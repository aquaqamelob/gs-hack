import { alertFields, alertFromRow, resolveAlert } from './alerts'
import { publishAlerts } from './bus'
import { db, type Tx } from './db'
import { insertDeliveries, planDeliveries, unassignedRule, UNASSIGNED_TEAM, wakeOutboxes } from './outbox'
import { evaluate, groupSettings, resolveField } from './rules'
import { count, rt } from './runtime'
import { asJson, normalize } from './schema'
import { observeSchema } from './schemas'
import type { Alert, AlertStep, Canonical, EventView, Json, Rule, Runbook, SchemaRecord, Severity } from './types'
import { newApprovalCode, newId, render, renderDeep, shortHash } from './util'

const SEVERITY_COLOR: Record<Severity, string> = { critical: 'red', error: 'orange', warning: 'amber', info: 'sky' }

interface Prepared extends EventView {
  receivedAt: number
  schema: SchemaRecord
  rules: Rule[]
  alertIds: string[]
}

/** Arrays and Alertmanager webhook envelopes become one event per element. */
export function expand(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload.flatMap(expand)
  if (payload && typeof payload === 'object' && Array.isArray((payload as { alerts?: unknown }).alerts)) {
    const env = payload as { alerts: Record<string, unknown>[]; commonLabels?: Record<string, unknown> }
    return env.alerts.map((a) => ({ ...a, labels: { ...(env.commonLabels ?? {}), ...((a.labels as object) ?? {}) } }))
  }
  return [payload]
}

function recordRuleError(rule: Rule, e: unknown) {
  count(`rule_errors_total{rule="${rule.id}"}`)
  const errors = rt().ruleErrors
  errors.set(rule.id, { count: (errors.get(rule.id)?.count ?? 0) + 1, message: String((e as Error)?.message ?? e).slice(0, 300) })
}

/** Written in the background, so a broken rule adds no queries to the ingest path. */
export async function flushRuleErrors() {
  const errors = rt().ruleErrors
  if (!errors.size) return
  const rows = [...errors].map(([rule_id, x]) => ({ rule_id, count: x.count, last_error: x.message }))
  errors.clear()
  await db()`
    insert into rule_errors (rule_id, count, last_error)
    select rule_id, count, last_error from jsonb_to_recordset(${db().json(rows as never)}::jsonb) as x(rule_id text, count bigint, last_error text)
    on conflict (rule_id) do update set count = rule_errors.count + excluded.count, last_error = excluded.last_error, last_at = now()`
}

async function prepare(payload: unknown, source: string, receivedAt: number): Promise<Prepared> {
  const raw = asJson(payload)
  const schema = await observeSchema(raw, source)
  const ev: EventView = { source, schemaName: schema.name, raw, canonical: normalize(raw, schema) }
  const rules = rt().rules.filter((r) => {
    if (r.enabled === false) return false
    try {
      return evaluate(r.when, ev, (e) => recordRuleError(r, e))
    } catch (e) {
      recordRuleError(r, e)
      return false
    }
  })
  return { ...ev, receivedAt, schema, rules, alertIds: [] }
}

export interface IngestResult {
  accepted: number
  schemas: { fingerprint: string; name: string; status: string }[]
  matchedRules: string[]
  unassigned: number
  alertIds: string[]
}

/** Never rejects an unknown schema. Resolves once the events are durably stored (202 semantics). */
export async function ingest(payload: unknown, source: string, receivedAt = Date.now()): Promise<IngestResult> {
  const items = expand(payload)
  const prepared = await Promise.all(items.map((p) => prepare(p, source, receivedAt)))
  await enqueue(prepared)
  count(`events_ingested_total{source="${source}"}`, prepared.length)
  const schemas = new Map(prepared.map((p) => [p.schema.fingerprint, { fingerprint: p.schema.fingerprint, name: p.schema.name, status: p.schema.status }]))
  return {
    accepted: prepared.length,
    schemas: [...schemas.values()],
    matchedRules: [...new Set(prepared.flatMap((p) => p.rules.map((r) => r.id)))],
    unassigned: prepared.filter(isUnassigned).length,
    alertIds: [...new Set(prepared.flatMap((p) => p.alertIds))],
  }
}

const isUnassigned = (p: Prepared) => p.rules.length === 0 && p.schema.status === 'needs-review'

// ---------------------------------------------------------------- group commit

type Job = { items: Prepared[]; resolve: () => void; reject: (e: unknown) => void }
const queue: Job[] = []
let flushing = false
const MAX_BATCH = 1000

function enqueue(items: Prepared[]) {
  return new Promise<void>((resolve, reject) => {
    queue.push({ items, resolve, reject })
    if (!flushing) {
      flushing = true
      setImmediate(flushLoop)
    }
  })
}

async function flushLoop() {
  while (queue.length) {
    const jobs: Job[] = []
    let n = 0
    while (queue.length && n < MAX_BATCH) {
      const j = queue.shift()!
      jobs.push(j)
      n += j.items.length
    }
    const items = jobs.flatMap((j) => j.items)
    try {
      await writeWithRetry(items)
      jobs.forEach((j) => j.resolve())
    } catch (e) {
      jobs.forEach((j) => j.reject(e))
    }
  }
  flushing = false
}

async function writeWithRetry(items: Prepared[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await writeBatch(items)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (attempt < 4 && (code === '40P01' || code === '40001' || code === '23505')) continue
      throw e
    }
  }
}

// ---------------------------------------------------------------- alert upsert

interface GroupOp {
  key: string
  rule: Rule
  first: Prepared
  last: Prepared
  n: number
  resolve: boolean
  members: Prepared[]
  queuedDelivery?: boolean
}

export function dedupKey(rule: Rule, ev: EventView) {
  const { groupBy } = groupSettings(rule)
  return `${rule.id}:${shortHash(groupBy.map((f) => String(resolveField(ev, f) ?? '∅')).join('|'))}`
}

function findRunbook(rule: Rule, ev: EventView): Runbook | undefined {
  const runbooks = rt().runbooks
  if (rule.runbook && runbooks.has(rule.runbook)) return runbooks.get(rule.runbook)
  for (const rb of runbooks.values()) {
    if (!rb.matches || !Object.keys(rb.matches).length) continue
    const hit = Object.entries(rb.matches).every(
      ([field, value]) => String(resolveField(ev, field) ?? '').toLowerCase() === String(value).toLowerCase()
    )
    if (hit) return rb
  }
  return undefined
}

function defaultTitle(c: Canonical, schemaName: string) {
  const what = c.title ?? c['error.message'] ?? schemaName
  return c.service ? `${what} on ${c.service}` : what
}

export function draftAlert(rule: Rule, ev: Prepared, n: number): Alert {
  const now = Date.now()
  const severity: Severity = rule.present?.severity ?? (ev.canonical.severity as Severity | undefined) ?? 'warning'
  const id = newId('alr')
  const base = { id, title: '', team: rule.team, count: n, severity }
  const fields = alertFields(base, ev)
  const unassigned = rule.team === UNASSIGNED_TEAM
  const title = unassigned
    ? `Unmapped event from ${ev.source}: ${ev.schema.name}`
    : render(rule.present?.title ?? '', fields).trim() || defaultTitle(ev.canonical, ev.schemaName)
  base.title = title
  const body = unassigned
    ? `No rule matched and the schema is not mapped yet. Map it so rules can use its fields.`
    : render(rule.present?.body ?? '{{error.message}}', fields).trim()
  const runbook = unassigned ? undefined : findRunbook(rule, ev)
  const steps: AlertStep[] = (runbook?.steps ?? []).map((st) => ({
    ...st,
    text: render(st.text, fields),
    ...(st.params ? { params: renderDeep(st.params as Json, (p) => (p.startsWith('env.') ? `{{${p}}}` : fields(p))) as Record<string, Json> } : {}),
    status: 'todo',
  }))
  return {
    id,
    dedupKey: '',
    ruleId: rule.id,
    ruleName: rule.name,
    team: rule.team,
    status: 'open',
    severity,
    color: rule.present?.color ?? SEVERITY_COLOR[severity],
    title,
    body,
    fields: (rule.present?.fields ?? []).map((f) => {
      const v = fields(f)
      return { label: f, value: v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v) }
    }),
    steps,
    runbook: runbook ? { id: runbook.id, title: runbook.title, format: runbook.format } : null,
    count: n,
    notifiedCount: 0,
    notifySeq: 0,
    nextNotifyAt: null,
    lastNotifiedAt: null,
    firstSeen: now,
    lastSeen: now,
    source: ev.source,
    schemaFp: ev.schema.fingerprint,
    schemaName: ev.schemaName,
    raw: ev.raw,
    canonical: ev.canonical,
    approvalCode: newApprovalCode(),
    approvalExpiresAt: now + 60 * 60 * 1000,
  }
}

async function upsert(tx: Tx, op: GroupOp): Promise<string> {
  const { waitSec, intervalSec, windowSec } = groupSettings(op.rule)
  const a = draftAlert(op.rule, op.first, op.n)
  a.dedupKey = op.key
  const immediate = waitSec === 0
  const nextNotify = immediate ? null : new Date(op.first.receivedAt + waitSec * 1000)
  const lastRaw = op.last.raw
  const lastCanonical = op.last.canonical

  const insert = (q: Tx) => q`
    insert into alerts (id, dedup_key, rule_id, rule_name, team, severity, title, body, color, fields, steps, runbook, count,
      notified_count, notify_seq, group_interval_s, next_notify_at, last_notified_at, first_received_at, source, schema_fp, schema_name,
      raw, canonical, approval_code, approval_expires_at)
    values (${a.id}, ${a.dedupKey}, ${a.ruleId}, ${a.ruleName}, ${a.team}, ${a.severity}, ${a.title}, ${a.body}, ${a.color},
      ${tx.json(a.fields as never)}, ${tx.json(a.steps as never)}, ${a.runbook ? tx.json(a.runbook as never) : null}, ${op.n},
      ${immediate ? op.n : 0}, ${immediate ? 1 : 0}, ${intervalSec}, ${nextNotify}, ${immediate ? new Date() : null},
      ${new Date(op.first.receivedAt)}, ${a.source}, ${a.schemaFp}, ${a.schemaName},
      ${tx.json(lastRaw as never)}, ${tx.json(lastCanonical as never)}, ${a.approvalCode}, ${new Date(a.approvalExpiresAt)})
    on conflict (dedup_key) where status <> 'resolved' do update set
      count = alerts.count + excluded.count,
      last_seen = now(),
      raw = excluded.raw,
      canonical = excluded.canonical,
      next_notify_at = case
        when alerts.status = 'open' then coalesce(alerts.next_notify_at,
          greatest(alerts.last_notified_at + make_interval(secs => alerts.group_interval_s), now()))
        else alerts.next_notify_at end
    where alerts.last_seen > now() - make_interval(secs => ${windowSec})
    returning id, (xmax = 0) as inserted`

  // A reply-code clash aborts the statement, so each attempt runs in a savepoint and retries with a fresh code.
  const attempt = async () => {
    for (let i = 0; ; i++) {
      try {
        return await tx.savepoint((sp) => insert(sp))
      } catch (e) {
        if (i >= 4 || (e as { constraint_name?: string }).constraint_name !== 'alerts_code_open') throw e
        a.approvalCode = newApprovalCode()
      }
    }
  }

  let [row] = await attempt()
  if (!row) {
    // The open alert has been quiet longer than dedup_window: close it and start a new one.
    const [stale] = await tx`select id from alerts where dedup_key = ${op.key} and status <> 'resolved'`
    if (stale) await resolveAlert(stale.id as string, 'system', 'Quiet for longer than the dedup window', tx)
    ;[row] = await attempt()
  }
  const id = row.id as string
  if (row.inserted) {
    count('alerts_created_total')
    if (immediate) {
      a.notifySeq = 1
      const reason = a.team === UNASSIGNED_TEAM ? 'unassigned' : 'new'
      await insertDeliveries(tx, planDeliveries(a, op.rule, reason, op.first.receivedAt))
      op.queuedDelivery = true
    }
  } else {
    count('events_deduplicated_total', op.n)
  }
  return id
}

async function resolveByKey(tx: Tx, key: string, source: string) {
  const [row] = await tx`select * from alerts where dedup_key = ${key} and status <> 'resolved' for update`
  if (!row) return undefined
  await resolveAlert(alertFromRow(row).id, `source:${source}`, 'Source reported the problem is gone', tx)
  return row.id as string
}

async function writeBatch(items: Prepared[]) {
  const ops = new Map<string, GroupOp[]>()
  const push = (rule: Rule, p: Prepared) => {
    const key = rule.team === UNASSIGNED_TEAM ? `__unassigned:${p.schema.fingerprint}` : dedupKey(rule, p)
    const list = ops.get(key) ?? []
    const resolve = Boolean(p.canonical.resolved)
    const tail = list[list.length - 1]
    if (tail && !tail.resolve && !resolve) {
      tail.n++
      tail.last = p
      tail.members.push(p)
    } else {
      list.push({ key, rule, first: p, last: p, n: 1, resolve, members: [p] })
    }
    ops.set(key, list)
  }
  for (const p of items) {
    for (const rule of p.rules) push(rule, p)
    if (isUnassigned(p)) {
      count('unmapped_events_total')
      push(unassignedRule(), p)
    }
    if (!p.rules.length) count('events_unrouted_total')
  }

  const touched = new Set<string>()
  await db().begin(async (tx) => {
    touched.clear()
    for (const p of items) p.alertIds = []
    // Consistent lock order across instances: sort by dedup key.
    for (const key of [...ops.keys()].sort()) {
      for (const op of ops.get(key)!) {
        const id = op.resolve ? await resolveByKey(tx, key, op.first.source) : await upsert(tx, op)
        if (!id) continue
        touched.add(id)
        for (const p of op.members) p.alertIds.push(id)
      }
    }
    await tx`
      insert into events ${tx(
        items.map((p) => ({
          receivedAt: new Date(p.receivedAt),
          source: p.source,
          schemaFp: p.schema.fingerprint,
          raw: tx.json(p.raw as never),
          canonical: tx.json(p.canonical as never),
          matched: p.rules.map((r) => r.id),
          alertIds: p.alertIds,
        })) as never,
        'receivedAt',
        'source',
        'schemaFp',
        'raw',
        'canonical',
        'matched',
        'alertIds'
      )}`
  })
  const queued = [...ops.values()].some((list) => list.some((op) => op.queuedDelivery))
  await Promise.all([publishAlerts(touched), queued ? wakeOutboxes() : undefined])
}
