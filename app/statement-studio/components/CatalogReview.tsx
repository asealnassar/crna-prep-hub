'use client'

/**
 * The imported requirement catalog, for DEVELOPMENT REVIEW ONLY.
 *
 * THE SAME CHECKLIST THE APPLICANT WILL SEE. Every school below is rendered
 * through RequirementChecklist, fed by checklistView(), fed by sets the server
 * assembled with requirementFromRow() -- the production reader. There is no
 * second rendering path, which is the only way looking at this screen tells you
 * anything about the real one.
 *
 * IT CANNOT CREATE, READ OR CHARGE ANYTHING. The sets arrive as props, already
 * read on the server. onStart puts a requirement id in React state so the
 * Continue state is reachable; `demo: true` makes every control render as a
 * span rather than a link, so there is nothing to navigate to and nothing to
 * post. No fetch, no draft, no model call, no usage.
 *
 * WHY IT IS NOT THE FIXTURE PREVIEW. RequirementPreview shows eight hand-built
 * worked examples -- one per requirement SHAPE -- and is the right screen for
 * checking that the interface handles every shape. This one shows the 63 real
 * schools actually sitting in production, inactive, so their CONTENT can be
 * read before anybody releases them. Different questions, so both exist.
 */
import { useMemo, useState } from 'react'
import { checklistView, type StartedDraft } from '@/lib/statement/requirements/checklistView'
import type { RequirementSet } from '@/lib/statement/requirements/requirement'
import RequirementChecklist from './RequirementChecklist'

export interface CatalogReviewProps {
  readonly sets: readonly RequirementSet[]
  readonly declaredSetCount: number
  readonly declaredDocumentCount: number
  readonly parsedSetCount: number
  readonly parsedDocumentCount: number
  readonly setFingerprint: string
  readonly documentFingerprint: string
  readonly correspondsTo: string
}

/** A status that is not plain `verified` is called out rather than left to be noticed. */
const STATUS_STYLE: Readonly<Record<string, string>> = {
  verified: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  'needs-review': 'bg-amber-200 text-amber-950 border-amber-500 font-bold',
  conflicting: 'bg-rose-200 text-rose-950 border-rose-500 font-bold',
  unverified: 'bg-slate-200 text-slate-900 border-slate-400',
}

export default function CatalogReview(props: CatalogReviewProps) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(props.sets[0]?.id ?? '')
  const [started, setStarted] = useState<readonly string[]>([])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return props.sets
    return props.sets.filter((set) =>
      set.schoolName.toLowerCase().includes(needle)
      || set.requirements.some((r) =>
        r.label.toLowerCase().includes(needle)
        || r.promptText.toLowerCase().includes(needle)))
  }, [props.sets, query])

  const selected = props.sets.find((set) => set.id === selectedId) ?? matches[0] ?? null

  const drafts: readonly StartedDraft[] = started.map((requirementId) => ({
    id: `review-${requirementId}`,
    requirementId,
    title: 'Review draft',
    updatedAt: new Date().toISOString(),
    words: 312,
  }))

  // A count mismatch means the payload and what parsed disagree, which is the
  // one thing that would make this review misleading. It is stated, not hidden.
  const setsAgree = props.parsedSetCount === props.declaredSetCount
  const docsAgree = props.parsedDocumentCount === props.declaredDocumentCount

  return (
    <section aria-labelledby="catalog-review-heading" className="grid gap-4">
      {/* ------------------------------------------------------------ banner */}
      <div className="rounded-2xl border-2 border-dashed border-rose-500 bg-rose-50 p-5">
        <h2
          id="catalog-review-heading"
          className="text-sm font-black uppercase tracking-widest text-rose-900"
        >
          Local review · not the applicant experience
        </h2>
        <p className="mt-1 max-w-3xl text-xs font-semibold leading-relaxed text-rose-900">
          These are the {props.declaredSetCount} requirement sets imported into production,
          where every one of them is <span className="font-black">inactive</span>. No
          applicant can see any of this. The rows are read from a local file on the
          server — this screen makes no database query, creates no draft and calls no
          model.
        </p>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-rose-900">
          <div className="flex gap-1.5">
            <dt className="font-semibold">Schools</dt>
            <dd className={setsAgree ? 'font-mono' : 'font-mono font-black text-rose-700'}>
              {props.parsedSetCount} of {props.declaredSetCount}
              {setsAgree ? '' : ' ← MISMATCH'}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-semibold">Writing requirements</dt>
            <dd className={docsAgree ? 'font-mono' : 'font-mono font-black text-rose-700'}>
              {props.parsedDocumentCount} of {props.declaredDocumentCount}
              {docsAgree ? '' : ' ← MISMATCH'}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-semibold">Set fingerprint</dt>
            <dd className="font-mono">{props.setFingerprint.slice(0, 12)}…</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-semibold">Document fingerprint</dt>
            <dd className="font-mono">{props.documentFingerprint.slice(0, 12)}…</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] text-rose-800">
          Payload corresponds to <code className="font-mono">{props.correspondsTo}</code>.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        {/* ------------------------------------------------------ school list */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <label htmlFor="catalog-search" className="text-xs font-semibold text-slate-700">
            Find a school, document or prompt
          </label>
          <input
            id="catalog-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Boston College, Gonzaga, 1.5 pages…"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                       outline-none focus:border-slate-900"
          />
          <p className="mt-2 text-[11px] text-slate-600">
            {matches.length} of {props.sets.length} schools
          </p>

          <ul className="mt-2 grid max-h-[32rem] gap-1 overflow-y-auto pr-1">
            {matches.map((set) => {
              const isSelected = selected !== null && set.id === selected.id
              const status = set.verification.status
              return (
                <li key={set.id}>
                  <button
                    type="button"
                    onClick={() => { setSelectedId(set.id); setStarted([]) }}
                    aria-pressed={isSelected}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                      isSelected
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-900 hover:bg-slate-50'}`}
                  >
                    <span className="block truncate text-sm font-semibold">
                      {set.schoolName}
                    </span>
                    <span className={`mt-0.5 flex items-center gap-1.5 text-[11px] ${
                      isSelected ? 'text-slate-300' : 'text-slate-600'}`}
                    >
                      <span>
                        {set.requirements.length} document
                        {set.requirements.length === 1 ? '' : 's'}
                      </span>
                      {status === 'verified' ? null : (
                        <span className={`rounded border px-1 py-px font-bold uppercase
                                          tracking-wide ${STATUS_STYLE[status] ?? ''}`}>
                          {status}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {/* -------------------------------------------------------- checklist */}
        <div className="grid gap-4">
          {selected === null ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
              No school matches that search.
            </p>
          ) : (
            <>
              {/* The provenance, which the checklist does not show in full and
                  which is the thing under review as much as the wording is. */}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <dl className="grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-slate-700">Verification status</dt>
                    <dd>
                      <span className={`inline-block rounded border px-1.5 py-px text-[11px]
                                        font-bold uppercase tracking-wide
                                        ${STATUS_STYLE[selected.verification.status] ?? ''}`}>
                        {selected.verification.status}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-700">Checked on</dt>
                    <dd className="font-mono text-slate-900">
                      {selected.verification.verifiedOn ?? '(none)'}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="font-semibold text-slate-700">Source</dt>
                    <dd className="break-all font-mono text-[11px] text-slate-900">
                      {selected.verification.sourceUrl ?? '(none)'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-700">Wording is verbatim</dt>
                    <dd className="text-slate-900">
                      {selected.verification.verbatim ? 'yes' : 'no'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-slate-700">Application cycle</dt>
                    <dd className="text-slate-900">
                      {selected.applicationCycle ?? '(not stated)'}
                    </dd>
                  </div>
                  {selected.originalText === '' ? null : (
                    <div className="sm:col-span-2">
                      <dt className="font-semibold text-slate-700">
                        As recorded, before structuring
                      </dt>
                      <dd className="mt-0.5 whitespace-pre-wrap text-[11px] leading-relaxed
                                     text-slate-800">
                        {selected.originalText}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <RequirementChecklist
                  view={checklistView({ set: selected, drafts })}
                  actions={{
                    // NO REQUEST. Local state only — see the module header.
                    onStart: (requirementId) =>
                      setStarted((current) =>
                        current.includes(requirementId)
                          ? current
                          : [...current, requirementId]),
                    // A dead href: this screen creates no draft to open. With
                    // `demo` set the checklist renders a span, so it is never
                    // navigated to.
                    draftHref: () => '#review-no-draft',
                    demo: true,
                  }}
                />
              </div>

              {started.length > 0 && (
                <button
                  type="button"
                  onClick={() => setStarted([])}
                  className="justify-self-start text-[11px] font-semibold text-slate-700
                             underline underline-offset-2"
                >
                  Reset the started state
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
