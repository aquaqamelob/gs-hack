import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { audit } from '@/lib/engine/bus'
import { insideWorkingHours } from '@/lib/engine/channels'
import { saveRecipients } from '@/lib/engine/config'
import { rt } from '@/lib/engine/runtime'
import { CHANNELS, SEVERITIES, type Recipient } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  return handle(async () =>
    json({
      recipients: rt().recipients.map((r) => ({ ...r, onShift: insideWorkingHours(r) })),
      defaultOwner: rt().defaultOwner,
    })
  )
}

export async function PUT(req: Request) {
  return handle(async () => {
    const body = await readJson<{ recipient?: Recipient; actor?: string }>(req)
    const r = body.recipient
    if (!r?.id || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(r.id)) return fail('id must be a lowercase slug')
    if (!r.name) return fail('name is required')
    if (r.kind !== 'team' && r.kind !== 'person') return fail('kind must be team or person')
    for (const sev of SEVERITIES) {
      const chans = r.prefs?.[sev]
      if (chans && !chans.every((c) => CHANNELS.includes(c))) return fail(`prefs.${sev} has an unknown channel`)
    }
    const h = r.working_hours
    if (h) {
      if (!/^\d{2}:\d{2}$/.test(h.from) || !/^\d{2}:\d{2}$/.test(h.to)) return fail('working_hours.from/to must be HH:MM')
      if (!Array.isArray(h.outside) || !h.outside.every((c) => CHANNELS.includes(c))) return fail('working_hours.outside must list channels')
    }
    const all = rt().recipients
    const exists = all.some((x) => x.id === r.id)
    saveRecipients(exists ? all.map((x) => (x.id === r.id ? r : x)) : [...all, r])
    await audit(actorOf(req, body), exists ? 'recipient.updated' : 'recipient.created', r.id, JSON.stringify({ prefs: r.prefs, working_hours: h }))
    return json({ ok: true })
  })
}
