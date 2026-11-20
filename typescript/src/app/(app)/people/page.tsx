'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Checkbox } from '@/components/checkbox'
import { Heading, Subheading } from '@/components/heading'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { api, timeAgo, useLive } from '@/lib/client'
import { CHANNELS, SEVERITIES, type Channel, type Recipient } from '@/lib/engine/types'
import { useCallback, useEffect, useState } from 'react'

type GatewayMessage = { id: number; channel: string; to: string; text: string; at: number }
type Row = Recipient & { onShift?: boolean }

const CHANNEL_ICON: Record<string, string> = { phone: '📞', sms: '💬', email: '✉️', webhook: '⚙️' }

function WorkingHours({ draft, setDraft }: { draft: Recipient; setDraft: (r: Recipient) => void }) {
  const h = draft.working_hours
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox
          checked={Boolean(h)}
          onChange={(v) =>
            setDraft({ ...draft, working_hours: v ? { from: '08:00', to: '20:00', tz: 'Europe/Warsaw', outside: ['email'] } : undefined })
          }
        />
        Working hours
      </label>
      {h && (
        <>
          <Input type="time" value={h.from} onChange={(e) => setDraft({ ...draft, working_hours: { ...h, from: e.target.value } })} className="w-28" />
          –
          <Input type="time" value={h.to} onChange={(e) => setDraft({ ...draft, working_hours: { ...h, to: e.target.value } })} className="w-28" />
          , otherwise
          <Select
            value={h.outside[0]}
            onChange={(e) => setDraft({ ...draft, working_hours: { ...h, outside: [e.target.value as Channel] } })}
            className="w-auto"
          >
            {CHANNELS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          <span className="text-xs text-zinc-500">{h.tz}</span>
        </>
      )}
    </div>
  )
}

function RecipientCard({ r, all, onSaved }: { r: Row; all: Recipient[]; onSaved: () => void }) {
  const { onShift, ...base } = r
  const [draft, setDraft] = useState<Recipient>(base)
  const [saved, setSaved] = useState(false)
  useEffect(() => setDraft(base), [JSON.stringify(base)]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)

  return (
    <div className="rounded-xl border border-zinc-950/10 p-4 dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{r.name}</span>
        <Badge color={r.kind === 'team' ? 'blue' : 'zinc'}>{r.kind}</Badge>
        <span className="text-xs text-zinc-500">{r.id}</span>
        {r.working_hours && <Badge color={onShift ? 'green' : 'zinc'}>{onShift ? 'in working hours' : 'outside working hours'}</Badge>}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Input
          value={draft.email ?? ''}
          placeholder="email"
          onChange={(e) => setDraft({ ...draft, email: e.target.value || undefined })}
        />
        {r.kind === 'person' ? (
          <Input
            value={draft.phone ?? ''}
            placeholder="phone"
            onChange={(e) => setDraft({ ...draft, phone: e.target.value || undefined })}
          />
        ) : (
          <Select
            value={draft.onCall ?? ''}
            onChange={(e) => setDraft({ ...draft, onCall: e.target.value || undefined })}
          >
            <option value="">No on-call person</option>
            {all
              .filter((x) => x.kind === 'person')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  On call: {p.name}
                </option>
              ))}
          </Select>
        )}
      </div>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-500">
            <th className="font-normal">When severity is</th>
            {CHANNELS.map((c) => (
              <th key={c} className="text-center font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SEVERITIES.map((sev) => (
            <tr key={sev}>
              <td className="py-1">{sev}</td>
              {CHANNELS.map((c) => {
                const list = draft.prefs[sev] ?? []
                return (
                  <td key={c} className="text-center">
                    <Checkbox
                      checked={list.includes(c)}
                      onChange={(v) =>
                        setDraft({
                          ...draft,
                          prefs: { ...draft.prefs, [sev]: v ? [...list, c] : list.filter((x) => x !== c) },
                        })
                      }
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <WorkingHours draft={draft} setDraft={setDraft} />
      {dirty && (
        <Button
          className="mt-3"
          color="dark/zinc"
          onClick={async () => {
            await api('/api/recipients', { method: 'PUT', body: { recipient: draft } })
            setSaved(true)
            onSaved()
          }}
        >
          Save preferences
        </Button>
      )}
      {saved && !dirty && <Text className="mt-2">Saved to config/recipients.yaml</Text>}
    </div>
  )
}

function ReplySimulator() {
  const [from, setFrom] = useState('+48 600 333 444')
  const [text, setText] = useState('')
  const [result, setResult] = useState('')
  return (
    <div className="rounded-xl border border-zinc-950/10 p-4 dark:border-white/10">
      <Subheading>Reply to an alert (SMS / email gateway)</Subheading>
      <Text>
        Each alert has a 4-digit code valid for one hour. “ACK 1234” acknowledges, “YES 1234” approves the next step that needs
        approval, “RESOLVE 1234” closes. Every reply is in the audit log.
      </Text>
      <div className="mt-3 flex flex-wrap gap-2">
        <Input value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-48" />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="YES 4821" className="max-w-40" />
        <Button
          color="dark/zinc"
          disabled={!text}
          onClick={async () => {
            try {
              const r = await api<{ message: string }>('/api/reply', { body: { from, text } })
              setResult(r.message)
            } catch (e) {
              setResult((e as Error).message)
            }
          }}
        >
          Send reply
        </Button>
      </div>
      {result && <Text className="mt-2 font-medium">{result}</Text>}
    </div>
  )
}

export default function PeoplePage() {
  const [recipients, setRecipients] = useState<Row[]>([])
  const [messages, setMessages] = useState<GatewayMessage[]>([])
  const [gatewayUp, setGatewayUp] = useState(true)
  const [mailhog, setMailhog] = useState('')
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    const [r, s] = await Promise.all([
      api<{ recipients: Row[] }>('/api/recipients'),
      api<{ gateway: { up: boolean; messages: GatewayMessage[] }; mailhog: string }>('/api/system'),
    ])
    setRecipients(r.recipients)
    setMessages(s.gateway.messages)
    setGatewayUp(s.gateway.up)
    setMailhog(s.mailhog)
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useLive({ onChanged: (k) => k.includes('config:config') && void load(), onAlerts: () => void load() })

  const shown = messages.filter((m) => !filter || m.channel === filter)

  return (
    <>
      <Heading>People & channels</Heading>
      <Text>
        Who prefers which channel for which severity, and when. A rule can name channels explicitly; otherwise these preferences
        apply. Stored in <code>config/recipients.yaml</code>.
      </Text>

      <div className="mt-8 grid gap-8 xl:grid-cols-2">
        <div className="space-y-4">
          {recipients.map((r) => (
            <RecipientCard key={r.id} r={r} all={recipients} onSaved={load} />
          ))}
        </div>
        <div className="space-y-6">
          <ReplySimulator />
          <div>
            <div className="flex items-center justify-between">
              <Subheading>Received by the mock gateway</Subheading>
              <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-40">
                <option value="">All</option>
                {['phone', 'sms', 'email', 'webhook'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </div>
            <Text>
              SMS, voice and runbook webhooks hit the mock gateway service{gatewayUp ? '' : ' (currently DOWN — deliveries are retrying)'}.
              Email goes over SMTP to{' '}
              <a href={mailhog} className="underline" target="_blank" rel="noreferrer">
                MailHog
              </a>
              . A real provider is one <code>ChannelAdapter</code>.
            </Text>
            <ul className="mt-3 space-y-2">
              {shown.slice(0, 60).map((m) => (
                <li key={m.id} className="rounded-lg border border-zinc-950/10 p-3 text-sm dark:border-white/10">
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <span>{CHANNEL_ICON[m.channel]}</span>
                    <span className="font-medium text-zinc-900 dark:text-white">{m.channel}</span>
                    <span>→ {m.to}</span>
                    <span className="ml-auto">{timeAgo(m.at)}</span>
                  </div>
                  <p className="mt-1 line-clamp-6 whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{m.text}</p>
                </li>
              ))}
              {shown.length === 0 && <Text>Nothing delivered yet.</Text>}
            </ul>
          </div>
        </div>
      </div>
    </>
  )
}
