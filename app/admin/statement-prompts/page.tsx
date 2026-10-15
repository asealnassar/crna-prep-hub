'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  SUBMISSION_STATUSES,
  type SubmissionStatus,
} from '@/lib/statement/draft/promptSubmission'
import { schoolLabel, wordLimitLabel } from '@/lib/statement/draft/picker'
import type { SchoolOption } from '@/lib/statement/draft/schoolPicker'
import PromotionEditor from './PromotionEditor'
import AdminNav from '../AdminNav'

/**
 * The prompt review queue.
 *
 * ADMIN-ONLY, AND NOT BECAUSE OF THIS FILE. Everything here runs through
 * /api/admin/statement-prompts, which authenticates, checks the shared admin
 * allowlist, and only then builds a service-role client. A browser that
 * rendered this page without passing that check would see an error from every
 * request it made; there is no data in this component that did not come from an
 * authorized response.
 *
 * NO SIDEBAR, AND NONE IS TOUCHED. ClientProviders already hides the shared
 * navigation for every /admin route, so this page carries the same inline
 * header the other admin pages do and the sidebar component is not imported,
 * referenced or changed.
 *
 * NOTHING SUBMITTED IS EVER RENDERED AS MARKUP. Prompt wording goes into a
 * <p> as escaped React text; a source link is rendered with rel="noopener
 * noreferrer" and is never fetched by the server. Stored XSS has no entry
 * point here because no path interpolates applicant text into HTML.
 *
 * THE APPLICANT IS ABSENT. No name, no email, no user id, and no essay: the
 * API does not return them, and moderating a question does not require knowing
 * who asked it.
 */

interface ReviewRow {
  id: string
  schoolId: string
  promptText: string
  statedMaxWords: number | null
  applicationCycle: string | null
  sourceUrl: string | null
  status: SubmissionStatus
  reviewedAt: string | null
  reviewNote: string | null
  approvedPromptId: string | null
  duplicateOfId: string | null
  textFingerprint: string
  createdAt: string
  // ---- 20261006_008: what else the applicant told us -------------------
  documentLabel: string | null
  documentTypeHint: string | null
  statedMinWords: number | null
  statedMaxCharacters: number | null
  statedMaxPages: number | null
  statedPagesText: string | null
  formattingInstructions: string | null
  otherInstructions: string | null
  submitterNote: string | null
  /** The catalog row this became, or null. NEVER means it is active. */
  approvedRequirementId: string | null
  // ---- 20261008_012 ----------------------------------------------------
  /** 'new-prompt' or 'prompt-change'. Recorded by the applicant, never guessed. */
  kind: 'new-prompt' | 'prompt-change'
  /** The catalog row a report contradicts. Null for a new prompt. */
  challengedRequirementId: string | null
}

/**
 * The catalog row a report is about, resolved by the server.
 *
 * `offered` IS NOT COSMETIC. A row that is no longer offered is one a previous
 * replacement already superseded, and a reviewer reading a second report about
 * it has to know that before deciding -- otherwise they replace a prompt that
 * is not on screen any more.
 */
interface ChallengedRow {
  readonly requirementId: string
  readonly label: string | null
  readonly documentType: string | null
  readonly promptText: string | null
  readonly offered: boolean
  readonly source?: 'imported' | 'local'
}

/** One replacement already recorded. Development only; see 012. */
interface Supersession {
  readonly requirementId: string
  readonly supersededBy: string
  readonly submissionId: string
}

/**
 * DEVELOPMENT ONLY: whether a promoted set is switched on for local preview.
 *
 * ABSENT IN PRODUCTION, and absent for anything the local store does not hold
 * -- production's 63 imported sets included, which is why none of them can be
 * toggled from this screen.
 */
interface LocalPreview {
  readonly setId: string
  readonly requirementId: string
  readonly isActive: boolean
  readonly qualifies: boolean
  readonly missing: readonly string[]
  readonly label: string
  readonly applicationCycle: string | null
  /** The stored rows, so the editor can be reopened on exactly what is there. */
  readonly entry: {
    readonly set: Record<string, unknown>
    readonly requirement: Record<string, unknown>
  } | null
}

/** One school's catalog, as applicants can see it today. */
interface CatalogContext {
  readonly available: boolean
  readonly reason?: string
  readonly sets?: readonly {
    readonly id: string
    readonly applicationCycle: string | null
    readonly requirements: readonly {
      readonly id: string
      readonly label: string
      readonly documentType: string
      readonly promptText: string
    }[]
  }[]
}

const ENDPOINT = '/api/admin/statement-prompts'

const STATUS_STYLE: Record<SubmissionStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-rose-100 text-rose-800',
  duplicate: 'bg-slate-200 text-slate-700',
  withdrawn: 'bg-slate-100 text-slate-500',
}

export default function StatementPromptReviewPage() {
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [schools, setSchools] = useState<readonly SchoolOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<SubmissionStatus | 'all'>('pending')
  const [search, setSearch] = useState('')
  /** Which row has a decision in flight. One at a time, by construction. */
  const [busy, setBusy] = useState<string | null>(null)
  const [labels, setLabels] = useState<Record<string, string>>({})
  /** Per-school catalog context, so a reviewer knows what already exists. */
  const [catalog, setCatalog] = useState<Record<string, CatalogContext>>({})
  const [pendingPerSchool, setPendingPerSchool] = useState<Record<string, number>>({})
  /** fingerprint -> submission ids, only where more than one shares it. */
  const [duplicateGroups, setDuplicateGroups] = useState<Record<string, string[]>>({})
  /** Which submission's promotion editor is open. One at a time. */
  const [promoting, setPromoting] = useState<string | null>(null)
  /**
   * Which of the two report outcomes the open editor will perform.
   *
   * HELD BESIDE `promoting` RATHER THAN DEFAULTED INSIDE THE EDITOR, because
   * the choice is the decision: the administrator makes it by pressing one of
   * two buttons, and the editor then says which one it is about to do. A
   * default here would be the inference the owner asked not to make.
   */
  const [changeAction, setChangeAction] =
    useState<'replace' | 'add-additional' | null>(null)
  const [challenged, setChallenged] = useState<Record<string, ChallengedRow>>({})
  const [supersessions, setSupersessions] = useState<readonly Supersession[]>([])
  /** What a finished promotion said, keyed by submission id. */
  const [promoted, setPromoted] = useState<Record<string, {
    setId: string; requirementId: string; created: string
  }>>({})
  /** DEVELOPMENT ONLY: local preview state per promoted submission. */
  const [localPreview, setLocalPreview] = useState<Record<string, LocalPreview>>({})
  /** Which set has a local preview toggle in flight. */
  const [previewBusy, setPreviewBusy] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<Record<string, string>>({})
  /** Which promoted submission's catalog entry is open for editing. */
  const [editingEntry, setEditingEntry] = useState<string | null>(null)

  /**
   * DEVELOPMENT ONLY: switch a locally promoted set on or off.
   *
   * THE ENDPOINT IS WHAT MAKES THIS SAFE, not this function. It answers 404
   * outside development, and the only thing it writes is one field in
   * local-review/dev-canonical.json -- so a bug here cannot reach production
   * catalog data however it is called.
   */
  const togglePreview = useCallback(async (
    submissionId: string,
    setId: string,
    action: 'activate' | 'deactivate',
  ) => {
    if (previewBusy !== null) return
    setPreviewBusy(setId)
    setPreviewError((previous) => {
      const next = { ...previous }
      delete next[submissionId]
      return next
    })
    try {
      const response = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ setId, action }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        // THE SHORTFALL, IN THE WORDS THE SERVER USED. Not "it does not
        // qualify": which of the three conditions is missing.
        setPreviewError((previous) => ({
          ...previous,
          [submissionId]: typeof body?.error === 'string'
            ? body.error
            : 'That local preview could not be changed.',
        }))
        return
      }
      await load()
    } catch {
      setPreviewError((previous) => ({
        ...previous,
        [submissionId]: 'That local preview could not be changed.',
      }))
    } finally {
      setPreviewBusy(null)
    }
  }, [previewBusy])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = filter === 'all' ? ENDPOINT : `${ENDPOINT}?status=${encodeURIComponent(filter)}`
      const response = await fetch(url)
      if (!response.ok) {
        setError(
          response.status === 403 ? 'You are not authorized to review prompts.'
            : response.status === 404 ? 'Prompt submissions are not enabled yet.'
            : 'Those submissions could not be loaded.',
        )
        setRows([])
        return
      }
      const body = await response.json().catch(() => null)
      setRows(Array.isArray(body?.submissions) ? body.submissions : [])
      setSchools(Array.isArray(body?.schools) ? body.schools : [])
      setCatalog(body?.catalog ?? {})
      setChallenged(body?.challenged ?? {})
      setSupersessions(Array.isArray(body?.supersessions) ? body.supersessions : [])
      setPendingPerSchool(body?.pendingPerSchool ?? {})
      setDuplicateGroups(body?.duplicateGroups ?? {})
      setLocalPreview(body?.localPreview ?? {})
    } catch {
      setError('Those submissions could not be loaded.')
      setRows([])
    }
    setLoading(false)
  }, [filter])

  useEffect(() => { void load() }, [load])

  /**
   * One decision.
   *
   * THE ROW IS LOCKED WHILE IT IS IN FLIGHT, and a second click returns
   * immediately -- the same reason the New Draft dialog holds a ref. The
   * database settles the rest: decide() locks the row and reports an
   * already-decided submission rather than deciding it twice.
   */
  const decide = useCallback(async (
    id: string,
    decision: 'approved' | 'rejected' | 'duplicate',
    extra: Record<string, unknown> = {},
  ) => {
    if (busy !== null) return
    setBusy(id)
    setError(null)
    try {
      const response = await fetch(ENDPOINT, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision, ...extra }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        setError(typeof body?.error === 'string' ? body.error : 'That decision could not be applied.')
      } else {
        await load()
      }
    } catch {
      setError('That decision could not be applied.')
    }
    setBusy(null)
  }, [busy, load])

  /**
   * School names, by id. Resolved from the directory the applicant chose from,
   * so a reviewer reads the same label the submitter did.
   */
  const schoolNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const school of schools) names.set(school.id, schoolLabel(school))
    return names
  }, [schools])

  /**
   * Submissions sharing a school and a fingerprint are the same question.
   *
   * A HINT FOR A HUMAN, AND NOTHING ELSE. Nothing in this file approves,
   * rejects or merges anything because two fingerprints match: the count turns
   * on a badge, and Mark duplicate still requires a click.
   */
  const duplicateCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      const key = `${row.schoolId}:${row.textFingerprint}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [rows])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return rows
    return rows.filter((row) => row.promptText.toLowerCase().includes(needle)
      || row.schoolId.toLowerCase().includes(needle)
      || (schoolNames.get(row.schoolId) ?? '').toLowerCase().includes(needle))
  }, [rows, search, schoolNames])

  const pendingCount = rows.filter((row) => row.status === 'pending').length

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Prompt submissions</h1>
            <p className="mt-1 text-sm text-slate-500">
              {pendingCount === 0
                ? 'Nothing is waiting for review.'
                : `${pendingCount} awaiting review.`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="status" className="sr-only">Filter by status</label>
            <select
              id="status"
              value={filter}
              onChange={(event) => setFilter(event.target.value as SubmissionStatus | 'all')}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
            >
              <option value="all">All statuses</option>
              {SUBMISSION_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
            <label htmlFor="search" className="sr-only">Search submissions</label>
            <input
              id="search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search prompt or school"
              className="w-60 rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>

        {error !== null && (
          <p role="alert" className="mt-5 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
          </p>
        )}

        {loading ? (
          <p className="mt-8 text-sm text-slate-500">Loading submissions…</p>
        ) : visible.length === 0 ? (
          <p className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">
            No submissions match that view.
          </p>
        ) : (
          <ul className="mt-6 grid gap-4">
            {visible.map((row) => {
              const copies = duplicateCounts.get(`${row.schoolId}:${row.textFingerprint}`) ?? 1
              return (
                <li key={row.id} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      {/* The name leads; the id is kept as secondary technical
                          detail because it is what a decision is applied to. */}
                      <p className="text-sm font-bold text-slate-900">
                        {schoolNames.get(row.schoolId) ?? 'Unrecognised school'}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-400">{row.schoolId}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        submitted {row.createdAt.slice(0, 10)}
                        {row.reviewedAt === null ? '' : ` · reviewed ${row.reviewedAt.slice(0, 10)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {/*
                        THE KIND IS THE FIRST THING SAID ABOUT THE ROW.

                        A report and a new prompt are reviewed by answering
                        different questions, and the two cards used to be
                        indistinguishable -- the reviewer's only clue was that
                        the wording resembled something already in the catalog,
                        which is exactly the inference 20261008_012 exists to
                        remove.
                      */}
                      {row.kind === 'prompt-change' && (
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">
                          Prompt Change Report
                        </span>
                      )}
                      {copies > 1 && (
                        <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-semibold text-indigo-800">
                          {copies} identical
                        </span>
                      )}
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[row.status]}`}>
                        {row.status}
                      </span>
                    </div>
                  </div>

                  {/*
                    A REPORT IS READ AS A COMPARISON, SO IT IS SHOWN AS ONE.

                    Two columns, labelled, in the order the decision is made:
                    what the catalog says now, and what the applicant says it
                    says. A single block of the submitted wording -- which is
                    all this card used to show -- made the reviewer go and look
                    our own row up, and the thing they were deciding was
                    whether these two texts are the same question.

                    OUR SIDE IS RESOLVED BY THE SERVER FROM THE REQUIREMENT ID,
                    never from the submission. Nothing the applicant sent
                    chooses what their report is compared against.
                  */}
                  {row.kind === 'prompt-change' ? (
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Current catalog prompt
                        </p>
                        {challenged[row.id] === undefined ? (
                          <p className="mt-2 text-sm text-slate-500">
                            That prompt could not be read
                            {row.challengedRequirementId === null
                              ? '. This report names no prompt.'
                              : ' from the catalog.'}
                          </p>
                        ) : (
                          <>
                            <p className="mt-1 text-sm font-bold text-slate-900">
                              {challenged[row.id]?.label ?? 'Untitled document'}
                            </p>
                            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                              {challenged[row.id]?.promptText ?? ''}
                            </p>
                            {/* ALREADY SUPERSEDED, SAID BEFORE A SECOND
                                REPLACEMENT IS CONSIDERED. */}
                            {challenged[row.id]?.offered === false && (
                              <p className="mt-2 text-xs font-semibold text-amber-800">
                                No longer offered — already replaced
                              </p>
                            )}
                          </>
                        )}
                        <p className="mt-2 font-mono text-[11px] text-slate-400">
                          {row.challengedRequirementId ?? '—'}
                        </p>
                      </div>
                      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-amber-800">
                          Student-reported prompt
                        </p>
                        {/* Escaped text in a paragraph. Never markup. */}
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                          {row.promptText}
                        </p>
                      </div>
                    </div>
                  ) : (
                    /* Escaped text in a paragraph. Never markup. */
                    <p className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-800">
                      {row.promptText}
                    </p>
                  )}

                  {/*
                    WHAT A DECIDED REPORT ACTUALLY DID, read from the recorded
                    replacement rather than from the decision word. 'approved'
                    is true of both outcomes; only this says which.
                  */}
                  {row.kind === 'prompt-change' && supersessions.some(
                    (entry) => entry.submissionId === row.id) && (
                    <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-800">
                      Replaced the catalog prompt. The superseded prompt is no longer offered.
                    </p>
                  )}

                  <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                    <span>{wordLimitLabel(row.statedMaxWords)}</span>
                    {row.applicationCycle !== null && <span>Cycle {row.applicationCycle}</span>}
                    {row.sourceUrl !== null && (
                      <a
                        href={row.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-blue-700 underline underline-offset-2"
                      >
                        source
                      </a>
                    )}
                  </p>

                  {/*
                    EVERYTHING ELSE THE APPLICANT REPORTED.
                    
                    SHOWN AS "WHAT THEY SAID", NOT AS FIELDS OF A RECORD. Each
                    of these is one person's report of a school's instruction
                    page; presenting them as catalog values is how unreviewed
                    data starts looking reviewed. The promotion editor repeats
                    them beside the controls they would inform, for the same
                    reason.
                    
                    EVERY ONE IS ESCAPED REACT TEXT. Nothing submitted is ever
                    interpreted as markup, here or anywhere.
                  */}
                  {(row.documentLabel !== null || row.documentTypeHint !== null
                    || row.statedMinWords !== null || row.statedMaxCharacters !== null
                    || row.statedMaxPages !== null || row.statedPagesText !== null
                    || row.formattingInstructions !== null || row.otherInstructions !== null
                    || row.submitterNote !== null) && (
                    <dl className="mt-3 grid gap-x-6 gap-y-1.5 rounded-xl border border-slate-200 bg-white p-3 text-xs sm:grid-cols-2">
                      {([
                        ['Document title', row.documentLabel],
                        ['Kind of document (their words)', row.documentTypeHint],
                        ['Minimum words', row.statedMinWords],
                        ['Character limit', row.statedMaxCharacters],
                        ['Page limit', row.statedMaxPages],
                        ['Length in their words', row.statedPagesText],
                        ['Formatting', row.formattingInstructions],
                        ['Other instructions', row.otherInstructions],
                        ['Note to us', row.submitterNote],
                      ] as const).filter(([, value]) => value !== null).map(([name, value]) => (
                        <div key={name} className="min-w-0">
                          <dt className="font-semibold text-slate-500">{name}</dt>
                          <dd className="whitespace-pre-wrap break-words text-slate-800">
                            {String(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {/*
                    WHAT THE SCHOOL ALREADY HAS, AND WHO ELSE SENT THIS.
                    
                    THE QUEUE CANNOT BE READ WITHOUT IT. A submission that looks
                    new may be this year's wording for a document already in the
                    catalog, a document the school added, or the same question
                    another applicant sent last week -- three different
                    decisions. Nothing here merges or decides anything: it
                    counts, groups and shows.
                  */}
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    {(() => {
                      const context = catalog[row.schoolId]
                      const sets = context?.sets ?? []
                      const documents = sets.reduce((n, set) => n + set.requirements.length, 0)
                      if (context === undefined) return null
                      if (!context.available) {
                        return (
                          <span className="text-slate-500">
                            Existing requirements could not be read ({context.reason})
                          </span>
                        )
                      }
                      return documents === 0 ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">
                          No catalog requirements for this school
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-700">
                          Catalog already has {documents} document
                          {documents === 1 ? '' : 's'} in {sets.length} set
                          {sets.length === 1 ? '' : 's'}
                        </span>
                      )
                    })()}
                    {(pendingPerSchool[row.schoolId] ?? 0) > 1 && (
                      <span className="text-slate-600">
                        {pendingPerSchool[row.schoolId]} pending for this school
                      </span>
                    )}
                    {(duplicateGroups[row.textFingerprint]?.length ?? 0) > 1 && (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 font-semibold text-violet-900">
                        Identical wording to{' '}
                        {(duplicateGroups[row.textFingerprint]?.length ?? 1) - 1} other
                        submission
                        {(duplicateGroups[row.textFingerprint]?.length ?? 2) - 1 === 1
                          ? '' : 's'}
                      </span>
                    )}
                  </div>

                  {/* The school's existing documents, named, so "already has 2"
                      is checkable rather than a number to trust. */}
                  {(catalog[row.schoolId]?.sets ?? []).length > 0 && (
                    <ul className="mt-2 grid gap-1 text-xs text-slate-600">
                      {(catalog[row.schoolId]?.sets ?? []).flatMap((set) =>
                        set.requirements.map((req) => (
                          <li key={req.id}>
                            <span className="font-medium text-slate-800">{req.label}</span>
                            {' '}&middot; {req.documentType}
                            {set.applicationCycle !== null && ` · ${set.applicationCycle}`}
                          </li>
                        )))}
                    </ul>
                  )}

                  {/* ---- promotion ---- */}
                  {row.approvedRequirementId !== null || promoted[row.id] !== undefined ? (
                    /* ADDED, AND INACTIVE, SAID TOGETHER. The second half is
                       the part somebody would otherwise assume. */
                    <div className="mt-4">
                      {(() => {
                        const preview = localPreview[row.id]
                        return (
                          <p className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                            preview?.isActive === true
                              ? 'border-violet-300 bg-violet-50 text-violet-900'
                              : 'border-emerald-300 bg-emerald-50 text-emerald-900'
                          }`}>
                            {preview?.isActive === true
                              ? 'Added to catalog \u2014 ACTIVE IN LOCAL PREVIEW ONLY. '
                                + 'Production is untouched and remains inactive.'
                              : 'Added to catalog \u2014 inactive. It is not visible to '
                                + 'applicants until the set is activated.'}
                          </p>
                        )
                      })()}

                      {/*
                        DEVELOPMENT ONLY. Rendered only when the server reported
                        a local preview state, which it does only in
                        development and only for a set the LOCAL store holds --
                        so none of production's 63 imported sets can be toggled
                        from here, and none of this appears in a deployed build.
                      */}
                      {localPreview[row.id] !== undefined && (
                        <div className="mt-2 rounded-xl border-2 border-dashed border-violet-400 bg-violet-50/60 p-3">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-violet-900">
                            Local only &mdash; does not affect production
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-violet-900">
                            This switches the set on in{' '}
                            <code className="rounded bg-white/70 px-1">
                              local-review/dev-canonical.json
                            </code>{' '}
                            so you can see it in the applicant flow. It writes nothing to
                            the database and does not change any production set.
                          </p>

                          {localPreview[row.id]!.isActive ? (
                            <button
                              type="button"
                              disabled={previewBusy !== null}
                              onClick={() => void togglePreview(
                                row.id, localPreview[row.id]!.setId, 'deactivate')}
                              className="mt-3 rounded-xl border-2 border-violet-500 px-4 py-2 text-sm font-semibold text-violet-800 transition hover:bg-violet-100 disabled:opacity-50"
                            >
                              {previewBusy === localPreview[row.id]!.setId
                                ? 'Working\u2026'
                                : 'Deactivate Local Preview'}
                            </button>
                          ) : localPreview[row.id]!.qualifies ? (
                            <button
                              type="button"
                              disabled={previewBusy !== null}
                              onClick={() => void togglePreview(
                                row.id, localPreview[row.id]!.setId, 'activate')}
                              className="mt-3 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
                            >
                              {previewBusy === localPreview[row.id]!.setId
                                ? 'Working\u2026'
                                : 'Activate for Local Preview'}
                            </button>
                          ) : (
                            /* SAID BEFORE THE BUTTON IS LOOKED FOR, not after
                               it is pressed. These are 20261002_005's three
                               conditions, named one by one. */
                            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                              <p className="text-xs font-semibold text-amber-900">
                                Not ready to activate &mdash; production would refuse this too:
                              </p>
                              <ul className="mt-1 grid gap-0.5">
                                {localPreview[row.id]!.missing.map((item) => (
                                  <li key={item} className="text-xs text-amber-900">
                                    &bull; {item}
                                  </li>
                                ))}
                              </ul>
                              <p className="mt-1.5 text-[11px] text-amber-800">
                                Promote another submission with a verified status, a source
                                URL and a verified date to try the applicant view.
                              </p>
                            </div>
                          )}

                          {/*
                            EDIT THE ENTRY THAT PROMOTION CREATED.
                            
                            WHY IT BELONGS HERE. The three things activation
                            requires -- a verified status, a source URL and a
                            verified date -- are set-level fields that usually
                            arrive AFTER the promotion: an administrator
                            promotes what the applicant sent, then goes and
                            checks the programme page. Without this the only way
                            to supply them is to promote a different
                            submission, which makes reviewing THIS school's
                            document wait on another applicant.
                            
                            SAVING NEVER ACTIVATES. The endpoint does not read
                            is_active from the payload, so the entry stays
                            exactly as active or inactive as it was, and the
                            button above remains the only way to release it.
                          */}
                          {localPreview[row.id]!.entry !== null && (
                            editingEntry === row.id ? (
                              <PromotionEditor
                                mode="edit"
                                existing={localPreview[row.id]!.entry}
                                submission={row}
                                schoolName={(() => {
                                  const option = schools.find((s) => s.id === row.schoolId)
                                  return option === undefined
                                    ? row.schoolId : schoolLabel(option)
                                })()}
                                existingSets={catalog[row.schoolId]?.sets ?? []}
                                onCancel={() => setEditingEntry(null)}
                                onSaved={() => {
                                  setEditingEntry(null)
                                  void load()
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => setEditingEntry(row.id)}
                                className="mt-3 ml-2 rounded-xl border border-violet-400 px-4 py-2 text-sm font-semibold text-violet-800 transition hover:bg-violet-100"
                              >
                                Edit Catalog Entry
                              </button>
                            )
                          )}

                          {previewError[row.id] !== undefined && (
                            <p role="alert" className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                              {previewError[row.id]}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {promoting === row.id ? (
                        <PromotionEditor
                          submission={row}
                          /* THE DIRECTORY'S NAME WHEN IT LOADED, THE ID WHEN IT
                             DID NOT. A failed directory read costs legibility,
                             not the ability to review. */
                          schoolName={(() => {
                            const option = schools.find((s) => s.id === row.schoolId)
                            return option === undefined ? row.schoolId : schoolLabel(option)
                          })()}
                          existingSets={catalog[row.schoolId]?.sets ?? []}
                          /* THE WORD THE ADMINISTRATOR PRESSED, carried to the
                             server unchanged. Null for a new prompt, and the
                             server refuses a report that arrives without one. */
                          changeAction={changeAction}
                          onCancel={() => { setPromoting(null); setChangeAction(null) }}
                          onSaved={(result) => {
                            setPromoted({ ...promoted, [row.id]: result })
                            setPromoting(null)
                            setChangeAction(null)
                            void load()
                          }}
                        />
                      ) : (
                        row.status !== 'rejected' && row.status !== 'withdrawn' && (
                          row.kind === 'prompt-change' ? (
                            /*
                              TWO BUTTONS, TWO WORDS, NO DEFAULT.

                              An applicant reporting a change cannot know
                              whether their school dropped the old question or
                              added a second one -- so neither can we, and
                              nothing here chooses. Replacing deactivates the
                              old row and records what replaced it; adding
                              leaves it exactly as it is. The server refuses a
                              report published without one of these two words.
                            */
                            <div className="mt-4 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setChangeAction('replace')
                                  setPromoting(row.id)
                                }}
                                className="rounded-xl border-2 border-amber-500 px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-50"
                              >
                                Replace Existing Prompt
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setChangeAction('add-additional')
                                  setPromoting(row.id)
                                }}
                                className="rounded-xl border-2 border-blue-500 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-50"
                              >
                                Add as Additional Prompt
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setChangeAction(null)
                                setPromoting(row.id)
                              }}
                              className="mt-4 rounded-xl border-2 border-blue-500 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-50"
                            >
                              Add to School Requirements
                            </button>
                          )
                        )
                      )}
                    </>
                  )}

                  {/*
                    A REPORT'S FOUR CHOICES, AND ONLY FOUR.

                    Replace and Add live above, beside the editor they open,
                    because both publish catalog data and both need the
                    requirement fields filled in. Reject and Duplicate are
                    decisions about the submission alone and need nothing, so
                    they are here.

                    THERE IS NO "Approve" ON A REPORT. Approving one would
                    record a yes without saying to WHAT -- replace or add --
                    which is the inference this whole feature exists to avoid.
                    The catalog label field goes with it: a replacement's label
                    is typed in the editor, beside the wording it labels.
                  */}
                  {row.status === 'pending' && row.kind === 'prompt-change' && (
                    <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void decide(row.id, 'rejected')}
                        className="rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null || copies < 2}
                        onClick={() => {
                          const other = rows.find((r) => r.id !== row.id
                            && r.schoolId === row.schoolId
                            && r.textFingerprint === row.textFingerprint)
                          if (other) void decide(row.id, 'duplicate', { duplicateOf: other.id })
                        }}
                        className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                      >
                        Duplicate
                      </button>
                      {copies < 2 && (
                        <span className="text-xs text-slate-500">
                          Duplicate needs another report with the same wording for this school.
                        </span>
                      )}
                    </div>
                  )}

                  {row.status === 'pending' && row.kind !== 'prompt-change' && (
                    <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
                      <label htmlFor={`label-${row.id}`} className="sr-only">Catalog label</label>
                      <input
                        id={`label-${row.id}`}
                        type="text"
                        value={labels[row.id] ?? ''}
                        onChange={(event) => setLabels({ ...labels, [row.id]: event.target.value })}
                        placeholder="Catalog label, e.g. Essay 1"
                        className="w-56 rounded-xl border border-slate-300 px-3 py-2 text-sm"
                      />
                      {/* Approval is impossible without a label somebody typed,
                          so nothing is ever published automatically. */}
                      <button
                        type="button"
                        disabled={busy !== null || (labels[row.id] ?? '').trim() === ''}
                        onClick={() => void decide(row.id, 'approved', { label: labels[row.id] })}
                        className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void decide(row.id, 'rejected')}
                        className="rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null || copies < 2}
                        onClick={() => {
                          const other = rows.find((r) => r.id !== row.id
                            && r.schoolId === row.schoolId
                            && r.textFingerprint === row.textFingerprint)
                          if (other) void decide(row.id, 'duplicate', { duplicateOf: other.id })
                        }}
                        className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                      >
                        Mark duplicate
                      </button>
                    </div>
                  )}

                  {row.status === 'approved' && row.approvedPromptId !== null && (
                    <p className="mt-4 font-mono text-xs text-emerald-700">
                      published as {row.approvedPromptId}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </main>
    </div>
  )
}
