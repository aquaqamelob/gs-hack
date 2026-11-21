import { audit, publishAlerts } from './bus'
import { ADAPTERS, addressFor, channelsFor, findRecipient, formatFor } from './channels'
import { db, ms, type Tx } from './db'
import { count, rt } from './runtime'
import type { Alert, Channel, Delivery, Rule } from './types'

export const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10)
const LEASE_SEC = 30
const CLAIM_BATCH = 200
export const OUTBOX_CHANNEL = 'ctrl_outbox'

/** Exponential backoff with jitter: 0.5s, 1s, 2s … capped at 30s. */
export function backoffMs(attempts: number, random = Math.random()) {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempts - 1)) * (0.8 + random * 0.4)
}

export const UNASSIGNED_TEAM = 'unassigned'

export function unassignedRule(): Rule {
  return {
    id: '__unassigned',
    name: 'Unassigned (unmapped schema)',
    team: UNASSIGNED_TEAM,
    when: { all: [] },
    notify: [{ to: rt().defaultOwner, channels: ['email', 'ui'] }],
    group_wait: 0,
    group_interval: '1h',
  }
}

export function ruleFor(id: string): Rule | undefined {
  if (id === '__unassigned') return unassignedRule()
  return rt().rules.find((r) => r.id === id)
}

export interface PlannedDelivery {
  idempotencyKey: string
  alertId: string
  recipient: string
  address: string
  channel: Channel
  reason: Delivery['reason']
  subject: string
  body: string
  eventReceivedAt: Date
}

/**
 * Who gets what, on which channel. Idempotency key = alert + notification sequence + channel + recipient.
 * `at` is when the notification goes out: working hours are checked at that moment (the noise budget passes event times).
 */
export function planDeliveries(
  alert: Alert,
  rule: Rule | undefined,
  reason: Delivery['reason'],
  eventReceivedAt: number,
  at = Date.now()
): PlannedDelivery[] {
  const out: PlannedDelivery[] = []
  const routes = rule?.notify?.length ? rule.notify : [{ to: alert.team }]
  let ui = false
  const add = (recipientId: string, address: string, channel: Channel) => {
    const { subject, body } = formatFor(channel, alert, reason)
    out.push({
      idempotencyKey: `${alert.id}:${alert.notifySeq}:${channel}:${recipientId}`,
      alertId: alert.id,
      recipient: recipientId,
      address,
      channel,
      reason,
      subject,
      body,
      eventReceivedAt: new Date(eventReceivedAt),
    })
  }
  for (const route of routes) {
    const recipient = findRecipient(route.to)
    for (const channel of channelsFor(route, recipient, alert.severity, at)) {
      if (channel === 'ui') ui = true
      add(recipient?.id ?? route.to, addressFor(recipient, channel, route.to), channel)
    }
  }
  if (!ui) add(alert.team, alert.team, 'ui')
  return out.filter((d, i, all) => all.findIndex((x) => x.idempotencyKey === d.idempotencyKey) === i)
}

export async function insertDeliveries(tx: Tx, rows: PlannedDelivery[]) {
  if (!rows.length) return
  await tx`
    insert into deliveries ${tx(rows as never, 'idempotencyKey', 'alertId', 'recipient', 'address', 'channel', 'reason', 'subject', 'body', 'eventReceivedAt')}
    on conflict (idempotency_key) do nothing`
  count('notifications_enqueued_total', rows.length)
}

/** Call after commit. Only a latency optimisation: every dispatcher also polls the outbox every 250 ms. */
export async function wakeOutboxes() {
  await db()`select set_config('synchronous_commit', 'off', true), pg_notify(${OUTBOX_CHANNEL}, '')`.catch((e) =>
    console.error('[outbox] wake failed:', (e as Error).message)
  )
}

// ---------------------------------------------------------------- dispatcher

type Claimed = {
  id: string
  idempotencyKey: string
  alertId: string
  recipient: string
  address: string
  channel: Channel
  subject: string
  body: string
  attempts: number
}

let running = false
let again = false

export function wakeDispatcher() {
  if (running) {
    again = true
    return
  }
  void drain()
}

async function drain() {
  running = true
  try {
    do {
      again = false
      const claimed = await db()<Claimed[]>`
        with due as (
          select id from deliveries
          where status = 'pending' and next_attempt_at <= now()
          order by next_attempt_at
          limit ${CLAIM_BATCH}
          for update skip locked
        )
        update deliveries d
        set next_attempt_at = now() + make_interval(secs => ${LEASE_SEC}), attempts = d.attempts + 1, leased_by = ${rt().instance}
        from due where d.id = due.id
        returning d.id, d.idempotency_key, d.alert_id, d.recipient, d.address, d.channel, d.subject, d.body, d.attempts`
      if (!claimed.length) break
      const results = await Promise.all(claimed.map(sendOne))
      await complete(results)
      if (claimed.length === CLAIM_BATCH) again = true
    } while (again)
  } catch (e) {
    console.error('[outbox] dispatcher error', (e as Error).message)
  } finally {
    running = false
  }
}

type Result = { id: string; ok: boolean; sentAt: string; error: string | null; attempts: number; alertId: string; channel: string; address: string }

async function sendOne(d: Claimed): Promise<Result> {
  const base = { id: d.id, attempts: d.attempts, alertId: d.alertId, channel: d.channel, address: d.address }
  try {
    if (!d.address) throw new Error(`no ${d.channel} address for ${d.recipient}`)
    await ADAPTERS[d.channel].send(d)
    count(`deliveries_sent_total{channel="${d.channel}"}`)
    return { ...base, ok: true, sentAt: new Date().toISOString(), error: null }
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code
    count(`deliveries_failed_total{channel="${d.channel}"}`)
    return { ...base, ok: false, sentAt: new Date().toISOString(), error: (cause ?? (e as Error).message).slice(0, 300) }
  }
}

async function complete(results: Result[]) {
  const rows = results.map((r) => ({
    id: r.id,
    status: r.ok ? 'sent' : r.attempts >= MAX_ATTEMPTS ? 'dead' : 'pending',
    sent_at: r.ok ? r.sentAt : null,
    retry_ms: r.ok ? 0 : Math.round(backoffMs(r.attempts)),
    error: r.error,
  }))
  await db()`
    update deliveries d set
      status = x.status,
      sent_at = x.sent_at,
      last_error = x.error,
      next_attempt_at = case when x.status = 'pending' then now() + make_interval(secs => x.retry_ms / 1000.0) else d.next_attempt_at end
    from jsonb_to_recordset(${db().json(rows as never)}::jsonb) as x(id bigint, status text, sent_at timestamptz, retry_ms int, error text)
    where d.id = x.id`
  const dead = results.filter((r, i) => rows[i].status === 'dead')
  for (const r of dead) {
    count('deliveries_dead_total')
    await audit('system', 'delivery.dead-letter', r.alertId, `${r.channel} to ${r.address}: ${r.error}`)
  }
  await publishAlerts(new Set(results.map((r) => r.alertId)))
}

export async function requeueDelivery(id: number, actor: string) {
  const [row] = await db()<{ alertId: string; channel: string; address: string }[]>`
    update deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
    where id = ${id} and status = 'dead'
    returning alert_id, channel, address`
  if (!row) return false
  await audit(actor, 'delivery.requeued', row.alertId, `${row.channel} to ${row.address}`)
  await db()`select pg_notify(${OUTBOX_CHANNEL}, '')`
  return true
}

// ---------------------------------------------------------------- group scheduler (group_wait / group_interval)

let scheduling = false

export async function scheduleTick(loadAlert: (row: never) => Alert) {
  if (scheduling) return
  scheduling = true
  try {
    const notified = new Set<string>()
    await db().begin(async (tx) => {
      const due = await tx`
        select * from alerts where next_notify_at <= now()
        order by next_notify_at limit 100 for update skip locked`
      for (const row of due) {
        const alert = loadAlert(row as never)
        if (alert.status !== 'open' || alert.count <= alert.notifiedCount) {
          await tx`update alerts set next_notify_at = null where id = ${alert.id}`
          continue
        }
        const reason: Delivery['reason'] = alert.notifiedCount === 0 ? (alert.team === UNASSIGNED_TEAM ? 'unassigned' : 'new') : 'update'
        alert.notifySeq += 1
        const planned = planDeliveries(alert, ruleFor(alert.ruleId), reason, alert.lastSeen)
        await insertDeliveries(tx, planned)
        await tx`
          update alerts set notify_seq = ${alert.notifySeq}, notified_count = ${alert.count}, last_notified_at = now(), next_notify_at = null
          where id = ${alert.id}`
        notified.add(alert.id)
      }
    })
    if (notified.size) await Promise.all([wakeOutboxes(), publishAlerts(notified)])
  } catch (e) {
    console.error('[outbox] scheduler error', (e as Error).message)
  } finally {
    scheduling = false
  }
}

export function deliveryFromRow(r: Record<string, unknown>): Delivery {
  return {
    id: Number(r.id),
    idempotencyKey: r.idempotencyKey as string,
    alertId: r.alertId as string,
    recipient: r.recipient as string,
    address: r.address as string,
    channel: r.channel as Channel,
    reason: r.reason as Delivery['reason'],
    subject: r.subject as string,
    body: r.body as string,
    status: r.status as Delivery['status'],
    attempts: Number(r.attempts),
    nextAttemptAt: ms(r.nextAttemptAt as Date)!,
    lastError: r.lastError as string | null,
    createdAt: ms(r.createdAt as Date)!,
    eventReceivedAt: ms(r.eventReceivedAt as Date)!,
    sentAt: ms(r.sentAt as Date),
  }
}
