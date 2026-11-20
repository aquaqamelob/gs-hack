import { fail, handle, json, readJson } from '@/lib/engine/api'
import { llmEnabled, llmModel } from '@/lib/engine/llm'
import { CANONICAL_DESCRIPTIONS } from '@/lib/engine/schema'
import { listSchemas, observeSchema, previewMapping } from '@/lib/engine/schemas'
import type { Json } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  return handle(async () =>
    json({
      schemas: await listSchemas(),
      canonical: CANONICAL_DESCRIPTIONS,
      llm: { enabled: llmEnabled(), model: llmModel() },
    })
  )
}

/** Mapping screen: `preview` is a dry run; `register` stores the schema so it can be reviewed like any other. */
export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{ op?: string; sample?: Json; source?: string }>(req)
    if (body.sample === undefined || body.sample === null || typeof body.sample !== 'object') return fail('sample must be a JSON object')
    const source = (body.source || 'webhook').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'webhook'
    if (body.op === 'register') return json({ schema: await observeSchema(body.sample, source) })
    return json({ preview: previewMapping(body.sample, source) })
  })
}
