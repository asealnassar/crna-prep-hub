/**
 * Whether an AI action may be offered at all.
 *
 * A question asked BEFORE the five grounding layers: is there enough of the
 * applicant's own work for a proposal to be an improvement rather than an
 * invention? The verifier can only refuse what a model states; it cannot
 * notice that the only thing a model had to work from was a provider's name
 * and a facility. So two operations are gated on substance:
 *
 *   THE SUMMARY waits until the resume is marked complete. A summary is about
 *   the whole applicant, and tightening one written against half a resume
 *   produces a paragraph that describes a draft.
 *
 *   A SHADOWING ENTRY waits until the applicant has written what they observed.
 *   Provider, setting and facility are an address, not an experience; asked to
 *   "improve" them a model has nothing to improve and everything to imagine.
 *
 * Pure, and shared: the editor disables the control with the same reason the
 * route refuses the request, so the two can never drift.
 */

import { isAiAuthored, isBlankAuthoredText } from '../model/authoredText.ts'
import type { AuthoredText } from '../model/authoredText.ts'
import { descriptorFor } from '../studio/fields.ts'
import type { ResumeSectionType, ResumeSectionV2, ResumeV2 } from '../model/types.ts'
import type { AiOperation } from './prompts.ts'

export interface AssistDecision {
  readonly allowed: boolean
  /** Shown beside the disabled control, and returned by the route verbatim. */
  readonly reason: string
}

const ALLOWED: AssistDecision = { allowed: true, reason: '' }

export const SUMMARY_NEEDS_TEXT =
  'Write your summary first, then use AI to tighten it.'

export const SHADOWING_NEEDS_DETAILS =
  'Write your shadowing details first. AI improves what you wrote; it will not invent it.'

export const VOLUNTEER_NEEDS_DETAILS =
  'Write what you did or contributed first. AI improves what you wrote; it will not invent it.'

export const QUALITY_IMPROVEMENT_NEEDS_DETAILS =
  'Write what you did or improved first. AI improves what you wrote; it will not invent it.'

/**
 * Sections whose narrative must exist before an assistant may touch it, and
 * what to say until it does.
 *
 * These are the entries whose factual fields are an index card -- an
 * organisation, a role, a title, a date. Asked to "improve" that, a model has
 * nothing to improve and everything to imagine: an outcome, a percentage, a
 * team size, a process it has never heard of. A section absent from this table
 * is not gated.
 */
const NARRATIVE_REQUIRED: Partial<Record<ResumeSectionType, string>> = {
  shadowing: SHADOWING_NEEDS_DETAILS,
  volunteer: VOLUNTEER_NEEDS_DETAILS,
  quality_improvement: QUALITY_IMPROVEMENT_NEEDS_DETAILS,
}

/**
 * How many of the applicant's own words a rewrite needs before it is a rewrite.
 *
 * Low on purpose. This is not a quality bar -- it is the difference between
 * having something to improve and having nothing.
 */
export const MIN_NARRATIVE_WORDS = 8

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((word) => word !== '').length
}

/**
 * Whether a field holds enough text the APPLICANT wrote.
 *
 * Accepted AI text is not the applicant's own, so it is read past: what counts
 * is `userSource`, the last words a person actually typed. Otherwise one
 * accepted suggestion would unlock the next, and the entry would drift away
 * from anything they said.
 */
export function hasApplicantNarrative(text: AuthoredText | null | undefined): boolean {
  if (!text || isBlankAuthoredText(text)) return false
  const own = isAiAuthored(text) ? text.userSource : text.accepted
  return wordCount(own) >= MIN_NARRATIVE_WORDS
}

/**
 * The summary may be tightened once the applicant has written one.
 *
 * NOT on Draft vs Complete. Status says whether they consider the resume
 * finished, which is a different question from whether there is a paragraph
 * here worth improving -- and it left someone who had written a good summary on
 * day one unable to tighten it. Takes the text rather than the resume so the
 * editor can ask without holding one.
 */
export function summaryAssist(text: AuthoredText | null | undefined): AssistDecision {
  return hasApplicantNarrative(text) ? ALLOWED : { allowed: false, reason: SUMMARY_NEEDS_TEXT }
}

/** The narrative field of one entry, whichever field that section calls it. */
function narrativeOf(
  section: ResumeSectionV2,
  entryId: string | null,
  fieldName: string | null
): AuthoredText | undefined {
  const entry = descriptorFor(section.type).entry
  if (!entry || !entryId) return undefined

  const name = fieldName ?? entry.fields.find((f) => f.kind === 'authored')?.name
  if (!name) return undefined

  const list = (section as unknown as Record<string, Record<string, unknown>[]>)[entry.listKey]
  const item = Array.isArray(list) ? list.find((e) => e.id === entryId) : undefined
  return item?.[name] as AuthoredText | undefined
}

/**
 * The decision for a narrative field on an entry.
 *
 * The editor asks this one, by field, without knowing which section types are
 * gated -- the rule lives in the table above so the editor stays driven by the
 * descriptor rather than by a list of special cases it would have to be kept in
 * step with.
 */
export function fieldAssist(
  section: ResumeSectionV2,
  entryId: string | null,
  fieldName: string | null
): AssistDecision {
  const reason = NARRATIVE_REQUIRED[section.type]
  if (!reason) return ALLOWED
  return hasApplicantNarrative(narrativeOf(section, entryId, fieldName))
    ? ALLOWED
    : { allowed: false, reason }
}

/**
 * The one decision both the editor and the route ask.
 *
 * Everything not named here is allowed: this adds gates, it does not become a
 * second place where AI eligibility is decided. Which FIELDS may be written at
 * all is still the descriptor's answer, and whether a sentence may be KEPT is
 * still the verifier's.
 */
export function assistDecision(input: {
  readonly resume: ResumeV2
  readonly section: ResumeSectionV2
  readonly operation: AiOperation
  readonly targetId: string | null
  readonly field: string | null
}): AssistDecision {
  const { section, targetId, field } = input

  if (section.type === 'summary') return summaryAssist(section.text)
  return fieldAssist(section, targetId, field)
}
