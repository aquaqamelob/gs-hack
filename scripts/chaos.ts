// Proof of delivery under failure. Run it through scripts/chaos.sh, which also kills an app replica mid-run.
// Sends events at a constant rate, takes the SMS gateway down for part of the run, then counts what the gateway received.
//   lost       = events accepted with 202 whose SMS never reached the gateway
//   duplicates = events whose SMS the gateway delivered more than once
const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), [])
)
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const GW = process.env.GATEWAY_URL ?? 'http://localhost:4010'
const RATE = Number(args.rate ?? 100)
const DURATION = Number(args.duration ?? 30)
const TOTAL = Math.round(RATE * DURATION)
const RULE_ID = 'chaos-e2e'
const run = Date.now().toString(36)
const admin = { 'content-type': 'application/json', 'x-actor': 'admin' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The gateway keeps the last 5000 messages, and every one of them has to be counted.
if (TOTAL > 4500) throw new Error('rate × duration must stay under 4500')

const chaos = (down: boolean) => fetch(`${GW}/chaos`, { method: 'POST', body: JSON.stringify({ down }) })

const accepted = new Set<number>()
let clientRetries = 0
let rejected = 0

/** Retries like a real producer: a request cut off by a dying replica is unacknowledged, so it is sent again. */
async function send(seq: number) {
  const body = JSON.stringify({ type: 'CHAOS', run, seq, service: 'chaos', severity: 'ERROR', environment: 'perf', error: { code: 'SYNTHETIC', message: 'chaos' } })
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(`${BASE}/ingest/chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      await res.arrayBuffer()
      if (res.status === 202) {
        accepted.add(seq)
        return
      }
    } catch {
      /* connection cut: retry below */
    }
    clientRetries++
    await sleep(200 * 2 ** attempt)
  }
  rejected++
}

async function smsPerEvent() {
  const messages = (await (await fetch(`${GW}/messages?limit=5000`)).json()) as { channel: string; text: string }[]
  const counts = new Map<number, number>()
  const tag = new RegExp(`Chaos ${run} (\\d+)`)
  for (const m of messages) {
    const seq = m.channel === 'sms' ? m.text.match(tag)?.[1] : undefined
    if (seq) counts.set(Number(seq), (counts.get(Number(seq)) ?? 0) + 1)
  }
  return counts
}

const stats = async (since: number) => (await fetch(`${BASE}/api/system?only=stats&since=${since}`)).json() as Promise<any>
const gatewayStats = async () => (await fetch(`${GW}/stats`)).json() as Promise<{ duplicatesRejected: number }>

async function main() {
  const res = await fetch(`${BASE}/api/rules`, {
    method: 'PUT',
    headers: admin,
    body: JSON.stringify({
      rule: {
        id: RULE_ID,
        name: 'Chaos test (temporary)',
        team: 'team-platform',
        when: { all: [{ field: 'type', op: 'eq', value: 'CHAOS' }] },
        notify: [{ to: 'piotr', channels: ['sms'] }],
        present: { title: `Chaos ${run} {{seq}}`, severity: 'error' },
        group_by: ['seq'],
        group_wait: '0s',
        group_interval: '1h',
        dedup_window: '1h',
      },
    }),
  })
  if (!res.ok) throw new Error(`Cannot create chaos rule: ${await res.text()}`)
  await sleep(500)

  const since = Date.now()
  const rejectedBefore = (await gatewayStats()).duplicatesRejected
  const start = performance.now()
  const pending: Promise<void>[] = []
  setTimeout(() => (console.log('t+%ds  SMS gateway DOWN', Math.round(DURATION * 0.2)), void chaos(true)), DURATION * 200)
  setTimeout(() => (console.log('t+%ds  SMS gateway UP', Math.round(DURATION * 0.5)), void chaos(false)), DURATION * 500)
  for (let sent = 0; sent < TOTAL; ) {
    const due = Math.min(TOTAL, Math.floor(((performance.now() - start) / 1000) * RATE))
    while (sent < due) pending.push(send(++sent))
    await sleep(2)
  }
  await Promise.all(pending)
  await chaos(false)

  // A replica killed mid-send leaves leased rows; they are retried once the 30 s lease expires.
  let m: any
  let counts = new Map<number, number>()
  const deadline = Date.now() + 150_000
  do {
    await sleep(1000)
    m = await stats(since)
    counts = await smsPerEvent()
  } while ((m.pending > 0 || [...accepted].some((s) => !counts.has(s))) && Date.now() < deadline)
  await fetch(`${BASE}/api/rules?id=${RULE_ID}`, { method: 'DELETE', headers: { 'x-actor': 'admin' } })

  const lost = [...accepted].filter((s) => !counts.has(s)).length
  const duplicates = [...counts.values()].filter((n) => n > 1).length
  const providerRetries = (await gatewayStats()).duplicatesRejected - rejectedBefore
  const sms = m.endToEnd.sms
  console.log(`
sent=${TOTAL} accepted=${accepted.size} refused_after_retries=${rejected} client_retries=${clientRetries}
sms_delivered=${counts.size} lost=${lost} duplicates=${duplicates} repeat_sends_stopped_by_idempotency_key=${providerRetries}
pending=${m.pending} dead=${m.dead}
ingest → SMS, including the outage: p50 ${sms.p50} ms  p99 ${sms.p99} ms  max ${sms.max} ms`)
  const ok = lost === 0 && duplicates === 0 && rejected === 0 && m.pending === 0 && m.dead === 0
  console.log(ok ? '\nPASS' : '\nFAIL')
  process.exit(ok ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await chaos(false).catch(() => {})
  process.exit(1)
})
