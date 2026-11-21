import { actorOf } from './api'
import { rt } from './runtime'
import type { Recipient, Rule } from './types'

/**
 * Who is calling. SSO is mocked: the console sends the person's id in `x-actor`, and the role
 * comes from config/recipients.yaml (`role: admin`), never from the request itself.
 */
export interface Me {
  id: string
  name: string
  role: 'admin' | 'user'
  teams: string[]
  known: boolean
}

export function me(req: Request, body?: { actor?: unknown }): Me {
  const id = actorOf(req, body)
  const r = rt().recipients.find((x) => x.id === id && x.kind === 'person')
  if (!r) return { id, name: id, role: 'user', teams: [], known: false }
  return { id: r.id, name: r.name, role: r.role === 'admin' ? 'admin' : 'user', teams: r.teams ?? [], known: true }
}

export class Forbidden extends Error {
  status = 403
}

/**
 * Recipients a person may see: themselves and the teams they belong to. `null` means everyone (admin).
 * An unknown actor sees nobody.
 */
export function visibleRecipientIds(who: Me): Set<string> | null {
  if (who.role === 'admin') return null
  return who.known ? new Set([who.id, ...who.teams]) : new Set()
}

const normAddress = (a: string) => (a.includes('@') ? a.trim().toLowerCase() : a.replace(/[^\d+]/g, ''))

/** Phone numbers and email addresses of the recipients a person may see; `null` means all (admin). */
export function visibleAddresses(who: Me): ((address: string) => boolean) | null {
  const ids = visibleRecipientIds(who)
  if (!ids) return null
  const mine = new Set<string>()
  for (const r of rt().recipients)
    if (ids.has(r.id)) for (const a of [r.phone, r.email]) if (a) mine.add(normAddress(a))
  return (address) => mine.has(normAddress(String(address ?? '')))
}

/** Personal filter = a rule owned by one person that only notifies that person. */
export function isPersonalRuleOf(rule: Pick<Rule, 'team' | 'notify'>, personId: string) {
  return rule.team === personId && rule.notify.length > 0 && rule.notify.every((n) => n.to === personId)
}

/** Admins change any rule. A person changes only their own personal filters. */
export function assertCanEditRule(who: Me, next: Rule | null, previous: Rule | undefined) {
  if (who.role === 'admin') return
  if (!who.known) throw new Forbidden(`"${who.id}" is not a known person; pick yourself in the console`)
  if (previous && previous.team !== who.id) {
    const owner = rt().recipients.find((x) => x.id === previous.team)
    throw new Forbidden(
      owner?.kind === 'person'
        ? `"${previous.name}" is ${owner.name}'s personal filter; you can change only your own`
        : `"${previous.name}" belongs to ${previous.team}; only an admin can change team filters`
    )
  }
  if (next && !isPersonalRuleOf(next, who.id))
    throw new Forbidden('Your filters must be owned by you and notify only you. Team filters are changed by an admin.')
}

/** Admins edit anyone. A person edits only their own contact details and channel preferences. */
export function assertCanEditRecipient(who: Me, next: Recipient, previous: Recipient | undefined) {
  if (who.role === 'admin') return
  if (next.id !== who.id || previous?.kind !== 'person') throw new Forbidden('You can only change your own preferences')
  if ((next.role ?? 'user') !== (previous.role ?? 'user')) throw new Forbidden('Only an admin can change roles')
  if (JSON.stringify(next.teams ?? []) !== JSON.stringify(previous.teams ?? []))
    throw new Forbidden('Only an admin can change team membership')
}
