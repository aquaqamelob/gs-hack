import { alertFromRow } from './alerts'
import { listen } from './bus'
import { loadAll, reloadConfig, seedConfig, watchConfig } from './config'
import { db, migrate } from './db'
import { startKafka } from './kafka'
import { OUTBOX_CHANNEL, scheduleTick, wakeDispatcher } from './outbox'
import { flushRuleErrors } from './pipeline'
import { rt } from './runtime'
import { flushSchemaCounts, invalidateSchema } from './schemas'

const RETENTION_HOURS = Number(process.env.EVENT_RETENTION_HOURS ?? 24)

const RETENTION_BATCH = 20_000
const RETENTION_MAX_BATCHES = 50

/** Short batches keep locks brief; the advisory lock means one instance does the work. Up to 1M rows per minute. */
async function retention() {
  for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
    const deleted = await db().begin(async (tx) => {
      const [{ locked }] = await tx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(424244) as locked`
      if (!locked) return 0
      const res = await tx`
        delete from events where id in (
          select id from events where received_at < now() - make_interval(hours => ${RETENTION_HOURS}) limit ${RETENTION_BATCH})`
      return res.count
    })
    if (deleted < RETENTION_BATCH) break
  }
  await db()`delete from reply_failures where at < now() - interval '1 day'`
}

const safe = (name: string, fn: () => Promise<unknown>) => () =>
  void fn().catch((e) => console.error(`[ctrl] ${name} failed:`, (e as Error).message))

/** Idempotent. Every instance runs the same workers; Postgres row locks keep them from stepping on each other. */
export function boot(): Promise<void> {
  const r = rt()
  r.booted ??= (async () => {
    await migrate()
    await seedConfig()
    await loadAll()
    await listen()
    await db().listen(OUTBOX_CHANNEL, () => wakeDispatcher())
    r.bus.on('change', (e) => {
      if (e.type === 'schema') invalidateSchema(e.id)
    })
    // Another instance saved config: reload from Postgres first, then tell SSE clients, so their refetch sees it.
    r.bus.on('config', (e) =>
      void reloadConfig()
        .then(() => r.bus.emit('change', e))
        .catch((err) => console.error('[config] reload failed:', (err as Error).message))
    )
    watchConfig(() => r.bus.emit('change', { type: 'config', what: 'all' }))
    setInterval(wakeDispatcher, 250).unref?.()
    setInterval(safe('scheduler', () => scheduleTick(alertFromRow as never)), 500).unref?.()
    setInterval(safe('schema counts', flushSchemaCounts), 2000).unref?.()
    setInterval(safe('rule errors', flushRuleErrors), 2000).unref?.()
    setInterval(safe('retention', retention), 60_000).unref?.()
    await startKafka().catch((e) => console.error('[kafka] not started:', (e as Error).message))
    wakeDispatcher()
    console.log(`[ctrl] ${r.instance} ready: ${r.rules.length} rules, ${r.recipients.length} recipients, ${r.runbooks.size} runbooks`)
  })().catch((e) => {
    r.booted = undefined
    throw e
  })
  return r.booted
}
