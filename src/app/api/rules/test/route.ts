import { fail, handle, json, readJson } from '@/lib/engine/api'
import { simulateBudget } from '@/lib/engine/budget'
import { db, ms } from '@/lib/engine/db'
import { dedupKey } from '@/lib/engine/pipeline'
import { evaluate, resolveField, validateRule } from '@/lib/engine/rules'
import { rt } from '@/lib/engine/runtime'
import type { Canonical, EventView, Json, Rule } from '@/lib/engine/types'
import { render } from '@/lib/engine/util'

export const dynamic = 'force-dynamic'

const PREVIEW_EVENTS = Number(process.env.RULE_PREVIEW_EVENTS ?? 1000)

/**
 * Preview a rule against the most recent stored events: what would match, how many alerts that would become, and
 * the noise budget: who would have been notified how often, on which channel, over the time those events cover.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const { rule } = await readJson<{ rule?: Rule }>(req)
    if (!rule?.when) return fail('rule.when is required')
    const err = validateRule({ ...rule, notify: rule.notify ?? [], id: rule.id || 'preview', name: rule.name || 'preview', team: rule.team || 'preview' })
    if (err) return fail(err)
    const rows = await db()<{ id: string; receivedAt: Date; source: string; schemaFp: string; raw: Json; canonical: Canonical }[]>`
      select id, received_at, source, schema_fp, raw, canonical from events order by id desc limit ${PREVIEW_EVENTS}`
    const names = new Map((await db()<{ fingerprint: string; name: string }[]>`select fingerprint, name from schemas`).map((s) => [s.fingerprint, s.name]))
    const samples: { id: string; schema: string; title: string; at: number }[] = []
    const groups = new Set<string>()
    const hits: { at: number; ev: EventView }[] = []
    let matched = 0
    for (const row of rows) {
      const ev: EventView = { source: row.source, schemaName: names.get(row.schemaFp) ?? row.schemaFp, raw: row.raw, canonical: row.canonical }
      if (!evaluate(rule.when, ev)) continue
      matched++
      hits.push({ at: ms(row.receivedAt)!, ev })
      groups.add(dedupKey({ ...rule, id: rule.id || 'preview' }, ev))
      if (samples.length < 5) {
        const title = render(rule.present?.title ?? '{{title}} on {{service}}', (p) => resolveField(ev, p))
        samples.push({ id: String(row.id), schema: ev.schemaName, title, at: ms(row.receivedAt)! })
      }
    }
    const existing = rt().rules.find((r) => r.id === rule.id)
    const budget = simulateBudget({ ...rule, id: rule.id || 'preview', name: rule.name || 'preview', team: rule.team || 'preview', notify: rule.notify ?? [] }, hits)
    return json({ tested: rows.length, matched, alerts: groups.size, samples, replaces: existing ? existing.name : null, budget })
  })
}
