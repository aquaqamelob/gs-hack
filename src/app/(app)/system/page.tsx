'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Heading, Subheading } from '@/components/heading'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/table'
import { Text } from '@/components/text'
import { api, timeAgo, useLive, type Metrics } from '@/lib/client'
import type { AuditEntry, Delivery } from '@/lib/engine/types'
import { useCallback, useEffect, useState } from 'react'

type Data = {
  stats: Metrics
  instance: string
  channels: { channel: string; label: string; provider: string }[]
  dlq: Delivery[]
  pending: Delivery[]
  audit: AuditEntry[]
  gateway: { up: boolean }
}

export default function SystemPage() {
  const [data, setData] = useState<Data | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)

  const load = useCallback(async () => setData(await api<Data>('/api/system')), [])
  useEffect(() => {
    void load()
  }, [load])
  useLive({
    onStats: setMetrics,
    onChanged: (k) => k.includes('audit') && void load(),
  })

  if (!data) return <Text>Loading…</Text>
  const m = metrics ?? data.stats

  const post = async (body: Record<string, unknown>) => {
    await api('/api/system', { body })
    await load()
  }

  return (
    <>
      <Heading>System & audit</Heading>
      <Text>
        Measured from Postgres over the last {Math.round(m.windowSec / 60)} minutes, across all instances. This page is
        served by <code>{data.instance}</code>. Reproducible numbers: <code>loadtest/</code>.
      </Text>

      <section className="mt-8">
        <Subheading>Event received → provider accepted (first notification)</Subheading>
        <Table dense className="mt-2">
          <TableHead>
            <TableRow>
              <TableHeader>Channel</TableHeader>
              <TableHeader>Deliveries</TableHeader>
              <TableHeader>p50</TableHeader>
              <TableHeader>p95</TableHeader>
              <TableHeader>p99</TableHeader>
              <TableHeader>max</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {(['all', 'ui', 'email', 'sms', 'phone'] as const).map((c) => (
              <TableRow key={c}>
                <TableCell className="font-medium">{c}</TableCell>
                <TableCell>{m.endToEnd[c].count.toLocaleString()}</TableCell>
                <TableCell>{m.endToEnd[c].p50} ms</TableCell>
                <TableCell>{m.endToEnd[c].p95} ms</TableCell>
                <TableCell>{m.endToEnd[c].p99} ms</TableCell>
                <TableCell>{m.endToEnd[c].max} ms</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Text className="mt-2">
          {m.events.toLocaleString()} events ({m.eventsPerSec}/s now) · {m.matched.toLocaleString()} matched a rule ·{' '}
          {m.alertsCreated} alerts created ({m.unassigned} unassigned) · {m.noiseReduction}× noise reduction ·{' '}
          {m.retried} deliveries needed a retry · {m.pending} pending · {m.dead} dead
        </Text>
      </section>

      <section className="mt-10">
        <Subheading>Dependencies</Subheading>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.channels.map((c) => (
            <div key={c.channel} className="rounded-lg border border-zinc-950/10 p-3 dark:border-white/10">
              <span className="block font-medium">{c.label}</span>
              <span className="block text-xs text-zinc-500">{c.provider}</span>
              {(c.channel === 'sms' || c.channel === 'phone') && (
                <Badge className="mt-1" color={data.gateway.up ? 'green' : 'red'}>
                  {data.gateway.up ? 'up' : 'down'}
                </Badge>
              )}
            </div>
          ))}
        </div>
        <Text className="mt-2">
          Kill the SMS gateway or an app instance (<code>chaos/</code>): deliveries stay in the outbox and retry with
          backoff.
        </Text>
      </section>

      {(data.pending.length > 0 || data.dlq.length > 0) && (
        <section className="mt-10">
          <div className="flex items-center justify-between">
            <Subheading>
              Outbox: {data.pending.length} pending · {data.dlq.length} dead-lettered
            </Subheading>
            {data.dlq.length > 0 && (
              <Button outline onClick={() => post({ op: 'requeue-all' })}>
                Requeue all dead letters
              </Button>
            )}
          </div>
          <Table dense className="mt-2">
            <TableHead>
              <TableRow>
                <TableHeader>Channel</TableHeader>
                <TableHeader>To</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Tries</TableHeader>
                <TableHeader>Last error</TableHeader>
                <TableHeader />
              </TableRow>
            </TableHead>
            <TableBody>
              {[...data.dlq, ...data.pending].slice(0, 50).map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.channel}</TableCell>
                  <TableCell>{d.address}</TableCell>
                  <TableCell>
                    <Badge color={d.status === 'dead' ? 'red' : 'amber'}>
                      {d.status === 'dead' ? 'dead' : 'retrying'}
                    </Badge>
                  </TableCell>
                  <TableCell>{d.attempts}</TableCell>
                  <TableCell className="max-w-72 truncate">{d.lastError}</TableCell>
                  <TableCell>
                    {d.status === 'dead' ? (
                      <Button plain onClick={() => post({ op: 'requeue', id: d.id })}>
                        Requeue
                      </Button>
                    ) : (
                      <Button plain href={`/alerts/${d.alertId}`}>
                        Alert
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      <section className="mt-10">
        <Subheading>Audit log</Subheading>
        <Text>Every approval, runbook action, rule or mapping change, reply and dead letter.</Text>
        <Table dense className="mt-2">
          <TableHead>
            <TableRow>
              <TableHeader>When</TableHeader>
              <TableHeader>Who</TableHeader>
              <TableHeader>What</TableHeader>
              <TableHeader>Target</TableHeader>
              <TableHeader>Detail</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.audit.slice(0, 150).map((e) => (
              <TableRow key={e.id} href={e.target.startsWith('alr_') ? `/alerts/${e.target}` : undefined}>
                <TableCell className="text-zinc-500">{timeAgo(e.at)}</TableCell>
                <TableCell>{e.actor}</TableCell>
                <TableCell className="font-medium">{e.action}</TableCell>
                <TableCell className="max-w-40 truncate">{e.target}</TableCell>
                <TableCell className="max-w-96 truncate">{e.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </>
  )
}
