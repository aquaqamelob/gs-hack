import { handle, json } from '@/lib/engine/api'
import { listAlerts } from '@/lib/engine/alerts'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url)
    const alerts = await listAlerts({
      team: url.searchParams.get('team') || undefined,
      status: url.searchParams.get('status') || undefined,
      limit: Number(url.searchParams.get('limit') ?? 200),
    })
    return json({ alerts })
  })
}
