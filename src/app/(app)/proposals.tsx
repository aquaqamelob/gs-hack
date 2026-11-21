'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { api, timeAgo, useLive, useNow } from '@/lib/client'
import type { Proposal } from '@/lib/engine/proposals'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

const REASON_LABEL: Record<string, string> = {
  'too-noisy': 'too noisy',
  'wrong-team': 'wrong team',
  'wrong-severity': 'wrong severity',
  'runbook-step-wrong': 'runbook step wrong',
  'missing-step': 'missing step',
  other: 'other',
}

/** Open proposals, reloaded live when anyone proposes, accepts or dismisses. */
export function useProposals() {
  const [items, setItems] = useState<Proposal[]>([])
  const load = useCallback(() => {
    api<{ proposals: Proposal[] }>('/api/proposals')
      .then((r) => setItems(r.proposals))
      .catch(() => setItems([]))
  }, [])
  useEffect(() => load(), [load])
  useLive({ onChanged: (k) => k.includes('proposal') && load() })
  return { items, reload: load }
}

/** Proposals for one target ("rule:<id>" or "runbook:<id>"), with accept / dismiss for admins. */
export function ProposalList({
  items,
  target,
  isAdmin,
  onDone,
}: {
  items: Proposal[]
  target: string
  isAdmin: boolean
  onDone: () => void
}) {
  const now = useNow(30_000)
  const [error, setError] = useState('')
  const mine = items.filter((p) => p.target === target)
  if (!mine.length) return null

  const decide = async (p: Proposal, op: 'accept' | 'dismiss') => {
    setError('')
    try {
      await api(`/api/proposals/${p.id}`, { body: { op } })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-sky-500/30 bg-sky-50 p-3 text-sm dark:bg-sky-500/10">
      <div className="font-semibold">
        {mine.some((p) => p.kind === 'learned') ? 'Suggested from resolved incidents' : 'Proposed fixes'}
      </div>
      {mine.map((p) => (
        <div
          key={p.id}
          className="flex flex-wrap items-start justify-between gap-2 border-t border-sky-500/20 pt-2 first:border-0 first:pt-0"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={p.kind === 'learned' ? 'sky' : 'amber'}>
                {p.kind === 'learned' ? 'learned' : (REASON_LABEL[p.reason] ?? p.reason)}
              </Badge>
              {p.kind === 'learned' && (
                <span className="font-mono text-green-700 dark:text-green-400">
                  + {p.patch?.runbook ? 'step' : 'new runbook with step'}: {p.text}
                </span>
              )}
              {p.kind === 'manual' && <span>{p.text}</span>}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {p.seen > 1 ? `seen in ${p.seen} incidents` : 'from 1 incident'} ·{' '}
              {p.alertIds.slice(-3).map((id, i) => (
                <span key={id}>
                  {i > 0 && ', '}
                  <Link href={`/alerts/${id}`} className="underline">
                    {id}
                  </Link>
                </span>
              ))}{' '}
              · by {p.createdBy} {timeAgo(p.updatedAt, now)}
            </div>
          </div>
          {isAdmin && (
            <div className="flex gap-2">
              <Button color="dark/zinc" onClick={() => decide(p, 'accept')}>
                {p.kind === 'learned' ? 'Add to runbook' : 'Mark done'}
              </Button>
              <Button plain onClick={() => decide(p, 'dismiss')}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      ))}
      {error && <p className="text-red-600">{error}</p>}
    </div>
  )
}
