import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { audit } from '@/lib/engine/bus'
import { deleteRunbook } from '@/lib/engine/config'
import { rt } from '@/lib/engine/runtime'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(async () => {
    const rb = rt().runbooks.get(params.id)
    if (!rb) return fail('Runbook not found', 404)
    const body = await readJson<{ op?: string; actor?: string }>(req)
    const actor = actorOf(req, body)

    switch (body.op) {
      case 'delete':
        await deleteRunbook(rb.id, actor)
        await audit(actor, 'runbook.deleted', rb.id)
        return json({ ok: true })
      default:
        return fail('Unknown op')
    }
  })
}
