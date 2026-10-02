import { normaliseTier, type RateWindow } from '../../resume/entitlement.ts'

/**
 * Who may run a Statement Studio V2 analysis, what it may cost them, and what
 * the editor should offer.
 *
 * BROWSER-SAFE BY CONSTRUCTION. StatementStudioClient.tsx imports this, so
 * everything here is pure TypeScript -- no node: builtin, no database client,
 * no filesystem. The one piece that needs node:crypto lives next door in
 * analysisFingerprint.ts and is imported only by the server.
 */

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Ultimate only.
 *
 * NORMALISED FIRST, AND THE DEFAULT IS 'free'. normaliseTier treats anything it
 * does not recognise -- a null, a typo, a tier added later -- as the lowest
 * plan, so a value this code has never seen cannot become access. An error is
 * never a way up.
 *
 * THIS IS NOT THE ONLY GATE AND IS NOT MEANT TO BE. The route checks it on the
 * server before any model call; the editor checks it to decide what to show.
 * Hiding a button is a courtesy, and the server is the control.
 */
export function canAnalyzeStatement(tier: string | null | undefined): boolean {
  return normaliseTier(tier) === 'ultimate'
}

/** A refusal code the browser keys on. Deliberately distinct from a rate limit. */
export const ANALYSIS_TIER_CODE = 'analysis-requires-ultimate'

/**
 * What a Free or Premium member is told.
 *
 * It names the plan and nothing else: no price, no link, no comparison. The
 * pricing page owns all of that, and duplicating it here would be a second
 * place for it to go out of date.
 */
export const ANALYSIS_TIER_MESSAGE =
  'AI analysis of your personal statement is included with Ultimate.'

// ---------------------------------------------------------------------------
// Whether this exact analysis has already been done
// ---------------------------------------------------------------------------

/**
 * THE FINGERPRINT LIVES IN analysisFingerprint.ts, NOT HERE, and the move was
 * not tidying.
 *
 * This module is imported by StatementStudioClient.tsx, and a client component
 * pulls its whole import graph into the browser bundle. The fingerprint needs
 * node:crypto; one such import at the top of this file made Webpack try to
 * resolve a `node:` scheme it has no loader for, and the editor stopped
 * building. Everything that remains here is pure TypeScript with no Node
 * dependency, so it is safe on both sides.
 *
 * Nothing is lost by the split: the fingerprint is computed from the SAVED
 * draft and compared against stored rows, both of which only the server has.
 */

/**
 * What the editor should offer, given what is stored.
 *
 * 'view'     an analysis of exactly this essay and prompt already exists.
 * 'analyze'  nothing has been analysed yet.
 * 'reanalyze' something was analysed, but the essay or the prompt has moved on.
 */
export type AnalysisAction = 'view' | 'analyze' | 'reanalyze'

export function analysisActionFor(input: {
  readonly storedFingerprint: string | null
  readonly currentFingerprint: string
}): AnalysisAction {
  if (input.storedFingerprint === null) return 'analyze'
  return input.storedFingerprint === input.currentFingerprint ? 'view' : 'reanalyze'
}

export const ANALYSIS_ACTION_LABELS: Readonly<Record<AnalysisAction, string>> = {
  view: 'View previous analysis',
  analyze: 'Analyze this draft',
  reanalyze: 'Analyze updated draft',
}

// ---------------------------------------------------------------------------
// How often, rather than how many
// ---------------------------------------------------------------------------

/**
 * The windows a V2 analysis is judged against.
 *
 * NO DAILY CEILING, AND THAT ABSENCE IS THE POINT. Ultimate is sold as
 * unlimited analysis of changed essays, and a 60-a-day cap is a fixed
 * allowance by another name -- an applicant rewriting a statement over a long
 * evening would meet it and be told to come back tomorrow, which is not what
 * they bought.
 *
 * WHAT REMAINS IS BURST PROTECTION. Five a minute and twenty an hour bound a
 * script, a stuck retry loop and a held-down button; they do not bound a
 * person. Twenty genuinely different essays in an hour is far beyond anything
 * a human drafting a personal statement does, and an unchanged essay costs
 * nothing at all once the cache is on -- so these ceilings only ever meet work
 * that is genuinely new.
 *
 * SEPARATE FROM THE LEGACY ANALYSER'S, deliberately. STATEMENT_RATE_LIMITS
 * still governs /api/analyze-statement, daily cap included; nothing here
 * changes what that feature allows.
 */
export const V2_ANALYSIS_RATE_LIMITS: readonly RateWindow[] = [
  { windowMs: 60_000, max: 5 },
  { windowMs: 60 * 60_000, max: 20 },
]

// ---------------------------------------------------------------------------
// Whether analysis can be offered at all
// ---------------------------------------------------------------------------

/**
 * What the analyser can honestly do right now.
 *
 * 'ready'                  storage exists; identical work is never paid for twice.
 * 'development-no-cache'   no storage, but this is a developer's machine. Every
 *                          request is a fresh paid call and the interface says so.
 * 'unavailable'            no storage, anywhere else. Refused.
 *
 * WHY 'unavailable' RATHER THAN "JUST CALL OPENAI AGAIN". Without storage there
 * is no way to know whether this exact essay has already been analysed, so
 * every reopen, refresh and second tab is another charge for work already done
 * -- silently, because nothing in the interface would say so. Failing closed is
 * the honest answer: the feature is off until the thing that makes it
 * affordable exists.
 *
 * THE DEVELOPMENT PATH IS NOT A FALLBACK. It is reachable only when NODE_ENV is
 * exactly 'development', read from the process, so a deployed build cannot
 * enter it however it is configured -- and it is labelled wherever it appears.
 */
export type AnalysisAvailability = 'ready' | 'development-no-cache' | 'unavailable'

export function analysisAvailability(input: {
  readonly cacheEnabled: boolean
  readonly nodeEnv: string | undefined
}): AnalysisAvailability {
  if (input.cacheEnabled === true) return 'ready'
  return input.nodeEnv === 'development' ? 'development-no-cache' : 'unavailable'
}

export const ANALYSIS_UNAVAILABLE_CODE = 'analysis-storage-unavailable'

export const ANALYSIS_UNAVAILABLE_MESSAGE =
  'AI analysis is temporarily unavailable. Nothing has been charged.'

/**
 * What a developer is told while running without storage.
 *
 * It promises nothing about deduplication, because there is none: this path
 * cannot tell whether an identical essay was analysed a minute ago.
 */
export const ANALYSIS_NO_CACHE_NOTICE =
  'Development mode: results are not stored, so every analysis is a new request.'
