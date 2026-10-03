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

import type { RequirementSnapshot } from './snapshot.ts'

const NUL = '\u0000'
const nn = (value: number | null | undefined) =>
  (value === null || value === undefined ? `${NUL}null` : String(value))
const nb = (value: boolean | null | undefined) =>
  (value === null || value === undefined ? `${NUL}null` : String(value))

/**
 * Every field of a requirement that reaches the model or a limit check.
 *
 * WHAT IS IN: the identifiers, so an essay written to alternative (2) can never
 * match a result produced for alternative (1); the components, because prompt
 * alignment reports on each question and a changed question is a changed
 * judgement; every constraint, because the model is told the limits and its
 * assessment of length refers to them; the LABEL and the DOCUMENT TYPE, which
 * are written into the <document> block; and the NOTES, which are quoted as the
 * catalog's own unresolved uncertainty.
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
    // THE TWO THE EARLIER SPLIT LEFT OUT. Both are quoted to the model as the
    // school's own, so an altered one is altered instructions.
    'label', requirement.label,
    'notes', ...requirement.notes,
  ].join(`${NUL}\u0003`)
}
