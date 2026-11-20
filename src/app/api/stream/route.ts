import { ready } from '@/lib/engine/api'
import { getAlertsByIds } from '@/lib/engine/alerts'
import { stats } from '@/lib/engine/metrics'
import { rt, type BusEvent } from '@/lib/engine/runtime'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** SSE: one-way push is all the console needs; it survives proxies and reconnects on its own. */
export async function GET(req: Request) {
  await ready()
  const bus = rt().bus
  const encoder = new TextEncoder()
  let cleanup = () => {}

  const stream = new ReadableStream({
    start(controller) {
      const pendingAlerts = new Set<string>()
      const pushes: { id: string; to: string }[] = []
      const kinds = new Set<string>()
      let closed = false
      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          cleanup()
        }
      }
      const onChange = (e: BusEvent) => {
        if (e.type === 'alert') pendingAlerts.add(e.id)
        else if (e.type === 'push') pushes.push({ id: e.id, to: e.to })
        else kinds.add(e.type === 'config' ? `config:${e.what}` : e.type)
      }
      const flush = setInterval(async () => {
        if (pendingAlerts.size) {
          const ids = [...pendingAlerts].slice(-200)
          pendingAlerts.clear()
          send('alerts', await getAlertsByIds(ids).catch(() => []))
        }
        if (pushes.length) send('push', pushes.splice(0))
        if (kinds.size) {
          send('changed', [...kinds])
          kinds.clear()
        }
      }, 200)
      const sendStats = () => stats().then((s) => send('stats', s)).catch(() => {})
      const statsTimer = setInterval(sendStats, 1000)
      const ping = setInterval(() => send('ping', Date.now()), 15000)
      bus.on('change', onChange)
      send('hello', { at: Date.now(), instance: rt().instance })
      void sendStats()
      cleanup = () => {
        closed = true
        clearInterval(flush)
        clearInterval(statsTimer)
        clearInterval(ping)
        bus.off('change', onChange)
      }
      req.signal.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {}
      })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
