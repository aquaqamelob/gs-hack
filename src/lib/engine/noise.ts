import { findRecipient, insideWorkingHours } from './channels'
import { planDeliveries } from './outbox'
import { dedupKey, draftAlert, type Prepared } from './pipeline'
import { groupSettings } from './rules'
import type { Channel, Rule } from './types'

export interface NoiseLine {
  recipient: string
  name: string
  channel: Channel
  count: number
  outsideHours: number
}

export interface NoiseBudget {
  fromMs: number | null
  toMs: number | null
  alerts: number
  notifications: number
  lines: NoiseLine[]
}

interface Group {
  first: Prepared
  count: number
  notified: number
  seq: number
  lastSeen: number
  lastNotified: number | null
  next: number | null
}

/**
 * Replays matching events through the same grouping as the live path (upsert + scheduleTick) and the real planDeliveries,
 * using each notification's own time for working hours. Read-only: nothing is stored or sent. A notification still waiting
 * for group_wait or group_interval at the end of the window is counted, because it would go out unless the alert closes.
 */
export function noiseBudget(rule: Rule, matched: Prepared[]): NoiseBudget {
  const { waitSec, intervalSec, windowSec } = groupSettings(rule)
  const events = [...matched].sort((a, b) => a.receivedAt - b.receivedAt)
  const open = new Map<string, Group>()
  const lines = new Map<string, NoiseLine>()
  let alerts = 0
  let notifications = 0

  const fire = (g: Group, at: number) => {
    g.next = null
    if (g.count <= g.notified) return
    const reason = g.notified === 0 ? 'new' : 'update'
    const alert = draftAlert(rule, g.first, g.count)
    alert.notifySeq = ++g.seq
    for (const d of planDeliveries(alert, rule, reason, at, at)) {
      const key = `${d.recipient}:${d.channel}`
      const recipient = findRecipient(d.recipient)
      const line = lines.get(key) ?? { recipient: d.recipient, name: recipient?.name ?? d.recipient, channel: d.channel, count: 0, outsideHours: 0 }
      line.count++
      if (recipient?.working_hours && !insideWorkingHours(recipient, at)) line.outsideHours++
      lines.set(key, line)
    }
    g.notified = g.count
    g.lastNotified = at
    notifications++
  }

  const fireDue = (until: number) => {
    const due = [...open.values()].filter((g) => g.next !== null && g.next <= until).sort((a, b) => a.next! - b.next!)
    for (const g of due) fire(g, g.next!)
  }

  for (const ev of events) {
    const t = ev.receivedAt
    fireDue(t)
    const key = dedupKey(rule, ev)
    if (ev.canonical.resolved) {
      open.delete(key)
      continue
    }
    let g = open.get(key)
    if (g && t - g.lastSeen > windowSec * 1000) g = undefined
    if (!g) {
      g = { first: ev, count: 1, notified: 0, seq: 0, lastSeen: t, lastNotified: null, next: waitSec ? t + waitSec * 1000 : null }
      open.set(key, g)
      alerts++
      if (!waitSec) fire(g, t)
      continue
    }
    g.count++
    g.lastSeen = t
    g.next ??= Math.max((g.lastNotified ?? t) + intervalSec * 1000, t)
  }
  fireDue(Infinity)

  return {
    fromMs: events[0]?.receivedAt ?? null,
    toMs: events[events.length - 1]?.receivedAt ?? null,
    alerts,
    notifications,
    lines: [...lines.values()].sort((a, b) => Number(a.channel === 'ui') - Number(b.channel === 'ui') || b.count - a.count),
  }
}
