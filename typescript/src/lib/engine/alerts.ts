import { resolveWebhook, runWebhook } from './actions'
import { audit, publish } from './bus'
import { db, ms, type Tx } from './db'
import { deliveryFromRow } from './outbox'
import { resolveField } from './rules'
import type { Alert, AlertStep, AuditEntry, EventView } from './types'

export function alertFromRow(r: Record<string, unknown>): Alert {
  return {
    id: r.id as string,
    dedupKey: r.dedupKey as string,
    ruleId: r.ruleId as string,
    ruleName: r.ruleName as string,
    team: r.team as string,
    status: r.status as Alert['status'],
    severity: r.severity as Alert['severity'],
    color: r.color as string,
    title: r.title as string,
    body: r.body as string,
    fields: r.fields as Alert['fields'],
    steps: r.steps as AlertStep[],
    runbook: r.runbook as Alert['runbook'],
    count: Number(r.count),
    notifiedCount: Number(r.notifiedCount),
    notifySeq: Number(r.notifySeq),
    nextNotifyAt: ms(r.nextNotifyAt as Date),
    lastNotifiedAt: ms(r.lastNotifiedAt as Date),
    firstSeen: ms(r.firstSeen as Date)!,
    lastSeen: ms(r.lastSeen as Date)!,
    source: r.source as string,
    schemaFp: r.schemaFp as string,
    schemaName: r.schemaName as string,
    raw: r.raw as Alert['raw'],
    canonical: r.canonical as Alert['canonical'],
    approvalCode: r.approvalCode as string,
    approvalExpiresAt: ms(r.approvalExpiresAt as Date)!,
    ackedBy: r.ackedBy as string | null,
    resolvedBy: r.resolvedBy as string | null,
    resolvedAt: ms(r.resolvedAt as Date),
    resolution: r.resolution as string | null,
  }
}

export type AlertSummary = Omit<Alert, 'raw' | 'canonical'>

export function summary(a: Alert): AlertSummary {
  const { raw: _r, canonical: _c, ...rest } = a
  return rest
}

export async function listAlerts(opts: { team?: string; status?: string; limit?: number } = {}) {
  const limit = Math.min(500, opts.limit ?? 200)
  const rows = await db()`
    select * from alerts
    where (${opts.team ?? null}::text is null or team = ${opts.team ?? null})
      and (${opts.status ?? null}::text is null or status = ${opts.status ?? null})
    order by (status = 'resolved'), last_seen desc
    limit ${limit}`
  return rows.map((r) => summary(alertFromRow(r)))
}

export async function getAlert(id: string) {
  const [row] = await db()`select * from alerts where id = ${id}`
  return row ? alertFromRow(row) : undefined
}

export async function getAlertsByIds(ids: string[]) {
  if (!ids.length) return []
  const rows = await db()`select * from alerts where id in ${db()(ids)}`
  return rows.map((r) => summary(alertFromRow(r)))
}

export async function alertDetail(id: string) {
  const alert = await getAlert(id)
  if (!alert) return undefined
  const deliveries = (await db()`select * from deliveries where alert_id = ${id} order by id`).map(deliveryFromRow)
  const auditRows = await db()<(Omit<AuditEntry, 'at'> & { at: Date })[]>`
    select * from audit_log where target = ${id} order by id desc limit 100`
  return { ...alert, deliveries, audit: auditRows.reverse().map((a) => ({ ...a, id: Number(a.id), at: ms(a.at)! })) }
}

async function withAlert<T>(id: string, fn: (a: Alert, tx: Tx) => Promise<T>): Promise<T> {
  return db().begin(async (tx) => {
    const [row] = await tx`select * from alerts where id = ${id} for update`
    if (!row) throw new Error('Alert not found')
    return fn(alertFromRow(row), tx)
  }) as Promise<T>
}

async function saveSteps(tx: Tx, a: Alert) {
  await tx`update alerts set steps = ${tx.json(a.steps as never)} where id = ${a.id}`
  await publish({ type: 'alert', id: a.id }, tx)
}

export async function ackAlert(id: string, actor: string) {
  return withAlert(id, async (a, tx) => {
    if (a.status !== 'open') return a
    await tx`update alerts set status = 'acked', acked_by = ${actor}, next_notify_at = null where id = ${id}`
    await audit(actor, 'alert.acked', id, a.title, tx)
    await publish({ type: 'alert', id }, tx)
    return { ...a, status: 'acked' as const }
  })
}

export async function resolveAlert(id: string, actor: string, note?: string, tx?: Tx) {
  const run = async (a: Alert, t: Tx) => {
    if (a.status === 'resolved') return a
    await t`
      update alerts set status = 'resolved', resolved_by = ${actor}, resolved_at = now(), resolution = ${note ?? null}, next_notify_at = null
      where id = ${a.id}`
    await audit(actor, 'alert.resolved', a.id, note ? `${a.title} — ${note}` : a.title, t)
    await publish({ type: 'alert', id: a.id }, t)
    return { ...a, status: 'resolved' as const }
  }
  if (tx) {
    const [row] = await tx`select * from alerts where id = ${id} for update`
    return row ? run(alertFromRow(row), tx) : undefined
  }
  return withAlert(id, run)
}

export async function reopenAlert(id: string, actor: string) {
  return withAlert(id, async (a, tx) => {
    const [clash] = await tx`select id from alerts where dedup_key = ${a.dedupKey} and status <> 'resolved' and id <> ${id}`
    if (clash) throw new Error(`A newer alert with the same dedup key is open: ${clash.id}`)
    await tx`update alerts set status = 'open', resolved_at = null, resolved_by = null where id = ${id}`
    await audit(actor, 'alert.reopened', id, a.title, tx)
    await publish({ type: 'alert', id }, tx)
  })
}

export async function addNote(id: string, actor: string, note: string) {
  await audit(actor, 'alert.note', id, note.slice(0, 1000))
  await publish({ type: 'alert', id })
}

const eventOf = (a: Alert): EventView => ({ source: a.source, schemaName: a.schemaName, raw: a.raw, canonical: a.canonical })

export function alertFields(a: Pick<Alert, 'id' | 'title' | 'team' | 'count' | 'severity'> & Partial<Alert>, ev: EventView) {
  return (p: string): unknown => {
    if (p.startsWith('alert.')) return (a as Record<string, unknown>)[p.slice(6)]
    if (p === 'count') return a.count
    return resolveField(ev, p)
  }
}

/** Run the next steps when every unconditional step is finished. */
function runbookFinished(a: Alert) {
  const core = a.steps.filter((s) => !s.when)
  return core.length > 0 && core.some((s) => s.action) && core.every((s) => s.status === 'done' || s.status === 'skipped')
}

export type StepOp = 'run' | 'approve' | 'skip' | 'done' | 'reset'

export async function stepAction(id: string, stepId: string, op: StepOp, actor: string) {
  const prepared = await withAlert(id, async (a, tx) => {
    const step = a.steps.find((s) => s.id === stepId)
    if (!step) throw new Error('Unknown step')
    if (a.status === 'resolved' && op !== 'reset') throw new Error('Alert is resolved')
    if (step.status === 'running') throw new Error('Step is already running')
    const now = Date.now()
    if (op === 'skip' || op === 'done') {
      step.status = op === 'skip' ? 'skipped' : 'done'
      step.by = actor
      step.at = now
      step.output = op === 'done' ? 'Marked as done' : undefined
      await audit(actor, `step.${op === 'skip' ? 'skipped' : 'done'}`, id, step.text, tx)
    } else if (op === 'reset') {
      Object.assign(step, { status: 'todo', output: undefined, approvedBy: undefined })
    } else if (op === 'run' && step.approval === 'required' && !step.approvedBy) {
      step.status = 'awaiting_approval'
      step.by = actor
      await audit(actor, 'step.approval-requested', id, step.text, tx)
    } else {
      if (op === 'approve') {
        if (step.approval !== 'required') throw new Error('This step does not need approval')
        step.approvedBy = actor
        await audit(actor, 'step.approved', id, step.text, tx)
      }
      if (!step.action) {
        step.status = 'done'
        step.by = actor
        step.at = now
        step.output = 'Done by hand'
        await audit(actor, 'step.done', id, step.text, tx)
      } else {
        step.status = 'running'
        step.by = actor
        await saveSteps(tx, a)
        return { alert: a, step: { ...step } }
      }
    }
    await saveSteps(tx, a)
    if (runbookFinished(a) && a.status !== 'resolved') await resolveAlert(id, 'system', 'Runbook completed', tx)
    return null
  })
  if (!prepared) return (await getAlert(id))?.steps.find((s) => s.id === stepId)

  const { alert, step } = prepared
  const fields = alertFields(alert, eventOf(alert))
  const webhook = resolveWebhook(step, fields, true)
  const result =
    'error' in webhook ? { ok: false, output: webhook.error } : await runWebhook(webhook, `${alert.id}:${step.id}:${Date.now()}`)
  const shown = resolveWebhook(step, fields, false)
  let output = result.output
  if (!('error' in webhook) && !('error' in shown)) output = output.split(webhook.url).join(shown.url)

  return withAlert(id, async (a, tx) => {
    const s = a.steps.find((x) => x.id === stepId)!
    s.status = result.ok ? 'done' : 'failed'
    s.output = output
    s.at = Date.now()
    await audit(actor, result.ok ? 'step.executed' : 'step.failed', id, `${s.text} → ${output}`, tx)
    await saveSteps(tx, a)
    if (runbookFinished(a) && a.status !== 'resolved') await resolveAlert(id, 'system', 'Runbook completed', tx)
    return s
  })
}

export async function handleReply(from: string, text: string) {
  const m = text.trim().match(/^(YES|TAK|APPROVE|ACK|OK|RESOLVE)\s+(\d{4})\b/i)
  if (!m) return { ok: false, message: 'Unrecognised reply. Use "ACK 1234", "YES 1234" or "RESOLVE 1234".' }
  const verb = m[1].toUpperCase()
  const [row] = await db()`
    select id from alerts
    where approval_code = ${m[2]} and status <> 'resolved' and approval_expires_at > now()
    order by first_seen desc limit 1`
  if (!row) return { ok: false, message: `No open alert with code ${m[2]} (expired or unknown).` }
  const id = row.id as string
  const actor = `reply:${from}`
  if (verb === 'ACK' || verb === 'OK') {
    const a = await ackAlert(id, actor)
    return { ok: true, message: `Acknowledged: ${a.title}`, alertId: id }
  }
  if (verb === 'RESOLVE') {
    const a = await resolveAlert(id, actor, 'Resolved by reply')
    return { ok: true, message: `Resolved: ${a?.title}`, alertId: id }
  }
  const alert = (await getAlert(id))!
  const step =
    alert.steps.find((s) => s.status === 'awaiting_approval') ??
    alert.steps.find((s) => s.approval === 'required' && (s.status === 'todo' || s.status === 'failed'))
  if (!step) return { ok: false, message: 'Nothing waiting for approval on this alert.' }
  const done = await stepAction(id, step.id, 'approve', actor)
  return { ok: true, message: `Approved and ran: ${step.text} → ${done?.output}`, alertId: id }
}
