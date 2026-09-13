import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { BLOCKED_BODY, UNAUTHORIZED_BODY, resumeV2Access } from '@/lib/resume/gate'
import { resumeBuilderMode } from '@/lib/resume/rollout'
import { readResume, saveStrength } from '@/lib/resume/repo/resumeRepo'
import {
  AI_RATE_LIMITS, RATE_LIMIT_CODE, checkAiRate, rateLedgerWindowMs,
} from '@/lib/resume/entitlement'
import { scoreDeterministic } from '@/lib/resume/score/deterministic'
import { buildRubricPrompt, parseRubric, rubricEligibility, rubricUnavailable } from '@/lib/resume/score/rubric'
import { compose, isStale } from '@/lib/resume/score/compose'
import { STRENGTH_DISCLAIMER } from '@/lib/resume/score/language'

/**
 * CRNA Resume Strength for one resume.
 *
 * NO TIER GATE. Every tier gets this — it is what makes the builder worth
 * using, and gating it would remove the reason anyone reaches the paywall. The
 * gate is finalising and exporting, and it is enforced elsewhere.
 *
 * ON DEMAND ONLY. There is no automatic scoring; this runs when the applicant
 * asks. That is what keeps the cost bounded without a quota, and what stops a
 * score being recomputed on every keystroke.
 *
 * THE RETIRED ROUTE'S FAILURE, NOT REPEATED. `app/api/resume/score` used the
 * service role, checked no session, and took an id from the request body — so
 * anyone could score anyone's resume. Here: a verified session, the V2 gate,
 * the caller's own JWT so RLS decides what may be read, and no service role
 * anywhere.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = process.env.RESUME_AI_MODEL || 'gpt-4o'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // `auth` is non-null here -- the 401 above returns first -- so the gate's
  // sign-in branch is unreachable from a route handler. It is still handled
  // rather than asserted away, because an assertion here would be a 404 for a
  // signed-out caller in v2 mode, and that is the one refusal that should say
  // plainly that signing in would help.
  const access = resumeV2Access({
    isAdmin: isAdminEmail(auth.email),
    isAuthenticated: true,
    mode: resumeBuilderMode(),
  })
  if (!access.allowed) {
    return NextResponse.json(
      access.reason === 'sign-in' ? UNAUTHORIZED_BODY : BLOCKED_BODY,
      { status: access.status }
    )
  }

  const token = await readAccessToken()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed JSON.' }, { status: 400 })
  }
  const id = (body as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !UUID.test(id)) {
    return NextResponse.json({ error: 'A valid id is required.' }, { status: 400 })
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  const read = await readResume(db, id)
  if (!read.ok) {
    console.error('resume-v2 score: read failed', read.reason, read.detail)
    return NextResponse.json({ error: 'read-failed' }, { status: 500 })
  }
  const resume = read.value.resume
  if (!resume) return NextResponse.json({ error: 'not-found' }, { status: 404 })

  // The same invisible ceiling the propose route uses. A 429 here says to try
  // again shortly; it never mentions a plan, because there is no quota.
  const rate = await rateDecision(db, auth.userId)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: RATE_LIMIT_CODE, message: rate.message },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
    )
  }

  // The free half, always. Even when the model is unreachable the applicant
  // gets their Data Quality score rather than an error page.
  const deterministic = scoreDeterministic(resume)
  const eligibility = rubricEligibility(resume)

  const usageId = await recordAttempt(db, id)
  let writing = rubricUnavailable('The writing review could not be run just now.')

  if (process.env.OPENAI_API_KEY) {
    try {
      const { system, user } = buildRubricPrompt(resume)
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        max_tokens: 2_000,
        response_format: { type: 'json_object' },
      })
      const parsed = parseRubric(response.choices[0]?.message?.content ?? '', eligibility)
      writing = [...parsed.categories]
      if (parsed.droppedLines > 0) {
        // Visible in the logs before it is visible to a user.
        console.warn('resume-v2 score: dropped', parsed.droppedLines, 'line(s) making admissions claims')
      }
      await settle(db, usageId, 'proposed')
    } catch (error) {
      // Never the error object: it echoes the request, and the request is a
      // person's resume.
      console.error('resume-v2 score: rubric failed', (error as { name?: string })?.name)
      await settle(db, usageId, 'failed')
    }
  } else {
    await settle(db, usageId, 'failed')
  }

  const result = compose({
    categories: [...deterministic, ...writing],
    revision: resume.revision,
    now: new Date().toISOString(),
  })

  // Stored with a scoped update so the revision does not move -- writing the
  // score must not be the thing that makes the score stale.
  const stored = await saveStrength(db, id, {
    score: result.score,
    computedAt: result.computedAt,
    computedAtRevision: result.computedAtRevision,
  })
  if (!stored.ok) console.error('resume-v2 score: could not store', stored.reason, stored.detail)

  return NextResponse.json({
    strength: result,
    stale: isStale(result.computedAtRevision, resume.revision),
    disclaimer: STRENGTH_DISCLAIMER,
  })
}

async function rateDecision(db: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - rateLedgerWindowMs()).toISOString()
  const { data, error } = await db
    .from('resume_ai_usage')
    .select('created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    // Fail closed: an abuse control that opens when its storage misbehaves is
    // not a control.
    console.error('resume-v2 score: usage ledger unreadable', error.code, error.message)
    return {
      allowed: false as const,
      retryAfterSeconds: 30,
      message: 'Too many requests just now. Please try again shortly.',
    }
  }

  const recent = (data ?? [])
    .map((row) => Date.parse((row as { created_at: string }).created_at))
    .filter((at) => Number.isFinite(at))
  return checkAiRate(recent, Date.now(), AI_RATE_LIMITS)
}

async function recordAttempt(db: SupabaseClient, resumeId: string): Promise<string | null> {
  const { data, error } = await db.rpc('record_ai_usage', {
    p_resume_id: resumeId,
    p_operation: 'strength-rubric',
    p_outcome: 'attempted',
  })
  if (error) {
    console.error('resume-v2 score: could not record usage', error.code, error.message)
    return null
  }
  return typeof data === 'string' ? data : null
}

async function settle(db: SupabaseClient, usageId: string | null, outcome: string): Promise<void> {
  if (!usageId) return
  const { error } = await db.rpc('settle_ai_usage', { p_id: usageId, p_outcome: outcome })
  if (error) console.error('resume-v2 score: could not settle usage', error.code, error.message)
}
