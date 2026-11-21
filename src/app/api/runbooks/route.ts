import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { audit } from '@/lib/engine/bus'
import { saveRunbookFile } from '@/lib/engine/config'
import { detectFormat, parseRunbookContent } from '@/lib/engine/runbooks'
import { rt } from '@/lib/engine/runtime'
import type { Runbook } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  return handle(async () => {
    const r = rt()
    return json({
      runbooks: [...r.runbooks.values()],
      actions: Object.entries(r.actions).map(([name, a]) => ({
        name,
        description: a.description ?? name,
        method: a.method,
        url: a.url,
        approval: a.approval ?? 'none',
      })),
      usedBy: Object.fromEntries(
        [...r.runbooks.keys()].map((id) => [id, r.rules.filter((x) => x.runbook === id).map((x) => x.name)])
      ),
    })
  })
}

export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{
      id?: string
      content?: string
      format?: Runbook['format'] | 'auto'
      preview?: boolean
      actor?: string
    }>(req)
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
    const id = saveRunbookFile(body.id, format, content)
    await audit(actorOf(req, body), 'runbook.saved', id, `${format}, ${parsed.steps.length} steps`)
    return json({ ok: true, id, format })
  })
}
