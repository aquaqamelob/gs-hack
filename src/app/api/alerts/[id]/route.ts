import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { ackAlert, addNote, alertDetail, reopenAlert, resolveAlert } from '@/lib/engine/alerts'
import { learnFromResolution } from '@/lib/engine/proposals'
import { rt } from '@/lib/engine/runtime'

export const dynamic = 'force-dynamic'

async function detail(id: string) {
  const alert = await alertDetail(id)
  if (!alert) return fail('Alert not found', 404)
  return json({ alert, runbook: alert.runbook ? (rt().runbooks.get(alert.runbook.id) ?? null) : null })
}

export async function GET(_: Request, { params }: { params: { id: string } }) {
  return handle(() => detail(params.id))
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(async () => {
    const body = await readJson<{ op?: string; note?: string; fixed?: string | string[]; actor?: string }>(req)
    const actor = actorOf(req, body)
    switch (body.op) {
      case 'ack':
        await ackAlert(params.id, actor)
        break
      case 'resolve': {
        // "What fixed it?": one step per line. Steps the runbook does not have yet become proposals for it.
        const fixed = (Array.isArray(body.fixed) ? body.fixed : String(body.fixed ?? '').split('\n')).map(String).filter((l) => l.trim())
        const note = body.note?.trim() || (fixed.length ? `Fixed by: ${fixed.join('; ')}` : undefined)
        await resolveAlert(params.id, actor, note?.slice(0, 500))
        if (fixed.length) await learnFromResolution(params.id, fixed, actor)
        break
      }
      case 'reopen':
        await reopenAlert(params.id, actor)
        break
      case 'note':
        if (!body.note) return fail('note is required')
        await addNote(params.id, actor, body.note)
        break
      default:
        return fail('op must be ack, resolve, reopen or note')
    }
    return detail(params.id)
  })
}
