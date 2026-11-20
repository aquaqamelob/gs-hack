export type Severity = 'critical' | 'error' | 'warning' | 'info'
export const SEVERITIES: Severity[] = ['critical', 'error', 'warning', 'info']
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2, critical: 3 }

export type Channel = 'phone' | 'sms' | 'email' | 'ui'
export const CHANNELS: Channel[] = ['phone', 'sms', 'email', 'ui']

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export const CANONICAL_KEYS = [
  'severity',
  'service',
  'environment',
  'error.code',
  'error.message',
  'timestamp',
  'entity_id',
  'title',
] as const
export type CanonicalKey = (typeof CANONICAL_KEYS)[number]
export type Canonical = Partial<Record<CanonicalKey, string>> & { resolved?: boolean }

export type FieldFormat =
  | 'iso-datetime'
  | 'epoch-ms'
  | 'epoch-s'
  | 'uuid'
  | 'currency'
  | 'enum-code'
  | 'id'
  | 'email'
  | 'url'
  | 'text'
  | 'word'
  | 'number'
  | 'boolean'
  | 'array'
  | 'null'

export interface FieldInfo {
  path: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'null'
  format: FieldFormat
}

export type MappedBy = 'known-format' | 'deterministic' | 'fuzzy' | 'llm' | 'human'

export interface MappingProposal {
  canonical: CanonicalKey
  path: string
  confidence: number
  by: 'fuzzy' | 'llm'
  reason?: string
  state: 'pending' | 'accepted' | 'rejected'
}

export type SchemaStatus = 'mapped' | 'needs-review' | 'approved'

export interface SchemaRecord {
  fingerprint: string
  name: string
  source: string
  knownFormat?: string | null
  fields: FieldInfo[]
  sample: Json
  mapping: Partial<Record<CanonicalKey, string>>
  mappedBy: Partial<Record<CanonicalKey, MappedBy>>
  confidence: Partial<Record<CanonicalKey, number>>
  proposals: MappingProposal[]
  status: SchemaStatus
  llm: { state: 'idle' | 'running' | 'done' | 'disabled' | 'error'; detail?: string; at?: number }
  eventCount: number
  firstSeen: number
  lastSeen: number
}

export interface EventView {
  source: string
  schemaName: string
  raw: Json
  canonical: Canonical
}

export type Condition = { all: Condition[] } | { any: Condition[] } | { field: string; op: ConditionOp; value?: Json }

export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'regex'
  | 'glob'
  | 'exists'

export interface Route {
  to: string
  channels?: Channel[]
}

export interface Rule {
  id: string
  name: string
  team: string
  enabled?: boolean
  description?: string
  when: Condition
  notify: Route[]
  present?: {
    title?: string
    body?: string
    fields?: string[]
    color?: string
    severity?: Severity
  }
  /** Alertmanager semantics: fields that form the dedup/group key. */
  group_by?: string[]
  /** Wait before the first notification so a burst becomes one message (e.g. "30s"). */
  group_wait?: string | number
  /** Minimum gap between notifications about new events in an open group (e.g. "5m"). */
  group_interval?: string | number
  /** An open alert that has been quiet this long is closed and the next event opens a new one. */
  dedup_window?: string | number
  runbook?: string
}

export interface WorkingHours {
  from: string
  to: string
  tz?: string
  /** Channels used outside working hours instead of the normal ones. */
  outside: Channel[]
}

export interface Recipient {
  id: string
  name: string
  kind: 'team' | 'person'
  email?: string
  phone?: string
  onCall?: string
  prefs: Partial<Record<Severity, Channel[]>>
  working_hours?: WorkingHours
}

/** The single action kind: an HTTP call. Named actions in config/actions.yaml expand to this. */
export interface WebhookAction {
  method: string
  url: string
  headers?: Record<string, string>
  body?: Json
}

export interface StepDef {
  id: string
  text: string
  /** Name from config/actions.yaml (e.g. "retry_workflow") or "webhook". */
  action?: string
  params?: Record<string, Json>
  approval: 'none' | 'required'
  when?: string
}

export interface Runbook {
  id: string
  title: string
  format: 'yaml' | 'markdown' | 'text'
  file: string
  content: string
  matches?: Record<string, Json>
  steps: StepDef[]
  parsedBy: 'parser' | 'llm' | 'fallback'
}

export type StepStatus = 'todo' | 'awaiting_approval' | 'running' | 'done' | 'failed' | 'skipped'

export interface AlertStep extends StepDef {
  status: StepStatus
  approvedBy?: string
  by?: string
  at?: number
  output?: string
}

export type AlertStatus = 'open' | 'acked' | 'resolved'

export interface Alert {
  id: string
  dedupKey: string
  ruleId: string
  ruleName: string
  team: string
  status: AlertStatus
  severity: Severity
  color: string
  title: string
  body: string
  fields: { label: string; value: string }[]
  steps: AlertStep[]
  runbook: { id: string; title: string; format: Runbook['format'] } | null
  count: number
  notifiedCount: number
  notifySeq: number
  nextNotifyAt: number | null
  lastNotifiedAt: number | null
  firstSeen: number
  lastSeen: number
  source: string
  schemaFp: string
  schemaName: string
  raw: Json
  canonical: Canonical
  approvalCode: string
  approvalExpiresAt: number
  ackedBy?: string | null
  resolvedBy?: string | null
  resolvedAt?: number | null
  resolution?: string | null
}

export type DeliveryStatus = 'pending' | 'sent' | 'dead'

export interface Delivery {
  id: number
  idempotencyKey: string
  alertId: string
  recipient: string
  address: string
  channel: Channel
  reason: 'new' | 'update' | 'unassigned'
  subject: string
  body: string
  status: DeliveryStatus
  attempts: number
  nextAttemptAt: number
  lastError?: string | null
  createdAt: number
  eventReceivedAt: number
  sentAt?: number | null
}

export interface AuditEntry {
  id: number
  at: number
  actor: string
  action: string
  target: string
  detail?: string | null
}
