import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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
import { claimAnalysis, settleAnalysis } from '@/lib/statement/draft/analysisRepo'
import { analysisCacheEnabled } from '@/lib/statement/draft/rollout'

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

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    },
  )
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
async function releaseClaim(db: SupabaseClient, claimId: string | null): Promise<void> {
  if (claimId === null) return
  const released = await settleAnalysis(db, { id: claimId, review: null, overall: null })
  if (!released.ok) console.error('statement analyze: claim not released —', released.reason)
}

type Context = { params: Promise<{ id: string }> }

export async function POST(_request: NextRequest, context: Context): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

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

  // ---- eligibility, which costs nothing and is therefore checked first ----
  const eligibility = eligibilityFor({ words, statedMaxWords: draft.statedMaxWords })
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
  })

  // Resolved before the claim, because the claim stores it: 'catalog' only when
  // the catalog agrees, never because an id looked real.
  const provenance = await verifiedProvenance(caller.db, {
    promptId: draft.promptId,
    promptText: draft.promptText,
  })

  let claimId: string | null = null
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

    claimId = claimed.value.id
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
  const usageId = await recordStatementAttempt(caller.db, STATEMENT_OPERATIONS.analyze)

  let completion: string
  try {
    const response = await openai.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: reviewSystemPrompt(promptAttached) },
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
    await settleStatementUsage(caller.db, usageId, 'failed')
    await releaseClaim(caller.db, claimId)
    return NextResponse.json({ error: MESSAGES.unavailable, code: 'unavailable' }, { status: 502 })
  }

  let raw: unknown
  try {
    raw = JSON.parse(completion)
  } catch {
    await settleStatementUsage(caller.db, usageId, 'rejected')
    await releaseClaim(caller.db, claimId)
    return NextResponse.json({ error: MESSAGES.malformed, code: 'malformed' }, { status: 502 })
  }

  // THE ESSAY GOES TO THE VALIDATOR TOO, so a quotation the model attributes to
  // the applicant can be checked against what they actually wrote.
  const parsed = parseReview({ raw, promptAttached, essay: draft.essay })
  if (!parsed.ok) {
    // THE REASON IS LOGGED, THE OUTPUT IS NOT. A malformed analysis still
    // quotes the applicant's essay back.
    console.error('statement analyze: malformed model response —', parsed.reason)
    await settleStatementUsage(caller.db, usageId, 'rejected')
    await releaseClaim(caller.db, claimId)
    return NextResponse.json({ error: MESSAGES.malformed, code: 'malformed' }, { status: 502 })
  }

  await settleStatementUsage(caller.db, usageId, 'proposed')

  // THE RESULT IS STORED ONLY AFTER IT VALIDATED. A malformed or failed
  // analysis released its claim above and wrote nothing, so no failure can ever
  // be read back as a cached success.
  if (claimId !== null) {
    const stored = await settleAnalysis(caller.db, {
      id: claimId,
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
    stored: availability === 'ready',
  })
}
