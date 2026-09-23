/**
 * Strict reading of the model's analysis, and the server-side redaction that
 * makes the Ultimate entitlement real.
 *
 * WHAT THIS REPLACES. The route did:
 *
 *     const result = JSON.parse(completion.choices[0].message.content || '{}')
 *     return NextResponse.json({ analysis: result })
 *
 * Whatever the model emitted became the API response and then the rendered
 * page. `analysis.overallScore` went straight into a template literal as a CSS
 * width and as the headline number, so a missing field rendered `undefined%`
 * and a string rendered whatever it said.
 *
 * FOUR THINGS HAPPEN HERE, in order:
 *
 *   1. SHAPE. Every field is checked for type and presence. There is no
 *      fallback chain and no coercion: a response that is not the contract is
 *      rejected whole, and the route answers 502 rather than rendering it.
 *   2. BOUNDS. Scores are clamped to 1-10, strings to a maximum length, arrays
 *      to a maximum count. A model cannot return a megabyte of prose into a
 *      field the page will render, and cannot return a score of 400.
 *   3. ARITHMETIC. `overallScore` is COMPUTED here from the category scores.
 *      The prompt used to ask the model to average six numbers and multiply by
 *      ten, and nothing checked the result. Deriving it is the strictest
 *      validation available for a value that is derivable.
 *   4. REDACTION. `suggestion` and `sentenceAnalysis` are removed for any tier
 *      that has not paid for them, after the model has answered. The prompt
 *      already omits them; this is the layer that holds when the model
 *      volunteers something it was not asked for.
 *
 * Pure. No network, no model, no session.
 */

import { CATEGORY_NAMES } from './prompts.ts'
import { canSeeSentenceAnalysis, canSeeSuggestions } from './entitlement.ts'
import type { ReviewNote } from './prompts.ts'

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Two or three sentences of feedback. Generous; a model in a loop is not. */
export const MAX_FIELD_CHARS = 1_200
/** A rewritten sentence, or an original quoted from the essay. */
export const MAX_SENTENCE_CHARS = 2_000
export const MAX_LIST_ITEMS = 10
export const MAX_SENTENCE_ITEMS = 12
export const MIN_CATEGORY_SCORE = 1
export const MAX_CATEGORY_SCORE = 10

export const SENTENCE_LABELS = ['Weak', 'Generic', 'Strong'] as const
export type SentenceLabel = (typeof SENTENCE_LABELS)[number]

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface AnalysisCategory {
  readonly name: string
  readonly score: number
  readonly feedback: string
  /** Present only for a tier that may see it. */
  readonly suggestion?: string
}

export interface SentenceNote {
  readonly original: string
  readonly label: SentenceLabel
  readonly improved: string
}

export interface StatementAnalysis {
  /** 0-100. Derived here, never read from the model. */
  readonly overallScore: number
  readonly categories: readonly AnalysisCategory[]
  readonly admissionsImpression: string
  readonly biggestWeaknesses: readonly string[]
  readonly topChanges: readonly string[]
  readonly sentenceAnalysis?: readonly SentenceNote[]
}

export type ParseFailure =
  | 'not-json'
  | 'not-an-object'
  | 'no-categories'
  | 'bad-category'
  | 'missing-impression'

export type ParseResult =
  | { readonly ok: true; readonly value: StatementAnalysis }
  | { readonly ok: false; readonly reason: ParseFailure }

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A bounded string, or null.
 *
 * Control characters are stripped rather than rejected: a stray newline in a
 * feedback field is a formatting artefact, not an attack, and rejecting the
 * whole analysis over one would make the feature flaky for no gain. What is NOT
 * tolerated is length.
 */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim()
  if (cleaned === '') return null
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned
}

/** A finite number clamped to the category range, or null. */
function score(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) return null
  return Math.min(MAX_CATEGORY_SCORE, Math.max(MIN_CATEGORY_SCORE, Math.round(n)))
}

/** A bounded array of bounded strings. Non-strings are dropped, not fatal. */
function list(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (out.length >= maxItems) break
    const cleaned = text(item, maxChars)
    if (cleaned !== null) out.push(cleaned)
  }
  return out
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The model's raw completion, read strictly.
 *
 * `includeSuggestions` and `includeSentenceAnalysis` describe what was ASKED
 * for. They do not decide what is returned to the browser -- `redactForTier`
 * does -- but they keep a field the prompt never requested from being read at
 * all, so a volunteered one never reaches the redaction step to be missed.
 */
export function parseAnalysis(
  raw: string,
  options: { readonly includeSuggestions: boolean; readonly includeSentenceAnalysis: boolean }
): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object' }
  }
  const body = parsed as Record<string, unknown>

  if (!Array.isArray(body.categories) || body.categories.length === 0) {
    return { ok: false, reason: 'no-categories' }
  }

  const categories: AnalysisCategory[] = []
  for (const entry of body.categories.slice(0, CATEGORY_NAMES.length)) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const name = text(row.name, 120)
    const value = score(row.score)
    const feedback = text(row.feedback, MAX_FIELD_CHARS)
    if (name === null || value === null || feedback === null) continue

    const suggestion = options.includeSuggestions
      ? text(row.suggestion, MAX_FIELD_CHARS)
      : null

    categories.push({
      name,
      score: value,
      feedback,
      ...(suggestion === null ? {} : { suggestion }),
    })
  }

  // Every category unreadable means the response was not the contract, however
  // well-formed the JSON was. One bad row among six is tolerated; none is not.
  if (categories.length === 0) return { ok: false, reason: 'bad-category' }

  const admissionsImpression = text(body.admissionsImpression, MAX_FIELD_CHARS)
  if (admissionsImpression === null) return { ok: false, reason: 'missing-impression' }

  const sentenceAnalysis = options.includeSentenceAnalysis
    ? readSentences(body.sentenceAnalysis)
    : []

  return {
    ok: true,
    value: {
      overallScore: overallFrom(categories),
      categories,
      admissionsImpression,
      biggestWeaknesses: list(body.biggestWeaknesses, MAX_LIST_ITEMS, MAX_FIELD_CHARS),
      topChanges: list(body.topChanges, MAX_LIST_ITEMS, MAX_FIELD_CHARS),
      ...(sentenceAnalysis.length > 0 ? { sentenceAnalysis } : {}),
    },
  }
}

function readSentences(value: unknown): SentenceNote[] {
  if (!Array.isArray(value)) return []
  const out: SentenceNote[] = []
  for (const entry of value) {
    if (out.length >= MAX_SENTENCE_ITEMS) break
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const original = text(row.original, MAX_SENTENCE_CHARS)
    const improved = text(row.improved, MAX_SENTENCE_CHARS)
    const rawLabel = text(row.label, 32)
    // The label drives a colour and a badge in the page. Anything that is not
    // one of the three is not rendered as a fourth kind of thing.
    const label = SENTENCE_LABELS.find((l) => l.toLowerCase() === rawLabel?.toLowerCase())
    if (original === null || improved === null || label === undefined) continue
    out.push({ original, label, improved })
  }
  return out
}

/**
 * The headline percentage, computed rather than believed.
 *
 * The mean of the category scores times ten, rounded, clamped to 0-100. With
 * scores already clamped to 1-10 the clamp is belt-and-braces, and it is here
 * because this number is interpolated into a CSS width.
 */
export function overallFrom(categories: readonly AnalysisCategory[]): number {
  if (categories.length === 0) return 0
  const mean = categories.reduce((sum, c) => sum + c.score, 0) / categories.length
  return Math.max(0, Math.min(100, Math.round(mean * 10)))
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * The analysis as this tier may receive it.
 *
 * Runs on the way OUT, over whatever the model actually produced. The page's
 * `{isUltimate && ...}` conditionals still exist and are still correct; they
 * are now presentation, as they should always have been, rather than the only
 * thing standing between a Free account and a paid field.
 */
export function redactForTier(
  analysis: StatementAnalysis,
  tier: string | null | undefined
): StatementAnalysis {
  const keepSuggestions = canSeeSuggestions(tier)
  const keepSentences = canSeeSentenceAnalysis(tier)
  if (keepSuggestions && keepSentences) return analysis

  const categories = keepSuggestions
    ? analysis.categories
    : analysis.categories.map(({ suggestion: _dropped, ...rest }) => rest)

  const { sentenceAnalysis, ...rest } = analysis
  return {
    ...rest,
    categories,
    ...(keepSentences && sentenceAnalysis ? { sentenceAnalysis } : {}),
  }
}

// ---------------------------------------------------------------------------
// Review notes for the rewrite
// ---------------------------------------------------------------------------

/**
 * The analysis flattened into the labelled lines a rewrite may see.
 *
 * Built from the VALIDATED analysis, so every line is already bounded and
 * stripped. This is the only route by which any part of an analysis reaches a
 * model prompt, and it produces a fixed set of label/detail pairs -- there is
 * no shape a caller can supply that turns into anything else.
 */
export function reviewNotesFrom(analysis: StatementAnalysis): ReviewNote[] {
  const notes: ReviewNote[] = []

  for (const category of analysis.categories) {
    const detail = category.suggestion ?? category.feedback
    notes.push({ label: `${category.name} (scored ${category.score}/10)`, detail })
  }
  for (const change of analysis.topChanges) {
    notes.push({ label: 'Priority change', detail: change })
  }
  for (const weakness of analysis.biggestWeaknesses) {
    notes.push({ label: 'Weakness', detail: weakness })
  }
  for (const sentence of analysis.sentenceAnalysis ?? []) {
    if (sentence.label === 'Strong') continue
    notes.push({
      label: `${sentence.label} sentence`,
      detail: `"${sentence.original}" could read as "${sentence.improved}"`,
    })
  }

  return notes
}
