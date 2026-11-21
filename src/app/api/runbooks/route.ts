import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { audit } from '@/lib/engine/bus'
import { saveRunbook } from '@/lib/engine/config'
import { db } from '@/lib/engine/db'
import { detectFormat, parseRunbookContent } from '@/lib/engine/runbooks'
import { rt } from '@/lib/engine/runtime'
import type { Runbook, StepDef } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  return handle(async () => {
    const r = rt()
    const proposals = await db()<{ runbookId: string; steps: StepDef[]; model: string; at: Date }[]>`select * from ai_proposals`
    const byId = new Map(proposals.map((p) => [p.runbookId, { steps: p.steps, model: p.model, at: new Date(p.at).getTime() }]))
    return json({
      runbooks: [...r.runbooks.values()].map((rb) => ({ ...rb, aiProposal: byId.get(rb.id) ?? null })),
      actions: Object.entries(r.actions).map(([name, a]) => ({ name, description: a.description ?? name, method: a.method, url: a.url, approval: a.approval ?? 'none' })),
      usedBy: Object.fromEntries([...r.runbooks.keys()].map((id) => [id, r.rules.filter((x) => x.runbook === id).map((x) => x.name)])),
    })
  })
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{ id?: string; content?: string; format?: Runbook['format'] | 'auto'; preview?: boolean; actor?: string }>(req)
    const content = (body.content ?? '').slice(0, 50_000)
    if (!content.trim()) return fail('content is required')
    const format = !body.format || body.format === 'auto' ? detectFormat(content) : body.format
    let parsed
    try {
      parsed = parseRunbookContent(body.id || 'new-runbook', format, content)
    } catch (e) {
      return fail(`Cannot parse ${format}: ${(e as Error).message}`)
    }
    if (body.preview) return json({ format, runbook: parsed })
    if (!body.id) return fail('id is required')
    const actor = actorOf(req, body)
    const id = await saveRunbook(body.id, format, content, actor)
    await audit(actor, 'runbook.saved', id, `${format}, ${parsed.steps.length} steps`)
    return json({ ok: true, id, format })
  })
}
