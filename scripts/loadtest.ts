// Open-model load test (constant arrival rate, no coordinated omission).
//   bun run loadtest                      # 300 msg/s for 20 s, every event becomes its own alert (full e2e path)
//   bun run loadtest --rate 1000 --duration 30
//   bun run loadtest --mode noise         # realistic mix with duplicates: shows noise reduction
//   BASE_URL=http://host:3000 bun run loadtest
//
// Requests are fired on a fixed schedule whether or not earlier ones have returned, and HTTP latency is measured
// from the *scheduled* send time. End-to-end latency (ingest → channel adapter accepted the message) is measured
// inside the service per delivery and read from /api/system after the queue drains.
import { mkdirSync, writeFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce<
      [string, string][]
    >((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), [])
)
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const RATE = Number(args.rate ?? 300)
const DURATION = Number(args.duration ?? 20)
const MODE = (args.mode ?? 'e2e') as 'e2e' | 'noise'
const RULE_ID = 'loadtest-e2e'

const post = (path: string, body: unknown, method = 'POST') =>
  fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-actor': 'loadtest' },
    body: JSON.stringify(body),
  })

const pct = (xs: number[], p: number) =>
  xs.length ? xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] : 0
const r1 = (n: number) => Math.round(n * 10) / 10

let seq = 0
function event() {
  seq++
  if (MODE === 'e2e') {
    return {
      type: 'LOADTEST',
      seq,
      service: 'loadgen',
      severity: 'ERROR',
      environment: 'perf',
      timestamp: new Date().toISOString(),
      error: { code: 'SYNTHETIC', message: `synthetic event ${seq}` },
    }
  }
  const r = Math.random()
  if (r < 0.5)
    return {
      type: 'WORKFLOW_FAILED',
      workflowId: `WF-LOAD-${seq % 7}`,
      workflowName: 'order-settlement',
      step: ['validate-counterparty', 'book', 'confirm'][seq % 3],
      severity: 'ERROR',
      environment: 'prod',
      timestamp: new Date().toISOString(),
      error: { code: 'TIMEOUT', message: 'Counterparty service did not respond in 5000 ms' },
    }
  if (r < 0.7)
    return {
      alertname: 'HighErrorRate',
      labels: { service: 'payments-api', region: 'eu-west', severity: 'critical' },
      annotations: { summary: 'Error rate 12%' },
      startsAt: new Date().toISOString(),
      status: 'firing',
    }
  if (r < 0.8)
    return {
      meta: { schema: 'trade.rejected.v2', producer: 'trade-gateway', ts: Date.now() },
      payload: {
        tradeId: `T-LOAD-${seq % 20}`,
        desk: 'rates',
        notional: 25000000,
        currency: 'EUR',
        reason: 'LIMIT_BREACH',
      },
    }
  return {
    type: 'HEARTBEAT',
    service: 'settlement-engine',
    severity: 'INFO',
    environment: 'prod',
    timestamp: new Date().toISOString(),
  }
}

async function main() {
  console.log(`Load test → ${BASE}  mode=${MODE}  rate=${RATE}/s  duration=${DURATION}s  (open model)`)
  if (MODE === 'e2e') {
    const res = await post(
      '/api/rules',
      {
        rule: {
          id: RULE_ID,
          name: 'Load test (temporary)',
          team: 'team-settlements',
          when: { all: [{ field: 'type', op: 'eq', value: 'LOADTEST' }] },
          notify: [{ to: 'team-settlements', channels: ['ui', 'email'] }],
          present: { title: 'Load test {{seq}}' },
          group: { by: ['seq'], windowSec: 60, throttleSec: 3600 },
        },
      },
      'PUT'
    )
    if (!res.ok) throw new Error(`Cannot create load-test rule: ${await res.text()}`)
  }
  await post('/api/system', { op: 'reset-metrics' })

  const total = Math.round(RATE * DURATION)
  const latencies: number[] = []
  let errors = 0
  let inflight = 0
  let maxInflight = 0
  const start = performance.now()
  const pending: Promise<void>[] = []

  await new Promise<void>((resolve) => {
    let sent = 0
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000
      const due = Math.min(total, Math.floor(elapsed * RATE))
      while (sent < due) {
        const scheduledAt = start + (sent / RATE) * 1000
        sent++
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        pending.push(
          fetch(`${BASE}/api/ingest/loadtest`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(event()),
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
  const wall = (performance.now() - start) / 1000

  let m: any
  for (let i = 0; i < 60; i++) {
    m = await (await fetch(`${BASE}/api/system?only=metrics`)).json()
    if (m.pending === 0) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (MODE === 'e2e') await fetch(`${BASE}/api/rules?id=${RULE_ID}`, { method: 'DELETE' })

  latencies.sort((a, b) => a - b)
  const result = {
    at: new Date().toISOString(),
    mode: MODE,
    targetRate: RATE,
    durationSec: DURATION,
    sent: total,
    httpErrors: errors,
    achievedRate: r1(total / wall),
    maxInflight,
    http: {
      p50: r1(pct(latencies, 50)),
      p95: r1(pct(latencies, 95)),
      p99: r1(pct(latencies, 99)),
      max: r1(latencies[latencies.length - 1] ?? 0),
    },
    server: {
      ingested: m.ingested,
      alertsCreated: m.alertsCreated,
      noiseReduction: m.noiseReduction,
      delivered: m.delivered,
      pending: m.pending,
      dead: m.dead,
      processingMs: m.processingMs,
      endToEnd: m.endToEnd,
      instance: m.instance,
    },
  }

  console.log(`
Sent ${total} events in ${r1(wall)} s → achieved ${result.achievedRate} msg/s (target ${RATE}), ${errors} HTTP errors, max ${maxInflight} in flight
HTTP accept latency (from scheduled send):  p50 ${result.http.p50} ms   p95 ${result.http.p95} ms   p99 ${result.http.p99} ms   max ${result.http.max} ms
Ingest → delivery (server-measured, ${m.endToEnd.all.count} deliveries):  p50 ${m.endToEnd.all.p50} ms   p95 ${m.endToEnd.all.p95} ms   p99 ${m.endToEnd.all.p99} ms   max ${m.endToEnd.all.max} ms
Processing per event (normalise+rules+dedup):  p50 ${m.processingMs.p50} ms   p99 ${m.processingMs.p99} ms
Events ${m.ingested} → alerts ${m.alertsCreated} (${m.noiseReduction}:1) · delivered ${m.delivered} · pending ${m.pending} · dead ${m.dead}`)

  mkdirSync('results', { recursive: true })
  const file = `results/loadtest-${MODE}-${RATE}rps-${result.at.replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(`\nSaved ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
