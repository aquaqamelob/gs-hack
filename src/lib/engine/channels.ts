import nodemailer, { type Transporter } from 'nodemailer'
import { publish } from './bus'
import { rt } from './runtime'
import type { Alert, Channel, Delivery, Recipient, Route, Severity } from './types'
import { hhmmToMinutes, localMinutes } from './util'

export interface ChannelAdapter {
  channel: Channel
  label: string
  provider: () => string
  /** Must be safe to call twice with the same idempotency key. Throws on failure; the outbox retries. */
  send(d: Pick<Delivery, 'idempotencyKey' | 'address' | 'subject' | 'body' | 'alertId' | 'recipient'>): Promise<void>
}

const gatewayUrl = () => (process.env.SMS_GATEWAY_URL ?? 'http://localhost:4010').replace(/\/$/, '')

function gateway(channel: 'sms' | 'phone', label: string): ChannelAdapter {
  return {
    channel,
    label,
    provider: () => `${gatewayUrl()}/${channel}`,
    async send(d) {
      const res = await fetch(`${gatewayUrl()}/${channel}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': d.idempotencyKey },
        body: JSON.stringify({ to: d.address, text: d.body, key: d.idempotencyKey }),
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) throw new Error(`${channel} gateway HTTP ${res.status}`)
    },
  }
}

let transport: Transporter | undefined
const smtpUrl = () => process.env.SMTP_URL ?? 'smtp://localhost:1025'

const email: ChannelAdapter = {
  channel: 'email',
  label: 'Email',
  provider: () => smtpUrl(),
  async send(d) {
    transport ??= nodemailer.createTransport(smtpUrl(), { pool: true, maxConnections: 5 } as never)
    await transport.sendMail({
      from: process.env.MAIL_FROM ?? 'CTRL <ctrl@bank.local>',
      to: d.address,
      subject: d.subject,
      text: d.body,
      messageId: `<${d.idempotencyKey.replace(/[^\w.-]/g, '.')}@ctrl.local>`,
    })
  },
}

const ui: ChannelAdapter = {
  channel: 'ui',
  label: 'Live UI',
  provider: () => 'server-sent events',
  async send(d) {
    await publish({ type: 'push', id: d.alertId, to: d.recipient })
  },
}

export const ADAPTERS: Record<Channel, ChannelAdapter> = {
  phone: gateway('phone', 'Phone call'),
  sms: gateway('sms', 'SMS'),
  email,
  ui,
}

// ---------------------------------------------------------------- routing

export function findRecipient(query: string): Recipient | undefined {
  const q = query.toLowerCase().trim()
  const all = rt().recipients
  return all.find((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q)
}

export function insideWorkingHours(r: Recipient | undefined, at = Date.now()) {
  const h = r?.working_hours
  if (!h) return true
  const m = localMinutes(at, h.tz)
  const from = hhmmToMinutes(h.from)
  const to = hhmmToMinutes(h.to)
  return from <= to ? m >= from && m < to : m >= from || m < to
}

/** Route channels win; otherwise the recipient's preference for this severity. Outside working hours the recipient's fallback applies. */
export function channelsFor(route: Route, recipient: Recipient | undefined, severity: Severity, at = Date.now()): Channel[] {
  let channels = route.channels ?? recipient?.prefs[severity] ?? ['ui']
  if (recipient?.working_hours && !insideWorkingHours(recipient, at)) {
    channels = [...recipient.working_hours.outside, ...(channels.includes('ui') ? (['ui'] as Channel[]) : [])]
  }
  return [...new Set(channels)]
}

export function addressFor(recipient: Recipient | undefined, channel: Channel, fallback: string) {
  if (channel === 'ui') return recipient?.id ?? fallback
  const onCall = recipient?.onCall ? rt().recipients.find((r) => r.id === recipient.onCall) : undefined
  if (channel === 'email') return recipient?.email ?? onCall?.email ?? `${fallback}@bank.local`
  return onCall?.phone ?? recipient?.phone ?? ''
}

// ---------------------------------------------------------------- message formats

const SEV_WORD = { critical: 'CRITICAL', error: 'ERROR', warning: 'WARNING', info: 'INFO' } as const

export const publicUrl = () => (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '')

export function formatFor(channel: Channel, alert: Alert, reason: Delivery['reason']): { subject: string; body: string } {
  const link = `${publicUrl()}/alerts/${alert.id}`
  const count = alert.count > 1 ? ` (x${alert.count})` : ''
  const prefix = reason === 'update' ? 'STILL FIRING ' : reason === 'unassigned' ? 'UNASSIGNED ' : ''
  const approvalStep = alert.steps.find((s) => s.approval === 'required' && s.status !== 'done' && s.status !== 'skipped')
  if (channel === 'sms') {
    const approve = approvalStep ? ` Reply YES ${alert.approvalCode} to approve "${approvalStep.text.slice(0, 40)}".` : ''
    return {
      subject: '',
      body: `[${SEV_WORD[alert.severity]}] ${prefix}${alert.title}${count}. ${link} Reply ACK ${alert.approvalCode} to acknowledge.${approve}`.slice(0, 480),
    }
  }
  if (channel === 'phone') {
    return {
      subject: 'voice call',
      body: `${prefix}${SEV_WORD[alert.severity].toLowerCase()} alert for ${alert.team}. ${alert.title}. ${alert.body}. Press 1 to acknowledge. Details were sent by SMS.`,
    }
  }
  if (channel === 'email') {
    const fields = alert.fields.map((f) => `  ${f.label}: ${f.value}`).join('\n')
    const steps = alert.steps
      .map((s, i) => `  ${i + 1}. ${s.when ? `[if ${s.when}] ` : ''}${s.text}${s.approval === 'required' ? ' (needs approval)' : ''}`)
      .join('\n')
    return {
      subject: `[${SEV_WORD[alert.severity]}] ${prefix}${alert.title}${count}`,
      body: [
        alert.body,
        fields && `\nDetails:\n${fields}`,
        steps && `\nRunbook "${alert.runbook?.title}":\n${steps}`,
        `\nOpen in the console: ${link}`,
        `Reply "ACK ${alert.approvalCode}" to acknowledge${approvalStep ? ` or "YES ${alert.approvalCode}" to approve the next step that needs approval` : ''}.`,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  return { subject: alert.title, body: alert.body }
}
