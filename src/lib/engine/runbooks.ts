import YAML from 'yaml'
import { rt } from './runtime'
import type { Json, Runbook, StepDef } from './types'

type RawStep = Record<string, Json>

const RESERVED = new Set(['id', 'text', 'check', 'title', 'name', 'description', 'if', 'when', 'approval', 'action'])

export function actionApproval(action: string | undefined): StepDef['approval'] {
  return action && rt().actions[action]?.approval === 'required' ? 'required' : 'none'
}

function approvalOf(value: Json | undefined, action: string | undefined): StepDef['approval'] {
  if (value === 'required' || value === true || value === 'yes') return 'required'
  if (value === 'none' || value === false || value === 'no') return 'none'
  return actionApproval(action)
}

export function describeAction(action: string, params: Record<string, Json>) {
  const def = rt().actions[action]
  if (action === 'webhook') return `${params.method ?? 'POST'} ${params.url ?? ''}`.trim()
  const hint = Object.entries(params)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([, v]) => String(v))
    .join(' ')
  return `${def?.description ?? action.replace(/_/g, ' ')}${hint ? ` ${hint}` : ''}`
}

function fromYamlStep(raw: RawStep, i: number): StepDef {
  let action: string | undefined
  let params: Record<string, Json> = {}
  if (raw.action && typeof raw.action === 'object' && !Array.isArray(raw.action)) {
    const { kind, ...rest } = raw.action as Record<string, Json>
    action = String(kind ?? 'webhook')
    params = rest
  } else if (typeof raw.action === 'string') {
    action = raw.action
  }
  for (const [k, v] of Object.entries(raw)) if (!RESERVED.has(k)) params[k] = v
  const text = String(
    raw.text ?? raw.check ?? raw.title ?? raw.name ?? raw.description ?? (action ? describeAction(action, params) : `Step ${i + 1}`)
  )
  const when = raw.if ?? raw.when
  return {
    id: String(raw.id ?? `s${i + 1}`),
    text,
    ...(action ? { action, params } : {}),
    approval: approvalOf(raw.approval, action),
    ...(when ? { when: String(when) } : {}),
  }
}

const NEEDS_APPROVAL =
  /\b(needs?|requires?|with|after|only with|get)\b[^.]*\b(approv\w*|sign[- ]?off|ok from|go[- ]ahead)\b|\bapprov(al|e)\b|\bconfirm with\b/i

export function textStep(text: string, i: number): StepDef {
  const clean = text.replace(/\s+/g, ' ').trim()
  const cond = clean.match(/^(?:and\s+)?if\s+(.+?)[,:]\s*(.+)$/i)
  return {
    id: `s${i + 1}`,
    text: cond ? cond[2] : clean,
    approval: NEEDS_APPROVAL.test(clean) ? 'required' : 'none',
    ...(cond ? { when: cond[1] } : {}),
  }
}

export function parseRunbookContent(id: string, format: Runbook['format'], content: string): Omit<Runbook, 'file'> {
  if (format === 'yaml') {
    const doc = (YAML.parse(content) ?? {}) as Record<string, Json>
    const steps = Array.isArray(doc.steps) ? (doc.steps as RawStep[]).map(fromYamlStep) : []
    return {
      id: String(doc.runbook ?? doc.id ?? id),
      title: String(doc.title ?? doc.runbook ?? id),
      format,
      content,
      matches: (doc.matches as Record<string, Json>) ?? undefined,
      steps,
      parsedBy: 'parser',
    }
  }
  if (format === 'markdown') {
    const lines = content.split('\n')
    const title =
      lines
        .find((l) => /^#\s+/.test(l))
        ?.replace(/^#\s+/, '')
        .trim() ?? id
    const items = lines
      .map((l) => l.match(/^\s*(?:\d+[.)]|[-*+])\s+(?:\[[ xX]\]\s+)?(.+)$/)?.[1])
      .filter((x): x is string => Boolean(x))
    const steps = items.length
      ? items.map(textStep)
      : [textStep(lines.filter((l) => !/^#/.test(l)).join(' '), 0)]
    return { id, title, format, content, steps, parsedBy: 'parser' }
  }
  // Free text or a wiki dump: one readable step. The LLM can propose structure on request; a human approves it.
  const text = content.replace(/\s+/g, ' ').trim()
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? id
  return {
    id,
    title: firstSentence.length <= 80 ? firstSentence.replace(/[.!?]$/, '') : id,
    format,
    content,
    steps: [{ id: 's1', text, approval: NEEDS_APPROVAL.test(text) ? 'required' : 'none' }],
    parsedBy: 'fallback',
  }
}

export function detectFormat(fileOrContent: string, content?: string): Runbook['format'] {
  if (content !== undefined) {
    if (/\.ya?ml$/i.test(fileOrContent)) return 'yaml'
    if (/\.(md|markdown)$/i.test(fileOrContent)) return 'markdown'
    return 'text'
  }
  const c = fileOrContent.trim()
  if (/^(runbook|steps|title|matches)\s*:/m.test(c)) return 'yaml'
  if (/^#\s|^\s*(\d+[.)]|[-*+])\s+/m.test(c)) return 'markdown'
  return 'text'
}

export function parseRunbook(file: string, content: string): Runbook {
  const id = file.replace(/\.[^.]+$/, '')
  const parsed = parseRunbookContent(id, detectFormat(file, content), content)
  return { ...parsed, id, file }
}
