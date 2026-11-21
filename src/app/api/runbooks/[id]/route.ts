import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { audit, publish } from '@/lib/engine/bus'
import { deleteRunbook, saveRunbook } from '@/lib/engine/config'
import { db } from '@/lib/engine/db'
import { LlmUnavailable, llmModel, structureRunbook } from '@/lib/engine/llm'
import { rt } from '@/lib/engine/runtime'
import type { StepDef } from '@/lib/engine/types'
import YAML from 'yaml'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(async () => {
    const rb = rt().runbooks.get(params.id)
    if (!rb) return fail('Runbook not found', 404)
    const body = await readJson<{ op?: string; actor?: string }>(req)
    const actor = actorOf(req, body)

    switch (body.op) {
      case 'ai-structure': {
        let steps: StepDef[]
        try {
          steps = await structureRunbook(rb.content)
        } catch (e) {
          const msg = e instanceof LlmUnavailable ? `${e.message}. The runbook stays a single text step.` : (e as Error).message
          return fail(msg, 503)
        }
        await db()`
          insert into ai_proposals (runbook_id, steps, model) values (${rb.id}, ${db().json(steps as never)}, ${llmModel()})
          on conflict (runbook_id) do update set steps = excluded.steps, model = excluded.model, at = now()`
        await audit(actor, 'runbook.ai-proposed', rb.id, `${steps.length} steps from ${llmModel()}`)
        await publish({ type: 'config', what: 'runbooks' })
        return json({ ok: true, steps })
      }
      case 'accept-ai': {
        const [p] = await db()<{ steps: StepDef[]; model: string }[]>`select steps, model from ai_proposals where runbook_id = ${rb.id}`
        if (!p) return fail('No AI proposal to accept')
        const doc = {
          runbook: rb.id,
          title: rb.title,
          ...(rb.matches ? { matches: rb.matches } : {}),
          steps: p.steps.map((st) => ({
            text: st.text,
            ...(st.when ? { if: st.when } : {}),
            ...(st.action ? { action: st.action, ...(st.params ?? {}) } : {}),
            approval: st.approval,
          })),
          source: { format: rb.format, text: rb.content },
        }
        await saveRunbook(rb.id, 'yaml', `# Structured from ${rb.format} by ${p.model}, approved by ${actor}\n${YAML.stringify(doc, { lineWidth: 0 })}`, actor)
        await db()`delete from ai_proposals where runbook_id = ${rb.id}`
        await audit(actor, 'runbook.ai-accepted', rb.id, `${p.steps.length} steps`)
        await publish({ type: 'config', what: 'runbooks' })
        return json({ ok: true })
      }
      case 'reject-ai':
        await db()`delete from ai_proposals where runbook_id = ${rb.id}`
        await audit(actor, 'runbook.ai-rejected', rb.id)
        await publish({ type: 'config', what: 'runbooks' })
        return json({ ok: true })
      case 'delete':
        await deleteRunbook(rb.id, actor)
        await audit(actor, 'runbook.deleted', rb.id)
        return json({ ok: true })
      default:
        return fail('Unknown op')
    }
  })
}
