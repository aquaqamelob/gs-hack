import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { boot } from './boot'

export async function ready() {
  await boot()
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } })
}

export function fail(message: string, status = 400) {
  return json({ error: message }, status)
}

/** SSO is out of scope: the console sends the acting user in a header. */
export function actorOf(req: Request, body?: { actor?: unknown }) {
  const a = (typeof body?.actor === 'string' && body.actor) || req.headers.get('x-actor') || 'console-user'
  return a.slice(0, 80)
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    return {} as T
  }
}

export async function handle(fn: () => Promise<Response>) {
  try {
    await ready()
    return await fn()
  } catch (e) {
    const msg = (e as Error).message
    const status = /not found|unknown/i.test(msg) ? 404 : /ECONNREFUSED|connect/i.test(msg) ? 503 : 400
    return fail(msg, status)
  }
}

const envKey = (source: string) => source.toUpperCase().replace(/[^A-Z0-9]/g, '_')

function safeEqual(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Per-source credentials: INGEST_TOKEN_<SOURCE> / INGEST_HMAC_<SOURCE>, falling back to INGEST_TOKEN / INGEST_HMAC_SECRET.
 * With nothing configured the endpoint is open (local demo only).
 */
export function checkIngestAuth(req: Request, source: string, rawBody: string): string | null {
  const token = process.env[`INGEST_TOKEN_${envKey(source)}`] ?? process.env.INGEST_TOKEN
  const secret = process.env[`INGEST_HMAC_${envKey(source)}`] ?? process.env.INGEST_HMAC_SECRET
  if (!token && !secret) return null
  const auth = req.headers.get('authorization') ?? ''
  if (token && safeEqual(auth, `Bearer ${token}`)) return null
  const sig = req.headers.get('x-signature')?.replace(/^sha256=/, '')
  if (secret && sig) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
    if (safeEqual(sig, expected)) return null
  }
  return 'Unauthorized: send "Authorization: Bearer <token>" or "X-Signature: sha256=<hmac of body>"'
}
