import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { rt } from '@/lib/engine/runtime'
import { canonicalDescriptions, isCanonicalKey } from '@/lib/engine/schema'
import { getSchema, listSchemas, observeSchema, previewMapping, setMapping } from '@/lib/engine/schemas'
import { type CanonicalKey, type Json } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  return handle(async () =>
    json({
      schemas: await listSchemas(),
      canonical: canonicalDescriptions(),
      fields: rt().fields,
    })
  )
}

/** Mapping screen: `preview` is a dry run; `register` stores the schema so it can be reviewed like any other. */
export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{
      op?: string
      sample?: Json
      source?: string
      mapping?: Partial<Record<CanonicalKey, string | null>>
      actor?: string
    }>(req)
    if (body.sample === undefined || body.sample === null || typeof body.sample !== 'object')
      return fail('sample must be a JSON object')
    const source =
      (body.source || 'webhook')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 40) || 'webhook'
    if (body.op === 'register') {
      const schema = await observeSchema(body.sample, source)
      for (const [key, path] of Object.entries(body.mapping ?? {})) {
        if (isCanonicalKey(key))
          await setMapping(schema.fingerprint, key, path || null, actorOf(req, body))
      }
      return json({ schema: (await getSchema(schema.fingerprint)) ?? schema })
    }
    return json({ preview: previewMapping(body.sample, source) })
  })
}
