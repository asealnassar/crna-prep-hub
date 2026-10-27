import { fabricatedQuotes, isEssayExcerpt } from './evidence.ts'
import {
  CATEGORY_IDS,
  RUBRIC_VERSION,
  bandFor,
  categoriesFor,
  isCategoryId,
  isValidScore,
  overallScore,
  type Band,
  type CategoryId,
} from './rubric.ts'

/**
 * What the analyser returns, and the only thing the browser is ever shown.
 *
 * EVERY FIELD IS VALIDATED BEFORE IT LEAVES THE SERVER. A language model is
 * asked for a particular shape and usually produces it; "usually" is not a
 * contract, so nothing here is believed. A result that does not parse is a
 * failure reported as a failure -- never a partial score, never a filled-in
 * default, and never a successful-looking card over missing data.
 *
 * THE NUMBERS ARE NOT THE MODEL'S. Scores are, because judging the writing is
 * what it is for. The BAND and the OVERALL PERCENTAGE are computed here from
 * those scores, so a model cannot report a total that disagrees with its own
 * parts -- the easiest mistake for it to make and the hardest for a reader to
 * catch.
 *
 * ITS OWN CONSTANTS, NOT THE LEGACY ANALYSER'S. lib/statement/analysis.ts has
 * similar caps, and this module deliberately does not import them: the two
 * instruments are separate, and a change to one must not silently move the
 * other's limits.
 */

/** Bumped whenever this shape changes. Carried on every result. */
export const REVIEW_SCHEMA_VERSION = 'statement-review-v2'

/** Caps on model-produced prose. Long enough to be useful, bounded to be safe. */
export const MAX_REVIEW_FIELD_CHARS = 1_200
export const MAX_REVIEW_LIST_ITEMS = 6

/**
 * One requirement a school's prompt states, and whether the essay meets it.
 *
 * WHY THIS IS STRUCTURED RATHER THAN PROSE. A prompt asking for professional
 * goals, past experience and expected contribution is three requirements, and
 * an essay can satisfy two of them completely. Left to prose, a model will
 * quote one sentence and assert that "the prompt is addressed" -- which is how
 * a 10/10 was produced for an essay that never said what it would contribute.
 * Enumerating them forces the judgement to be made per requirement, and lets
 * the validator refuse a top score that its own breakdown contradicts.
 *
 * THE COMPONENTS COME FROM THE PROMPT, NOT FROM A LIST THIS PRODUCT KEEPS.
 * Nothing here knows what any school asks for; the model reads the saved
 * snapshot and reports what it finds there. A requirement this product invented
 * would be a requirement the applicant is scored against for no reason.
 */
export type ComponentStatus = 'addressed' | 'weak' | 'missing'

export interface PromptComponent {
  /** The requirement, in the prompt's own terms. */
  readonly component: string
  readonly status: ComponentStatus
  /** The passage that satisfies it, or a statement that none does. */
  readonly evidence: string
}

export const COMPONENT_STATUSES: readonly ComponentStatus[] = ['addressed', 'weak', 'missing']

/** One category's verdict, as the browser receives it. */
export interface CategoryReview {
  readonly id: CategoryId
  readonly score: number
  /** Derived from the score here, never read from the model. */
  readonly band: Band
  /**
   * A quotation from the applicant's own essay, or a plain statement that the
   * category's material is absent. PROSE: it is what the card shows, and it
   * carries no verification burden -- see `excerpt`.
   */
  readonly evidence: string
  /**
   * The exact passage the score rests on, or null when the material is absent.
   *
   * ---------------------------------------------------------------------------
   * THE FIELD THAT MAKES EVIDENCE PROVABLE
   * ---------------------------------------------------------------------------
   * `evidenceFound: true` used to be an unchecked assertion. The only
   * verification was a scan for quotation marks in `evidence`, so a model that
   * claimed evidence and then described it in plain prose -- "Your essay
   * contains strong material for this category" -- was believed at any score.
   * That produced a validated 90/100 with six Strong bands over an essay
   * nothing had been quoted from. AI-QA-002.
   *
   * So the excerpt is its own field and the validator proves it: when
   * `evidenceFound` is true this must be a contiguous verbatim span of the
   * submitted essay, at least MIN_VERIFIABLE_QUOTE_CHARS long, matched after
   * harmless normalisation only. When `evidenceFound` is false it must be
   * null, because there is nothing to excerpt and a span supplied anyway is a
   * contradiction rather than a detail.
   */
  readonly excerpt: string | null
  /**
   * MISSING IS NOT THE SAME AS WEAK, and the interface says which. "You did not
   * describe any clinical experience" and "your clinical example is thin" lead
   * to different next actions, and collapsing them into one low score tells an
   * applicant nothing about which they are.
   */
  readonly evidenceFound: boolean
  readonly explanation: string
  readonly recommendation: string
  /**
   * Present on prompt-alignment only: one entry per requirement the prompt
   * states. Empty for every other category.
   */
  readonly components: readonly PromptComponent[]
}

export interface StatementReview {
  readonly schemaVersion: string
  readonly rubricVersion: string
  readonly promptAttached: boolean
  /** Weighted, computed, 0-100. */
  readonly overall: number
  readonly categories: readonly CategoryReview[]
  readonly overallAssessment: string
  readonly strengths: readonly string[]
  readonly priorities: readonly string[]
  readonly nextSteps: readonly string[]
}

export type ReviewFailure =
  | 'not-an-object'
  | 'categories-not-a-list'
  | 'wrong-category-set'
  | 'duplicate-category'
  | 'unknown-category'
  | 'invalid-score'
  | 'missing-text'
  | 'missing-summary'
  | 'unscorable'
  | 'missing-components'
  | 'inconsistent-score'
  | 'fabricated-quote'
  /** `evidenceFound` was true with no excerpt, or one not in the essay. */
  | 'unverifiable-evidence'
  /** `evidenceFound` was false, but an excerpt was supplied anyway. */
  | 'contradictory-evidence'

export type ReviewParse =
  | { readonly ok: true; readonly review: StatementReview }
  | { readonly ok: false; readonly reason: ReviewFailure }

function field(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Control characters are stripped rather than refused: a stray newline in a
  // quotation is not a reason to throw an applicant's analysis away.
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (cleaned.length === 0) return null
  return cleaned.length > MAX_REVIEW_FIELD_CHARS
    ? cleaned.slice(0, MAX_REVIEW_FIELD_CHARS)
    : cleaned
}

function list(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const items: string[] = []
  for (const entry of value) {
    const text = field(entry)
    if (text !== null) items.push(text)
    if (items.length === MAX_REVIEW_LIST_ITEMS) break
  }
  return items
}

/**
 * One model response as a result, or the first reason it is not one.
 *
 * THE CATEGORY SET MUST MATCH EXACTLY. Not a superset, not a subset, and no
 * duplicates: a general statement that came back with a prompt-alignment score
 * means the model was told one thing and did another, and the right response to
 * that is to refuse the result rather than to drop the extra entry and carry on
 * as though the instruction had been followed.
 *
 * ANY `overall`, `total` OR `score` AT THE TOP LEVEL IS IGNORED. It is not read,
 * not compared and not reported -- the percentage is computed from the
 * categories by rubric.ts.
 */
export function parseReview(input: {
  readonly raw: unknown
  readonly promptAttached: boolean
  /**
   * The essay that was analysed, for verifying quotations.
   *
   * OPTIONAL SO THE SAMPLE BUILDER CAN OMIT IT. The route always passes it;
   * reviewSample.ts does not, because its evidence quotes an essay that does
   * not exist. Omitting it skips quotation verification and nothing else.
   */
  readonly essay?: string
}): ReviewParse {
  const { raw, promptAttached } = input
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not-an-object' }
  const body = raw as Record<string, unknown>

  if (!Array.isArray(body.categories)) return { ok: false, reason: 'categories-not-a-list' }

  const expected = categoriesFor(promptAttached).map((category) => category.id)
  const seen = new Set<CategoryId>()
  const categories: CategoryReview[] = []
  const scores = new Map<CategoryId, number>()

  for (const entry of body.categories) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, reason: 'not-an-object' }
    const row = entry as Record<string, unknown>

    if (!isCategoryId(row.id)) return { ok: false, reason: 'unknown-category' }
    // A category the rubric knows but this draft is not scored on.
    if (!expected.includes(row.id)) return { ok: false, reason: 'wrong-category-set' }
    if (seen.has(row.id)) return { ok: false, reason: 'duplicate-category' }
    seen.add(row.id)

    // Rejects 4, every non-integer and everything outside 1-10. No remapping.
    if (!isValidScore(row.score)) return { ok: false, reason: 'invalid-score' }
    const band = bandFor(row.score)
    if (band === null) return { ok: false, reason: 'invalid-score' }

    const evidence = field(row.evidence)
    const explanation = field(row.explanation)
    const recommendation = field(row.recommendation)
    if (evidence === null || explanation === null || recommendation === null) {
      return { ok: false, reason: 'missing-text' }
    }

    // THE PROMPT'S REQUIREMENTS, one entry each. Required for prompt alignment
    // and ignored everywhere else, so no other category can smuggle one in.
    const components: PromptComponent[] = []
    if (row.id === 'prompt-alignment') {
      if (!Array.isArray(row.components) || row.components.length === 0) {
        return { ok: false, reason: 'missing-components' }
      }
      for (const entry of row.components) {
        if (typeof entry !== 'object' || entry === null) {
          return { ok: false, reason: 'missing-components' }
        }
        const part = entry as Record<string, unknown>
        const name = field(part.component)
        const detail = field(part.evidence)
        const status = part.status
        if (
          name === null || detail === null
          || typeof status !== 'string'
          || !(COMPONENT_STATUSES as readonly string[]).includes(status)
        ) {
          return { ok: false, reason: 'missing-components' }
        }
        components.push({ component: name, status: status as ComponentStatus, evidence: detail })
      }

      // A TOP SCORE CANNOT CONTRADICT ITS OWN BREAKDOWN. 10/10 means the essay
      // covers what the prompt asked for; a requirement the model marked
      // missing or weak says it does not. Refusing is not capping the score --
      // the model is free to justify a 10 -- it is refusing output that
      // disagrees with itself.
      if (row.score === 10 && components.some((c) => c.status !== 'addressed')) {
        return { ok: false, reason: 'inconsistent-score' }
      }
    }

    // STRONG MEANS THE MATERIAL IS THERE. A category in the 8-10 band whose own
    // evidence says the material is absent is the contradiction that produced
    // "9/10, but you never describe a patient encounter". A low score with
    // absent material is coherent; a high one is not.
    if (row.evidenceFound !== true && row.score >= 8) {
      return { ok: false, reason: 'inconsistent-score' }
    }

    /*
      EVIDENCE CLAIMED AS PRESENT MUST BE PROVABLY PRESENT. AI-QA-002.

      `evidenceFound` was previously an assertion nothing checked unless the
      model happened to use quotation marks, so prose like "Your essay
      contains strong material for this category" passed at any score. The
      claim now lives in `excerpt`, which is verified against the submitted
      essay as a contiguous verbatim span.

      WITHOUT THE ESSAY, THE CLAIM CANNOT BE PROVED, SO IT IS NOT BELIEVED.
      reviewSample.ts omits the essay on purpose -- its specimen quotes an
      essay that does not exist -- so for that one caller the excerpt is
      carried as given and the shape is still enforced. The route ALWAYS
      passes the essay; a test asserts that.
    */
    const excerptRaw = row.excerpt
    const excerpt = typeof excerptRaw === 'string' ? field(excerptRaw) : null
    if (row.evidenceFound === true) {
      if (excerpt === null) return { ok: false, reason: 'unverifiable-evidence' }
      if (typeof input.essay === 'string'
          && !isEssayExcerpt({ excerpt, essay: input.essay })) {
        return { ok: false, reason: 'unverifiable-evidence' }
      }
    } else if (excerpt !== null) {
      // NOTHING TO EXCERPT, AND YET ONE ARRIVED. A model describing an absence
      // while handing over a passage is contradicting itself, and the passage
      // is the half more likely to be invented.
      return { ok: false, reason: 'contradictory-evidence' }
    }

    // AND A QUOTATION ANYWHERE IN THE PROSE MUST STILL BE THE APPLICANT'S.
    // Checked in BOTH states now: an absence described with an invented
    // quotation inside it is exactly as misleading as a present one.
    if (typeof input.essay === 'string') {
      for (const prose of [evidence, explanation, recommendation]) {
        if (fabricatedQuotes({ evidence: prose, essay: input.essay }).length > 0) {
          return { ok: false, reason: 'fabricated-quote' }
        }
      }
    }

    categories.push({
      id: row.id,
      score: row.score,
      band,
      evidence,
      excerpt,
      // Absent unless the model says so explicitly. Defaulting to "found" would
      // let a missing quotation read as present-but-weak.
      evidenceFound: row.evidenceFound === true,
      explanation,
      recommendation,
      components,
    })
    scores.set(row.id, row.score)
  }

  if (categories.length !== expected.length) return { ok: false, reason: 'wrong-category-set' }

  const overallAssessment = field(body.overallAssessment)
  if (overallAssessment === null) return { ok: false, reason: 'missing-summary' }

  const strengths = list(body.strengths)
  const priorities = list(body.priorities)
  const nextSteps = list(body.nextSteps)
  if (strengths.length === 0 || priorities.length === 0 || nextSteps.length === 0) {
    return { ok: false, reason: 'missing-summary' }
  }

  // Computed, never read. Null here would mean a category slipped through the
  // loop above, which the length check should already have caught.
  const overall = overallScore({ scores, promptAttached })
  if (overall === null) return { ok: false, reason: 'unscorable' }

  // DISPLAY ORDER IS THE RUBRIC'S, not the order the model happened to emit.
  const ordered = CATEGORY_IDS
    .map((id) => categories.find((category) => category.id === id))
    .filter((category): category is CategoryReview => category !== undefined)

  return {
    ok: true,
    review: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      rubricVersion: RUBRIC_VERSION,
      promptAttached,
      overall,
      categories: ordered,
      overallAssessment,
      strengths,
      priorities,
      nextSteps,
    },
  }
}

// ---------------------------------------------------------------------------
// Binding a result to what was actually analysed
// ---------------------------------------------------------------------------

/**
 * A result, and exactly which draft it is about.
 *
 * THE SERVER ANALYSES THE SAVED DRAFT, not whatever is on screen. It reads the
 * row with the caller's own client, so what was judged is the text that had
 * reached the database -- which is the honest thing to analyse, and which can
 * be older than the editor if autosave has not flushed.
 */
export interface BoundReview {
  readonly review: StatementReview
  /** The revision the server read. */
  readonly revision: number
  /** Words in the text the server actually analysed. */
  readonly words: number
  readonly overLimit: boolean
  readonly statedMaxWords: number | null
}

/**
 * Whether a result has stopped describing what is on screen.
 *
 * TWO WAYS IT CAN GO STALE, and both are checked because they catch different
 * things:
 *
 *   THE REVISION MOVED. Another save landed -- possibly from another tab --
 *   so the analysed text is no longer the stored text.
 *   THE ESSAY CHANGED. The applicant kept typing while the request was in
 *   flight. The revision may not have moved yet, and the result is already
 *   about something they have edited past.
 *
 * STALE IS NOT WRONG, and the interface must not treat it as an error. The
 * feedback was accurate about the revision it names; it simply is not about the
 * current one, so it is labelled rather than discarded, and a fresh analysis is
 * offered rather than forced.
 */
export function reviewIsStale(input: {
  readonly analyzedRevision: number
  readonly analyzedEssay: string
  readonly currentRevision: number
  readonly currentEssay: string
}): boolean {
  if (input.analyzedRevision !== input.currentRevision) return true
  return input.analyzedEssay !== input.currentEssay
}

// ---------------------------------------------------------------------------
// AI-QA-004: the shape the model is shown is GENERATED from this module
// ---------------------------------------------------------------------------

/**
 * The response shape, as the system prompt shows it to the model.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS GENERATED AND NOT TYPED OUT IN THE PROMPT
 * ---------------------------------------------------------------------------
 * The prompt ended with "Reply with JSON only, in exactly this shape:" and a
 * literal object -- and that object omitted `components`, which this validator
 * REQUIRES on prompt-alignment. A model following the example exactly produced
 * a response the server refused, so every school-specific analysis was one
 * `missing-components` away from "the analysis came back in a form we could not
 * read", and each attempt still spent a slice of the applicant's burst
 * allowance. AI-QA-004.
 *
 * Two hand-maintained descriptions of one shape will drift; the only question
 * is when. So there is now ONE description, here, beside the parser that
 * enforces it, and the prompt renders it. A field added to the validator and
 * not to this example shows up as a failing test rather than as a 502 an
 * applicant sees.
 *
 * IT IS A SHAPE, NOT A SPECIMEN. The values are placeholders that say what
 * belongs in each field; a test proves the shape round-trips through
 * parseReview() by substituting real values into it, which is what makes the
 * example and the validator provably the same contract.
 */
export function reviewResponseShape(promptAttached: boolean): string {
  const category = (id: string, extra = '') =>
    `    {\n`
    + `      "id": "${id}",\n`
    + `      "score": <one of 1,2,3,5,6,7,8,9,10>,\n`
    + `      "evidenceFound": <true if you are quoting the essay, false if the material is absent>,\n`
    + `      "excerpt": <the exact passage from the essay, word for word, when evidenceFound is true; null when it is false>,\n`
    + `      "evidence": "<what that passage shows, or a plain statement that the material is absent>",\n`
    + `      "explanation": "<why this score, referring to what is actually written>",\n`
    + `      "recommendation": "<one concrete thing to do next>"${extra}\n`
    + `    }`

  const components =
    `,\n      "components": [\n`
    + `        {\n`
    + `          "component": "<one requirement, in the prompt's own words>",\n`
    + `          "status": "<${COMPONENT_STATUSES.join(' | ')}>",\n`
    + `          "evidence": "<the passage that satisfies it, or a statement that none does>"\n`
    + `        }\n`
    + `      ]`

  const rows = categoriesFor(promptAttached).map((entry) =>
    entry.id === 'prompt-alignment' ? category(entry.id, components) : category(entry.id))

  return `{\n  "categories": [\n${rows.join(',\n')}\n  ],\n`
    + `  "overallAssessment": "<two or three sentences>",\n`
    + `  "strengths": ["<short phrase>"],\n`
    + `  "priorities": ["<short phrase>"],\n`
    + `  "nextSteps": ["<short phrase>"]\n}`
}

/**
 * The same shape as DATA, for tests and fixtures.
 *
 * ONE SOURCE FOR THE MOCKS TOO. A fixture hand-written to match the prompt is a
 * third copy of the contract, and the one most likely to be forgotten; the
 * end-to-end suites build theirs from here instead.
 */
export function reviewResponseSpecimen(input: {
  readonly promptAttached: boolean
  readonly excerpt: string
  readonly score?: number
  readonly components?: readonly string[]
}): Record<string, unknown> {
  const score = input.score ?? 7
  return {
    categories: categoriesFor(input.promptAttached).map((entry) => ({
      id: entry.id,
      score,
      evidenceFound: true,
      excerpt: input.excerpt,
      evidence: 'What that passage shows about this category.',
      explanation: `Scored ${score} on the strength of that passage and what it stops short of.`,
      recommendation: 'Name the outcome of the case you describe in that paragraph.',
      ...(entry.id === 'prompt-alignment'
        ? {
          components: (input.components ?? ['The school’s question']).map((component) => ({
            component, status: 'addressed' as const, evidence: input.excerpt,
          })),
        }
        : {}),
    })),
    overallAssessment: 'A specific draft that stops short of its own conclusions.',
    strengths: ['Concrete clinical detail'],
    priorities: ['Say what changed for the patient'],
    nextSteps: ['Revise the second paragraph'],
  }
}
