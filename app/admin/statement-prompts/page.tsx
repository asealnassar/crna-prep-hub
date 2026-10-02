'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  SUBMISSION_STATUSES,
  type SubmissionStatus,
} from '@/lib/statement/draft/promptSubmission'
import { schoolLabel, wordLimitLabel } from '@/lib/statement/draft/picker'
import type { SchoolOption } from '@/lib/statement/draft/schoolPicker'

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
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
          <Link href="/"><span className="text-xl font-bold text-blue-600">CRNA Prep Hub</span></Link>
          <nav className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <Link href="/admin" className="text-slate-600 hover:text-blue-600">Manage Schools</Link>
            <Link href="/admin/schools" className="text-slate-600 hover:text-blue-600">Edit Schools</Link>
            <Link href="/admin/school-unlocks" className="text-slate-600 hover:text-blue-600">Unlock Requests</Link>
            <Link href="/admin/reports" className="text-slate-600 hover:text-blue-600">Error Reports</Link>
            <span className="font-semibold text-blue-700">Prompt Submissions</span>
          </nav>
        </div>
      </header>

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

                  {/* Escaped text in a paragraph. Never markup. */}
                  <p className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-800">
                    {row.promptText}
                  </p>

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

                  {row.status === 'pending' && (
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
