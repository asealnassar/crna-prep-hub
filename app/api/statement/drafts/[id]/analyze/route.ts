import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import type { SupabaseClient } from '@supabase/supabase-js'
import { statementDbClient } from '@/lib/statement/devMode/guardedClient'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import {
  STATEMENT_STUDIO_HIDDEN_BODY, statementStudioAccess, statementStudioMode,
} from '@/lib/statement/studioGate'
import { UNAUTHENTICATED_BODY } from '@/lib/statement/draft/http'
import { isDraftId } from '@/lib/statement/draft/http'
import { readDraft } from '@/lib/statement/draft/draftRepo'
import { wordCount } from '@/lib/statement/draft/editor'
import { eligibilityFor, overLimit } from '@/lib/statement/draft/rubric'
import { parseReview } from '@/lib/statement/draft/reviewSchema'
import { buildReviewUserMessage, reviewSystemPrompt } from '@/lib/statement/draft/reviewPrompt'
import { verifiedProvenance } from '@/lib/statement/draft/submissionRepo'
import {
  STATEMENT_OPERATIONS, recordStatementAttempt, settleStatementUsage, statementRateDecision,
} from '@/lib/statement/usage'
import { RATE_LIMIT_CODE } from '@/lib/statement/entitlement'
import {
  ANALYSIS_TIER_CODE, ANALYSIS_TIER_MESSAGE, ANALYSIS_UNAVAILABLE_CODE,
  ANALYSIS_UNAVAILABLE_MESSAGE, V2_ANALYSIS_RATE_LIMITS, analysisAvailability,
  canAnalyzeStatement,
} from '@/lib/statement/draft/reviewAccess'
// SERVER ONLY: this module imports node:crypto.
import { analysisFingerprint } from '@/lib/statement/draft/analysisFingerprint'
import { parseRequirementSnapshot } from '@/lib/statement/requirements/snapshot'
import {
  FLOOR_UNREACHABLE, eligibilityForRequirement, wordFloorFits,
} from '@/lib/statement/requirements/eligibility'
import { analyzerUnmeasuredKinds } from '@/lib/statement/requirements/constraints'
import { draftProvenance } from '@/lib/statement/requirements/provenance'
import { claimAnalysis, settleAnalysis } from '@/lib/statement/draft/analysisRepo'
import { analysisCacheEnabled } from '@/lib/statement/draft/rollout'
import { beginAnalysis, endAnalysis } from '@/lib/statement/draft/analysisInFlight'
import { simulatedLiveEnabled } from '@/lib/statement/devMode/gate'
import { RUBRIC_VERSION } from '@/lib/statement/draft/rubric'
import { REVIEW_SCHEMA_VERSION } from '@/lib/statement/draft/reviewSchema'

/**
 * Statement Studio V2 analysis. One draft, seven categories, or six.
 *
 * SEPARATE FROM /api/analyze-statement, which is the legacy analyser and is not
 * touched by this file. That one takes an essay in the request body and scores
 * six unweighted categories; this one takes a DRAFT ID and scores the saved row
 * against the V2 rubric. Different inputs, different rubric, different trust
 * model -- and sharing a route would have meant one set of changes governing
 * both.
 *
 * THE BROWSER SUPPLIES AN ID AND NOTHING ELSE. Not the essay, not the prompt,
 * not the school, not the word limit, not the revision. Everything judged is
 * read here with the caller's own client, so RLS decides whose draft this is
 * and a request naming somebody else's draft is a 404 rather than an analysis
 * of it. There is no field in this request that could carry forged prompt
 * provenance, because there is no field.
 *
 * ORDER OF OPERATIONS, and the order is the point:
 *
 *   1. THE STUDIO GATE, before anything else exists.
 *   2. AUTHENTICATION, and the caller-scoped client.
 *   3. THE DRAFT, read under RLS.
 *   4. ELIGIBILITY, which is free. A draft that is too short is refused HERE,
 *      before any usage is recorded -- consuming somebody's allowance to tell
 *      them their essay is too short is not something to get wrong.
 *   5. THE RATE DECISION, then the attempt record.
 *   6. THE MODEL, with an abort timeout inside this function's budget.
 *   7. VALIDATION, and only then a response.
 *
 * NOTHING SENSITIVE IS LOGGED. Not the essay, not the prompt wording, not the
 * model's output, and never an error object -- an OpenAI error echoes the
 * request, and the request contains somebody's personal statement.
 */

export const maxDuration = 60

/** Below maxDuration, so a slow model is a clean refusal rather than a kill. */
const MODEL_TIMEOUT_MS = 50_000

/** The same variable the legacy analyser reads, so one setting moves both. */
const MODEL = process.env.STATEMENT_AI_MODEL || 'gpt-4o'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/** Every answer this route can give. Fixed strings; no model or database prose. */
const MESSAGES = {
  notFound: 'That draft could not be found.',
  tooShort: 'This draft is too short to analyze yet.',
  promptTooShort: 'This school prompt is too short for a full analysis.',
  unavailable: 'Analysis is not available right now. Please try again.',
  rateLimited: 'You have run several analyses recently. Please wait a moment.',
  running: 'An analysis of this draft is already running. Give it a moment.',
  cacheUnavailable: 'Analysis is not available right now. Please try again.',
  malformed: 'The analysis came back in a form we could not read. Nothing was charged.',
} as const

type Caller = { userId: string; tier: string; db: SupabaseClient }

/** Identical in shape to the other Studio endpoints' admit(). */
async function admit(): Promise<Caller | NextResponse> {
  const mode = statementStudioMode()
  const auth = await authenticateRequest()
  const access = statementStudioAccess({
    isAdmin: isAdminEmail(auth?.email),
    isAuthenticated: auth !== null,
    mode,
  })
  if (!access.allowed) {
    const body = access.reason === 'hidden' ? STATEMENT_STUDIO_HIDDEN_BODY : UNAUTHENTICATED_BODY
    return NextResponse.json(body, { status: access.status })
  }
  if (!auth) return NextResponse.json(STATEMENT_STUDIO_HIDDEN_BODY, { status: 404 })

  const token = await readAccessToken()
  if (!token) return NextResponse.json(UNAUTHENTICATED_BODY, { status: 401 })

  // THE VERIFIED SESSION'S OWN ANSWER, passed for simulated-live only: the
  // local stand-in for the submission functions has no auth.uid() to read.
  // Production ignores it. Nothing here comes from the request body.
  const db = statementDbClient(token, {
    userId: auth.userId,
    isAdmin: isAdminEmail(auth.email),
  })
  return { userId: auth.userId, tier: auth.tier, db }
}

/**
 * Give back a claim this request is not going to complete.
 *
 * A CLAIM MUST NOT OUTLIVE ITS REQUEST. Left behind, it would read as "an
 * analysis is already running" to the applicant's next attempt, for the whole
 * staleness window. Releasing deletes it, so the retry is an ordinary first
 * attempt rather than something that has to reason about old rows.
 *
 * A FAILURE TO RELEASE IS LOGGED AND NOT RAISED. The request has already failed
 * for its own reason, and the staleness window is the backstop.
 */
type HeldClaim = { readonly id: string; readonly claimToken: string }

async function releaseClaim(db: SupabaseClient, claim: HeldClaim | null): Promise<void> {
  if (claim === null) return
  // THE TOKEN GOES WITH IT. A release that named only the id could delete a
  // claim this request no longer holds -- one reclaimed while the model call
  // was in flight -- and the replacement's paid result would then have nowhere
  // to land. With the token, a superseded release removes nothing.
  const released = await settleAnalysis(db, {
    id: claim.id,
    claimToken: claim.claimToken,
    review: null,
    overall: null,
  })
  if (!released.ok) console.error('statement analyze: claim not released —', released.reason)
}

type Context = { params: Promise<{ id: string }> }

export async function POST(_request: NextRequest, context: Context): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  // DEVELOPMENT ONLY, DECIDED ON THE SERVER, ONCE. Read here so every branch
  // below answers to the same value, and so the three places it changes
  // behaviour -- the local store read, the usage ledger and where the result is
  // written -- cannot disagree about which mode this request is in.
  //
  // IT CHANGES NOTHING ABOUT WHAT IS ANALYSED. The prompt, the model, the
  // validator and the refusals are the production ones either way.
  const simulated = simulatedLiveEnabled()

  const { id } = await context.params
  // Checked before any query: Postgres casts this to uuid, and a malformed one
  // would be a 500 for what is plainly a bad request.
  if (!isDraftId(id)) {
    return NextResponse.json({ error: MESSAGES.notFound, code: 'not-found' }, { status: 404 })
  }

  // THE DRAFT, read under RLS. Somebody else's row and a row that does not
  // exist are the same answer, which is the indistinguishability readDraft was
  // written to produce.
  const found = await readDraft(caller.db, id)
  if (!found.ok) {
    if (found.reason === 'not-found') {
      return NextResponse.json({ error: MESSAGES.notFound, code: 'not-found' }, { status: 404 })
    }
    console.error('statement analyze: draft read failed —', found.reason)
    return NextResponse.json({ error: MESSAGES.unavailable, code: 'unavailable' }, { status: 500 })
  }
  const draft = found.value

  // ---- the plan, before any work at all ----------------------------------
  // ULTIMATE ONLY, AND CHECKED HERE. The editor also checks it, to decide what
  // to show; that is a courtesy and this is the control. A Free or Premium
  // caller posting straight to this endpoint is refused before the draft's
  // eligibility is computed, before the ledger is read, and long before a model
  // is called -- so no part of the paid path is reachable without the plan.
  //
  // THE TIER COMES FROM THE VERIFIED SESSION. authenticateRequest reads it from
  // user_profiles; no request field names a plan, so none can claim one.
  if (!canAnalyzeStatement(caller.tier)) {
    return NextResponse.json(
      { error: ANALYSIS_TIER_MESSAGE, code: ANALYSIS_TIER_CODE },
      { status: 403 },
    )
  }

  // ---- can this be offered honestly at all? ------------------------------
  // WITHOUT STORAGE THERE IS NO DEDUPLICATION, and without deduplication every
  // reopen and second tab is another charge for work already done -- silently,
  // because nothing would say so. So it fails CLOSED rather than calling the
  // model again: the feature is off until the thing that makes it affordable
  // exists. The development path is reachable only on a developer's machine
  // and is labelled wherever it appears.
  const availability = analysisAvailability({
    cacheEnabled: analysisCacheEnabled(),
    nodeEnv: process.env.NODE_ENV,
  })
  if (availability === 'unavailable') {
    return NextResponse.json(
      { error: ANALYSIS_UNAVAILABLE_MESSAGE, code: ANALYSIS_UNAVAILABLE_CODE },
      { status: 503 },
    )
  }

  // Measured on the SERVER's copy of the essay, which is the text that will be
  // judged -- not on anything the browser reported about it.
  const words = wordCount(draft.essay)
  const promptAttached = draft.promptText !== null

  // ---- the draft's STRUCTURED requirement, if it has one -----------------
  //
  // THE STORED SNAPSHOT, AND ONLY THAT. snapshot.ts can also PROJECT an old
  // draft's prompt columns into a RequirementSnapshot, and that projection is
  // the right thing for the editor to display -- but it must not be used here.
  // Every decision below that reads this value feeds either the cache key or
  // the model prompt, and a projected snapshot would change both for drafts
  // that already exist: their cached analyses would miss and be paid for
  // again, and their model input would gain a document header describing
  // something they never chose. So a draft without a stored requirement is
  // treated exactly as it was before this feature, byte for byte.
  //
  // null ON EVERY UNMIGRATED DEPLOYMENT, because the repository does not even
  // select the column unless STATEMENT_REQUIREMENTS is on.
  const requirement = parseRequirementSnapshot(draft.requirementSnapshot)

  // ---- is this draft's requirement really the school's? ------------------
  //
  // RESOLVED BEFORE ANYTHING READS THE SNAPSHOT, which is the whole correction.
  // public.statement_drafts grants `authenticated` table-level UPDATE and an
  // own-rows policy, so an applicant can PATCH requirement_snapshot straight
  // through PostgREST. Everything below that used to read it -- the eligibility
  // floor, the component list handed to the model, the limits quoted to the
  // model, the notes quoted as the catalog's -- was reading a column the
  // applicant controls.
  //
  // THE SNAPSHOT IS NOT EVIDENCE OF ITSELF. draftProvenance looks the
  // requirement up with the caller's own client and compares every attributed
  // field against the catalog's current row. Nothing in the snapshot's own
  // `verification` object is consulted.
  const verdict = await draftProvenance(
    caller.db,
    { promptId: draft.promptId, promptText: draft.promptText },
    requirement,
    verifiedProvenance,
  )
  const provenance = verdict.provenance

  // THE ONLY REQUIREMENT ANY DECISION BELOW MAY READ.
  //
  // null WHENEVER AUTHENTICATION FAILED, for any reason: a tampered field, a
  // reworded catalog entry, a withdrawn requirement, an unverified set, a read
  // error, or the rollout flag being off. The draft is then analysed exactly as
  // a legacy single-prompt draft is -- against draft.promptText, with the word
  // floor from stated_max_words and no structured extras -- which is a path
  // that has shipped and is not influenced by the snapshot at all.
  //
  // THE SNAPSHOT IS NOT DELETED OR REWRITTEN. It stays on the row as the
  // historical copy of what the applicant started from, and the editor still
  // displays it; it simply carries no authority here. That is the difference
  // between keeping a record and treating it as official.
  const authoritative = verdict.authentic ? requirement : null

  // ---- eligibility, which costs nothing and is therefore checked first ----
  //
  // ONE POLICY, ONE BRANCH. The word floor from rubric.ts, which is what every
  // draft has always been held to.
  //
  // WHERE THE WORD MAXIMUM COMES FROM is the only thing the requirement
  // changes, and it comes from the AUTHENTICATED requirement or not at all. A
  // tampered `constraints.words.max` of 60 would otherwise have dropped the
  // floor from 100 words to 48.
  const eligibility = authoritative === null
    ? eligibilityFor({ words, statedMaxWords: draft.statedMaxWords })
    : eligibilityForRequirement({ constraints: authoritative.constraints, words })

  if (eligibility.kind === 'prompt-too-short') {
    return NextResponse.json({
      error: MESSAGES.promptTooShort,
      code: 'prompt-too-short',
      statedMaxWords: eligibility.statedMaxWords,
    }, { status: 422 })
  }
  if (eligibility.kind === 'too-short') {
    // NO USAGE IS RECORDED ON THIS PATH. A below-minimum attempt must not
    // consume an applicant's allowance; a test asserts this returns before the
    // ledger is touched.
    return NextResponse.json({
      error: MESSAGES.tooShort,
      code: 'too-short',
      minimumWords: eligibility.minimumWords,
      words,
    }, { status: 422 })
  }

  // A STATED CHARACTER MAXIMUM THAT THE WORD FLOOR CANNOT FIT INSIDE.
  //
  // REFUSED, AND SAID PLAINLY, rather than silently given a lower floor. The
  // bound is arithmetic and not an estimate: 100 words cannot occupy fewer
  // than 199 characters counting the separators between them. What should
  // happen for those responses is an owner decision nobody has taken.
  //
  // READ FROM THE AUTHENTICATED REQUIREMENT, so a fabricated character limit
  // cannot be used to refuse -- or to permit -- an analysis.
  if (authoritative !== null && !wordFloorFits(authoritative.constraints)) {
    return NextResponse.json({
      error: FLOOR_UNREACHABLE,
      code: 'prompt-too-short',
      statedMaxWords: null,
    }, { status: 422 })
  }

  // ---- has this exact work already been done? ----------------------------
  // CONTENT-ADDRESSED. The fingerprint covers the essay, the saved prompt
  // snapshot, the school, the word limit and the rubric and schema versions --
  // and does NOT cover the title or the revision. So renaming a draft reuses
  // the stored result, and changing a word of the essay does not.
  const fingerprint = analysisFingerprint({
    essay: draft.essay,
    promptText: draft.promptText,
    schoolId: draft.schoolId,
    promptId: draft.promptId,
    statedMaxWords: draft.statedMaxWords,
    // THE STORED SNAPSHOT, NOT THE AUTHENTICATED ONE, AND DELIBERATELY SO.
    // The fingerprint's job is to identify what was analysed, not to say
    // whether it was trustworthy. Keying on the snapshot as stored means a
    // tampered draft gets its OWN cache row: it can neither read the authentic
    // analysis nor write over it, and reverting the tampering returns to the
    // authentic key. Keying on the authenticated value instead would collapse
    // every tampered variant onto one key and let the first one answer for all
    // of them.
    requirement,
    // AND THE VERDICT, so an outdated or altered requirement cannot retrieve a
    // row stored while it was still the school's. See the field's own note.
    requirementAuthentic: verdict.authentic,
  })

  /*
    AI-QA-017: WITHOUT THE DURABLE CLAIM, ONE SLOT PER KEY IN THIS PROCESS.

    The claim below is taken only when the cache is on. With it off, production
    has already answered 503 and nothing reaches here -- but a developer's
    machine runs the model anyway, and four simultaneous requests for one essay
    made four model calls. Measured, not supposed.

    SO THE SLOT IS TAKEN ONLY ON THAT PATH. Where the claim exists it is the
    authority and this would be a second opinion; where it does not, this
    collapses the burst a double-click or a second tab produces. It is
    best-effort by construction -- see analysisInFlight.ts.

    THE SAME 409 EITHER WAY, so the applicant is told the same true thing and
    the client needs no second code to understand.
  */
  const inFlightKey = `${caller.userId}:${id}:${fingerprint}`
  const slotTaken = availability === 'ready' ? false : beginAnalysis(inFlightKey)
  if (availability !== 'ready' && !slotTaken) {
    return NextResponse.json(
      { error: MESSAGES.running, code: 'already-running' },
      { status: 409 },
    )
  }

  /** Give back whatever this request is holding, on every exit. */
  const release = (): void => { if (slotTaken) endAnalysis(inFlightKey) }

  /*
    ONE finally FOR TEN EXITS. A slot left behind would read as "already
    running" to the applicant's next attempt for the whole TTL -- the same
    mistake an unreleased claim would be -- and there are ten ways out of
    this function. Releasing at each one is ten chances to forget.
  */
  try {

    // THE CLAIM, NOT JUST ITS ID. The token is this request's authority to settle
    // the row, and it is rotated by the database on every successful claim -- so
    // holding both is what lets a superseded request be refused rather than
    // overwriting whoever replaced it.
    let claim: HeldClaim | null = null
    if (availability === 'ready') {
      const claimed = await claimAnalysis(caller.db, {
        draftId: id,
        fingerprint,
        revision: draft.revision,
        promptAttached,
        provenance,
        words,
        statedMaxWords: draft.statedMaxWords,
        overLimit: overLimit({ words, statedMaxWords: draft.statedMaxWords }),
      })
      if (!claimed.ok) {
        // NO SILENT FALL-BACK TO A PAID CALL. With the cache on, a failure here
        // means this request cannot tell whether the work has already been paid
        // for -- and running the model anyway is exactly the charge this feature
        // exists to prevent.
        console.error('statement analyze: claim failed —', claimed.reason)
        return NextResponse.json(
          { error: MESSAGES.cacheUnavailable, code: 'unavailable' },
          { status: 503 },
        )
      }

      // A CACHE HIT. Zero model calls, no ledger entry, no allowance consumed.
      if (claimed.value.state === 'complete') {
        const stored = claimed.value.analysis
        return NextResponse.json({
          review: stored.review,
          revision: stored.revision,
          words: stored.words,
          overLimit: stored.overLimit,
          statedMaxWords: stored.statedMaxWords,
          provenance: stored.provenance,
          cached: true,
          analyzedAt: stored.createdAt,
        })
      }

      // Another request is already running for exactly these inputs. Two rapid
      // clicks, or two tabs, land here and neither starts a second paid call.
      if (claimed.value.state === 'running') {
        return NextResponse.json(
          { error: MESSAGES.running, code: 'already-running' },
          { status: 409 },
        )
      }

      claim = { id: claimed.value.id, claimToken: claimed.value.claimToken }
    }

    // ---- SIMULATED LIVE: the local store, in place of the cache ------------
    //
    // THE SAME QUESTION PRODUCTION ASKS, ASKED OF A LOCAL FILE. Keyed on the
    // fingerprint that was just computed, so an identical essay and requirement
    // return the stored result and no paid call is made -- and a changed essay
    // has a different fingerprint, so it reaches the model as it should.
    //
    // PLACED AFTER THE CLAIM BLOCK AND BEFORE THE ALLOWANCE, which is exactly
    // where production's cache hit returns. Everything above it has already run
    // for real: the gate, the tier check, the provenance verdict and every
    // eligibility refusal.
    //
    // NO PRODUCTION RPC IS INVOLVED. claimAnalysis() is unreachable here anyway,
    // because it is taken only when the cache flag is on; this is the substitute
    // for the protection that flag would have provided.
    if (simulated) {
      const { localAnalysisFor } = await import('@/lib/statement/devMode/localAnalyses')
      const stored = localAnalysisFor(id, fingerprint)
      if (stored !== null) {
        return NextResponse.json({
          review: stored.review,
          revision: stored.revision,
          words: stored.words,
          overLimit: stored.overLimit,
          statedMaxWords: stored.statedMaxWords,
          provenance: stored.provenance,
          cached: true,
          analyzedAt: stored.createdAt,
        })
      }
    }

    // ---- the allowance ------------------------------------------------------
    // V2's OWN WINDOWS: burst protection with no daily ceiling, because Ultimate
    // is sold as unlimited analysis of changed essays. The legacy analyser keeps
    // its own limits, daily cap included -- nothing here changes them.
    const rate = await statementRateDecision(
      caller.db, caller.userId, { limits: V2_ANALYSIS_RATE_LIMITS },
    )
    if (!rate.allowed) {
      return NextResponse.json(
        { error: MESSAGES.rateLimited, code: RATE_LIMIT_CODE },
        { status: 429 },
      )
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error('statement analyze: OPENAI_API_KEY is not configured')
      return NextResponse.json({ error: MESSAGES.unavailable, code: 'unavailable' }, { status: 503 })
    }

    // THE SAME OPERATION THE LEGACY ANALYSER RECORDS. One analysis is one
    // analysis: this introduces no new charge, no new allowance and no new
    // pricing, and it counts against the budget the applicant already has.
    // THE LEDGER IS NOT WRITTEN LOCALLY.
    //
    // record_ai_usage and settle_ai_usage are RPCs on the production ledger and
    // the guarded client refuses both -- so this is not the safety mechanism, it
    // is what lets the screen work instead of erroring. No attempt is recorded,
    // so there is no attempt to settle, which settleUsage() below enforces.
    //
    // THE RATE DECISION ABOVE IS STILL REAL. It is a SELECT on the ledger, which
    // the guard passes through untouched, so a local run is refused for the same
    // reason production would refuse it -- without consuming anything.
    const usageId = simulated
      ? null
      : await recordStatementAttempt(caller.db, STATEMENT_OPERATIONS.analyze)

    /**
     * Settle the attempt, if there is an attempt to settle.
     *
     * ONE PLACE WHERE THE LEDGER IS TOUCHED, instead of four. settleStatementUsage
     * already returns on a null id, so this changes nothing about what happens --
     * but it changes what has to be TRUE for nothing to happen. With four direct
     * calls, "no usage RPC runs on a local request" was a property of a shared
     * production function's first line; here it is a property of this route,
     * provable by reading it. A test that replaces the ledger module with a
     * tripwire catches the difference, which is how this was found.
     *
     * A NULL ID IS NOT A SIMULATED-LIVE SPECIAL CASE. It also happens in
     * production when recordStatementAttempt fails, and skipping the settle is
     * the right answer there too: there is no row to settle.
     */
    const settleUsage = async (outcome: 'proposed' | 'rejected' | 'failed'): Promise<void> => {
      if (usageId === null) return
      await settleStatementUsage(caller.db, usageId, outcome)
    }

    let completion: string
    try {
      const response = await openai.chat.completions.create(
        {
          model: MODEL,
          messages: [
            {
              role: 'system',
              // THE AUTHENTICATED REQUIREMENT, so a fabricated component list
              // cannot reach the instruction that says "there are N, return one
              // entry for each" -- which is how a tampered draft would have been
              // scored against requirements it wrote for itself.
              content: reviewSystemPrompt(promptAttached, authoritative === null ? null : {
                componentCount: authoritative.components.length,
                hasOptionalComponent: authoritative.components.some((part) => part.optional),
                hasUnmeasurable: analyzerUnmeasuredKinds(authoritative.constraints).length > 0,
              }),
            },
            {
              role: 'user',
              content: buildReviewUserMessage({
                essay: draft.essay,
                // THE DRAFT'S OWN SNAPSHOT. Never re-read from the catalog: an
                // essay is judged against the question its author saw.
                promptText: draft.promptText,
                statedMaxWords: draft.statedMaxWords,
                // Measured here, so the model is told the count rather than
                // asking the applicant to check something already known.
                words,
                // THE AUTHENTICATED REQUIREMENT. Everything this block would put
                // in front of the model as the school's own -- the numbered
                // questions, the label, the limits, the free-text formatting
                // instructions, the "catalog records unresolved uncertainty"
                // sentence -- is omitted entirely unless the catalog confirmed it.
                // The essay is still assessed against draft.promptText, exactly
                // as a legacy single-prompt draft is.
                requirement: authoritative,
              }),
            },
          ],
          temperature: 0.3,
          /*
           * 4,000, NOT 3,000, AND THE ARITHMETIC IS WHY.
           *
           * A seven-category response carries 21 prose fields plus a summary with
           * three lists. At the brevity the system prompt asks for that is around
           * 1,200 tokens; at the verbosity this model actually tends toward it is
           * closer to 2,200; and a plausibly wordy answer reaches about 3,300.
           *
           * TRUNCATION IS NOT A DEGRADED ANSWER, IT IS AN INVALID ONE. The reply
           * is JSON, so cutting it mid-object makes it unparseable, parseReview
           * refuses it, and the applicant is told the analysis could not be read.
           * They also lose a slot: statementRateDecision counts every row in the
           * window regardless of how it settled, so a truncated call costs them
           * part of their allowance and returns nothing.
           *
           * THIS IS NOT A PRICING CHANGE. max_tokens is a ceiling, not a purchase
           * -- billing is on tokens actually generated, and a response that would
           * have fitted in 3,000 still costs exactly what it did. What changes is
           * only that a longer one is completed rather than cut in half.
           */
          max_tokens: 4000,
          response_format: { type: 'json_object' },
        },
        { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) },
      )
      completion = response.choices[0]?.message?.content ?? ''
    } catch (error) {
      // The NAME only. An OpenAI error echoes the request, and the request is
      // somebody's personal statement.
      console.error('statement analyze: model call failed', (error as { name?: string })?.name)
      await settleUsage('failed')
      await releaseClaim(caller.db, claim)
      return NextResponse.json({ error: MESSAGES.unavailable, code: 'unavailable' }, { status: 502 })
    }

    let raw: unknown
    try {
      raw = JSON.parse(completion)
    } catch {
      await settleUsage('rejected')
      await releaseClaim(caller.db, claim)
      return NextResponse.json({ error: MESSAGES.malformed, code: 'malformed' }, { status: 502 })
    }

    // THE ESSAY GOES TO THE VALIDATOR TOO, so a quotation the model attributes to
    // the applicant can be checked against what they actually wrote.
    const parsed = parseReview({ raw, promptAttached, essay: draft.essay })
    if (!parsed.ok) {
      // THE REASON IS LOGGED, THE OUTPUT IS NOT. A malformed analysis still
      // quotes the applicant's essay back.
      console.error('statement analyze: malformed model response —', parsed.reason)
      await settleUsage('rejected')
      await releaseClaim(caller.db, claim)
      return NextResponse.json({ error: MESSAGES.malformed, code: 'malformed' }, { status: 502 })
    }

    await settleUsage('proposed')

    // THE RESULT IS STORED ONLY AFTER IT VALIDATED. A malformed or failed
    // analysis released its claim above and wrote nothing, so no failure can ever
    // be read back as a cached success.
    // SIMULATED LIVE: the result is kept locally, and only now.
    //
    // AFTER parseReview(), FOR THE SAME REASON PRODUCTION STORES ONLY THEN. A
    // malformed or failed analysis must not be readable back as a success, or the
    // next identical click would be served a result the validator rejected.
    if (simulated) {
      const { saveLocalAnalysis } = await import('@/lib/statement/devMode/localAnalyses')
      saveLocalAnalysis({
        draftId: id,
        fingerprint,
        review: parsed.review,
        revision: draft.revision,
        words,
        overLimit: overLimit({ words, statedMaxWords: draft.statedMaxWords }),
        statedMaxWords: draft.statedMaxWords,
        provenance,
      })
    }

    if (claim !== null) {
      const stored = await settleAnalysis(caller.db, {
        id: claim.id,
        claimToken: claim.claimToken,
        review: parsed.review,
        overall: parsed.review.overall,
      })
      // A STORE THAT FAILED IS NOT A FAILED ANALYSIS. The applicant paid for this
      // feedback and it is valid; they get it. The only cost is that reopening
      // the draft will analyse again, which is the behaviour without the cache.
      if (!stored.ok) console.error('statement analyze: result not stored —', stored.reason)
    }

    return NextResponse.json({
      review: parsed.review,
      // BOUND TO WHAT WAS ACTUALLY JUDGED. The browser compares these with what
      // is on screen and labels the result as older when they have moved on.
      revision: draft.revision,
      words,
      overLimit: overLimit({ words, statedMaxWords: draft.statedMaxWords }),
      statedMaxWords: draft.statedMaxWords,
      // 'catalog' only when the catalog agrees; never because an id looked real.
      provenance,
      // SAID PLAINLY. False means this result was not stored, so asking again
      // will pay again -- the interface must not imply otherwise.
      //
      // TRUE LOCALLY BECAUSE IT IS TRUE LOCALLY: the local store will answer the
      // next identical request without a model call, which is the behaviour the
      // field describes. It is not a claim about production, which stored
      // nothing.
      stored: availability === 'ready' || simulated,
    })
  } finally {
    release()
  }
}
