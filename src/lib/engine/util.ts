import { createHash, randomBytes } from 'node:crypto'
import type { Json } from './types'

export function newId(prefix: string) {
  return `${prefix}_${randomBytes(5).toString('hex')}`
}

export function shortHash(input: string) {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export function leaves(obj: unknown, prefix = '', out: { path: string; value: unknown }[] = []) {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const entries = Object.entries(obj as Record<string, unknown>)
    if (entries.length === 0 && prefix) out.push({ path: prefix, value: obj })
    for (const [k, v] of entries) leaves(v, prefix ? `${prefix}.${k}` : k, out)
  } else if (prefix) {
    out.push({ path: prefix, value: obj })
  }
  return out
}

const PIPES: Record<string, (v: unknown, arg?: string) => unknown> = {
  number: (v) =>
    typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)))
      ? Number(v).toLocaleString('en-US')
      : v,
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  default: (v, arg) => (v === undefined || v === null || v === '' ? arg : v),
}

export function render(template: string, resolve: (path: string) => unknown): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const [path, ...pipes] = expr.split('|').map((s) => s.trim())
    let value = resolve(path)
    for (const p of pipes) {
      const [name, arg] = p.split(':').map((s) => s.trim())
      value = PIPES[name]?.(value, arg) ?? value
    }
    if (value === undefined || value === null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

export function renderDeep(value: Json, resolve: (path: string) => unknown): Json {
  if (typeof value === 'string') return render(value, resolve)
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, resolve))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, resolve)]))
  }
  return value
}

export function globToRegex(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

export function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export function pushCapped<T>(arr: T[], item: T, cap: number) {
  arr.push(item)
  if (arr.length > cap) arr.splice(0, arr.length - cap)
}

export function localMinutes(at: number, tz?: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || process.env.TZ || 'Europe/Warsaw',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at))
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

export function hhmmToMinutes(s: string) {
  const [h, m] = s.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** "30s", "5m", "1h", "250ms" or a number of seconds → seconds. */
export function durationSec(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number') return value
  const m = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i)
  if (!m) return fallback
  const n = Number(m[1])
  const unit = (m[2] ?? 's').toLowerCase()
  return unit === 'ms' ? n / 1000 : unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : unit === 'd' ? n * 86400 : n
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
