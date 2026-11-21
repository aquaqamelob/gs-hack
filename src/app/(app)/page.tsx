'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { Textarea } from '@/components/textarea'
import { COLOR_BAR, SEVERITY_BADGE, api, timeAgo, useLive, useMetrics, useNow, type AlertSummary } from '@/lib/client'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'

// ---------------------------------------------------------------- demo events

const SCENARIOS = [
  { id: 'workflow', label: 'Settlement workflow failed', hint: 'Appendix A #1, via the broker when configured' },
  { id: 'metric', label: 'payments-api error rate', hint: 'Appendix A #2, Alertmanager webhook' },
  { id: 'trade', label: 'Rejected EUR 25M trade', hint: 'Appendix A #3, different envelope' },
  { id: 'pricing-log', label: 'Pricing WARN log lines', hint: '6 log lines, grouped per instrument', count: 6 },
  { id: 'burst', label: 'Same error ×500', hint: 'shows deduplication', count: 500 },
  { id: 'metric-resolved', label: 'payments-api recovered', hint: 'closes the alert automatically' },
  { id: 'unknown', label: 'Never-seen message type', hint: 'lands in the Unassigned inbox' },
  { id: 'noise', label: '10,000 mixed events', hint: 'shows noise reduction', count: 10000 },
] as const

type DemoResult = { via?: 'kafka' | 'direct'; target?: string; sent?: number; accepted?: number; matchedRules?: string[]; unassigned?: number }

function describeResult(r: DemoResult) {
  const n = r.sent ?? r.accepted ?? 0
  const rules = r.matchedRules?.length ? `matched ${r.matchedRules.join(', ')}` : r.via === 'kafka' ? 'consumer will pick it up' : 'no rule matched'
  const path = r.via === 'kafka' ? `kafka (topic ${r.target})` : `direct (${r.target})`
  return `${n} event${n === 1 ? '' : 's'} via ${path} → ${rules}${r.unassigned ? ` · ${r.unassigned} to Unassigned` : ''}`
}

function DemoPanel() {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [custom, setCustom] = useState('')

  const run = async (scenario: string, count?: number) => {
    setBusy(scenario)
    setMsg('')
    try {
      setMsg(describeResult((await api<{ result: DemoResult }>('/api/demo', { body: { scenario, count } })).result))
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const sendCustom = async () => {
    setBusy('custom')
    try {
      const r = await api<DemoResult & { schemas: { name: string; status: string }[] }>('/api/ingest/webhook', { body: JSON.parse(custom) })
      setMsg(`${describeResult({ ...r, via: 'direct', target: 'POST /ingest/webhook' })} · schema ${r.schemas.map((s) => `"${s.name}" (${s.status})`).join(', ')}`)
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <Text>
        These are <strong>test events</strong>, not suggestions: each button sends a sample message from the task brief through
        the real ingest path, so you can watch rules, grouping and notifications work.
      </Text>
      <div className="mt-3 flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <Button key={s.id} outline disabled={busy !== null} onClick={() => run(s.id, 'count' in s ? s.count : undefined)}>
            <span className="text-left">
              <span className="block">{busy === s.id ? 'Sending…' : s.label}</span>
              <span className="block text-xs font-normal text-zinc-500">{s.hint}</span>
            </span>
          </Button>
        ))}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">Send your own JSON…</summary>
        <Textarea rows={5} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder='{"anything": "any shape"}' className="mt-2 font-mono" />
        <Button className="mt-2" color="dark/zinc" disabled={!custom.trim() || busy !== null} onClick={sendCustom}>
          Send to POST /ingest/webhook
        </Button>
      </details>
      {msg && <Text className="mt-3 font-medium">{msg}</Text>}
    </div>
  )
}

// ---------------------------------------------------------------- alert rows

const SEV_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 }

function StatusBadge({ a }: { a: AlertSummary }) {
  if (a.status === 'open') return null
  return <Badge color={a.status === 'acked' ? 'blue' : 'green'}>{a.status === 'acked' ? `acked by ${a.ackedBy}` : 'resolved'}</Badge>
}

function Actions({ a, onAction, small }: { a: AlertSummary; onAction: (id: string, op: string) => void; small?: boolean }) {
  return (
    <>
      {a.status === 'open' && (
        <Button {...(small ? { plain: true } : { outline: true })} onClick={() => onAction(a.id, 'ack')}>
          {small ? 'Ack' : 'Acknowledge'}
        </Button>
      )}
      {a.status !== 'resolved' ? (
        <Button {...(small ? { plain: true } : { outline: true })} onClick={() => onAction(a.id, 'resolve')}>
          Resolve
        </Button>
      ) : (
        <Button plain onClick={() => onAction(a.id, 'reopen')}>
          Reopen
        </Button>
      )}
    </>
  )
}

function AlertCard({ a, now, flash, onAction }: { a: AlertSummary; now: number; flash: boolean; onAction: (id: string, op: string) => void }) {
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
          <StatusBadge a={a} />
          <span className="text-xs text-zinc-500">
            {`${a.team} · ${a.ruleName} · ${timeAgo(a.lastSeen, now)}`}
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
        <Actions a={a} onAction={onAction} />
      </div>
    </li>
  )
}

function AlertLine({ a, now, flash, onAction }: { a: AlertSummary; now: number; flash: boolean; onAction: (id: string, op: string) => void }) {
  return (
    <li className={`flex items-center gap-3 py-2 pl-2 text-sm ${flash ? 'bg-blue-50 dark:bg-blue-500/10' : ''} ${a.status === 'resolved' ? 'opacity-60' : ''}`}>
      <span className={`h-6 w-1 shrink-0 rounded ${COLOR_BAR[a.color] ?? 'bg-zinc-400'}`} />
      <Badge color={SEVERITY_BADGE[a.severity]} className="w-16 justify-center">
        {a.severity}
      </Badge>
      <span className="w-14 shrink-0 text-right tabular-nums text-zinc-500">×{a.count.toLocaleString()}</span>
      <Link href={`/alerts/${a.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
        {a.title}
      </Link>
      <span className="hidden w-32 truncate text-xs text-zinc-500 md:block">{a.team}</span>
      <StatusBadge a={a} />
      <span className="w-16 shrink-0 text-right text-xs text-zinc-500">{timeAgo(a.lastSeen, now)}</span>
      <span className="flex w-36 shrink-0 justify-end gap-1">
        <Actions a={a} onAction={onAction} small />
      </span>
    </li>
  )
}

// ---------------------------------------------------------------- page

type GroupBy = 'none' | 'team' | 'rule' | 'severity' | 'source' | 'status'
type SortBy = 'priority' | 'newest' | 'count'

const GROUP_LABEL: Record<GroupBy, string> = { none: 'No grouping', team: 'Team', rule: 'Rule', severity: 'Severity', source: 'Source', status: 'Status' }

function groupKey(a: AlertSummary, by: GroupBy) {
  switch (by) {
    case 'team':
      return a.team
    case 'rule':
      return a.ruleName
    case 'severity':
      return a.severity
    case 'source':
      return a.source
    case 'status':
      return a.status
    default:
      return ''
  }
}

const PREFS_KEY = 'ctrl.feed'

export default function Feed() {
  const [alerts, setAlerts] = useState<Map<string, AlertSummary>>(new Map())
  const [team, setTeam] = useState('')
  const [status, setStatus] = useState('active')
  const [query, setQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [sortBy, setSortBy] = useState<SortBy>('priority')
  const [compact, setCompact] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [demo, setDemo] = useState(false)
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const m = useMetrics()
  const now = useNow(5000)

  const [prefsLoaded, setPrefsLoaded] = useState(false)
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
      if (p.groupBy) setGroupBy(p.groupBy)
      if (p.sortBy) setSortBy(p.sortBy)
      if (typeof p.compact === 'boolean') setCompact(p.compact)
    } catch {}
    setPrefsLoaded(true)
  }, [])
  useEffect(() => {
    if (prefsLoaded) localStorage.setItem(PREFS_KEY, JSON.stringify({ groupBy, sortBy, compact }))
  }, [prefsLoaded, groupBy, sortBy, compact])

  const load = useCallback(async () => {
    const r = await api<{ alerts: AlertSummary[] }>('/api/alerts?limit=500')
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

  const all = useMemo(() => [...alerts.values()], [alerts])
  const teams = useMemo(() => [...new Set(all.map((a) => a.team))].filter((t) => t !== 'unassigned').sort(), [all])
  const unassignedOpen = useMemo(() => all.filter((a) => a.team === 'unassigned' && a.status !== 'resolved').length, [all])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = all.filter(
      (a) =>
        (!team || a.team === team) &&
        (status === 'all' || (status === 'active' ? a.status !== 'resolved' : a.status === status)) &&
        (!q || `${a.title} ${a.body} ${a.team} ${a.ruleName} ${a.source} ${a.schemaName}`.toLowerCase().includes(q))
    )
    const cmp: Record<SortBy, (a: AlertSummary, b: AlertSummary) => number> = {
      priority: (a, b) =>
        Number(a.status === 'resolved') - Number(b.status === 'resolved') ||
        Number(a.status === 'acked') - Number(b.status === 'acked') ||
        SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
        b.lastSeen - a.lastSeen,
      newest: (a, b) => b.lastSeen - a.lastSeen,
      count: (a, b) => b.count - a.count,
    }
    return list.sort(cmp[sortBy]).slice(0, 300)
  }, [all, team, status, query, sortBy])

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', items: visible }]
    const map = new Map<string, AlertSummary[]>()
    for (const a of visible) {
      const k = groupKey(a, groupBy)
      map.set(k, [...(map.get(k) ?? []), a])
    }
    return [...map.entries()]
      .map(([key, items]) => ({ key, items }))
      .sort((x, y) => (groupBy === 'severity' ? SEV_RANK[x.key] - SEV_RANK[y.key] : y.items.length - x.items.length))
  }, [visible, groupBy])

  const onAction = async (id: string, op: string) => {
    const r = await api<{ alert: AlertSummary }>(`/api/alerts/${id}`, { body: { op } })
    setAlerts((prev) => new Map(prev).set(id, r.alert))
  }
  const ackAll = async (items: AlertSummary[]) => {
    for (const a of items.filter((x) => x.status === 'open')) await onAction(a.id, 'ack')
  }

  const toggle = (k: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  return (
    <>
      <div className="sticky top-0 z-20 -mx-6 -mt-6 border-b border-zinc-950/5 bg-white px-6 pt-6 pb-3 lg:-mx-10 lg:-mt-10 lg:rounded-t-lg lg:px-10 lg:pt-8 dark:border-white/5 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl/8 font-semibold sm:text-xl/8">Live alerts</h1>
            <span className="text-sm text-zinc-500">
              {`${(m?.events ?? 0).toLocaleString()} events → ${(m?.alertsCreated ?? 0).toLocaleString()} alerts (15 min) · ${m?.noiseReduction ? `${m.noiseReduction}:1 noise reduction` : '—'} · ${m?.openAlerts ?? 0} open`}
            </span>
          </div>
          <div className="flex gap-2">
            {team === 'unassigned' ? (
              <Button color="amber" onClick={() => setTeam('')}>
                Unassigned ({unassignedOpen}) ✕
              </Button>
            ) : (
              <Button outline onClick={() => setTeam('unassigned')}>
                Unassigned inbox{unassignedOpen ? ` (${unassignedOpen})` : ''}
              </Button>
            )}
            <Button plain onClick={() => setDemo(!demo)}>
              {demo ? 'Hide test events' : 'Send test events'}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search alerts…" className="max-w-56" aria-label="Search" />
          <Select value={team === 'unassigned' ? '' : team} onChange={(e) => setTeam(e.target.value)} aria-label="Team" className="max-w-44">
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="max-w-40">
            <option value="active">Open & acked</option>
            <option value="open">Open only</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </Select>
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} aria-label="Group by" className="max-w-44">
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
              <option key={g} value={g}>
                {g === 'none' ? GROUP_LABEL[g] : `Group by ${GROUP_LABEL[g].toLowerCase()}`}
              </option>
            ))}
          </Select>
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} aria-label="Sort" className="max-w-44">
            <option value="priority">Most urgent first</option>
            <option value="newest">Newest first</option>
            <option value="count">Most frequent first</option>
          </Select>
          <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs font-medium dark:bg-zinc-800">
            {[
              { v: false, l: 'Cards' },
              { v: true, l: 'List' },
            ].map((o) => (
              <button
                key={o.l}
                onClick={() => setCompact(o.v)}
                className={`rounded-md px-2.5 py-1.5 ${compact === o.v ? 'bg-white shadow-sm dark:bg-zinc-700' : 'text-zinc-500'}`}
              >
                {o.l}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-zinc-500">{visible.length} shown</span>
        </div>
      </div>

      {demo && <DemoPanel />}

      <div className="mt-6 space-y-6">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          const open = g.items.filter((a) => a.status === 'open').length
          const worst = g.items.reduce((w, a) => (SEV_RANK[a.severity] < SEV_RANK[w] ? a.severity : w), 'info' as AlertSummary['severity'])
          return (
            <section key={g.key || 'all'}>
              {groupBy !== 'none' && (
                <div className="mb-2 flex items-center gap-3 border-b border-zinc-950/5 pb-2 dark:border-white/5">
                  <button onClick={() => toggle(g.key)} className="flex items-center gap-2 text-left font-semibold">
                    <span className="w-4 text-zinc-400">{isCollapsed ? '▸' : '▾'}</span>
                    {g.key || '—'}
                  </button>
                  <Badge color={SEVERITY_BADGE[worst]}>{g.items.length}</Badge>
                  <span className="text-xs text-zinc-500">
                    {open} open · {g.items.reduce((s, a) => s + a.count, 0).toLocaleString()} events
                  </span>
                  {open > 0 && (
                    <Button plain className="ml-auto" onClick={() => ackAll(g.items)}>
                      Acknowledge all {open}
                    </Button>
                  )}
                </div>
              )}
              {!isCollapsed &&
                (compact ? (
                  <ul className="divide-y divide-zinc-950/5 dark:divide-white/5">
                    {g.items.map((a) => (
                      <AlertLine key={a.id} a={a} now={now} flash={flash.has(a.id)} onAction={onAction} />
                    ))}
                  </ul>
                ) : (
                  <ul className="space-y-3">
                    {g.items.map((a) => (
                      <AlertCard key={a.id} a={a} now={now} flash={flash.has(a.id)} onAction={onAction} />
                    ))}
                  </ul>
                ))}
            </section>
          )
        })}
        {visible.length === 0 && (
          <div className="rounded-xl border border-zinc-950/10 p-10 text-center text-sm text-zinc-500 dark:border-white/10">
            {query ? 'No alerts match your search.' : 'No alerts. Click “Send test events” above, or POST any JSON to /ingest/<source>.'}
          </div>
        )}
      </div>
    </>
  )
}
