'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Divider } from '@/components/divider'
import { Heading, Subheading } from '@/components/heading'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { Textarea } from '@/components/textarea'
import { COLOR_BAR, SEVERITY_BADGE, api, timeAgo, useLive, useMetrics, useNow, type AlertSummary } from '@/lib/client'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

const SCENARIOS = [
  { id: 'workflow', label: 'Settlement workflow failed', hint: 'broker · Appendix A #1' },
  { id: 'metric', label: 'payments-api error rate', hint: 'Alertmanager webhook · #2' },
  { id: 'trade', label: 'Rejected EUR 25M trade', hint: 'broker, other envelope · #3' },
  { id: 'pricing-log', label: 'Pricing WARN log lines', hint: 'log lines · grouped per instrument', count: 6 },
  { id: 'burst', label: 'Same error ×500', hint: 'dedup demo', count: 500 },
  { id: 'metric-resolved', label: 'payments-api recovered', hint: 'auto-close' },
  { id: 'unknown', label: 'Unseen schema', hint: 'goes to Unassigned' },
  { id: 'noise', label: '10,000 mixed events', hint: 'noise reduction', count: 10000 },
] as const

type DemoResult = { via?: string; sent?: number; accepted?: number; matchedRules?: string[]; unassigned?: number }

function describeResult(r: DemoResult) {
  const n = r.sent ?? r.accepted ?? 0
  const rules = r.matchedRules?.length ? `matched ${r.matchedRules.join(', ')}` : r.via?.startsWith('kafka') ? 'consumer will pick it up' : 'no rule matched'
  return `${n} event${n === 1 ? '' : 's'} via ${r.via ?? 'webhook'} → ${rules}${r.unassigned ? ` · ${r.unassigned} to Unassigned` : ''}`
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <Divider />
      <div className="mt-4 text-sm/6 font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl/8 font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs/5 text-zinc-500">{sub}</div>}
    </div>
  )
}

function Simulator() {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')

  const run = async (scenario: string, count?: number) => {
    setBusy(scenario)
    setMsg('')
    try {
      const r = await api<{ result: DemoResult }>('/api/demo', { body: { scenario, count } })
      setMsg(describeResult(r.result))
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const sendCustom = async () => {
    setBusy('custom')
    try {
      const body = JSON.parse(custom)
      const r = await api<DemoResult & { schemas: { name: string; status: string }[] }>('/api/ingest/webhook', { body })
      setMsg(`${describeResult({ ...r, via: 'webhook' })} · schema ${r.schemas.map((s) => `"${s.name}" (${s.status})`).join(', ')}`)
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Subheading>Simulate sources</Subheading>
          <Text>Sends the sample events from the brief through the real ingest path (Redpanda topic or webhook).</Text>
        </div>
        <Button plain onClick={() => setOpen(!open)}>
          {open ? 'Hide custom event' : 'Paste any JSON…'}
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <Button
            key={s.id}
            outline
            disabled={busy !== null}
            onClick={() => run(s.id, 'count' in s ? s.count : undefined)}
          >
            <span className="text-left">
              <span className="block">{busy === s.id ? 'Sending…' : s.label}</span>
              <span className="block text-xs font-normal text-zinc-500">{s.hint}</span>
            </span>
          </Button>
        ))}
      </div>
      {open && (
        <div className="mt-4 space-y-2">
          <Textarea
            rows={6}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder='{"anything": "any shape — e.g. the judges’ new schema"}'
            className="font-mono"
          />
          <div className="flex gap-2">
            <Button color="dark/zinc" disabled={!custom.trim() || busy !== null} onClick={sendCustom}>
              Send to POST /api/ingest/webhook
            </Button>
            <Button
              plain
              onClick={async () => {
                const r = await api<{ samples: Record<string, unknown> }>('/api/demo')
                setCustom(JSON.stringify(r.samples.unknown, null, 2))
              }}
            >
              Load an unseen schema
            </Button>
          </div>
        </div>
      )}
      {msg && <Text className="mt-3 font-medium">{msg}</Text>}
    </div>
  )
}

function AlertRow({
  a,
  now,
  onAction,
  flash,
}: {
  a: AlertSummary
  now: number
  onAction: (id: string, op: string) => void
  flash: boolean
}) {
  const nextStep = a.steps.find((s) => s.status !== 'done' && s.status !== 'skipped')
  const unassigned = a.team === 'unassigned'
  return (
    <li
      className={`relative flex gap-4 overflow-hidden rounded-xl border border-zinc-950/10 bg-white p-4 pl-6 transition dark:border-white/10 dark:bg-zinc-900 ${flash ? 'ring-2 ring-blue-500/60' : ''} ${a.status === 'resolved' ? 'opacity-60' : ''}`}
    >
      <span className={`absolute inset-y-0 left-0 w-1.5 ${COLOR_BAR[a.color] ?? 'bg-zinc-400'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={SEVERITY_BADGE[a.severity]}>{a.severity}</Badge>
          {a.count > 1 && <Badge color="zinc">×{a.count.toLocaleString()}</Badge>}
          {a.status !== 'open' && (
            <Badge color={a.status === 'acked' ? 'blue' : 'green'}>
              {a.status === 'acked' ? `acked by ${a.ackedBy}` : 'resolved'}
            </Badge>
          )}
          <span className="text-xs text-zinc-500">
            {a.team} · {a.ruleName} · {timeAgo(a.lastSeen, now)}
          </span>
        </div>
        <Link href={`/alerts/${a.id}`} className="mt-1 block text-base/6 font-semibold hover:underline">
          {a.title}
        </Link>
        {a.body && <p className="mt-0.5 line-clamp-2 text-sm/6 text-zinc-600 dark:text-zinc-400">{a.body}</p>}
        {unassigned && a.status !== 'resolved' && (
          <p className="mt-2 text-sm/6">
            <Link href={`/schemas?fp=${a.schemaFp}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
              Map this schema →
            </Link>
          </p>
        )}
        {nextStep && a.status !== 'resolved' && (
          <p className="mt-2 text-sm/6">
            <span className="font-medium">Next step:</span> {nextStep.text}
            {nextStep.approval === 'required' && (
              <Badge color="purple" className="ml-2">
                needs approval
              </Badge>
            )}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        {a.status === 'open' && (
          <Button outline onClick={() => onAction(a.id, 'ack')}>
            Acknowledge
          </Button>
        )}
        {a.status !== 'resolved' ? (
          <Button outline onClick={() => onAction(a.id, 'resolve')}>
            Resolve
          </Button>
        ) : (
          <Button plain onClick={() => onAction(a.id, 'reopen')}>
            Reopen
          </Button>
        )}
      </div>
    </li>
  )
}

export default function Feed() {
  const [alerts, setAlerts] = useState<Map<string, AlertSummary>>(new Map())
  const [team, setTeam] = useState('')
  const [status, setStatus] = useState('active')
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const m = useMetrics()
  const now = useNow(5000)

  const load = useCallback(async () => {
    const r = await api<{ alerts: AlertSummary[] }>('/api/alerts?limit=300')
    setAlerts(new Map(r.alerts.map((a) => [a.id, a])))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useLive({
    onAlerts: (updates) => {
      setAlerts((prev) => {
        const next = new Map(prev)
        for (const a of updates) next.set(a.id, a)
        return next
      })
      setFlash(new Set(updates.map((a) => a.id)))
      setTimeout(() => setFlash(new Set()), 900)
    },
  })

  const teams = useMemo(
    () => [...new Set([...alerts.values()].map((a) => a.team))].filter((t) => t !== 'unassigned').sort(),
    [alerts]
  )
  const unassignedOpen = useMemo(
    () => [...alerts.values()].filter((a) => a.team === 'unassigned' && a.status !== 'resolved').length,
    [alerts]
  )
  const visible = useMemo(
    () =>
      [...alerts.values()]
        .filter(
          (a) =>
            (!team || a.team === team) &&
            (status === 'all' || (status === 'active' ? a.status !== 'resolved' : a.status === status))
        )
        .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.lastSeen - a.lastSeen)
        .slice(0, 200),
    [alerts, team, status]
  )

  const onAction = async (id: string, op: string) => {
    const r = await api<{ alert: AlertSummary }>(`/api/alerts/${id}`, { body: { op } })
    setAlerts((prev) => new Map(prev).set(id, r.alert))
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>Live alerts</Heading>
          <Text>Updated in real time. Click an alert to see the runbook, deliveries and history.</Text>
        </div>
        <div className="flex gap-2">
          {team === 'unassigned' ? (
            <Button color="amber" onClick={() => setTeam('')}>
              Unassigned inbox{unassignedOpen ? ` (${unassignedOpen})` : ''}
            </Button>
          ) : (
            <Button outline onClick={() => setTeam('unassigned')}>
              Unassigned inbox{unassignedOpen ? ` (${unassignedOpen})` : ''}
            </Button>
          )}
          <Select value={team === 'unassigned' ? '' : team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="active">Open & acked</option>
            <option value="open">Open only</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </Select>
        </div>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Events (last 15 min)"
          value={(m?.events ?? 0).toLocaleString()}
          sub={`${m?.eventsPerSec ?? 0}/s now · ${(m?.matched ?? 0).toLocaleString()} matched a rule`}
        />
        <Stat
          label="Alerts raised"
          value={(m?.alertsCreated ?? 0).toLocaleString()}
          sub={`${m?.openAlerts ?? 0} open · ${m?.unassigned ?? 0} unassigned`}
        />
        <Stat
          label="Noise reduction"
          value={m?.noiseReduction ? `${m.noiseReduction}:1` : '—'}
          sub="matched events per alert"
        />
        <Stat
          label="Ingest → delivery"
          value={m ? `${m.endToEnd.all.p50} / ${m.endToEnd.all.p99} ms` : '—'}
          sub={`p50 / p99 · ${m?.pending ?? 0} pending · ${m?.dead ?? 0} dead`}
        />
      </div>

      <Simulator />

      <ul className="mt-8 space-y-3">
        {visible.map((a) => (
          <AlertRow key={a.id} a={a} now={now} onAction={onAction} flash={flash.has(a.id)} />
        ))}
        {visible.length === 0 && (
          <li className="rounded-xl border border-zinc-950/10 p-10 text-center text-sm text-zinc-500 dark:border-white/10">
            No alerts. Use “Simulate sources” above or POST any JSON to <code>/ingest/&lt;source&gt;</code>.
          </li>
        )}
      </ul>
    </>
  )
}
