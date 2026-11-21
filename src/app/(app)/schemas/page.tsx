'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Heading, Subheading } from '@/components/heading'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { Textarea } from '@/components/textarea'
import { api, timeAgo, useLive } from '@/lib/client'
import type { CanonicalKey, CustomField, CustomFieldType, FieldInfo, Json, MappedBy, MappingProposal, SchemaRecord } from '@/lib/engine/types'
import { useSearchParams } from 'next/navigation'
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState } from 'react'

type Data = {
  schemas: SchemaRecord[]
  canonical: Record<CanonicalKey, string>
  fields: CustomField[]
}

type Mapping = Partial<Record<CanonicalKey, string>>

const BUILTIN_ORDER: CanonicalKey[] = [
  'title',
  'severity',
  'service',
  'environment',
  'error.message',
  'error.code',
  'entity_id',
  'timestamp',
]

/** Built-in keys in display order, then custom fields; shared by every component on the page. */
type Keys = { all: CanonicalKey[]; custom: CustomField[]; isCustom: (k: CanonicalKey) => boolean }
function makeKeys(custom: CustomField[]): Keys {
  return {
    all: [...BUILTIN_ORDER, ...custom.map((f) => f.key)],
    custom,
    isCustom: (k) => custom.some((f) => f.key === k),
  }
}
const KeysContext = createContext<Keys>(makeKeys([]))
const useKeys = () => useContext(KeysContext)

const BY_BADGE: Record<MappedBy, { color: 'zinc' | 'violet' | 'green' | 'sky' | 'amber'; label: string }> = {
  'known-format': { color: 'sky', label: 'known format' },
  deterministic: { color: 'zinc', label: 'rules' },
  fuzzy: { color: 'amber', label: 'fuzzy' },
  human: { color: 'green', label: 'you' },
}

const STATUS = {
  approved: { color: 'green', label: 'approved' },
  mapped: { color: 'zinc', label: 'mapped' },
  'needs-review': { color: 'amber', label: 'needs review' },
} as const

const CUSTOM = '__custom__'

function getPath(obj: Json | undefined, path: string): Json | undefined {
  let cur: Json | undefined = obj
  for (const part of path.replace(/\[\]/g, '').split('.')) {
    if (Array.isArray(cur)) cur = cur[0]
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, Json>)[part]
  }
  return Array.isArray(cur) ? cur[0] : cur
}

function show(v: Json | undefined) {
  if (v === undefined) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 48 ? `${s.slice(0, 45)}…` : s
}

// ---------------------------------------------------------------- mapping editor (shared by new and stored schemas)

function MappingRow({
  k,
  fields,
  sample,
  path,
  by,
  confidence,
  description,
  onChange,
}: {
  k: CanonicalKey
  fields: FieldInfo[]
  sample: Json
  path?: string
  by?: MappedBy
  confidence?: number
  description: string
  onChange: (path: string | null) => void
}) {
  const keys = useKeys()
  const known = !path || fields.some((f) => f.path === path)
  const [custom, setCustom] = useState(!known)
  const [draft, setDraft] = useState(path ?? '')
  useEffect(() => {
    setDraft(path ?? '')
    if (path && !fields.some((f) => f.path === path)) setCustom(true)
  }, [path, fields])
  const value = path ? getPath(sample, path) : undefined
  const listId = `paths-${k}`

  return (
    <div className="grid items-center gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(8rem,12rem)_minmax(12rem,1fr)_auto]">
      <div>
        <div className="font-medium">
          {k}
          {keys.isCustom(k) && (
            <Badge color="violet" className="ml-2">
              custom
            </Badge>
          )}
        </div>
        <div className="text-xs text-zinc-500">{description}</div>
      </div>
      <div className="min-w-0">
        {custom ? (
          <div className="flex gap-2">
            <Input
              list={listId}
              value={draft}
              placeholder="field path, e.g. details.failure_reason"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onChange(draft.trim() || null)}
              className="font-mono"
            />
            <datalist id={listId}>
              {fields.map((f) => (
                <option key={f.path} value={f.path} />
              ))}
            </datalist>
            <Button outline disabled={draft.trim() === (path ?? '')} onClick={() => onChange(draft.trim() || null)}>
              Save
            </Button>
            <Button plain onClick={() => setCustom(false)}>
              List
            </Button>
          </div>
        ) : (
          <Select
            value={path ?? ''}
            onChange={(e) => (e.target.value === CUSTOM ? setCustom(true) : onChange(e.target.value || null))}
          >
            <option value="">— not mapped —</option>
            {fields.map((f) => {
              const v = show(getPath(sample, f.path))
              return (
                <option key={f.path} value={f.path}>
                  {f.path}
                  {v ? ` — e.g. ${v}` : ''}
                </option>
              )
            })}
            <option value={CUSTOM}>Type another field path…</option>
          </Select>
        )}
        {path && (
          <div className="mt-1 truncate text-xs text-zinc-500">
            {value === undefined ? (
              'no value in the example'
            ) : (
              <>
                example: <span className="font-medium text-zinc-700 dark:text-zinc-300">{show(value)}</span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="text-right">
        {by && <Badge color={BY_BADGE[by].color}>{BY_BADGE[by].label}</Badge>}
      </div>
    </div>
  )
}

function MappingEditor(props: {
  fields: FieldInfo[]
  sample: Json
  mapping: Mapping
  mappedBy?: Partial<Record<CanonicalKey, MappedBy>>
  confidence?: Partial<Record<CanonicalKey, number>>
  canonical: Record<CanonicalKey, string>
  onChange: (k: CanonicalKey, path: string | null) => void
}) {
  const keys = useKeys()
  return (
    <div className="divide-y divide-zinc-950/5 dark:divide-white/5">
      {keys.all.map((k) => (
        <MappingRow
          key={k}
          k={k}
          fields={props.fields}
          sample={props.sample}
          path={props.mapping[k]}
          by={props.mappedBy?.[k]}
          confidence={props.confidence?.[k]}
          description={props.canonical[k]}
          onChange={(p) => props.onChange(k, p)}
        />
      ))}
    </div>
  )
}

function Proposals({
  proposals,
  sample,
  onDecide,
}: {
  proposals: MappingProposal[]
  sample: Json
  onDecide: (p: MappingProposal, accept: boolean) => void
}) {
  const keys = useKeys()
  if (!proposals.length) return null
  return (
    <section>
      <Subheading>Waiting for your review ({proposals.length})</Subheading>
      <ul className="mt-3 space-y-2">
        {proposals.map((p) => (
          <li
            key={`${p.canonical}-${p.path}`}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50/50 p-3 dark:border-amber-500/30 dark:bg-amber-500/5"
          >
            <span className="flex-1">
              <code className="font-semibold">{p.path}</code> → <strong>{p.canonical}</strong>{' '}
              <Badge color="amber">fuzzy</Badge>
              {p.reason && <span className="ml-2 text-sm text-zinc-500">{p.reason}</span>}
            </span>
            <Button color="green" onClick={() => onDecide(p, true)}>
              ✓ Accept
            </Button>
            <Button outline onClick={() => onDecide(p, false)}>
              ✗ Reject
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------- new schema: fields, JSON, or both

type FieldRow = { path: string; example: string; means: CanonicalKey | '' }
type Preview = {
  fingerprint: string
  name: string
  status: SchemaRecord['status']
  fields: FieldInfo[]
  mapping: Mapping
  mappedBy: Partial<Record<CanonicalKey, MappedBy>>
  confidence: Partial<Record<CanonicalKey, number>>
  proposals: MappingProposal[]
}

function typed(v: string): Json {
  const t = v.trim()
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (t === 'true' || t === 'false') return t === 'true'
  return v
}

function setPath(obj: Record<string, Json>, path: string, value: Json) {
  const parts = path.split('.').filter(Boolean)
  let cur = obj
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = value
    else {
      if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {}
      cur = cur[p] as Record<string, Json>
    }
  })
}

function NewSchema({
  canonical,
  onRegistered,
}: {
  canonical: Record<CanonicalKey, string>
  onRegistered: (fp: string) => void
}) {
  const [rows, setRows] = useState<FieldRow[]>([
    { path: '', example: '', means: '' },
    { path: '', example: '', means: '' },
    { path: '', example: '', means: '' },
  ])
  const [jsonText, setJsonText] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [source, setSource] = useState('partner')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [overrides, setOverrides] = useState<Partial<Record<CanonicalKey, string | null>>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')
  const keys = useKeys()

  const built = useMemo(() => {
    let sample: Record<string, Json> = {}
    if (jsonText.trim()) {
      try {
        const parsed = JSON.parse(jsonText)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return { error: 'The JSON must be an object: { … }' }
        sample = parsed
      } catch {
        return { error: 'The JSON is not valid yet.' }
      }
    }
    for (const r of rows) if (r.path.trim()) setPath(sample, r.path.trim(), typed(r.example))
    const fromRows: Partial<Record<CanonicalKey, string>> = {}
    for (const r of rows) if (r.path.trim() && r.means) fromRows[r.means] = r.path.trim()
    return { sample, fromRows }
  }, [rows, jsonText])

  useEffect(() => {
    if ('error' in built) {
      setErr(built.error!)
      return
    }
    setErr('')
    if (!Object.keys(built.sample).length) return setPreview(null)
    const t = setTimeout(async () => {
      try {
        setPreview(
          (await api<{ preview: Preview }>('/api/schemas', { body: { op: 'preview', sample: built.sample, source } }))
            .preview
        )
      } catch (e) {
        setErr((e as Error).message)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [built, source])

  const finalMapping: Mapping = useMemo(() => {
    const m: Mapping = { ...(preview?.mapping ?? {}) }
    const fromRows = 'fromRows' in built ? built.fromRows : {}
    for (const [k, v] of Object.entries({ ...fromRows, ...overrides }) as [CanonicalKey, string | null][]) {
      if (v) m[k] = v
      else delete m[k]
    }
    return m
  }, [preview, overrides, built])

  const register = async () => {
    if (!('sample' in built)) return
    try {
      const fromRows = built.fromRows ?? {}
      const r = await api<{ schema: SchemaRecord }>('/api/schemas', {
        body: { op: 'register', sample: built.sample, source, mapping: { ...fromRows, ...overrides } },
      })
      onRegistered(r.schema.fingerprint)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const updateRow = (i: number, patch: Partial<FieldRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <div className="space-y-6 rounded-xl border border-zinc-950/10 p-5 dark:border-white/10">
      <div>
        <Subheading>Add a schema</Subheading>
        <Text>
          Describe fields one by one, paste an example JSON, or both: rows are merged into the JSON (dots mean nesting). Nothing is stored until you register.
        </Text>
      </div>

      <div className="space-y-6">
        <div className="max-w-3xl space-y-3">
          <div className="grid grid-cols-[1fr_1fr_11rem_auto] gap-2 text-xs font-medium text-zinc-500">
            <span>Field path</span>
            <span>Example value</span>
            <span>Maps to (optional)</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_11rem_auto] items-center gap-2">
              <Input
                value={r.path}
                onChange={(e) => updateRow(i, { path: e.target.value })}
                placeholder={i === 0 ? 'evt_kind' : i === 1 ? 'lvl' : 'details.reason'}
              />
              <Input
                value={r.example}
                onChange={(e) => updateRow(i, { example: e.target.value })}
                placeholder={i === 0 ? 'PAYMENT_STUCK' : i === 1 ? 'P1' : 'ACK_TIMEOUT'}
              />
              <Select value={r.means} onChange={(e) => updateRow(i, { means: e.target.value as CanonicalKey | '' })}>
                <option value="">auto</option>
                {keys.all.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
              <Button plain aria-label="Remove field" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button plain onClick={() => setRows((rs) => [...rs, { path: '', example: '', means: '' }])}>
            + Add field
          </Button>

          <div className="pt-2">
            {showJson ? (
              <>
                <div className="mb-1 text-xs font-medium text-zinc-500">
                  Example JSON (optional, merged with the rows)
                </div>
                <Textarea
                  rows={7}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  className="font-mono text-xs"
                  placeholder='{"evt_kind": "PAYMENT_STUCK", "lvl": "P1", "details": {"failure_reason": "ACK_TIMEOUT"}}'
                />
              </>
            ) : (
              <Button plain onClick={() => setShowJson(true)}>
                I have an example message (JSON)…
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-500">Source</span>
            <Input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="max-w-40"
              aria-label="Source name"
            />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>

        <div className="border-t border-zinc-950/5 pt-5 dark:border-white/5">
          {preview ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{preview.name}</span>
                <Badge color={STATUS[preview.status].color}>
                  {STATUS[preview.status].label}
                </Badge>
              </div>
              <Text className="mt-1">
                Proposed mapping. Change anything before registering.
              </Text>
              <div className="mt-3">
                <Proposals
                  proposals={preview.proposals.filter(
                    (p) => !(p.canonical in finalMapping) && !dismissed.has(`${p.canonical}:${p.path}`)
                  )}
                  sample={'sample' in built ? (built.sample as Json) : {}}
                  onDecide={(p, accept) =>
                    accept
                      ? setOverrides((o) => ({ ...o, [p.canonical]: p.path }))
                      : setDismissed((d) => new Set(d).add(`${p.canonical}:${p.path}`))
                  }
                />
              </div>
              <MappingEditor
                fields={preview.fields}
                sample={'sample' in built ? (built.sample as Json) : {}}
                mapping={finalMapping}
                mappedBy={preview.mappedBy}
                confidence={preview.confidence}
                canonical={canonical}
                onChange={(k, p) => setOverrides((o) => ({ ...o, [k]: p }))}
              />
              <Button color="dark/zinc" className="mt-3" onClick={register}>
                Register schema
              </Button>
            </>
          ) : (
            <Text>
              The proposed mapping appears here as you type.
            </Text>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- custom fields

const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'text (eq, in, contains)',
  number: 'number (>, <, ≥, ≤)',
  id: 'id (eq, in; good for grouping)',
}

function keyFromPath(path: string) {
  return (path.split('.').pop() ?? path)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[^a-z]+|_$/g, '')
}

function guessType(f: FieldInfo | undefined): CustomFieldType {
  if (!f) return 'text'
  if (/(id|ref|key|number)$/i.test(f.path.split('.').pop() ?? '') || f.format === 'uuid' || f.format === 'id') return 'id'
  if (f.type === 'number' || f.format === 'number') return 'number'
  return 'text'
}

function NewFieldForm({
  schema,
  initialPath,
  onDone,
  onCancel,
}: {
  schema: SchemaRecord
  initialPath: string
  onDone: () => void
  onCancel: () => void
}) {
  const keys = useKeys()
  const [path, setPath] = useState(initialPath)
  const field = schema.fields.find((f) => f.path === path)
  const [key, setKey] = useState(keyFromPath(initialPath))
  const [type, setType] = useState<CustomFieldType>(guessType(field))
  const [description, setDescription] = useState('')
  const [synonyms, setSynonyms] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ mapped: number; proposed: number } | null>(null)

  const pickPath = (p: string) => {
    setPath(p)
    setKey(keyFromPath(p))
    setType(guessType(schema.fields.find((f) => f.path === p)))
  }
  const exists = keys.all.includes(key)
  const pathWord = (path.split('.').pop() ?? '').toLowerCase()

  const save = async () => {
    setBusy(true)
    setErr('')
    try {
      const syn = synonyms.split(',').map((x) => x.trim()).filter(Boolean)
      if (pathWord && pathWord.replace(/[^a-z0-9]/g, '') !== key.replace(/[^a-z0-9]/g, '')) syn.push(pathWord)
      const r = await api<{ backfill: { mapped: number; proposed: number } }>('/api/fields', {
        body: {
          field: { key, type, description: description || undefined, synonyms: syn },
          map: path ? { fingerprint: schema.fingerprint, path } : undefined,
        },
      })
      setResult(r.backfill)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (result)
    return (
      <div className="mt-3 rounded-lg border border-green-300 bg-green-50/50 p-4 dark:border-green-500/30 dark:bg-green-500/5">
        <p>
          <strong>{key}</strong> added and mapped to {path || '—'}.{' '}
          {result.mapped + result.proposed === 0
            ? 'Not found in other stored schemas; every new schema is checked for it automatically.'
            : `Also found in ${result.mapped + result.proposed} other schema${result.mapped + result.proposed > 1 ? 's' : ''}: ${result.mapped} mapped automatically, ${result.proposed} waiting for review.`}
        </p>
        <p className="mt-1 text-sm text-zinc-500">
          Use it in rules as <code>{key}</code> and in templates as <code>{`{{${key}}}`}</code>.
        </p>
        <Button className="mt-3" outline onClick={onDone}>
          Close
        </Button>
      </div>
    )

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-zinc-950/10 p-4 dark:border-white/10">
      <Subheading>New field</Subheading>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium text-zinc-500">Comes from</span>
          <Select value={path} onChange={(e) => pickPath(e.target.value)}>
            <option value="">— define only, map later —</option>
            {schema.fields
              .filter((f) => f.type !== 'array' && f.type !== 'null')
              .map((f) => {
                const v = show(getPath(schema.sample, f.path))
                return (
                  <option key={f.path} value={f.path}>
                    {f.path}
                    {v ? ` — e.g. ${v}` : ''}
                  </option>
                )
              })}
          </Select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-zinc-500">Field key</span>
          <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} className="font-mono" placeholder="amount" />
          {exists && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {keys.isCustom(key) ? 'Exists already: saving updates it.' : 'This is a built-in field; map it above instead.'}
            </span>
          )}
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-zinc-500">Value type</span>
          <Select value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
            {(Object.keys(TYPE_LABEL) as CustomFieldType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-zinc-500">Description</span>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="transaction amount in the original currency"
          />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-zinc-500">
            Synonyms (comma separated, used to find it in other sources)
          </span>
          <Input value={synonyms} onChange={(e) => setSynonyms(e.target.value)} placeholder="notional, value, amt, sum" />
        </label>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2">
        <Button color="dark/zinc" disabled={busy || !key || (exists && !keys.isCustom(key))} onClick={save}>
          Add field
        </Button>
        <Button plain onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function CustomFields({ onChanged }: { onChanged: () => void }) {
  const keys = useKeys()
  const [err, setErr] = useState('')
  if (!keys.custom.length) return null
  const remove = async (key: string) => {
    if (!confirm(`Remove the field "${key}"? Its mapping is removed from every schema.`)) return
    setErr('')
    try {
      await api(`/api/fields?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <section className="mt-8">
      <Subheading>Custom fields</Subheading>
      <ul className="mt-2 space-y-1">
        {keys.custom.map((f) => (
          <li key={f.key} className="flex items-start justify-between gap-2 rounded-lg px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
            <div className="min-w-0">
              <div className="font-mono font-medium">{f.key}</div>
              <div className="truncate text-xs text-zinc-500">
                {`${f.type} · ${f.synonyms.join(', ')}`}
              </div>
            </div>
            <Button plain aria-label={`Remove ${f.key}`} onClick={() => remove(f.key)}>
              ✕
            </Button>
          </li>
        ))}
      </ul>
      {err && <p className="mt-1 text-sm text-red-600">{err}</p>}
    </section>
  )
}

// ---------------------------------------------------------------- stored schema

function SchemaDetail({
  schema,
  data,
  reload,
}: {
  schema: SchemaRecord
  data: Data
  reload: () => void
}) {
  const [name, setName] = useState(schema.name)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => setName(schema.name), [schema.fingerprint, schema.name])

  const op = async (body: Record<string, unknown>, key = String(body.op)) => {
    setBusy(key)
    setErr('')
    try {
      await api(`/api/schemas/${schema.fingerprint}`, { body })
      reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const keys = useKeys()
  const [newFieldFrom, setNewFieldFrom] = useState<string | null>(null)
  const pending = schema.proposals.filter((p) => p.state === 'pending')
  const mapped = keys.all.filter((k) => schema.mapping[k]).length
  const mappedPaths = new Set(Object.values(schema.mapping))

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" aria-label="Schema name" />
        <Badge color={STATUS[schema.status].color}>{STATUS[schema.status].label}</Badge>
        <span className="text-sm text-zinc-500">
          source {schema.source} ·{' '}
          {schema.eventCount.toLocaleString()} messages · last {schema.lastSeen ? timeAgo(schema.lastSeen) : 'never'}
        </span>
      </div>

      <div className="rounded-lg bg-zinc-50 p-4 text-sm dark:bg-zinc-800/50">
        <strong>How this works:</strong> the first time a new kind of event arrives, CTRL guesses which of its fields is
        the title, the severity, the service and so on, from field names and values (no AI). Sure guesses are used right
        away; unsure ones wait here for a person to accept. Rules can also use any field by its original name.
      </div>

      <Proposals
        proposals={pending}
        sample={schema.sample}
        onDecide={(p, accept) =>
          op({ op: accept ? 'accept' : 'reject', canonical: p.canonical, path: p.path }, `${p.canonical}`)
        }
      />

      <section>
        <Subheading>
          Field mapping ({mapped}/{keys.all.length})
        </Subheading>
        <MappingEditor
          fields={schema.fields}
          sample={schema.sample}
          mapping={schema.mapping}
          mappedBy={schema.mappedBy}
          confidence={schema.confidence}
          canonical={data.canonical}
          onChange={(k, p) => op({ op: 'map', canonical: k, path: p }, `m-${k}`)}
        />
        {newFieldFrom === null ? (
          <div className="mt-3">
            <Button plain onClick={() => setNewFieldFrom(schema.fields.find((f) => !mappedPaths.has(f.path))?.path ?? '')}>
              + New field
            </Button>
            <span className="ml-2 text-sm text-zinc-500">
              Add your own field (amount, region, customer…) so rules work on it across all sources.
            </span>
          </div>
        ) : (
          <NewFieldForm
            schema={schema}
            initialPath={newFieldFrom}
            onDone={() => {
              setNewFieldFrom(null)
              reload()
            }}
            onCancel={() => setNewFieldFrom(null)}
          />
        )}
      </section>

      <div className="flex flex-wrap gap-2">
        <Button color="dark/zinc" disabled={busy !== ''} onClick={() => op({ op: 'approve', name })}>
          {schema.status === 'approved' ? 'Save name' : 'Approve schema'}
        </Button>
        <Button outline href="/rules">
          Create a rule for it →
        </Button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}


      <details>
        <summary className="cursor-pointer text-sm font-semibold">Example message (raw JSON)</summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
          {JSON.stringify(schema.sample, null, 2)}
        </pre>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------- page

export default function SchemasPage() {
  return (
    <Suspense fallback={<Text>Loading…</Text>}>
      <Schemas />
    </Suspense>
  )
}

function Schemas() {
  const params = useSearchParams()
  const [data, setData] = useState<Data | null>(null)
  const [selected, setSelected] = useState<string | null>(params.get('fp'))
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const d = await api<Data>('/api/schemas')
    setData(d)
    setSelected(
      (s) => s ?? d.schemas.find((x) => x.status === 'needs-review')?.fingerprint ?? d.schemas[0]?.fingerprint ?? null
    )
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useLive({ onChanged: (k) => k.includes('schema') && void load() })

  if (!data) return <Text>Loading…</Text>
  return (
    <KeysContext.Provider value={makeKeys(data.fields ?? [])}>
      <SchemasBody data={data} selected={selected} setSelected={setSelected} adding={adding} setAdding={setAdding} load={load} />
    </KeysContext.Provider>
  )
}

function SchemasBody({
  data,
  selected,
  setSelected,
  adding,
  setAdding,
  load,
}: {
  data: Data
  selected: string | null
  setSelected: (fp: string) => void
  adding: boolean
  setAdding: (v: boolean) => void
  load: () => Promise<void>
}) {
  const keys = useKeys()
  const schema = data.schemas.find((s) => s.fingerprint === selected)
  const review = data.schemas.filter((s) => s.status === 'needs-review').length

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>Sources & schemas</Heading>
          <Text>
            {'Every new kind of event is recognised automatically, whichever way it arrives. Nothing is rejected: until a schema is mapped, its events go to the Unassigned inbox so a person can look at them.'}
          </Text>
        </div>
        <Button color="dark/zinc" onClick={() => setAdding(!adding)}>
          {adding ? 'Close' : 'Add schema'}
        </Button>
      </div>

      {adding && (
        <div className="mt-6">
          <NewSchema
            canonical={data.canonical}
            onRegistered={(fp) => {
              setAdding(false)
              setSelected(fp)
              void load()
            }}
          />
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[18rem_1fr]">
        <div>
          {review > 0 && (
            <p className="mb-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              {review} need{review === 1 ? 's' : ''} review
            </p>
          )}
          <ul className="space-y-1">
            {data.schemas.map((s, _, all) => (
              <li key={s.fingerprint}>
                <button
                  onClick={() => setSelected(s.fingerprint)}
                  className={`w-full rounded-lg px-3 py-2 text-left ${s.fingerprint === selected ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    {/* Two shapes can share a name (same event type, different fields): tell them apart. */}
                    {all.some((o) => o.name === s.name && o.fingerprint !== s.fingerprint) && (
                      <span className="shrink-0 font-mono text-xs text-zinc-500">{s.fingerprint.slice(0, 6)}</span>
                    )}
                    {s.status === 'needs-review' && <span className="size-2 shrink-0 rounded-full bg-amber-500" />}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {s.source} · {s.eventCount.toLocaleString()} event{s.eventCount === 1 ? '' : 's'} ·{' '}
                    {keys.all.filter((k) => s.mapping[k]).length}/{keys.all.length} mapped
                  </div>
                </button>
              </li>
            ))}
            {data.schemas.length === 0 && <Text>No messages yet.</Text>}
          </ul>
          <CustomFields onChanged={load} />
        </div>
        <div>
          {schema ? (
            <SchemaDetail schema={schema} data={data} reload={load} />
          ) : (
            <Text>Select a schema.</Text>
          )}
        </div>
      </div>
    </>
  )
}
