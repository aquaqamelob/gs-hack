import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import type { CustomField, Recipient, Rule, Runbook, SchemaRecord, WebhookAction } from './types'

/**
 * Per-instance memory. Nothing here is authoritative: config comes from YAML files,
 * the schema cache mirrors Postgres, counters are this instance's Prometheus metrics.
 */
export interface Runtime {
  instance: string
  rules: Rule[]
  /** Custom canonical fields from config/fields.yaml. */
  fields: CustomField[]
  recipients: Recipient[]
  defaultOwner: string
  runbooks: Map<string, Runbook>
  actions: Record<string, WebhookAction & { approval?: 'none' | 'required'; description?: string }>
  schemas: Map<string, SchemaRecord>
  counters: Map<string, number>
  bus: EventEmitter
  booted?: Promise<void>
}

const KEY = Symbol.for('ctrl.runtime.v1')

export function rt(): Runtime {
  const g = globalThis as unknown as Record<symbol, Runtime | undefined>
  if (!g[KEY]) {
    const bus = new EventEmitter()
    bus.setMaxListeners(10_000)
    g[KEY] = {
      instance: process.env.INSTANCE_ID || `${hostname()}-${process.pid}`,
      rules: [],
      fields: [],
      recipients: [],
      defaultOwner: 'team-platform',
      runbooks: new Map(),
      actions: {},
      schemas: new Map(),
      counters: new Map(),
      bus,
    }
  }
  return g[KEY]!
}

export function count(name: string, by = 1) {
  const c = rt().counters
  c.set(name, (c.get(name) ?? 0) + by)
}

/** Events fanned out to SSE clients. They arrive via Postgres NOTIFY so every instance sees every change. */
export type BusEvent =
  | { type: 'alert'; id: string }
  | { type: 'push'; id: string; to: string }
  | { type: 'schema'; id: string }
  | { type: 'config'; what: string }
  | { type: 'audit' }
