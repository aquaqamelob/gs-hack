import YAML from 'yaml'
import { getAlert } from './alerts'
import { audit, publish } from './bus'
import { ConfigError, saveRunbook, slug, updateRules } from './config'
import { db, ms } from './db'
import { rt } from './runtime'
import { describeFields } from './schema'
import type { Alert, Runbook } from './types'
import { getPath, newId } from './util'

/**
 * Proposals = "Propose a fix" (brief 2.4) and runbooks that learn from resolved incidents (brief 2.6, optional).
 *
 * Learning is deterministic, no model: when someone resolves an alert they can list what fixed it, one step per line.
 * Lines that are not already a step of the alert's runbook become proposals for that runbook (or for a new runbook
 * of the rule when there is none). Concrete values from the alert are turned back into template fields
 * (WF-20261023-00042 → {{workflowId}}) so the step fits the next incident too. The same step proposed again from
 * another incident merges into one proposal with a counter. A human accepts it; accepting saves the runbook through
 * the normal config path. Learned steps are always plain text steps, never actions, so a resolution note can never
 * add a webhook call: turning a step into an action stays a human edit.
 */
export const MANUAL_REASONS = [
  'too-noisy',
  'wrong-team',
  'wrong-severity',
  'runbook-step-wrong',
  'missing-step',
  'other',
] as const
export type Reason = (typeof MANUAL_REASONS)[number]

export interface Proposal {
  id: number
  kind: 'manual' | 'learned'
  target: string
  reason: string
  text: string
  patch: { op: 'add-step'; text: string; runbook: string | null; rule: string } | null
  alertIds: string[]
  seen: number
  status: 'open' | 'accepted' | 'dismissed'
  createdBy: string
  createdAt: number
  updatedAt: number
  decidedBy: string | null
  decidedAt: number | null
}

const fromRow = (r: Record<string, unknown>): Proposal => ({
  id: Number(r.id),
  kind: r.kind as Proposal['kind'],
  target: r.target as string,
  reason: r.reason as string,
  text: r.text as string,
  patch: (r.patch as Proposal['patch']) ?? null,
  alertIds: (r.alertIds as string[]) ?? [],
  seen: Number(r.seen),
  status: r.status as Proposal['status'],
  createdBy: r.createdBy as string,
  createdAt: ms(r.createdAt as Date)!,
  updatedAt: ms(r.updatedAt as Date)!,
  decidedBy: (r.decidedBy as string) ?? null,
  decidedAt: ms(r.decidedAt as Date),
})

export async function listProposals(status: string | null = 'open') {
  const rows = await db()`
    select * from proposals where (${status}::text is null or status = ${status})
    order by status = 'open' desc, seen desc, updated_at desc limit 200`
  return rows.map(fromRow)
}

/** Lowercase letters, digits and template fields only: "Restart  the pod!" and "restart the pod" are the same step. */
export const normStep = (s: string) =>
  s
    .toLowerCase()
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, '{{$1}}')
    .replace(/[^a-z0-9{}.]+/g, ' ')
    .trim()

/**
 * Concrete values from the alert's event → {{path}}, longest first. Only values that look like identifiers (a digit,
 * or a separator such as - _ . : /), so WF-20261023-00042 or order-settlement become fields while ordinary words
 * that happen to be a field value ("settlement", "prod") stay text.
 */
export function templatize(line: string, raw: unknown): string {
  const values = new Map<string, string>()
  for (const f of describeFields(raw)) {
    const v = getPath(raw, f.path)
    if (typeof v !== 'string' && typeof v !== 'number') continue
    const s = String(v)
    if (s.length < 4 || !/[\d\-_.:/]/.test(s)) continue
    if (!values.has(s)) values.set(s, f.path)
  }
  let out = line
  for (const [value, path] of [...values].sort((a, b) => b[0].length - a[0].length))
    out = out.split(value).join(`{{${path}}}`)
  return out
}

/** Called after an alert is resolved with "what fixed it" lines. Returns the proposals created or merged. */
export async function learnFromResolution(alertId: string, lines: string[], actor: string) {
  const alert = await getAlert(alertId)
  if (!alert || alert.ruleId === '__unassigned') return []
  const rb = alert.runbook ? rt().runbooks.get(alert.runbook.id) : undefined
  // Known steps: the runbook's templates, and the alert's own steps as rendered (what the person saw and may copy).
  const existing = new Set([
    ...(rb?.steps ?? []).map((s) => normStep(s.text)),
    ...alert.steps.map((s) => normStep(s.text)),
  ])
  const out: Proposal[] = []
  for (const line of lines
    .map((l) => l.trim().replace(/^(\d+[.)]|[-*•])\s+/, ''))
    .filter(Boolean)
    .slice(0, 10)) {
    const text = templatize(line.slice(0, 300), alert.raw)
    const fp = normStep(text)
    if (!fp || existing.has(fp) || existing.has(normStep(line))) continue
    existing.add(fp)
    const target = rb ? `runbook:${rb.id}` : `rule:${alert.ruleId}`
    const patch = { op: 'add-step', text, runbook: rb?.id ?? null, rule: alert.ruleId }
    const [row] = await db()`
      insert into proposals (kind, target, reason, text, patch, fingerprint, alert_ids, created_by)
      values ('learned', ${target}, 'missing-step', ${text}, ${db().json(patch as never)}, ${fp}, ${[alert.id]}, ${actor})
      on conflict (target, fingerprint) where status = 'open' do update set
        seen = proposals.seen + (case when ${alert.id} = any(proposals.alert_ids) then 0 else 1 end),
        alert_ids = case when ${alert.id} = any(proposals.alert_ids) then proposals.alert_ids
                         else array_append(proposals.alert_ids, ${alert.id}) end,
        updated_at = now()
      returning *`
    out.push(fromRow(row))
  }
  if (out.length) {
    await audit(
      actor,
      'proposal.learned',
      alert.id,
      out.map((p) => `${p.target}: ${p.text} (seen ${p.seen}×)`).join(' | ')
    )
    await publish({ type: 'proposal' })
  }
  return out
}

/** "Propose a fix" on an alert: a free-text suggestion for the alert's rule, for an admin to act on. */
export async function proposeFix(alert: Alert, reason: Reason, text: string, actor: string) {
  const [row] = await db()`
    insert into proposals (kind, target, reason, text, fingerprint, alert_ids, created_by)
    values ('manual', ${`rule:${alert.ruleId}`}, ${reason}, ${text}, ${newId('fix')}, ${[alert.id]}, ${actor})
    returning *`
  await audit(actor, 'proposal.created', alert.id, `${reason}: ${text}`)
  await publish({ type: 'proposal' })
  return fromRow(row)
}

/** The runbook text with one more step, in the runbook's own format (free text becomes a Markdown list). */
export function withStep(
  rb: Pick<Runbook, 'format' | 'content' | 'title'>,
  text: string
): { format: Runbook['format']; content: string } {
  if (rb.format === 'yaml') {
    const doc = YAML.parseDocument(rb.content)
    if (!doc.has('steps')) doc.set('steps', doc.createNode([]))
    doc.addIn(['steps'], doc.createNode({ text }))
    return { format: 'yaml', content: doc.toString({ lineWidth: 0 }) }
  }
  if (rb.format === 'markdown') {
    const items = rb.content.split('\n').filter((l) => /^\s*(\d+[.)]|[-*+])\s+/.test(l))
    const last = items.at(-1)
    const n = last?.match(/^\s*(\d+)[.)]/)?.[1]
    const marker = last ? (n ? `${Number(n) + 1}.` : (last.trim()[0] ?? '-')) : `${items.length + 1}.`
    return { format: 'markdown', content: `${rb.content.replace(/\s*$/, '')}\n${marker} ${text}\n` }
  }
  return {
    format: 'markdown',
    content: `# ${rb.title}\n\n1. ${rb.content.trim().replace(/\s*\n\s*/g, ' ')}\n2. ${text}\n`,
  }
}

async function decide(id: number, status: 'accepted' | 'dismissed', actor: string) {
  const [row] = await db()`
    update proposals set status = ${status}, decided_by = ${actor}, decided_at = now(), updated_at = now()
    where id = ${id} and status = 'open' returning *`
  if (!row) throw new ConfigError('Proposal not found or already decided', 409)
  return fromRow(row)
}

export async function acceptProposal(id: number, actor: string) {
  const [row] = await db()`select * from proposals where id = ${id}`
  if (!row) throw new ConfigError('Proposal not found', 404)
  const p = fromRow(row)
  if (p.status !== 'open') throw new ConfigError('Proposal already decided', 409)
  let applied = 'noted for the rule owner'
  if (p.kind === 'learned' && p.patch?.op === 'add-step') {
    const rule = rt().rules.find((r) => r.id === p.patch!.rule)
    let rb = p.patch.runbook ? rt().runbooks.get(p.patch.runbook) : undefined
    if (!rb && rule?.runbook) rb = rt().runbooks.get(rule.runbook)
    if (rb) {
      const next = withStep(rb, p.patch.text)
      await saveRunbook(rb.id, next.format, next.content, actor)
      applied = `step added to runbook ${rb.id}`
    } else {
      if (!rule) throw new ConfigError(`Rule ${p.patch.rule} no longer exists`, 409)
      const rbId = slug(rule.id)
      await saveRunbook(rbId, 'markdown', `# ${rule.name}\n\n1. ${p.patch.text}\n`, actor)
      await updateRules(
        (rules) => ({ rules: rules.map((r) => (r.id === rule.id ? { ...r, runbook: rbId } : r)) }),
        undefined,
        actor
      )
      applied = `new runbook ${rbId} attached to rule ${rule.id}`
    }
  }
  const done = await decide(id, 'accepted', actor)
  await audit(actor, p.kind === 'learned' ? 'runbook.learned' : 'proposal.accepted', p.target, `${p.text} → ${applied}`)
  await publish({ type: 'proposal' })
  return { proposal: done, applied }
}

export async function dismissProposal(id: number, actor: string) {
  const done = await decide(id, 'dismissed', actor)
  await audit(actor, 'proposal.dismissed', done.target, done.text)
  await publish({ type: 'proposal' })
  return done
}
