import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { publish } from './bus'
import { db, type Tx } from './db'
import { parseRunbook } from './runbooks'
import { rt } from './runtime'
import type { Recipient, Rule, Runbook } from './types'

/**
 * Runtime-editable config (rules, recipients, runbooks) lives in Postgres, table config_docs. Instances are
 * stateless: each keeps an in-memory copy, reloaded whenever any instance saves (pg_notify) and on a periodic
 * version check. The YAML files under config/ only seed an empty table; actions.yaml is read-only from the image.
 */
export const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR ?? path.join(process.cwd(), 'config'))
export const RUNBOOK_DIR = path.join(CONFIG_DIR, 'runbooks')
const RULES_FILE = path.join(CONFIG_DIR, 'rules.yaml')
const RECIPIENTS_FILE = path.join(CONFIG_DIR, 'recipients.yaml')
const ACTIONS_FILE = path.join(CONFIG_DIR, 'actions.yaml')

const RUNBOOK_EXT = /\.(ya?ml|md|markdown|txt)$/i
const RUNBOOK_PREFIX = 'runbook:'

type RulesDoc = { rules: Rule[] }
type RecipientsDoc = { default_owner: string; recipients: Recipient[] }
type RunbookDoc = { file: string; format: Runbook['format']; content: string }
type ConfigWhat = 'rules' | 'recipients' | 'runbooks'

function readYaml<T>(file: string, fallback: T): T {
  try {
    return (YAML.parse(fs.readFileSync(file, 'utf8')) as T) ?? fallback
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[config] cannot parse ${file}:`, e)
    return fallback
  }
}

export function loadActions() {
  const doc = readYaml<{ actions?: Record<string, never> }>(ACTIONS_FILE, {})
  rt().actions = doc.actions ?? {}
}

/** First boot: copy config/*.yaml into an empty config_docs table. Serialised across instances by an advisory lock. */
export async function seedConfig() {
  await db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(424243)`
    const [{ n }] = await tx`select count(*)::int as n from config_docs`
    if (n > 0) return
    const by = 'seed:config/'
    const rules = readYaml<{ rules?: Rule[] }>(RULES_FILE, {}).rules ?? []
    const rec = readYaml<{ default_owner?: string; recipients?: Recipient[] }>(RECIPIENTS_FILE, {})
    const docs: { id: string; doc: unknown }[] = [
      { id: 'rules', doc: { rules } satisfies RulesDoc },
      { id: 'recipients', doc: { default_owner: rec.default_owner ?? 'team-platform', recipients: rec.recipients ?? [] } satisfies RecipientsDoc },
    ]
    if (fs.existsSync(RUNBOOK_DIR)) {
      for (const file of fs.readdirSync(RUNBOOK_DIR).sort()) {
        if (!RUNBOOK_EXT.test(file)) continue
        const content = fs.readFileSync(path.join(RUNBOOK_DIR, file), 'utf8')
        const rb = parseRunbook(file, content)
        docs.push({ id: RUNBOOK_PREFIX + rb.id, doc: { file, format: rb.format, content } satisfies RunbookDoc })
      }
    }
    for (const d of docs)
      await tx`insert into config_docs (id, doc, updated_by) values (${d.id}, ${tx.json(d.doc as never)}, ${by}) on conflict (id) do nothing`
    console.log(`[config] seeded ${docs.length} config docs from ${CONFIG_DIR}`)
  })
}

let version = ''
let reloading: Promise<void> | undefined
let reloadAgain = false

async function readAll() {
  const rows = await db()<{ id: string; doc: unknown }[]>`select id, doc from config_docs`
  const r = rt()
  const runbooks = new Map<string, Runbook>()
  for (const row of rows) {
    if (row.id === 'rules') {
      r.rules = ((row.doc as RulesDoc).rules ?? []).map((x) => ({ enabled: true, ...x }))
    } else if (row.id === 'recipients') {
      const doc = row.doc as RecipientsDoc
      r.recipients = doc.recipients ?? []
      r.defaultOwner = doc.default_owner ?? 'team-platform'
    } else if (row.id.startsWith(RUNBOOK_PREFIX)) {
      const doc = row.doc as RunbookDoc
      try {
        const rb = parseRunbook(doc.file, doc.content)
        runbooks.set(rb.id, rb)
      } catch (e) {
        console.error(`[config] cannot parse runbook ${doc.file}:`, e)
      }
    }
  }
  r.runbooks = new Map([...runbooks].sort(([a], [b]) => a.localeCompare(b)))
}

async function currentVersion() {
  const [v] = await db()`select coalesce(max(updated_at)::text, '') as at, count(*)::int as n from config_docs`
  return `${v.at}|${v.n}`
}

/** Reload this instance's copy from Postgres. Concurrent calls coalesce into at most one extra reload. */
export function reloadConfig(): Promise<void> {
  if (reloading) {
    reloadAgain = true
    return reloading
  }
  reloading = (async () => {
    try {
      do {
        reloadAgain = false
        const v = await currentVersion()
        await readAll()
        version = v
      } while (reloadAgain)
    } finally {
      reloading = undefined
    }
  })()
  return reloading
}

export async function loadAll() {
  loadActions()
  await reloadConfig()
}

/**
 * Fallback for a missed NOTIFY (the LISTEN connection can drop): compare the version every few seconds.
 * `onReload` fires only when something changed.
 */
export function watchConfig(onReload: () => void, everyMs = 5000) {
  setInterval(() => {
    void currentVersion()
      .then(async (v) => {
        if (v === version) return
        await reloadConfig()
        onReload()
      })
      .catch((e) => console.error('[config] version check failed:', (e as Error).message))
  }, everyMs).unref?.()
}

/** Read-modify-write of one doc under a row lock, then broadcast. Every instance (this one included) reloads. */
async function updateDoc<T>(id: string, what: ConfigWhat, actor: string, fn: (current: T | undefined, tx: Tx) => T | null) {
  await db().begin(async (tx) => {
    const [row] = await tx<{ doc: T }[]>`select doc from config_docs where id = ${id} for update`
    const next = fn(row?.doc, tx)
    if (next === null) {
      await tx`delete from config_docs where id = ${id}`
    } else {
      await tx`
        insert into config_docs (id, doc, updated_at, updated_by) values (${id}, ${tx.json(next as never)}, now(), ${actor})
        on conflict (id) do update set doc = excluded.doc, updated_at = now(), updated_by = excluded.updated_by`
    }
    await publish({ type: 'config', what }, tx)
  })
  // Do not wait for our own NOTIFY: the caller's next read on this instance must already see the change.
  await reloadConfig()
}

/** Apply `fn` to the current rules inside the transaction, so concurrent edits on different instances do not lose updates. */
export async function updateRules(actor: string, fn: (rules: Rule[]) => Rule[]) {
  let out: Rule[] = []
  await updateDoc<RulesDoc>('rules', 'rules', actor, (doc) => ({ rules: (out = fn(doc?.rules ?? [])) }))
  return out
}

export async function updateRecipients(actor: string, fn: (recipients: Recipient[]) => Recipient[]) {
  await updateDoc<RecipientsDoc>('recipients', 'recipients', actor, (doc) => ({
    default_owner: doc?.default_owner ?? rt().defaultOwner,
    recipients: fn(doc?.recipients ?? []),
  }))
}

export function slug(id: string) {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function saveRunbook(id: string, format: Runbook['format'], content: string, actor: string) {
  const safeId = slug(id)
  if (!safeId) throw new Error('Invalid runbook id')
  const ext = { yaml: 'yaml', markdown: 'md', text: 'txt' }[format]
  await updateDoc<RunbookDoc>(RUNBOOK_PREFIX + safeId, 'runbooks', actor, () => ({ file: `${safeId}.${ext}`, format, content }))
  return safeId
}

export async function deleteRunbook(id: string, actor: string) {
  await updateDoc<RunbookDoc>(RUNBOOK_PREFIX + id, 'runbooks', actor, () => null)
}

/** Git-friendly view of the current rules, same shape as config/rules.yaml. */
export function rulesYaml() {
  return YAML.stringify({ rules: rt().rules }, { lineWidth: 0 })
}
