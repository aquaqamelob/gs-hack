import { ready } from '@/lib/engine/api'
import { prometheus } from '@/lib/engine/metrics'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ready()
  return new Response(prometheus(), { headers: { 'content-type': 'text/plain; version=0.0.4' } })
}
