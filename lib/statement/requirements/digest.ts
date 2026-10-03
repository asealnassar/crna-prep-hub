/**
 * A requirement snapshot reduced to one canonical string.
 *
 * ONE DIGEST, FOR BOTH QUESTIONS. "Has this snapshot stopped being what the
 * school published?" and "does this change cost a new analysis?" have the same
 * answer, because the set of fields involved is the same set: everything this
 * product puts in front of the model as the school's requirement.
 *
 * AN EARLIER VERSION HAD TWO, AND THE SPLIT WAS WRONG. It excluded `label` and
 * `notes` from the cache key on the grounds that renaming a document is
 * housekeeping -- reasoning borrowed from the draft TITLE, which genuinely
 * reaches nothing. But the requirement label and the notes both reach the model:
 * buildReviewUserMessage writes the label into the <document> block ("This is
 * ONE document: Diversity Statement") and the notes into a sentence beginning
 * "The catalog records unresolved uncertainty about this requirement". Changing
 * either changes the instructions the model is given, so a cached result
 * produced under the old wording is not an answer to the new question. The
 * applicant's own draft title remains exempt, because it reaches no prompt.
 *
 * PURE, AND DELIBERATELY FREE OF node:crypto. The hashing lives in
 * analysisFingerprint.ts, which is server-only for that reason; this module is
 * only string building, so provenance checking can compare two digests without
 * dragging a Node builtin into anything.
 *
 * THE SEPARATORS CANNOT OCCUR IN PROSE OR IN A UUID, so no field's contents can
 * be shifted across a boundary to forge a match with a different field layout.
 */

import { DEFAULT_ENFORCEMENT, type Constraints } from './constraints.ts'
import type { RequirementSnapshot } from './snapshot.ts'

const NUL = '\u0000'
const nn = (value: number | null | undefined) =>
  (value === null || value === undefined ? `${NUL}null` : String(value))
const nb = (value: boolean | null | undefined) =>
  (value === null || value === undefined ? `${NUL}null` : String(value))

/**
 * The length registers, appended ONLY when one of them is not the default.
 *
 * THIS CONDITIONAL IS THE BACKWARD-COMPATIBILITY MECHANISM AND IS NOT A TRICK.
 * The rule it implements is the rule the whole digest implements: the digest
 * records WHAT THE MODEL IS TOLD AND WHAT A LIMIT CHECK USES. A limit in the
 * default register produces byte-for-byte the instructions it produced before
 * this field existed -- "500 words maximum", warned on as a maximum -- so it
 * must produce byte-for-byte the same digest, or every draft saved to date
 * would lose its cached analysis and have to be paid for again over a field
 * whose value changed nothing about its analysis.
 *
 * A NON-DEFAULT REGISTER DOES CHANGE THE DIGEST, and must. "250 words
 * suggested" is a different instruction from "250 words maximum": the
 * constraint lines differ, the over-limit sentence differs, and the analyser is
 * told explicitly not to treat it as a cap. A result produced under one is not
 * an answer to the other.
 *
 * statedAs IS IN HERE TOO, because it is quoted to the applicant and to the
 * model as the school's own sentence. Changing the quotation changes what was
 * said, exactly as changing `notes` does.
 */
function registerSegments(requirement: RequirementSnapshot): readonly string[] {
  const c = requirement.constraints
  const limits = [
    ['words', c.words] as const,
    ['chars', c.characters] as const,
    ['pages', c.pages] as const,
  ]
  const nonDefault = limits.some(([, limit]) =>
    limit !== null
    && (limit.enforcement !== DEFAULT_ENFORCEMENT || limit.statedAs !== null))
  // THE UNENFORCED LENGTH SENTENCE IS PART OF THE SAME CONDITION, for the same
  // reason. It did not exist when any current draft was saved, so every one of
  // them has null here and must keep the digest it already has; a draft that
  // HAS one is being given an instruction no draft was given before, so it
  // must not share a cache row with one that is not.
  if (!nonDefault && requirement.constraints.unenforcedLength === null) return []
  const out: string[] = ['enf']
  for (const [key, limit] of limits) {
    out.push(key)
    out.push(limit === null ? `${NUL}null` : limit.enforcement)
    out.push(limit === null || limit.statedAs === null ? `${NUL}null` : limit.statedAs)
  }
  // THE TEXT AND THE FLAG. Whether a sentence is attributed to the school as a
  // quotation changes what the applicant is told and what the model is told, so
  // the same text shown two ways is two different requirements.
  const shown = requirement.constraints.unenforcedLength
  out.push('unenf', shown === null ? `${NUL}null` : shown.text)
  out.push(shown === null ? `${NUL}null` : String(shown.verbatim))
  return out
}

/**
 * Every field of a requirement that reaches the model or a limit check.
 *
 * WHAT IS IN: the identifiers, so an essay written to alternative (2) can never
 * match a result produced for alternative (1); the components, because prompt
 * alignment reports on each question and a changed question is a changed
 * judgement; every constraint, because the model is told the limits and its
 * assessment of length refers to them; each limit's REGISTER and the school's
 * own sentence about it, because "250 words suggested" and "250 words maximum"
 * are different instructions and produce different advice; the UNENFORCED
 * LENGTH sentence, which is quoted to the model together with an instruction
 * not to penalise exceeding it; the LABEL and the
 * DOCUMENT TYPE, which are written into the <document> block; and the NOTES,
 * which are quoted as the catalog's own unresolved uncertainty.
 *
 * WHAT IS OUT, and why each is safe to leave out:
 *
 *   verification      never trusted from a snapshot at all. Provenance is
 *                     computed fresh from the catalog set's own columns, so the
 *                     snapshot's copy influences nothing. Including it would
 *                     also mean a re-verification date bump invalidated every
 *                     stored analysis and downgraded every existing draft,
 *                     which is a regression rather than a protection.
 *   applicationCycle  display only. It reaches no model prompt, no eligibility
 *                     decision and no limit check.
 *
 * ORDER IS PART OF THE VALUE for components, because the school's numbering is
 * part of the question. Reordering two prompts is a different requirement.
 */
export function requirementDigest(requirement: RequirementSnapshot): string {
  const c = requirement.constraints
  return [
    requirement.requirementId,
    requirement.setId,
    requirement.schoolId,
    requirement.documentType,
    requirement.choiceGroup ?? `${NUL}null`,
    String(requirement.optional),
    requirement.promptText,
    // Each component as id/optional/text, in the school's own order.
    ...requirement.components.map((part) =>
      [part.id, String(part.optional), part.text].join(`${NUL}\u0002`)),
    // A fixed field order, so a null and an absent section cannot differ.
    'words', nn(c.words?.min), nn(c.words?.max),
    'chars', nn(c.characters?.min), nn(c.characters?.max), nb(c.characters?.spacesCount),
    'pages', nn(c.pages?.min), nn(c.pages?.max), c.pages?.spacing ?? `${NUL}null`,
    'type', nn(c.typography?.fontSizePt), c.typography?.fontFamily ?? `${NUL}null`,
    nn(c.typography?.marginsInches),
    'cite', c.citation?.family ?? `${NUL}null`, c.citation?.statedAs ?? `${NUL}null`,
    nn(c.citation?.minReferences),
    'other', ...c.otherInstructions,
    // ABSENT ENTIRELY when every register is the default, so an existing
    // draft's digest -- and therefore its cached analysis -- is untouched.
    ...registerSegments(requirement),
    // THE TWO THE EARLIER SPLIT LEFT OUT. Both are quoted to the model as the
    // school's own, so an altered one is altered instructions.
    'label', requirement.label,
    'notes', ...requirement.notes,
  ].join(`${NUL}\u0003`)
}
