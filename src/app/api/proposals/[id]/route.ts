import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { Forbidden, me } from '@/lib/engine/auth'
import { audit } from '@/lib/engine/bus'
import { acceptProposal, dismissProposal } from '@/lib/engine/proposals'

export const dynamic = 'force-dynamic'

/** {op: "accept" | "dismiss"}. Accepting changes a runbook or a rule, so it needs an admin. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(async () => {
    const body = await readJson<{ op?: string; actor?: string }>(req)
    const id = Number(params.id)
    if (!Number.isInteger(id)) return fail('Proposal not found', 404)
    const who = me(req, body)
    if (who.role !== 'admin') {
      await audit(actorOf(req, body), 'proposal.forbidden', `proposal:${id}`, body.op)
      throw new Forbidden('Only an admin can accept or dismiss proposals')
    }
    if (body.op === 'accept') return json(await acceptProposal(id, who.id))
    if (body.op === 'dismiss') return json({ proposal: await dismissProposal(id, who.id) })
    return fail('op must be accept or dismiss')
  })
}
