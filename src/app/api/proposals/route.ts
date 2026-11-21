import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { getAlert } from '@/lib/engine/alerts'
import { listProposals, MANUAL_REASONS, proposeFix, type Reason } from '@/lib/engine/proposals'

export const dynamic = 'force-dynamic'

/** ?status=open (default) | accepted | dismissed | all */
export async function GET(req: Request) {
  return handle(async () => {
    const status = new URL(req.url).searchParams.get('status') ?? 'open'
    return json({ proposals: await listProposals(status === 'all' ? null : status), reasons: MANUAL_REASONS })
  })
}

/** "Propose a fix" from an alert: {alertId, reason, text}. Anyone may propose; an admin decides. */
export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{ alertId?: string; reason?: string; text?: string; actor?: string }>(req)
    if (!body.alertId) return fail('alertId is required')
    if (!MANUAL_REASONS.includes(body.reason as Reason)) return fail(`reason must be one of ${MANUAL_REASONS.join(', ')}`)
    const text = String(body.text ?? '').trim().slice(0, 1000)
    if (!text) return fail('text is required: what should change?')
    const alert = await getAlert(body.alertId)
    if (!alert) return fail('Alert not found', 404)
    return json({ proposal: await proposeFix(alert, body.reason as Reason, text, actorOf(req, body)) })
  })
}
