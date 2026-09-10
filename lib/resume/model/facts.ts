/**
 * Fact grounding.
 *
 * A Fact is something the applicant supplied -- typed into a field, ticked in
 * a checklist, or extracted from a document they uploaded. It is the only
 * material an AI proposal is permitted to draw on.
 *
 * The separation this file exists to enforce:
 *
 *   FACT   = supplied by a person or their document.  Never produced by AI.
 *   TEXT   = written prose. May be AI-proposed, and is inert until accepted.
 *
 * That distinction is enforced in the type, not by convention: `provenance`
 * admits 'user' and 'import' and nothing else, so there is no value an AI path
 * could construct a Fact with. V1 had the opposite arrangement -- its prompt
 * was told to invent "measurable outcomes", and the builder never collected
 * any, so the numbers on the page came from nowhere.
 *
 * SCOPE NOTE. Building a fact sheet for a model call, and verifying generated
 * text against one, belong to the AI phase. What lives here is the vocabulary
 * they will both use, plus the collectors that read facts out of canonical
 * sections -- because that reading is a property of the model, not of the AI.
 */

/** Stable within one resume; a proposal cites these to say what it used. */
export type FactId = string

/**
 * What a fact is about. Kinds exist so a later verifier can reason about
 * shape -- a quantity is checkable in a way a free-text note is not.
 */
export type FactKind =
  | 'employer'
  | 'location'
  | 'role'
  | 'unit_type'
  | 'acuity'
  | 'date_range'
  | 'device'
  | 'therapy'
  | 'patient_population'
  | 'charge_role'
  | 'preceptor_role'
  | 'committee'
  | 'responsibility'
  | 'credential'
  | 'organization'
  | 'applicant_metric'
  | 'applicant_note'

/** Only a person or their uploaded document can originate a fact. */
export type FactProvenance = 'user' | 'import'

export interface Fact {
  readonly id: FactId
  readonly kind: FactKind
  /** Exactly as supplied. Not normalised, not expanded, not corrected. */
  readonly value: string
  readonly provenance: FactProvenance
  /** Where in the resume it came from, e.g. 'critical_care/<id>/devices'. */
  readonly path: string
}

/**
 * Everything a single proposal is allowed to know. A model call receives this
 * and nothing else -- not the resume, not the contact block, not free context.
 */
export interface FactSheet {
  /** What the proposal is for, e.g. 'critical_care/<positionId>/bullets'. */
  readonly subject: string
  readonly facts: readonly Fact[]
}

export function makeFact(
  id: FactId,
  kind: FactKind,
  value: string,
  path: string,
  provenance: FactProvenance = 'user'
): Fact {
  return { id, kind, value, provenance, path }
}

/**
 * Collects facts from a list of supplied values, skipping blanks.
 *
 * Ids are derived from the path and index so they are stable across calls --
 * a proposal citing `f:critical_care/abc/devices#2` still means the same fact
 * when the sheet is rebuilt.
 */
export function factsFromValues(
  values: readonly string[] | undefined,
  kind: FactKind,
  path: string,
  provenance: FactProvenance = 'user'
): Fact[] {
  if (!Array.isArray(values)) return []
  const out: Fact[] = []
  values.forEach((value, index) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === '') return
    out.push(makeFact(`f:${path}#${index}`, kind, text, `${path}#${index}`, provenance))
  })
  return out
}

/** Single-value convenience. Returns nothing for a blank. */
export function factFromValue(
  value: string | undefined | null,
  kind: FactKind,
  path: string,
  provenance: FactProvenance = 'user'
): Fact[] {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return []
  return [makeFact(`f:${path}`, kind, text, path, provenance)]
}

export function factSheet(subject: string, groups: readonly Fact[][]): FactSheet {
  return { subject, facts: groups.flat() }
}

/** Lookup for a verifier: does this cited id actually exist in the sheet? */
export function hasFact(sheet: FactSheet, id: FactId): boolean {
  return sheet.facts.some((f) => f.id === id)
}

/** Every distinct value in the sheet, for grounding checks. */
export function factValues(sheet: FactSheet): string[] {
  return sheet.facts.map((f) => f.value)
}
