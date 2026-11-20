import { produce } from './kafka'
import { ingest } from './pipeline'
import { parseLogLine } from './schema'

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

/** Broker events go through Redpanda when it is configured, so the demo exercises the real consumer. */
async function toBroker(topic: string, events: unknown[]) {
  if (process.env.KAFKA_BROKERS) {
    await produce(topic, events)
    return { via: `kafka:${topic}`, sent: events.length }
  }
  const r = await ingest(events, topic)
  return { via: `direct:${topic}`, sent: r.accepted, matchedRules: r.matchedRules, alertIds: r.alertIds }
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
      if (process.env.KAFKA_BROKERS) return toBroker('logs', lines)
      return toBroker('logs', lines.map(parseLogLine))
    }
    case 'metric':
      return { via: 'webhook:alertmanager', ...(await ingest(SAMPLES.metric('firing'), 'alertmanager')) }
    case 'metric-resolved':
      return { via: 'webhook:alertmanager', ...(await ingest(SAMPLES.metric('resolved'), 'alertmanager')) }
    case 'unknown':
      return { via: 'webhook:partner', ...(await ingest(SAMPLES.unknown(), 'partner')) }
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
