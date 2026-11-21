import { ingestAuthHeaders } from './api'
import { produce } from './kafka'
import type { IngestResult } from './pipeline'

const pad = (n: number, w = 5) => String(n).padStart(w, '0')
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '')

/** Appendix A of the task, plus one schema nobody has seen before. */
export const SAMPLES = {
  workflow: () => ({
    type: 'WORKFLOW_FAILED',
    workflowId: `WF-${today()}-${pad(Math.floor(Math.random() * 99999))}`,
    workflowName: 'order-settlement',
    step: 'validate-counterparty',
    severity: 'ERROR',
    environment: 'prod',
    timestamp: new Date().toISOString(),
    error: { code: 'TIMEOUT', message: 'Counterparty service did not respond in 5000 ms' },
  }),
  metric: (status: 'firing' | 'resolved' = 'firing') => ({
    receiver: 'ctrl',
    status,
    alerts: [
      {
        status,
        labels: { alertname: 'HighErrorRate', service: 'payments-api', region: 'eu-west', severity: 'critical' },
        annotations: { summary: 'Error rate 12% over the last 5 minutes' },
        startsAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  }),
  trade: () => ({
    meta: { schema: 'trade.rejected.v2', producer: 'trade-gateway', ts: Date.now() },
    payload: { tradeId: `T-${Math.floor(100000 + Math.random() * 900000)}`, desk: 'rates', notional: 25000000, currency: 'EUR', reason: 'LIMIT_BREACH' },
  }),
  unknown: () => ({
    evt_kind: 'PAYMENT_STUCK',
    lvl: 'P1',
    originSystem: 'swift-connector',
    env_name: 'prod',
    occurred: new Date().toISOString(),
    details: { failure_reason: 'ACK_TIMEOUT', note: 'MT103 not acknowledged by correspondent bank within SLA' },
    paymentRef: 'PAY-2026-118822',
  }),
  logLine: (instrument: string, latency: number, instance = 3) =>
    `${new Date().toISOString()} WARN pricing-engine-${instance} instrument=${instrument} latency_ms=${latency} msg="price latency above threshold"`,
}

export const SCENARIOS = ['workflow', 'burst', 'metric', 'metric-resolved', 'trade', 'pricing-log', 'unknown', 'noise'] as const
export type Scenario = (typeof SCENARIOS)[number]

export type DemoResult = { via: 'kafka' | 'direct'; target: string; sent: number } & Partial<IngestResult>

const INGEST_BASE = () => process.env.INGEST_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`
const HTTP_CHUNK = 500

/** A real request through the load balancer: same auth, parsing and limits as any external producer. */
async function postIngest(source: string, body: string, contentType: string): Promise<IngestResult> {
  const res = await fetch(`${INGEST_BASE()}/ingest/${source}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...ingestAuthHeaders(source, body) },
    body,
  })
  const data = await res.json()
  if (res.status !== 202) throw new Error(`POST /ingest/${source} returned ${res.status}: ${data.error ?? ''}`)
  return data as IngestResult
}

async function viaHttp(source: string, events: unknown[], contentType = 'application/json'): Promise<DemoResult> {
  const results: IngestResult[] = []
  for (let i = 0; i < events.length; i += HTTP_CHUNK) {
    const chunk = events.slice(i, i + HTTP_CHUNK)
    const body = contentType === 'text/plain' ? chunk.join('\n') : JSON.stringify(chunk)
    results.push(await postIngest(source, body, contentType))
  }
  return {
    via: 'direct',
    target: `POST /ingest/${source}`,
    sent: results.reduce((n, r) => n + r.accepted, 0),
    accepted: results.reduce((n, r) => n + r.accepted, 0),
    unassigned: results.reduce((n, r) => n + r.unassigned, 0),
    schemas: results.flatMap((r) => r.schemas),
    matchedRules: [...new Set(results.flatMap((r) => r.matchedRules))],
    alertIds: [...new Set(results.flatMap((r) => r.alertIds))],
  }
}

/** Broker events go through Redpanda when it is configured. Without it they take the HTTP path, and the result says so. */
async function toBroker(topic: string, events: unknown[], contentType?: string): Promise<DemoResult> {
  if (process.env.KAFKA_BROKERS) {
    await produce(topic, events)
    return { via: 'kafka', target: topic, sent: events.length }
  }
  return viaHttp(topic, events, contentType)
}

export async function runScenario(scenario: Scenario, count = 1) {
  switch (scenario) {
    case 'workflow':
      return toBroker('events', [SAMPLES.workflow()])
    case 'burst': {
      const ev = SAMPLES.workflow()
      return toBroker('events', Array.from({ length: count }, () => ({ ...ev, timestamp: new Date().toISOString() })))
    }
    case 'trade':
      return toBroker('events', [SAMPLES.trade()])
    case 'pricing-log': {
      const instruments = ['EURUSD', 'USDJPY', 'GBPUSD']
      const lines = Array.from({ length: count }, (_, i) => SAMPLES.logLine(instruments[i % 3], 1000 + Math.floor(Math.random() * 900), 1 + (i % 4)))
      return toBroker('logs', lines, 'text/plain')
    }
    case 'metric':
      return viaHttp('alertmanager', [SAMPLES.metric('firing')])
    case 'metric-resolved':
      return viaHttp('alertmanager', [SAMPLES.metric('resolved')])
    case 'unknown':
      return viaHttp('partner', [SAMPLES.unknown()])
    case 'noise': {
      const events: unknown[] = []
      for (let i = 0; i < count; i++) {
        const r = Math.random()
        if (r < 0.6) events.push({ ...SAMPLES.workflow(), workflowId: `WF-${today()}-${pad(i % 7)}` })
        else if (r < 0.8) events.push({ ...SAMPLES.trade(), payload: { ...SAMPLES.trade().payload, tradeId: `T-90000${i % 5}` } })
        else events.push({ type: 'HEARTBEAT', service: 'settlement-engine', severity: 'INFO', environment: 'prod', timestamp: new Date().toISOString() })
      }
      return toBroker('events', events)
    }
  }
}

/**
 * Console reply simulator: hands the reply to the mock SMS gateway, which signs it and calls /api/reply like a provider.
 * CTRL itself never signs replies, so this goes through the same sender check and attempt limit as a real one.
 */
export async function simulateReply(from: string, text: string) {
  const res = await fetch(`${(process.env.SMS_GATEWAY_URL ?? 'http://localhost:4010').replace(/\/$/, '')}/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: from.slice(0, 120), text: text.slice(0, 200) }),
    signal: AbortSignal.timeout(5000),
  })
  const body = (await res.json().catch(() => ({ message: `gateway HTTP ${res.status}` }))) as { message?: string; error?: string }
  return { status: res.status, body: { ...body, message: body.message ?? body.error ?? `HTTP ${res.status}` } }
}
