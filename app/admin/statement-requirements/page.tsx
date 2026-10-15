'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import PromotionEditor, { type ExistingEntry } from '../statement-prompts/PromotionEditor'
import AdminNav from '../AdminNav'

/**
 * The canonical prompt catalog.
 *
 * ADMIN-ONLY, AND NOT BECAUSE OF THIS FILE. Everything here comes from
 * /api/admin/statement-requirements, which is gated on simulated-live, then
 * authenticates, then checks the shared admin allowlist. A browser that
 * rendered this component without passing those would see an error from every
 * request it made.
 *
 * TWO SOURCES, AND THE SCREEN NEVER BLURS THEM. The imported 63 sets are
 * production's reviewed catalog, shown read-only; the local ones were created
 * here and are editable and previewable. Every row says which it is, because
 * "can I change this" and "is this real" are the two questions a catalog
 * manager is for.
 *
 * NOTHING SUBMITTED OR IMPORTED IS RENDERED AS MARKUP. Prompt wording, labels
 * and instructions all go into escaped React text; a source link carries
 * rel="noopener noreferrer nofollow" and is never fetched by the server.
 */

const ENDPOINT = '/api/admin/statement-requirements'

/** The nine values 20261005_007 constrains document_type to. */
const DOCUMENT_TYPES = [
  'personal-statement', 'goal-statement', 'diversity-statement',
  'writing-sample', 'additional-response', 'other',
  'statement-of-purpose', 'autobiographical-essay', 'supplemental-essay',
] as const

const VERIFICATION = ['unverified', 'needs-review', 'verified', 'conflicting'] as const

interface CatalogDocument {
  readonly id: string
  readonly label?: unknown
  readonly document_type?: unknown
  readonly prompt_text?: unknown
  readonly components?: unknown
  readonly min_words?: unknown
  readonly max_words?: unknown
  readonly min_characters?: unknown
  readonly max_characters?: unknown
  readonly characters_include_spaces?: unknown
  readonly min_pages?: unknown
  readonly max_pages?: unknown
  readonly words_enforcement?: unknown
  readonly words_stated_as?: unknown
  readonly characters_enforcement?: unknown
  readonly characters_stated_as?: unknown
  readonly pages_enforcement?: unknown
  readonly pages_stated_as?: unknown
  readonly unenforced_length?: unknown
  readonly page_spacing?: unknown
  readonly font_size_pt?: unknown
  readonly font_family?: unknown
  readonly margins_inches?: unknown
  readonly citation_style?: unknown
  readonly citation_family?: unknown
  readonly min_references?: unknown
  readonly other_instructions?: unknown
  readonly choice_group?: unknown
  readonly is_optional?: unknown
  readonly notes?: unknown
  readonly display_order?: unknown
  readonly is_active?: unknown
  readonly source: 'import' | 'local'
  readonly editable: boolean
  readonly provenance: 'catalog-import' | 'student-submission' | 'admin-created'
  readonly submissionId: string | null
}

interface CatalogSet {
  readonly id: string
  readonly schoolId: string
  readonly schoolName: string
  readonly applicationCycle: string | null
  readonly verificationStatus: string
  readonly sourceUrl: string | null
  readonly verifiedOn: string | null
  readonly isActive: boolean
  readonly notes: readonly unknown[]
  readonly originalText: unknown
  readonly source: 'import' | 'local'
  readonly editable: boolean
  readonly activationMissing: readonly string[] | null
  readonly documentCount: number
  readonly documents: readonly CatalogDocument[]
}

const VERIFICATION_STYLE: Record<string, string> = {
  verified: 'bg-emerald-100 text-emerald-800',
  'needs-review': 'bg-amber-100 text-amber-800',
  unverified: 'bg-slate-200 text-slate-700',
  conflicting: 'bg-rose-100 text-rose-800',
}

/** Escaped text, or a dash. Never markup, and never an empty-looking field. */
const show = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((item) => (
      typeof item === 'object' && item !== null
        ? String((item as { text?: unknown }).text ?? JSON.stringify(item))
        : String(item)
    )).join(' · ')
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

export default function StatementRequirementsPage() {
  const [sets, setSets] = useState<CatalogSet[]>([])
  const [schools, setSchools] = useState<readonly { id: string; name: string }[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const [verificationFilter, setVerificationFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [cycleFilter, setCycleFilter] = useState<string>('all')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'import' | 'local'>('all')

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** Which local document is open in the editor. */
  const [editing, setEditing] = useState<{ setId: string; document: CatalogDocument } | null>(null)
  /** Whether the Add Requirement form is open. */
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Set when an imported row's Edit affordance is pressed. */
  const [readOnlyNotice, setReadOnlyNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(ENDPOINT)
      if (!response.ok) {
        setError(
          response.status === 403 ? 'You are not authorized to manage requirements.'
            : response.status === 404 ? 'The catalog manager is development-only.'
            : 'The catalog could not be loaded.',
        )
        setSets([])
        return
      }
      const body = await response.json().catch(() => null)
      setSets(Array.isArray(body?.sets) ? body.sets : [])
      setSchools(Array.isArray(body?.schools) ? body.schools : [])
      setCounts(body?.counts ?? {})
    } catch {
      setError('The catalog could not be loaded.')
      setSets([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  /** The cycles actually present, so the filter offers nothing empty. */
  const cycles = useMemo(() => [...new Set(sets
    .map((set) => set.applicationCycle)
    .filter((cycle): cycle is string => typeof cycle === 'string' && cycle !== ''))].sort(),
  [sets])

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return sets.filter((set) => {
      if (needle !== '' && !set.schoolName.toLowerCase().includes(needle)) return false
      if (activeFilter === 'active' && !set.isActive) return false
      if (activeFilter === 'inactive' && set.isActive) return false
      if (verificationFilter !== 'all' && set.verificationStatus !== verificationFilter) {
        return false
      }
      if (cycleFilter !== 'all' && set.applicationCycle !== cycleFilter) return false
      if (sourceFilter !== 'all' && set.source !== sourceFilter) return false
      // A DOCUMENT-TYPE FILTER IS A QUESTION ABOUT THE DOCUMENTS, so a set
      // matches when any of its documents does -- otherwise filtering by type
      // would hide the school that has one.
      if (typeFilter !== 'all'
        && !set.documents.some((document) => document.document_type === typeFilter)) {
        return false
      }
      return true
    })
  }, [sets, search, activeFilter, verificationFilter, typeFilter, cycleFilter, sourceFilter])

  /**
   * Switch a LOCAL set on or off for preview.
   *
   * THE SAME TWO FUNCTIONS THE SUBMISSION QUEUE CALLS. The readiness rule --
   * verified, with a source URL and a verified date -- lives in
   * localCanonical.ts and is not restated here.
   */
  const toggle = useCallback(async (setId: string, action: 'activate' | 'deactivate') => {
    if (busy !== null) return
    setBusy(setId)
    setNotice(null)
    try {
      const response = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, setId }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setNotice(typeof body?.error === 'string'
          ? body.error
          : 'That local preview could not be changed.')
        return
      }
      await load()
    } catch {
      setNotice('That local preview could not be changed.')
    } finally {
      setBusy(null)
    }
  }, [busy, load])

  const localSetsFor = useCallback((schoolId: string) => sets
    .filter((set) => set.source === 'local' && set.schoolId === schoolId)
    .map((set) => ({
      id: set.id,
      applicationCycle: set.applicationCycle,
      requirements: set.documents.map((document) => ({ label: show(document.label) })),
    })), [sets])

  const label = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500'

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Statement requirements
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {loading ? 'Loading the catalog…' : (
                <>
                  {counts.imported ?? 0} imported set{counts.imported === 1 ? '' : 's'}
                  {' '}({counts.importedDocuments ?? 0} document
                  {counts.importedDocuments === 1 ? '' : 's'},{' '}
                  {counts.activeImported ?? 0} active) ·{' '}
                  {counts.local ?? 0} local set{counts.local === 1 ? '' : 's'}
                  {' '}({counts.localDocuments ?? 0} document
                  {counts.localDocuments === 1 ? '' : 's'})
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { setAdding((open) => !open); setReadOnlyNotice(null) }}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            {adding ? 'Close' : 'Add Requirement'}
          </button>
        </div>

        {/* LOCAL ONLY, said once at the top of the page. */}
        <p className="mt-4 rounded-xl border-2 border-dashed border-violet-400 bg-violet-50/60 px-3 py-2 text-xs leading-relaxed text-violet-900">
          <span className="font-bold uppercase tracking-wide">Local only</span> — edits,
          additions and activation here write to{' '}
          <code className="rounded bg-white/70 px-1">local-review/dev-canonical.json</code>.
          The {counts.imported ?? 63} imported sets are production-backed and read-only in this
          rehearsal.
        </p>

        {adding && (
          <PromotionEditor
            mode="create"
            schoolName=""
            schoolChoices={schools}
            existingSets={[]}
            endpoint={ENDPOINT}
            onCancel={() => setAdding(false)}
            onSaved={() => { setAdding(false); void load() }}
          />
        )}

        {/* ---- search and filters ---- */}
        <div className="mt-5 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-6">
          <div className="sm:col-span-3 lg:col-span-2">
            <label htmlFor="q" className={label}>Search school</label>
            <input
              id="q"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Barry, Duke, Rutgers…"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="f-active" className={label}>Status</label>
            <select id="f-active" value={activeFilter}
              onChange={(e) => setActiveFilter(e.target.value as 'all' | 'active' | 'inactive')}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <div>
            <label htmlFor="f-verif" className={label}>Verification</label>
            <select id="f-verif" value={verificationFilter}
              onChange={(e) => setVerificationFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
              <option value="all">All</option>
              {VERIFICATION.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-type" className={label}>Document type</label>
            <select id="f-type" value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
              <option value="all">All</option>
              {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="f-cycle" className={label}>Cycle</label>
            <select id="f-cycle" value={cycleFilter}
              onChange={(e) => setCycleFilter(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
              <option value="all">All</option>
              {cycles.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="sm:col-span-3 lg:col-span-1">
            <label htmlFor="f-source" className={label}>Source</label>
            <select id="f-source" value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as 'all' | 'import' | 'local')}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
              <option value="all">All</option>
              <option value="import">Verified catalog import</option>
              <option value="local">Created locally</option>
            </select>
          </div>
        </div>

        {error !== null && (
          <p role="alert" className="mt-5 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </p>
        )}
        {notice !== null && (
          <p role="alert" className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {notice}
          </p>
        )}
        {readOnlyNotice !== null && (
          <p role="alert" className="mt-5 rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-800">
            {readOnlyNotice}
          </p>
        )}

        <p className="mt-5 text-xs text-slate-500">
          {loading ? '' : `${shown.length} of ${sets.length} sets shown`}
        </p>

        {/* ---- the catalog ---- */}
        <ul className="mt-2 grid gap-3">
          {shown.map((set) => {
            const open = expanded[set.id] === true
            return (
              <li key={set.id} className="rounded-2xl border border-slate-200 bg-white">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded({ ...expanded, [set.id]: !open })}
                  className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-4 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-base font-semibold text-slate-900">
                      {set.schoolName}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {set.applicationCycle ?? 'no cycle'} ·{' '}
                      {set.documentCount} requirement{set.documentCount === 1 ? '' : 's'}
                      {set.verifiedOn === null ? '' : ` · verified ${String(set.verifiedOn)}`}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {/* PROVENANCE, ON THE ROW. "Can I change this" is the first
                        question a catalog manager answers. */}
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      set.source === 'import'
                        ? 'bg-sky-100 text-sky-900' : 'bg-violet-100 text-violet-900'
                    }`}>
                      {set.source === 'import' ? 'Verified catalog import' : 'Created locally'}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      VERIFICATION_STYLE[set.verificationStatus] ?? 'bg-slate-200 text-slate-700'
                    }`}>
                      {set.verificationStatus}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      set.isActive ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'
                    }`}>
                      {set.isActive ? 'active' : 'inactive'}
                    </span>
                    <span aria-hidden className="text-slate-400">{open ? '▴' : '▾'}</span>
                  </span>
                </button>

                {open && (
                  <div className="border-t border-slate-200 px-5 py-4">
                    {/* ---- set-level facts ---- */}
                    <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
                      <div>
                        <dt className={label}>Application cycle</dt>
                        <dd className="text-slate-800">{show(set.applicationCycle)}</dd>
                      </div>
                      <div>
                        <dt className={label}>Verified on</dt>
                        <dd className="text-slate-800">{show(set.verifiedOn)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className={label}>Source URL</dt>
                        <dd className="truncate text-slate-800">
                          {set.sourceUrl === null ? '—' : (
                            <a href={String(set.sourceUrl)} target="_blank"
                              rel="noopener noreferrer nofollow"
                              className="text-blue-700 underline underline-offset-2">
                              {String(set.sourceUrl)}
                            </a>
                          )}
                        </dd>
                      </div>
                      {set.notes.length > 0 && (
                        <div className="sm:col-span-3">
                          <dt className={label}>Set notes</dt>
                          <dd className="text-slate-800">{show(set.notes)}</dd>
                        </div>
                      )}
                    </dl>

                    {/* ---- local preview controls ---- */}
                    {set.source === 'local' && (
                      <div className="mt-4 rounded-xl border-2 border-dashed border-violet-400 bg-violet-50/60 p-3">
                        <p className="text-[11px] font-bold uppercase tracking-wide text-violet-900">
                          Local only — does not affect production
                        </p>
                        {set.isActive ? (
                          <button type="button" disabled={busy !== null}
                            onClick={() => void toggle(set.id, 'deactivate')}
                            className="mt-2 rounded-xl border-2 border-violet-500 px-4 py-2 text-sm font-semibold text-violet-800 disabled:opacity-50">
                            {busy === set.id ? 'Working…' : 'Deactivate Local Preview'}
                          </button>
                        ) : (set.activationMissing ?? []).length === 0 ? (
                          <button type="button" disabled={busy !== null}
                            onClick={() => void toggle(set.id, 'activate')}
                            className="mt-2 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                            {busy === set.id ? 'Working…' : 'Activate for Local Preview'}
                          </button>
                        ) : (
                          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
                            <p className="text-xs font-semibold text-amber-900">
                              Not ready to activate — production would refuse this too:
                            </p>
                            <ul className="mt-1 grid gap-0.5">
                              {(set.activationMissing ?? []).map((item) => (
                                <li key={item} className="text-xs text-amber-900">• {item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ---- the documents ---- */}
                    <h3 className="mt-5 text-xs font-bold uppercase tracking-wide text-slate-500">
                      Writing requirements
                    </h3>
                    <ul className="mt-2 grid gap-3">
                      {set.documents.map((document) => (
                        <li key={document.id} className="rounded-xl border border-slate-200 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-slate-900">
                                {show(document.label)}
                              </p>
                              <p className="mt-0.5 text-xs text-slate-500">
                                {show(document.document_type)} · order{' '}
                                {show(document.display_order)} ·{' '}
                                {document.is_optional === true ? 'optional' : 'required'} ·{' '}
                                {document.is_active === true ? 'active' : 'inactive'}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {/* SOURCE: where this canonical row came from. A
                                  student-submission row links back to the
                                  original, which remains a separate record. */}
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                                {document.provenance === 'catalog-import'
                                  ? 'Source: Verified catalog import'
                                  : document.provenance === 'student-submission'
                                    ? 'Source: Student submission'
                                    : 'Source: Added by admin'}
                              </span>
                              {document.submissionId !== null && (
                                <Link
                                  href="/admin/statement-prompts"
                                  className="text-[11px] font-semibold text-blue-700 underline underline-offset-2"
                                >
                                  View submission
                                </Link>
                              )}
                              {document.editable ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReadOnlyNotice(null)
                                    setEditing({ setId: set.id, document })
                                  }}
                                  className="rounded-lg border border-violet-400 px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-50"
                                >
                                  Edit
                                </button>
                              ) : (
                                /* NO DATABASE WRITE IS ATTEMPTED. The affordance
                                   explains itself instead of failing. */
                                <button
                                  type="button"
                                  onClick={() => setReadOnlyNotice(
                                    'Production-backed catalog entry — editing is disabled '
                                    + 'in local rehearsal.')}
                                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-500"
                                >
                                  Edit
                                </button>
                              )}
                            </div>
                          </div>

                          <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-800">
                            {show(document.prompt_text)}
                          </p>

                          <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
                            {([
                              ['Components', document.components],
                              ['Words', `${show(document.min_words)} – ${show(document.max_words)}`],
                              ['Words enforcement', document.words_enforcement],
                              ['Words stated as', document.words_stated_as],
                              ['Characters', `${show(document.min_characters)} – ${show(document.max_characters)}`],
                              ['Characters enforcement', document.characters_enforcement],
                              ['Characters stated as', document.characters_stated_as],
                              ['Includes spaces', document.characters_include_spaces],
                              ['Pages', `${show(document.min_pages)} – ${show(document.max_pages)}`],
                              ['Pages enforcement', document.pages_enforcement],
                              ['Pages stated as', document.pages_stated_as],
                              ['Prose-only length', document.unenforced_length],
                              ['Spacing', document.page_spacing],
                              ['Font', document.font_family],
                              ['Font size (pt)', document.font_size_pt],
                              ['Margins (in)', document.margins_inches],
                              ['Citation style', document.citation_style],
                              ['Citation family', document.citation_family],
                              ['Minimum references', document.min_references],
                              ['Choice group', document.choice_group],
                              ['Other instructions', document.other_instructions],
                              ['Notes', document.notes],
                            ] as const).map(([name, value]) => (
                              <div key={name} className="min-w-0">
                                <dt className={label}>{name}</dt>
                                <dd className="whitespace-pre-wrap break-words text-slate-800">
                                  {show(value)}
                                </dd>
                              </div>
                            ))}
                          </dl>

                          {editing?.document.id === document.id && (
                            <PromotionEditor
                              mode="edit"
                              existing={{
                                set: {
                                  id: set.id,
                                  application_cycle: set.applicationCycle,
                                  verification_status: set.verificationStatus,
                                  source_url: set.sourceUrl,
                                  verified_on: set.verifiedOn,
                                  notes: set.notes,
                                  original_text: set.originalText,
                                },
                                requirement: document as unknown as Record<string, unknown>,
                              } satisfies ExistingEntry}
                              schoolName={set.schoolName}
                              existingSets={localSetsFor(set.schoolId)}
                              endpoint={ENDPOINT}
                              onCancel={() => setEditing(null)}
                              onSaved={() => { setEditing(null); void load() }}
                            />
                          )}
                        </li>
                      ))}
                      {set.documents.length === 0 && (
                        <li className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">
                          This set has no writing requirements yet.
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        {!loading && shown.length === 0 && error === null && (
          <p className="mt-6 rounded-xl border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No sets match those filters.
          </p>
        )}
      </main>
    </div>
  )
}
