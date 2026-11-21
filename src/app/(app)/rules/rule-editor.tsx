'use client'

import { Button } from '@/components/button'
import { Checkbox } from '@/components/checkbox'
import { Subheading } from '@/components/heading'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { Textarea } from '@/components/textarea'
import { api } from '@/lib/client'
import {
  CHANNELS,
  type Condition,
  type ConditionOp,
  type Json,
  type Route,
  type Rule,
  type Severity,
} from '@/lib/engine/types'
import { useState } from 'react'
import YAML from 'yaml'

export type RuleRow = Rule & { summary: string }
export type Meta = {
  rules: RuleRow[]
  fields: string[]
  recipients: { id: string; name: string; kind: string }[]
  runbooks: { id: string; title: string; format: string }[]
  me: { id: string; name: string; role: 'admin' | 'user'; teams: string[]; known: boolean }
}
type Leaf = { field: string; op: ConditionOp; value?: Json }

const OPS: { op: ConditionOp; label: string }[] = [
  { op: 'eq', label: 'is' },
  { op: 'neq', label: 'is not' },
  { op: 'in', label: 'is one of' },
  { op: 'not_in', label: 'is none of' },
  { op: 'gt', label: 'greater than' },
  { op: 'gte', label: 'at least' },
  { op: 'lt', label: 'less than' },
  { op: 'lte', label: 'at most' },
  { op: 'glob', label: 'matches pattern (*)' },
  { op: 'regex', label: 'matches regex' },
  { op: 'exists', label: 'exists (true/false)' },
]

const COLORS = ['', 'red', 'orange', 'amber', 'green', 'sky', 'blue', 'violet', 'zinc']

export const blank = (): Rule => ({
  id: '',
  name: '',
  team: '',
  enabled: true,
  when: { all: [{ field: 'severity', op: 'gte', value: 'error' }] },
  notify: [{ to: '' }],
  present: { title: '{{title}} on {{service}}', body: '{{error.message}}', fields: [] },
  group_by: ['source', 'title', 'service', 'error.code'],
  group_wait: '0s',
  group_interval: '5m',
  dedup_window: '1h',
})

function isFlat(c: Condition): c is { all: Leaf[] } | { any: Leaf[] } {
  const list = 'all' in c ? c.all : 'any' in c ? c.any : null
  return list !== null && list.every((x) => 'field' in x)
}

function valueToText(v: Json | undefined) {
  return Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v)
}

function textToValue(op: ConditionOp, text: string): Json {
  if (op === 'exists') return text.trim().toLowerCase() !== 'false'
  if (op === 'in' || op === 'not_in')
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && text.trim() !== '' && !isNaN(Number(text))) return Number(text)
  return text
}

function ConditionEditor({
  when,
  fields,
  onChange,
}: {
  when: Condition
  fields: string[]
  onChange: (c: Condition) => void
}) {
  if (!isFlat(when)) {
    return <Text>This rule has nested AND/OR groups. Edit it in the YAML tab.</Text>
  }
  const mode = 'all' in when ? 'all' : 'any'
  const rows = ('all' in when ? when.all : when.any) as Leaf[]
  const set = (next: Leaf[], m = mode) => onChange(m === 'all' ? { all: next } : { any: next })
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        Alert when
        <Select value={mode} onChange={(e) => set(rows, e.target.value as 'all' | 'any')} className="w-auto">
          <option value="all">ALL of these are true (AND)</option>
          <option value="any">ANY of these is true (OR)</option>
        </Select>
      </div>
      <datalist id="field-list">
        {fields.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
          <Input
            list="field-list"
            value={r.field}
            placeholder="field, e.g. payload.notional"
            onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
          />
          <Select
            value={r.op}
            onChange={(e) =>
              set(
                rows.map((x, j) =>
                  j === i
                    ? {
                        ...x,
                        op: e.target.value as ConditionOp,
                        value: textToValue(e.target.value as ConditionOp, valueToText(x.value)),
                      }
                    : x
                )
              )
            }
          >
            {OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </Select>
          <Input
            value={valueToText(r.value)}
            placeholder={r.op === 'in' || r.op === 'not_in' ? 'A, B, C' : r.op === 'exists' ? 'true / false' : 'value'}
            onChange={(e) =>
              set(rows.map((x, j) => (j === i ? { ...x, value: textToValue(x.op, e.target.value) } : x)))
            }
          />
          <Button plain onClick={() => set(rows.filter((_, j) => j !== i))} aria-label="Remove condition">
            ✕
          </Button>
        </div>
      ))}
      <Button outline onClick={() => set([...rows, { field: '', op: 'eq', value: '' }])}>
        + Add condition
      </Button>
    </div>
  )
}

function RouteEditor({
  routes,
  recipients,
  onChange,
}: {
  routes: Route[]
  recipients: Meta['recipients']
  onChange: (r: Route[]) => void
}) {
  const update = (i: number, patch: Partial<Route>) =>
    onChange(routes.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-3">
      {routes.map((r, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-zinc-950/10 p-3 dark:border-white/10">
          <div className="flex items-center gap-2">
            <Select value={r.to} onChange={(e) => update(i, { to: e.target.value })}>
              <option value="">Choose a team or person…</option>
              {recipients.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.kind})
                </option>
              ))}
            </Select>
            <Button plain onClick={() => onChange(routes.filter((_, j) => j !== i))} aria-label="Remove recipient">
              ✕
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={!r.channels} onChange={(v) => update(i, { channels: v ? undefined : ['ui'] })} />
              Use their preferences
            </label>
            {r.channels &&
              CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-1.5">
                  <Checkbox
                    checked={r.channels!.includes(c)}
                    onChange={(v) =>
                      update(i, { channels: v ? [...r.channels!, c] : r.channels!.filter((x) => x !== c) })
                    }
                  />
                  {c}
                </label>
              ))}
          </div>
        </div>
      ))}
      <Button outline onClick={() => onChange([...routes, { to: '' }])}>
        + Add recipient
      </Button>
      <Text>
        Working hours (e.g. “SMS 08–20, otherwise email”) are part of each person’s preferences on the People page.
      </Text>
    </div>
  )
}

function SelfChannels({ route, onChange }: { route: Route; onChange: (r: Route) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox
          checked={!route.channels}
          onChange={(v) => onChange({ ...route, channels: v ? undefined : ['ui'] })}
        />
        Use my channel preferences
      </label>
      {route.channels &&
        CHANNELS.map((c) => (
          <label key={c} className="flex items-center gap-1.5">
            <Checkbox
              checked={route.channels!.includes(c)}
              onChange={(v) =>
                onChange({ ...route, channels: v ? [...route.channels!, c] : route.channels!.filter((x) => x !== c) })
              }
            />
            {c}
          </label>
        ))}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  )
}

/** A personal filter is owned by one person and notifies only them; the owner and recipient are fixed. */
export function personalBlank(personId: string): Rule {
  return {
    ...blank(),
    team: personId,
    notify: [{ to: personId }],
    group_by: ['source', 'title', 'service', 'error.code'],
  }
}

export function RuleEditor({
  initial,
  meta,
  onClose,
  personal,
}: {
  initial: Rule | null
  meta: Meta
  onClose: (saved: boolean) => void
  /** Set when a person edits their own filter: owner and recipient are locked to them. */
  personal?: { id: string; name: string }
}) {
  const [rule, setRule] = useState<Rule>(
    initial ? structuredClone(initial) : personal ? personalBlank(personal.id) : blank()
  )
  const [tab, setTab] = useState<'form' | 'yaml'>('form')
  const [yamlText, setYamlText] = useState('')
  const [error, setError] = useState('')
  const [test, setTest] = useState<{
    tested: number
    matched: number
    alerts: number
    samples: { title: string; schema: string }[]
  } | null>(null)
  const previousId = initial?.id

  const patch = (p: Partial<Rule>) => setRule((r) => ({ ...r, ...p }))

  const switchTab = (t: 'form' | 'yaml') => {
    setError('')
    if (t === 'yaml') {
      const { summary: _s, ...clean } = rule as RuleRow
      setYamlText(YAML.stringify(clean, { lineWidth: 0 }))
    } else {
      try {
        setRule(YAML.parse(yamlText))
      } catch (e) {
        setError(`YAML: ${(e as Error).message}`)
        return
      }
    }
    setTab(t)
  }

  const current = (): Rule => (tab === 'yaml' ? YAML.parse(yamlText) : rule)

  const runTest = async () => {
    setError('')
    try {
      setTest(await api('/api/rules/test', { body: { rule: current() } }))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const save = async () => {
    setError('')
    try {
      const r = current()
      if (personal) {
        r.team = personal.id
        r.notify = [{ to: personal.id, ...(r.notify[0]?.channels ? { channels: r.notify[0].channels } : {}) }]
      }
      if (!r.id) {
        const base = r.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 50)
        r.id = personal && base ? `${personal.id}-${base}`.slice(0, 60) : base
      }
      await api('/api/rules', { method: 'PUT', body: { rule: r, previousId } })
      onClose(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-zinc-950/10 p-6 dark:border-white/10">
      <div className="flex items-center justify-between">
        <Subheading>{initial ? `Edit “${initial.name}”` : 'New rule'}</Subheading>
        <div className="flex rounded-lg border border-zinc-950/10 p-0.5 text-sm dark:border-white/10">
          {(['form', 'yaml'] as const).map((t) => (
            <button
              key={t}
              onClick={() => switchTab(t)}
              className={`rounded-md px-3 py-1 ${tab === t ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : ''}`}
            >
              {t === 'form' ? 'Form' : 'YAML'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'yaml' ? (
        <Textarea
          rows={24}
          value={yamlText}
          onChange={(e) => setYamlText(e.target.value)}
          className="mt-4 font-mono text-xs"
        />
      ) : (
        <div className="mt-4 space-y-8">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Rule name">
              <Input
                value={rule.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="Large rejected trades"
              />
            </Field>
            {personal ? (
              <Field label="Owner" hint="your personal filter">
                <Input value={personal.name} disabled />
              </Field>
            ) : (
              <Field label="Owning team" hint="whose feed shows these alerts">
                <Select value={rule.team} onChange={(e) => patch({ team: e.target.value })}>
                  <option value="">Choose…</option>
                  {meta.recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Runbook">
              <Select value={rule.runbook ?? ''} onChange={(e) => patch({ runbook: e.target.value || undefined })}>
                <option value="">None (or match by runbook “matches”)</option>
                {meta.runbooks.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} ({r.format})
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <section>
            <div className="text-sm font-semibold">1. Which events?</div>
            <Text>
              Use canonical fields (severity, service, environment, title, error.code, entity_id…), <code>source</code>,
              or any raw path from the event.
            </Text>
            <div className="mt-3">
              <ConditionEditor when={rule.when} fields={meta.fields} onChange={(when) => patch({ when })} />
            </div>
          </section>

          <section>
            <div className="text-sm font-semibold">
              {personal ? '2. How do you want to be told?' : '2. Who gets notified, and how?'}
            </div>
            <div className="mt-3">
              {personal ? (
                <SelfChannels
                  route={rule.notify[0] ?? { to: personal.id }}
                  onChange={(r) => patch({ notify: [{ ...r, to: personal.id }] })}
                />
              ) : (
                <RouteEditor
                  routes={rule.notify}
                  recipients={meta.recipients}
                  onChange={(notify) => patch({ notify })}
                />
              )}
            </div>
          </section>

          <section>
            <div className="text-sm font-semibold">3. How does the alert look?</div>
            <Text>
              Use {'{{field}}'} placeholders, e.g. {'{{payload.notional | number}}'}.
            </Text>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Title">
                <Input
                  value={rule.present?.title ?? ''}
                  onChange={(e) => patch({ present: { ...rule.present, title: e.target.value } })}
                />
              </Field>
              <Field label="Body">
                <Input
                  value={rule.present?.body ?? ''}
                  onChange={(e) => patch({ present: { ...rule.present, body: e.target.value } })}
                />
              </Field>
              <Field label="Fields to show" hint="comma-separated">
                <Input
                  value={(rule.present?.fields ?? []).join(', ')}
                  onChange={(e) =>
                    patch({
                      present: {
                        ...rule.present,
                        fields: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Colour">
                  <Select
                    value={rule.present?.color ?? ''}
                    onChange={(e) => patch({ present: { ...rule.present, color: e.target.value || undefined } })}
                  >
                    {COLORS.map((c) => (
                      <option key={c} value={c}>
                        {c || 'by severity'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Severity">
                  <Select
                    value={rule.present?.severity ?? ''}
                    onChange={(e) =>
                      patch({
                        present: { ...rule.present, severity: (e.target.value || undefined) as Severity | undefined },
                      })
                    }
                  >
                    <option value="">from event</option>
                    <option>critical</option>
                    <option>error</option>
                    <option>warning</option>
                    <option>info</option>
                  </Select>
                </Field>
              </div>
            </div>
          </section>

          <section>
            <div className="text-sm font-semibold">4. Don’t flood people</div>
            <Text>Alertmanager semantics. Durations like 30s, 5m, 1h.</Text>
            <div className="mt-3 grid gap-4 sm:grid-cols-4">
              <Field label="group_by" hint="same values → same alert, counter goes up">
                <Input
                  value={(rule.group_by ?? []).join(', ')}
                  onChange={(e) =>
                    patch({
                      group_by: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </Field>
              <Field label="group_wait" hint="wait before the first message">
                <Input
                  value={String(rule.group_wait ?? '0s')}
                  onChange={(e) => patch({ group_wait: e.target.value })}
                />
              </Field>
              <Field label="group_interval" hint="at most one update per">
                <Input
                  value={String(rule.group_interval ?? '5m')}
                  onChange={(e) => patch({ group_interval: e.target.value })}
                />
              </Field>
              <Field label="dedup_window" hint="quiet this long → next event is a new alert">
                <Input
                  value={String(rule.dedup_window ?? '1h')}
                  onChange={(e) => patch({ dedup_window: e.target.value })}
                />
              </Field>
            </div>
          </section>
        </div>
      )}

      {test && (
        <div className="mt-6 rounded-lg bg-zinc-50 p-4 text-sm dark:bg-zinc-800/50">
          <strong>
            {test.matched} of the last {test.tested} events
          </strong>{' '}
          would match, grouped into <strong>{test.alerts}</strong> alert{test.alerts === 1 ? '' : 's'}.
          <ul className="mt-1 list-disc pl-5">
            {test.samples.map((s, i) => (
              <li key={i}>
                {s.title} <span className="text-zinc-500">({s.schema})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      <div className="mt-6 flex gap-2">
        <Button color="dark/zinc" onClick={save}>
          Save (live, no restart)
        </Button>
        <Button outline onClick={runTest}>
          Preview against last 100 events
        </Button>
        <Button plain onClick={() => onClose(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function RuleSummary({ r }: { r: RuleRow }) {
  return (
    <>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">When</span> {r.summary}
      </p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">Notify</span>{' '}
        {r.notify.map((n) => `${n.to} via ${n.channels?.join(' + ') ?? 'their preferences'}`).join('; ')}
      </p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">Group by</span>{' '}
        {(r.group_by ?? ['source', 'title', 'service', 'error.code']).join(', ')} · wait {String(r.group_wait ?? '0s')}{' '}
        · interval {String(r.group_interval ?? '5m')}
      </p>
    </>
  )
}
