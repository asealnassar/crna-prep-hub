'use client'

import {
  MEASUREMENT_BASIS, appliedLines, complianceRows,
  type ComplianceRow, type Measurements,
} from '@/lib/statement/layout/compliance'
import type { RequirementCapabilities } from '@/lib/statement/layout/capabilities'

/**
 * What this school requires, and whether the draft meets it.
 *
 * ---------------------------------------------------------------------------
 * IT REPLACES A BLANKET DISCLAIMER WITH FACTS
 * ---------------------------------------------------------------------------
 * The editor used to say it "counts words and characters only" and could not
 * check pages, spacing, font or margins. That was true of a textarea. It is not
 * true of a page the Studio lays out itself: the page count and the spacing are
 * now the things it knows most exactly. Repeating the old sentence beside a
 * measured figure would teach a reader to distrust the figure.
 *
 * ---------------------------------------------------------------------------
 * EVERY ROW COMES FROM THE RESOLVER
 * ---------------------------------------------------------------------------
 * This component decides nothing. Which figures appear, which values are
 * applied and which lines need a human are all resolved from the school's own
 * canonical record, so a school with a word count and a school with a
 * fractional page bound produce different panels without this file knowing
 * either of them exists.
 *
 * PROVENANCE IS RENDERED, NOT ASSERTED. A school typically states a page bound
 * and a spacing and nothing else -- no paper size, font or margins -- and a page
 * count depends on all of them. So the panel has two halves, both filtered from
 * one list the resolver tagged. There is no second list of "things the school
 * said" that could drift into claiming more than it did.
 *
 * ESCAPED TEXT THROUGHOUT. Everything here originates in the catalog; none of
 * it is ever interpreted as markup.
 */

const TICK: Record<ComplianceRow['status'], { mark: string; className: string }> = {
  met: { mark: '✓', className: 'text-emerald-700' },
  applied: { mark: '✓', className: 'text-emerald-700' },
  // DELIBERATELY NOT A TICK. The layout holds, the requirement does not, and a
  // green mark here would be the silent substitution this state exists to stop.
  substituted: { mark: '≈', className: 'text-amber-700' },
  breached: { mark: '⚠', className: 'text-amber-700' },
  unverifiable: { mark: '•', className: 'text-slate-500' },
  pending: { mark: '•', className: 'text-slate-400' },
}

export default function RequirementsPanel({
  schoolName,
  capabilities,
  measurements,
}: {
  schoolName: string
  capabilities: RequirementCapabilities
  measurements: Measurements
}) {
  const rows = complianceRows({ capabilities, measurements })
  if (rows.length === 0) return null

  const schoolLines = [
    ...appliedLines(capabilities, 'school'),
    ...appliedLines(capabilities, 'school-choice'),
  ]
  // THE DEFAULTS ARE ONLY WORTH DISCLOSING WHERE THEY CHANGE A NUMBER. On a
  // surface with no page measurement they are typography nobody asked about;
  // beside a page figure they are half of what produced it.
  const studioLines = capabilities.pages === null
    ? [] : appliedLines(capabilities, 'studio-default')

  return (
    <section
      aria-label="School requirements"
      className="rounded-2xl border border-slate-200 bg-white p-5"
    >
      <h3 className="text-sm font-bold text-slate-900">
        {schoolName === '' ? 'Requirements' : `${schoolName} requirements`}
      </h3>

      <ul className="mt-3 grid gap-2">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span aria-hidden className={`text-sm font-bold ${TICK[row.status].className}`}>
              {TICK[row.status].mark}
            </span>
            <span className={`text-sm ${
              row.status === 'breached' ? 'font-semibold text-amber-800' : 'text-slate-800'
            }`}>
              {row.label}
            </span>
            {row.detail !== null && (
              /* THE LIVE FIGURE. Tabular numerals so the digits do not shift
                 sideways on every keystroke. */
              <span className={`text-sm font-semibold tabular-nums ${
                row.status === 'breached' ? 'text-amber-800' : 'text-slate-900'
              }`}>
                {row.detail}
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* ---- where each layout property came from ---- */}
      {(schoolLines.length > 0 || studioLines.length > 0) && (
        <div className="mt-4 grid gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
          {schoolLines.length > 0 && (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Required by {schoolName === '' ? 'the school' : schoolName}
              </p>
              <ul className="mt-1 grid gap-0.5">
                {schoolLines.map((line) => (
                  <li key={line} className="text-xs text-slate-700">{line}</li>
                ))}
              </ul>
            </div>
          )}
          {studioLines.length > 0 && (
            <div>
              {/* NEVER ATTRIBUTED TO THE SCHOOL. These are ours, and the page
                  count depends on them, so they are named rather than implied. */}
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                CRNAPREPHUB Studio defaults
              </p>
              <ul className="mt-1 grid gap-0.5">
                {studioLines.map((line) => (
                  <li key={line} className="text-xs text-slate-700">{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/*
        WHAT THE STUDIO IS DOING THAT THE SCHOOL DID NOT ASK FOR.

        ITS OWN HEADING, NEVER MERGED INTO THE LIST ABOVE. "Required by this
        school" and "what we render" are different claims, and a substituted
        font printed among the requirements would read as satisfying one.
      */}
      {capabilities.rendering.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-amber-800">
            Studio rendering
          </p>
          <ul className="mt-1 grid gap-1">
            {capabilities.rendering.map((note) => (
              <li key={note} className="text-xs leading-relaxed text-amber-900">{note}</li>
            ))}
          </ul>
        </div>
      )}

      {/* SAID ONLY WHERE A PAGE WAS MEASURED, because that is what it is about. */}
      {capabilities.pages !== null && (
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{MEASUREMENT_BASIS}</p>
      )}
    </section>
  )
}
