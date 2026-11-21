import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { approveSchema, decideProposal, getSchema, setMapping } from '@/lib/engine/schemas'
import { isCanonicalKey } from '@/lib/engine/schema'
import { type CanonicalKey } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

export async function GET(_: Request, { params }: { params: { id: string } }) {
  return handle(async () => {
    const schema = await getSchema(params.id)
    return schema ? json({ schema }) : fail('Schema not found', 404)
  })
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(async () => {
    const body = await readJson<{
      op?: string
      canonical?: CanonicalKey
      path?: string | null
      name?: string
      actor?: string
    }>(req)
    const actor = actorOf(req, body)
    const needsKey = body.op === 'accept' || body.op === 'reject' || body.op === 'map'
    if (needsKey && !isCanonicalKey(body.canonical))
      return fail('canonical must be a canonical key')
    switch (body.op) {
      case 'accept':
      case 'reject':
        await decideProposal(params.id, body.canonical!, String(body.path), body.op === 'accept', actor)
        break
      case 'map':
        await setMapping(params.id, body.canonical!, body.path ?? null, actor)
        break
      case 'approve':
        await approveSchema(params.id, actor, body.name)
        break
      default:
        return fail('Unknown op')
    }
    return json({ schema: await getSchema(params.id) })
  })
}
