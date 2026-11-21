import { handle, json } from '@/lib/engine/api'
import { me } from '@/lib/engine/auth'
import { rt } from '@/lib/engine/runtime'

export const dynamic = 'force-dynamic'

/** The acting person, plus who can be picked in the console's (mocked) sign-in. */
export async function GET(req: Request) {
  return handle(async () =>
    json({
      me: me(req),
      people: rt()
        .recipients.filter((r) => r.kind === 'person')
        .map((r) => ({ id: r.id, name: r.name, role: r.role === 'admin' ? 'admin' : 'user' })),
    })
  )
}
