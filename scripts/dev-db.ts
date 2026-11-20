// Local Postgres without Docker (dev and tests only). `docker compose up` uses postgres:16 instead.
// Usage: bun scripts/dev-db.ts   → postgres://postgres:postgres@localhost:5432/ctrl
import EmbeddedPostgres from 'embedded-postgres'
import path from 'node:path'

const port = Number(process.env.PGPORT ?? 5432)
const pg = new EmbeddedPostgres({
  databaseDir: path.resolve('data/pg'),
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  postgresFlags: ['-c', 'max_connections=300', '-c', 'synchronous_commit=on'],
})

const fs = await import('node:fs')
if (!fs.existsSync(path.resolve('data/pg/PG_VERSION'))) await pg.initialise()
await pg.start()
try {
  await pg.createDatabase('ctrl')
} catch {
  /* already exists */
}
console.log(`[dev-db] postgres://postgres:postgres@localhost:${port}/ctrl`)

const stop = async () => {
  await pg.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setInterval(() => {}, 1 << 30)
