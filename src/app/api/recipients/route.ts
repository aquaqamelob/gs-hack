import { actorOf, fail, handle, json, readJson } from '@/lib/engine/api'
import { assertCanEditRecipient, me, visibleRecipientIds } from '@/lib/engine/auth'
import { audit } from '@/lib/engine/bus'
import { insideWorkingHours } from '@/lib/engine/channels'
import { ConfigError, configVersion, updateRecipients } from '@/lib/engine/config'
import { rt } from '@/lib/engine/runtime'
import { CHANNELS, SEVERITIES, type Recipient } from '@/lib/engine/types'

export const dynamic = 'force-dynamic'

/** Admins see everyone; a person sees only themselves and their own teams. */
export async function GET(req: Request) {
  return handle(async () => {
    const ids = visibleRecipientIds(me(req))
    const all = rt().recipients
    return json({
      recipients: all
        .filter((r) => !ids || ids.has(r.id))
        .map((r) => ({
          ...r,
          onShift: insideWorkingHours(r),
          // Only the name: a team member may see who is on call without seeing that person's contacts.
          ...(r.onCall ? { onCallName: all.find((p) => p.id === r.onCall)?.name ?? r.onCall } : {}),
        })),
      defaultOwner: rt().defaultOwner,
      version: configVersion('recipients'),
    })
  })
}

export async function PUT(req: Request) {
  return handle(async () => {
    const body = await readJson<{ recipient?: Recipient; actor?: string; version?: string }>(req)
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
      if (!/^\d{2}:\d{2}$/.test(h.from) || !/^\d{2}:\d{2}$/.test(h.to))
        return fail('working_hours.from/to must be HH:MM')
      if (!Array.isArray(h.outside) || !h.outside.every((c) => CHANNELS.includes(c)))
        return fail('working_hours.outside must list channels')
    }
    if (r.role !== undefined && r.role !== 'admin' && r.role !== 'user') return fail('role must be admin or user')
    if (r.teams !== undefined && !Array.isArray(r.teams)) return fail('teams must list existing team ids')
    if (r.kind === 'team') {
      delete r.role
      delete r.teams
    }
    const who = me(req, body)
    // Checks against other recipients run on the file as it is now, under the global config lock.
    const exists = await updateRecipients((all) => {
      if (r.teams && !r.teams.every((t) => all.some((x) => x.id === t && x.kind === 'team')))
        throw new ConfigError('teams must list existing team ids')
      const previous = all.find((x) => x.id === r.id)
      assertCanEditRecipient(who, r, previous)
      return { recipients: previous ? all.map((x) => (x.id === r.id ? r : x)) : [...all, r], result: Boolean(previous) }
    }, body.version)
    await audit(
      actorOf(req, body),
      exists ? 'recipient.updated' : 'recipient.created',
      r.id,
      JSON.stringify({ prefs: r.prefs, working_hours: h, role: r.role, teams: r.teams })
    )
    return json({ ok: true, version: configVersion('recipients') })
  })
}
