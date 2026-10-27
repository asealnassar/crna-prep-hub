'use client'

import { useState } from 'react'
import {
  FIXTURE_NOTICE, FIXTURE_SETS, FIXTURE_SOURCE,
} from '@/lib/statement/requirements/fixtures'
import { checklistView, type StartedDraft } from '@/lib/statement/requirements/checklistView'
import RequirementChecklist from './RequirementChecklist'

/**
 * A development-only walk through every writing-requirement shape.
 *
 * WHAT IT IS FOR. The owner approves an interface, not a description of one, so
 * the eight research examples are rendered through the SAME component the real
 * checklist uses -- RequirementChecklist, fed by the same checklistView(). If
 * this screen looks right, the real one looks right, because there is no second
 * implementation to drift.
 *
 * IT CANNOT CREATE, READ OR CHARGE ANYTHING. onStart records a requirement id
 * in local state and nothing else: no fetch, no draft, no model call, no usage.
 * The fixtures are TypeScript constants, so there is no query to make and no
 * row to write; a pretend "started" draft is constructed in the browser to show
 * the Continue state.
 *
 * AND IT SAYS SO, TWICE, BEFORE ANY REQUIREMENT. The banner names the research
 * file and states that these are not current admissions requirements, and each
 * checklist carries its own unverified warning from the fixture's own
 * provenance -- which is the real mechanism, not a label added for the preview.
 */
export default function RequirementPreview() {
  const [index, setIndex] = useState(0)
  /**
   * Requirement ids the viewer has pressed Start on.
   *
   * LOCAL, AND THROWN AWAY ON RELOAD. It exists so the Continue state and the
   * "choice has been made" state are both reachable without a database.
   */
  const [started, setStarted] = useState<readonly string[]>([])

  const set = FIXTURE_SETS[index]!
  const drafts: readonly StartedDraft[] = started.map((requirementId) => ({
    id: `preview-${requirementId}`,
    requirementId,
    title: 'Preview draft',
    updatedAt: new Date().toISOString(),
    words: 312,
  }))
  const view = checklistView({ set, drafts })

  return (
    <section
      aria-labelledby="requirement-preview-heading"
      className="rounded-2xl border-2 border-dashed border-amber-400 bg-amber-50/40 p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="requirement-preview-heading"
            className="text-sm font-bold uppercase tracking-wide text-amber-900"
          >
            Development preview &middot; school writing requirements
          </h2>
          <p className="mt-1 max-w-2xl text-xs font-semibold leading-relaxed text-amber-900">
            {FIXTURE_NOTICE}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-800">
            Source: {FIXTURE_SOURCE}. Nothing on this screen reads or writes the database,
            creates a draft, or calls a model.
          </p>
        </div>
      </div>

      {/* One tab per shape, so every case is reachable in two clicks. */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {FIXTURE_SETS.map((candidate, candidateIndex) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => { setIndex(candidateIndex); setStarted([]) }}
            aria-pressed={candidateIndex === index}
            className={candidateIndex === index
              ? 'rounded-lg bg-amber-900 px-2.5 py-1 text-[11px] font-semibold text-white'
              : 'rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 transition hover:bg-amber-100'}
          >
            {candidate.schoolName}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5">
        <RequirementChecklist
          view={view}
          actions={{
            // NO REQUEST. Local state only -- see the module header.
            onStart: (requirementId) =>
              setStarted((current) =>
                current.includes(requirementId) ? current : [...current, requirementId]),
            // A dead href: the preview creates no draft to open. With `demo`
            // set, the checklist renders a span rather than an anchor, so this
            // is never navigated to -- it is kept because the prop is required
            // and a lie about its value would be worse than a dead one.
            draftHref: () => '#preview-no-draft',
            // EVERY CONTROL IS DRESSED AS A DEMO. See ChecklistActions.demo.
            demo: true,
          }}
        />
      </div>

      {started.length > 0 && (
        <button
          type="button"
          onClick={() => setStarted([])}
          className="mt-3 text-[11px] font-semibold text-amber-900 underline underline-offset-2"
        >
          Reset the preview
        </button>
      )}
    </section>
  )
}
