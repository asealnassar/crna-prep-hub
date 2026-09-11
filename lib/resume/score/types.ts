/**
 * CRNA Resume Strength: the category table, as data.
 *
 * WHAT THE NUMBER IS. A measure of RESUME QUALITY. It is not a prediction, not
 * a probability, and not a statement about anyone's chances. V1's scorer
 * asserted things like "required by most programs"; nothing here may.
 *
 * TWO SUB-SCORES, NOT ONE BLEND. "You scored 72" says nothing useful. "Data
 * Quality 34/40, Writing Quality 38/60" says immediately which kind of work is
 * in front of you -- fix your dates, or rewrite your bullets. They sum to the
 * locked 0-100.
 *
 * WHAT NO CATEGORY MEASURES. Whether the applicant has a GPA, a certification,
 * shadowing hours, leadership, research or publications. That is not a promise
 * kept by the prompt; it is structural. The deterministic half contains no rule
 * that reads any of them, the rubric half is scoped to presentation, and a
 * category with nothing legitimate to assess is EXCLUDED from its sub-score's
 * denominator rather than scored zero. A resume with none of the optional
 * experiences above can still reach 100.
 */

export type SubScoreId = 'data-quality' | 'writing-quality'

export type CategoryId =
  // Data quality -- deterministic, pure, free, instant.
  | 'section-completeness'
  | 'contact-completeness'
  | 'date-integrity'
  | 'content-hygiene'
  | 'length-and-fit'
  // Writing quality -- the AI rubric.
  | 'clinical-specificity'
  | 'accomplishment-focus'
  | 'critical-care-presentation'
  | 'leadership-framing'
  | 'clarity-and-tone'
  | 'organisation-readability'

export interface CategoryDefinition {
  readonly id: CategoryId
  readonly subScore: SubScoreId
  readonly label: string
  readonly maxPoints: number
  /** Shown to the applicant beside the score. Plain English, no jargon. */
  readonly measures: string
}

export const SUB_SCORE_MAX: Readonly<Record<SubScoreId, number>> = {
  'data-quality': 40,
  'writing-quality': 60,
}

export const SUB_SCORE_LABEL: Readonly<Record<SubScoreId, string>> = {
  'data-quality': 'Data Quality',
  'writing-quality': 'Writing Quality',
}

/** The locked breakdown. Every weight here was decided; none is a default. */
export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'section-completeness',
    subScore: 'data-quality',
    label: 'Section completeness',
    maxPoints: 10,
    measures:
      'Whether the sections you chose to include actually have content. It never asks why you do not have a section you did not add.',
  },
  {
    id: 'contact-completeness',
    subScore: 'data-quality',
    label: 'Contact completeness',
    maxPoints: 8,
    measures:
      'Whether a programme can identify and reach you: your name, email, phone and location. Credentials are not scored here.',
  },
  {
    id: 'date-integrity',
    subScore: 'data-quality',
    label: 'Date integrity',
    maxPoints: 8,
    measures:
      'Whether the dates you entered read clearly and run forwards. Leaving an optional date out is not counted against you.',
  },
  {
    id: 'content-hygiene',
    subScore: 'data-quality',
    label: 'Content hygiene',
    maxPoints: 8,
    measures: 'Empty bullets, repeated lines and leftover placeholder text.',
  },
  {
    id: 'length-and-fit',
    subScore: 'data-quality',
    label: 'Length and fit',
    maxPoints: 6,
    measures:
      'Whether the resume sits at a workable length for what it contains. Having more experience is never the problem; how tightly it is written can be.',
  },
  {
    id: 'clinical-specificity',
    subScore: 'writing-quality',
    label: 'Clinical specificity',
    maxPoints: 14,
    measures:
      'Whether your lines describe what you actually did, rather than what anyone in the role does. A nurse in a small community ICU can score full marks here.',
  },
  {
    id: 'accomplishment-focus',
    subScore: 'writing-quality',
    label: 'Accomplishment focus',
    maxPoints: 12,
    measures:
      'Whether your lines are framed around what you contributed rather than reading as a job description. Not having figures to quote does not reduce this.',
  },
  {
    id: 'critical-care-presentation',
    subScore: 'writing-quality',
    label: 'Critical-care presentation',
    maxPoints: 12,
    measures:
      'How clearly your critical-care work reads to someone outside your unit. It measures the presentation, never the amount.',
  },
  {
    id: 'leadership-framing',
    subScore: 'writing-quality',
    label: 'Leadership framing',
    maxPoints: 8,
    measures:
      'Where you have recorded leadership, precepting or committee work, how clearly it is presented. Not assessed at all when you have not recorded any.',
  },
  {
    id: 'clarity-and-tone',
    subScore: 'writing-quality',
    label: 'Clarity and tone',
    maxPoints: 8,
    measures: 'Professional register, consistent tense, and language a reader outside your specialty follows.',
  },
  {
    id: 'organisation-readability',
    subScore: 'writing-quality',
    label: 'Organisation and readability',
    maxPoints: 6,
    measures: 'Whether the order and structure help a reader find your strongest material quickly.',
  },
]

export const CATEGORY_BY_ID: Readonly<Record<CategoryId, CategoryDefinition>> =
  Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<CategoryId, CategoryDefinition>

export function categoriesOf(subScore: SubScoreId): CategoryDefinition[] {
  return CATEGORIES.filter((c) => c.subScore === subScore)
}

/**
 * One category's verdict.
 *
 * `earned: null` means NOT ASSESSED -- there was nothing legitimate to judge,
 * so the category leaves the denominator entirely. That is the mechanism that
 * makes "we never deduct for what you do not have" true rather than intended.
 */
export interface CategoryResult {
  readonly id: CategoryId
  readonly earned: number | null
  readonly max: number
  readonly strengths: readonly string[]
  readonly weaknesses: readonly string[]
  readonly improvements: readonly string[]
  /** Present when `earned` is null. Shown in place of a score. */
  readonly notAssessed?: string
}

export interface SubScoreResult {
  readonly id: SubScoreId
  readonly label: string
  /** Rescaled across the categories that were assessed. */
  readonly points: number
  readonly max: number
  readonly categories: readonly CategoryResult[]
  /** Present when nothing in this half could be judged yet. */
  readonly notAssessed?: string
}

export interface StrengthResult {
  /** 0-100. The headline. */
  readonly score: number
  readonly dataQuality: SubScoreResult
  readonly writingQuality: SubScoreResult
  /** The resume revision this was computed against. Drives staleness. */
  readonly computedAtRevision: number
  readonly computedAt: string
}

/** Helper for building a result. Keeps every construction site consistent. */
export function category(
  id: CategoryId,
  earned: number | null,
  parts: {
    strengths?: readonly string[]
    weaknesses?: readonly string[]
    improvements?: readonly string[]
    notAssessed?: string
  } = {}
): CategoryResult {
  const definition = CATEGORY_BY_ID[id]
  const clamped =
    earned === null ? null : Math.max(0, Math.min(definition.maxPoints, Math.round(earned * 100) / 100))
  return {
    id,
    earned: clamped,
    max: definition.maxPoints,
    strengths: parts.strengths ?? [],
    weaknesses: parts.weaknesses ?? [],
    improvements: parts.improvements ?? [],
    ...(clamped === null ? { notAssessed: parts.notAssessed ?? 'Nothing to assess yet.' } : {}),
  }
}
