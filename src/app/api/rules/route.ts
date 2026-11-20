import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { audit } from '@/lib/engine/bus'
import { saveRules } from '@/lib/engine/config'
import { db } from '@/lib/engine/db'
import { describeCondition, OP_LABELS, validateRule } from '@/lib/engine/rules'
import { rt } from '@/lib/engine/runtime'
import { CANONICAL_KEYS, type FieldInfo, type Rule } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  return handle(async () => {
    const r = rt()
    const fields = new Set<string>(['source', 'schema', ...CANONICAL_KEYS])
    const rows = await db()<{ fields: FieldInfo[] }[]>`select fields from schemas order by last_seen desc limit 100`
    for (const row of rows) for (const f of row.fields) fields.add(f.path)
    return json({
      rules: r.rules.map((x) => ({ ...x, summary: describeCondition(x.when) })),
      fields: [...fields],
      ops: OP_LABELS,
      recipients: r.recipients.map(({ id, name, kind }) => ({ id, name, kind })),
      runbooks: [...r.runbooks.values()].map(({ id, title, format }) => ({ id, title, format })),
    })
  })
}

export async function PUT(req: Request) {
  return handle(async () => {
    const r = rt()
    const body = await readJson<{ rule?: Rule; previousId?: string; actor?: string }>(req)
    const rule = body.rule
    if (!rule) return fail('rule is required')
    const err = validateRule(rule)
    if (err) return fail(err)
    const replaceId = body.previousId ?? rule.id
    const exists = r.rules.some((x) => x.id === replaceId)
    if (!exists && r.rules.some((x) => x.id === rule.id)) return fail(`Rule id "${rule.id}" already exists`)
    const clean = JSON.parse(JSON.stringify(rule)) as Rule & { summary?: string }
    delete clean.summary
    saveRules(exists ? r.rules.map((x) => (x.id === replaceId ? clean : x)) : [...r.rules, clean])
    await audit(actorOf(req, body), exists ? 'rule.updated' : 'rule.created', rule.id, describeCondition(rule.when))
    return json({ ok: true, rule: clean })
  })
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const r = rt()
    const id = new URL(req.url).searchParams.get('id')
    if (!id || !r.rules.some((x) => x.id === id)) return fail('Unknown rule', 404)
    saveRules(r.rules.filter((x) => x.id !== id))
    await audit(actorOf(req), 'rule.deleted', id)
    return json({ ok: true })
  })
}
