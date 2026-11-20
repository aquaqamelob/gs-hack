import { db } from './db'
import { llmEnabled } from './llm'
import { rt } from './runtime'

export interface LatencyStats {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface Stats {
  instance: string
  windowSec: number
  events: number
  eventsPerSec: number
  matched: number
  unassigned: number
  alertsCreated: number
  openAlerts: number
  noiseReduction: number
  pending: number
  dead: number
  retried: number
  endToEnd: Record<'all' | 'phone' | 'sms' | 'email' | 'ui', LatencyStats>
  llmEnabled: boolean
}

let cache: { at: number; since: number; value: Stats } | undefined

/** Measured from Postgres, so it covers every instance. e2e = provider accepted − event received. */
export async function stats(sinceMs = Date.now() - 15 * 60_000): Promise<Stats> {
  if (cache && Date.now() - cache.at < 900 && cache.since === sinceMs) return cache.value
  const since = new Date(sinceMs)
  const sql = db()
  const [[ev], [al], [dl], lat, [rate]] = await Promise.all([
    sql`select count(*)::int as events, count(*) filter (where cardinality(matched) > 0)::int as matched
        from events where received_at >= ${since}`,
    sql`select count(*) filter (where first_seen >= ${since})::int as created,
               count(*) filter (where first_seen >= ${since} and team = 'unassigned')::int as unassigned,
               count(*) filter (where status <> 'resolved')::int as open
        from alerts`,
    sql`select count(*) filter (where status = 'pending')::int as pending,
               count(*) filter (where status = 'dead')::int as dead,
               count(*) filter (where attempts > 1 and created_at >= ${since})::int as retried
        from deliveries where status <> 'sent' or created_at >= ${since}`,
    sql`select channel, count(*)::int as n,
               percentile_cont(array[0.5, 0.95, 0.99]) within group (order by extract(epoch from sent_at - event_received_at) * 1000) as p,
               max(extract(epoch from sent_at - event_received_at) * 1000) as max
        from deliveries where status = 'sent' and sent_at >= ${since} and reason = 'new'
        group by rollup(channel)`,
    sql`select count(*)::int as n from events where received_at >= now() - interval '10 seconds'`,
  ])
  const empty: LatencyStats = { count: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const endToEnd = { all: empty, phone: empty, sms: empty, email: empty, ui: empty } as Stats['endToEnd']
  for (const r of lat) {
    const p = (r.p as number[] | null) ?? [0, 0, 0]
    const v: LatencyStats = { count: r.n, p50: round(p[0]), p95: round(p[1]), p99: round(p[2]), max: round(Number(r.max)) }
    endToEnd[(r.channel as keyof Stats['endToEnd']) ?? 'all'] = v
  }
  const value: Stats = {
    instance: rt().instance,
    windowSec: Math.round((Date.now() - sinceMs) / 1000),
    events: ev.events,
    eventsPerSec: Math.round(rate.n / 10),
    matched: ev.matched,
    unassigned: al.unassigned,
    alertsCreated: al.created,
    openAlerts: al.open,
    noiseReduction: al.created ? Math.round((ev.matched / Math.max(1, al.created - al.unassigned)) * 10) / 10 : 0,
    pending: dl.pending,
    dead: dl.dead,
    retried: dl.retried,
    endToEnd,
    llmEnabled: llmEnabled(),
  }
  cache = { at: Date.now(), since: sinceMs, value }
  return value
}

const round = (n: number) => Math.round((Number(n) || 0) * 10) / 10

/** Prometheus text format for this instance's counters. */
export function prometheus() {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const [key, value] of [...rt().counters].sort()) {
    const name = key.split('{')[0]
    if (!seen.has(name)) {
      seen.add(name)
      lines.push(`# TYPE ctrl_${name} counter`)
    }
    lines.push(`ctrl_${key} ${value}`)
  }
  if (!seen.has('unmapped_events_total')) lines.push('# TYPE ctrl_unmapped_events_total counter', 'ctrl_unmapped_events_total 0')
  lines.push(`ctrl_llm_enabled ${llmEnabled() ? 1 : 0}`)
  return lines.join('\n') + '\n'
}
