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
      // Batched events fan out as single ones, so subscribers see one shape.
      if (e.type === 'alerts') for (const id of e.ids) rt().bus.emit('change', { type: 'alert', id })
      else if (e.type === 'pushes') for (const x of e.items) rt().bus.emit('change', { type: 'push', ...x })
      // Config changes are re-emitted as 'change' by boot once this instance has reloaded them.
      else rt().bus.emit(e.type === 'config' ? 'config' : 'change', e)
    } catch {
      /* ignore malformed payloads */
    }
  })
}

// NOTIFY payloads are limited to 8000 bytes; an alert id takes about 17 of them in JSON.
const IDS_PER_NOTIFY = 400

/**
 * For hot paths, called after the data transaction has committed. A transaction with NOTIFY takes a global lock at commit
 * and holds it through the WAL flush, so notifying inside the write transaction serialises all writers. Here the lock is
 * held only by this tiny transaction, which skips the flush: a NOTIFY lost in a crash costs one UI refresh, never data.
 * It never throws, because the caller's write has already succeeded and must not be retried.
 */
export async function publishAlerts(ids: Iterable<string>) {
  const all = [...ids]
  try {
    for (let i = 0; i < all.length; i += IDS_PER_NOTIFY) {
      const e: BusEvent = { type: 'alerts', ids: all.slice(i, i + IDS_PER_NOTIFY) }
      await db()`select set_config('synchronous_commit', 'off', true), pg_notify(${CHANNEL}, ${JSON.stringify(e)})`
    }
  } catch (e) {
    console.error('[bus] notify failed:', (e as Error).message)
  }
}

const PUSHES_PER_NOTIFY = 100
let pushBatch: { id: string; to: string }[] | null = null
let pushFlush: Promise<void> = Promise.resolve()

/** Coalesces the UI pushes of one dispatcher batch into a few NOTIFYs. Rejects on failure, so the outbox retries the delivery. */
export function publishPush(id: string, to: string) {
  if (!pushBatch) {
    const batch: { id: string; to: string }[] = (pushBatch = [])
    pushFlush = new Promise((resolve) => setImmediate(resolve)).then(async () => {
      pushBatch = null
      for (let i = 0; i < batch.length; i += PUSHES_PER_NOTIFY) {
        const e: BusEvent = { type: 'pushes', items: batch.slice(i, i + PUSHES_PER_NOTIFY) }
        await db()`select set_config('synchronous_commit', 'off', true), pg_notify(${CHANNEL}, ${JSON.stringify(e)})`
      }
    })
  }
  pushBatch.push({ id, to })
  return pushFlush
}

export async function audit(actor: string, action: string, target: string, detail?: string, tx?: Tx) {
  const q = tx ?? db()
  await q`insert into audit_log (actor, action, target, detail) values (${actor}, ${action}, ${target}, ${detail ?? null})`
  await publish({ type: 'audit' }, tx)
}
