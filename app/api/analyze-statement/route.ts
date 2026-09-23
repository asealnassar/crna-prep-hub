import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, readAccessToken } from '@/lib/apiAuth'
import {
  MAX_ANALYZE_BODY_BYTES, MAX_REWRITE_BODY_BYTES, checkStatement, declaredTooLarge, withinBodyLimit,
} from '@/lib/statement/limits'
import {
  RATE_LIMIT_CODE, REWRITE_TIER_CODE, REWRITE_TIER_MESSAGE,
  canRewrite, canSeeSentenceAnalysis, canSeeSuggestions,
} from '@/lib/statement/entitlement'
import {
  REWRITE_SYSTEM_PROMPT, analysisSystemPrompt, buildRewriteUserMessage,
} from '@/lib/statement/prompts'
import { parseAnalysis, redactForTier, reviewNotesFrom } from '@/lib/statement/analysis'
import { signAnalysis, verifyAnalysisToken } from '@/lib/statement/signing'
import {
  STATEMENT_OPERATIONS, recordStatementAttempt, settleStatementUsage, statementRateDecision,
} from '@/lib/statement/usage'

/**
 * The Personal Statement Analyzer's only server surface.
 *
 * PHASE 0 HARDENING. The feature, the tiers and the page are unchanged. What
 * changed is everything between the request arriving and the model being
 * called, in this order -- and the order is the design, because each gate is
 * cheaper than the one after it:
 *
 *   1. AUTHENTICATION, before the body is read. Unchanged; it was already
 *      right.
 *   2. BODY SIZE, on raw bytes, before parsing. There was no limit, and
 *      App Router route handlers impose none.
 *   3. STATEMENT LENGTH, after parsing. There was a floor and no ceiling.
 *   4. ENTITLEMENT, from the verified session. Unchanged for the rewrite;
 *      NEW for per-category suggestions, which were being generated for every
 *      tier and hidden in the browser.
 *   5. ORIGIN, for a rewrite: the analysis must carry a signature this server
 *      issued. This is what stops the caller writing the system prompt.
 *   6. RATE, from the ledger. There was none of any kind.
 *   7. The model, with an abort timeout inside the function's own budget.
 *   8. STRICT VALIDATION of what comes back, then redaction for the tier.
 *
 * NOTHING IS STORED. The statement is read, sent, and dropped; the only row
 * written is a ledger entry recording that a call happened. See
 * lib/statement/usage.ts for why that row lives where it does.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = process.env.STATEMENT_AI_MODEL || 'gpt-4o'

/**
 * Below `maxDuration`, so a slow model is a clean 504 with a message rather
 * than the platform killing the function and the browser showing the generic
 * "Analysis failed". This route had no duration setting at all, which is the
 * likeliest cause of long statements appearing to fail at random.
 */
const MODEL_TIMEOUT_MS = 50_000

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

type Caller = {
  readonly userId: string
  readonly tier: string
  readonly db: SupabaseClient
}

/** Authenticates and builds a client scoped to the caller's own JWT. */
async function admit(): Promise<Caller | NextResponse> {
  const auth = await authenticateRequest()
  if (!auth) {
    return NextResponse.json(
      { error: 'You must be signed in to analyze a statement.' },
      { status: 401 }
    )
  }
  const token = await readAccessToken()
  if (!token) {
    return NextResponse.json(
      { error: 'You must be signed in to analyze a statement.' },
      { status: 401 }
    )
  }
  // The anon key plus the caller's own JWT, so RLS is in force and the ledger
  // functions see the real user. No service role anywhere in this file.
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )
  return { userId: auth.userId, tier: auth.tier, db }
}

const tooLarge = () =>
  NextResponse.json({ error: 'That request is too large.' }, { status: 413 })

/**
 * Reads the body under a byte ceiling.
 *
 * TWO GATES, because they protect different things. The Content-Length check
 * refuses an honestly-declared oversized request WITHOUT buffering it, which is
 * the only one that saves memory. The byte measurement then runs on what
 * actually arrived, which is the one a liar cannot get past.
 */
async function readBody(
  request: NextRequest,
  maxBytes: number
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  if (declaredTooLarge(request.headers.get('content-length'), maxBytes)) {
    return { ok: false, response: tooLarge() }
  }
  const raw = await request.text()
  if (!withinBodyLimit(raw, maxBytes)) {
    return { ok: false, response: tooLarge() }
  }
  try {
    const parsed = raw === '' ? null : JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'Malformed request.' }, { status: 400 }),
      }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Malformed request.' }, { status: 400 }),
    }
  }
}

function rateRefusal(rate: { retryAfterSeconds: number; message: string }): NextResponse {
  return NextResponse.json(
    { error: rate.message, code: RATE_LIMIT_CODE },
    { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
  )
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  const read = await readBody(request, MAX_ANALYZE_BODY_BYTES)
  if (!read.ok) return read.response

  const checked = checkStatement(read.body.statement)
  if (!checked.ok) {
    return NextResponse.json({ error: checked.message, code: checked.code }, { status: 400 })
  }
  const statement = checked.statement

  // Tier from the verified session, never from the body. What the tier may not
  // see is not asked for, so it is not generated and not billed.
  const includeSuggestions = canSeeSuggestions(caller.tier)
  const includeSentenceAnalysis = canSeeSentenceAnalysis(caller.tier)

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'Analysis is unavailable right now.' }, { status: 503 })
  }

  // RECORDED BEFORE THE CHECK, so a burst of simultaneous requests can see each
  // other. A failed write falls back to the old ordering rather than taking the
  // feature down with it -- degraded, never open. See lib/statement/usage.ts.
  const usageId = await recordStatementAttempt(caller.db, STATEMENT_OPERATIONS.analyze)
  const rate = await statementRateDecision(caller.db, caller.userId, { selfRecorded: usageId !== null })
  if (!rate.allowed) {
    await settleStatementUsage(caller.db, usageId, 'rejected')
    return rateRefusal(rate)
  }

  let completion: string
  try {
    const response = await openai.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: analysisSystemPrompt({ includeSuggestions, includeSentenceAnalysis }) },
          { role: 'user', content: statement },
        ],
        temperature: 0.4,
        max_tokens: 2500,
        response_format: { type: 'json_object' },
      },
      { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) }
    )
    completion = response.choices[0]?.message?.content ?? ''
  } catch (error) {
    // Never the error object: an OpenAI error echoes the request, and the
    // request is the applicant's personal statement.
    const name = (error as { name?: string })?.name
    console.error('statement analyze: model call failed', name)
    await settleStatementUsage(caller.db, usageId, 'failed')
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    return NextResponse.json(
      { error: timedOut ? 'That took too long to analyze. Please try again.' : 'Analysis failed. Please try again.' },
      { status: timedOut ? 504 : 502 }
    )
  }

  const parsed = parseAnalysis(completion, { includeSuggestions, includeSentenceAnalysis })
  if (!parsed.ok) {
    console.error('statement analyze: malformed model response —', parsed.reason)
    await settleStatementUsage(caller.db, usageId, 'rejected')
    return NextResponse.json({ error: 'Analysis failed. Please try again.' }, { status: 502 })
  }

  // Redacted on the way out, over whatever the model actually produced. The
  // page's tier conditionals are presentation; this is the entitlement.
  const analysis = redactForTier(parsed.value, caller.tier)

  await settleStatementUsage(caller.db, usageId, 'proposed')

  // The token binds this analysis to this user and this statement. A rewrite
  // presents it back; see lib/statement/signing.ts. A null key means rewrites
  // will refuse, which is the correct failure for a misconfigured server.
  const token = signAnalysis({ userId: caller.userId, statement, analysis })

  return NextResponse.json({ analysis, token })
}

// ---------------------------------------------------------------------------
// Rewrite
// ---------------------------------------------------------------------------

export async function PUT(request: NextRequest) {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  // Entitlement before anything expensive, and before the body is read.
  if (!canRewrite(caller.tier)) {
    return NextResponse.json(
      { error: REWRITE_TIER_MESSAGE, code: REWRITE_TIER_CODE },
      { status: 403 }
    )
  }

  const read = await readBody(request, MAX_REWRITE_BODY_BYTES)
  if (!read.ok) return read.response

  const checked = checkStatement(read.body.statement)
  if (!checked.ok) {
    return NextResponse.json({ error: checked.message, code: checked.code }, { status: 400 })
  }
  const statement = checked.statement

  // The analysis is read through the SAME strict validator the model's own
  // output goes through, so what reaches the prompt builder is a known shape
  // with bounded fields — never the raw object off the wire.
  const revalidated = parseAnalysis(JSON.stringify(read.body.analysis ?? null), {
    includeSuggestions: true,
    includeSentenceAnalysis: true,
  })
  if (!revalidated.ok) {
    return NextResponse.json(
      { error: 'Please analyze your statement again before rewriting.', code: 'analysis-unreadable' },
      { status: 400 }
    )
  }

  // ORIGIN. The signature is checked against the analysis EXACTLY as the client
  // sent it, which is what the server signed — not against the revalidated
  // copy, which normalises. A single altered character fails here, so nothing
  // a caller composed can reach the model.
  const verdict = verifyAnalysisToken({
    token: read.body.token,
    userId: caller.userId,
    statement,
    analysis: read.body.analysis,
  })
  if (!verdict.ok) {
    console.error('statement rewrite: token rejected —', verdict.reason)
    // 'unavailable' is a server misconfiguration, not the applicant's doing:
    // telling them to analyze again would send them round a loop that cannot
    // succeed until the signing key is present.
    const message =
      verdict.reason === 'unavailable'
        ? 'Rewrite is unavailable right now. Please try again later.'
        : verdict.reason === 'expired'
          ? 'That analysis has expired. Please analyze your statement again.'
          : 'Please analyze your statement again before rewriting.'
    return NextResponse.json(
      { error: message, code: `analysis-token-${verdict.reason}` },
      { status: verdict.reason === 'unavailable' ? 503 : 400 }
    )
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'Rewrite is unavailable right now.' }, { status: 503 })
  }

  const usageId = await recordStatementAttempt(caller.db, STATEMENT_OPERATIONS.rewrite)
  const rate = await statementRateDecision(caller.db, caller.userId, { selfRecorded: usageId !== null })
  if (!rate.allowed) {
    await settleStatementUsage(caller.db, usageId, 'rejected')
    return rateRefusal(rate)
  }

  try {
    const response = await openai.chat.completions.create(
      {
        model: MODEL,
        messages: [
          // A CONSTANT. Nothing is interpolated into the system turn, ever.
          { role: 'system', content: REWRITE_SYSTEM_PROMPT },
          { role: 'user', content: buildRewriteUserMessage(statement, reviewNotesFrom(revalidated.value)) },
        ],
        temperature: 0.6,
        max_tokens: 2500,
      },
      { signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) }
    )

    const rewritten = response.choices[0]?.message?.content?.trim() ?? ''
    if (rewritten === '') {
      await settleStatementUsage(caller.db, usageId, 'rejected')
      return NextResponse.json({ error: 'Rewrite failed. Please try again.' }, { status: 502 })
    }

    await settleStatementUsage(caller.db, usageId, 'proposed')
    return NextResponse.json({ rewritten })
  } catch (error) {
    const name = (error as { name?: string })?.name
    console.error('statement rewrite: model call failed', name)
    await settleStatementUsage(caller.db, usageId, 'failed')
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    return NextResponse.json(
      { error: timedOut ? 'That took too long to rewrite. Please try again.' : 'Rewrite failed. Please try again.' },
      { status: timedOut ? 504 : 502 }
    )
  }
}
