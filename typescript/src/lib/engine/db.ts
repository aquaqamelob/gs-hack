import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

export type Sql = postgres.Sql<Record<string, never>>
export type Tx = postgres.TransactionSql<Record<string, never>>

const KEY = Symbol.for('ctrl.db.v1')
type Holder = { sql?: Sql; migrated?: Promise<void> }
const holder = (): Holder => ((globalThis as Record<symbol, Holder>)[KEY] ??= {})

export const databaseUrl = () => process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ctrl'

export function db(): Sql {
  const h = holder()
  if (!h.sql) {
    h.sql = postgres(databaseUrl(), {
      max: Number(process.env.DB_POOL ?? 20),
      idle_timeout: 30,
      connect_timeout: 10,
      transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } },
      onnotice: () => {},
    }) as unknown as Sql
  }
  return h.sql
}

export function migrate(): Promise<void> {
  const h = holder()
  h.migrated ??= (async () => {
    const ddl = fs.readFileSync(path.join(process.cwd(), 'db', 'schema.sql'), 'utf8')
    await db().begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(424242)`
      await tx.unsafe(ddl)
    })
  })().catch((e) => {
    h.migrated = undefined
    throw e
  })
  return h.migrated
}

export const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null)
