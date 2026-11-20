import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { audit, publish } from '@/lib/engine/bus'
import { ADAPTERS } from '@/lib/engine/channels'
import { db, ms } from '@/lib/engine/db'
import { llmEnabled, llmModel } from '@/lib/engine/llm'
import { stats } from '@/lib/engine/metrics'
import { deliveryFromRow, OUTBOX_CHANNEL, requeueDelivery } from '@/lib/engine/outbox'
import { rt } from '@/lib/engine/runtime'

export const dynamic = 'force-dynamic'

async function gatewayMessages() {
  try {
    const res = await fetch(`${(process.env.SMS_GATEWAY_URL ?? 'http://localhost:4010').replace(/\/$/, '')}/messages?limit=100`, {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok ? { up: true, messages: await res.json() } : { up: false, messages: [] }
  } catch {
    return { up: false, messages: [] }
  }
}

export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url)
    const since = Number(url.searchParams.get('since') ?? 0) || undefined
    if (url.searchParams.get('only') === 'stats') return json(await stats(since))
    const [dead, pending, auditRows, gateway] = await Promise.all([
      db()`select * from deliveries where status = 'dead' order by id desc limit 100`,
      db()`select * from deliveries where status = 'pending' order by next_attempt_at limit 100`,
      db()`select * from audit_log order by id desc limit 300`,
      gatewayMessages(),
    ])
    return json({
      stats: await stats(since),
      instance: rt().instance,
      channels: Object.values(ADAPTERS).map(({ channel, label, provider }) => ({ channel, label, provider: provider() })),
      llm: { enabled: llmEnabled(), model: llmModel(), endpoint: process.env.LLM_BASE_URL || 'http://localhost:11434/v1' },
      dlq: dead.map(deliveryFromRow),
      pending: pending.map(deliveryFromRow),
      audit: auditRows.map((a) => ({ ...a, id: Number(a.id), at: ms(a.at as Date) })),
      gateway,
      mailhog: process.env.MAILHOG_UI_URL ?? 'http://localhost:8025',
    })
  })
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{ op?: string; id?: number; enabled?: boolean; actor?: string }>(req)
    const actor = actorOf(req, body)
    switch (body.op) {
      case 'requeue':
        return json({ ok: await requeueDelivery(Number(body.id), actor) })
      case 'requeue-all': {
        const rows = await db()`
          update deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
          where status = 'dead' returning id`
        await db()`select pg_notify(${OUTBOX_CHANNEL}, '')`
        await audit(actor, 'delivery.requeued', 'dlq', `${rows.length} deliveries`)
        return json({ requeued: rows.length })
      }
      case 'llm': {
        // Runtime kill switch, broadcast to every instance. Used by the chaos test "disable the LLM mid-run".
        const enabled = Boolean(body.enabled) && process.env.LLM_ENABLED === 'true'
        await publish({ type: 'llm', enabled })
        await audit(actor, enabled ? 'llm.enabled' : 'llm.disabled', 'llm')
        return json({ enabled })
      }
      default:
        return fail('Unknown op')
    }
  })
}
