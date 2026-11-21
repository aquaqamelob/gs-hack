import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { db } from './db'
import { parseRunbook } from './runbooks'
import { rt } from './runtime'
import { BUILTIN_KEYS, CUSTOM_FIELD_TYPES, type CustomField, type Recipient, type Rule, type Runbook } from './types'

export const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR ?? path.join(process.cwd(), 'config'))
export const RUNBOOK_DIR = path.join(CONFIG_DIR, 'runbooks')
const RULES_FILE = path.join(CONFIG_DIR, 'rules.yaml')
const RECIPIENTS_FILE = path.join(CONFIG_DIR, 'recipients.yaml')
const ACTIONS_FILE = path.join(CONFIG_DIR, 'actions.yaml')
const FIELDS_FILE = path.join(CONFIG_DIR, 'fields.yaml')

const RUNBOOK_EXT = /\.(ya?ml|md|markdown|txt)$/i

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

/** Content hash of each config file as this instance last loaded it (kept in rt(): route bundles share only globalThis). */
export const configVersion = (kind: ConfigKind) => rt().configVersions[kind]

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16)

function readYaml<T>(file: string, fallback: T): { doc: T; version: string } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[config] cannot read ${file}:`, e)
    return { doc: fallback, version: 'missing' }
  }
  const version = hashOf(text)
  try {
    return { doc: (YAML.parse(text) as T) ?? fallback, version }
  } catch (e) {
    console.error(`[config] cannot parse ${file}:`, e)
    return { doc: fallback, version }
  }
}

function writeAtomic(file: string, content: string) {
  const dir = path.dirname(file)
  // Unique per write: in containers every replica may be PID 1, so a pid-based name would collide.
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    const err = e as NodeJS.ErrnoException
    throw new ConfigError(
      `Cannot write ${path.relative(path.dirname(CONFIG_DIR), file)}: ${err.code ?? ''} ${err.message}`.trim(),
      500
    )
  }
  // Running as root in a container on a bind mount: keep the host user as the file owner.
  if (process.getuid?.() === 0) {
    try {
      const st = fs.statSync(dir)
      if (st.uid !== 0) fs.chownSync(file, st.uid, st.gid)
    } catch {
      /* best effort */
    }
  }
  return hashOf(content)
}

/**
 * Serializes config writes across every instance (Postgres advisory lock), so a write always
 * starts from what is on disk right now, not from an instance's possibly stale memory.
 */
async function withConfigLock<T>(fn: () => T | Promise<T>): Promise<T> {
  return (await db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ctrl-config'))`
    return fn()
  })) as T
}

function checkVersion(kind: ConfigKind, onDisk: string, expected?: string) {
  if (expected && expected !== onDisk)
    throw new ConfigError(`Someone else changed the ${kind} in the meantime. Reload and try again.`, 409)
}

function readRules() {
  const { doc, version } = readYaml<{ rules?: Rule[] }>(RULES_FILE, {})
  return { rules: (doc.rules ?? []).map((r) => ({ enabled: true, ...r })), version }
}

export function loadRules() {
  const { rules, version } = readRules()
  rt().rules = rules
  rt().configVersions.rules = version
}

/**
 * Read → modify → write under the global config lock. `mutate` gets the rules fresh from disk
 * and may throw (e.g. ConfigError) to abort. `expectedVersion` (optional) turns a concurrent edit into a 409.
 */
export async function updateRules<R = void>(
  mutate: (current: Rule[]) => { rules: Rule[]; result?: R },
  expectedVersion?: string
): Promise<R | undefined> {
  return withConfigLock(() => {
    const fresh = readRules()
    checkVersion('rules', fresh.version, expectedVersion)
    const { rules, result } = mutate(fresh.rules)
    rt().configVersions.rules = writeAtomic(RULES_FILE, YAML.stringify({ rules }, { lineWidth: 0 }))
    rt().rules = rules
    return result
  })
}

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

function readFields(log = false) {
  const { doc, version } = readYaml<{ fields?: Partial<CustomField>[] }>(FIELDS_FILE, {})
  const out: CustomField[] = []
  for (const f of doc.fields ?? []) {
    const err = validateField(f)
    if (err) {
      if (log) console.error(`[config] fields.yaml: skipping ${f.key ?? '(no key)'}: ${err}`)
    } else if (!out.some((x) => x.key === f.key)) out.push(cleanField(f))
  }
  return { fields: out, version }
}

export function loadFields() {
  const { fields, version } = readFields(true)
  rt().fields = fields
  rt().configVersions.fields = version
}

/** Like updateRules. `rules` are read fresh too, for checks such as "field still used by a rule". */
export async function updateFields<R = void>(
  mutate: (current: CustomField[], rules: Rule[]) => { fields: CustomField[]; result?: R },
  expectedVersion?: string
): Promise<R | undefined> {
  return withConfigLock(() => {
    const fresh = readFields()
    checkVersion('fields', fresh.version, expectedVersion)
    const { fields, result } = mutate(fresh.fields, readRules().rules)
    rt().configVersions.fields = writeAtomic(FIELDS_FILE, YAML.stringify({ fields }, { lineWidth: 0 }))
    rt().fields = fields
    return result
  })
}

function readRecipients() {
  const { doc, version } = readYaml<{ default_owner?: string; recipients?: Recipient[] }>(RECIPIENTS_FILE, {})
  return { recipients: doc.recipients ?? [], defaultOwner: doc.default_owner ?? 'team-platform', version }
}

export function loadRecipients() {
  const { recipients, defaultOwner, version } = readRecipients()
  rt().recipients = recipients
  rt().defaultOwner = defaultOwner
  rt().configVersions.recipients = version
}

/** Like updateRules, for config/recipients.yaml. */
export async function updateRecipients<R = void>(
  mutate: (current: Recipient[]) => { recipients: Recipient[]; result?: R },
  expectedVersion?: string
): Promise<R | undefined> {
  return withConfigLock(() => {
    const fresh = readRecipients()
    checkVersion('recipients', fresh.version, expectedVersion)
    const { recipients, result } = mutate(fresh.recipients)
    rt().configVersions.recipients = writeAtomic(
      RECIPIENTS_FILE,
      YAML.stringify({ default_owner: fresh.defaultOwner, recipients }, { lineWidth: 0 })
    )
    rt().recipients = recipients
    rt().defaultOwner = fresh.defaultOwner
    return result
  })
}

export function loadActions() {
  const { doc } = readYaml<{ actions?: Record<string, never> }>(ACTIONS_FILE, {})
  rt().actions = doc.actions ?? {}
}

export function loadRunbooks() {
  const next = new Map<string, Runbook>()
  if (fs.existsSync(RUNBOOK_DIR)) {
    for (const file of fs.readdirSync(RUNBOOK_DIR).sort()) {
      if (!RUNBOOK_EXT.test(file)) continue
      try {
        const rb = parseRunbook(file, fs.readFileSync(path.join(RUNBOOK_DIR, file), 'utf8'))
        next.set(rb.id, rb)
      } catch (e) {
        console.error(`[config] cannot parse runbook ${file}:`, e)
      }
    }
  }
  rt().runbooks = next
}

export function slug(id: string) {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function saveRunbookFile(id: string, format: Runbook['format'], content: string) {
  const safeId = slug(id)
  if (!safeId) throw new Error('Invalid runbook id')
  const ext = { yaml: 'yaml', markdown: 'md', text: 'txt' }[format]
  for (const file of fs.existsSync(RUNBOOK_DIR) ? fs.readdirSync(RUNBOOK_DIR) : []) {
    if (file.replace(RUNBOOK_EXT, '') === safeId) fs.unlinkSync(path.join(RUNBOOK_DIR, file))
  }
  writeAtomic(path.join(RUNBOOK_DIR, `${safeId}.${ext}`), content)
  loadRunbooks()
  return safeId
}

export function deleteRunbookFile(id: string) {
  const rb = rt().runbooks.get(id)
  if (rb) fs.rmSync(path.join(RUNBOOK_DIR, rb.file), { force: true })
  loadRunbooks()
}

export function loadAll() {
  loadRecipients()
  loadActions()
  loadFields()
  loadRules()
  loadRunbooks()
}

function signature(): string {
  const parts: string[] = []
  for (const f of [RULES_FILE, RECIPIENTS_FILE, ACTIONS_FILE, FIELDS_FILE]) {
    try {
      parts.push(`${f}:${fs.statSync(f).mtimeMs}`)
    } catch {
      parts.push(`${f}:-`)
    }
  }
  try {
    for (const f of fs.readdirSync(RUNBOOK_DIR).sort())
      parts.push(`${f}:${fs.statSync(path.join(RUNBOOK_DIR, f)).mtimeMs}`)
  } catch {
    /* no runbook dir */
  }
  return parts.join('|')
}

/**
 * Hot reload by polling mtimes once a second. Works on bind mounts shared by several
 * containers, where inotify events written by another container are not reliable.
 */
export function watchConfig(onReload: (what: string) => void) {
  let last = signature()
  setInterval(() => {
    const now = signature()
    if (now === last) return
    last = now
    loadAll()
    onReload('config')
  }, 1000).unref?.()
}
