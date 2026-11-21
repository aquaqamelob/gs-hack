// End-to-end check of the alert flow against a running stack: bun run smoke
// Needs the app, Postgres and the mock gateway. GATEWAY_URL is the mock gateway as seen from this machine.
import { createHmac } from 'node:crypto'

const B = process.env.BASE_URL ?? 'http://localhost:3000'
const GW = process.env.GATEWAY_URL ?? 'http://localhost:4010'
const PARTNER_TOKEN = process.env.INGEST_TOKEN_PARTNER ?? 'dev-partner-token'
const PAYMENTS_HMAC = process.env.INGEST_HMAC_PAYMENTS ?? 'dev-payments-hmac'
const REPLY_TOKEN = process.env.INGEST_TOKEN_REPLY ?? 'dev-reply-token'

async function call<T = any>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(B + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-actor': 'smoke-test', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data)}`)
  return data
}

/** Reply webhook as a script would call it (bearer). */
async function replyAs(from: string, text: string, headers: Record<string, string> = { authorization: `Bearer ${REPLY_TOKEN}` }) {
  const res = await fetch(B + '/api/reply', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ from, text }) })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any }
}

async function status(path: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
  return res.status
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  let v = await fn()
  while (!ok(v) && Date.now() < end) {
    await sleep(250)
    v = await fn()
  }
  return v
}

const alertOf = async (id: string) => (await call(`/api/alerts/${id}`)).alert
const chaos = (down: boolean) => fetch(`${GW}/chaos`, { method: 'POST', body: JSON.stringify({ down }) })
const run = Date.now().toString(36)
const tail = String(Date.now()).slice(-6) // digits for per-run sender numbers, so reruns never share a lockout

// 1. Ingest contract: 202 for anything parseable, 400 malformed, 401 bad credentials.
check('unknown schema accepted with 202', (await status('/ingest/webhook', JSON.stringify({ [`x_${run}`]: 1 }))) === 202)
check('malformed JSON rejected with 400', (await status('/ingest/webhook', '{"oops":')) === 400)
check('missing bearer token rejected with 401', (await status('/ingest/partner', '{}')) === 401)
check('valid bearer token accepted', (await status('/ingest/partner', '{}', { authorization: `Bearer ${PARTNER_TOKEN}` })) === 202)
const signed = JSON.stringify({ probe: run })
check('bad HMAC signature rejected with 401', (await status('/ingest/payments', signed, { 'x-signature': 'sha256=00' })) === 401)
check(
  'valid HMAC signature accepted',
  (await status('/ingest/payments', signed, { 'x-signature': `sha256=${createHmac('sha256', PAYMENTS_HMAC).update(signed).digest('hex')}` })) === 202
)

// 2. Appendix A workflow failure while the SMS gateway is down: SMS retries, other channels go out, nothing is lost.
await chaos(true)
const wfEvent = {
  type: 'WORKFLOW_FAILED',
  workflowId: `WF-SMOKE-${run}`,
  workflowName: 'order-settlement',
  step: `validate-counterparty-${run}`,
  severity: 'ERROR',
  environment: 'prod',
  timestamp: new Date().toISOString(),
  error: { code: 'TIMEOUT', message: 'Counterparty service did not respond in 5000 ms' },
}
const wf = await call('/ingest/events', wfEvent)
check('workflow failure matched the settlements rule', wf.matchedRules.includes('settlements-workflow-failed'))
const id = wf.alertIds[0]
let a = await until(
  () => alertOf(id),
  (x) => x.deliveries.some((d: any) => d.channel === 'sms' && d.attempts > 1)
)
const sms = a.deliveries.find((d: any) => d.channel === 'sms')
check('SMS retries with backoff while the gateway is down', sms?.status === 'pending' && sms.attempts > 1, `${sms?.status}, ${sms?.attempts} tries`)
check('UI delivery not blocked by the SMS outage', a.deliveries.some((d: any) => d.channel === 'ui' && d.status === 'sent'))
await chaos(false)
a = await until(
  () => alertOf(id),
  (x) => x.deliveries.every((d: any) => d.status === 'sent'),
  40_000
)
check(
  'every delivery sent after recovery',
  a.deliveries.every((d: any) => d.status === 'sent'),
  a.deliveries.map((d: any) => `${d.channel}:${d.status}/${d.attempts}`).join(' ')
)
const gw = await (await fetch(`${GW}/stats`)).json()
check('gateway saw no duplicate messages (idempotency key)', gw.total - (gw.byChannel.webhook ?? 0) - (gw.byChannel.email ?? 0) - (gw.byChannel.inbound ?? 0) <= gw.uniqueKeys, JSON.stringify(gw))
check('runbook steps rendered with the workflow id', JSON.stringify(a.steps).includes(wfEvent.workflowId), a.steps.map((s: any) => s.text).join(' | '))

// 3. Dedup: 500 identical events become one alert.
// With Kafka the demo only produces to the topic, so wait for the consumer instead of expecting alert ids back.
const listAlerts = async () => (await call('/api/alerts?limit=500')).alerts as any[]
const countsBefore = new Map((await listAlerts()).map((x) => [x.id, x.count]))
const burst = await call('/api/demo', { scenario: 'burst', count: 500 })
check('demo reports the path it used', burst.result.via === 'kafka' || burst.result.via === 'direct', burst.result.via)
const grown = (xs: any[]) => xs.filter((x) => x.ruleId === 'settlements-workflow-failed' && x.count > (countsBefore.get(x.id) ?? 0))
const grew = (x: any) => x.count - (countsBefore.get(x.id) ?? 0)
const burstAlerts = grown(await until(listAlerts, (xs) => grown(xs).reduce((n, x) => n + grew(x), 0) >= 500, 20_000))
check('500 identical events fold into one alert', burstAlerts.length === 1 && grew(burstAlerts[0]) === 500, burstAlerts.map((x) => `+${grew(x)}`).join(','))

// 4. Runbook steps as buttons, and approval by SMS reply.
const s2 = (await call(`/api/alerts/${id}/steps/s2`, { op: 'run' })).alert.steps[1]
check('retry_workflow webhook runs', s2.status === 'done', s2.output)
// Reply webhook hardening: auth, 6-digit code, sender must be a recipient, attempt limit.
const PIOTR = '+48 600 333 444' // on call for team-settlements: the SMS for this alert went to this number
check('reply code is 6 digits', /^\d{6}$/.test(a.approvalCode), a.approvalCode)
check('unauthenticated reply rejected with 401', (await replyAs(PIOTR, `YES ${a.approvalCode}`, {})).status === 401)
const stranger = await replyAs(`+48 500 ${tail}`, `YES ${a.approvalCode}`)
check('correct code from a non-recipient rejected with 403', stranger.status === 403, `${stranger.status} ${stranger.body.message}`)
a = await alertOf(id)
check('non-recipient reply audited as reply.rejected', a.audit.some((e: any) => e.action === 'reply.rejected'))
check('non-recipient reply did not run the step', a.steps[2]?.status !== 'done', a.steps[2]?.status)
const guesser = `+48 501 ${tail}`
const guesses: number[] = []
for (let i = 0; i < 6; i++) guesses.push((await replyAs(guesser, `YES ${String(100000 + i)}`)).status)
check('6 wrong codes from one sender: 5× 400 then 429', guesses.slice(0, 5).every((x) => x === 400) && guesses[5] === 429, guesses.join(','))
// The correct code goes through the mock gateway, which signs the webhook with HMAC like a provider.
const viaGateway = await fetch(`${GW}/inbound`, { method: 'POST', body: JSON.stringify({ from: PIOTR, text: `YES ${a.approvalCode}` }) })
const reply = (await viaGateway.json()) as any
check('escalation approved by "YES <code>" from a recipient (signed via gateway)', viaGateway.status === 200 && reply.ok, `${viaGateway.status} ${reply.message}`)
a = await alertOf(id)
check('escalate webhook ran after approval', a.steps[2]?.status === 'done', a.steps[2]?.output)
check('approval recorded in the audit log', a.audit.some((e: any) => e.action === 'step.approved' && e.actor.startsWith('reply:')))
check('unknown approval code refused', (await replyAs(`+48 502 ${tail}`, 'YES 000000')).status === 400)

// 5. Alertmanager firing → resolved closes the alert; Anna's working hours pick the channel.
const m = await call('/api/demo', { scenario: 'metric' })
const warsawHour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Europe/Warsaw' }).format(new Date()))
const expected = warsawHour >= 8 && warsawHour < 20 ? 'sms' : 'email'
let ma = await until(
  () => alertOf(m.result.alertIds[0]),
  (x) => x.deliveries.length > 0
)
check(`Anna notified by ${expected} (Warsaw ${warsawHour}:00)`, ma.deliveries.some((d: any) => d.channel === expected), ma.deliveries.map((d: any) => d.channel).join(','))
await call('/api/demo', { scenario: 'metric-resolved' })
ma = await alertOf(m.result.alertIds[0])
check('Alertmanager "resolved" auto-closes the alert', ma.status === 'resolved', ma.resolvedBy)

// 6. Rule on raw fields with a template title.
const tradeAt = Date.now()
await call('/api/demo', { scenario: 'trade' })
const isTrade = (x: any) => x.ruleId !== '__unassigned' && x.source === 'events' && x.schemaName?.includes('trade') && x.lastSeen >= tradeAt - 1000
const ta = (await until(listAlerts, (xs) => xs.some(isTrade), 15_000)).find(isTrade)
check('trade title rendered from raw payload fields', ta?.title === 'Rejected EUR 25,000,000 — LIMIT_BREACH', ta?.title)

// 7. group_wait: log lines grouped per instrument, notified once after the wait.
const instruments = ['EUR', 'JPY', 'GBP'].map((c) => `${c}-${run}`)
const logLines = Array.from(
  { length: 9 },
  (_, i) => `${new Date().toISOString()} WARN pricing-engine-${1 + (i % 4)} instrument=${instruments[i % 3]} latency_ms=${1200 + i} msg="price latency above threshold"`
).join('\n')
const pricingRes = await fetch(`${B}/ingest/logs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: logLines })
const pricing = { result: await pricingRes.json() }
const groups = await Promise.all(pricing.result.alertIds.map(alertOf))
check(
  'log lines grouped into one alert per instrument',
  groups.length === 3 && groups.every((g: any) => g.count === 3),
  groups.map((g: any) => `${g.title} x${g.count}`).join(' | ')
)
check('nothing sent before group_wait elapses', groups.every((g: any) => g.deliveries.length === 0))

// 8. Unknown schema from an unknown producer lands in the Unassigned inbox.
const u = await call('/api/ingest/partner', { [`probe_${run}`]: 'x', lvl: 'P1', originSystem: 'smoke', occurred: new Date().toISOString() }, {
  authorization: `Bearer ${PARTNER_TOKEN}`,
})
check('unmapped schema goes to the Unassigned inbox', u.unassigned === 1 && u.schemas[0].status === 'needs-review', u.schemas[0]?.name)
const ua = await alertOf(u.alertIds[0])
check('default owner notified about the unassigned event', ua.team === 'unassigned' && ua.deliveries.some((d: any) => d.recipient === 'team-platform'))
// Counters are per instance and the LB picks one per request, so keep scraping until the instance that handled it answers.
const metrics = await until(
  async () => (await fetch(`${B}/metrics`)).text(),
  (text) => /ctrl_unmapped_events_total [1-9]/.test(text)
)
check('unmapped_events_total exported', /ctrl_unmapped_events_total [1-9]/.test(metrics))

// 9. Rule preview against recent events.
const preview = await call('/api/rules/test', { rule: { when: { field: 'title', op: 'eq', value: 'WORKFLOW_FAILED' } } })
check('rule preview runs against the last 100 events', preview.tested > 0 && preview.matched > 0, `${preview.matched}/${preview.tested} → ${preview.alerts} alerts`)

// 10. group_wait elapses: pricing alerts get exactly one notification each.
await sleep(11_000)
const later = await Promise.all(pricing.result.alertIds.map(alertOf))
check(
  'exactly one notification per group after group_wait',
  later.every((g: any) => g.deliveries.length === 1),
  later.map((g: any) => g.deliveries.length).join(',')
)

// 11. Config lives in Postgres: a save reaches every replica behind the LB (run with APP_REPLICAS=3),
// stale saves get 409, concurrent saves both land.
async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(B + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-actor': 'admin' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}
const probeRule = (rid: string) => ({
  id: rid,
  name: `Smoke probe ${rid}`,
  team: 'team-platform',
  enabled: false,
  when: { field: 'title', op: 'eq', value: `SMOKE_PROBE_${run}` },
  notify: [{ to: 'team-platform', channels: ['ui'] }],
})
const [r1, r2, r3] = ['a', 'b', 'c'].map((x) => `smoke-${x}-${run}`)
const v0 = (await call('/api/rules')).version as string
const put1 = await send('PUT', '/api/rules', { rule: probeRule(r1), version: v0 })
check('rule saved with the current version', put1.status === 200, `${put1.status} ${JSON.stringify(put1.data)}`)
const saved = Date.now()
// Round-robin across replicas: 10 consecutive GETs that all see the rule, reached within 2 s of the save.
let streak = 0
let gets = 0
while (streak < 10 && Date.now() - saved < 2000) {
  const data = (await (await fetch(`${B}/api/rules`)).json()) as any
  gets++
  streak = data.rules.some((r: any) => r.id === r1) ? streak + 1 : 0
}
check('new rule returned by 10 consecutive GETs through the load balancer within 2 s', streak >= 10, `${gets} GETs, ${Date.now() - saved} ms`)
const stale = await send('PUT', '/api/rules', { rule: probeRule(r2), version: v0 })
check('save with a stale version rejected with 409', stale.status === 409, `${stale.status} ${stale.data.error ?? ''}`)
const both = await Promise.all([send('PUT', '/api/rules', { rule: probeRule(r2) }), send('PUT', '/api/rules', { rule: probeRule(r3) })])
const after = (await call('/api/rules')).rules.map((y: any) => y.id)
check(
  'two concurrent saves on different replicas both land',
  both.every((x) => x.status === 200) && after.includes(r2) && after.includes(r3),
  both.map((x) => x.status).join(',')
)
const exported = await (await fetch(`${B}/api/rules/export`)).text()
check('GET /api/rules/export returns the rules as YAML', exported.startsWith('rules:') && exported.includes(`id: ${r1}`))
for (const rid of [r1, r2, r3]) await send('DELETE', `/api/rules?id=${rid}`)

// 11. Noise budget: the forecast must equal what the real grouping and outbox then send.
const noiseType = `NOISE_${run}`
const noiseRule = {
  id: `smoke-noise-${run}`,
  name: 'Smoke noise budget',
  team: 'team-platform',
  when: { field: 'type', op: 'eq', value: noiseType },
  notify: [{ to: 'piotr', channels: ['sms'] }],
  group_by: ['type'],
  group_wait: '1s',
  group_interval: '2s',
}
const asAdmin = { 'content-type': 'application/json', 'x-actor': 'admin' }
await fetch(`${B}/api/rules`, { method: 'PUT', headers: asAdmin, body: JSON.stringify({ rule: noiseRule }) })
await sleep(500)
let noiseAlert = ''
for (const wait of [0, 100, 3900, 4000]) {
  await sleep(wait)
  const r = await call('/ingest/webhook', { type: noiseType, service: 'noise', severity: 'ERROR' })
  noiseAlert = r.alertIds[0]
}
await sleep(3500)
const realSms = (await alertOf(noiseAlert)).deliveries.filter((d: any) => d.channel === 'sms').length
const forecast = (await call('/api/rules/test', { rule: noiseRule })).noise
const forecastSms = forecast.lines.find((l: any) => l.recipient === 'piotr' && l.channel === 'sms')?.count
check('noise budget forecast equals real SMS sent', realSms === 3 && forecastSms === realSms, `forecast ${forecastSms}, real ${realSms}, from 4 events`)
await fetch(`${B}/api/rules?id=${noiseRule.id}`, { method: 'DELETE', headers: asAdmin })

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
