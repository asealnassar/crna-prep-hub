/**
 * The Statement Studio V2 rubric: what is scored, how much it counts, and what
 * a number means.
 *
 * SEPARATE FROM THE LEGACY ANALYSER, deliberately. lib/statement/analysis.ts
 * scores six categories and takes their unweighted mean; this rubric has seven
 * with explicit weights, one of which does not always apply. They are different
 * instruments that happen to both produce a percentage, and merging them would
 * mean one set of weights quietly governing both.
 *
 * EVERY NUMBER HERE IS COMPUTED, NEVER BELIEVED. A model is asked for category
 * scores and for nothing else; the weighting, the redistribution and the
 * headline percentage all happen in this file, where they can be tested without
 * a model and cannot be influenced by one.
 *
 * THESE ARE WRITING-DEVELOPMENT INDICATORS. Nothing here estimates a chance of
 * admission, and no wording in this module should start to.
 */

/**
 * The schema version, carried on every result.
 *
 * It exists so a stored or in-flight result from an older rubric can be
 * recognised rather than silently re-read under new weights. Bump it whenever a
 * category, a weight or the band boundaries change.
 */
export const RUBRIC_VERSION = 'statement-rubric-v1'

/** The identifiers a model must use. Stable; the labels may be reworded. */
export type CategoryId =
  | 'motivation'
  | 'clinical-experience'
  | 'reflection-growth'
  | 'understanding-goals'
  | 'organization-flow'
  | 'writing-quality'
  | 'prompt-alignment'

export interface RubricCategory {
  readonly id: CategoryId
  readonly label: string
  /** Percentage points out of 100 when every category applies. */
  readonly weight: number
  /** True for the one category that needs a prompt to mean anything. */
  readonly needsPrompt: boolean
}

/**
 * The approved rubric. The weights total 100 and a test asserts it.
 *
 * ORDER IS DISPLAY ORDER, and prompt alignment is last because it is the one
 * that may be absent -- a list that ends with "not assessed" reads better than
 * one with a hole in the middle.
 */
export const RUBRIC: readonly RubricCategory[] = [
  { id: 'motivation', label: 'Motivation for nurse anesthesia', weight: 20, needsPrompt: false },
  { id: 'clinical-experience', label: 'Clinical experience and examples', weight: 20, needsPrompt: false },
  { id: 'reflection-growth', label: 'Personal reflection and growth', weight: 20, needsPrompt: false },
  { id: 'understanding-goals', label: 'Understanding of nurse anesthesia and career goals', weight: 15, needsPrompt: false },
  { id: 'organization-flow', label: 'Organization and flow', weight: 10, needsPrompt: false },
  { id: 'writing-quality', label: 'Grammar, clarity, and writing quality', weight: 5, needsPrompt: false },
  { id: 'prompt-alignment', label: 'School-prompt alignment', weight: 10, needsPrompt: true },
]

export const CATEGORY_IDS: readonly CategoryId[] = RUBRIC.map((c) => c.id)

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && (CATEGORY_IDS as readonly string[]).includes(value)
}

/** What is shown when a general statement reaches prompt alignment. */
export const NOT_ASSESSED = 'Not assessed — no school prompt attached.'

// ---------------------------------------------------------------------------
// Scores and bands
// ---------------------------------------------------------------------------

/**
 * The scores a category may receive.
 *
 * FOUR IS ABSENT ON PURPOSE. The approved bands are 1-3, 5-7 and 8-10, so a 4
 * belongs to no band. The two wrong answers would be inventing a fourth band
 * for it or quietly moving it to 3 or 5 -- either would report a number nobody
 * assigned. So a 4 is not a score: it is malformed model output, and the parser
 * refuses the whole result rather than guessing which way the model meant to
 * round.
 */
export const VALID_SCORES: readonly number[] = [1, 2, 3, 5, 6, 7, 8, 9, 10]

export function isValidScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && VALID_SCORES.includes(value)
}

export type Band = 'needs-improvement' | 'developing' | 'strong'

export const BAND_LABELS: Readonly<Record<Band, string>> = {
  'needs-improvement': 'Needs Improvement',
  developing: 'Developing',
  strong: 'Strong',
}

/**
 * The band a score falls in, or null when it falls in none.
 *
 * NULL IS ONLY EVER REACHED BY A SCORE THAT SHOULD NOT EXIST -- a 4, a zero, a
 * 11 -- because isValidScore refuses those before a result is built. It returns
 * null rather than throwing so a display path cannot crash on data that got
 * past the parser some other way.
 */
export function bandFor(score: number): Band | null {
  if (!Number.isInteger(score)) return null
  if (score >= 1 && score <= 3) return 'needs-improvement'
  if (score >= 5 && score <= 7) return 'developing'
  if (score >= 8 && score <= 10) return 'strong'
  return null
}

// ---------------------------------------------------------------------------
// Which categories apply, and what they are worth
// ---------------------------------------------------------------------------

/** The categories assessed for this draft. Six, or seven with a prompt. */
export function categoriesFor(promptAttached: boolean): readonly RubricCategory[] {
  if (promptAttached) return RUBRIC
  return RUBRIC.filter((category) => !category.needsPrompt)
}

/**
 * What each applicable category is worth, redistributed when one is absent.
 *
 * A GENERAL STATEMENT IS NOT PENALISED FOR BEING ONE. Dropping prompt alignment
 * and leaving the other six at their original weights would cap a flawless
 * general statement at 90%, which would be scoring somebody down for a choice
 * the product offered them. Instead the missing ten points are redistributed in
 * proportion, so the six remaining categories still total 100.
 *
 * NOT ROUNDED HERE. 20 becomes 22.222..., and rounding that to 22 six times
 * over would lose two points before the sum was taken. The only rounding
 * happens once, on the final percentage.
 */
export function weightsFor(promptAttached: boolean): ReadonlyMap<CategoryId, number> {
  const applicable = categoriesFor(promptAttached)
  const total = applicable.reduce((sum, category) => sum + category.weight, 0)
  const weights = new Map<CategoryId, number>()
  for (const category of applicable) {
    weights.set(category.id, (category.weight * 100) / total)
  }
  return weights
}

// ---------------------------------------------------------------------------
// The headline number
// ---------------------------------------------------------------------------

/**
 * The weighted percentage, out of 100.
 *
 * COMPUTED FROM THE CATEGORY SCORES AND NOTHING ELSE. A model may not report an
 * overall score; if one appears in its output it is ignored, because a total
 * that disagrees with its own parts is the single easiest thing for a language
 * model to produce and the hardest for a reader to notice.
 *
 * A score of 1-10 is read as 10-100 per category, weighted, and summed. All
 * eights therefore give exactly 80 whether six categories were assessed or
 * seven -- which is the property that makes a general statement's score
 * comparable with a school-specific one.
 *
 * RETURNS NULL IF A CATEGORY IS MISSING, rather than scoring what did arrive. A
 * percentage computed over five of six categories is not this applicant's
 * score, and presenting it as one would be worse than presenting nothing.
 */
export function overallScore(input: {
  readonly scores: ReadonlyMap<CategoryId, number>
  readonly promptAttached: boolean
}): number | null {
  const weights = weightsFor(input.promptAttached)
  let total = 0
  for (const [id, weight] of weights) {
    const score = input.scores.get(id)
    if (!isValidScore(score)) return null
    total += (weight * score * 10) / 100
  }
  return Math.max(0, Math.min(100, Math.round(total)))
}

// ---------------------------------------------------------------------------
// Whether a draft may be analysed at all
// ---------------------------------------------------------------------------

/** The ordinary floor, in words, for a statement worth seven categories of feedback. */
export const MIN_ANALYSIS_WORDS = 100

/**
 * Below this stated maximum, the seven-category rubric does not fit the task.
 *
 * A 40-word answer is a different genre, and scoring its "organization and
 * flow" out of ten would be measuring something that is not there. A short
 * response analyser is a separate, unapproved piece of work.
 */
export const SHORT_PROMPT_CEILING = 50

export type Eligibility =
  | { readonly kind: 'eligible'; readonly minimumWords: number }
  | { readonly kind: 'too-short'; readonly minimumWords: number; readonly words: number }
  | { readonly kind: 'prompt-too-short'; readonly statedMaxWords: number }

/**
 * Whether this draft can be analysed, and what it would take.
 *
 * THE FLOOR MOVES WITH THE PROMPT. An ordinary statement needs 100 words to say
 * anything a rubric can read. A school asking for 60 would make that floor
 * impossible, so for a stated maximum of 50-99 the floor becomes 80% of it --
 * enough to be a real attempt at the answer, and reachable.
 *
 * A BELOW-MINIMUM ATTEMPT IS NOT A FAILURE TO CHARGE FOR. The caller must check
 * this BEFORE recording a usage attempt; a test on the route asserts that
 * order, because consuming somebody's allowance to tell them their essay is too
 * short is the kind of billing behaviour nobody forgives.
 */
export function eligibilityFor(input: {
  readonly words: number
  readonly statedMaxWords: number | null
}): Eligibility {
  const { words, statedMaxWords } = input

  if (statedMaxWords !== null && statedMaxWords < SHORT_PROMPT_CEILING) {
    return { kind: 'prompt-too-short', statedMaxWords }
  }

  const minimumWords = statedMaxWords !== null && statedMaxWords < MIN_ANALYSIS_WORDS
    ? Math.ceil(0.8 * statedMaxWords)
    : MIN_ANALYSIS_WORDS

  if (words < minimumWords) return { kind: 'too-short', minimumWords, words }
  return { kind: 'eligible', minimumWords }
}

/**
 * Whether the essay is past the school's stated maximum.
 *
 * REPORTED, NEVER ENFORCED. Going over is the applicant's business: the
 * analysis still runs, the warning is prominent, and no fixed penalty is
 * subtracted anywhere. Length may inform the prompt-alignment judgement -- a
 * 900-word answer to a 500-word question has not answered it as asked -- but
 * that is a judgement about the writing, not an automatic deduction.
 */
export function overLimit(input: {
  readonly words: number
  readonly statedMaxWords: number | null
}): boolean {
  if (input.statedMaxWords === null) return false
  return input.words > input.statedMaxWords
}
