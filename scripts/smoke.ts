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
check('gateway saw no duplicate messages (idempotency key)', gw.total - (gw.byChannel.webhook ?? 0) - (gw.byChannel.email ?? 0) <= gw.uniqueKeys, JSON.stringify(gw))
check('runbook steps rendered with the workflow id', JSON.stringify(a.steps).includes(wfEvent.workflowId), a.steps.map((s: any) => s.text).join(' | '))

// 3. Dedup: 500 identical events become one alert.
const burst = await call('/api/demo', { scenario: 'burst', count: 500 })
const burstAlert = await alertOf(burst.result.alertIds[0])
check('500 identical events fold into one alert', burstAlert.count >= 500 && burst.result.alertIds.length === 1, `count=${burstAlert.count}`)

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
const t = await call('/api/demo', { scenario: 'trade' })
const ta = await alertOf(t.result.alertIds[0])
check('trade title rendered from raw payload fields', ta.title === 'Rejected EUR 25,000,000 — LIMIT_BREACH', ta.title)

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
const metrics = await (await fetch(`${B}/metrics`)).text()
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

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
