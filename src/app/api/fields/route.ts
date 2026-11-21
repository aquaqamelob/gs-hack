import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { audit } from '@/lib/engine/bus'
import { cleanField, ConfigError, updateFields, validateField } from '@/lib/engine/config'
import { rt } from '@/lib/engine/runtime'
import { backfillField, dropField, setMapping } from '@/lib/engine/schemas'
import type { CustomField } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

/** Custom canonical fields (stored in Postgres; config/fields.yaml only seeds them). */
export async function GET() {
  return handle(async () => json({ fields: rt().fields }))
}

/**
 * Create or update a custom field. Optionally map it right away in one schema (`map: {fingerprint, path}`),
 * then look for it in every other stored schema.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{ field?: Partial<CustomField>; map?: { fingerprint: string; path: string }; actor?: string }>(req)
    const f = body.field
    if (!f) return fail('field is required')
    const err = validateField(f)
    if (err) return fail(err)
    const field = cleanField(f)
    const exists = await updateFields((fields) => {
      const found = fields.some((x) => x.key === field.key)
      return { fields: found ? fields.map((x) => (x.key === field.key ? field : x)) : [...fields, field], result: found }
    }, undefined, actorOf(req, body))
    const actor = actorOf(req, body)
    await audit(actor, exists ? 'field.updated' : 'field.created', field.key, `${field.type}; synonyms: ${field.synonyms.join(', ')}`)
    if (body.map?.fingerprint && body.map.path) await setMapping(body.map.fingerprint, field.key, body.map.path, actor)
    const backfill = await backfillField(field.key, actor)
    return json({ field, backfill })
  })
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const key = new URL(req.url).searchParams.get('key')
    if (!key) return fail('Unknown field', 404)
    await updateFields((fields, rules) => {
      if (!fields.some((f) => f.key === key)) throw new ConfigError('Unknown field', 404)
      const usedBy = rules.filter((rule) => JSON.stringify(rule).includes(`"${key}"`) || JSON.stringify(rule).includes(`{{${key}}}`))
      if (usedBy.length)
        throw new ConfigError(
          `"${key}" is used by rule${usedBy.length > 1 ? 's' : ''} ${usedBy.map((x) => x.id).join(', ')}. Change them first.`,
          409
        )
      return { fields: fields.filter((f) => f.key !== key) }
    }, undefined, actorOf(req))
    const schemas = await dropField(key)
    await audit(actorOf(req), 'field.deleted', key, `removed from ${schemas} schema(s)`)
    return json({ ok: true })
  })
}
