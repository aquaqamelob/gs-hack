import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { assertCanEditRule, me } from '@/lib/engine/auth'
import { audit } from '@/lib/engine/bus'
import { ConfigError, configVersion, updateRules } from '@/lib/engine/config'
import { db } from '@/lib/engine/db'
import { describeCondition, OP_LABELS, validateRule } from '@/lib/engine/rules'
import { rt } from '@/lib/engine/runtime'
import { allKeys } from '@/lib/engine/schema'
import { type FieldInfo, type Rule } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return handle(async () => {
    const r = rt()
    const fields = new Set<string>(['source', 'schema', ...allKeys()])
    const rows = await db()<{ fields: FieldInfo[] }[]>`select fields from schemas order by last_seen desc limit 100`
    for (const row of rows) for (const f of row.fields) fields.add(f.path)
    return json({
      version: configVersion('rules'),
      rules: r.rules.map((x) => ({ ...x, summary: describeCondition(x.when) })),
      fields: [...fields],
      ops: OP_LABELS,
      recipients: r.recipients.map(({ id, name, kind }) => ({ id, name, kind })),
      me: me(req),
      runbooks: [...r.runbooks.values()].map(({ id, title, format }) => ({ id, title, format })),
    })
  })
}

export async function PUT(req: Request) {
  return handle(async () => {
    const body = await readJson<{ rule?: Rule; previousId?: string; actor?: string; version?: string }>(req)
    const rule = body.rule
    if (!rule) return fail('rule is required')
    const err = validateRule(rule)
    if (err) return fail(err)
    const who = me(req, body)
    const replaceId = body.previousId ?? rule.id
    const clean = JSON.parse(JSON.stringify(rule)) as Rule & { summary?: string }
    delete clean.summary
    // Conflict checks run on the rules as stored in Postgres now, under the row lock.
    const exists = await updateRules((rules) => {
      const previous = rules.find((x) => x.id === replaceId)
      if (!previous && rules.some((x) => x.id === rule.id)) throw new ConfigError(`Rule id "${rule.id}" already exists`)
      if (replaceId !== rule.id && rules.some((x) => x.id === rule.id))
        throw new ConfigError(`Rule id "${rule.id}" already exists`)
      assertCanEditRule(who, rule, previous)
      return {
        rules: previous ? rules.map((x) => (x.id === replaceId ? clean : x)) : [...rules, clean],
        result: Boolean(previous),
      }
    }, body.version, actorOf(req, body))
    await audit(actorOf(req, body), exists ? 'rule.updated' : 'rule.created', rule.id, describeCondition(rule.when))
    return json({ ok: true, rule: clean, version: configVersion('rules') })
  })
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const params = new URL(req.url).searchParams
    const id = params.get('id')
    if (!id) return fail('Unknown rule', 404)
    const who = me(req)
    await updateRules((rules) => {
      const previous = rules.find((x) => x.id === id)
      if (!previous) throw new ConfigError('Unknown rule', 404)
      assertCanEditRule(who, null, previous)
      return { rules: rules.filter((x) => x.id !== id) }
    }, params.get('version') ?? undefined, actorOf(req))
    await audit(actorOf(req), 'rule.deleted', id)
    return json({ ok: true, version: configVersion('rules') })
  })
}
