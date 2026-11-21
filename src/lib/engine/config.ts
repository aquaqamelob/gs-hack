import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { publish } from './bus'
import { db, type Tx } from './db'
import { parseRunbook } from './runbooks'
import { rt } from './runtime'
import { BUILTIN_KEYS, CUSTOM_FIELD_TYPES, type CustomField, type Recipient, type Rule, type Runbook } from './types'

/**
 * Runtime-editable config (rules, recipients, custom fields, runbooks) lives in Postgres, table config_docs.
 * Instances are stateless: each keeps an in-memory copy, reloaded whenever any instance saves (pg_notify) and on
 * a periodic version check. The YAML files under config/ only seed missing docs; actions.yaml is read-only.
 */
export const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR ?? path.join(process.cwd(), 'config'))
export const RUNBOOK_DIR = path.join(CONFIG_DIR, 'runbooks')
const RULES_FILE = path.join(CONFIG_DIR, 'rules.yaml')
const RECIPIENTS_FILE = path.join(CONFIG_DIR, 'recipients.yaml')
const ACTIONS_FILE = path.join(CONFIG_DIR, 'actions.yaml')
const FIELDS_FILE = path.join(CONFIG_DIR, 'fields.yaml')

const RUNBOOK_EXT = /\.(ya?ml|md|markdown|txt)$/i
const RUNBOOK_PREFIX = 'runbook:'

/** Error carrying an HTTP status; `handle()` in api.ts turns it into that response. */
export class ConfigError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message)
  }
}

export type ConfigKind = 'rules' | 'recipients' | 'fields'

type RulesDoc = { rules: Rule[] }
type RecipientsDoc = { default_owner: string; recipients: Recipient[] }
type FieldsDoc = { fields: Partial<CustomField>[] }
type RunbookDoc = { file: string; format: Runbook['format']; content: string }

/**
 * Version of a doc as this instance last loaded it: md5 of the stored jsonb, computed by Postgres so it is the
 * same on every instance. Clients send it back on save; a mismatch is a 409 (optimistic concurrency).
 */
export const configVersion = (kind: ConfigKind) => rt().configVersions[kind]

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

// ---------------------------------------------------------------- custom fields

const RESERVED_KEYS = new Set<string>([...BUILTIN_KEYS, 'source', 'schema', 'resolved', 'raw'])

/** Returns an error message, or null when the definition is usable. */
export function validateField(f: Partial<CustomField>): string | null {
  if (!f.key || typeof f.key !== 'string') return 'key is required'
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(f.key) || f.key.length > 40)
    return 'key must be lowercase letters, digits and _ (dots for groups, e.g. trade.amount), max 40 chars'
  if (RESERVED_KEYS.has(f.key) || f.key.startsWith('raw.')) return `"${f.key}" is reserved`
  if (f.type && !CUSTOM_FIELD_TYPES.includes(f.type)) return `type must be one of ${CUSTOM_FIELD_TYPES.join(', ')}`
  return null
}

const normWord = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase()

/** Fills defaults: the key itself is always a synonym; synonyms are normalized like field names. */
export function cleanField(f: Partial<CustomField>): CustomField {
  const key = f.key!
  const synonyms = new Set<string>([normWord(key.split('.').pop()!), normWord(key)])
  for (const s of f.synonyms ?? []) if (normWord(String(s))) synonyms.add(normWord(String(s)))
  return {
    key,
    description: String(f.description ?? '').trim() || key,
    synonyms: [...synonyms],
    type: f.type ?? 'text',
  }
}

function cleanFields(list: Partial<CustomField>[], log = false) {
  const out: CustomField[] = []
  for (const f of list ?? []) {
    const err = validateField(f)
    if (err) {
      if (log) console.error(`[config] fields: skipping ${f.key ?? '(no key)'}: ${err}`)
    } else if (!out.some((x) => x.key === f.key)) out.push(cleanField(f))
  }
  return out
}

const normRules = (rules: Rule[] | undefined) => (rules ?? []).map((r) => ({ enabled: true, ...r }))

// ---------------------------------------------------------------- seed + load

/**
 * Copy config/*.yaml into config_docs for every doc that does not exist yet (first boot, or a doc kind added
 * later such as fields). Runbook files are copied only while there is no runbook at all, so deleting one sticks.
 * Serialised across instances by an advisory lock.
 */
export async function seedConfig() {
  await db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(424243)`
    const have = new Set((await tx<{ id: string }[]>`select id from config_docs`).map((r) => r.id))
    const docs: { id: string; doc: unknown }[] = []
    if (!have.has('rules')) docs.push({ id: 'rules', doc: { rules: readYaml<{ rules?: Rule[] }>(RULES_FILE, {}).rules ?? [] } satisfies RulesDoc })
    if (!have.has('recipients')) {
      const rec = readYaml<{ default_owner?: string; recipients?: Recipient[] }>(RECIPIENTS_FILE, {})
      docs.push({ id: 'recipients', doc: { default_owner: rec.default_owner ?? 'team-platform', recipients: rec.recipients ?? [] } satisfies RecipientsDoc })
    }
    if (!have.has('fields')) docs.push({ id: 'fields', doc: { fields: readYaml<FieldsDoc>(FIELDS_FILE, { fields: [] }).fields ?? [] } satisfies FieldsDoc })
    if (![...have].some((id) => id.startsWith(RUNBOOK_PREFIX)) && fs.existsSync(RUNBOOK_DIR)) {
      for (const file of fs.readdirSync(RUNBOOK_DIR).sort()) {
        if (!RUNBOOK_EXT.test(file)) continue
        const content = fs.readFileSync(path.join(RUNBOOK_DIR, file), 'utf8')
        const rb = parseRunbook(file, content)
        docs.push({ id: RUNBOOK_PREFIX + rb.id, doc: { file, format: rb.format, content } satisfies RunbookDoc })
      }
    }
    for (const d of docs)
      await tx`insert into config_docs (id, doc, updated_by) values (${d.id}, ${tx.json(d.doc as never)}, 'seed:config/') on conflict (id) do nothing`
    if (docs.length) console.log(`[config] seeded ${docs.map((d) => d.id).join(', ')} from ${CONFIG_DIR}`)
  })
}

let version = ''
let reloading: Promise<void> | undefined
let reloadAgain = false

async function readAll() {
  const rows = await db()<{ id: string; doc: unknown; version: string }[]>`select id, doc, md5(doc::text) as version from config_docs`
  const r = rt()
  const runbooks = new Map<string, Runbook>()
  const versions = { rules: 'missing', recipients: 'missing', fields: 'missing' }
  r.fields = []
  for (const row of rows) {
    if (row.id === 'rules') {
      r.rules = normRules((row.doc as RulesDoc).rules)
      versions.rules = row.version
    } else if (row.id === 'recipients') {
      const doc = row.doc as RecipientsDoc
      r.recipients = doc.recipients ?? []
      r.defaultOwner = doc.default_owner ?? 'team-platform'
      versions.recipients = row.version
    } else if (row.id === 'fields') {
      r.fields = cleanFields((row.doc as FieldsDoc).fields, true)
      versions.fields = row.version
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
  r.configVersions = versions
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

// ---------------------------------------------------------------- writes

/**
 * Read → modify → write of one doc under its row lock, then broadcast so every instance (this one included)
 * reloads. `fn` gets the doc as stored right now (not this instance's possibly stale copy) and may throw to abort.
 * `expectedVersion` (optional) turns a concurrent edit into a 409.
 */
async function updateDoc<T>(
  id: string,
  what: string,
  actor: string,
  expectedVersion: string | undefined,
  fn: (current: T | undefined, tx: Tx) => T | null | Promise<T | null>
) {
  await db().begin(async (tx) => {
    const [row] = await tx<{ doc: T; version: string }[]>`select doc, md5(doc::text) as version from config_docs where id = ${id} for update`
    if (expectedVersion && expectedVersion !== (row?.version ?? 'missing'))
      throw new ConfigError(`Someone else changed the ${what} in the meantime. Reload and try again.`, 409)
    const next = await fn(row?.doc, tx)
    if (next === null) {
      await tx`delete from config_docs where id = ${id}`
    } else {
      await tx`
        insert into config_docs (id, doc, updated_at, updated_by) values (${id}, ${tx.json(next as never)}, now(), ${actor})
        on conflict (id) do update set doc = excluded.doc, updated_at = now(), updated_by = excluded.updated_by`
    }
    await publish({ type: 'config', what }, tx)
  })
  // Do not wait for our own NOTIFY: the caller's next read on this instance (and the returned version) must see the change.
  await reloadConfig()
}

export async function updateRules<R = void>(
  mutate: (current: Rule[]) => { rules: Rule[]; result?: R },
  expectedVersion?: string,
  actor = 'console'
): Promise<R | undefined> {
  let result: R | undefined
  await updateDoc<RulesDoc>('rules', 'rules', actor, expectedVersion, (doc) => {
    const out = mutate(normRules(doc?.rules))
    result = out.result
    return { rules: out.rules }
  })
  return result
}

export async function updateRecipients<R = void>(
  mutate: (current: Recipient[]) => { recipients: Recipient[]; result?: R },
  expectedVersion?: string,
  actor = 'console'
): Promise<R | undefined> {
  let result: R | undefined
  await updateDoc<RecipientsDoc>('recipients', 'recipients', actor, expectedVersion, (doc) => {
    const out = mutate(doc?.recipients ?? [])
    result = out.result
    return { default_owner: doc?.default_owner ?? rt().defaultOwner, recipients: out.recipients }
  })
  return result
}

/** Like updateRules. `rules` are read in the same transaction, for checks such as "field still used by a rule". */
export async function updateFields<R = void>(
  mutate: (current: CustomField[], rules: Rule[]) => { fields: CustomField[]; result?: R },
  expectedVersion?: string,
  actor = 'console'
): Promise<R | undefined> {
  let result: R | undefined
  await updateDoc<FieldsDoc>('fields', 'fields', actor, expectedVersion, async (doc, tx) => {
    const [rules] = await tx<{ doc: RulesDoc }[]>`select doc from config_docs where id = 'rules'`
    const out = mutate(cleanFields(doc?.fields ?? []), normRules(rules?.doc.rules))
    result = out.result
    return { fields: out.fields }
  })
  return result
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
  if (!safeId) throw new ConfigError('Invalid runbook id')
  const ext = { yaml: 'yaml', markdown: 'md', text: 'txt' }[format]
  await updateDoc<RunbookDoc>(RUNBOOK_PREFIX + safeId, 'runbooks', actor, undefined, () => ({ file: `${safeId}.${ext}`, format, content }))
  return safeId
}

export async function deleteRunbook(id: string, actor: string) {
  await updateDoc<RunbookDoc>(RUNBOOK_PREFIX + id, 'runbooks', actor, undefined, () => null)
}

/** Git-friendly view of the current rules, same shape as config/rules.yaml. */
export function rulesYaml() {
  return YAML.stringify({ rules: rt().rules }, { lineWidth: 0 })
}
