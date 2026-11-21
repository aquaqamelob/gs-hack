// Shared by scripts/loadtest.ts and scripts/chaos.ts: open-model load generator and server stats.
// Open model = requests are fired on a fixed schedule whether or not earlier ones have returned, and latency is
// measured from the *scheduled* send time, so a slow server cannot hide its queueing (no coordinated omission).

export const args: Record<string, string> = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce<[string, string][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), [])
)

export const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
/** Service identity for config writes made by the scripts. */
export const ADMIN_HEADERS = { 'content-type': 'application/json', 'x-actor': 'admin' }

export const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] : 0)
export const r1 = (n: number) => Math.round(n * 10) / 10
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface LoadResult {
  sent: number
  httpErrors: number
  wallSec: number
  achievedRate: number
  maxInflight: number
  http: { p50: number; p95: number; p99: number; max: number }
}

/**
 * Send `rate` events per second for `durationSec` to POST /ingest/<source>.
 * `onSecond(t)` is called once per elapsed second (used by the chaos script to schedule faults).
 */
export async function openLoad(opts: {
  rate: number
  durationSec: number
  source: string
  event: (seq: number) => unknown
  onSecond?: (t: number) => void
}): Promise<LoadResult> {
  const total = Math.round(opts.rate * opts.durationSec)
  const latencies: number[] = []
  const pending: Promise<void>[] = []
  let errors = 0
  let inflight = 0
  let maxInflight = 0
  let lastSecond = -1
  const start = performance.now()

  await new Promise<void>((resolve) => {
    let sent = 0
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000
      while (lastSecond < Math.floor(elapsed) && lastSecond < opts.durationSec) {
        lastSecond++ // not inside the optional call: `f?.(++x)` skips the increment when f is undefined
        opts.onSecond?.(lastSecond)
      }
      const due = Math.min(total, Math.floor(elapsed * opts.rate))
      while (sent < due) {
        const scheduledAt = start + (sent / opts.rate) * 1000
        sent++
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        pending.push(
          fetch(`${BASE}/ingest/${opts.source}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(opts.event(sent)),
          })
            .then(async (r) => {
              await r.arrayBuffer()
              if (!r.ok) errors++
            })
            .catch(() => void errors++)
            .finally(() => {
              inflight--
              latencies.push(performance.now() - scheduledAt)
            })
        )
      }
      if (sent >= total) return resolve()
      setTimeout(tick, 2)
    }
    tick()
  })
  await Promise.all(pending)
  const wallSec = (performance.now() - start) / 1000
  latencies.sort((a, b) => a - b)
  return {
    sent: total,
    httpErrors: errors,
    wallSec: r1(wallSec),
    achievedRate: r1(total / wallSec),
    maxInflight,
    http: { p50: r1(pct(latencies, 50)), p95: r1(pct(latencies, 95)), p99: r1(pct(latencies, 99)), max: r1(latencies.at(-1) ?? 0) },
  }
}

/** Server-side stats since `sinceMs`, measured from Postgres (covers every instance). */
export async function serverStats(sinceMs: number) {
  const res = await fetch(`${BASE}/api/system?only=stats&since=${sinceMs}`)
  if (!res.ok) throw new Error(`/api/system: HTTP ${res.status}`)
  return (await res.json()) as {
    instance: string
    events: number
    matched: number
    alertsCreated: number
    noiseReduction: number
    pending: number
    dead: number
    retried: number
    endToEnd: Record<'all' | 'phone' | 'sms' | 'email' | 'ui', { count: number; p50: number; p95: number; p99: number; max: number }>
  }
}

/** Poll until the outbox has no pending deliveries (or `timeoutMs` passes). */
export async function waitForDrain(sinceMs: number, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs
  let s = await serverStats(sinceMs)
  while (s.pending > 0 && Date.now() < end) {
    await sleep(1000)
    s = await serverStats(sinceMs)
  }
  return s
}

export async function putRule(rule: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/rules`, { method: 'PUT', headers: ADMIN_HEADERS, body: JSON.stringify({ rule }) })
  if (!res.ok) throw new Error(`Cannot create rule ${rule.id}: ${await res.text()}`)
}

export async function deleteRule(id: string) {
  await fetch(`${BASE}/api/rules?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: ADMIN_HEADERS })
}
