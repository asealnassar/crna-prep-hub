/**
 * Who gets what in the Personal Statement Analyzer, decided on the server.
 *
 * PHASE 0 CHANGES NOTHING ABOUT WHAT IS SOLD. The tiers below are exactly what
 * the pricing page already advertises -- Free and Premium get the score, the
 * six categories and the feedback; Ultimate adds per-category suggestions,
 * sentence-level feedback and the rewrite. What changes is WHERE that is
 * enforced.
 *
 * THE LEAK THIS CLOSES. The prompt asked for a `suggestion` on every category
 * for every tier, the route returned the whole object, and the page hid the
 * field behind `isUltimate`. The network tab did not. So the one thing the
 * comparison table calls the difference between "Basic" and "Advanced" was
 * being handed to Free users, who were also being charged for the tokens.
 *
 * Now the prompt does not ask for what the tier may not have, AND the response
 * is redacted before it is serialised (lib/statement/analysis.ts). Two layers,
 * because a model that volunteers an unasked-for field must not be able to
 * defeat an entitlement.
 *
 * Pure. Takes a tier string; touches no database, no session and no network.
 */

import { checkAiRate, normaliseTier } from '../resume/entitlement.ts'
import type { RateDecision, RateWindow, Tier } from '../resume/entitlement.ts'

// `normaliseTier` and `checkAiRate` are imported rather than copied: the
// sliding-window algorithm and the "anything unrecognised is Free" rule are
// already proven and tested, and a second implementation of either is a second
// thing to keep in step. Only the WINDOWS below are this feature's own.
export { normaliseTier }
export type { RateDecision, RateWindow, Tier }

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

/** Per-category "here is one specific improvement". Ultimate only. */
export function canSeeSuggestions(tier: string | null | undefined): boolean {
  return normaliseTier(tier) === 'ultimate'
}

/** The 5-7 labelled sentences with improved versions. Ultimate only. */
export function canSeeSentenceAnalysis(tier: string | null | undefined): boolean {
  return normaliseTier(tier) === 'ultimate'
}

/** The whole-statement rewrite. Ultimate only, as it already was. */
export function canRewrite(tier: string | null | undefined): boolean {
  return normaliseTier(tier) === 'ultimate'
}

export const REWRITE_TIER_CODE = 'rewrite-requires-ultimate'
export const REWRITE_TIER_MESSAGE = 'Rewrite feature is Ultimate only'

// ---------------------------------------------------------------------------
// Abuse protection
// ---------------------------------------------------------------------------

/** Deliberately not an entitlement code: a ceiling is not a plan. */
export const RATE_LIMIT_CODE = 'too-many-requests'

/**
 * The invisible ceiling. NOT a quota, and nothing derived from it is shown.
 *
 * TIGHTER THAN THE RESUME BUILDER'S, on purpose. A resume proposal rewrites one
 * bullet; an analysis reads a whole essay and writes ~1,800 tokens of JSON back,
 * which costs an order of magnitude more per call. These windows are sized so
 * somebody genuinely revising an essay never meets them -- five in a minute is
 * faster than anyone reads a page of feedback, and sixty in a day is far past
 * finishing a personal statement -- while a script meets them immediately.
 *
 * The windows are SHARED between analysis and rewrite. They are the same
 * expense against the same account, and separate budgets would just mean two
 * ways to spend.
 */
export const STATEMENT_RATE_LIMITS: readonly RateWindow[] = [
  { windowMs: 60_000, max: 5 },
  { windowMs: 60 * 60_000, max: 20 },
  { windowMs: 24 * 60 * 60_000, max: 60 },
]

/** The longest window the ledger has to be read back over. */
export function statementLedgerWindowMs(
  limits: readonly RateWindow[] = STATEMENT_RATE_LIMITS
): number {
  return limits.reduce((widest, limit) => Math.max(widest, limit.windowMs), 0)
}

/**
 * Whether another call may be made, given when the recent ones happened.
 *
 * A thin, named wrapper so callers state which limits they mean rather than
 * passing the resume builder's by accident.
 */
export function checkStatementRate(
  recent: readonly number[],
  now: number,
  limits: readonly RateWindow[] = STATEMENT_RATE_LIMITS
): RateDecision {
  return checkAiRate(recent, now, limits)
}
