'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Heading, Subheading } from '@/components/heading'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/table'
import { Text } from '@/components/text'
import { Textarea } from '@/components/textarea'
import { COLOR_BAR, COLOR_TEXT, SEVERITY_BADGE, api, timeAgo, useLive, useNow } from '@/lib/client'
import type { Alert, AlertStep, AuditEntry, Delivery, Runbook } from '@/lib/engine/types'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

type Detail = Alert & { deliveries: Delivery[]; audit: AuditEntry[] }

const STEP_BADGE: Record<AlertStep['status'], { color: 'zinc' | 'purple' | 'blue' | 'green' | 'red'; label: string }> = {
  todo: { color: 'zinc', label: 'to do' },
  awaiting_approval: { color: 'purple', label: 'waiting for approval' },
  running: { color: 'blue', label: 'running' },
  done: { color: 'green', label: 'done' },
  failed: { color: 'red', label: 'failed' },
  skipped: { color: 'zinc', label: 'skipped' },
}

const DELIVERY_BADGE: Record<Delivery['status'], 'green' | 'amber' | 'red'> = { sent: 'green', pending: 'amber', dead: 'red' }

const PLAIN_SEVERITY = {
  critical: 'Something important is broken right now and needs attention immediately.',
  error: 'Something failed and needs someone to look at it soon.',
  warning: 'Something looks wrong; it is not urgent yet.',
  info: 'For your information; no action needed unless it repeats.',
}

function StepCard({
  step,
  index,
  alertId,
  onChange,
  disabled,
}: {
  step: AlertStep
  index: number
  alertId: string
  onChange: (a: Detail) => void
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const act = async (op: string) => {
    setBusy(true)
    setErr('')
    try {
      const r = await api<{ alert: Detail }>(`/api/alerts/${alertId}/steps/${step.id}`, { body: { op } })
      onChange(r.alert)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const b = STEP_BADGE[step.status]
  const finished = step.status === 'done' || step.status === 'skipped'
  return (
    <li className="flex gap-4 rounded-lg border border-zinc-950/10 p-4 dark:border-white/10">
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${finished ? 'bg-green-500 text-white' : 'bg-zinc-100 dark:bg-zinc-800'}`}
      >
        {finished ? '✓' : index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {step.when && <Badge color="sky">if {step.when}</Badge>}
          <span className="font-medium">{step.text}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <Badge color={b.color}>{b.label}</Badge>
          {step.action && <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">webhook: {step.action}</code>}
          {step.approval === 'required' && <Badge color="purple">human approval required</Badge>}
          {step.approvedBy && <span>approved by {step.approvedBy}</span>}
          {step.by && step.at && (
            <span>
              · {step.by} {timeAgo(step.at)}
            </span>
          )}
        </div>
        {step.output && <p className="mt-2 rounded bg-zinc-50 px-2 py-1 font-mono text-xs break-all dark:bg-zinc-800/60">{step.output}</p>}
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      </div>
      {!disabled && (
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {step.status === 'awaiting_approval' ? (
            <Button color="purple" disabled={busy} onClick={() => act('approve')}>
              Approve & run
            </Button>
          ) : !finished && step.action ? (
            <Button color={step.approval === 'required' ? 'purple' : 'dark/zinc'} disabled={busy} onClick={() => act('run')}>
              {busy ? 'Running…' : step.approval === 'required' ? 'Request approval' : step.status === 'failed' ? 'Retry' : 'Run'}
            </Button>
          ) : !finished ? (
            <Button outline disabled={busy} onClick={() => act(step.approval === 'required' ? 'run' : 'done')}>
              {step.approval === 'required' ? 'Request approval' : 'Mark done'}
            </Button>
          ) : null}
          {!finished && (
            <Button plain disabled={busy} onClick={() => act('skip')}>
              Skip
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

export default function AlertPage({ params }: { params: { id: string } }) {
  const [alert, setAlert] = useState<Detail | null>(null)
  const [runbook, setRunbook] = useState<Runbook | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [fixed, setFixed] = useState('')
  const [proposing, setProposing] = useState(false)
  const [fix, setFix] = useState({ reason: 'too-noisy', text: '' })
  const [notice, setNotice] = useState('')
  const now = useNow(5000)

  const load = useCallback(async () => {
    try {
      const r = await api<{ alert: Detail; runbook: Runbook | null }>(`/api/alerts/${params.id}`)
      setAlert(r.alert)
      setRunbook(r.runbook)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [params.id])

  useEffect(() => {
    void load()
  }, [load])

  useLive({ onAlerts: (as) => as.some((a) => a.id === params.id) && void load() })

  if (error) return <Text>{error}</Text>
  if (!alert) return <Text>Loading…</Text>

  const op = async (o: string, extra?: Record<string, unknown>) => {
    const r = await api<{ alert: Detail }>(`/api/alerts/${alert.id}`, { body: { op: o, ...extra } })
    setAlert(r.alert)
  }

  const nextStep = alert.steps.find((s) => s.status !== 'done' && s.status !== 'skipped')
  const closed = alert.status === 'resolved'
  const unassigned = alert.team === 'unassigned'

  return (
    <>
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← Live alerts
      </Link>

      <div className="relative mt-4 overflow-hidden rounded-xl border border-zinc-950/10 p-6 pl-8 dark:border-white/10">
        <span className={`absolute inset-y-0 left-0 w-2 ${COLOR_BAR[alert.color] ?? 'bg-zinc-400'}`} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={SEVERITY_BADGE[alert.severity]}>{alert.severity}</Badge>
          {alert.count > 1 && <Badge color="zinc">happened {alert.count.toLocaleString()}×</Badge>}
          <Badge color={alert.status === 'open' ? 'red' : alert.status === 'acked' ? 'blue' : 'green'}>{alert.status}</Badge>
          <span className="text-sm text-zinc-500">
            first {timeAgo(alert.firstSeen, now)} · last {timeAgo(alert.lastSeen, now)} · {alert.team}
          </span>
        </div>
        <Heading className={`mt-3 ${COLOR_TEXT[alert.color] ?? ''}`}>{alert.title}</Heading>

        {/* Level 1: plain language */}
        <div className="mt-3 space-y-1 text-base/7">
          <p>{PLAIN_SEVERITY[alert.severity]}</p>
          {alert.body && <p className="text-zinc-700 dark:text-zinc-300">{alert.body}</p>}
          <p className="text-zinc-600 dark:text-zinc-400">
            {alert.ackedBy ? `${alert.ackedBy} is on it.` : `Sent to ${alert.team}; nobody has acknowledged it yet.`}
            {nextStep && !closed && (
              <>
                {' '}
                Next: <strong>{nextStep.text}</strong>
              </>
            )}
          </p>
          {unassigned && (
            <p>
              <Link href={`/schemas?fp=${alert.schemaFp}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                Map this schema →
              </Link>{' '}
              <span className="text-sm text-zinc-500">then add a rule so the right team gets it next time.</span>
            </p>
          )}
        </div>

        {/* Level 2: key fields */}
        {alert.fields.length > 0 && (
          <dl className="mt-5 grid gap-x-6 gap-y-2 sm:grid-cols-3">
            {alert.fields.map((f) => (
              <div key={f.label}>
                <dt className="text-xs text-zinc-500">{f.label}</dt>
                <dd className="font-medium break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {alert.status === 'open' && (
            <Button color="dark/zinc" onClick={() => op('ack')}>
              Acknowledge
            </Button>
          )}
          {!closed && (
            <div className="flex w-full flex-wrap items-start gap-2">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Resolution note (optional)" className="max-w-sm" />
              <Textarea
                value={fixed}
                onChange={(e) => setFixed(e.target.value)}
                rows={2}
                className="max-w-md"
                placeholder={'What fixed it? One step per line (optional).\nSteps the runbook does not have yet are suggested for it.'}
              />
              <Button
                color="green"
                onClick={async () => {
                  const lines = fixed.split('\n').filter((l) => l.trim())
                  await op('resolve', { note: note || undefined, fixed: lines })
                  setNote('')
                  setFixed('')
                  if (lines.length) setNotice('Thanks. New steps were suggested for the runbook; an admin reviews them on the Runbooks page.')
                }}
              >
                Resolve
              </Button>
            </div>
          )}
          <Button outline onClick={() => setProposing((x) => !x)}>
            Propose a fix
          </Button>
          {closed && (
            <>
              <Text>
                Resolved by {alert.resolvedBy}
                {alert.resolution ? ` — “${alert.resolution}”` : ''}
              </Text>
              <Button plain onClick={() => op('reopen')}>
                Reopen
              </Button>
            </>
          )}
          <span className="ml-auto text-xs text-zinc-500">
            Reply code <code className="font-semibold">{alert.approvalCode}</code> (reply “ACK {alert.approvalCode}” or “YES{' '}
            {alert.approvalCode}” from a phone or email this alert was sent to)
          </span>
        </div>

        {proposing && (
          <div className="mt-4 flex flex-wrap items-start gap-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
            <Select value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} className="w-auto">
              <option value="too-noisy">Too noisy</option>
              <option value="wrong-team">Wrong team</option>
              <option value="wrong-severity">Wrong severity</option>
              <option value="runbook-step-wrong">Runbook step is wrong</option>
              <option value="missing-step">A step is missing</option>
              <option value="other">Other</option>
            </Select>
            <Textarea
              value={fix.text}
              onChange={(e) => setFix({ ...fix, text: e.target.value })}
              rows={2}
              className="max-w-lg"
              placeholder="What should change? e.g. group these per instrument, or page counterparty-support instead"
            />
            <Button
              color="dark/zinc"
              disabled={!fix.text.trim()}
              onClick={async () => {
                try {
                  await api('/api/proposals', { body: { alertId: alert.id, ...fix } })
                  setProposing(false)
                  setFix({ reason: 'too-noisy', text: '' })
                  setNotice('Proposal sent. It is listed under this rule on the Rules page for an admin to act on.')
                } catch (e) {
                  setNotice((e as Error).message)
                }
              }}
            >
              Send proposal
            </Button>
          </div>
        )}
        {notice && <Text className="mt-3 font-medium">{notice}</Text>}

        {/* Level 3: raw JSON, collapsed */}
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-zinc-500">Raw event and normalised fields</summary>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">{JSON.stringify(alert.raw, null, 2)}</pre>
            <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-100">
              {JSON.stringify(alert.canonical, null, 2)}
            </pre>
          </div>
          <Text className="mt-2">
            dedup key <code>{alert.dedupKey}</code> · rule <code>{alert.ruleId}</code> · schema{' '}
            <Link href={`/schemas?fp=${alert.schemaFp}`} className="underline">
              {alert.schemaName}
            </Link>{' '}
            from {alert.source}
          </Text>
        </details>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <div className="flex items-baseline justify-between">
            <Subheading>Runbook{alert.runbook ? `: ${alert.runbook.title}` : ''}</Subheading>
            {alert.runbook && (
              <Link href="/runbooks" className="text-xs text-zinc-500 hover:underline">
                source: {alert.runbook.format}
                {runbook?.parsedBy === 'fallback' ? ' (single text step)' : ''}
              </Link>
            )}
          </div>
          {alert.steps.length === 0 ? (
            <Text className="mt-3">No runbook is attached to this rule yet. Add one on the Runbooks page and reference it from the rule.</Text>
          ) : (
            <ol className="mt-4 space-y-3">
              {alert.steps.map((s, i) => (
                <StepCard key={s.id} step={s} index={i} alertId={alert.id} onChange={setAlert} disabled={closed} />
              ))}
            </ol>
          )}

          <Subheading className="mt-10">Notifications</Subheading>
          <Table dense className="mt-2 [--gutter:--spacing(1)]">
            <TableHead>
              <TableRow>
                <TableHeader>Channel</TableHeader>
                <TableHeader>To</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Tries</TableHeader>
                <TableHeader>Latency</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {alert.deliveries.map((d) => (
                <TableRow key={d.id} title={d.lastError ?? undefined}>
                  <TableCell>
                    {d.channel}
                    {d.reason !== 'new' && <span className="text-xs text-zinc-500"> · {d.reason}</span>}
                  </TableCell>
                  <TableCell className="max-w-48 truncate">{d.address}</TableCell>
                  <TableCell>
                    <Badge color={DELIVERY_BADGE[d.status]}>{d.status === 'pending' && d.attempts > 0 ? 'retrying' : d.status}</Badge>
                    {d.lastError && d.status !== 'sent' && <span className="ml-2 text-xs text-red-600">{d.lastError}</span>}
                  </TableCell>
                  <TableCell>{d.attempts}</TableCell>
                  <TableCell>{d.sentAt ? `${d.sentAt - d.eventReceivedAt} ms` : '—'}</TableCell>
                </TableRow>
              ))}
              {alert.deliveries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-zinc-500">
                    {alert.nextNotifyAt ? `Grouping: first notification in ${Math.max(0, Math.round((alert.nextNotifyAt - now) / 1000))}s` : 'None yet'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </section>

        <aside className="space-y-10 lg:col-span-2">
          <section>
            <Subheading>History</Subheading>
            <ol className="mt-3 space-y-3 border-l border-zinc-200 pl-4 text-sm dark:border-zinc-700">
              <li>
                <div className="text-xs text-zinc-500">{new Date(alert.firstSeen).toLocaleTimeString('en-GB')}</div>
                Alert raised by rule “{alert.ruleName}” from {alert.source} / {alert.schemaName}
              </li>
              {alert.audit.map((e) => (
                <li key={e.id}>
                  <div className="text-xs text-zinc-500">
                    {new Date(e.at).toLocaleTimeString('en-GB')} · {e.actor}
                  </div>
                  <span className="font-medium">{e.action}</span> {e.detail}
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </>
  )
}
