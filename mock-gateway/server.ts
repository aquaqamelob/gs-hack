// Mock SMS / voice gateway and generic webhook target for runbook actions.
// Run with: bun mock-gateway/server.ts   (PORT defaults to 4010)
// Kill it to simulate a provider outage; CTRL's outbox retries until it is back.

type Message = { id: number; channel: string; to: string; text: string; key: string; at: number; host?: string; method?: string; path?: string }

const port = Number(process.env.PORT ?? 4010)
const messages: Message[] = []
const seen = new Map<string, number>()
let seq = 0
let down = false

function record(m: Omit<Message, 'id' | 'at'>) {
  const msg = { ...m, id: ++seq, at: Date.now() }
  messages.push(msg)
  if (messages.length > 5000) messages.splice(0, messages.length - 5000)
  return msg
}

const json = (data: unknown, status = 200) => Response.json(data, { status })

// Inbound replies are forwarded to CTRL like a real provider webhook, signed with HMAC-SHA256 of the body.
const replyUrl = process.env.CTRL_REPLY_URL ?? 'http://localhost:3000/api/reply'
const replyHmac = process.env.REPLY_HMAC ?? ''
const sign = (body: string) => new Bun.CryptoHasher('sha256', replyHmac).update(body).digest('hex')

Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/health') return json({ status: down ? 'DOWN' : 'UP' }, down ? 503 : 200)
    if (path === '/messages') {
      const limit = Number(url.searchParams.get('limit') ?? 200)
      return json(messages.slice(-limit).reverse())
    }
    if (path === '/stats') {
      const by: Record<string, number> = {}
      for (const m of messages) by[m.channel] = (by[m.channel] ?? 0) + 1
      return json({ total: messages.length, uniqueKeys: seen.size, byChannel: by, down })
    }
    if (path === '/chaos' && req.method === 'POST') {
      down = Boolean(((await req.json().catch(() => ({}))) as { down?: boolean }).down)
      return json({ down })
    }
    if (down) return json({ error: 'gateway unavailable' }, 503)

    // Simulated inbound SMS/email reply: {from, text} → signed POST to CTRL /api/reply. Returns CTRL's answer.
    if (path === '/inbound' && req.method === 'POST') {
      const inbound = (await req.json().catch(() => ({}))) as { from?: string; text?: string }
      const body = JSON.stringify({ from: String(inbound.from ?? ''), text: String(inbound.text ?? '') })
      record({ channel: 'inbound', to: 'ctrl', text: body, key: '' })
      try {
        const res = await fetch(replyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(replyHmac ? { 'x-signature': `sha256=${sign(body)}` } : {}) },
          body,
          signal: AbortSignal.timeout(10_000),
        })
        return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
      } catch (e) {
        return json({ error: `cannot reach CTRL: ${(e as Error).message}` }, 502)
      }
    }

    if ((path === '/sms' || path === '/phone') && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { to?: string; text?: string; key?: string }
      const key = req.headers.get('idempotency-key') ?? body.key ?? ''
      if (key && seen.has(key)) return json({ id: seen.get(key), duplicate: true })
      const msg = record({ channel: path.slice(1), to: String(body.to ?? ''), text: String(body.text ?? ''), key })
      if (key) seen.set(key, msg.id)
      return json({ id: msg.id, duplicate: false })
    }

    // Anything else is a runbook webhook target (counterparty-service, workflow-api, escalation-api, ...).
    const host = req.headers.get('host') ?? ''
    const body = req.method === 'GET' ? '' : await req.text()
    record({ channel: 'webhook', to: `${host}${path}`, text: body.slice(0, 500), key: req.headers.get('idempotency-key') ?? '', host, method: req.method, path })
    if (path.includes('/fail')) return json({ error: 'simulated failure' }, 500)
    if (path.endsWith('/health')) return json({ status: 'UP' })
    if (path.includes('/retry')) return json({ accepted: true, status: 'RETRY_SCHEDULED' }, 202)
    if (path.includes('/escalations')) return json({ paged: true }, 201)
    return json({ ok: true })
  },
})

console.log(`[mock-gateway] listening on :${port}`)

// Minimal SMTP sink for local runs without Docker (compose uses MailHog instead). Set SMTP_PORT=0 to disable.
const smtpPort = Number(process.env.SMTP_PORT ?? 1025)
if (smtpPort) {
  type Session = { buf: string; data: boolean; from: string; to: string[] }
  Bun.listen<Session>({
    hostname: '0.0.0.0',
    port: smtpPort,
    socket: {
      open(s) {
        s.data = { buf: '', data: false, from: '', to: [] }
        s.write('220 mock-gateway ESMTP\r\n')
      },
      data(s, chunk) {
        const st = s.data
        st.buf += chunk.toString()
        let i: number
        while ((i = st.buf.indexOf('\r\n')) >= 0 || (st.data && st.buf.includes('\r\n.\r\n'))) {
          if (st.data) {
            const end = st.buf.indexOf('\r\n.\r\n')
            if (end < 0) return
            const raw = st.buf.slice(0, end)
            st.buf = st.buf.slice(end + 5)
            st.data = false
            if (down) {
              s.write('451 gateway unavailable\r\n')
              continue
            }
            const subject = raw.match(/^Subject: (.*)$/im)?.[1] ?? ''
            const key = raw.match(/^Message-ID: <([^>]+)>/im)?.[1] ?? ''
            const body = raw.split(/\r\n\r\n/).slice(1).join('\n\n')
            if (!key || !seen.has(key)) {
              const msg = record({ channel: 'email', to: st.to.join(', '), text: `${subject}\n${body}`.slice(0, 2000), key })
              if (key) seen.set(key, msg.id)
            }
            s.write('250 OK queued\r\n')
            continue
          }
          const line = st.buf.slice(0, i)
          st.buf = st.buf.slice(i + 2)
          const cmd = line.slice(0, 4).toUpperCase()
          if (cmd === 'EHLO' || cmd === 'HELO') s.write('250-mock-gateway\r\n250 SIZE 10000000\r\n')
          else if (cmd === 'MAIL') (st.from = line), (st.to = []), s.write('250 OK\r\n')
          else if (cmd === 'RCPT') st.to.push(line.match(/<([^>]*)>/)?.[1] ?? ''), s.write('250 OK\r\n')
          else if (cmd === 'DATA') (st.data = true), s.write('354 End data with <CR><LF>.<CR><LF>\r\n')
          else if (cmd === 'QUIT') s.write('221 Bye\r\n'), s.end()
          else if (cmd === 'RSET') (st.to = []), s.write('250 OK\r\n')
          else s.write('250 OK\r\n')
        }
      },
    },
  })
  console.log(`[mock-gateway] SMTP sink on :${smtpPort}`)
}
