import {
  CANONICAL_KEYS,
  type Canonical,
  type CanonicalKey,
  type FieldFormat,
  type FieldInfo,
  type Json,
  type MappedBy,
  type MappingProposal,
  type SchemaRecord,
  type SchemaStatus,
  type Severity,
} from './types'
import { getPath, leaves, shortHash } from './util'

export const CANONICAL_DESCRIPTIONS: Record<CanonicalKey, string> = {
  severity: 'how bad it is (critical / error / warning / info)',
  service: 'system, service, workflow or producer that emitted the event',
  environment: 'deployment environment such as prod, uat, dev',
  'error.code': 'machine-readable error or reason code',
  'error.message': 'human-readable description of what went wrong',
  timestamp: 'when it happened',
  entity_id: 'identifier of the affected business entity (workflow, trade, order, ...)',
  title: 'short name of what happened: event type, alert name, subject',
}

const CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'PLN', 'CHF', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'CZK', 'HUF', 'CNY', 'HKD', 'SGD'])

export function detectFormat(value: unknown): { type: FieldInfo['type']; format: FieldFormat } {
  if (value === null || value === undefined) return { type: 'null', format: 'null' }
  if (Array.isArray(value)) return { type: 'array', format: 'array' }
  if (typeof value === 'boolean') return { type: 'boolean', format: 'boolean' }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value > 1e12 && value < 1e13) return { type: 'number', format: 'epoch-ms' }
    if (Number.isInteger(value) && value > 1e9 && value < 1e10) return { type: 'number', format: 'epoch-s' }
    return { type: 'number', format: 'number' }
  }
  const s = String(value)
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s))
    return { type: 'string', format: 'iso-datetime' }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return { type: 'string', format: 'uuid' }
  if (CURRENCIES.has(s)) return { type: 'string', format: 'currency' }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return { type: 'string', format: 'email' }
  if (/^https?:\/\//.test(s)) return { type: 'string', format: 'url' }
  if (/^[A-Z]{1,6}-[A-Z0-9-]*\d[A-Z0-9-]*$/i.test(s) && /\d/.test(s)) return { type: 'string', format: 'id' }
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s) || /^[A-Z]{3,}$/.test(s)) return { type: 'string', format: 'enum-code' }
  if (/\s/.test(s.trim())) return { type: 'string', format: 'text' }
  return { type: 'string', format: 'word' }
}

export function describeFields(raw: unknown): FieldInfo[] {
  return leaves(raw).map(({ path, value }) => ({ path, ...detectFormat(value) }))
}

/** Fingerprint = hash of the sorted key paths. Values never influence it. */
export function structureFingerprint(fields: Pick<FieldInfo, 'path'>[]) {
  return shortHash(
    fields
      .map((f) => f.path)
      .sort()
      .join('|')
  )
}

const SEVERITY_WORDS: Record<string, Severity> = {
  critical: 'critical',
  crit: 'critical',
  fatal: 'critical',
  emergency: 'critical',
  emerg: 'critical',
  alert: 'critical',
  p1: 'critical',
  sev1: 'critical',
  blocker: 'critical',
  page: 'critical',
  error: 'error',
  err: 'error',
  high: 'error',
  major: 'error',
  p2: 'error',
  sev2: 'error',
  severe: 'error',
  warning: 'warning',
  warn: 'warning',
  medium: 'warning',
  minor: 'warning',
  p3: 'warning',
  sev3: 'warning',
  info: 'info',
  information: 'info',
  informational: 'info',
  low: 'info',
  notice: 'info',
  debug: 'info',
  trace: 'info',
  ok: 'info',
  p4: 'info',
  p5: 'info',
  sev4: 'info',
}

export function normalizeSeverity(value: unknown): Severity | undefined {
  if (value === undefined || value === null) return undefined
  return SEVERITY_WORDS[String(value).trim().toLowerCase()]
}

export function normalizeTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    const d = new Date(value > 1e12 ? value : value * 1000)
    return isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  const d = new Date(String(value))
  return isNaN(d.getTime()) ? String(value) : d.toISOString()
}

function tokens(path: string) {
  const last = path.split('.').pop() ?? path
  const norm = last.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
  return { last, norm, words, depth: path.split('.').length }
}
type Tokens = ReturnType<typeof tokens>

// ---------------------------------------------------------------- layer 1: deterministic synonyms + value format

const SYNONYMS: Record<CanonicalKey, string[]> = {
  severity: ['severity', 'sev', 'level', 'loglevel', 'priority', 'urgency', 'criticality'],
  service: [
    'service',
    'servicename',
    'svc',
    'app',
    'application',
    'appname',
    'component',
    'system',
    'producer',
    'workflowname',
    'logger',
    'source',
    'host',
    'hostname',
    'job',
    'jobname',
    'emitter',
    'origin',
  ],
  environment: ['environment', 'env', 'stage', 'tier', 'envname'],
  'error.code': ['code', 'errorcode', 'errcode', 'reason', 'reasoncode', 'faultcode', 'rejectreason', 'rejectioncode', 'rejectcode', 'failurecode'],
  'error.message': ['message', 'msg', 'summary', 'description', 'detail', 'details', 'errormessage', 'text', 'reason', 'error', 'cause'],
  timestamp: [
    'timestamp',
    'ts',
    'time',
    'startsat',
    'createdat',
    'occurredat',
    'eventtime',
    'datetime',
    'date',
    'at',
    'firedat',
    'raisedat',
    'sentat',
    'receivedat',
    'loggedat',
  ],
  entity_id: ['entityid', 'workflowid', 'tradeid', 'orderid', 'paymentid', 'accountid', 'instrumentid', 'id'],
  title: ['title', 'subject', 'type', 'eventtype', 'kind', 'event', 'eventname', 'alertname', 'schema', 'messagetype', 'name'],
}

/** For the fuzzy tiebreak: a word of the field name must start with one of these, so error_count never becomes error.code. */
const DISTINGUISHING: Record<CanonicalKey, string[]> = {
  severity: ['sev', 'level', 'lvl', 'prio', 'urg', 'crit'],
  service: ['serv', 'svc', 'app', 'comp', 'sys', 'host', 'job', 'produc'],
  environment: ['env', 'stage', 'tier'],
  'error.code': ['code', 'cd', 'reason'],
  'error.message': ['msg', 'mess', 'desc', 'summ', 'detail', 'text'],
  timestamp: ['time', 'ts', 'date', 'stamp'],
  entity_id: ['id', 'ref', 'key'],
  title: ['title', 'subj', 'type', 'kind', 'event', 'name'],
}

const TECHNICAL_IDS = ['requestid', 'traceid', 'spanid', 'correlationid', 'messageid', 'eventid', 'fingerprint']

type Scorer = (f: FieldInfo, value: unknown, t: Tokens) => [number, string] | null

const named = (key: CanonicalKey, t: Tokens) => SYNONYMS[key].includes(t.norm)

const SCORERS: Record<CanonicalKey, Scorer> = {
  severity: (f, v, t) => {
    if (!named('severity', t)) return null
    return normalizeSeverity(v) ? [0.95, `name "${t.last}" + severity-like value`] : [0.6, `name "${t.last}" but unknown value`]
  },
  service: (f, v, t) => {
    if (f.type !== 'string' || !named('service', t)) return null
    return SYNONYMS.service.indexOf(t.norm) < 8 ? [0.95, `name "${t.last}"`] : [0.85, `name "${t.last}" usually identifies the emitter`]
  },
  environment: (f, v, t) => (named('environment', t) ? [0.95, `name "${t.last}"`] : null),
  'error.code': (f, v, t) => {
    if (!named('error.code', t)) return null
    if (f.format === 'enum-code' || f.format === 'word' || f.type === 'number') return [0.9, `name "${t.last}" with code-like value`]
    return null
  },
  'error.message': (f, v, t) => {
    if (f.type !== 'string' || !named('error.message', t)) return null
    return f.format === 'text' ? [0.9, `name "${t.last}" with free-text value`] : [0.6, `name "${t.last}" but short value`]
  },
  timestamp: (f, v, t) => {
    const tsFormat = ['iso-datetime', 'epoch-ms', 'epoch-s'].includes(f.format)
    if (named('timestamp', t) && tsFormat) return [0.95, `name "${t.last}" + ${f.format} value`]
    if (tsFormat) return [0.7, `${f.format} value`]
    return null
  },
  entity_id: (f, v, t) => {
    if (t.norm === 'id' && t.depth === 1) return [0.7, 'top-level "id"']
    if (TECHNICAL_IDS.includes(t.norm)) return null
    if (!/(id|ref|key|number)$/.test(t.norm) || t.norm.length <= 2) return null
    return [f.format === 'id' || f.format === 'uuid' ? 0.9 : 0.8, `"${t.last}" names an entity id`]
  },
  title: (f, v, t) => {
    if (f.type !== 'string' || !named('title', t)) return null
    if (f.format === 'text' && !['title', 'subject'].includes(t.norm)) return null
    return [t.depth <= 2 ? 0.9 : 0.7, `name "${t.last}"`]
  },
}

export const AUTO_ACCEPT = 0.75
export const PROPOSE = 0.5

// ---------------------------------------------------------------- layer 2: fuzzy tiebreak

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const am = new Array(a.length).fill(false)
  const bm = new Array(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue
      am[i] = bm[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let t = 0
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!am[i]) continue
    while (!bm[k]) k++
    if (a[i] !== b[k++]) t++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3
  let prefix = 0
  while (prefix < 4 && a[prefix] && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

export const FUZZY_ACCEPT = 0.9
export const FUZZY_PROPOSE = 0.82

export function fuzzyScore(key: CanonicalKey, path: string): { score: number; synonym: string } | null {
  const t = tokens(path)
  const distinguishing = DISTINGUISHING[key]
  if (!t.words.some((w) => distinguishing.some((d) => w.startsWith(d)))) return null
  let best = { score: 0, synonym: '' }
  for (const syn of SYNONYMS[key]) {
    if (syn.length < 4) continue
    const score = jaroWinkler(t.norm, syn)
    if (score > best.score) best = { score, synonym: syn }
  }
  return best.score >= FUZZY_PROPOSE ? best : null
}

// ---------------------------------------------------------------- known formats

interface KnownFormat {
  name: string
  test: (raw: Record<string, unknown>) => boolean
  mapping: Partial<Record<CanonicalKey, string[]>>
  resolved?: (raw: unknown) => boolean
}

const KNOWN_FORMATS: KnownFormat[] = [
  {
    name: 'prometheus-alertmanager',
    test: (r) =>
      typeof r.labels === 'object' &&
      r.labels !== null &&
      'alertname' in (r.labels as object) &&
      ('startsAt' in r || 'status' in r),
    mapping: {
      title: ['labels.alertname'],
      severity: ['labels.severity', 'labels.priority'],
      service: ['labels.service', 'labels.job', 'labels.app'],
      environment: ['labels.env', 'labels.environment'],
      'error.message': ['annotations.summary', 'annotations.description', 'annotations.message'],
      timestamp: ['startsAt'],
      entity_id: ['labels.instance', 'fingerprint'],
    },
    resolved: (raw) => getPath(raw, 'status') === 'resolved',
  },
]

export function knownFormat(name: string | null | undefined) {
  return KNOWN_FORMATS.find((k) => k.name === name)
}

export interface MappingResult {
  knownFormat?: string
  mapping: Partial<Record<CanonicalKey, string>>
  mappedBy: Partial<Record<CanonicalKey, MappedBy>>
  confidence: Partial<Record<CanonicalKey, number>>
  proposals: Omit<MappingProposal, 'state'>[]
}

/** Layers 1 and 2. Runs once per new schema; the result is stored in Postgres and reused for every event. */
export function computeMapping(raw: unknown, fields: FieldInfo[]): MappingResult {
  const result: MappingResult = { mapping: {}, mappedBy: {}, confidence: {}, proposals: [] }
  const used = new Set<string>()

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const known = KNOWN_FORMATS.find((k) => k.test(raw as Record<string, unknown>))
    if (known) {
      result.knownFormat = known.name
      for (const [key, candidates] of Object.entries(known.mapping) as [CanonicalKey, string[]][]) {
        const path = candidates.find((c) => getPath(raw, c) !== undefined)
        if (!path) continue
        result.mapping[key] = path
        result.mappedBy[key] = 'known-format'
        result.confidence[key] = 1
        used.add(path)
      }
      return result
    }
  }

  const scored: { key: CanonicalKey; path: string; score: number; reason: string }[] = []
  for (const key of CANONICAL_KEYS) {
    for (const f of fields) {
      const s = SCORERS[key](f, getPath(raw, f.path), tokens(f.path))
      if (s && s[0] >= PROPOSE) scored.push({ key, path: f.path, score: s[0], reason: s[1] })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.path.split('.').length - b.path.split('.').length)
  for (const s of scored) {
    if (result.mapping[s.key] || used.has(s.path)) continue
    if (s.score >= AUTO_ACCEPT) {
      result.mapping[s.key] = s.path
      result.mappedBy[s.key] = 'deterministic'
      result.confidence[s.key] = s.score
      used.add(s.path)
    }
  }
  for (const s of scored) {
    if (result.mapping[s.key] || used.has(s.path) || result.proposals.some((p) => p.canonical === s.key)) continue
    result.proposals.push({ canonical: s.key, path: s.path, confidence: s.score, by: 'fuzzy', reason: s.reason })
  }

  for (const key of CANONICAL_KEYS) {
    if (result.mapping[key]) continue
    const best = fields
      .filter((f) => !used.has(f.path) && f.type !== 'array' && f.type !== 'null')
      .map((f) => ({ f, m: fuzzyScore(key, f.path) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)[0]
    if (!best) continue
    const reason = `"${tokens(best.f.path).last}" ≈ "${best.m!.synonym}" (${Math.round(best.m!.score * 100)}%)`
    if (best.m!.score >= FUZZY_ACCEPT) {
      result.mapping[key] = best.f.path
      result.mappedBy[key] = 'fuzzy'
      result.confidence[key] = best.m!.score
      used.add(best.f.path)
      result.proposals = result.proposals.filter((p) => p.canonical !== key)
    } else if (!result.proposals.some((p) => p.canonical === key)) {
      result.proposals.push({ canonical: key, path: best.f.path, confidence: best.m!.score, by: 'fuzzy', reason })
    }
  }
  return result
}

/** A schema is "mapped" when we can say what happened and how bad it is without a human. */
export function schemaStatus(m: {
  knownFormat?: string | null
  mapping: MappingResult['mapping']
  proposals: Pick<MappingProposal, 'state'>[]
}): SchemaStatus {
  if (m.knownFormat) return 'approved'
  const pending = m.proposals.some((p) => p.state === 'pending')
  const understood = Boolean(m.mapping.title || m.mapping['error.message']) && Boolean(m.mapping.severity)
  return !pending && understood ? 'mapped' : 'needs-review'
}

export function normalize(raw: unknown, schema: Pick<SchemaRecord, 'mapping' | 'knownFormat'>): Canonical {
  const out: Canonical = {}
  for (const [key, path] of Object.entries(schema.mapping) as [CanonicalKey, string][]) {
    const v = getPath(raw, path)
    if (v === undefined || v === null) continue
    if (key === 'severity') {
      const s = normalizeSeverity(v)
      if (s) out.severity = s
    } else if (key === 'timestamp') {
      const t = normalizeTimestamp(v)
      if (t) out.timestamp = t
    } else {
      out[key] = typeof v === 'object' ? JSON.stringify(v) : String(v)
    }
  }
  if (knownFormat(schema.knownFormat)?.resolved?.(raw)) out.resolved = true
  return out
}

export function schemaName(raw: unknown, source: string, mapping: MappingResult) {
  if (mapping.knownFormat) return mapping.knownFormat
  const titleValue = mapping.mapping.title ? getPath(raw, mapping.mapping.title) : undefined
  if (typeof titleValue === 'string' && titleValue.length < 60) return titleValue
  if (source === 'logs' || source === 'log') {
    const svc = mapping.mapping.service ? getPath(raw, mapping.mapping.service) : undefined
    if (typeof svc === 'string') return `log:${svc.replace(/[-_]?\d+$/, '-*')}`
  }
  return `${source}-schema`
}

export function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** Parse a plain-text log line (or JSON line) into a flat object. Never throws. */
export function parseLogLine(line: string): Record<string, Json> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      /* fall through to text parsing */
    }
  }
  const m = trimmed.match(
    /^(\S+(?:\s\d{2}:\d{2}:\d{2}\S*)?)\s+\[?(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL)\]?\s+\[?([\w.\-]+)\]?:?\s*(.*)$/i
  )
  if (!m) return { message: trimmed }
  const rest = m[4]
  const out: Record<string, Json> = { timestamp: m[1], level: m[2].toUpperCase(), logger: m[3] }
  const kv = /(\w[\w.]*)=("([^"]*)"|\S+)/g
  let match: RegExpExecArray | null
  while ((match = kv.exec(rest))) {
    const v = match[3] ?? match[2]
    out[match[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
  }
  const text = rest.replace(kv, '').replace(/\s+/g, ' ').trim()
  if (text && out.message === undefined && out.msg === undefined) out.message = text
  return out
}
