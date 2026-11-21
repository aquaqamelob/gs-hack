import { db, type Tx } from './db'
import { rt, type BusEvent } from './runtime'

export const CHANNEL = 'ctrl'

/** Publish to every instance (including this one) through Postgres NOTIFY. Inside a transaction it fires on commit. */
export async function publish(e: BusEvent, tx?: Tx) {
  const q = tx ?? db()
  await q`select pg_notify(${CHANNEL}, ${JSON.stringify(e)})`
}

export async function listen() {
  await db().listen(CHANNEL, (payload) => {
    try {
      const e = JSON.parse(payload) as BusEvent
      rt().bus.emit('change', e)
    } catch {
      /* ignore malformed payloads */
    }
  })
}

export async function audit(actor: string, action: string, target: string, detail?: string, tx?: Tx) {
  const q = tx ?? db()
  await q`insert into audit_log (actor, action, target, detail) values (${actor}, ${action}, ${target}, ${detail ?? null})`
  await publish({ type: 'audit' }, tx)
}
