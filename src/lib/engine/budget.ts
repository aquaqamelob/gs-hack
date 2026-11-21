import { findRecipient, insideWorkingHours } from './channels'
import { planDeliveries } from './outbox'
import { dedupKey } from './pipeline'
import { groupSettings } from './rules'
import type { Alert, Channel, Delivery, EventView, Rule, Severity } from './types'

/**
 * Noise budget: replay stored events through a rule the way the pipeline would, and count what each recipient
 * would have received on each channel. Same dedup key, group_wait, group_interval and dedup_window semantics as
 * pipeline.upsert + outbox.scheduleTick, and the real planDeliveries (routing, preferences, working hours at the
 * moment each notification would go out). Assumes nobody acknowledges in between. No extrapolation.
 */
export interface BudgetLine {
  recipient: string
  name: string
  channel: Channel
  count: number
  outsideHours: number
}

export interface Budget {
  events: number
  notifications: number
  from: number | null
  to: number | null
  lines: BudgetLine[]
}

interface Group {
  count: number
  notifiedCount: number
  notifySeq: number
  lastNotifiedAt: number | null
  nextNotifyAt: number | null
  lastSeen: number
  severity: Severity
}

export function simulateBudget(rule: Rule, events: { at: number; ev: EventView }[]): Budget {
  const { waitSec, intervalSec, windowSec } = groupSettings(rule)
  const sorted = [...events].sort((a, b) => a.at - b.at)
  const groups = new Map<string, Group>()
  const lines = new Map<string, BudgetLine>()
  let notifications = 0

  const notify = (g: Group, at: number, reason: Delivery['reason']) => {
    notifications++
    g.notifySeq++
    const alert = {
      id: 'preview',
      team: rule.team,
      severity: g.severity,
      title: rule.name,
      body: '',
      count: g.count,
      notifySeq: g.notifySeq,
      steps: [],
      fields: [],
      runbook: null,
      approvalCode: '000000',
    } as unknown as Alert
    for (const d of planDeliveries(alert, rule, reason, at, at)) {
      const key = `${d.recipient}:${d.channel}`
      const r = findRecipient(d.recipient)
      const line = lines.get(key) ?? { recipient: d.recipient, name: r?.name ?? d.recipient, channel: d.channel, count: 0, outsideHours: 0 }
      line.count++
      if (r?.working_hours && !insideWorkingHours(r, at)) line.outsideHours++
      lines.set(key, line)
    }
    g.notifiedCount = g.count
    g.lastNotifiedAt = at
    g.nextNotifyAt = null
  }

  // A scheduled group notification fires at next_notify_at, and only if events arrived since the last one.
  const fireDue = (g: Group, until: number) => {
    if (g.nextNotifyAt === null || g.nextNotifyAt > until) return
    const at = g.nextNotifyAt
    if (g.count <= g.notifiedCount) g.nextNotifyAt = null
    else notify(g, at, g.notifiedCount === 0 ? 'new' : 'update')
  }

  for (const { at, ev } of sorted) {
    const key = dedupKey(rule, ev)
    let g = groups.get(key)
    if (g) fireDue(g, at)
    if (ev.canonical.resolved) {
      groups.delete(key)
      continue
    }
    if (g && at - g.lastSeen > windowSec * 1000) g = undefined // quiet longer than dedup_window: a new alert
    if (!g) {
      const severity = rule.present?.severity ?? (ev.canonical.severity as Severity | undefined) ?? 'warning'
      g = { count: 1, notifiedCount: 0, notifySeq: 0, lastNotifiedAt: null, nextNotifyAt: null, lastSeen: at, severity }
      groups.set(key, g)
      if (waitSec === 0) notify(g, at, 'new')
      else g.nextNotifyAt = at + waitSec * 1000
      continue
    }
    g.count++
    g.lastSeen = at
    g.nextNotifyAt ??= Math.max((g.lastNotifiedAt ?? at) + intervalSec * 1000, at)
  }
  // Notifications already scheduled by these events would still go out, even after the last event.
  for (const g of groups.values()) fireDue(g, Infinity)

  return {
    events: sorted.length,
    notifications,
    from: sorted[0]?.at ?? null,
    to: sorted.at(-1)?.at ?? null,
    lines: [...lines.values()].sort((a, b) => (a.channel === 'ui' ? 1 : 0) - (b.channel === 'ui' ? 1 : 0) || b.count - a.count),
  }
}
