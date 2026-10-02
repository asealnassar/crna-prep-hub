import type { StatementReview } from './reviewSchema.ts'
import type { PromptOrigin } from './promptSubmission.ts'

/**
 * Asking for an analysis, and reading what comes back.
 *
 * SAME ARRANGEMENT AS library.ts AND save.ts: the editor is a client component
 * node --test cannot import, so the rules worth testing -- what is sent, what
 * each status means, what a reader is told -- live here, and the component is
 * the wiring that calls them.
 *
 * EVERY MESSAGE A READER CAN SEE IS CHOSEN HERE. The route answers with fixed
 * strings of its own and this module does not render them: it keys on `code`
 * and looks the wording up, so neither model prose nor a database message can
 * reach a screen.
 */

/** Where an analysis is requested. The one place this path is spelled out. */
export function analyzePath(draftId: string): string {
  return `/api/statement/drafts/${encodeURIComponent(draftId)}/analyze`
}

export const REVIEW_MESSAGES = {
  /** The draft has not enough words yet. Nothing was charged. */
  tooShort: 'Write a little more and this draft can be analyzed.',
  /** The school's question is too short for the seven-category rubric. */
  promptTooShort:
    'This school asks for a very short answer, which this analysis is not designed for yet.',
  /** The applicant has run several analyses in quick succession. */
  rateLimited: 'You have run several analyses recently. Please wait a moment and try again.',
  /** The model failed, timed out, or is not configured. */
  unavailable: 'The analysis could not be completed. Please try again.',
  /** The model answered in a shape the server would not accept. */
  malformed:
    'The analysis came back in a form we could not read, so nothing is shown. Please try again.',
  /** The session is gone, or the draft is not this applicant's. */
  unavailableDraft: 'That draft could not be analyzed. Reload the page and try again.',
  /** The request never arrived. */
  network: 'Could not reach the server. Please try again.',
  /** The result describes a version the applicant has since edited past. */
  stale:
    'You have edited this draft since this analysis ran, so it describes an earlier version.',
  /** The essay is past the school's stated maximum. Reported, never blocking. */
  overLimit: 'This draft is longer than the school says it should be.',
} as const

/** What a draft's prompt may be called in front of an applicant. */
export const PROVENANCE_LABELS = {
  catalog: 'Approved school prompt',
  user: 'User-provided prompt — not verified by CRNAPREPHUB',
} as const

/**
 * How a prompt is described, and the unverified wording is the DEFAULT.
 *
 * Anything other than a confirmed catalog match reads as user-provided: a
 * prompt whose provenance could not be established is not one this product
 * vouches for, and saying nothing would leave it looking like one that is.
 */
export function provenanceLabel(provenance: PromptOrigin | null): string | null {
  if (provenance === null) return null
  return provenance === 'catalog' ? PROVENANCE_LABELS.catalog : PROVENANCE_LABELS.user
}

/** A completed analysis, and exactly which draft it is about. */
export interface ReviewResult {
  readonly review: StatementReview
  readonly revision: number
  readonly words: number
  readonly overLimit: boolean
  readonly statedMaxWords: number | null
  readonly provenance: PromptOrigin | null
  /** The essay this result describes, captured by the browser when it asked. */
  readonly essay: string
}

export type ReviewOutcome =
  | { readonly type: 'ready'; readonly result: Omit<ReviewResult, 'essay'> }
  | { readonly type: 'refused'; readonly message: string; readonly retryable: boolean }

/** Our own refusal codes, and nothing else, may choose a message. */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  'too-short': REVIEW_MESSAGES.tooShort,
  'prompt-too-short': REVIEW_MESSAGES.promptTooShort,
  'too-many-requests': REVIEW_MESSAGES.rateLimited,
  malformed: REVIEW_MESSAGES.malformed,
  unavailable: REVIEW_MESSAGES.unavailable,
  'not-found': REVIEW_MESSAGES.unavailableDraft,
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

/**
 * One response as an outcome.
 *
 * A 2xx WITHOUT A READABLE REVIEW IS A REFUSAL, not a blank result card. The
 * server validates the model's output before answering, so an unreadable 200
 * means something between here and there changed the body -- and showing an
 * empty analysis would look like a finished one.
 *
 * `retryable` ANSWERS ONE QUESTION: is trying again likely to behave
 * differently? A too-short draft is not retryable until the applicant writes
 * more, and a prompt that is too short never will be. Everything else may be.
 */
export function reviewOutcomeFrom(input: {
  readonly status: number
  readonly body: unknown
}): ReviewOutcome {
  const { status, body } = input

  if (status >= 200 && status < 300) {
    const review = field(body, 'review')
    const revision = field(body, 'revision')
    const words = field(body, 'words')
    if (
      typeof review !== 'object' || review === null
      || typeof revision !== 'number' || !Number.isInteger(revision)
      || typeof words !== 'number' || !Number.isInteger(words)
    ) {
      return { type: 'refused', message: REVIEW_MESSAGES.malformed, retryable: true }
    }
    const statedMaxWords = field(body, 'statedMaxWords')
    const provenance = field(body, 'provenance')
    return {
      type: 'ready',
      result: {
        review: review as StatementReview,
        revision,
        words,
        overLimit: field(body, 'overLimit') === true,
        statedMaxWords: typeof statedMaxWords === 'number' ? statedMaxWords : null,
        provenance: provenance === 'catalog' || provenance === 'user' ? provenance : null,
      },
    }
  }

  const code = field(body, 'code')
  if (typeof code === 'string' && code in CODE_MESSAGES) {
    // Neither of these changes by asking again.
    const retryable = code !== 'too-short' && code !== 'prompt-too-short'
    return { type: 'refused', message: CODE_MESSAGES[code], retryable }
  }

  if (status === 401 || status === 404) {
    return { type: 'refused', message: REVIEW_MESSAGES.unavailableDraft, retryable: true }
  }
  return { type: 'refused', message: REVIEW_MESSAGES.unavailable, retryable: true }
}

/** The request never arrived. Nothing ran, so trying again is safe. */
export const REVIEW_NETWORK_FAILURE: Extract<ReviewOutcome, { type: 'refused' }> = {
  type: 'refused',
  message: REVIEW_MESSAGES.network,
  retryable: true,
}

/**
 * Whether Analyze may fire.
 *
 * NOT THE DUPLICATE GUARD. The editor holds a ref set synchronously before the
 * request, for the same reason the New Draft dialog does: two clicks in one
 * tick would both read the same state. This decides what the button looks like.
 */
export function canAnalyzeNow(input: {
  readonly words: number
  readonly minimumWords: number
  readonly running: boolean
  readonly conflicted: boolean
}): boolean {
  if (input.running !== false) return false
  // A frozen draft is not being analysed: the text on screen is not the stored
  // text, and the server analyses the stored one.
  if (input.conflicted !== false) return false
  return input.words >= input.minimumWords
}
