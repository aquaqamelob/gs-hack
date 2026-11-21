'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Heading, Subheading } from '@/components/heading'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { COLOR_BAR, SEVERITY_BADGE, api, isConflict, timeAgo, useLive, useNow, type AlertSummary } from '@/lib/client'
import type { Rule } from '@/lib/engine/types'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RecipientCard, type Row } from '../people/recipient-card'
import { RuleEditor, RuleSummary, type Meta, type RuleRow } from '../rules/rule-editor'

const SEV_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 }

function MyAlerts({ teams, names }: { teams: Set<string>; names: Map<string, string> }) {
  const [alerts, setAlerts] = useState<Map<string, AlertSummary>>(new Map())
  const [status, setStatus] = useState('active')
  const [source, setSource] = useState('')
  const now = useNow(5000)

  const load = useCallback(async () => {
    const r = await api<{ alerts: AlertSummary[] }>('/api/alerts?limit=500')
    setAlerts(new Map(r.alerts.map((a) => [a.id, a])))
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useLive({
    onAlerts: (updates) =>
      setAlerts((prev) => {
        const next = new Map(prev)
        for (const a of updates) next.set(a.id, a)
        return next
      }),
  })

  const visible = useMemo(
    () =>
      [...alerts.values()]
        .filter(
          (a) =>
            teams.has(a.team) &&
            (!source || a.team === source) &&
            (status === 'all' || (status === 'active' ? a.status !== 'resolved' : a.status === status))
        )
        .sort(
          (a, b) =>
            Number(a.status !== 'open') - Number(b.status !== 'open') ||
            SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
            b.lastSeen - a.lastSeen
        )
        .slice(0, 200),
    [alerts, teams, source, status]
  )

  const act = async (id: string, op: string) => {
    const r = await api<{ alert: AlertSummary }>(`/api/alerts/${id}`, { body: { op } })
    setAlerts((prev) => new Map(prev).set(id, r.alert))
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Subheading>My alerts</Subheading>
        <div className="flex gap-2">
          <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="From" className="w-48">
            <option value="">Personal + my teams</option>
            {[...teams].map((t) => (
              <option key={t} value={t}>
                {names.get(t) ?? t}
              </option>
            ))}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="w-36">
            <option value="active">Active</option>
            <option value="open">Open</option>
            <option value="acked">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </Select>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {visible.map((a) => (
          <li
            key={a.id}
            className={`relative flex items-center gap-3 overflow-hidden rounded-lg border border-zinc-950/10 p-3 pl-5 text-sm dark:border-white/10 ${a.status === 'resolved' ? 'opacity-60' : ''}`}
          >
            <span className={`absolute inset-y-0 left-0 w-1.5 ${COLOR_BAR[a.color] ?? 'bg-zinc-400'}`} />
            <Badge color={SEVERITY_BADGE[a.severity]}>{a.severity}</Badge>
            {a.count > 1 && <Badge color="zinc">×{a.count.toLocaleString()}</Badge>}
            <div className="min-w-0 flex-1">
              <Link href={`/alerts/${a.id}`} className="block truncate font-medium hover:underline">
                {a.title}
              </Link>
              <span className="text-xs text-zinc-500">
                {names.get(a.team) ?? a.team} · {a.ruleName} · {timeAgo(a.lastSeen, now)}
                {a.status === 'acked' && ` · acked by ${a.ackedBy}`}
              </span>
            </div>
            {a.status === 'open' && (
              <Button plain onClick={() => act(a.id, 'ack')}>
                Ack
              </Button>
            )}
            {a.status !== 'resolved' ? (
              <Button plain onClick={() => act(a.id, 'resolve')}>
                Resolve
              </Button>
            ) : (
              <Button plain onClick={() => act(a.id, 'reopen')}>
                Reopen
              </Button>
            )}
          </li>
        ))}
        {visible.length === 0 && <Text>Nothing here. Alerts from your filters and your teams show up live.</Text>}
      </ul>
    </section>
  )
}

export default function MyViewPage() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [recipients, setRecipients] = useState<Row[]>([])
  const [recipientsVersion, setRecipientsVersion] = useState('')
  const [editing, setEditing] = useState<Rule | 'new' | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [m, r] = await Promise.all([api<Meta>('/api/rules'), api<{ recipients: Row[]; version: string }>('/api/recipients')])
    setMeta(m)
    setRecipients(r.recipients)
    setRecipientsVersion(r.version)
  }, [])
  useEffect(() => {
    void load()
    const onActor = () => {
      setEditing(null)
      void load()
    }
    window.addEventListener('actor-changed', onActor)
    return () => window.removeEventListener('actor-changed', onActor)
  }, [load])
  useLive({ onChanged: (k) => k.includes('config:config') && void load() })

  const me = meta?.me
  const self = recipients.find((r) => r.id === me?.id)
  const names = useMemo(() => new Map(recipients.map((r) => [r.id, r.name])), [recipients])
  const myTeams = useMemo(() => {
    if (!me) return new Set<string>()
    const onCall = recipients.filter((r) => r.kind === 'team' && r.onCall === me.id).map((r) => r.id)
    return new Set([me.id, ...me.teams, ...onCall])
  }, [me, recipients])

  if (!meta || !me) return <Text>Loading…</Text>

  if (!me.known) {
    return (
      <>
        <Heading>My view</Heading>
        <Text className="mt-2">
          “{me.id}” is not a person in <code>config/recipients.yaml</code>. Pick yourself in the bottom-left corner.
        </Text>
      </>
    )
  }

  const mine = meta.rules.filter((r) => r.team === me.id)
  const teamRules = meta.rules.filter((r) => r.team !== me.id && myTeams.has(r.team))

  const run = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error).message)
      if (isConflict(e)) void load()
    }
  }
  const toggle = (r: RuleRow) =>
    run(() => {
      const { summary: _s, ...clean } = r
      return api('/api/rules', { method: 'PUT', body: { rule: { ...clean, enabled: r.enabled === false }, version: meta.version } })
    })
  const remove = (r: RuleRow) =>
    confirm(`Delete your filter “${r.name}”?`) &&
    run(() => api(`/api/rules?id=${encodeURIComponent(r.id)}&version=${meta.version}`, { method: 'DELETE' }))

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Heading>My view — {me.name}</Heading>
        <Badge color={me.role === 'admin' ? 'purple' : 'zinc'}>{me.role}</Badge>
      </div>
      <Text>
        Your alerts, your own filters and how you want to be told.
        {me.teams.length > 0 && <> You also see alerts of {me.teams.map((t) => names.get(t) ?? t).join(', ')}.</>}
        {me.role === 'admin' && (
          <>
            {' '}
            As an admin you change team filters on the{' '}
            <Link href="/rules" className="underline">
              Rules
            </Link>{' '}
            page.
          </>
        )}
      </Text>

      <div className="mt-8 grid gap-10 xl:grid-cols-[3fr_2fr]">
        <div className="space-y-10">
          <MyAlerts teams={myTeams} names={names} />

          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Subheading>My filters</Subheading>
                <Text>Personal rules: they notify only you and nobody else is affected.</Text>
              </div>
              {!editing && (
                <Button color="dark/zinc" onClick={() => setEditing('new')}>
                  New filter
                </Button>
              )}
            </div>
            {editing && (
              <RuleEditor
                key={editing === 'new' ? 'new' : editing.id}
                initial={editing === 'new' ? null : editing}
                meta={meta}
                reload={() => void load()}
                personal={{ id: me.id, name: me.name }}
                onClose={(saved) => {
                  setEditing(null)
                  if (saved) void load()
                }}
              />
            )}
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            <ul className="mt-4 space-y-3">
              {mine.map((r) => (
                <li
                  key={r.id}
                  className={`rounded-xl border border-zinc-950/10 p-4 dark:border-white/10 ${r.enabled === false ? 'opacity-50' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <span className="font-semibold">{r.name}</span>
                      <RuleSummary r={r} />
                    </div>
                    <div className="flex gap-2">
                      <Button outline onClick={() => toggle(r)}>
                        {r.enabled === false ? 'Enable' : 'Pause'}
                      </Button>
                      <Button outline onClick={() => setEditing(r)}>
                        Edit
                      </Button>
                      <Button plain onClick={() => remove(r)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
              {mine.length === 0 && !editing && <Text>No personal filters yet.</Text>}
            </ul>
          </section>

          {teamRules.length > 0 && (
            <section>
              <Subheading>My teams’ filters</Subheading>
              <Text>
                {me.role === 'admin' ? 'Edit them on the Rules page.' : 'Read-only — ask an admin to change them.'}
              </Text>
              <ul className="mt-4 space-y-3">
                {teamRules.map((r) => (
                  <li
                    key={r.id}
                    className={`rounded-xl border border-zinc-950/10 p-4 dark:border-white/10 ${r.enabled === false ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{r.name}</span>
                      <Badge color="zinc">{names.get(r.team) ?? r.team}</Badge>
                    </div>
                    <RuleSummary r={r} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <section>
          <Subheading>How I want to be told</Subheading>
          <Text>Used by every rule that notifies you without naming channels.</Text>
          {self && (
            <div className="mt-4">
              <RecipientCard r={self} all={recipients} version={recipientsVersion} onSaved={load} editable isAdmin={me.role === 'admin'} />
            </div>
          )}
        </section>
      </div>
    </>
  )
}
