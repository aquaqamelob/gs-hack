import { audit, publish } from './bus'
import { db, ms, type Tx } from './db'
import { LlmUnavailable, llmEnabled, llmModel, proposeMappings } from './llm'
import { count, rt } from './runtime'
import { computeMapping, describeFields, schemaName, schemaStatus, structureFingerprint, type MappingResult } from './schema'
import { CANONICAL_KEYS, type CanonicalKey, type FieldInfo, type Json, type MappingProposal, type SchemaRecord } from './types'

type Row = {
  fingerprint: string
  source: string
  name: string
  knownFormat: string | null
  fields: FieldInfo[]
  sample: Json
  mapping: SchemaRecord['mapping']
  mappedBy: SchemaRecord['mappedBy']
  confidence: SchemaRecord['confidence']
  proposals: MappingProposal[]
  status: SchemaRecord['status']
  llm: SchemaRecord['llm']
  eventCount: string | number
  firstSeen: Date
  lastSeen: Date
}

function fromRow(r: Row): SchemaRecord {
  return {
    fingerprint: r.fingerprint,
    source: r.source,
    name: r.name,
    knownFormat: r.knownFormat,
    fields: r.fields,
    sample: r.sample,
    mapping: r.mapping,
    mappedBy: r.mappedBy,
    confidence: r.confidence,
    proposals: r.proposals,
    status: r.status,
    llm: r.llm,
    eventCount: Number(r.eventCount),
    firstSeen: ms(r.firstSeen)!,
    lastSeen: ms(r.lastSeen)!,
  }
}

// Shared through globalThis: API routes and the instrumentation loop that flushes it load separate module copies.
const COUNTS_KEY = Symbol.for('ctrl.schema-counts.v1')
const pendingCounts: Map<string, number> = ((globalThis as Record<symbol, unknown>)[COUNTS_KEY] ??= new Map()) as Map<string, number>

export function invalidateSchema(fp: string) {
  rt().schemas.delete(fp)
}

function jaccard(a: string[], b: string[]) {
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter || 1)
}

/** A new variant of a schema we already understand (an optional field appeared) inherits its reviewed mapping. */
async function inheritFrom(source: string, fields: FieldInfo[]): Promise<Row | undefined> {
  const paths = fields.map((f) => f.path)
  const rows = await db()<Row[]>`
    select * from schemas where source = ${source} and status in ('approved', 'mapped') and known_format is null
    order by last_seen desc limit 50`
  return rows.find((r) => jaccard(r.fields.map((f) => f.path), paths) >= 0.8)
}

export async function observeSchema(raw: Json, source: string): Promise<SchemaRecord> {
  const fields = describeFields(raw)
  const fp = structureFingerprint(fields)
  pendingCounts.set(fp, (pendingCounts.get(fp) ?? 0) + 1)
  const cached = rt().schemas.get(fp)
  if (cached) return cached

  const [existing] = await db()<Row[]>`select * from schemas where fingerprint = ${fp}`
  if (existing) {
    const s = fromRow(existing)
    rt().schemas.set(fp, s)
    return s
  }

  const computed: MappingResult = computeMapping(raw, fields)
  const parent = computed.knownFormat ? undefined : await inheritFrom(source, fields)
  if (parent) {
    for (const [k, path] of Object.entries(parent.mapping) as [CanonicalKey, string][]) {
      if (!fields.some((f) => f.path === path)) continue
      computed.mapping[k] = path
      computed.mappedBy[k] = parent.mappedBy[k]
      computed.confidence[k] = parent.confidence[k]
      computed.proposals = computed.proposals.filter((p) => p.canonical !== k && p.path !== path)
    }
  }
  const proposals: MappingProposal[] = computed.proposals.map((p) => ({ ...p, state: 'pending' }))
  const status = parent?.status === 'approved' && !proposals.length ? 'approved' : schemaStatus({ ...computed, proposals })
  const name = parent?.name ?? schemaName(raw, source, computed)
  const inserted = await db()<Row[]>`
    insert into schemas (fingerprint, source, name, known_format, fields, sample, mapping, mapped_by, confidence, proposals, status)
    values (${fp}, ${source}, ${name}, ${computed.knownFormat ?? null}, ${db().json(fields as never)}, ${db().json(raw as never)},
            ${db().json(computed.mapping as never)}, ${db().json(computed.mappedBy as never)}, ${db().json(computed.confidence as never)},
            ${db().json(proposals as never)}, ${status})
    on conflict (fingerprint) do nothing
    returning *`
  const row = inserted[0] ?? (await db()<Row[]>`select * from schemas where fingerprint = ${fp}`)[0]
  const schema = fromRow(row)
  rt().schemas.set(fp, schema)
  if (inserted[0]) {
    count('schemas_detected_total')
    const mapped = Object.keys(schema.mapping).length
    await audit('system', 'schema.detected', schema.name, `${fields.length} fields, ${mapped} mapped automatically, ${proposals.length} to review`)
    await publish({ type: 'schema', id: fp })
    if (schema.status === 'needs-review' && llmEnabled()) void askLlmForSchema(fp, 'system')
  }
  return schema
}

export async function flushSchemaCounts() {
  if (!pendingCounts.size) return
  const rows = [...pendingCounts].map(([fingerprint, n]) => ({ fingerprint, n }))
  pendingCounts.clear()
  await db()`
    update schemas s set event_count = s.event_count + x.n, last_seen = now()
    from jsonb_to_recordset(${db().json(rows as never)}::jsonb) as x(fingerprint text, n int)
    where s.fingerprint = x.fingerprint`
}

export async function listSchemas() {
  const rows = await db()<Row[]>`select * from schemas order by (status = 'needs-review') desc, last_seen desc limit 500`
  return rows.map(fromRow)
}

export async function getSchema(fp: string) {
  const [row] = await db()<Row[]>`select * from schemas where fingerprint = ${fp}`
  return row ? fromRow(row) : undefined
}

async function mutate(fp: string, fn: (s: SchemaRecord, tx: Tx) => Promise<void> | void) {
  const result = await db().begin(async (tx) => {
    const [row] = await tx<Row[]>`select * from schemas where fingerprint = ${fp} for update`
    if (!row) throw new Error('Unknown schema')
    const s = fromRow(row)
    await fn(s, tx)
    await tx`
      update schemas set name = ${s.name}, mapping = ${tx.json(s.mapping as never)}, mapped_by = ${tx.json(s.mappedBy as never)},
        confidence = ${tx.json(s.confidence as never)}, proposals = ${tx.json(s.proposals as never)}, status = ${s.status},
        llm = ${tx.json(s.llm as never)}
      where fingerprint = ${fp}`
    await publish({ type: 'schema', id: fp }, tx)
    return s
  })
  invalidateSchema(fp)
  return result
}

const recomputeStatus = (s: SchemaRecord) => {
  if (s.status !== 'approved') s.status = schemaStatus(s)
}

export async function askLlmForSchema(fp: string, actor: string) {
  const schema = await getSchema(fp)
  if (!schema || schema.llm.state === 'running') return
  const missing = CANONICAL_KEYS.filter((k) => !schema.mapping[k] && !schema.proposals.some((p) => p.canonical === k && p.state === 'pending'))
  const used = new Set(Object.values(schema.mapping))
  const candidates = schema.fields.filter((f) => !used.has(f.path))
  if (!missing.length || !candidates.length) {
    await mutate(fp, (s) => void (s.llm = { state: 'done', detail: 'Nothing left to map', at: Date.now() }))
    return
  }
  await mutate(fp, (s) => void (s.llm = { state: 'running', at: Date.now() }))
  try {
    const mappings = await proposeMappings(candidates, missing)
    await mutate(fp, (s) => {
      for (const m of mappings) {
        s.proposals = s.proposals.filter((p) => !(p.canonical === m.canonical && p.state === 'pending'))
        s.proposals.push({ ...m, by: 'llm', state: 'pending' })
      }
      s.llm = { state: 'done', detail: `${mappings.length} proposal(s) from ${llmModel()}`, at: Date.now() }
      recomputeStatus(s)
    })
    await audit(actor, 'schema.llm-proposed', schema.name, `${mappings.length} proposals; sent ${candidates.length} field paths, no values`)
  } catch (e) {
    await mutate(fp, (s) => {
      s.llm = { state: e instanceof LlmUnavailable ? 'disabled' : 'error', detail: (e as Error).message, at: Date.now() }
    })
  }
}

export async function decideProposal(fp: string, canonical: CanonicalKey, path: string, accept: boolean, actor: string) {
  let label = ''
  const s = await mutate(fp, (s) => {
    const p = s.proposals.find((x) => x.canonical === canonical && x.path === path && x.state === 'pending')
    if (!p) throw new Error('Proposal not found')
    p.state = accept ? 'accepted' : 'rejected'
    label = `${canonical} ← ${path} (${p.by}, ${Math.round(p.confidence * 100)}%)`
    if (accept) {
      s.mapping[canonical] = path
      s.mappedBy[canonical] = 'human'
      s.confidence[canonical] = 1
      for (const o of s.proposals) if (o !== p && o.canonical === canonical && o.state === 'pending') o.state = 'rejected'
    }
    recomputeStatus(s)
  })
  await audit(actor, accept ? 'schema.mapping-accepted' : 'schema.mapping-rejected', s.name, label)
  return s
}

export async function setMapping(fp: string, canonical: CanonicalKey, path: string | null, actor: string) {
  const s = await mutate(fp, (s) => {
    if (path) {
      if (!s.fields.some((f) => f.path === path) && !/^[\w$@-]+(\.[\w$@-]+)*$/.test(path))
        throw new Error(`"${path}" is not a field path (use dots for nesting, e.g. details.reason)`)
      s.mapping[canonical] = path
      s.mappedBy[canonical] = 'human'
      s.confidence[canonical] = 1
    } else {
      delete s.mapping[canonical]
      delete s.mappedBy[canonical]
      delete s.confidence[canonical]
    }
    recomputeStatus(s)
  })
  await audit(actor, 'schema.mapping-set', s.name, `${canonical} ← ${path ?? '(none)'}`)
  return s
}

export async function approveSchema(fp: string, actor: string, name?: string) {
  const s = await mutate(fp, (s) => {
    if (name) s.name = name.slice(0, 80)
    s.status = 'approved'
    for (const p of s.proposals) if (p.state === 'pending') p.state = 'rejected'
  })
  await audit(actor, 'schema.approved', s.name, JSON.stringify(s.mapping))
  return s
}

/** Dry run for the mapping screen: paste a sample, see what layers 1 and 2 would do. Nothing is stored. */
export function previewMapping(sample: Json, source: string) {
  const fields = describeFields(sample)
  const computed = computeMapping(sample, fields)
  const proposals = computed.proposals.map((p) => ({ ...p, state: 'pending' as const }))
  return {
    fingerprint: structureFingerprint(fields),
    name: schemaName(sample, source, computed),
    fields,
    ...computed,
    proposals,
    status: schemaStatus({ ...computed, proposals }),
  }
}
