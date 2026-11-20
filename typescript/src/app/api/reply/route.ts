import { fail, handle, json, readJson } from '@/lib/engine/api'
import { handleReply } from '@/lib/engine/alerts'

export const dynamic = 'force-dynamic'

/** Inbound SMS/email reply webhook: "ACK 4821", "YES 4821", "RESOLVE 4821". */
export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson<{ from?: string; text?: string }>(req)
    if (!body.from || !body.text) return fail('from and text are required')
    const result = await handleReply(body.from.slice(0, 60), body.text.slice(0, 200))
    return json(result, result.ok ? 200 : 400)
  })
}
