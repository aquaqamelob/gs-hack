'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Heading } from '@/components/heading'
import { Text } from '@/components/text'
import { api, isConflict, useLive } from '@/lib/client'
import type { Rule } from '@/lib/engine/types'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { RuleEditor, RuleSummary, type Meta, type RuleRow } from './rule-editor'

export default function RulesPage() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [editing, setEditing] = useState<Rule | 'new' | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => setMeta(await api<Meta>('/api/rules')), [])
  useEffect(() => {
    void load()
    const onActor = () => {
      setEditing(null)
      void load()
    }
    window.addEventListener('actor-changed', onActor)
    return () => window.removeEventListener('actor-changed', onActor)
  }, [load])
  useLive({ onChanged: (k) => (k.includes('config:rules') || k.includes('config:all')) && void load() })

  if (!meta) return <Text>Loading…</Text>
  const isAdmin = meta.me.role === 'admin'
  const kindOf = new Map(meta.recipients.map((r) => [r.id, r.kind]))

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
  const toggle = (r: Rule) =>
    run(() => {
      const { summary: _s, ...clean } = r as RuleRow
      return api('/api/rules', { method: 'PUT', body: { rule: { ...clean, enabled: r.enabled === false }, version: meta.version } })
    })
  const remove = (r: Rule) =>
    confirm(`Delete rule “${r.name}”?`) &&
    run(() => api(`/api/rules?id=${encodeURIComponent(r.id)}&version=${meta.version}`, { method: 'DELETE' }))

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>Rules</Heading>
          <Text>
            Each rule decides which events become alerts, who is told and how the alert looks. Stored in Postgres
            (seeded from <code>config/rules.yaml</code> on first boot); a save reaches every instance within seconds.{' '}
            <a className="underline" href="/api/rules/export">
              Export as YAML
            </a>
          </Text>
        </div>
        {isAdmin && !editing && (
          <Button color="dark/zinc" onClick={() => setEditing('new')}>
            New rule
          </Button>
        )}
      </div>

      {!isAdmin && (
        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50/50 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-500/5">
          You are signed in as <strong>{meta.me.name}</strong>. Team filters are read-only for you — only an admin can
          change them. Set up your own filters on{' '}
          <Link href="/me" className="font-medium underline">
            My view
          </Link>
          .
        </div>
      )}

      {editing && isAdmin && (
        <RuleEditor
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          meta={meta}
          reload={() => void load()}
          onClose={(saved) => {
            setEditing(null)
            if (saved) void load()
          }}
        />
      )}
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <ul className="mt-8 space-y-3">
        {meta.rules.map((r) => (
          <li
            key={r.id}
            className={`rounded-xl border border-zinc-950/10 p-4 dark:border-white/10 ${r.enabled === false ? 'opacity-50' : ''}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{r.name}</span>
                  <Badge color={kindOf.get(r.team) === 'person' ? 'purple' : 'zinc'}>
                    {kindOf.get(r.team) === 'person' ? `personal: ${r.team}` : r.team}
                  </Badge>
                  {r.runbook && <Badge color="sky">runbook: {r.runbook}</Badge>}
                </div>
                <RuleSummary r={r} />
              </div>
              {isAdmin && (
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
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
