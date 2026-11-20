import { Kafka, logLevel } from 'kafkajs'
import { ingest } from './pipeline'
import { count } from './runtime'
import { parseLogLine } from './schema'

/**
 * Consumer group over Redpanda/Kafka. The topic name is the source name.
 * Offsets are committed only after the batch is stored, so a crash replays instead of losing events.
 * Non-JSON messages are treated as log lines, never dropped.
 */
export async function startKafka() {
  const brokers = process.env.KAFKA_BROKERS
  if (!brokers) return
  const topics = (process.env.KAFKA_TOPICS ?? 'events,logs').split(',').map((t) => t.trim()).filter(Boolean)
  const kafka = new Kafka({ clientId: 'ctrl', brokers: brokers.split(','), logLevel: logLevel.WARN })
  const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP ?? 'ctrl' })
  await consumer.connect()
  for (const topic of topics) await consumer.subscribe({ topic, fromBeginning: false })
  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      const payloads: unknown[] = []
      for (const m of batch.messages) {
        const text = m.value?.toString('utf8') ?? ''
        try {
          payloads.push(JSON.parse(text))
        } catch {
          const parsed = parseLogLine(text)
          if (parsed) payloads.push(parsed)
          else count('kafka_empty_messages_total')
        }
      }
      if (!isRunning() || isStale()) return
      if (payloads.length) await ingest(payloads, batch.topic)
      resolveOffset(batch.lastOffset())
      await heartbeat()
    },
  })
  console.log(`[kafka] consuming ${topics.join(', ')} from ${brokers}`)
}

export async function produce(topic: string, messages: unknown[]) {
  const brokers = process.env.KAFKA_BROKERS
  if (!brokers) throw new Error('KAFKA_BROKERS is not set')
  const kafka = new Kafka({ clientId: 'ctrl-demo', brokers: brokers.split(','), logLevel: logLevel.WARN })
  const producer = kafka.producer()
  await producer.connect()
  await producer.send({ topic, messages: messages.map((m) => ({ value: typeof m === 'string' ? m : JSON.stringify(m) })) })
  await producer.disconnect()
}
