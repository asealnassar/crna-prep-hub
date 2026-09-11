/**
 * Merging both halves into one 0-100, and the rescaling that makes the
 * no-penalty rule structural.
 *
 * Pure. Given the same categories it produces the same result, so the arithmetic
 * that decides someone's number is unit-tested rather than inferred.
 *
 * THE RESCALING RULE, which is the load-bearing part of this file:
 *
 *   A category with `earned: null` was NOT ASSESSED. It leaves the denominator
 *   entirely. Its points are not awarded and not withheld -- they cease to
 *   exist, and the remaining categories in that sub-score expand to fill the
 *   sub-score's full weight.
 *
 * So an applicant with no leadership recorded does not score 0/8 for Leadership
 * framing; the category reads "not assessed" and the other five writing
 * categories carry the whole 60. A resume with no leadership, no research, no
 * publications and no shadowing can still reach 100. That is the difference
 * between a promise in a prompt and a property of the arithmetic.
 */

import { SUB_SCORE_LABEL, SUB_SCORE_MAX, categoriesOf } from './types.ts'
import type {
  CategoryResult, StrengthResult, SubScoreId, SubScoreResult,
} from './types.ts'

export function composeSubScore(
  id: SubScoreId,
  results: readonly CategoryResult[]
): SubScoreResult {
  const wanted = new Set(categoriesOf(id).map((c) => c.id))
  const mine = results.filter((r) => wanted.has(r.id))
  const assessed = mine.filter((r) => r.earned !== null)
  const max = SUB_SCORE_MAX[id]

  if (assessed.length === 0) {
    // Nothing in this half could be judged. Not a penalty for lacking an
    // experience -- there is no writing to assess at all -- so it is reported
    // as what it is rather than as a zero the applicant cannot explain.
    return {
      id,
      label: SUB_SCORE_LABEL[id],
      points: 0,
      max,
      categories: mine,
      notAssessed:
        id === 'writing-quality'
          ? 'Nothing written yet. Add a summary or some bullets and this half becomes scoreable.'
          : 'Nothing on the resume yet to check.',
    }
  }

  const earned = assessed.reduce((sum, r) => sum + (r.earned ?? 0), 0)
  const available = assessed.reduce((sum, r) => sum + r.max, 0)
  const points = available === 0 ? 0 : Math.round((earned / available) * max)

  return {
    id,
    label: SUB_SCORE_LABEL[id],
    points: Math.max(0, Math.min(max, points)),
    max,
    categories: mine,
  }
}

export function compose(input: {
  readonly categories: readonly CategoryResult[]
  readonly revision: number
  readonly now: string
}): StrengthResult {
  const dataQuality = composeSubScore('data-quality', input.categories)
  const writingQuality = composeSubScore('writing-quality', input.categories)

  return {
    score: Math.max(0, Math.min(100, dataQuality.points + writingQuality.points)),
    dataQuality,
    writingQuality,
    computedAtRevision: input.revision,
    computedAt: input.now,
  }
}

/**
 * Whether a stored score still describes the resume in front of the applicant.
 *
 * Any edit bumps the resume's revision, so a score computed at an earlier one
 * is out of date. It stays VISIBLE and is labelled -- hiding it would lose the
 * guidance someone is working through, and silently keeping it would be a
 * number that no longer refers to anything.
 */
export function isStale(computedAtRevision: number, currentRevision: number): boolean {
  return computedAtRevision !== currentRevision
}

/** The neutral sentence under the number. Says nothing about admission. */
export function describeScore(result: StrengthResult): string {
  return `${result.score} out of 100 — Data Quality ${result.dataQuality.points}/${result.dataQuality.max}, Writing Quality ${result.writingQuality.points}/${result.writingQuality.max}.`
}

/** Every line of feedback in a result, for tests and for the improvement list. */
export function allFeedback(result: StrengthResult): string[] {
  return [result.dataQuality, result.writingQuality].flatMap((sub) => [
    ...(sub.notAssessed ? [sub.notAssessed] : []),
    ...sub.categories.flatMap((c) => [
      ...c.strengths, ...c.weaknesses, ...c.improvements,
      ...(c.notAssessed ? [c.notAssessed] : []),
    ]),
  ])
}
