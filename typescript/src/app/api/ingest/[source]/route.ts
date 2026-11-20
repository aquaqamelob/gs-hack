import { checkIngestAuth, fail, handle, json } from '@/lib/engine/api'
import { ingest } from '@/lib/engine/pipeline'
import { parseLogLine } from '@/lib/engine/schema'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** 202 for anything parseable — unknown schemas are never rejected. 400 malformed JSON, 401 bad credentials. */
export async function POST(req: Request, { params }: { params: { source: string } }) {
  const receivedAt = Date.now()
  const source = params.source.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'webhook'
  const body = await req.text()
  const authError = checkIngestAuth(req, source, body)
  if (authError) return fail(authError, 401)
  if (body.length > 1_000_000) return fail('Payload too large', 413)

  let payload: unknown
  if ((req.headers.get('content-type') ?? '').startsWith('text/plain')) {
    payload = body.split('\n').map(parseLogLine).filter(Boolean)
  } else {
    try {
      payload = JSON.parse(body)
    } catch {
      return fail('Malformed JSON. Send application/json, or text/plain for log lines.')
    }
  }
  return handle(async () => json(await ingest(payload, source, receivedAt), 202))
}
