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
/**
 * What a developer running the REAL analyser against localhost is told.
 *
 * TWO SENTENCES, TWO JOBS. The notice sits with the result and says where it
 * came from; the warning sits with the button and says what pressing it costs.
 * Both are development-only -- the server decides whether they are shown and
 * passes a boolean, because a notice the browser could turn on would be a
 * statement about what the client was told rather than about the mode.
 *
 * THE FEEDBACK ITSELF IS NEVER STAMPED. It is the model's own output after
 * production validation, and a prefix inside it would be a change to the thing
 * being evaluated.
 */
export const LOCAL_REAL_AI_NOTICE =
  'LOCAL REAL AI TEST — This analysis uses the real AI model but is not written '
  + 'to production.'

export const LOCAL_REAL_AI_WARNING =
  'Analyzing makes a real, paid OpenAI request. The result is stored locally '
  + 'only; production records nothing.'

export const ANALYSIS_NO_CACHE_NOTICE =
  'Development mode: results are not stored, so every analysis is a new request.'

// ---------------------------------------------------------------------------
// What the applicant-facing surfaces may claim about analysis
// ---------------------------------------------------------------------------

/**
 * Whether analysis is offered, withheld by plan, or switched off.
 *
 * ONE DERIVATION FOR THREE SURFACES. WK-QA-001: the editor banner, the library
 * notice and the library feature card each hardcoded that the analyser did not
 * exist -- "not built yet", "not available yet", "Coming soon." -- and that
 * claim outlived the analyser being built. The authenticated WebKit pass found
 * the editor telling an applicant the feature was not built directly above a
 * rendered seven-category analysis. Because each sentence was a literal, no
 * capability flag could correct it, and all three were guaranteed to be wrong
 * the moment analysis was enabled.
 *
 * NOT A SECOND READING OF THE ENVIRONMENT. The two inputs are exactly the facts
 * the route gates on -- canAnalyzeStatement() for the plan and
 * analysisAvailability() for the capability -- resolved on the server and handed
 * down as props. Nothing here touches process.env, so the interface cannot come
 * to a different conclusion than the route about whether analysis can happen.
 *
 * CAPABILITY OUTRANKS PLAN FOR THIS ONE QUESTION. When analysis is switched off
 * for everybody, naming the plan that includes it would advertise something
 * nobody can currently run. This does not change the analysis panel's own
 * ordering: that answers "may THIS viewer analyse", which is a different
 * question with a different right answer.
 */
export type AnalysisOffer = 'offered' | 'needs-plan' | 'unavailable'

export function analysisOffer(input: {
  readonly allowed: boolean
  readonly availability: AnalysisAvailability
}): AnalysisOffer {
  if (input.availability === 'unavailable') return 'unavailable'
  return input.allowed ? 'offered' : 'needs-plan'
}

/**
 * The editor's internal-preview banner.
 *
 * NEVER CLAIMS THE FEATURE DOES NOT EXIST. 'unavailable' says analysis is off
 * right now, which is both true and reversible; "not built yet" made a claim
 * about the product that stopped being true and could not be unsaid by a flag.
 */
export const ANALYSIS_PREVIEW_NOTICE: Readonly<Record<AnalysisOffer, string>> = {
  offered: 'Drafting, document import and AI analysis are available.',
  'needs-plan':
    'Drafting and document import are available. AI analysis is included with Ultimate.',
  unavailable:
    'Drafting and document import are available. AI analysis is currently unavailable.',
}

/** The library's equivalent notice, which also names who can see the page. */
export const ANALYSIS_LIBRARY_NOTICE: Readonly<Record<AnalysisOffer, string>> = {
  offered:
    'Visible to administrators only. Drafting, document upload and AI analysis are live.',
  'needs-plan':
    'Visible to administrators only. Drafting and document upload are live; AI analysis is included with Ultimate.',
  unavailable:
    'Visible to administrators only. Drafting and document upload are live; AI analysis is currently unavailable.',
}

/**
 * The third step on the library's explainer, and whether its tile reads as live.
 *
 * `live` is false ONLY when the capability is off, because that is the one state
 * in which nobody can reach the step. A viewer on the wrong plan is looking at a
 * feature that exists and works, so muting it would repeat the original lie in
 * styling instead of words.
 */
export const ANALYSIS_STEP_BODY: Readonly<Record<AnalysisOffer, string>> = {
  offered: 'Get personalized AI feedback to strengthen your statement.',
  'needs-plan':
    'Get personalized AI feedback to strengthen your statement, included with Ultimate.',
  unavailable:
    'Get personalized AI feedback to strengthen your statement. Currently unavailable.',
}

export const analysisStepIsLive = (offer: AnalysisOffer): boolean => offer !== 'unavailable'
