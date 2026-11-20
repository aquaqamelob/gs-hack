'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Stats } from './engine/metrics'
import type { Alert } from './engine/types'

export type AlertSummary = Omit<Alert, 'raw' | 'canonical'>

export type Metrics = Stats

const ACTOR_KEY = 'gs-alerting.actor'

export function useActor() {
  const [actor, setActorState] = useState('console-user')
  useEffect(() => {
    const stored = localStorage.getItem(ACTOR_KEY)
    if (stored) setActorState(stored)
    const onChange = () => setActorState(localStorage.getItem(ACTOR_KEY) || 'console-user')
    window.addEventListener('actor-changed', onChange)
    return () => window.removeEventListener('actor-changed', onChange)
  }, [])
  const setActor = useCallback((a: string) => {
    localStorage.setItem(ACTOR_KEY, a)
    window.dispatchEvent(new Event('actor-changed'))
  }, [])
  return [actor, setActor] as const
}

export type Level = 'simple' | 'standard' | 'expert'
export const LEVELS: { id: Level; label: string; hint: string }[] = [
  { id: 'simple', label: 'Simple', hint: 'Plain language, only what you need to act' },
  { id: 'standard', label: 'Standard', hint: 'Field names, rules and details' },
  { id: 'expert', label: 'Expert', hint: 'Raw paths, formats, confidence, JSON' },
]
const LEVEL_KEY = 'ctrl.level'

/** Readability level for the whole console, remembered per browser. */
export function useLevel() {
  const [level, setLevelState] = useState<Level>('standard')
  useEffect(() => {
    const read = () => setLevelState((localStorage.getItem(LEVEL_KEY) as Level) || 'standard')
    read()
    window.addEventListener('level-changed', read)
    return () => window.removeEventListener('level-changed', read)
  }, [])
  const setLevel = useCallback((l: Level) => {
    localStorage.setItem(LEVEL_KEY, l)
    window.dispatchEvent(new Event('level-changed'))
  }, [])
  return [level, setLevel] as const
}

function currentActor() {
  return (typeof window !== 'undefined' && localStorage.getItem(ACTOR_KEY)) || 'console-user'
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-actor': currentActor() },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error(
      (data as { error?: string; message?: string }).error ??
        (data as { message?: string }).message ??
        `HTTP ${res.status}`
    )
  return data as T
}

type Listener = {
  onAlerts?: (a: AlertSummary[]) => void
  onStats?: (m: Metrics) => void
  onChanged?: (kinds: string[]) => void
}

let source: EventSource | null = null
const listeners = new Set<Listener>()
const connectionListeners = new Set<(c: boolean) => void>()
let connected = false

function ensureSource() {
  if (source || typeof window === 'undefined') return
  source = new EventSource('/api/stream')
  const setConnected = (c: boolean) => {
    connected = c
    connectionListeners.forEach((l) => l(c))
  }
  source.addEventListener('hello', () => setConnected(true))
  source.addEventListener('error', () => setConnected(false))
  source.addEventListener('alerts', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as AlertSummary[]
    listeners.forEach((l) => l.onAlerts?.(data))
  })
  source.addEventListener('stats', (e) => {
    setConnected(true)
    const data = JSON.parse((e as MessageEvent).data) as Metrics
    listeners.forEach((l) => l.onStats?.(data))
  })
  source.addEventListener('changed', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as string[]
    listeners.forEach((l) => l.onChanged?.(data))
  })
}

export function useLive(listener: Listener) {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => {
    ensureSource()
    const l: Listener = {
      onAlerts: (a) => ref.current.onAlerts?.(a),
      onStats: (m) => ref.current.onStats?.(m),
      onChanged: (k) => ref.current.onChanged?.(k),
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
}

export function useConnected() {
  const [c, setC] = useState(connected)
  useEffect(() => {
    ensureSource()
    connectionListeners.add(setC)
    return () => {
      connectionListeners.delete(setC)
    }
  }, [])
  return c
}

export function useMetrics() {
  const [m, setM] = useState<Metrics | null>(null)
  useLive({ onStats: setM })
  return m
}

export function timeAgo(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function useNow(intervalMs = 5000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export const SEVERITY_BADGE = { critical: 'red', error: 'orange', warning: 'amber', info: 'sky' } as const

export const COLOR_BAR: Record<string, string> = {
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-400',
  yellow: 'bg-yellow-400',
  green: 'bg-green-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  zinc: 'bg-zinc-400',
}

export const COLOR_TEXT: Record<string, string> = {
  red: 'text-red-600 dark:text-red-400',
  orange: 'text-orange-600 dark:text-orange-400',
  amber: 'text-amber-700 dark:text-amber-400',
  yellow: 'text-yellow-700 dark:text-yellow-300',
  green: 'text-green-700 dark:text-green-400',
  sky: 'text-sky-700 dark:text-sky-400',
  blue: 'text-blue-700 dark:text-blue-400',
  violet: 'text-violet-700 dark:text-violet-400',
  zinc: 'text-zinc-700 dark:text-zinc-300',
}
