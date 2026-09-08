'use client'

/**
 * Schools & Grading - one place, not two.
 *
 * The old page had a "Grading scales" summary card sitting above a separate
 * Institutions card, and both reported the same scale status. Each school is
 * now one row that states its credit system, where its scale came from, and
 * what that scale actually is.
 */

import { useState } from 'react'
import { useState as useLocalState } from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import {
  gradingScaleStatus, STANDARD_SCALE, type GradingScale, type Institution,
} from '@/lib/gpa'
import { normalizeGradeSymbol } from '@/lib/gpa/gradingScale'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from './workspace'

/** A grade symbol is editable only if it is a plausible symbol at all. */
const GRADE_SYMBOL_RE = /^[A-Z][A-Z+\-]{0,3}$/

/** Highest grade first, so the summary reads like the printed legend. */
export function scaleSummary(points: Record<string, number> | undefined, limit = Infinity): string {
  if (!points) return '—'
  const all = Object.entries(points).sort((a, b) => b[1] - a[1])
  const head = all.slice(0, limit).map(([g, p]) => `${g} ${p.toFixed(2)}`).join(' · ')
  return all.length > limit ? `${head} …` : head
}

const SOURCE_STYLE: Record<string, string> = {
  user: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  transcript: 'bg-violet-50 text-violet-700 ring-violet-200',
  default: 'bg-amber-50 text-amber-800 ring-amber-200',
}

/**
 * D38 item 7 - the grading scale editor.
 *
 * Saving here always stamps source:'user'. That is the whole point: a scale the
 * user has looked at and confirmed outranks anything a later transcript upload
 * detects, and must never be silently replaced.
 */
export function ScaleEditor({ institution, onSave, onCancel }: {
  institution: Institution
  onSave: (next: GradingScale) => void | Promise<void>
  onCancel: () => void
}) {
  const starting = institution.gradingScale ?? STANDARD_SCALE
  const [rows, setRows] = useState<{ symbol: string; points: string }[]>(
    () => Object.entries(starting.points)
      .sort((a, b) => b[1] - a[1])
      .map(([symbol, points]) => ({ symbol, points: String(points) })))
  const [error, setError] = useState<string | null>(null)

  const setRow = (i: number, patch: Partial<{ symbol: string; points: string }>) =>
    setRows(rows.map((r, n) => n === i ? { ...r, ...patch } : r))

  const save = async () => {
    const points: Record<string, number> = {}
    for (const r of rows) {
      const symbol = normalizeGradeSymbol(r.symbol)
      if (!symbol) { setError('Every row needs a grade symbol.'); return }
      if (!GRADE_SYMBOL_RE.test(symbol)) { setError(`"${r.symbol}" is not a grade symbol.`); return }
      const n = Number(r.points)
      if (!Number.isFinite(n) || n < 0 || n > 5) {
        setError(`"${symbol}" needs grade points between 0 and 5.`); return
      }
      if (symbol in points) { setError(`"${symbol}" is listed twice.`); return }
      points[symbol] = n
    }
    if (Object.keys(points).length === 0) { setError('A scale needs at least one grade.'); return }
    setError(null)
    await onSave({ source: 'user', points })
  }

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <p className="mb-3 text-xs text-slate-600">
        Grade points used for <strong className="font-semibold text-slate-800">{institution.name}</strong>.
        Saving marks this scale as confirmed by you, and later transcript uploads will not change it.
      </p>
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input value={r.symbol} onChange={e => setRow(i, { symbol: e.target.value })}
              placeholder="Grade" aria-label={`Grade symbol ${i + 1}`}
              className={`${FIELD} w-24 bg-white`} />
            <input value={r.points} onChange={e => setRow(i, { points: e.target.value })}
              inputMode="decimal" placeholder="Points" aria-label={`Grade points ${i + 1}`}
              className={`${FIELD} w-24 bg-white`} />
            <button onClick={() => setRows(rows.filter((_, n) => n !== i))}
              aria-label={`Remove ${r.symbol || 'this grade'}`}
              className={`${BTN_GHOST} h-8 w-8 !px-0 hover:text-rose-600`}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setRows([...rows, { symbol: '', points: '' }])}
          className={`${BTN_SECONDARY} !px-3 !py-1.5 !text-xs`}>
          <Plus className="h-3.5 w-3.5" aria-hidden />Add grade
        </button>
        <button onClick={save} className={`${BTN_PRIMARY} !px-3 !py-1.5 !text-xs`}>Save &amp; confirm scale</button>
        <button onClick={onCancel} className={`${BTN_GHOST} !text-xs`}>Cancel</button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs font-medium text-rose-600">{error}</p>}
    </div>
  )
}

export function SchoolsPanel({
  institutions, otherInstitutions, totalCourses,
  scaleEditorId, setScaleEditorId,
  editInstitution, commitInstitution, removeInstitution, addInstitution,
}: {
  /** Schools this analysis actually uses. */
  institutions: Institution[]
  /** Saved on the account but not referenced by this analysis. */
  otherInstitutions: Institution[]
  totalCourses: number
  scaleEditorId: string | null
  setScaleEditorId: (id: string | null) => void
  editInstitution: (id: string, patch: Partial<Institution>) => void
  commitInstitution: (id: string, patch: Partial<Institution>) => Promise<void>
  removeInstitution: (id: string) => void
  addInstitution: () => void
}) {
  // Saved schools stay reachable, just not mixed in with the ones in play.
  const [showAll, setShowAll] = useLocalState(false)
  return (
    <div className={CARD}>
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <h2 className="text-base font-bold tracking-tight text-slate-900">
            {institutions.length} {institutions.length === 1 ? 'School' : 'Schools'} in this analysis
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Credit systems and grading scales. A school is shared across your analyses, so editing
            it here affects every analysis that uses it.
          </p>
        </div>
        <button onClick={addInstitution} className={BTN_SECONDARY}>
          <Plus className="h-4 w-4" aria-hidden />Add School
        </button>
      </div>

      {institutions.length === 0 ? (
        <p className="px-5 py-12 text-center text-sm text-slate-500">
          {totalCourses > 0
            ? 'None of the coursework in this analysis is assigned to a school yet.'
            : 'Add each school you attended so transfer credit, retakes and credit systems are handled correctly.'}
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {institutions.map(inst => {
            const source = inst.gradingScale?.source ?? 'default'
            const scale = inst.gradingScale ?? STANDARD_SCALE
            const open = scaleEditorId === inst.id
            return (
              <div key={inst.id} className="p-4 sm:p-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input value={inst.name} placeholder="School name"
                    aria-label="School name"
                    onChange={e => editInstitution(inst.id, { name: e.target.value })}
                    onBlur={e => commitInstitution(inst.id, { name: e.target.value })}
                    className={`${FIELD} flex-1 !text-sm !font-semibold !text-slate-900 ${
                      inst.creditSystem === 'unknown' ? 'border-amber-300' : ''}`} />
                  <select value={inst.creditSystem} aria-label={`Credit system for ${inst.name}`}
                    onChange={e => {
                      editInstitution(inst.id, { creditSystem: e.target.value as any })
                      commitInstitution(inst.id, { creditSystem: e.target.value as any })
                    }}
                    className={`${FIELD} sm:w-56`}>
                    <option value="unknown">Credit system: not set</option>
                    <option value="semester">Semester credits</option>
                    <option value="quarter">Quarter credits (unsupported)</option>
                  </select>
                  <button onClick={() => removeInstitution(inst.id)}
                    aria-label={`Delete ${inst.name || 'this school'}`}
                    className={`${BTN_GHOST} h-9 w-9 shrink-0 !px-0 hover:bg-rose-50 hover:text-rose-600`}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${SOURCE_STYLE[source]}`}>
                    {gradingScaleStatus(inst.gradingScale)}
                  </span>
                  <p className="min-w-0 flex-1 truncate text-xs tabular-nums text-slate-500">
                    {scaleSummary(scale.points, 6)}
                  </p>
                  <button onClick={() => setScaleEditorId(open ? null : inst.id)}
                    aria-expanded={open}
                    className={`${BTN_GHOST} shrink-0 !text-xs !text-violet-700 hover:!bg-violet-50`}>
                    {open ? 'Close' : 'Review grading scale'}
                  </button>
                </div>

                {!inst.gradingScale && (
                  <p className="mt-1.5 text-xs text-slate-500">
                    Using the standard 4.0 scale because no explicit grading legend was found on your transcript.
                  </p>
                )}

                {open && (
                  <ScaleEditor institution={inst}
                    onSave={async next => {
                      await commitInstitution(inst.id, { gradingScale: next })
                      editInstitution(inst.id, { gradingScale: next })
                      setScaleEditorId(null)
                    }}
                    onCancel={() => setScaleEditorId(null)} />
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Account-level schools stay reachable, but they are not presented as
          participants in this analysis. */}
      {otherInstitutions.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
          <button onClick={() => setShowAll(v => !v)} aria-expanded={showAll}
            className={`${BTN_GHOST} !px-0 !text-xs`}>
            <ChevronDown className={`h-3.5 w-3.5 transition ${showAll ? 'rotate-180' : ''}`} aria-hidden />
            Manage saved schools ({otherInstitutions.length} not used here)
          </button>
          {showAll && (
            <div className="mt-2 space-y-1.5">
              <p className="text-xs text-slate-500">
                Saved on your account and available to any analysis. These are not part of this
                analysis&apos;s GPA — assign coursework to a school to bring it in.
              </p>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {otherInstitutions.map(inst => (
                  <li key={inst.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{inst.name}</span>
                    <span className="text-xs text-slate-500">
                      {inst.creditSystem === 'unknown' ? 'Credit system not set' : `${inst.creditSystem} credits`}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${SOURCE_STYLE[inst.gradingScale?.source ?? 'default']}`}>
                      {gradingScaleStatus(inst.gradingScale)}
                    </span>
                    <button onClick={() => removeInstitution(inst.id)}
                      aria-label={`Delete ${inst.name || 'this school'}`}
                      className={`${BTN_GHOST} h-7 w-7 shrink-0 !px-0 hover:bg-rose-50 hover:text-rose-600`}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}