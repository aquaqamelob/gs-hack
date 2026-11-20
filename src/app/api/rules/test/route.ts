import { fail, handle, json, readJson } from '@/lib/engine/api'
import { db, ms } from '@/lib/engine/db'
import { dedupKey } from '@/lib/engine/pipeline'
import { evaluate, resolveField, validateRule } from '@/lib/engine/rules'
import { rt } from '@/lib/engine/runtime'
import type { Canonical, EventView, Json, Rule } from '@/lib/engine/types'
import { render } from '@/lib/engine/util'

export const dynamic = 'force-dynamic'

/** Preview a rule against the last 100 stored events: what would match and how many alerts that would become. */
export async function POST(req: Request) {
  return handle(async () => {
    const { rule } = await readJson<{ rule?: Rule }>(req)
    if (!rule?.when) return fail('rule.when is required')
    const err = validateRule({ ...rule, notify: rule.notify ?? [], id: rule.id || 'preview', name: rule.name || 'preview', team: rule.team || 'preview' })
    if (err) return fail(err)
    const rows = await db()<{ id: string; receivedAt: Date; source: string; schemaFp: string; raw: Json; canonical: Canonical }[]>`
      select id, received_at, source, schema_fp, raw, canonical from events order by id desc limit 100`
    const names = new Map((await db()<{ fingerprint: string; name: string }[]>`select fingerprint, name from schemas`).map((s) => [s.fingerprint, s.name]))
    const samples: { id: string; schema: string; title: string; at: number }[] = []
    const groups = new Set<string>()
    let matched = 0
    for (const row of rows) {
      const ev: EventView = { source: row.source, schemaName: names.get(row.schemaFp) ?? row.schemaFp, raw: row.raw, canonical: row.canonical }
      if (!evaluate(rule.when, ev)) continue
      matched++
      groups.add(dedupKey({ ...rule, id: rule.id || 'preview' }, ev))
      if (samples.length < 5) {
        const title = render(rule.present?.title ?? '{{title}} on {{service}}', (p) => resolveField(ev, p))
        samples.push({ id: String(row.id), schema: ev.schemaName, title, at: ms(row.receivedAt)! })
      }
    }
    const existing = rt().rules.find((r) => r.id === rule.id)
    return json({ tested: rows.length, matched, alerts: groups.size, samples, replaces: existing ? existing.name : null })
  })
}
