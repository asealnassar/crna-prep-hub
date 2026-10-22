'use client'

import { useMemo, useState, type ReactElement } from 'react'
import Link from 'next/link'
import type { StatementDraftSummary } from '@/lib/statement/draft/rows'
import type { SchoolOption } from '@/lib/statement/draft/schoolPicker'
import {
  DRAFT_ORDERS,
  draftDay,
  draftPath,
  draftTally,
  isDraftOrder,
  matchDrafts,
  orderDrafts,
  type DraftOrder,
} from '@/lib/statement/draft/library'
import {
  ANALYSIS_LIBRARY_NOTICE, ANALYSIS_STEP_BODY, analysisStepIsLive,
  type AnalysisOffer,
} from '@/lib/statement/draft/reviewAccess'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import NewDraftDialog from './NewDraftDialog'
import CatalogReview, { type CatalogReviewProps } from './CatalogReview'
import RequirementPreview from './RequirementPreview'

/**
 * The statement draft library.
 *
 * SUMMARIES, NOT DRAFTS. The prop type is StatementDraftSummary -- a distinct
 * type from StatementDraft with no body field at all, so no statement text can
 * reach this component even by accident. The full text is loaded by
 * /statement-studio/[id] when a draft is opened, and only then.
 *
 * NAVIGATION IS A LINK, not a click handler. Opening a draft is a plain
 * document navigation, so it should be a real anchor: middle-click, Cmd-click
 * and "open in new tab" all work, and it needs no JavaScript to function.
 *
 * SEARCHING AND ORDERING ARE NOT DONE HERE. Both are pure functions in
 * lib/statement/draft/library.ts, where node --test can reach them; this file
 * holds the two pieces of state they are called with and nothing else. The
 * default order is still the server's own -- `orderDrafts(rows, 'edited')`
 * hands back the same array it was given -- so the browser reorders only when
 * somebody asks it to. The earlier note here said sorting controls were a
 * later job; this is that job.
 *
 * WHAT IS DELIBERATELY NOT SHOWN. No school or prompt appears on a card,
 * because StatementDraftSummary carries neither -- the list projection is
 * exactly id, title, revision and the two timestamps, and widening it to put a
 * school name on a card would pull prompt text across the wire for every row.
 *
 * THE ARTWORK IS DRAWN HERE, not downloaded. DeskScene below is plain inline
 * SVG: nothing is fetched, no image is licensed from anyone, and the hero
 * costs no extra request. It is marked aria-hidden because it says nothing the
 * heading beside it does not already say.
 *
 * THE NOTICE SAYS WHAT IS ACTUALLY TRUE. Drafting and document upload are
 * implemented -- the editor takes .pdf, .docx and .txt through the gated
 * extraction endpoint -- and the V2 analyser is not. The previous wording
 * claimed upload was unwired, which stopped being true when upload shipped.
 */
export default function LibraryClient({
  analysisOffer,
  drafts,
  schools,
  schoolsUnavailable,
  submissionsEnabled,
  pastePreview,
  requirementsPreview = false,
  fixturesPreview = false,
  reviewCatalog = null,
}: {
  /**
   * Whether analysis is offered, withheld by plan, or switched off -- decided on
   * the server from the plan and the capability, never re-derived here.
   */
  analysisOffer: AnalysisOffer
  drafts: readonly StatementDraftSummary[]
  /** The directory, three columns, read on the server after the gate. */
  schools: readonly SchoolOption[]
  /** The directory could not be READ. Not the same as it being empty. */
  schoolsUnavailable: boolean
  /** Whether a prompt the catalog lacks may be pasted. Read on the server. */
  submissionsEnabled: boolean
  /** Development-only: draw the paste screens without wiring them up. */
  pastePreview: boolean
  /**
   * Development-only: draw the school writing-requirement checklists from the
   * research fixtures.
   *
   * Defaults to false, so a page that does not pass it draws none. Decided on
   * the server, after the Studio gate, from NODE_ENV and an explicit query
   * parameter -- see app/statement-studio/page.tsx.
   */
  requirementsPreview?: boolean
  /** The eight shape fixtures, at ?preview=fixtures. */
  fixturesPreview?: boolean
  /**
   * The 63 imported sets, read on the server. Null when the gate is closed OR
   * when the local payload has not been generated -- two states this screen
   * distinguishes, because "not allowed" and "not built yet" need different
   * answers.
   */
  reviewCatalog?: CatalogReviewProps | null
}) {
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [order, setOrder] = useState<DraftOrder>('edited')
  const { sidebarCollapsed } = useSidebarCollapsed()

  const empty = drafts.length === 0
  const visible = useMemo(
    () => orderDrafts(matchDrafts(drafts, query), order),
    [drafts, query, order],
  )

  return (
    // THE SIDEBAR IS `fixed`, so it is out of flow: without a reservation this
    // page starts at the left edge of the VIEWPORT with the nav painted on top
    // of it, and mx-auto then centres against the viewport rather than against
    // the workspace -- which slides the whole page left and clips its headings.
    // Every other page reserves the width the same way; resume-studio's
    // DashboardClient and app/dashboard are the two nearest copies of this.
    //
    // The width is READ FROM THE SHARED CONTEXT rather than hard-coded, so the
    // page reflows when the nav is collapsed instead of stranding a gap beside
    // it. `min-w-0` is what actually prevents a sideways scroll: a flex item
    // defaults to min-width:auto and would refuse to shrink below its content.
    // `pt-16 lg:pt-0` clears the floating menu button that the nav shows below
    // lg, where the nav itself is off-canvas and no left reservation is wanted.
    <div className="flex min-h-screen bg-slate-50">
      <div
        className={`min-w-0 flex-1 transition-all duration-300 ${
          sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'
        } pt-16 lg:pt-0`}
      >
        {/*
          THE PREVIEW REPLACES THE LIBRARY, IT DOES NOT SIT BESIDE IT.

          WHY THIS IS A CONDITIONAL AND NOT A SECOND BLOCK. The root element of
          this component is `flex`, and its one child is the column that holds
          everything -- `min-w-0 flex-1`, which is what lets the page reflow
          when the nav collapses. A preview rendered as a SECOND child of that
          flex row becomes a column BESIDE the page: it claims its own width and
          `flex-1` obligingly shrinks the real content to fit, which squeezed
          the hero, the three step cards and the draft library into narrow
          strips and wrapped their text to pieces. That is exactly what
          happened, and the comment that shipped with it said "below the
          library" because it was below the `</main>`'s PARENT rather than
          below the `</main>`.

          SO THERE IS ONE CONTENT COLUMN AND IT RENDERS ONE THING. The preview
          gets the same `mx-auto w-full max-w-7xl` container the library uses,
          so it is centred and padded identically and inherits the same
          responsive behaviour instead of having its own.

          AND WITHOUT THE PARAMETER THIS BRANCH IS NOT TAKEN, so the approved
          layout below is rendered by exactly the markup that rendered it
          before -- not a reconstruction of it.
        */}
        {requirementsPreview || fixturesPreview ? (
          <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10">
            {/* ?preview=fixtures -- the eight hand-built SHAPE examples. */}
            {fixturesPreview ? <RequirementPreview /> : null}

            {/* ?preview=requirements -- the 63 sets actually in production.
                NO SILENT FALLBACK: if the payload has not been generated the
                screen says so and shows nothing, because showing eight worked
                examples to somebody reviewing 63 real schools would read as an
                answer. */}
            {requirementsPreview && reviewCatalog !== null
              ? <CatalogReview {...reviewCatalog} />
              : null}
            {requirementsPreview && reviewCatalog === null ? (
              <section className="rounded-2xl border-2 border-dashed border-rose-500 bg-rose-50 p-6">
                <h2 className="text-sm font-black uppercase tracking-widest text-rose-900">
                  Review payload not found
                </h2>
                <p className="mt-2 max-w-2xl text-xs font-semibold leading-relaxed text-rose-900">
                  The imported catalog is read from{' '}
                  <code className="font-mono">local-review/statement_requirements_catalog.json</code>
                  , which is generated and untracked. Build it with:
                </p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-rose-900 px-3 py-2 text-[11px] text-rose-50">
python3 scripts/build_statement_requirements_import_sql.py
                </pre>
                <p className="mt-2 text-[11px] text-rose-800">
                  Nothing is shown in its place. The shape fixtures are a different
                  screen, at <code className="font-mono">?preview=fixtures</code>.
                </p>
              </section>
            ) : null}
          </main>
        ) : (
        <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10">
          {/* ============================================================ hero */}
          <section className="relative isolate overflow-hidden rounded-3xl bg-slate-950 shadow-xl shadow-slate-900/10">
            {/* The artwork sits behind the words and is cropped away on small
                screens, where there is no room for it beside the heading. */}
            <div aria-hidden="true" className="absolute inset-y-0 right-0 hidden w-3/5 lg:block">
              <DeskScene />
              <div className="absolute inset-0 bg-gradient-to-r from-slate-950 from-5% via-slate-950/35 via-40% to-transparent to-72%" />
            </div>

            <div className="relative px-6 py-12 sm:px-10 sm:py-14 lg:w-3/5 lg:py-20">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-300">
                CRNAPREPHUB
              </p>
              <h1 className="mt-4 text-4xl font-bold tracking-tight text-white sm:text-5xl">
                Statement <span className="text-blue-400">Studio</span>
              </h1>
              <p className="mt-4 text-xl font-semibold text-slate-100 sm:text-2xl">
                Your story deserves a strong statement.
              </p>
              <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-300 sm:text-base">
                Create, organize, and tailor your personal statement for the CRNA programs
                you&rsquo;re applying to.
              </p>

              {/* ONE ACTION. A "learn how" link lived here and pointed at the
                  three cards immediately below, which the reader reaches by
                  scrolling anyway -- a second control that competed with the
                  only thing there is to do on this screen. */}
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="mt-8 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-950/40 transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
              >
                <PlusIcon />
                New draft
              </button>
            </div>

            <figure className="absolute bottom-8 right-8 hidden w-56 rounded-2xl border border-white/10 bg-slate-950/60 p-5 backdrop-blur-sm xl:block">
              <QuoteIcon />
              <blockquote className="mt-2 text-sm italic leading-relaxed text-slate-200">
                A well-written personal statement can open doors to your future.
              </blockquote>
            </figure>
          </section>

          {/* ================================================== preview notice */}
          <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs leading-relaxed text-slate-600 sm:text-sm">
            <span className="inline-flex items-center gap-2 font-semibold text-slate-800">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Internal preview
            </span>
            <span aria-hidden="true" className="text-slate-300">
              &middot;
            </span>
            <span>{ANALYSIS_LIBRARY_NOTICE[analysisOffer]}</span>
          </p>

          {/* ==================================================== how it works */}
          <section aria-labelledby="how-it-works" className="mt-12">
            <h2
              id="how-it-works"
              className="scroll-mt-8 text-2xl font-bold tracking-tight text-slate-900"
            >
              How Statement Studio works
            </h2>
            <ol className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {stepsFor(analysisOffer).map((step, index) => (
                <li
                  key={step.title}
                  className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-blue-200 hover:shadow-md"
                >
                  <span
                    className={`flex h-14 w-14 items-center justify-center rounded-2xl ${
                      step.available ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    <step.Icon />
                  </span>
                  <p
                    className={`mt-5 text-xs font-bold tracking-[0.18em] ${
                      step.available ? 'text-blue-600' : 'text-slate-400'
                    }`}
                  >
                    0{index + 1}
                  </p>
                  <p className="mt-1.5 text-lg font-bold text-slate-900">{step.title}</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
                </li>
              ))}
            </ol>
          </section>

          {/* ===================================================== your drafts */}
          <section aria-labelledby="your-drafts" className="mt-12">
            <div className="flex flex-col gap-5 border-t border-slate-200 pt-8 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <h2 id="your-drafts" className="text-2xl font-bold tracking-tight text-slate-900">
                  Your drafts
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {draftTally(visible.length, drafts.length)}
                </p>
              </div>

              {/* Both controls act on the rows already in hand. With nothing to
                  act on they are disabled rather than merely decorative. */}
              <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
                <div className="relative w-full sm:w-auto">
                  <label htmlFor="draft-search" className="sr-only">
                    Search drafts by title
                  </label>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-slate-400"
                  >
                    <SearchIcon />
                  </span>
                  <input
                    id="draft-search"
                    type="search"
                    value={query}
                    disabled={empty}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search drafts..."
                    className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 sm:w-60"
                  />
                </div>

                <div className="relative w-full sm:w-auto">
                  <label htmlFor="draft-order" className="sr-only">
                    Order drafts
                  </label>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-slate-400"
                  >
                    <SortIcon />
                  </span>
                  <select
                    id="draft-order"
                    value={order}
                    disabled={empty}
                    onChange={(event) =>
                      setOrder(isDraftOrder(event.target.value) ? event.target.value : 'edited')
                    }
                    className="w-full appearance-none rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-9 text-sm font-medium text-slate-700 transition focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 sm:w-48"
                  >
                    {DRAFT_ORDERS.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400"
                  >
                    <ChevronIcon />
                  </span>
                </div>
              </div>
            </div>

            {empty ? (
              <div className="mt-6 rounded-2xl border-2 border-dashed border-slate-200 bg-white px-6 py-20 text-center">
                <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                  <DocumentIcon />
                </span>
                <p className="mt-6 text-xl font-bold text-slate-900">
                  Your writing journey starts here.
                </p>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-600">
                  Create your first draft and build your personal statement in one organized
                  workspace.
                </p>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="mt-7 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  <PlusIcon />
                  Create your first draft
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-6 py-16 text-center">
                <p className="text-base font-semibold text-slate-900">
                  No drafts match that search.
                </p>
                <p className="mt-1.5 text-sm text-slate-500">
                  Try a different word from the title.
                </p>
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="mt-5 text-sm font-semibold text-blue-700 underline-offset-4 transition hover:text-blue-800 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  Clear search
                </button>
              </div>
            ) : (
              /* grid-cols-1 IS LOAD-BEARING, NOT TIDYING. WK-QA-003: below `sm`
                 there was no explicit column, so the single implicit track was
                 `auto`, whose minimum is the grid ITEM's min-content -- and the
                 title's `truncate` sets white-space: nowrap, which makes
                 min-content the whole untruncated title. A 200-character title
                 therefore stretched the card to 2,160px inside a 375px
                 viewport and the page scrolled sideways. grid-cols-1 resolves
                 the track to repeat(1, minmax(0, 1fr)), which is why sm: and
                 xl: never showed the bug: their minmax(0, 1fr) already did
                 this above 640px. min-w-0 on the item relaxes the same
                 automatic minimum one level in. */
              <ul className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {visible.map((draft) => (
                  <li key={draft.id} className="min-w-0">
                    <Link
                      href={draftPath(draft.id)}
                      className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                    >
                      <span className="flex items-start gap-4">
                        <span
                          aria-hidden="true"
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 transition group-hover:bg-blue-600 group-hover:text-white"
                        >
                          <DocumentIcon />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base font-bold text-slate-900">
                            {draft.title}
                          </span>
                          <span className="mt-1 block text-xs text-slate-500">
                            Edited {draftDay(draft.updatedAt)}
                            <span aria-hidden="true" className="px-1 text-slate-300">
                              &middot;
                            </span>
                            started {draftDay(draft.createdAt)}
                          </span>
                        </span>
                      </span>
                      <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-blue-700 transition group-hover:gap-2.5">
                        Continue writing
                        <ArrowIcon />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
        )}
      </div>

      {/* Handed straight through: the library shows no school of its own, and
          a summary carries none. The dialog is where a school is chosen. */}
      <NewDraftDialog
        open={creating}
        onClose={() => setCreating(false)}
        schools={schools}
        schoolsUnavailable={schoolsUnavailable}
        submissionsEnabled={submissionsEnabled}
        pastePreview={pastePreview}
      />
    </div>
  )
}

/**
 * The three steps, as data rather than as repeated markup.
 *
 * THESE DESCRIBE THE CREATION FLOW THAT EXISTS. The first card is the dialog's
 * first screen, which offers a school and a general statement as two equal
 * choices -- so the wording is "or start a general statement", not an
 * instruction to pick a school. An applicant writing one statement for several
 * programmes is not doing it wrong, and a card that said "choose your school"
 * would tell them they were.
 *
 * `available` IS WHAT SEPARATES REACHABLE FROM SWITCHED OFF, and it is derived
 * rather than written down. The third card hardcoded "Coming soon." with
 * available: false, which outlived the analyser being built (WK-QA-001). Both
 * now come from the server's verdict, so the tile is muted only when nobody can
 * run an analysis -- not merely when this viewer's plan excludes it.
 */
function stepsFor(offer: AnalysisOffer): readonly {
  readonly title: string
  readonly body: string
  readonly available: boolean
  readonly Icon: () => ReactElement
}[] {
  return [
    {
      title: 'Choose your path',
      body: 'Select a CRNA school and its prompt, or start a general statement.',
      available: true,
      Icon: PathIcon,
    },
    {
      title: 'Write your story',
      body: 'Create your draft, write your personal statement, or upload an existing document.',
      available: true,
      Icon: PenIcon,
    },
    {
      title: 'Analyze & improve',
      body: ANALYSIS_STEP_BODY[offer],
      available: analysisStepIsLive(offer),
      Icon: FeedbackIcon,
    },
  ]
}

/**
 * The hero artwork: a writing desk, drawn as vectors.
 *
 * The four book spines are the qualities a CRNA personal statement is read
 * for, which is the one place this picture carries meaning rather than mood.
 * It is cropped with `slice`, so the composition keeps its centre at any
 * aspect ratio instead of stretching.
 */
function DeskScene() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 680 460"
      preserveAspectRatio="xMidYMid slice"
      className="h-full w-full"
    >
      <defs>
        <radialGradient id="ss-lamp" cx="0.72" cy="0.08" r="0.62">
          <stop offset="0%" stopColor="#fef3c7" stopOpacity="0.62" />
          <stop offset="40%" stopColor="#f8b04b" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ss-desk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1e293b" />
          <stop offset="100%" stopColor="#0a1020" />
        </linearGradient>
        <linearGradient id="ss-page" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="100%" stopColor="#c9d4e3" />
        </linearGradient>
        <linearGradient id="ss-screen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#93c5fd" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      <rect width="680" height="460" fill="#0b1220" />
      <rect width="680" height="460" fill="url(#ss-lamp)" />

      {/* the desk */}
      <rect y="352" width="680" height="108" fill="url(#ss-desk)" />
      <rect y="352" width="680" height="1.5" fill="#475569" opacity="0.6" />

      {/* everything standing on the desk, nudged clear of the heading beside it */}
      <g transform="translate(44 0)">

      {/* a laptop, cropped by the right edge */}
      <g>
        <rect x="556" y="196" width="160" height="150" rx="6" fill="#121d31" stroke="#334155" strokeWidth="2" />
        <rect x="568" y="208" width="136" height="126" rx="3" fill="url(#ss-screen)" />
        <rect x="534" y="346" width="196" height="9" rx="4.5" fill="#1e293b" />
      </g>

      {/* a plant */}
      <g>
        <path d="M476 352 l6 -38 h40 l6 38 z" fill="#1e293b" stroke="#334155" strokeWidth="1.5" />
        <path d="M502 314 C 502 286 490 272 474 264 C 482 288 488 300 502 314 Z" fill="#2f7d63" />
        <path d="M502 314 C 502 282 514 266 532 258 C 524 284 518 298 502 314 Z" fill="#359373" />
        <path d="M502 314 C 496 294 498 276 506 262 C 512 280 510 298 502 314 Z" fill="#3fae88" />
      </g>

      {/* four books, the qualities a statement is read for */}
      <g fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="10" letterSpacing="1.4">
        <rect x="150" y="324" width="304" height="28" rx="3" fill="#13213c" />
        <rect x="150" y="324" width="304" height="3" rx="1.5" fill="#2a3f68" />
        <text x="302" y="343" fill="#c7d5ee" textAnchor="middle">EVIDENCE-BASED PRACTICE</text>

        <rect x="158" y="296" width="288" height="28" rx="3" fill="#1b2d52" />
        <rect x="158" y="296" width="288" height="3" rx="1.5" fill="#37507f" />
        <text x="302" y="315" fill="#cfdcf2" textAnchor="middle">PATIENT ADVOCACY</text>

        <rect x="166" y="268" width="272" height="28" rx="3" fill="#1e3a8a" />
        <rect x="166" y="268" width="272" height="3" rx="1.5" fill="#3b5fb8" />
        <text x="302" y="287" fill="#dbe6fb" textAnchor="middle">CRITICAL CARE</text>

        <rect x="174" y="240" width="256" height="28" rx="3" fill="#2544a5" />
        <rect x="174" y="240" width="256" height="3" rx="1.5" fill="#4f74d6" />
        <text x="302" y="259" fill="#e8effd" textAnchor="middle">LEADERSHIP</text>
      </g>

      {/* an open notebook, in front of everything */}
      <g>
        <path d="M44 372 L232 356 L420 372 L420 446 L232 432 L44 446 Z" fill="url(#ss-page)" />
        <path d="M232 356 L232 432" stroke="#94a3b8" strokeWidth="1.5" />
        <g stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" opacity="0.55">
          <path d="M66 392 L206 380" />
          <path d="M66 408 L206 396" />
          <path d="M66 424 L164 414" />
          <path d="M258 381 L398 393" />
          <path d="M258 397 L398 409" />
          <path d="M258 413 L356 423" />
        </g>
        {/* a pen resting across the page */}
        <g transform="rotate(-7 332 424)">
          <rect x="268" y="420" width="128" height="8" rx="4" fill="#0f172a" />
          <rect x="384" y="420" width="20" height="8" rx="4" fill="#60a5fa" />
        </g>
      </g>
      </g>
    </svg>
  )
}

/* ------------------------------------------------------------------------- *
 * Icons. Inline SVG, so the page adds no icon dependency, and every one of
 * them is aria-hidden: each sits beside text that already says what it means.
 * ------------------------------------------------------------------------- */

function DocumentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5L14.5 3Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  )
}

function PenIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
      <path d="M13 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-5" />
      <path d="M18.4 3.6a1.8 1.8 0 0 1 2.5 2.5L14.5 12.5 11 13.5l1-3.5 6.4-6.4Z" />
      <path d="M9 16h3" />
    </svg>
  )
}

/** Two ways forward, neither of them the main one: the card offers a choice. */
function PathIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
      <path d="M12 21v-6" />
      <path d="M12 15c0-3 -2-4 -4-5S5 7 5 5" />
      <path d="M12 15c0-3 2-4 4-5s3-3 3-5" />
      <path d="M3 5h4v-2" />
      <path d="M21 5h-4v-2" />
    </svg>
  )
}

/** Notes written back on a draft: feedback, not analytics. */
function FeedbackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
      <path d="M20 14a2 2 0 0 1-2 2H8l-4 3.5V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />
      <path d="M8 8h8M8 11.5h5" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-4 w-4">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M5 12h13M12 5l7 7-7 7" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function SortIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M7 4v16M7 20l-3-3M7 4l3 3" />
      <path d="M14 7h7M14 12h5M14 17h3" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function QuoteIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6 text-blue-400/70">
      <path d="M9.6 5.4C6.5 6.9 4.6 9.8 4.6 13.1c0 3.2 1.9 5.5 4.5 5.5 2.2 0 3.8-1.6 3.8-3.7 0-2-1.4-3.5-3.3-3.5-.4 0-.8.1-1 .2.4-1.6 1.9-3.2 3.8-4.2l-2.8-2Zm9.4 0c-3.1 1.5-5 4.4-5 7.7 0 3.2 1.9 5.5 4.5 5.5 2.2 0 3.8-1.6 3.8-3.7 0-2-1.4-3.5-3.3-3.5-.4 0-.8.1-1 .2.4-1.6 1.9-3.2 3.8-4.2l-2.8-2Z" />
    </svg>
  )
}
