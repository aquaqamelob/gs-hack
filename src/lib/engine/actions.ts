import { rt } from './runtime'
import type { Json, StepDef, WebhookAction } from './types'
import { render, renderDeep } from './util'

export interface ActionResult {
  ok: boolean
  output: string
}

export const allowedHosts = () =>
  (process.env.ACTION_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,mock-gateway,counterparty-service,workflow-api,escalation-api')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)

/** Env vars a runbook may reference as {{env.NAME}}. Everything else renders empty so a runbook cannot exfiltrate secrets. */
const envAllowed = (name: string) =>
  (process.env.ACTION_ENV_ALLOWLIST ?? 'WORKFLOW_API,ESCALATION_API,WORKFLOW_API_TOKEN,ESCALATION_API_TOKEN')
    .split(',')
    .map((s) => s.trim())
    .includes(name)

const MASK = '•••'

/**
 * Expand a step into the one action kind we execute: an HTTP call.
 * `action: webhook` uses the step params directly; any other name is looked up in config/actions.yaml.
 */
export function resolveWebhook(
  step: Pick<StepDef, 'action' | 'params'>,
  fields: (path: string) => unknown,
  revealSecrets: boolean
): WebhookAction | { error: string } {
  if (!step.action) return { error: 'Manual step' }
  const params = step.params ?? {}
  const template: WebhookAction | undefined =
    step.action === 'webhook'
      ? {
          method: String(params.method ?? 'POST'),
          url: String(params.url ?? ''),
          headers: (params.headers as Record<string, string>) ?? undefined,
          body: params.body ?? undefined,
        }
      : rt().actions[step.action]
  if (!template) return { error: `Unknown action "${step.action}". Add it to config/actions.yaml.` }

  const resolve = (p: string): unknown => {
    if (p.startsWith('env.')) {
      const name = p.slice(4)
      if (!envAllowed(name)) return ''
      return revealSecrets || !/TOKEN|SECRET|KEY|PASSWORD/i.test(name) ? process.env[name] ?? '' : MASK
    }
    if (p in params) return params[p]
    return fields(p)
  }
  return {
    method: String(template.method ?? 'POST').toUpperCase(),
    url: render(String(template.url ?? ''), resolve),
    headers: template.headers
      ? (renderDeep(template.headers as unknown as Json, resolve) as Record<string, string>)
      : undefined,
    body: template.body !== undefined ? renderDeep(template.body, resolve) : undefined,
  }
}

export function checkUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `Invalid URL "${url}"`
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return `Blocked: only http(s) is allowed`
  if (parsed.username || parsed.password) return 'Blocked: credentials in URL'
  const host = parsed.hostname.toLowerCase()
  if (!allowedHosts().includes(host)) return `Blocked: host "${host}" is not in ACTION_ALLOWED_HOSTS`
  return null
}

export async function runWebhook(action: WebhookAction, idempotencyKey: string): Promise<ActionResult> {
  const blocked = checkUrl(action.url)
  if (blocked) return { ok: false, output: blocked }
  try {
    const hasBody = action.body !== undefined && action.method !== 'GET'
    const res = await fetch(action.url, {
      method: action.method,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        'idempotency-key': idempotencyKey,
        ...(action.headers ?? {}),
      },
      body: hasBody ? JSON.stringify(action.body) : undefined,
      signal: AbortSignal.timeout(Number(process.env.ACTION_TIMEOUT_MS ?? 5000)),
      redirect: 'error',
    })
    const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
    return { ok: res.ok, output: `${action.method} ${action.url} → ${res.status} ${text}`.trim() }
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code
    return { ok: false, output: `${action.method} ${action.url} failed: ${cause ?? (e as Error).message}` }
  }
}
