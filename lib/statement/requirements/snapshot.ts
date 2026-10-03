/**
 * What a draft freezes about the requirement it answers.
 *
 * THE REASON SNAPSHOTS EXIST AT ALL, restated because this module is where it
 * is enforced: a draft answers the question its author read. A school may
 * reword a prompt, a researcher may correct a word limit, an entry may be
 * deactivated -- and none of that may retroactively change what an essay was
 * written against, or what it was analysed against. So the whole requirement is
 * copied into the draft at creation and never re-read from the catalog.
 *
 * THE LEGACY PROJECTION IS THE BACKWARD-COMPATIBILITY MECHANISM, and it is the
 * most important function here. statement_drafts already has prompt_text and
 * stated_max_words, and the editor, the analyser, the eligibility floor and the
 * over-limit warning all read them. Rather than teach every one of those paths
 * about a new shape, a structured requirement PROJECTS onto those two columns:
 * the prompt text goes in prompt_text, and the word maximum -- if there is one
 * -- goes in stated_max_words. Everything the old columns cannot express lives
 * in the snapshot beside them.
 *
 * SO A PAGE LIMIT PROJECTS TO NULL. Rutgers asks for one page and states no
 * word count; stated_max_words is therefore null, which the existing code
 * already reads correctly as "this school stated no word limit". That is not a
 * loss of information -- the page limit is in the snapshot -- it is the only
 * honest projection, because the alternative is writing a number into a word
 * column that no school ever said.
 */

import {
  NO_CONSTRAINTS, type Citation, type Constraints, type PageLimit, type Spacing,
} from './constraints.ts'
import { UNVERIFIED, isIsoDate, type Verification, type VerificationStatus } from './verification.ts'
import {
  isDocumentType, type DocumentType, type RequirementComponent, type RequirementSet,
  type WritingRequirement,
} from './requirement.ts'

/**
 * The frozen requirement, as stored on the draft.
 *
 * IT CARRIES ITS SET'S IDENTITY AND PROVENANCE, not just the document's. An
 * analysis has to be able to say "this was an unverified research entry" months
 * later, and the set is where that fact lives.
 */
export interface RequirementSnapshot {
  readonly requirementId: string
  readonly setId: string
  readonly schoolId: string
  readonly documentType: DocumentType
  readonly label: string
  readonly promptText: string
  readonly components: readonly RequirementComponent[]
  readonly constraints: Constraints
  /**
   * The group this document was chosen from, when it was a choice.
   *
   * KEPT SO THE ANALYSIS KNOWS IT WAS A CHOICE. An essay written to alternative
   * (2) must never be assessed against alternative (1), and the only way to be
   * sure is for the draft to record which one it answers.
   */
  readonly choiceGroup: string | null
  readonly optional: boolean
  readonly applicationCycle: string | null
  readonly verification: Verification
  readonly notes: readonly string[]
}

/** Freeze one document of one set onto a draft. */
export function snapshotOf(
  set: RequirementSet,
  requirement: WritingRequirement
): RequirementSnapshot {
  return {
    requirementId: requirement.id,
    setId: set.id,
    schoolId: set.schoolId,
    documentType: requirement.documentType,
    label: requirement.label,
    promptText: requirement.promptText,
    components: requirement.components.map((component) => ({ ...component })),
    constraints: requirement.constraints,
    choiceGroup: requirement.choiceGroup,
    optional: requirement.optional,
    applicationCycle: set.applicationCycle,
    // PROVENANCE IS THE SET'S, because that is where a source URL and a
    // verification date are recorded. A document does not get its own standing.
    verification: set.verification,
    // BOTH LEVELS OF UNCERTAINTY, CONCATENATED. A note on the set ("two pages
    // or four, sources disagree") matters to every document in it; a note on
    // the document matters to this one. The draft needs both and has one field.
    notes: [...set.notes, ...requirement.notes],
  }
}

// ---------------------------------------------------------------------------
// The legacy projection
// ---------------------------------------------------------------------------

export interface LegacyPromptColumns {
  readonly promptText: string | null
  readonly statedMaxWords: number | null
}

/**
 * The two existing columns, derived from a structured requirement.
 *
 * stated_max_words COMES FROM constraints.words.max AND FROM NOWHERE ELSE. Not
 * from a page count, not from a character count, not from a minimum, not from a
 * guess. Every other unit projects to null, and null already means "no stated
 * word limit" everywhere in the existing code.
 */
export function legacyProjection(snapshot: RequirementSnapshot): LegacyPromptColumns {
  return {
    promptText: snapshot.promptText.length > 0 ? snapshot.promptText : null,
    statedMaxWords: snapshot.constraints.words?.max ?? null,
  }
}

/**
 * A snapshot for a draft that predates this architecture.
 *
 * READ BACK OUT OF THE OLD COLUMNS, so one code path can serve both. An
 * existing single-prompt draft becomes a one-document requirement with no
 * components, a word maximum if it had one, and no provenance -- which is a
 * true description of it. Nothing is invented: the constraints are empty except
 * for the word limit that was actually stored.
 *
 * RETURNS NULL FOR A GENERAL STATEMENT, because a draft answering no prompt has
 * no requirement to describe and must not be given an empty one.
 */
export function snapshotFromLegacy(input: {
  readonly schoolId: string | null
  readonly promptId: string | null
  readonly promptText: string | null
  readonly statedMaxWords: number | null
}): RequirementSnapshot | null {
  if (input.promptText === null || input.promptId === null || input.schoolId === null) return null
  return {
    requirementId: input.promptId,
    // THE SET ID IS THE PROMPT ID for a legacy draft. There is no set, and
    // inventing a separate identifier would create one that resolves to
    // nothing; reusing the prompt's own id keeps the field non-null and
    // truthful about what it points at.
    setId: input.promptId,
    schoolId: input.schoolId,
    documentType: 'personal-statement',
    label: 'Personal Statement',
    promptText: input.promptText,
    components: [],
    constraints: input.statedMaxWords === null
      ? NO_CONSTRAINTS
      : { ...NO_CONSTRAINTS, words: { min: null, max: input.statedMaxWords } },
    choiceGroup: null,
    optional: false,
    applicationCycle: null,
    verification: UNVERIFIED,
    notes: [],
  }
}

// ---------------------------------------------------------------------------
// Reading one back out of storage
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function posInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function nullableBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function parseConstraints(value: unknown): Constraints {
  if (value === null || typeof value !== 'object') return NO_CONSTRAINTS
  const raw = value as Record<string, unknown>

  const wordsRaw = raw.words as Record<string, unknown> | null | undefined
  const words = wordsRaw == null ? null : {
    min: posInt(wordsRaw.min), max: posInt(wordsRaw.max),
  }

  const charsRaw = raw.characters as Record<string, unknown> | null | undefined
  const characters = charsRaw == null ? null : {
    min: posInt(charsRaw.min),
    max: posInt(charsRaw.max),
    spacesCount: nullableBool(charsRaw.spacesCount),
  }

  const pagesRaw = raw.pages as Record<string, unknown> | null | undefined
  const spacingRaw = str(pagesRaw?.spacing)
  const spacing: Spacing | null =
    spacingRaw === 'single' || spacingRaw === 'double' ? spacingRaw : null
  const pages: PageLimit | null = pagesRaw == null ? null : {
    min: posInt(pagesRaw.min),
    max: posInt(pagesRaw.max),
    spacing,
  }

  const typoRaw = raw.typography as Record<string, unknown> | null | undefined
  const typography = typoRaw == null ? null : {
    fontSizePt: posInt(typoRaw.fontSizePt),
    fontFamily: str(typoRaw.fontFamily),
    marginsInches: typeof typoRaw.marginsInches === 'number' && typoRaw.marginsInches > 0
      ? typoRaw.marginsInches
      : null,
  }

  const citeRaw = raw.citation as Record<string, unknown> | null | undefined
  const familyRaw = str(citeRaw?.family)
  const family: Citation['family'] =
    familyRaw === 'apa' || familyRaw === 'ama' ? familyRaw : 'other'
  const statedAs = str(citeRaw?.statedAs)
  // statedAs IS REQUIRED. A citation style with no wording is not a style, and
  // branching on `family` alone would show an applicant "other" as a rule.
  const citation: Citation | null = citeRaw == null || statedAs === null ? null : {
    family,
    statedAs,
    minReferences: posInt(citeRaw.minReferences),
  }

  return {
    words, characters, pages, typography, citation,
    otherInstructions: strings(raw.otherInstructions),
  }
}

function parseVerification(value: unknown): Verification {
  if (value === null || typeof value !== 'object') return UNVERIFIED
  const raw = value as Record<string, unknown>
  const status = str(raw.status)
  const known: readonly VerificationStatus[] = ['unverified', 'needs-review', 'verified', 'conflicting']
  return {
    // AN UNRECOGNISED STATUS BECOMES 'unverified', never 'verified'. A snapshot
    // written by a newer version of this code must degrade into the state that
    // withholds the claim, not the one that makes it.
    status: (known as readonly string[]).includes(status ?? '')
      ? (status as VerificationStatus)
      : 'unverified',
    sourceUrl: str(raw.sourceUrl),
    verifiedOn: isIsoDate(raw.verifiedOn) ? raw.verifiedOn : null,
    verbatim: raw.verbatim === true,
  }
}

function parseComponents(value: unknown): readonly RequirementComponent[] {
  if (!Array.isArray(value)) return []
  const out: RequirementComponent[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = str(raw.id)
    const text = str(raw.text)
    if (id === null || text === null) continue
    out.push({ id, text, optional: raw.optional === true })
  }
  return out
}

/**
 * A stored snapshot, parsed strictly.
 *
 * RETURNS NULL RATHER THAN A PARTIAL SNAPSHOT. The four identity fields and the
 * prompt text are required; without them this is not a requirement and the
 * caller must fall back to the legacy columns rather than display a document
 * with no question in it.
 *
 * EVERYTHING OPTIONAL DEGRADES TO ABSENT, never to a default that looks like a
 * requirement. A malformed word limit becomes no word limit, which is the same
 * state as a school that stated none -- and is safe, because no limit is ever
 * enforced.
 */
export function parseRequirementSnapshot(value: unknown): RequirementSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  const requirementId = str(raw.requirementId)
  const setId = str(raw.setId)
  const schoolId = str(raw.schoolId)
  const promptText = str(raw.promptText)
  const label = str(raw.label)
  if (requirementId === null || setId === null || schoolId === null) return null
  if (promptText === null || label === null) return null

  const documentType = raw.documentType
  return {
    requirementId,
    setId,
    schoolId,
    documentType: isDocumentType(documentType) ? documentType : 'other',
    label,
    promptText,
    components: parseComponents(raw.components),
    constraints: parseConstraints(raw.constraints),
    choiceGroup: str(raw.choiceGroup),
    optional: raw.optional === true,
    applicationCycle: str(raw.applicationCycle),
    verification: parseVerification(raw.verification),
    notes: strings(raw.notes),
  }
}

/**
 * The snapshot for a draft, from whichever source it has.
 *
 * ONE FUNCTION, SO NO CALLER CHOOSES. A draft with a structured snapshot uses
 * it; a draft without one is projected from its legacy columns; a general
 * statement has neither and yields null. Every consumer -- editor, analyser,
 * fingerprint -- asks this and cannot accidentally read only the new path and
 * break the old drafts.
 */
export function effectiveSnapshot(draft: {
  readonly schoolId: string | null
  readonly promptId: string | null
  readonly promptText: string | null
  readonly statedMaxWords: number | null
  readonly requirementSnapshot?: unknown
}): RequirementSnapshot | null {
  const stored = parseRequirementSnapshot(draft.requirementSnapshot ?? null)
  if (stored !== null) return stored
  return snapshotFromLegacy(draft)
}
