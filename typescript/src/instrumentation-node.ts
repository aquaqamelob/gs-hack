import { boot } from './lib/engine/boot'

/** Start workers (Kafka consumer, outbox dispatcher, scheduler) at server start, not on the first request. */
async function start(): Promise<void> {
  try {
    await boot()
  } catch (e) {
    console.error('[ctrl] boot failed, retrying in 2s:', (e as Error).message)
    await new Promise((r) => setTimeout(r, 2000))
    return start()
  }
}

if (process.env.NEXT_PHASE !== 'phase-production-build') void start()
