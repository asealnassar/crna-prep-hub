/**
 * Copy and scoping decisions for the GPA workspace.
 *
 * Kept out of the components so the wording can be asserted directly: each of
 * these existed as a hardcoded sentence that stopped being true the moment the
 * user changed something.
 */

import type { Course, GpaPolicies, Institution } from './types.ts'

/**
 * The schools an analysis actually uses.
 *
 * Institutions are shared across every analysis on the account, which is right
 * for reuse but wrong for display: a Montclair-only analysis listing Rutgers
 * makes Rutgers look like it takes part in that GPA. Coursework decides.
 */
export function institutionsUsedIn(
  courses: readonly Course[],
  institutions: readonly Institution[],
): Institution[] {
  const used = new Set<string>()
  for (const c of courses) if (c.institutionId) used.add(c.institutionId)
  return institutions.filter(i => used.has(i.id))
}

/** The schools saved on the account that this analysis does not reference. */
export function institutionsUnusedIn(
  courses: readonly Course[],
  institutions: readonly Institution[],
): Institution[] {
  const used = new Set(institutionsUsedIn(courses, institutions).map(i => i.id))
  return institutions.filter(i => !used.has(i.id))
}

export type LegendOutcome =
  /** The parser found no grading table printed anywhere in the document. */
  | 'none'
  /** One table was found and established as the one that governs. */
  | 'applied'
  /** Several tables were found and none could be shown to govern. */
  | 'ambiguous'
  /** A single table was found but nothing said it governs this coursework. */
  | 'unestablished'

export interface LegendNote {
  outcome: LegendOutcome
  /** True when the user has something to decide. */
  actionable: boolean
  text: string
}

/**
 * Describes what the legend parser actually found.
 *
 * The claim has to match the evidence. Reporting "the transcript prints more
 * than one grading system" for a transcript that prints none is worse than
 * saying nothing, because it sends the user hunting for a page that does not
 * exist.
 */
export function legendNoteFor(input: {
  institutionName: string
  /** Grading tables the DETERMINISTIC parser found in this document. */
  candidateCount: number
  /** Whatever the applicability step said it could not resolve. */
  ambiguity?: string | null
  applied: boolean
}): LegendNote {
  const { institutionName, candidateCount, applied } = input
  const ambiguity = String(input.ambiguity ?? '').trim()

  if (applied) {
    return {
      outcome: 'applied', actionable: false,
      text: `${institutionName}: grading scale detected from the transcript.`,
    }
  }
  if (candidateCount === 0) {
    return {
      outcome: 'none', actionable: false,
      text: `${institutionName}: no explicit grading legend was found on this transcript. ` +
        `The standard 4.0 scale is being used until you confirm or edit it.`,
    }
  }
  if (candidateCount === 1) {
    return {
      outcome: 'unestablished', actionable: true,
      text: `${institutionName}: a grading table was found, but the transcript does not say it ` +
        `governs this coursework, so it was not applied.` + (ambiguity ? ` ${ambiguity}` : ''),
    }
  }
  return {
    outcome: 'ambiguous', actionable: true,
    text: `${institutionName}: this transcript prints ${candidateCount} grading tables and the ` +
      `correct one could not be determined, so none was applied.` + (ambiguity ? ` ${ambiguity}` : ''),
  }
}

/**
 * The retake sentence in the disclaimer.
 *
 * This used to be the fixed words "Both attempts of a repeated course are
 * included", which stayed on screen after the user chose "latest only" and the
 * GPA had already changed underneath it.
 */
export function retakeDisclaimer(policies: GpaPolicies, unresolvedRetakes = 0): string {
  if (policies.retake === 'both') return 'Both attempts of repeated coursework are included.'
  if (policies.retake === 'latest') return 'Only the latest matched attempt of repeated coursework is included.'
  if (unresolvedRetakes > 0) return 'Repeated coursework is awaiting your policy selection.'
  return ''
}

/** D43. The approved wording, in one place so it cannot drift. */
export const GPA_DISCLAIMER_D43 =
  'GPA results are estimates based on your coursework, selected calculation policies, and each ' +
  'institution’s detected or confirmed grading scale. When a school’s grading scale is unknown, ' +
  'CRNAPREPHUB uses the standard 4.0 scale until confirmed. CRNA programs may recalculate GPA ' +
  'differently, so always verify each program’s requirements.'
