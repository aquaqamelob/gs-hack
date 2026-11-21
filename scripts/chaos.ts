// Chaos test: does delivery survive a provider outage under load?   bun run chaos
//   bun run chaos --rate 50 --duration 60              # docker compose stack (stops/starts the mock-gateway container)
//   bun run chaos --outage http                        # local stack without Docker: the gateway's /chaos switch
//
// Open-model load at a fixed rate; every event is its own alert notified by SMS + UI.
//   t=15 s  the SMS gateway goes down (docker compose stop mock-gateway)
//   t=35 s  it comes back (docker compose start mock-gateway)
// After the outbox drains, for every alert created in the run:
//   lost       = events without an alert + deliveries not `sent` + SMS the gateway never recorded
//   duplicates = SMS idempotency keys the gateway recorded more than once
// Prints `lost=0 duplicates=0` or fails with details. Needs DATABASE_URL (default: the compose Postgres on :5432).
import { mkdirSync, writeFileSync } from 'node:fs'
import postgres from 'postgres'
import { args, BASE, deleteRule, openLoad, putRule, sleep, waitForDrain } from './lib/load'

const RATE = Number(args.rate ?? 50)
const DURATION = Number(args.duration ?? 60)
const DOWN_AT = Number(args['down-at'] ?? 15)
const UP_AT = Number(args['up-at'] ?? 35)
const OUTAGE = (args.outage ?? 'docker') as 'docker' | 'http'
const GW = (process.env.GATEWAY_URL ?? 'http://localhost:4010').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ctrl'
const run = Date.now().toString(36)
const RULE_ID = `chaos-${run}`

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)

async function gateway(up: boolean) {
  if (OUTAGE === 'http') {
    await fetch(`${GW}/chaos`, { method: 'POST', body: JSON.stringify({ down: !up }) })
    return
  }
  // Async spawn: a blocking call would stall the load generator for the seconds docker takes.
  const p = Bun.spawn(['docker', 'compose', up ? 'start' : 'stop', 'mock-gateway'], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  if ((await p.exited) !== 0)
    throw new Error(`docker compose ${up ? 'start' : 'stop'} failed: ${await new Response(p.stderr).text()}`)
}

async function main() {
  log(`Chaos → ${BASE}  rate=${RATE}/s  duration=${DURATION}s  gateway down ${DOWN_AT}–${UP_AT} s via ${OUTAGE}`)
  await putRule({
    id: RULE_ID,
    name: `Chaos test ${run} (temporary)`,
    team: 'team-settlements',
    when: {
      all: [
        { field: 'type', op: 'eq', value: 'CHAOS' },
        { field: 'run', op: 'eq', value: run },
      ],
    },
    notify: [{ to: 'team-settlements', channels: ['sms', 'ui'] }],
    present: { title: 'Chaos {{seq}}' },
    group_by: ['seq'],
    group_wait: '0s',
  })

  const faults: Promise<void>[] = []
  const since = Date.now()
  const load = await openLoad({
    rate: RATE,
    durationSec: DURATION,
    source: 'chaos',
    event: (seq) => ({
      type: 'CHAOS',
      run,
      seq: `${run}-${seq}`,
      service: 'chaos',
      severity: 'ERROR',
      environment: 'perf',
    }),
    onSecond: (t) => {
      if (t === DOWN_AT) faults.push(gateway(false).then(() => log('SMS gateway DOWN')))
      if (t === UP_AT) faults.push(gateway(true).then(() => log('SMS gateway UP')))
    },
  })
  await Promise.all(faults)
  log(
    `load done: ${load.sent} events, ${load.httpErrors} HTTP errors, ${load.achievedRate} msg/s; waiting for the outbox to drain`
  )
  const drained = await waitForDrain(since, 300_000)

  const sql = postgres(DATABASE_URL, { max: 2 })
  const [{ alerts }] = await sql`select count(*)::int as alerts from alerts where rule_id = ${RULE_ID}`
  const rows = await sql<{ key: string; channel: string; status: string; attempts: number }[]>`
    select d.idempotency_key as key, d.channel, d.status, d.attempts
    from deliveries d join alerts a on a.id = d.alert_id
    where a.rule_id = ${RULE_ID}`
  await sql.end()

  const notSent = rows.filter((r) => r.status !== 'sent')
  const sms = rows.filter((r) => r.channel === 'sms')
  const lookup: Record<string, { recorded: number; receipts: number }> = {}
  for (let i = 0; i < sms.length; i += 1000) {
    const res = await fetch(`${GW}/lookup`, {
      method: 'POST',
      body: JSON.stringify({ keys: sms.slice(i, i + 1000).map((r) => r.key) }),
    })
    Object.assign(lookup, await res.json())
  }
  const missingAtGateway = sms.filter((r) => r.status === 'sent' && !lookup[r.key]?.recorded)
  const duplicated = sms.filter((r) => (lookup[r.key]?.recorded ?? 0) > 1)
  const retransmits = sms.reduce((n, r) => n + Math.max(0, (lookup[r.key]?.receipts ?? 0) - 1), 0)
  const eventsWithoutAlert = Math.max(0, load.sent - alerts)
  const lost = eventsWithoutAlert + notSent.length + missingAtGateway.length
  const duplicates = duplicated.length

  const result = {
    at: new Date().toISOString(),
    base: BASE,
    rate: RATE,
    durationSec: DURATION,
    outage: { mode: OUTAGE, downAtSec: DOWN_AT, upAtSec: UP_AT },
    load,
    alerts,
    deliveries: rows.length,
    byStatus: Object.fromEntries(
      ['sent', 'pending', 'dead'].map((s) => [s, rows.filter((r) => r.status === s).length])
    ),
    smsDeliveries: sms.length,
    smsRetried: sms.filter((r) => r.attempts > 1).length,
    retransmitsAbsorbedByIdempotencyKey: retransmits,
    endToEnd: drained.endToEnd,
    lost,
    duplicates,
    details: {
      eventsWithoutAlert,
      notSent: notSent.slice(0, 20),
      missingAtGateway: missingAtGateway.slice(0, 20).map((r) => r.key),
      duplicated: duplicated.slice(0, 20).map((r) => r.key),
    },
  }
  mkdirSync('results', { recursive: true })
  const file = `results/chaos-${RATE}rps-${result.at.replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify(result, null, 2))

  console.log(`
${alerts} alerts, ${rows.length} deliveries (${sms.length} SMS, ${result.smsRetried} retried during the outage)
${retransmits} resends absorbed by the idempotency key
lost=${lost} duplicates=${duplicates}
Saved ${file}`)
  if (lost || duplicates) {
    console.error('FAILED', JSON.stringify(result.details, null, 2))
    process.exitCode = 1
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await gateway(true).catch(() => {})
    await sleep(100)
    await deleteRule(RULE_ID)
  })
