'use client'

import { Button } from '@/components/button'
import { Heading, Subheading } from '@/components/heading'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { api, timeAgo, useLive, useMe } from '@/lib/client'
import { useCallback, useEffect, useState } from 'react'
import { RecipientCard, type Row } from './recipient-card'

type GatewayMessage = { id: number; channel: string; to: string; text: string; at: number }

const CHANNEL_ICON: Record<string, string> = { phone: '📞', sms: '💬', email: '✉️', webhook: '⚙️' }

function ReplySimulator({ defaultFrom }: { defaultFrom?: string }) {
  const [from, setFrom] = useState(defaultFrom ?? '+48 600 333 444')
  useEffect(() => {
    if (defaultFrom) setFrom(defaultFrom)
  }, [defaultFrom])
  const [text, setText] = useState('')
  const [result, setResult] = useState('')
  return (
    <div className="rounded-xl border border-zinc-950/10 p-4 dark:border-white/10">
      <Subheading>Reply to an alert (SMS / email gateway)</Subheading>
      <Text>
        Each alert has a 4-digit code valid for one hour. “ACK 1234” acknowledges, “YES 1234” approves the next step
        that needs approval, “RESOLVE 1234” closes. Every reply is in the audit log.
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
  const [recipients, setRecipients] = useState<Row[] | null>(null)
  const [messages, setMessages] = useState<GatewayMessage[]>([])
  const [gatewayUp, setGatewayUp] = useState(true)
  const [mailhog, setMailhog] = useState('')
  const [filter, setFilter] = useState('')
  const { me, isAdmin } = useMe()

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
    // Switching the signed-in person changes what the server lets us see.
    const onActor = () => void load()
    window.addEventListener('actor-changed', onActor)
    return () => window.removeEventListener('actor-changed', onActor)
  }, [load])
  useLive({ onChanged: (k) => k.includes('config:config') && void load(), onAlerts: () => void load() })

  const list = recipients ?? []
  const shown = messages.filter((m) => !filter || m.channel === filter)
  // Self first, then own teams (the server already hides everyone else from non-admins).
  const ordered = [...list].sort((a, b) => Number(b.id === me?.id) - Number(a.id === me?.id))
  const self = list.find((r) => r.id === me?.id)

  return (
    <>
      <Heading>People & channels</Heading>
      <Text>
        Who prefers which channel for which severity, and when. A rule can name channels explicitly; otherwise these
        preferences apply. Stored in <code>config/recipients.yaml</code>.{' '}
        {isAdmin
          ? 'As an admin you can see and change everyone, including roles and team membership.'
          : 'You see your own settings and the teams you belong to. You can change only your own preferences.'}
      </Text>

      <div className="mt-8 grid gap-8 xl:grid-cols-2">
        <div className="space-y-4">
          {recipients !== null && !isAdmin && list.length === 0 && (
            <Text>Pick yourself in the bottom-left corner to see your channels and preferences.</Text>
          )}
          {ordered.map((r) => (
            <RecipientCard
              key={r.id}
              r={r}
              all={list}
              onSaved={load}
              editable={isAdmin || r.id === me?.id}
              isAdmin={isAdmin}
            />
          ))}
        </div>
        <div className="space-y-6">
          <ReplySimulator defaultFrom={isAdmin ? undefined : self?.phone} />
          <div>
            <div className="flex items-center justify-between">
              <Subheading>{isAdmin ? 'Received by the mock gateway' : 'Sent to you and your teams'}</Subheading>
              <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-40">
                <option value="">All</option>
                {['phone', 'sms', 'email', 'webhook'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </div>
            <Text>
              SMS, voice and runbook webhooks hit the mock gateway service
              {gatewayUp ? '' : ' (currently DOWN — deliveries are retrying)'}. Email goes over SMTP to{' '}
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
