'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Heading, Subheading } from '@/components/heading'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { api, timeAgo, useLive } from '@/lib/client'
import { Textarea } from '@/components/textarea'
import type { CanonicalKey, MappedBy, MappingProposal, SchemaRecord } from '@/lib/engine/types'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState } from 'react'

type Data = {
  schemas: SchemaRecord[]
  canonical: Record<CanonicalKey, string>
  llm: { enabled: boolean; model: string }
}

const BY_BADGE: Record<MappedBy, { color: 'zinc' | 'violet' | 'green' | 'sky' | 'amber'; label: string }> = {
  'known-format': { color: 'sky', label: 'known format' },
  deterministic: { color: 'zinc', label: 'rules' },
  fuzzy: { color: 'amber', label: 'fuzzy' },
  llm: { color: 'violet', label: 'AI' },
  human: { color: 'green', label: 'human' },
}

const STATUS_BADGE = { approved: 'green', mapped: 'zinc', 'needs-review': 'amber' } as const

type Preview = {
  fingerprint: string
  name: string
  status: SchemaRecord['status']
  mapping: SchemaRecord['mapping']
  mappedBy: SchemaRecord['mappedBy']
  proposals: MappingProposal[]
}

function PasteSample({ onRegistered }: { onRegistered: (fp: string) => void }) {
  const [text, setText] = useState('')
  const [source, setSource] = useState('partner')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [err, setErr] = useState('')
  const run = async (op: 'preview' | 'register') => {
    setErr('')
    try {
      const sample = JSON.parse(text)
      if (op === 'preview') setPreview((await api<{ preview: Preview }>('/api/schemas', { body: { op, sample, source } })).preview)
      else onRegistered((await api<{ schema: SchemaRecord }>('/api/schemas', { body: { op, sample, source } })).schema.fingerprint)
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <div className="mt-6 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <Subheading>Map a new schema</Subheading>
      <Text>Paste one sample event. You see what the deterministic and fuzzy layers would map before anything is stored.</Text>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" placeholder='{"evt_kind": "PAYMENT_STUCK", ...}' />
          <div className="flex items-center gap-2">
            <Input value={source} onChange={(e) => setSource(e.target.value)} className="max-w-40" aria-label="Source name" />
            <Button outline disabled={!text.trim()} onClick={() => run('preview')}>
              Propose mapping
            </Button>
            <Button color="dark/zinc" disabled={!preview} onClick={() => run('register')}>
              Register for review
            </Button>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        {preview && (
          <div className="text-sm">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{preview.name}</span>
              <Badge color={STATUS_BADGE[preview.status]}>{preview.status}</Badge>
            </div>
            <ul className="mt-2 space-y-1">
              {(Object.keys(preview.mapping) as CanonicalKey[]).map((k) => (
                <li key={k}>
                  <span className="font-medium">{k}</span> ← <code>{preview.mapping[k]}</code>{' '}
                  <Badge color={BY_BADGE[preview.mappedBy[k]!].color}>{BY_BADGE[preview.mappedBy[k]!].label}</Badge>
                </li>
              ))}
              {preview.proposals.map((p) => (
                <li key={p.canonical} className="text-amber-700 dark:text-amber-400">
                  {p.canonical} ← <code>{p.path}</code>? ({p.by}, {Math.round(p.confidence * 100)}%) — needs ✓
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

function SchemaDetail({ schema, data, reload }: { schema: SchemaRecord; data: Data; reload: () => void }) {
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
  const keys = Object.keys(data.canonical) as CanonicalKey[]
  const mappedCount = keys.filter((k) => schema.mapping[k]).length

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" aria-label="Schema name" />
        <Badge color={STATUS_BADGE[schema.status]}>{schema.status}</Badge>
        <span className="text-sm text-zinc-500">
          source {schema.source} · {schema.eventCount.toLocaleString()} events · last{' '}
          {schema.lastSeen ? timeAgo(schema.lastSeen) : 'never'}
        </span>
      </div>

      <div className="rounded-lg bg-zinc-50 p-4 text-sm dark:bg-zinc-800/50">
        <strong>How this works:</strong> computed once per schema and stored. 1) Deterministic: names, synonyms, value formats,
        known formats like Alertmanager. 2) Fuzzy tiebreak: similar names, only when the distinguishing word matches
        (error_count never becomes error.code). 3) Optional AI: sees only leftover field <em>names, types and formats</em>,
        never values. Everything uncertain waits for a human ✓. Raw paths always work in rules.
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge color={data.llm.enabled ? 'violet' : 'zinc'}>{data.llm.enabled ? `AI: ${data.llm.model}` : 'AI off (LLM_ENABLED=false)'}</Badge>
          {schema.llm.state !== 'idle' && (
            <span className="text-zinc-500">
              AI {schema.llm.state}
              {schema.llm.detail ? ` — ${schema.llm.detail}` : ''}
            </span>
          )}
          <Button outline disabled={busy !== '' || !data.llm.enabled} onClick={() => op({ op: 'ask-ai' })}>
            {busy === 'ask-ai' ? 'Asking AI…' : 'Ask AI for missing fields'}
          </Button>
        </div>
      </div>

      {pending.length > 0 && (
        <section>
          <Subheading>Waiting for your review ({pending.length})</Subheading>
          <ul className="mt-3 space-y-2">
            {pending.map((p) => (
              <li
                key={`${p.canonical}-${p.path}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50/50 p-3 dark:border-amber-500/30 dark:bg-amber-500/5"
              >
                <code className="font-semibold">{p.path}</code>
                <span>→</span>
                <span className="font-semibold">{p.canonical}</span>
                <Badge color={p.by === 'llm' ? 'violet' : 'amber'}>
                  {p.by === 'llm' ? 'AI' : 'fuzzy'} · {Math.round(p.confidence * 100)}%
                </Badge>
                <span className="flex-1 text-sm text-zinc-500">{p.reason}</span>
                <Button
                  color="green"
                  disabled={busy !== ''}
                  onClick={() => op({ op: 'accept', canonical: p.canonical, path: p.path }, `a-${p.canonical}`)}
                >
                  ✓ Accept
                </Button>
                <Button
                  outline
                  disabled={busy !== ''}
                  onClick={() => op({ op: 'reject', canonical: p.canonical, path: p.path }, `r-${p.canonical}`)}
                >
                  ✗ Reject
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <Subheading>
          Field mapping ({mappedCount}/{keys.length})
        </Subheading>
        <div className="mt-3 divide-y divide-zinc-950/5 dark:divide-white/5">
          {keys.map((k) => {
            const by = schema.mappedBy[k]
            return (
              <div key={k} className="grid grid-cols-[10rem_1fr_auto] items-center gap-3 py-2">
                <div>
                  <div className="font-medium">{k}</div>
                  <div className="text-xs text-zinc-500">{data.canonical[k]}</div>
                </div>
                <Select
                  value={schema.mapping[k] ?? ''}
                  onChange={(e) => op({ op: 'map', canonical: k, path: e.target.value || null }, `m-${k}`)}
                >
                  <option value="">— not mapped —</option>
                  {schema.fields.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path} ({f.format})
                    </option>
                  ))}
                </Select>
                <div className="w-28 text-right">
                  {by && (
                    <Badge color={BY_BADGE[by].color}>
                      {BY_BADGE[by].label}
                      {schema.confidence[k] !== undefined && schema.confidence[k]! < 1
                        ? ` ${Math.round(schema.confidence[k]! * 100)}%`
                        : ''}
                    </Badge>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button color="dark/zinc" disabled={busy !== ''} onClick={() => op({ op: 'approve', name })}>
          {schema.status === 'approved' ? 'Save name & mapping' : 'Approve schema'}
        </Button>
        <Button outline href="/rules">
          Create a rule for it →
        </Button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}

      <section>
        <Subheading>Sample event</Subheading>
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
          {JSON.stringify(schema.sample, null, 2)}
        </pre>
      </section>
    </div>
  )
}

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

  return (
    <>
      <Heading>Sources & schemas</Heading>
      <Text>
        Every new event shape is detected automatically from Redpanda topics and <code>POST /ingest/&lt;source&gt;</code> (JSON,
        Alertmanager webhooks, or text/plain log lines). Unknown schemas are never rejected: until mapped, their events land in the
        Unassigned inbox.
      </Text>

      <PasteSample
        onRegistered={(fp) => {
          setSelected(fp)
          void load()
        }}
      />

      <div className="mt-8 grid gap-8 lg:grid-cols-[18rem_1fr]">
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
                  {s.source} · {s.eventCount.toLocaleString()} events · {Object.keys(s.mapping).length} mapped
                </div>
              </button>
            </li>
          ))}
          {data.schemas.length === 0 && <Text>No events yet.</Text>}
        </ul>
        <div>{schema ? <SchemaDetail schema={schema} data={data} reload={load} /> : <Text>Select a schema.</Text>}</div>
      </div>
    </>
  )
}
