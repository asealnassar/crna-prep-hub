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
  /** Another request for this exact draft and text is already in flight. */
  alreadyRunning:
    'An analysis of this draft is already running. Wait for it to finish — you do not need to '
    + 'start another.',
  /** The applicant's plan does not include analysis. */
  needsUltimate: 'AI analysis of your personal statement is included with Ultimate.',
  /** The capability is switched off. Not the applicant's doing, and not retryable by them. */
  storageUnavailable:
    'AI analysis is not available yet. Nothing has been charged, and your draft is saved.',
  /** The session is gone. Signing in again is the fix, not retrying. */
  signedOut: 'Your session has expired. Sign in again to analyze this draft.',
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

/**
 * Every code the analyse route can intentionally answer with, and what the
 * applicant is told for each.
 *
 * ---------------------------------------------------------------------------
 * EXHAUSTIVE, AND A TEST ENFORCES THAT
 * ---------------------------------------------------------------------------
 * The route answers with nine codes; this mapped six, and the three it missed
 * fell through to the generic "could not be completed. Please try again."
 * marked retryable. Two of those were actively wrong:
 *
 *   `already-running` is reachable in ordinary use -- a second tab -- and the
 *   advice given was the one thing certain to fail again.
 *   `analysis-requires-ultimate` turned a clear upsell into an apparent bug.
 *
 * AI-QA-003. reviewClient.test.ts now derives the route's codes from its
 * source and fails if any is unmapped, so adding a tenth breaks a test rather
 * than reaching an applicant as a shrug.
 *
 * `retryable` ANSWERS ONE QUESTION: would trying again, unchanged, behave
 * differently? Not "may the applicant ever try again" -- a plan upgrade or a
 * finished analysis changes the answer, and the interface offers those
 * separately.
 */
interface Refusal {
  readonly message: string
  readonly retryable: boolean
}

const CODE_REFUSALS: Readonly<Record<string, Refusal>> = {
  // The draft itself is not ready. Writing more changes it; retrying does not.
  'too-short': { message: REVIEW_MESSAGES.tooShort, retryable: false },
  'prompt-too-short': { message: REVIEW_MESSAGES.promptTooShort, retryable: false },
  // Waiting changes it, and the message says to wait.
  'too-many-requests': { message: REVIEW_MESSAGES.rateLimited, retryable: true },
  // ONE IS ALREADY RUNNING. Retrying now returns here again; the applicant is
  // told to wait rather than invited to collide with their own request.
  'already-running': { message: REVIEW_MESSAGES.alreadyRunning, retryable: false },
  // The plan is the blocker. Retrying is pointless; upgrading is not retrying.
  'analysis-requires-ultimate': { message: REVIEW_MESSAGES.needsUltimate, retryable: false },
  // Switched off. Nothing the applicant does now changes it.
  'analysis-storage-unavailable': { message: REVIEW_MESSAGES.storageUnavailable, retryable: false },
  // The model answered unusably. A second attempt may well succeed.
  malformed: { message: REVIEW_MESSAGES.malformed, retryable: true },
  // Upstream or configuration failure.
  unavailable: { message: REVIEW_MESSAGES.unavailable, retryable: true },
  // The draft is not visible to this caller, which includes "not theirs".
  'not-found': { message: REVIEW_MESSAGES.unavailableDraft, retryable: true },
}

/** Exported so a test can prove the mapping covers the route. */
export const ANALYSIS_REFUSAL_CODES: readonly string[] = Object.keys(CODE_REFUSALS)

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
  if (typeof code === 'string' && code in CODE_REFUSALS) {
    const refusal = CODE_REFUSALS[code]!
    return { type: 'refused', message: refusal.message, retryable: refusal.retryable }
  }

  /*
    NO CODE WE RECOGNISE. The studio gate answers 401 and 404 with its own
    bodies, which carry no analysis code, so those are read from the status.
    401 is a lost session and says so -- "reload and try again" is what it used
    to say, and reloading a signed-out page does not help.
  */
  if (status === 401) {
    return { type: 'refused', message: REVIEW_MESSAGES.signedOut, retryable: false }
  }
  if (status === 404) {
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
