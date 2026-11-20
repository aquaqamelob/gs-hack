import { fail, handle, json, readJson } from '@/lib/engine/api'
import { runScenario, SAMPLES, SCENARIOS, type Scenario } from '@/lib/engine/demo'

export const dynamic = 'force-dynamic'

export async function GET() {
  return json({ samples: { workflow: SAMPLES.workflow(), metric: SAMPLES.metric(), trade: SAMPLES.trade(), unknown: SAMPLES.unknown() } })
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{ scenario?: Scenario; count?: number }>(req)
    if (!body.scenario || !SCENARIOS.includes(body.scenario)) return fail(`scenario must be one of ${SCENARIOS.join(', ')}`)
    return json({ result: await runScenario(body.scenario, Math.min(20000, Math.max(1, Number(body.count ?? 1)))) })
  })
}
