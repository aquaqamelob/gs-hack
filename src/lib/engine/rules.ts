import { normalizeSeverity } from './schema'
import { CANONICAL_KEYS, CHANNELS, SEVERITIES, SEVERITY_RANK, type CanonicalKey, type Condition, type EventView, type Json, type Rule } from './types'
import { durationSec, getPath, globToRegex } from './util'

/** Canonical fields first, then `source`/`schema`, then any raw path (optionally prefixed with `raw.`). */
export function resolveField(ev: EventView, path: string): unknown {
  if (path === 'source') return ev.source
  if (path === 'schema') return ev.schemaName
  if (path.startsWith('raw.')) return getPath(ev.raw, path.slice(4))
  if ((CANONICAL_KEYS as readonly string[]).includes(path)) {
    const v = ev.canonical[path as CanonicalKey]
    if (v !== undefined) return v
  }
  return getPath(ev.raw, path)
}

function eq(a: unknown, b: unknown) {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
}

function list(value: Json | undefined): Json[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(',').map((s) => s.trim())
  return value === undefined ? [] : [value]
}

function compare(field: string, a: unknown, b: unknown): number | null {
  if (field === 'severity') {
    const x = normalizeSeverity(a)
    const y = normalizeSeverity(b)
    return x && y ? SEVERITY_RANK[x] - SEVERITY_RANK[y] : null
  }
  const x = Number(a)
  const y = Number(b)
  if (a === undefined || a === null || a === '' || isNaN(x) || isNaN(y)) return null
  return x - y
}

const regexCache = new Map<string, RegExp>()
function cachedRegex(key: string, make: () => RegExp) {
  let r = regexCache.get(key)
  if (!r) {
    r = make()
    if (regexCache.size > 1000) regexCache.clear()
    regexCache.set(key, r)
  }
  return r
}

export function evaluate(cond: Condition, ev: EventView): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluate(c, ev))
  if ('any' in cond) return cond.any.some((c) => evaluate(c, ev))
  const v = resolveField(ev, cond.field)
  switch (cond.op) {
    case 'eq':
      return eq(v, cond.value)
    case 'neq':
      return !eq(v, cond.value)
    case 'in':
      return list(cond.value).some((x) => eq(v, x))
    case 'not_in':
      return !list(cond.value).some((x) => eq(v, x))
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const c = compare(cond.field, v, cond.value)
      if (c === null) return false
      return cond.op === 'gt' ? c > 0 : cond.op === 'gte' ? c >= 0 : cond.op === 'lt' ? c < 0 : c <= 0
    }
    case 'glob':
      return v !== undefined && v !== null && cachedRegex(`g:${cond.value}`, () => globToRegex(String(cond.value))).test(String(v))
    case 'regex':
      try {
        return v !== undefined && v !== null && cachedRegex(`r:${cond.value}`, () => new RegExp(String(cond.value), 'i')).test(String(v))
      } catch {
        return false
      }
    case 'exists': {
      const present = v !== undefined && v !== null && v !== ''
      return cond.value === false ? !present : present
    }
    default:
      return false
  }
}

export const OP_LABELS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  glob: 'matches',
  regex: 'matches regex',
  exists: 'is present',
}

function validCondition(c: unknown, depth = 0): string | null {
  if (!c || typeof c !== 'object' || depth > 8) return 'condition must be an object'
  const x = c as Record<string, unknown>
  if (Array.isArray(x.all) || Array.isArray(x.any)) {
    for (const y of (x.all ?? x.any) as unknown[]) {
      const err = validCondition(y, depth + 1)
      if (err) return err
    }
    return null
  }
  if (typeof x.field !== 'string' || !x.field) return 'every condition needs a field'
  if (typeof x.op !== 'string' || !(x.op in OP_LABELS)) return `op must be one of ${Object.keys(OP_LABELS).join(', ')}`
  if (x.op === 'regex') {
    try {
      new RegExp(String(x.value))
    } catch {
      return `invalid regex "${x.value}"`
    }
  }
  return null
}

export function validateRule(r: Partial<Rule>): string | null {
  if (!r.id || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(r.id)) return 'id must be a lowercase slug (a-z, 0-9, -)'
  if (!r.name) return 'name is required'
  if (!r.team) return 'team is required'
  const condErr = validCondition(r.when)
  if (condErr) return `when: ${condErr}`
  if (!Array.isArray(r.notify)) return 'notify must be a list'
  for (const n of r.notify) {
    if (!n.to) return 'every notify entry needs "to"'
    if (n.channels && !n.channels.every((c) => CHANNELS.includes(c))) return `channels must be from ${CHANNELS.join(', ')}`
  }
  if (r.present?.severity && !SEVERITIES.includes(r.present.severity)) return `severity must be one of ${SEVERITIES.join(', ')}`
  for (const k of ['group_wait', 'group_interval', 'dedup_window'] as const) {
    if (r[k] !== undefined && durationSec(r[k], -1) < 0) return `${k} must be a duration like 30s, 5m or 1h`
  }
  return null
}

export function describeCondition(cond: Condition): string {
  if ('all' in cond) return cond.all.map((c) => ('field' in c ? describeCondition(c) : `(${describeCondition(c)})`)).join(' AND ')
  if ('any' in cond) return cond.any.map((c) => ('field' in c ? describeCondition(c) : `(${describeCondition(c)})`)).join(' OR ')
  if (cond.op === 'exists') return `${cond.field} ${cond.value === false ? 'is missing' : 'is present'}`
  const value = Array.isArray(cond.value) ? cond.value.join(', ') : cond.value
  return `${cond.field} ${OP_LABELS[cond.op] ?? cond.op} ${value}`
}

/** Default dedup key per the brief: source + type + service + error.code. */
export const DEFAULT_GROUP_BY = ['source', 'title', 'service', 'error.code']

export function groupSettings(rule: Rule) {
  return {
    groupBy: rule.group_by?.length ? rule.group_by : DEFAULT_GROUP_BY,
    waitSec: durationSec(rule.group_wait, 0),
    intervalSec: durationSec(rule.group_interval, 300),
    windowSec: durationSec(rule.dedup_window, 3600),
  }
}
