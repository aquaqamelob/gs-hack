import { fail, handle, json, readJson } from '@/lib/engine/api'
import { db, ms } from '@/lib/engine/db'
import { noiseBudget } from '@/lib/engine/noise'
import type { Prepared } from '@/lib/engine/pipeline'
import { evaluate, resolveField, validateRule } from '@/lib/engine/rules'
import { rt } from '@/lib/engine/runtime'
import type { Canonical, EventView, Json, Rule, SchemaRecord } from '@/lib/engine/types'
import { render } from '@/lib/engine/util'

export const dynamic = 'force-dynamic'

/** Preview a rule against the last 100 stored events: what would match, how many alerts that becomes and who would be notified. */
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
    const candidate: Rule = { ...rule, id: rule.id || 'preview', name: rule.name || 'preview', team: rule.team || 'preview', notify: rule.notify ?? [] }
    const hits: Prepared[] = []
    for (const row of rows) {
      const ev: EventView = { source: row.source, schemaName: names.get(row.schemaFp) ?? row.schemaFp, raw: row.raw, canonical: row.canonical }
      if (!evaluate(rule.when, ev)) continue
      hits.push({
        ...ev,
        receivedAt: ms(row.receivedAt)!,
        schema: { fingerprint: row.schemaFp, name: ev.schemaName } as SchemaRecord,
        rules: [candidate],
        alertIds: [],
      })
      if (samples.length < 5) {
        const title = render(rule.present?.title ?? '{{title}} on {{service}}', (p) => resolveField(ev, p))
        samples.push({ id: String(row.id), schema: ev.schemaName, title, at: ms(row.receivedAt)! })
      }
    }
    const existing = rt().rules.find((r) => r.id === rule.id)
    const noise = noiseBudget(candidate, hits)
    return json({ tested: rows.length, matched: hits.length, alerts: noise.alerts, samples, noise, replaces: existing ? existing.name : null })
  })
}
