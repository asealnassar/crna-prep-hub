'use client'

/**
 * The guided setup card.
 *
 * Replaces four stacked amber panels that all described the same unset field.
 * Anything blocking the calculation is resolvable right here - the credit
 * system control writes the same institution field Schools & Grading writes,
 * so there is no second copy of that state anywhere.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Info, Plus } from 'lucide-react'
import {
  gradingScaleStatus,
  type Course, type CreditSystem, type GpaPolicies, type Institution,
} from '@/lib/gpa'
import type { SetupState } from '@/lib/gpa/setup'
import { pickerOptionsFor } from '@/lib/gpa/transferLinks'
import {
  setupSummary, setupHeading, transferGroupDetail, transferGroupTitle,
  quarterGroupDetail, quarterGroupTitle,
} from '@/lib/gpa/setup'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, CARD, FIELD } from './workspace'

/** Segmented choice. Real buttons, real pressed state, keyboard like any button. */
function Segmented<T extends string>({
  legend, options, value, onChange,
}: {
  legend: string
  options: { value: T; label: string; hint?: string }[]
  value: T | null
  onChange: (v: T) => void
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(o => {
          const on = value === o.value
          return (
            <button key={o.value} type="button" aria-pressed={on} title={o.hint}
              onClick={() => onChange(o.value)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-1 ${
                on ? 'border-violet-600 bg-violet-600 text-white'
                   : 'border-slate-200 bg-white text-slate-700 hover:border-violet-300 hover:bg-violet-50'}`}>
              {on && <Check className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />}
              {o.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

/** Compact grading-scale status, replacing the standalone full-width notice. */
function ScaleChip({ institution }: { institution: Institution }) {
  const source = institution.gradingScale?.source
  const good = source === 'transcript' || source === 'user'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
      good ? 'text-emerald-700' : 'text-slate-500'}`}>
      {good
        ? <Check className="h-3.5 w-3.5" aria-hidden />
        : <Info className="h-3.5 w-3.5 text-slate-400" aria-hidden />}
      {gradingScaleStatus(institution.gradingScale)}
    </span>
  )
}

/** Courses a transfer record could plausibly refer to, most likely first. */
function pickerOptions(
  courses: readonly Course[], notationId: string,
): (Course & { schoolName?: string })[] {
  const notation = courses.find(c => c.id === notationId)
  if (!notation) return []
  return pickerOptionsFor(notation, courses, []).slice(0, 40)
}

export function SetupCard({
  state, courseCount, institutions, policies, setPolicies, setInstitutionCreditSystem,
  unassigned, selectedIds, toggleSelected, setSelectedIds,
  assignTargetId, setAssignTargetId, assignSelectedTo, addInstitution,
  onReviewCourses, courses, chooseTransferLink,
}: {
  state: SetupState
  courseCount: number
  institutions: readonly Institution[]
  policies: GpaPolicies
  setPolicies: (p: GpaPolicies) => void
  setInstitutionCreditSystem: (id: string, v: CreditSystem) => void
  unassigned: Course[]
  selectedIds: string[]
  toggleSelected: (id: string) => void
  setSelectedIds: (ids: string[]) => void
  assignTargetId: string
  setAssignTargetId: (v: string) => void
  assignSelectedTo: (id: string) => void
  addInstitution: () => void
  onReviewCourses: () => void
  /** D50: every row in this analysis, so a transfer record can be matched. */
  courses: readonly Course[]
  /** D50: the user's answer for one transfer record. null = none of them. */
  chooseTransferLink: (notationId: string, courseId: string | null) => void
}) {
  const [showAllReview, setShowAllReview] = useState(false)
  /** D53: which optional transfer groups the user has opened. Collapsed by default. */
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  /** D57: which quarter-credit schools the user has opened. Collapsed by default. */
  const [expandedQuarter, setExpandedQuarter] = useState<Record<string, boolean>>({})
  const [showDetail, setShowDetail] = useState(false)
  /**
   * A short attention pulse when required items first appear, and again when a
   * new one shows up -- three soft cycles, then still. Never a loop: a card
   * that keeps flashing stops being information and becomes noise.
   */
  const requiredCount = state.required.length
  const [pulse, setPulse] = useState(false)
  const lastCount = useRef(0)

  // Start it when required items appear, or when one more shows up.
  useEffect(() => {
    if (requiredCount > lastCount.current) setPulse(true)
    lastCount.current = requiredCount
  }, [requiredCount])

  // Stop it on its own terms. The timer hangs off `pulse` rather than off the
  // count, because a count-keyed effect re-running cleared the pending timer
  // and the class never came off. `onAnimationEnd` below ends it the moment the
  // three cycles finish; this is the backstop, and the only stop that runs when
  // reduced motion means there is no animation to end.
  useEffect(() => {
    if (!pulse) return
    const id = setTimeout(() => setPulse(false), 2400)
    return () => clearTimeout(id)
  }, [pulse])
  const {
    required, review, informational, transferConfirms, transferGroups, quarterGroups, blocked,
  } = state

  // Everything resolved: the card has nothing to say, so it says nothing.
  if (required.length === 0 && review.length === 0 && informational.length === 0 &&
      transferConfirms.length === 0 && transferGroups.length === 0 &&
      quarterGroups.length === 0) return null

  const shownReview = showAllReview ? review : review.slice(0, 3)
  const n = required.length

  return (
    <section aria-labelledby="setup-heading"
      onAnimationEnd={() => setPulse(false)}
      className={`${CARD} ${blocked
        ? `border-rose-300 ring-1 ring-rose-200 ${pulse ? 'gpa-attention' : ''}`
        : ''}`}>

      {blocked ? (
        /* Required items are the one thing on this page a user must not scroll
           past, so they get the strongest treatment the design system has --
           and never colour alone: an icon, the words "Action required", and
           the count all say it independently. */
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-4 sm:px-5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden />
            <div className="min-w-0">
              <h2 id="setup-heading"
                className="flex flex-wrap items-center gap-2 text-base font-bold tracking-tight text-rose-900">
                Action required
                <span className="rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white tabular-nums">
                  {n}
                </span>
              </h2>
              <p className="mt-0.5 text-sm font-medium text-rose-900">
                {n} action{n === 1 ? '' : 's'} required before your GPA is complete
              </p>
              <p className="mt-0.5 text-sm text-rose-800/90">
                Some coursework is currently being held out of your calculation.
              </p>
            </div>
          </div>
        </div>
      ) : (
      <div className="border-b border-slate-100 px-4 py-4 sm:px-5">
        <h2 id="setup-heading" className="text-base font-bold tracking-tight text-slate-900">
          {setupHeading(state)}
        </h2>
        <p className="mt-0.5 text-sm text-slate-500">{setupSummary(state, courseCount)}</p>
      </div>
      )}

      {/* -------------------------------------------------- required to calculate */}
      {required.length > 0 && (
        <div className="divide-y divide-slate-100">
          {required.map(item => {
            const inst = institutions.find(i => i.id === item.institutionId)
            const key = `${item.kind}-${item.institutionId ?? ''}`

            if (item.kind === 'credit-system' && inst) {
              return (
                <div key={key} className="px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-slate-900">{inst.name}</p>
                      <p className="mt-0.5 text-sm text-slate-500">
                        Credit system — needed for {item.count} course{item.count === 1 ? '' : 's'}
                      </p>
                    </div>
                    <Segmented legend={`Credit system for ${inst.name}`}
                      value={inst.creditSystem === 'unknown' ? null : inst.creditSystem}
                      onChange={v => setInstitutionCreditSystem(inst.id, v)}
                      options={[
                        { value: 'semester', label: 'Semester credits' },
                        { value: 'quarter', label: 'Quarter credits',
                          hint: 'Quarter coursework is flagged and excluded, never converted.' },
                      ]} />
                  </div>
                  <div className="mt-2.5"><ScaleChip institution={inst} /></div>
                </div>
              )
            }

            if (item.kind === 'no-institution') {
              return (
                <div key={key} className="px-4 py-4 sm:px-5">
                  <p className="text-sm font-semibold text-slate-900">
                    {item.count} course{item.count === 1 ? '' : 's'} need a school
                  </p>
                  <p className="mt-0.5 text-sm text-slate-500">
                    We do not assume a school&apos;s credit system, because semester and quarter credits
                    carry different weight. Nothing is lost in the meantime.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button onClick={() => setSelectedIds(
                      selectedIds.length === unassigned.length ? [] : unassigned.map(c => c.id))}
                      className={BTN_SECONDARY}>
                      {selectedIds.length === unassigned.length ? 'Clear selection' : `Select all ${unassigned.length}`}
                    </button>
                    <select value={assignTargetId} aria-label="Assign selected courses to a school"
                      onChange={e => setAssignTargetId(e.target.value)} className={`${FIELD} flex-1`}>
                      <option value="">Assign selected to…</option>
                      {institutions.map(i => (
                        <option key={i.id} value={i.id}>
                          {i.name}{i.creditSystem === 'unknown' ? ' (credit system not set)' : ` (${i.creditSystem})`}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => assignSelectedTo(assignTargetId)}
                      disabled={selectedIds.length === 0 || !assignTargetId} className={BTN_PRIMARY}>
                      Assign {selectedIds.length || ''}
                    </button>
                    <button onClick={addInstitution} className={BTN_SECONDARY}>
                      <Plus className="h-4 w-4" aria-hidden />New school
                    </button>
                  </div>
                  <div className="mt-3 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200">
                    {unassigned.map(c => (
                      <label key={c.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50">
                        <input type="checkbox" checked={selectedIds.includes(c.id)}
                          onChange={() => toggleSelected(c.id)} className="h-4 w-4 accent-violet-600" />
                        <span className="min-w-0 flex-1 truncate text-slate-700">
                          {c.name || <span className="italic text-slate-400">Untitled course</span>}
                          {c.courseCode && <span className="text-slate-400"> · {c.courseCode}</span>}
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">{c.grade} · {c.credits} cr</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            }

            // D50: the transfer-link reviews have their own section below, with
            // the context needed to answer them. This row is the pointer, so
            // the required list still accounts for every required item.
            if (item.kind === 'transfer-link') {
              return (
                <div key={key} className="px-4 py-4 sm:px-5">
                  <p className="text-sm font-semibold text-slate-900">Transfer links</p>
                  <p className="mt-0.5 text-sm text-slate-500">
                    {item.count} transfer record{item.count === 1 ? '' : 's'} need
                    {item.count === 1 ? 's' : ''} review below. The coursework they may document is
                    held out of your GPA until you decide.
                  </p>
                </div>
              )
            }

            const isTransfer = item.kind === 'transfer-policy'
            return (
              <div key={key} className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">
                      {isTransfer ? 'Transferred coursework' : 'Repeated coursework'}
                    </p>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {isTransfer
                        ? `CRNA programs treat transferred coursework differently, so there is no default. ${item.count} course(s) are held out until you choose.`
                        : `CRNA programs may handle repeated courses differently, so there is no default. ${item.count} course(s) are held out until you choose.`}
                    </p>
                  </div>
                  {isTransfer ? (
                    <Segmented legend="Transferred coursework policy" value={policies.transfer}
                      onChange={v => setPolicies({ ...policies, transfer: v })}
                      options={[{ value: 'include', label: 'Include' }, { value: 'exclude', label: 'Exclude' }]} />
                  ) : (
                    <Segmented legend="Repeated coursework policy" value={policies.retake}
                      onChange={v => setPolicies({ ...policies, retake: v })}
                      options={[{ value: 'both', label: 'Count both' }, { value: 'latest', label: 'Latest only' }]} />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* -------------------------------------------------------------- review */}
      {review.length > 0 && (
        <div className="border-t border-slate-100 bg-amber-50/40 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-amber-900">
              {review.length} course{review.length === 1 ? '' : 's'} need review
            </p>
            <div className="flex items-center gap-1">
              <button onClick={() => setShowDetail(d => !d)} className={`${BTN_GHOST} !text-xs`}
                aria-expanded={showDetail}>
                {showDetail ? 'Hide why' : 'Why?'}
              </button>
              <button onClick={onReviewCourses} className={`${BTN_SECONDARY} !px-3 !py-1.5 !text-xs`}>
                Review courses
              </button>
            </div>
          </div>
          <p className="mt-0.5 text-xs text-amber-800/80">
            These are excluded from your GPA until you fix them. Everything else still calculates.
          </p>
          <ul className="mt-2.5 space-y-1.5">
            {shownReview.map(r => (
              <li key={`${r.courseId}-${r.label}`} className="text-sm">
                <span className="font-medium text-slate-800">{r.courseName}</span>
                <span className="text-slate-400"> · </span>
                <span className="text-slate-600">{r.label}</span>
                {showDetail && <p className="mt-0.5 text-xs text-slate-500">{r.detail}</p>}
              </li>
            ))}
          </ul>
          {review.length > 3 && (
            <button onClick={() => setShowAllReview(s => !s)}
              className={`${BTN_GHOST} mt-1.5 !px-0 !text-xs`} aria-expanded={showAllReview}>
              <ChevronDown className={`h-3.5 w-3.5 transition ${showAllReview ? 'rotate-180' : ''}`} aria-hidden />
              {showAllReview ? 'Show fewer' : `Show all ${review.length}`}
            </button>
          )}
        </div>
      )}

      {/* ------------------------------------- D50: transfer records to confirm */}
      {/* Required: coursework here could be what these document, so the GPA
          genuinely waits on the answer. One row each, with the picker. */}
      {transferConfirms.some(t => t.severity === 'required') && (
        <div className="border-t border-slate-100 bg-violet-50/50 px-4 py-4 sm:px-5">
          {(() => {
            const items = transferConfirms.filter(t => t.severity === 'required')
            return (
              <>
                <p className="text-sm font-semibold text-violet-900">
                  Transfer coursework needs confirmation
                </p>
                <p className="mt-0.5 text-xs text-violet-800/80">
                  {items.length} transfer record{items.length === 1 ? '' : 's'} require
                  {items.length === 1 ? 's' : ''} review. Coursework in this analysis could be what
                  {' '}they document, so your GPA depends on the answer — that coursework is held out
                  {' '}until you decide.
                </p>
                <ul className="mt-3 space-y-3">
                  {items.map(t => (
                    <li key={t.notationId} className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">
                        {t.courseCode ? `${t.courseCode} · ` : ''}{t.courseName}
                        {' · '}{t.credits} cr
                        <span className="text-slate-400"> · </span>
                        <span className="font-normal text-slate-600">{t.label}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Transfer record on {t.receivingName ?? 'this transcript'}
                        {t.fromName ? `, from “${t.fromName}”` : ''}. {t.detail}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <label className="sr-only" htmlFor={`tl-${t.notationId}`}>
                          Which course does this transfer record represent?
                        </label>
                        <select id={`tl-${t.notationId}`} defaultValue=""
                          onChange={e => {
                            if (!e.target.value) return
                            chooseTransferLink(t.notationId, e.target.value === '__none__' ? null : e.target.value)
                          }}
                          className={`${FIELD} !w-auto max-w-full !py-1.5 !text-xs`}>
                          <option value="" disabled>Choose the original course…</option>
                          {pickerOptions(courses, t.notationId).map(c => (
                            <option key={c.id} value={c.id}>
                              {c.courseCode ? `${c.courseCode} — ` : ''}{c.name || 'Untitled'}
                              {' '}({c.credits} cr{c.schoolName ? `, ${c.schoolName}` : ''})
                            </option>
                          ))}
                          <option value="__none__">Not in this analysis</option>
                        </select>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )
          })()}
        </div>
      )}

      {/* Optional: one group per originating school, collapsed. Nothing here is
          waiting on the user, so it says so once instead of once per record. */}
      {transferGroups.map(group => {
        const open = !!expandedGroups[group.key]
        const n = group.records.length
        return (
          <div key={group.key} className="border-t border-slate-100 bg-slate-50/70 px-4 py-4 sm:px-5">
            <p className="break-words text-sm font-semibold text-slate-900">
              {transferGroupTitle(group)}
            </p>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              {n} record{n === 1 ? '' : 's'}
            </p>
            <p className="mt-1 text-xs text-slate-600">{transferGroupDetail(group)}</p>
            <button type="button" aria-expanded={open}
              onClick={() => setExpandedGroups(g => ({ ...g, [group.key]: !open }))}
              className={`${BTN_SECONDARY} mt-2.5 !px-3 !py-1.5 !text-xs`}>
              <ChevronDown className={`h-3.5 w-3.5 transition ${open ? 'rotate-180' : ''}`} aria-hidden />
              {open ? 'Hide records' : `View ${n} record${n === 1 ? '' : 's'}`}
            </button>
            {open && (
              <ul className="mt-2.5 space-y-1.5">
                {group.records.map(t => (
                  <li key={t.notationId} className="break-words text-sm text-slate-700">
                    {t.courseCode && <span className="font-medium">{t.courseCode} · </span>}
                    {t.courseName}
                    <span className="text-slate-400"> · </span>{t.credits} cr
                    <span className="text-slate-400"> · </span>
                    {/* The printed grade, exactly as printed. Nothing is invented
                        for a row the transcript left blank. */}
                    <span className="text-slate-600">{t.grade?.trim() ? t.grade : 'blank grade'}</span>
                    {t.receivingName && (
                      <span className="block text-xs text-slate-500">
                        On {t.receivingName}
                        {t.fromName ? `, from ${t.fromName}` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}

      {/* ---------------------------- D57: quarter credit, which nobody can fix */}
      {quarterGroups.map(group => {
        const key = group.institutionId ?? 'unknown'
        const open = !!expandedQuarter[key]
        const n = group.courses.length
        return (
          <div key={key} className="border-t border-slate-100 bg-slate-50/70 px-4 py-4 sm:px-5">
            <p className="flex items-start gap-2 text-sm font-semibold text-slate-900">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              {quarterGroupTitle()}
            </p>
            <p className="mt-1 break-words text-xs text-slate-600">{quarterGroupDetail(group)}</p>
            <button type="button" aria-expanded={open}
              onClick={() => setExpandedQuarter(g => ({ ...g, [key]: !open }))}
              className={`${BTN_SECONDARY} mt-2.5 !px-3 !py-1.5 !text-xs`}>
              <ChevronDown className={`h-3.5 w-3.5 transition ${open ? 'rotate-180' : ''}`} aria-hidden />
              {open ? 'Hide courses' : `View ${n} course${n === 1 ? '' : 's'}`}
            </button>
            {open && (
              <ul className="mt-2.5 space-y-1">
                {group.courses.map(c => (
                  <li key={c.courseId} className="break-words text-sm text-slate-700">
                    {c.courseCode && <span className="font-medium">{c.courseCode} · </span>}
                    {c.courseName}
                    <span className="text-slate-400"> · </span>{c.credits} cr
                    {c.grade?.trim() && (
                      <><span className="text-slate-400"> · </span>{c.grade}</>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}

      {/* ----------------------------------------- excluded by rule, nothing to fix */}
      {informational.map(i => (
        <div key={i.label} className="border-t border-slate-100 px-4 py-3 sm:px-5">
          <p className="flex items-start gap-2 text-sm text-slate-600">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <span><span className="font-medium text-slate-800">{i.label}</span> — {i.detail}</span>
          </p>
        </div>
      ))}
    </section>
  )
}
