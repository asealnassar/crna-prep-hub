/**
 * The school's writing requirements as a checklist, ready to render.
 *
 * A VIEW MODEL, NOT A COMPONENT, for the reason every other decision in this
 * feature lives in lib/: next/navigation and next/headers cannot be resolved
 * under `node --test`, so anything inside a component is testable only by
 * reading its source as text. Which card appears, what it says about a limit,
 * whether it offers Start or Continue and whether a choice has been made are
 * all decisions worth real runtime tests, so they are made here and the
 * component renders what it is given.
 *
 * ONE DOCUMENT, ONE DRAFT, ONE ANALYSIS -- AND STILL VISIBLY ONE SCHOOL. Each
 * card owns its own draft and its own analysis; the checklist is what keeps
 * them visibly part of one application. That is the whole reason the set exists
 * as a level above the document.
 *
 * NOTHING IS CREATED EAGERLY. A school asking for five essays does not get five
 * drafts the moment an applicant opens it. Every card is either started or
 * offering to start, and an applicant who writes one and leaves is in a normal
 * state, not an incomplete one.
 */

import { liveCounts, type LiveCount } from './constraints.ts'
import { constraintSummary, labelledConstraints, showUnmeasuredNotice, type LabelledConstraint } from './constraintText.ts'
import {
  DOCUMENT_TYPE_LABELS, checklist, requiredDocumentCount, type ChecklistEntry,
  type RequirementSet, type WritingRequirement,
} from './requirement.ts'
import { VERIFICATION_NOTICES, needsVerificationWarning, textAttribution } from './verification.ts'

/** A draft the applicant already has, as far as this screen cares. */
export interface StartedDraft {
  readonly id: string
  readonly requirementId: string
  readonly title: string
  readonly updatedAt: string
  readonly words: number
}

/** One question inside a document, for display. */
export interface QuestionView {
  readonly id: string
  readonly text: string
  readonly optional: boolean
}

/** What one writing card shows. */
export interface RequirementCard {
  /** The requirement this card will create or open a draft for. */
  readonly requirementId: string
  readonly label: string
  readonly documentTypeLabel: string
  readonly promptText: string
  /**
   * The school's own questions inside this one document.
   *
   * SHOWN TOGETHER, inside the one card and later inside the one editor panel,
   * because they are answered in one essay. A card per question would be the
   * product telling the applicant to write four essays where the school asked
   * for one.
   */
  readonly questions: readonly QuestionView[]
  readonly constraints: readonly LabelledConstraint[]
  readonly constraintSummary: string
  readonly showUnmeasuredNotice: boolean
  readonly liveCounts: readonly LiveCount[]
  readonly optional: boolean
  readonly notes: readonly string[]
  /** The draft already started for this document, if there is one. */
  readonly started: StartedDraft | null
  readonly action: 'start' | 'continue'
}

/**
 * One row of the checklist: a document, or a choice between documents.
 *
 * A CHOICE IS ONE ROW WITH SEVERAL CARDS. "Choose one of these two prompts" is
 * one thing to do, and the applicant decides which before a draft exists --
 * which is the only moment the decision means anything, because after that the
 * draft answers the prompt it was created for.
 */
export type ChecklistRow =
  | { readonly kind: 'document'; readonly card: RequirementCard }
  | {
    readonly kind: 'choice'
    readonly key: string
    readonly optional: boolean
    readonly options: readonly RequirementCard[]
    /**
     * The option already started, when one has been.
     *
     * ONCE ONE IS STARTED THE CHOICE IS MADE, and the row stops offering the
     * others: an applicant with a draft against alternative (2) is not helped
     * by a button that starts alternative (1) beside it. They can delete the
     * draft to change their mind, which is a deliberate act.
     */
    readonly chosen: RequirementCard | null
  }

export interface ChecklistView {
  readonly schoolName: string
  readonly applicationCycle: string | null
  readonly rows: readonly ChecklistRow[]
  /** Documents the applicant must write. A choice counts once. */
  readonly requiredCount: number
  /** How many of those are started. Never more than requiredCount. */
  readonly startedCount: number
  /** The provenance warning, when this entry is not verified. */
  readonly verificationNotice: string | null
  readonly textAttribution: string
  readonly notes: readonly string[]
  /** The research text, so a reader can audit the structuring. */
  readonly originalText: string
}

function cardFor(
  requirement: WritingRequirement,
  drafts: readonly StartedDraft[]
): RequirementCard {
  // FIRST BY REQUIREMENT ID, and the most recently edited one when somebody has
  // more than one draft against the same document. Nothing prevents that -- a
  // draft is the applicant's and they may keep two attempts -- so the card
  // opens the one they touched last rather than an arbitrary one.
  const started = drafts
    .filter((draft) => draft.requirementId === requirement.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null

  return {
    requirementId: requirement.id,
    label: requirement.label,
    documentTypeLabel: DOCUMENT_TYPE_LABELS[requirement.documentType],
    promptText: requirement.promptText,
    questions: requirement.components.map((part) => ({
      id: part.id, text: part.text, optional: part.optional,
    })),
    constraints: labelledConstraints(requirement.constraints),
    constraintSummary: constraintSummary(requirement.constraints),
    showUnmeasuredNotice: showUnmeasuredNotice(requirement.constraints),
    liveCounts: liveCounts(requirement.constraints),
    optional: requirement.optional,
    notes: requirement.notes,
    started,
    action: started === null ? 'start' : 'continue',
  }
}

function rowFor(entry: ChecklistEntry, drafts: readonly StartedDraft[]): ChecklistRow {
  if (entry.kind === 'document') {
    return { kind: 'document', card: cardFor(entry.requirement, drafts) }
  }
  const options = entry.group.options.map((option) => cardFor(option, drafts))
  return {
    kind: 'choice',
    key: entry.group.key,
    optional: entry.optional,
    options,
    chosen: options.find((option) => option.started !== null) ?? null,
  }
}

/** Whether this row counts as done, for the progress line. */
function rowStarted(row: ChecklistRow): boolean {
  return row.kind === 'document' ? row.card.started !== null : row.chosen !== null
}

/** Whether this row is something the applicant must do. */
function rowRequired(row: ChecklistRow): boolean {
  return row.kind === 'document' ? !row.card.optional : !row.optional
}

export function checklistView(input: {
  readonly set: RequirementSet
  readonly drafts: readonly StartedDraft[]
}): ChecklistView {
  const rows = checklist(input.set).map((entry) => rowFor(entry, input.drafts))
  return {
    schoolName: input.set.schoolName,
    applicationCycle: input.set.applicationCycle,
    rows,
    requiredCount: requiredDocumentCount(input.set),
    // COUNTED OVER REQUIRED ROWS ONLY, so writing an optional supplement
    // cannot report "3 of 2 started", which is the kind of arithmetic that
    // makes a reader distrust everything else on the screen.
    startedCount: rows.filter((row) => rowRequired(row) && rowStarted(row)).length,
    verificationNotice: needsVerificationWarning(input.set.verification)
      ? VERIFICATION_NOTICES[input.set.verification.status]
      : null,
    textAttribution: textAttribution(input.set.verification),
    notes: input.set.notes,
    originalText: input.set.originalText,
  }
}

/** "2 of 3 started", or the singular, or the all-done line. */
export function progressLabel(view: ChecklistView): string {
  if (view.requiredCount === 0) return 'No required writing recorded'
  if (view.startedCount === 0) {
    return `${view.requiredCount} required ${view.requiredCount === 1 ? 'document' : 'documents'}`
  }
  if (view.startedCount >= view.requiredCount) {
    return `All ${view.requiredCount} started`
  }
  return `${view.startedCount} of ${view.requiredCount} started`
}
