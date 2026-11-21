import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
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

function readYaml<T>(file: string, fallback: T): T {
  try {
    return (YAML.parse(fs.readFileSync(file, 'utf8')) as T) ?? fallback
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[config] cannot parse ${file}:`, e)
    return fallback
  }
}

function writeAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

export function loadRules() {
  const doc = readYaml<{ rules?: Rule[] }>(RULES_FILE, {})
  rt().rules = (doc.rules ?? []).map((r) => ({ enabled: true, ...r }))
}

export function saveRules(rules: Rule[]) {
  rt().rules = rules
  writeAtomic(RULES_FILE, YAML.stringify({ rules }, { lineWidth: 0 }))
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

export function loadFields() {
  const doc = readYaml<{ fields?: Partial<CustomField>[] }>(FIELDS_FILE, {})
  const out: CustomField[] = []
  for (const f of doc.fields ?? []) {
    const err = validateField(f)
    if (err) console.error(`[config] fields.yaml: skipping ${f.key ?? '(no key)'}: ${err}`)
    else if (!out.some((x) => x.key === f.key)) out.push(cleanField(f))
  }
  rt().fields = out
}

export function saveFields(fields: CustomField[]) {
  rt().fields = fields
  writeAtomic(FIELDS_FILE, YAML.stringify({ fields }, { lineWidth: 0 }))
}

export function loadRecipients() {
  const doc = readYaml<{ default_owner?: string; recipients?: Recipient[] }>(RECIPIENTS_FILE, {})
  rt().recipients = doc.recipients ?? []
  rt().defaultOwner = doc.default_owner ?? 'team-platform'
}

export function saveRecipients(recipients: Recipient[]) {
  rt().recipients = recipients
  writeAtomic(
    RECIPIENTS_FILE,
    YAML.stringify({ default_owner: rt().defaultOwner, recipients }, { lineWidth: 0 })
  )
}

export function loadActions() {
  const doc = readYaml<{ actions?: Record<string, never> }>(ACTIONS_FILE, {})
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
