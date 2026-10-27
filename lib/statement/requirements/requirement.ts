/**
 * A school's writing requirements, modelled.
 *
 * THE ONE DISTINCTION EVERYTHING ELSE RESTS ON: a question inside an essay is
 * not a separate essay. A school asking for one 1,000-word statement that
 * addresses four things wants ONE document; a school asking for three 500-word
 * statements wants THREE. Both read as "a numbered list of questions" in a
 * programme page, and getting them the wrong way round means either splitting
 * one essay into four stubs or cramming three submissions into one textarea.
 *
 * SO THE MODEL HAS TWO LEVELS AND ONLY TWO. A WritingRequirement is a DOCUMENT:
 * one thing the applicant uploads or pastes, with its own draft, its own limits
 * and its own analysis. A RequirementComponent is a QUESTION INSIDE one of
 * those documents: it has no draft of its own, it is never analysed separately,
 * and it exists so that prompt alignment can report on each thing the school
 * asked rather than on the paragraph as a whole.
 *
 * HOW THE SIX APPROVED CASES MAP, with no case needing a new level:
 *
 *   A. One essay, one prompt        -- one requirement, components empty.
 *   B. One essay, several questions -- one requirement, several components.
 *   C. Several separate documents   -- several requirements in one set.
 *   D. A choice of prompts          -- several requirements sharing a
 *                                      choiceGroup; the applicant picks one.
 *   E. Required plus optional       -- `optional` on the supplement.
 *   F. A named document type        -- `documentType`.
 *
 * AND THEY COMPOSE, which is the actual requirement: a real school asks for a
 * multipart personal statement (B+F) AND a separate diversity essay (C+F), one
 * of which may be a choice (D) and one optional (E). Nothing here special-cases
 * a combination.
 */

import { NO_CONSTRAINTS, type Constraints } from './constraints.ts'
import { UNVERIFIED, type Verification } from './verification.ts'

/**
 * What the school calls the document.
 *
 * A CLOSED SET WITH AN ESCAPE HATCH. These are the types the research actually
 * contains; 'other' carries the rest without forcing a wrong label, and the
 * school's own wording always survives in `label` regardless.
 */
export type DocumentType =
  | 'personal-statement'
  | 'goal-statement'
  | 'diversity-statement'
  | 'writing-sample'
  | 'additional-response'
  // ADDED BY MIGRATION 007, because the verified research contains all three and
  // the importer refused five documents rather than mislabel them. Each is a
  // name a school actually uses, not a synonym this product invented: a
  // Statement of Purpose is not a Goal Statement in every school's usage, and
  // collapsing them would overwrite a classification a human made from the
  // school's own page. 'other' remains the escape hatch for everything else.
  | 'statement-of-purpose'
  | 'autobiographical-essay'
  | 'supplemental-essay'
  | 'other'

export const DOCUMENT_TYPE_LABELS: Readonly<Record<DocumentType, string>> = {
  'personal-statement': 'Personal Statement',
  'goal-statement': 'Goal Statement',
  'diversity-statement': 'Diversity Statement',
  'writing-sample': 'Writing Sample',
  'additional-response': 'Additional Response',
  'statement-of-purpose': 'Statement of Purpose',
  'autobiographical-essay': 'Autobiographical Essay',
  'supplemental-essay': 'Supplemental Essay',
  other: 'Writing Requirement',
}

export const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_LABELS) as readonly DocumentType[]

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value)
}

/**
 * One question the school asks INSIDE a single document.
 *
 * NO CONSTRAINTS FIELD, DELIBERATELY. A component cannot carry its own word
 * limit, because the limit belongs to the document it lives in -- Buffalo's
 * 1,000 words covers all four questions together. A school that states a limit
 * per question is not describing components; it is describing separate
 * documents, and belongs in several WritingRequirements. Giving a component a
 * limit would make that distinction expressible twice and therefore ambiguous.
 */
export interface RequirementComponent {
  /** Stable within its requirement, so analysis can refer to it. */
  readonly id: string
  /** The question, in the school's wording as recorded. */
  readonly text: string
  /** True for the ones a school marks optional inside an otherwise required essay. */
  readonly optional: boolean
}

/** One document: one draft, one set of limits, one analysis. */
export interface WritingRequirement {
  readonly id: string
  readonly documentType: DocumentType
  /** What a card shows: "Personal Statement", "Essay 2". Not the question. */
  readonly label: string
  /** The question or instructions for THIS document, as recorded. */
  readonly promptText: string
  /**
   * The questions inside this document.
   *
   * EMPTY MEANS ONE UNDIVIDED PROMPT, which is case A and the existing
   * single-prompt behaviour. It does not mean "not yet filled in".
   */
  readonly components: readonly RequirementComponent[]
  readonly constraints: Constraints
  /**
   * null when this document is always required or always optional.
   *
   * A NON-NULL GROUP MEANS "PICK ONE OF THESE". Every requirement sharing the
   * string is an alternative to the others, exactly one is written, and the
   * applicant chooses which before a draft exists.
   */
  readonly choiceGroup: string | null
  /** A supplement the school invites but does not require. */
  readonly optional: boolean
  readonly displayOrder: number
  /** Uncertainty that survived research. Shown to the applicant, never resolved here. */
  readonly notes: readonly string[]
}

/** Everything one school asks for, in one cycle, from one reading of their pages. */
export interface RequirementSet {
  readonly id: string
  readonly schoolId: string
  readonly schoolName: string
  readonly applicationCycle: string | null
  readonly verification: Verification
  /**
   * The requirement as it was recorded, before anybody structured it.
   *
   * KEPT SO THE STRUCTURING CAN BE AUDITED. Every constraint below was derived
   * from this text by a human; when the two disagree, this is the evidence and
   * the structure is the error.
   */
  readonly originalText: string
  readonly requirements: readonly WritingRequirement[]
  /** Set-level uncertainty: conflicts between sources, scope questions. */
  readonly notes: readonly string[]
}

// ---------------------------------------------------------------------------
// Reading a set
// ---------------------------------------------------------------------------

/** An empty requirement for a school nobody has researched. */
export function emptyRequirement(id: string, label: string): WritingRequirement {
  return {
    id,
    documentType: 'other',
    label,
    promptText: '',
    components: [],
    constraints: NO_CONSTRAINTS,
    choiceGroup: null,
    optional: false,
    displayOrder: 0,
    notes: [],
  }
}

export const EMPTY_SET: Omit<RequirementSet, 'id' | 'schoolId' | 'schoolName'> = {
  applicationCycle: null,
  verification: UNVERIFIED,
  originalText: '',
  requirements: [],
  notes: [],
}

/** Display order, then label, so a set renders the same way every time. */
export function orderedRequirements(set: RequirementSet): readonly WritingRequirement[] {
  return [...set.requirements].sort((a, b) =>
    a.displayOrder - b.displayOrder || a.label.localeCompare(b.label, 'en-US'))
}

/** Documents the applicant must write. Excludes optional supplements. */
export function requiredRequirements(set: RequirementSet): readonly WritingRequirement[] {
  return orderedRequirements(set).filter((r) => !r.optional)
}

/** Documents the school invites but does not require. */
export function optionalRequirements(set: RequirementSet): readonly WritingRequirement[] {
  return orderedRequirements(set).filter((r) => r.optional)
}

/** One group of alternatives: pick exactly one. */
export interface ChoiceGroup {
  readonly key: string
  readonly options: readonly WritingRequirement[]
}

/**
 * The choice groups in this set, each with its alternatives in display order.
 *
 * A GROUP OF ONE IS STILL A GROUP. If research records a choiceGroup with a
 * single option, that is a school whose other alternative has not been recorded
 * yet -- not a required document. Silently promoting it would invent a
 * requirement, so it stays a choice with one known option.
 */
export function choiceGroups(set: RequirementSet): readonly ChoiceGroup[] {
  const groups = new Map<string, WritingRequirement[]>()
  for (const requirement of orderedRequirements(set)) {
    if (requirement.choiceGroup === null) continue
    const existing = groups.get(requirement.choiceGroup)
    if (existing === undefined) groups.set(requirement.choiceGroup, [requirement])
    else existing.push(requirement)
  }
  return [...groups].map(([key, options]) => ({ key, options }))
}

/**
 * What the checklist shows: one entry per thing the applicant must decide or write.
 *
 * A CHOICE GROUP COLLAPSES TO ONE ENTRY, because "choose one of two prompts" is
 * one item on a to-do list, not two. The alternatives travel with the entry so
 * the interface can offer them at the moment a draft is created -- which is the
 * only moment the choice means anything.
 */
export type ChecklistEntry =
  | {
    readonly kind: 'document'
    readonly requirement: WritingRequirement
  }
  | {
    readonly kind: 'choice'
    readonly group: ChoiceGroup
    /** True when every alternative in the group is optional. */
    readonly optional: boolean
  }

export function checklist(set: RequirementSet): readonly ChecklistEntry[] {
  const entries: ChecklistEntry[] = []
  const seenGroups = new Set<string>()
  for (const requirement of orderedRequirements(set)) {
    if (requirement.choiceGroup === null) {
      entries.push({ kind: 'document', requirement })
      continue
    }
    if (seenGroups.has(requirement.choiceGroup)) continue
    seenGroups.add(requirement.choiceGroup)
    const group = choiceGroups(set).find((g) => g.key === requirement.choiceGroup)
    if (group === undefined) continue
    entries.push({
      kind: 'choice',
      group,
      optional: group.options.every((option) => option.optional),
    })
  }
  return entries
}

/**
 * How many documents the applicant will actually write.
 *
 * A CHOICE COUNTS ONCE, not once per alternative, because they write one of
 * them. Optional supplements are excluded: the count is what is required.
 */
export function requiredDocumentCount(set: RequirementSet): number {
  return checklist(set).filter((entry) =>
    entry.kind === 'choice' ? !entry.optional : !entry.requirement.optional).length
}

/** Whether this school asks for more than one document. Drives the checklist UI. */
export function isMultiDocument(set: RequirementSet): boolean {
  return checklist(set).length > 1
}

/** The questions a document's analysis must report on: its required components. */
export function requiredComponents(
  requirement: WritingRequirement
): readonly RequirementComponent[] {
  return requirement.components.filter((component) => !component.optional)
}

/** Whether this document is one essay answering several questions. Case B. */
export function isMultipart(requirement: WritingRequirement): boolean {
  return requirement.components.length > 1
}

/** Find one requirement by id, across the whole set, including alternatives. */
export function requirementById(
  set: RequirementSet,
  id: string
): WritingRequirement | null {
  return set.requirements.find((requirement) => requirement.id === id) ?? null
}
