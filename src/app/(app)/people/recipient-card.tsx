'use client'

import { Badge } from '@/components/badge'
import { Button } from '@/components/button'
import { Checkbox } from '@/components/checkbox'
import { Input } from '@/components/input'
import { Select } from '@/components/select'
import { Text } from '@/components/text'
import { api } from '@/lib/client'
import { CHANNELS, SEVERITIES, type Channel, type Recipient } from '@/lib/engine/types'
import { useEffect, useState } from 'react'

export type Row = Recipient & { onShift?: boolean; onCallName?: string }

function WorkingHours({ draft, setDraft }: { draft: Recipient; setDraft: (r: Recipient) => void }) {
  const h = draft.working_hours
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox
          checked={Boolean(h)}
          onChange={(v) =>
            setDraft({
              ...draft,
              working_hours: v ? { from: '08:00', to: '20:00', tz: 'Europe/Warsaw', outside: ['email'] } : undefined,
            })
          }
        />
        Working hours
      </label>
      {h && (
        <>
          <Input
            type="time"
            value={h.from}
            onChange={(e) => setDraft({ ...draft, working_hours: { ...h, from: e.target.value } })}
            className="w-28"
          />
          –
          <Input
            type="time"
            value={h.to}
            onChange={(e) => setDraft({ ...draft, working_hours: { ...h, to: e.target.value } })}
            className="w-28"
          />
          , otherwise
          <Select
            value={h.outside[0]}
            onChange={(e) => setDraft({ ...draft, working_hours: { ...h, outside: [e.target.value as Channel] } })}
            className="w-auto"
          >
            {CHANNELS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          <span className="text-xs text-zinc-500">{h.tz}</span>
        </>
      )}
    </div>
  )
}

export function RecipientCard({
  r,
  all,
  onSaved,
  editable = true,
  isAdmin = false,
}: {
  r: Row
  all: Recipient[]
  onSaved: () => void
  /** False: shown read-only (someone else's preferences, and you are not an admin). */
  editable?: boolean
  /** Admins also set a person's role and team membership. */
  isAdmin?: boolean
}) {
  const { onShift, onCallName: _onCallName, ...base } = r
  const [draft, setDraft] = useState<Recipient>(base)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setDraft(base), [JSON.stringify(base)]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)

  return (
    <div className="rounded-xl border border-zinc-950/10 p-4 dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{r.name}</span>
        <Badge color={r.kind === 'team' ? 'blue' : 'zinc'}>{r.kind}</Badge>
        <span className="text-xs text-zinc-500">{r.id}</span>
        {r.role === 'admin' && <Badge color="purple">admin</Badge>}
        {r.working_hours && (
          <Badge color={onShift ? 'green' : 'zinc'}>{onShift ? 'in working hours' : 'outside working hours'}</Badge>
        )}
        {!editable && <span className="ml-auto text-xs text-zinc-500">read-only</span>}
      </div>
      {r.kind === 'person' && isAdmin && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={draft.role === 'admin'}
              onChange={(v) => setDraft({ ...draft, role: v ? 'admin' : undefined })}
            />
            Admin
          </label>
          <span className="text-zinc-500">Member of:</span>
          {all
            .filter((x) => x.kind === 'team')
            .map((t) => {
              const teams = draft.teams ?? []
              return (
                <label key={t.id} className="flex items-center gap-1.5">
                  <Checkbox
                    checked={teams.includes(t.id)}
                    onChange={(v) =>
                      setDraft({ ...draft, teams: v ? [...teams, t.id] : teams.filter((x) => x !== t.id) })
                    }
                  />
                  {t.name}
                </label>
              )
            })}
        </div>
      )}
      {r.kind === 'person' && !isAdmin && (r.teams?.length ?? 0) > 0 && (
        <Text className="mt-2">Member of {r.teams!.map((t) => all.find((x) => x.id === t)?.name ?? t).join(', ')}</Text>
      )}
      <fieldset disabled={!editable} className={editable ? '' : 'opacity-70'}>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Input
            value={draft.email ?? ''}
            placeholder="email"
            onChange={(e) => setDraft({ ...draft, email: e.target.value || undefined })}
          />
          {r.kind === 'person' ? (
            <Input
              value={draft.phone ?? ''}
              placeholder="phone"
              onChange={(e) => setDraft({ ...draft, phone: e.target.value || undefined })}
            />
          ) : (
            <Select
              value={draft.onCall ?? ''}
              onChange={(e) => setDraft({ ...draft, onCall: e.target.value || undefined })}
            >
              <option value="">No on-call person</option>
              {r.onCall && !all.some((x) => x.id === r.onCall) && (
                <option value={r.onCall}>On call: {r.onCallName ?? r.onCall}</option>
              )}
              {all
                .filter((x) => x.kind === 'person')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    On call: {p.name}
                  </option>
                ))}
            </Select>
          )}
        </div>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th className="font-normal">When severity is</th>
              {CHANNELS.map((c) => (
                <th key={c} className="text-center font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SEVERITIES.map((sev) => (
              <tr key={sev}>
                <td className="py-1">{sev}</td>
                {CHANNELS.map((c) => {
                  const list = draft.prefs[sev] ?? []
                  return (
                    <td key={c} className="text-center">
                      <Checkbox
                        checked={list.includes(c)}
                        onChange={(v) =>
                          setDraft({
                            ...draft,
                            prefs: { ...draft.prefs, [sev]: v ? [...list, c] : list.filter((x) => x !== c) },
                          })
                        }
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <WorkingHours draft={draft} setDraft={setDraft} />
      </fieldset>
      {editable && dirty && (
        <Button
          className="mt-3"
          color="dark/zinc"
          onClick={async () => {
            setError('')
            try {
              await api('/api/recipients', { method: 'PUT', body: { recipient: draft } })
              setSaved(true)
              onSaved()
            } catch (e) {
              setError((e as Error).message)
            }
          }}
        >
          Save preferences
        </Button>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {saved && !dirty && <Text className="mt-2">Saved to config/recipients.yaml</Text>}
    </div>
  )
}
