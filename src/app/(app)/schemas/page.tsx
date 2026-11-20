'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Heading, Subheading } from '@/components/heading'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { Textarea } from '@/components/textarea'
import { api, timeAgo, useLevel, useLive, type Level } from '@/lib/client'
import type { CanonicalKey, FieldInfo, Json, MappedBy, MappingProposal, SchemaRecord } from '@/lib/engine/types'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'

type Data = {
  schemas: SchemaRecord[]
  canonical: Record<CanonicalKey, string>
  llm: { enabled: boolean; model: string }
}

type Mapping = Partial<Record<CanonicalKey, string>>

const KEYS: CanonicalKey[] = ['title', 'severity', 'service', 'environment', 'error.message', 'error.code', 'entity_id', 'timestamp']

const QUESTION: Record<CanonicalKey, string> = {
  title: 'What kind of event is it?',
  severity: 'How serious is it?',
  service: 'Which system or app?',
  environment: 'Where did it happen (prod, test…)?',
  'error.message': 'What went wrong, in words?',
  'error.code': 'Error code',
  entity_id: 'Which item is affected (order, trade, payment…)?',
  timestamp: 'When did it happen?',
}

const BY_BADGE: Record<MappedBy, { color: 'zinc' | 'violet' | 'green' | 'sky' | 'amber'; label: string }> = {
  'known-format': { color: 'sky', label: 'known format' },
  deterministic: { color: 'zinc', label: 'rules' },
  fuzzy: { color: 'amber', label: 'fuzzy' },
  llm: { color: 'violet', label: 'AI' },
  human: { color: 'green', label: 'you' },
}

const STATUS = {
  approved: { color: 'green', simple: 'ready', label: 'approved' },
  mapped: { color: 'zinc', simple: 'works, not reviewed', label: 'mapped' },
  'needs-review': { color: 'amber', simple: 'needs your help', label: 'needs review' },
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
  level,
  description,
  onChange,
}: {
  k: CanonicalKey
  fields: FieldInfo[]
  sample: Json
  path?: string
  by?: MappedBy
  confidence?: number
  level: Level
  description: string
  onChange: (path: string | null) => void
}) {
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
        <div className="font-medium">{level === 'simple' ? QUESTION[k] : k}</div>
        {level !== 'simple' && <div className="text-xs text-zinc-500">{description}</div>}
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
            <option value="">{level === 'simple' ? '— not in these messages —' : '— not mapped —'}</option>
            {fields.map((f) => {
              const v = show(getPath(sample, f.path))
              return (
                <option key={f.path} value={f.path}>
                  {level === 'expert' ? `${f.path}  (${f.type}, ${f.format})` : f.path}
                  {v ? ` — e.g. ${v}` : ''}
                </option>
              )
            })}
            <option value={CUSTOM}>Type another field path…</option>
          </Select>
        )}
        {path && level !== 'expert' && (
          <div className="mt-1 truncate text-xs text-zinc-500">
            {value === undefined ? 'no value in the example' : <>example: <span className="font-medium text-zinc-700 dark:text-zinc-300">{show(value)}</span></>}
          </div>
        )}
      </div>
      <div className="text-right">
        {by &&
          (level === 'simple' ? (
            <span className="text-xs text-zinc-500">{by === 'human' ? '✓ set by you' : 'filled in automatically'}</span>
          ) : (
            <Badge color={BY_BADGE[by].color}>
              {BY_BADGE[by].label}
              {level === 'expert' && confidence !== undefined && confidence < 1 ? ` ${Math.round(confidence * 100)}%` : ''}
            </Badge>
          ))}
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
  level: Level
  onChange: (k: CanonicalKey, path: string | null) => void
}) {
  return (
    <div className="divide-y divide-zinc-950/5 dark:divide-white/5">
      {KEYS.map((k) => (
        <MappingRow
          key={k}
          k={k}
          fields={props.fields}
          sample={props.sample}
          path={props.mapping[k]}
          by={props.mappedBy?.[k]}
          confidence={props.confidence?.[k]}
          level={props.level}
          description={props.canonical[k]}
          onChange={(p) => props.onChange(k, p)}
        />
      ))}
    </div>
  )
}

function Proposals({
  proposals,
  level,
  sample,
  onDecide,
}: {
  proposals: MappingProposal[]
  level: Level
  sample: Json
  onDecide: (p: MappingProposal, accept: boolean) => void
}) {
  if (!proposals.length) return null
  return (
    <section>
      <Subheading>{level === 'simple' ? 'Please confirm' : `Waiting for your review (${proposals.length})`}</Subheading>
      <ul className="mt-3 space-y-2">
        {proposals.map((p) => (
          <li
            key={`${p.canonical}-${p.path}`}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50/50 p-3 dark:border-amber-500/30 dark:bg-amber-500/5"
          >
            <span className="flex-1">
              {level === 'simple' ? (
                <>
                  We think <strong>{p.path}</strong>
                  {show(getPath(sample, p.path)) && <> (e.g. “{show(getPath(sample, p.path))}”)</>} answers <strong>{QUESTION[p.canonical].toLowerCase()}</strong>
                </>
              ) : (
                <>
                  <code className="font-semibold">{p.path}</code> → <strong>{p.canonical}</strong>{' '}
                  <Badge color={p.by === 'llm' ? 'violet' : 'amber'}>
                    {p.by === 'llm' ? 'AI' : 'fuzzy'}
                    {level === 'expert' ? ` · ${Math.round(p.confidence * 100)}%` : ''}
                  </Badge>
                  {p.reason && <span className="ml-2 text-sm text-zinc-500">{p.reason}</span>}
                </>
              )}
            </span>
            <Button color="green" onClick={() => onDecide(p, true)}>
              {level === 'simple' ? 'Yes' : '✓ Accept'}
            </Button>
            <Button outline onClick={() => onDecide(p, false)}>
              {level === 'simple' ? 'No' : '✗ Reject'}
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

function NewSchema({ level, canonical, onRegistered }: { level: Level; canonical: Record<CanonicalKey, string>; onRegistered: (fp: string) => void }) {
  const [rows, setRows] = useState<FieldRow[]>([
    { path: '', example: '', means: '' },
    { path: '', example: '', means: '' },
    { path: '', example: '', means: '' },
  ])
  const [jsonText, setJsonText] = useState('')
  const [showJson, setShowJson] = useState(level === 'expert')
  const [source, setSource] = useState('partner')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [overrides, setOverrides] = useState<Partial<Record<CanonicalKey, string | null>>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')

  useEffect(() => setShowJson((s) => s || level === 'expert'), [level])

  const built = useMemo(() => {
    let sample: Record<string, Json> = {}
    if (jsonText.trim()) {
      try {
        const parsed = JSON.parse(jsonText)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'The JSON must be an object: { … }' }
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
        setPreview((await api<{ preview: Preview }>('/api/schemas', { body: { op: 'preview', sample: built.sample, source } })).preview)
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

  const updateRow = (i: number, patch: Partial<FieldRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <div className="space-y-6 rounded-xl border border-zinc-950/10 p-5 dark:border-white/10">
      <div>
        <Subheading>{level === 'simple' ? 'Tell CTRL about a new kind of message' : 'Add a schema'}</Subheading>
        <Text>
          {level === 'simple'
            ? 'List the fields the message has and an example value for each. If you have an example message, paste it too. You can mix both.'
            : 'Describe fields one by one, paste an example JSON, or both: rows are merged into the JSON (dots mean nesting). Nothing is stored until you register.'}
        </Text>
      </div>

      <div className="space-y-6">
        <div className="max-w-3xl space-y-3">
          <div className="grid grid-cols-[1fr_1fr_11rem_auto] gap-2 text-xs font-medium text-zinc-500">
            <span>{level === 'simple' ? 'Field name' : 'Field path'}</span>
            <span>Example value</span>
            <span>{level === 'simple' ? 'What it means' : 'Maps to (optional)'}</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_11rem_auto] items-center gap-2">
              <Input value={r.path} onChange={(e) => updateRow(i, { path: e.target.value })} placeholder={i === 0 ? 'evt_kind' : i === 1 ? 'lvl' : 'details.reason'} />
              <Input value={r.example} onChange={(e) => updateRow(i, { example: e.target.value })} placeholder={i === 0 ? 'PAYMENT_STUCK' : i === 1 ? 'P1' : 'ACK_TIMEOUT'} />
              <Select value={r.means} onChange={(e) => updateRow(i, { means: e.target.value as CanonicalKey | '' })}>
                <option value="">{level === 'simple' ? 'let CTRL guess' : 'auto'}</option>
                {KEYS.map((k) => (
                  <option key={k} value={k}>
                    {level === 'simple' ? QUESTION[k] : k}
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
                <div className="mb-1 text-xs font-medium text-zinc-500">{level === 'simple' ? 'Example message (optional)' : 'Example JSON (optional, merged with the rows)'}</div>
                <Textarea rows={7} value={jsonText} onChange={(e) => setJsonText(e.target.value)} className="font-mono text-xs" placeholder='{"evt_kind": "PAYMENT_STUCK", "lvl": "P1", "details": {"failure_reason": "ACK_TIMEOUT"}}' />
              </>
            ) : (
              <Button plain onClick={() => setShowJson(true)}>
                I have an example message (JSON)…
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-500">{level === 'simple' ? 'Sent by' : 'Source'}</span>
            <Input value={source} onChange={(e) => setSource(e.target.value)} className="max-w-40" aria-label="Source name" />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>

        <div className="border-t border-zinc-950/5 pt-5 dark:border-white/5">
          {preview ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{preview.name}</span>
                <Badge color={STATUS[preview.status].color}>{level === 'simple' ? STATUS[preview.status].simple : STATUS[preview.status].label}</Badge>
                {level === 'expert' && <code className="text-xs text-zinc-500">fp {preview.fingerprint.slice(0, 12)}</code>}
              </div>
              <Text className="mt-1">{level === 'simple' ? 'Check the answers below and change any that are wrong.' : 'Proposed mapping. Change anything before registering.'}</Text>
              <div className="mt-3">
                <Proposals
                  proposals={preview.proposals.filter((p) => !(p.canonical in finalMapping) && !dismissed.has(`${p.canonical}:${p.path}`))}
                  level={level}
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
                level={level}
                onChange={(k, p) => setOverrides((o) => ({ ...o, [k]: p }))}
              />
              <Button color="dark/zinc" className="mt-3" onClick={register}>
                {level === 'simple' ? 'Save this message type' : 'Register schema'}
              </Button>
            </>
          ) : (
            <Text>{level === 'simple' ? 'Start typing fields on the left; CTRL shows what it understands here.' : 'The proposed mapping appears here as you type.'}</Text>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- stored schema

function SchemaDetail({ schema, data, level, reload }: { schema: SchemaRecord; data: Data; level: Level; reload: () => void }) {
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

  const pending = schema.proposals.filter((p) => p.state === 'pending')
  const mapped = KEYS.filter((k) => schema.mapping[k]).length

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" aria-label="Schema name" />
        <Badge color={STATUS[schema.status].color}>{level === 'simple' ? STATUS[schema.status].simple : STATUS[schema.status].label}</Badge>
        <span className="text-sm text-zinc-500">
          {level === 'simple' ? `from ${schema.source}` : `source ${schema.source}`} · {schema.eventCount.toLocaleString()} messages · last{' '}
          {schema.lastSeen ? timeAgo(schema.lastSeen) : 'never'}
        </span>
        {level === 'expert' && <code className="text-xs text-zinc-500">fp {schema.fingerprint}</code>}
      </div>

      {level === 'simple' ? (
        <Text>
          Answer the questions below by picking the field that holds each piece of information. CTRL then uses them to route and
          describe alerts. Unknown fields are fine; you can leave answers empty.
        </Text>
      ) : (
        <div className="rounded-lg bg-zinc-50 p-4 text-sm dark:bg-zinc-800/50">
          <strong>How this works:</strong> computed once per schema and stored. 1) Deterministic: names, synonyms, value formats,
          known formats like Alertmanager. 2) Fuzzy tiebreak: similar names, only when the distinguishing word matches. 3)
          Optional AI: sees only leftover field names, types and formats, never values. Uncertain proposals wait for a human ✓.
          Raw paths always work in rules.
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge color={data.llm.enabled ? 'violet' : 'zinc'}>{data.llm.enabled ? `AI: ${data.llm.model}` : 'AI off'}</Badge>
            {schema.llm.state !== 'idle' && (
              <span className="text-zinc-500">
                AI {schema.llm.state}
                {schema.llm.detail ? ` — ${schema.llm.detail}` : ''}
              </span>
            )}
            {data.llm.enabled && (
              <Button outline disabled={busy !== ''} onClick={() => op({ op: 'ask-ai' })}>
                {busy === 'ask-ai' ? 'Asking AI…' : 'Ask AI for missing fields'}
              </Button>
            )}
          </div>
        </div>
      )}

      <Proposals
        proposals={pending}
        level={level}
        sample={schema.sample}
        onDecide={(p, accept) => op({ op: accept ? 'accept' : 'reject', canonical: p.canonical, path: p.path }, `${p.canonical}`)}
      />

      <section>
        <Subheading>
          {level === 'simple' ? 'What the message means' : 'Field mapping'} ({mapped}/{KEYS.length})
        </Subheading>
        <MappingEditor
          fields={schema.fields}
          sample={schema.sample}
          mapping={schema.mapping}
          mappedBy={schema.mappedBy}
          confidence={schema.confidence}
          canonical={data.canonical}
          level={level}
          onChange={(k, p) => op({ op: 'map', canonical: k, path: p }, `m-${k}`)}
        />
      </section>

      <div className="flex flex-wrap gap-2">
        <Button color="dark/zinc" disabled={busy !== ''} onClick={() => op({ op: 'approve', name })}>
          {schema.status === 'approved' ? 'Save name' : level === 'simple' ? 'Looks right — approve' : 'Approve schema'}
        </Button>
        <Button outline href="/rules">
          {level === 'simple' ? 'Decide who gets alerted →' : 'Create a rule for it →'}
        </Button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}

      {level === 'expert' && (
        <section>
          <Subheading>All fields</Subheading>
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1 font-normal">Path</th>
                <th className="font-normal">Type</th>
                <th className="font-normal">Format</th>
                <th className="font-normal">Example</th>
                <th className="font-normal">Mapped to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-950/5 dark:divide-white/5">
              {schema.fields.map((f) => (
                <tr key={f.path}>
                  <td className="py-1 font-mono text-xs">{f.path}</td>
                  <td>{f.type}</td>
                  <td>{f.format}</td>
                  <td className="max-w-48 truncate">{show(getPath(schema.sample, f.path))}</td>
                  <td>{KEYS.filter((k) => schema.mapping[k] === f.path).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {level !== 'simple' && (
        <details open={level === 'expert'}>
          <summary className="cursor-pointer text-sm font-semibold">Example message (raw JSON)</summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">{JSON.stringify(schema.sample, null, 2)}</pre>
        </details>
      )}
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
  const [level] = useLevel()
  const [data, setData] = useState<Data | null>(null)
  const [selected, setSelected] = useState<string | null>(params.get('fp'))
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const d = await api<Data>('/api/schemas')
    setData(d)
    setSelected((s) => s ?? d.schemas.find((x) => x.status === 'needs-review')?.fingerprint ?? d.schemas[0]?.fingerprint ?? null)
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useLive({ onChanged: (k) => k.includes('schema') && void load() })

  if (!data) return <Text>Loading…</Text>
  const schema = data.schemas.find((s) => s.fingerprint === selected)
  const review = data.schemas.filter((s) => s.status === 'needs-review').length

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>{level === 'simple' ? 'Message types' : 'Sources & schemas'}</Heading>
          <Text>
            {level === 'simple'
              ? 'Every kind of message CTRL has received. New kinds are picked up automatically; the ones marked “needs your help” wait for you to explain them.'
              : 'Every new event shape is detected automatically from Redpanda topics and POST /ingest/<source>. Unknown schemas are never rejected; until mapped, their events land in the Unassigned inbox.'}
          </Text>
        </div>
        <Button color="dark/zinc" onClick={() => setAdding(!adding)}>
          {adding ? 'Close' : level === 'simple' ? 'Add a message type' : 'Add schema'}
        </Button>
      </div>

      {adding && (
        <div className="mt-6">
          <NewSchema
            level={level}
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
          {review > 0 && <p className="mb-2 text-sm font-medium text-amber-700 dark:text-amber-400">{review} need{review === 1 ? 's' : ''} review</p>}
          <ul className="space-y-1">
            {data.schemas.map((s) => (
              <li key={s.fingerprint}>
                <button
                  onClick={() => setSelected(s.fingerprint)}
                  className={`w-full rounded-lg px-3 py-2 text-left ${s.fingerprint === selected ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    {s.status === 'needs-review' && <span className="size-2 shrink-0 rounded-full bg-amber-500" />}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {s.source} · {s.eventCount.toLocaleString()} {level === 'simple' ? 'messages' : 'events'} · {Object.keys(s.mapping).length}/{KEYS.length}{' '}
                    {level === 'simple' ? 'answered' : 'mapped'}
                  </div>
                </button>
              </li>
            ))}
            {data.schemas.length === 0 && <Text>No messages yet.</Text>}
          </ul>
        </div>
        <div>{schema ? <SchemaDetail schema={schema} data={data} level={level} reload={load} /> : <Text>Select a schema.</Text>}</div>
      </div>
    </>
  )
}
