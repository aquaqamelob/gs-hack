import { checkIngestAuth, fail, handle, json } from '@/lib/engine/api'
import { handleReply } from '@/lib/engine/alerts'

export const dynamic = 'force-dynamic'

/**
 * Inbound SMS/email reply webhook from the gateway: {from, text} with "ACK 482113", "YES 482113" or "RESOLVE 482113".
 * Authenticated like an ingest source named "reply": INGEST_TOKEN_REPLY (bearer) or INGEST_HMAC_REPLY (X-Signature).
 */
export async function POST(req: Request) {
  return handle(async () => {
    const raw = await req.text()
    const denied = checkIngestAuth(req, 'reply', raw)
    if (denied) return fail(denied, 401)
    let body: { from?: unknown; text?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      return fail('Malformed JSON')
    }
    if (typeof body?.from !== 'string' || typeof body.text !== 'string' || !body.from || !body.text)
      return fail('from and text are required')
    const result = await handleReply(body.from.slice(0, 120), body.text.slice(0, 200))
    return json(result, result.status)
  })
}
