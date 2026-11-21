// Open-model load test (constant arrival rate, no coordinated omission).
//   bun run loadtest                      # 300 msg/s for 20 s, every event becomes its own alert (full e2e path)
//   bun run loadtest --rate 1000 --duration 30
//   bun run loadtest --mode noise         # realistic mix with duplicates: shows noise reduction
//   BASE_URL=http://host:3000 bun run loadtest
//
// Requests are fired on a fixed schedule whether or not earlier ones have returned, and HTTP latency is measured
// from the *scheduled* send time. End-to-end latency (ingest → channel adapter accepted the message) is measured
// inside the service per delivery (Postgres timestamps) and read from /api/system after the queue drains.
// The load generator runs on the same machine as the service unless BASE_URL points elsewhere: say so with the numbers.
import { mkdirSync, writeFileSync } from 'node:fs'
import { BASE, args, deleteRule, openLoad, putRule, waitForDrain } from './lib/load'

const RATE = Number(args.rate ?? 300)
const DURATION = Number(args.duration ?? 20)
const MODE = (args.mode ?? 'e2e') as 'e2e' | 'noise'
const RULE_ID = 'loadtest-e2e'
const run = Date.now().toString(36)

function event(seq: number) {
  if (MODE === 'e2e') {
    return {
      type: 'LOADTEST',
      seq: `${run}-${seq}`,
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
    // One alert per event (group_by seq, no group_wait), notified on email + UI: the full path for every event.
    await putRule({
      id: RULE_ID,
      name: 'Load test (temporary)',
      team: 'team-settlements',
      when: { field: 'type', op: 'eq', value: 'LOADTEST' },
      notify: [{ to: 'team-settlements', channels: ['ui', 'email'] }],
      present: { title: 'Load test {{seq}}' },
      group_by: ['seq'],
      group_wait: '0s',
    })
  }
  const since = Date.now()
  const load = await openLoad({ rate: RATE, durationSec: DURATION, source: 'loadtest', event })
  const m = await waitForDrain(since)
  if (MODE === 'e2e') await deleteRule(RULE_ID)

  const result = {
    at: new Date().toISOString(),
    mode: MODE,
    base: BASE,
    targetRate: RATE,
    durationSec: DURATION,
    ...load,
    server: {
      events: m.events,
      matched: m.matched,
      alertsCreated: m.alertsCreated,
      noiseReduction: m.noiseReduction,
      pending: m.pending,
      dead: m.dead,
      retried: m.retried,
      endToEnd: m.endToEnd,
      instance: m.instance,
    },
  }
  const e = m.endToEnd.all
  console.log(`
Sent ${load.sent} events in ${load.wallSec} s → achieved ${load.achievedRate} msg/s (target ${RATE}), ${load.httpErrors} HTTP errors, max ${load.maxInflight} in flight
HTTP accept latency (from scheduled send):  p50 ${load.http.p50} ms   p95 ${load.http.p95} ms   p99 ${load.http.p99} ms   max ${load.http.max} ms
Ingest → delivery (server-measured, ${e.count} first notifications):  p50 ${e.p50} ms   p95 ${e.p95} ms   p99 ${e.p99} ms   max ${e.max} ms
Events ${m.events} (${m.matched} matched) → alerts ${m.alertsCreated} (${m.noiseReduction}:1) · pending ${m.pending} · dead ${m.dead} · retried ${m.retried}`)

  mkdirSync('results', { recursive: true })
  const file = `results/loadtest-${MODE}-${RATE}rps-${result.at.replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(`\nSaved ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
