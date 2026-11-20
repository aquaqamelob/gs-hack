import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { ackAlert, addNote, alertDetail, reopenAlert, resolveAlert } from '@/lib/engine/alerts'
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
    const body = await readJson<{ op?: string; note?: string; actor?: string }>(req)
    const actor = actorOf(req, body)
    switch (body.op) {
      case 'ack':
        await ackAlert(params.id, actor)
        break
      case 'resolve':
        await resolveAlert(params.id, actor, body.note?.slice(0, 500))
        break
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
