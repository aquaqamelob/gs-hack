import { handle } from '@/lib/engine/api'
import { rulesYaml } from '@/lib/engine/config'

export const dynamic = 'force-dynamic'

/** Current rules as YAML (same shape as config/rules.yaml), for review and version control. */
export async function GET() {
  return handle(async () =>
    new Response(rulesYaml(), {
      headers: {
        'content-type': 'application/yaml; charset=utf-8',
        'content-disposition': 'inline; filename="rules.yaml"',
        'cache-control': 'no-store',
      },
    })
  )
}
