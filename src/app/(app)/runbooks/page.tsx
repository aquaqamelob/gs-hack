'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Heading, Subheading } from '@/components/heading'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { Textarea } from '@/components/textarea'
import { api, useLive, useMe } from '@/lib/client'
import type { Runbook, StepDef } from '@/lib/engine/types'
import { useCallback, useEffect, useState } from 'react'
import { ProposalList, useProposals } from '../proposals'

type RunbookRow = Runbook
type Data = {
  runbooks: RunbookRow[]
  actions: { name: string; description: string; method: string; url: string; approval: string }[]
  usedBy: Record<string, string[]>
}

function Steps({ steps }: { steps: StepDef[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => (
        <li key={s.id} className="flex gap-3 rounded-lg border border-zinc-950/10 p-3 text-sm dark:border-white/10">
          <span className="font-semibold text-zinc-400">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {s.when && <Badge color="sky">if {s.when}</Badge>}
              <span>{s.text}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
              {s.action ? (
                <code className="rounded bg-zinc-100 px-1 break-all dark:bg-zinc-800">
                  webhook: {s.action}
                  {s.params && Object.keys(s.params).length ? ` ${JSON.stringify(s.params)}` : ''}
                </code>
              ) : (
                <span>done by a person</span>
              )}
              {s.approval === 'required' && <Badge color="purple">approval required</Badge>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function NewRunbook({ onSaved }: { onSaved: () => void }) {
  const [id, setId] = useState('')
  const [format, setFormat] = useState('auto')
  const [content, setContent] = useState('')
  const [preview, setPreview] = useState<{ format: string; runbook: Runbook } | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!content.trim()) return setPreview(null)
    const t = setTimeout(async () => {
      try {
        setPreview(await api('/api/runbooks', { body: { id: id || 'new-runbook', content, format, preview: true } }))
        setErr('')
      } catch (e) {
        setErr((e as Error).message)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [content, format, id])

  return (
    <div className="grid gap-6 rounded-xl border border-zinc-950/10 p-6 lg:grid-cols-2 dark:border-white/10">
      <div className="space-y-3">
        <Subheading>Add a runbook</Subheading>
        <Text>
          Paste it as you have it. YAML: structured steps with actions. Markdown list: one step per item, approval
          wording is detected. Free text or a wiki dump: one readable step shown as written.
        </Text>
        <div className="flex gap-2">
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="id, e.g. swift-ack-timeout" />
          <Select value={format} onChange={(e) => setFormat(e.target.value)} className="w-40">
            <option value="auto">auto-detect</option>
            <option value="yaml">YAML</option>
            <option value="markdown">Markdown</option>
            <option value="text">Free text / wiki</option>
          </Select>
        </div>
        <Textarea
          rows={12}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="font-mono text-xs"
          placeholder="# My runbook&#10;1. Check …&#10;2. Restart … (needs approval)"
        />
        <Button
          color="dark/zinc"
          disabled={!id || !content.trim()}
          onClick={async () => {
            try {
              await api('/api/runbooks', { body: { id, content, format } })
              setId('')
              setContent('')
              onSaved()
            } catch (e) {
              setErr((e as Error).message)
            }
          }}
        >
          Save runbook
        </Button>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
      <div>
        <Subheading>Preview {preview && <Badge color="zinc">{preview.format}</Badge>}</Subheading>
        <div className="mt-3">
          {preview ? <Steps steps={preview.runbook.steps} /> : <Text>Steps appear here as you type.</Text>}
        </div>
      </div>
    </div>
  )
}

export default function RunbooksPage() {
  const [data, setData] = useState<Data | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const proposals = useProposals()
  const { isAdmin } = useMe()

  const load = useCallback(async () => {
    const d = await api<Data>('/api/runbooks')
    setData(d)
    setSelected((s) => (s && d.runbooks.some((r) => r.id === s) ? s : (d.runbooks[0]?.id ?? null)))
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useLive({ onChanged: (k) => (k.includes('config:runbooks') || k.includes('config:all')) && void load() })

  if (!data) return <Text>Loading…</Text>
  const rb = data.runbooks.find((r) => r.id === selected)

  const op = async (o: string) => {
    if (!rb) return
    setBusy(o)
    setErr('')
    try {
      await api(`/api/runbooks/${rb.id}`, { body: { op: o } })
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>Runbooks</Heading>
          <Text>
            Stored in Postgres (seeded from <code>config/runbooks/</code> on first boot); a save reaches every instance.
            Every format becomes the same list of steps. Steps that need approval wait for a person (button, or SMS
            reply “YES 123456”).
          </Text>
        </div>
        <Button color="dark/zinc" onClick={() => setAdding(!adding)}>
          {adding ? 'Close' : 'Add runbook'}
        </Button>
      </div>

      {adding && (
        <div className="mt-6">
          <NewRunbook
            onSaved={() => {
              setAdding(false)
              void load()
            }}
          />
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[16rem_1fr]">
        <ul className="space-y-1">
          {data.runbooks.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => setSelected(r.id)}
                className={`w-full rounded-lg px-3 py-2 text-left ${r.id === selected ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'}`}
              >
                <div className="truncate font-medium">{r.title}</div>
                <div className="text-xs text-zinc-500">
                  {r.file} · {r.steps.length} steps
                  {proposals.items.some((p) => p.target === `runbook:${r.id}`) && (
                    <span className="ml-1 text-sky-600">· suggestions</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>

        {rb && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <Subheading>{rb.title}</Subheading>
              <Badge color="zinc">{rb.format}</Badge>
              <Badge color={rb.parsedBy === 'parser' ? 'green' : 'amber'}>
                {rb.parsedBy === 'parser' ? 'structured' : 'single text step'}
              </Badge>
              {data.usedBy[rb.id]?.length ? (
                <span className="text-sm text-zinc-500">used by {data.usedBy[rb.id].join(', ')}</span>
              ) : null}
            </div>
            <ProposalList
              items={proposals.items}
              target={`runbook:${rb.id}`}
              isAdmin={isAdmin}
              onDone={() => {
                proposals.reload()
                void load()
              }}
            />
            {rb.matches && (
              <Text>
                Auto-attaches to alerts where{' '}
                {Object.entries(rb.matches)
                  .map(([k, v]) => `${k} = ${v}`)
                  .join(' and ')}
              </Text>
            )}

            <div className="grid gap-6 xl:grid-cols-2">
              <div>
                <div className="mb-2 text-sm font-semibold">As written</div>
                <pre className="max-h-[28rem] overflow-auto rounded-lg bg-zinc-50 p-3 text-xs whitespace-pre-wrap dark:bg-zinc-800/50">
                  {rb.content}
                </pre>
              </div>
              <div>
                <div className="mb-2 text-sm font-semibold">Steps the service will show</div>
                <Steps steps={rb.steps} />
              </div>
            </div>

            {err && <p className="text-sm text-red-600">{err}</p>}
            <Button plain onClick={() => confirm(`Delete ${rb.file}?`) && op('delete')}>
              Delete runbook
            </Button>
          </div>
        )}
      </div>

      <section className="mt-12">
        <Subheading>Named actions</Subheading>
        <Text>
          There is one action kind: a webhook. Names below come from <code>config/actions.yaml</code>; a new action is a
          new entry there, not code. Targets must be in <code>ACTION_ALLOWED_HOSTS</code>; secrets come from env vars.
        </Text>
        <ul className="mt-3 space-y-1 text-sm">
          {data.actions.map((a) => (
            <li key={a.name} className="flex flex-wrap items-center gap-2">
              <code className="font-semibold">{a.name}</code>
              <code className="text-xs text-zinc-500">
                {a.method} {a.url}
              </code>
              {a.approval === 'required' && <Badge color="purple">needs approval</Badge>}
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
