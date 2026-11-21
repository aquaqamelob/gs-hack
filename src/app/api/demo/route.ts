import { fail, handle, json, readJson } from '@/lib/engine/api'
import { runScenario, SAMPLES, SCENARIOS, simulateReply, type Scenario } from '@/lib/engine/demo'

export const dynamic = 'force-dynamic'

export async function GET() {
  return json({ samples: { workflow: SAMPLES.workflow(), metric: SAMPLES.metric(), trade: SAMPLES.trade(), unknown: SAMPLES.unknown() } })
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{ scenario?: Scenario | 'reply'; count?: number; from?: string; text?: string }>(req)
    if (body.scenario === 'reply') {
      if (!body.from || !body.text) return fail('from and text are required')
      const r = await simulateReply(String(body.from), String(body.text))
      return json(r.body, r.status)
    }
    if (!body.scenario || !SCENARIOS.includes(body.scenario)) return fail(`scenario must be one of ${SCENARIOS.join(', ')}`)
    return json({ result: await runScenario(body.scenario, Math.min(20000, Math.max(1, Number(body.count ?? 1)))) })
  })
}
