import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { alertDetail, stepAction, type StepOp } from '@/lib/engine/alerts'

export const dynamic = 'force-dynamic'

const OPS: StepOp[] = ['run', 'approve', 'skip', 'done', 'reset']

export async function POST(req: Request, { params }: { params: { id: string; stepId: string } }) {
  return handle(async () => {
    const body = await readJson<{ op?: StepOp; actor?: string }>(req)
    if (!body.op || !OPS.includes(body.op)) return fail(`op must be one of ${OPS.join(', ')}`)
    await stepAction(params.id, params.stepId, body.op, actorOf(req, body))
    return json({ alert: await alertDetail(params.id) })
  })
}
