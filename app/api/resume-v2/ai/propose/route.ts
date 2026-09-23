import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { BLOCKED_BODY, UNAUTHORIZED_BODY, resumeV2Access } from '@/lib/resume/gate'
import { resumeBuilderMode } from '@/lib/resume/rollout'
import { readResume } from '@/lib/resume/repo/resumeRepo'
import {
  AI_RATE_LIMITS, RATE_LIMIT_CODE, checkAiRate, rateLedgerWindowMs,
} from '@/lib/resume/entitlement'
import { STATEMENT_OPERATION_PATTERN } from '@/lib/statement/usage'
import {
  factSheetForEntryField, factSheetForPosition, factSheetForSummary,
} from '@/lib/resume/ai/factSheet'
import { assistDecision } from '@/lib/resume/ai/gating'
import { usableCandidates } from '@/lib/resume/ai/candidates'
import { descriptorFor } from '@/lib/resume/studio/fields'
import { buildPrompt, needsCurrentText, parseModelResponse } from '@/lib/resume/ai/prompts'
import { verifyGrounding } from '@/lib/resume/ai/verify'
import type { Violation } from '@/lib/resume/ai/verify'
import { parseProposeRequest, targetTextFor } from '@/lib/resume/ai/request'
import type { AiOperation } from '@/lib/resume/ai/request'
import type { FactSheet } from '@/lib/resume/model/facts'
import type { ResumeV2 } from '@/lib/resume/model/types'

/**
 * Grounded AI proposals for one field of one resume.
 *
 * FIVE LAYERS, IN ORDER, and the prompt is only the second of them:
 *
 *   1. The grounding envelope. The server builds a FactSheet from the STORED
 *      resume. The request names a field; it never carries content.
 *   2. The prompt contract, which states the prohibited categories verbatim.
 *   3. Strict schema reading. No fallback chain, no coercion.
 *   4. The deterministic verifier. Anything not traceable to a supplied fact is
 *      rejected and named, per the locked decision.
 *   5. The human gate. What comes back is a proposal; nothing is written here.
 *      This route performs NO write to the resume at all.
 *
 * NO QUOTA. Every tier may use this. What guards it is an invisible rate
 * ceiling; when that trips the caller gets a 429 that says to try again, never
 * that they should upgrade. See lib/resume/entitlement.ts.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = process.env.RESUME_AI_MODEL || 'gpt-4o'
const MAX_BODY_BYTES = 32 * 1024

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

  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request too large.' }, { status: 413 })
  }
  let body: unknown
  try {
    body = raw === '' ? null : JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Malformed JSON.' }, { status: 400 })
  }

  const parsed = parseProposeRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const command = parsed.value

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  // Ownership is RLS's answer. A resume belonging to someone else is not
  // forbidden here; it does not exist.
  const read = await readResume(db, command.resumeId)
  if (!read.ok) {
    console.error('resume-v2 propose: read failed', read.reason, read.detail)
    return NextResponse.json({ error: 'read-failed' }, { status: 500 })
  }
  const resume = read.value.resume
  if (!resume) return NextResponse.json({ error: 'not-found' }, { status: 404 })

  // A sixth question, asked before the five layers: is there enough of the
  // applicant's own work for a proposal to be an improvement rather than an
  // invention? The editor disables the control for the same reason and in the
  // same words, so this is the floor under that rather than a second opinion.
  const section = resume.sections.find((s) => s.id === command.sectionId)
  if (!section) return NextResponse.json({ error: 'unknown-target' }, { status: 400 })

  const decision = assistDecision({
    resume,
    section,
    operation: command.operation,
    targetId: command.targetId,
    field: command.field,
  })
  if (!decision.allowed) {
    return NextResponse.json({ error: 'not-available', message: decision.reason }, { status: 400 })
  }

  // Invisible ceiling. Checked before the model call, so abuse costs no tokens.
  const rate = await rateDecision(db, auth.userId)
  if (!rate.allowed) {
    return NextResponse.json(
      { error: RATE_LIMIT_CODE, message: rate.message },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
    )
  }

  const grounding = groundingFor(resume, command)
  if (!grounding) return NextResponse.json({ error: 'unknown-target' }, { status: 400 })

  const currentText = needsCurrentText(command.operation)
    ? targetTextFor(resume, command.sectionId, command.targetId, command.bulletIndex, command.field)
    : undefined

  const usageId = await recordAttempt(db, command)

  if (!process.env.OPENAI_API_KEY) {
    await settle(db, usageId, 'failed')
    return NextResponse.json({ error: 'ai-unavailable' }, { status: 503 })
  }

  let completion: string
  try {
    const { system, user } = buildPrompt({
      operation: command.operation,
      sheet: grounding,
      currentText,
      maxItems: command.maxItems,
    })
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
      max_tokens: 900,
      response_format: { type: 'json_object' },
    })
    completion = response.choices[0]?.message?.content ?? ''
  } catch (error) {
    // Never the error object: an OpenAI error echoes the request, and the
    // request contains the applicant's own words.
    console.error('resume-v2 propose: model call failed', (error as { name?: string })?.name)
    await settle(db, usageId, 'failed')
    return NextResponse.json({ error: 'ai-failed' }, { status: 502 })
  }

  const model = parseModelResponse(completion)
  if (!model.ok) {
    console.error('resume-v2 propose: malformed model response —', model.reason)
    await settle(db, usageId, 'failed')
    return NextResponse.json({ error: 'ai-malformed' }, { status: 502 })
  }

  // Layer 4. Each proposal stands or falls on its own: a clean bullet is not
  // thrown away because a sibling invented a figure, and an invented one is
  // never returned so it can never be accepted.
  const proposals: string[] = []
  const violations: Violation[] = []
  for (const proposal of model.value.proposals) {
    const verdict = verifyGrounding(proposal, grounding, { existingText: currentText })
    if (verdict.ok) proposals.push(proposal)
    else violations.push(...verdict.violations)
  }

  // A choice of five that says one thing five ways is not a choice, and a
  // suggestion to write what is already written is not a suggestion. Compared
  // against the STORED bullets, for the same reason the grounding is built from
  // them: the browser's copy is not what this server can vouch for.
  const alreadyWritten =
    section.type === 'critical_care' || section.type === 'other_clinical'
      ? (section.positions.find((p) => p.id === command.targetId)?.bullets ?? []).map((b) => b.accepted)
      : []
  const offered = usableCandidates(proposals, alreadyWritten)

  await settle(db, usageId, violations.length > 0 && offered.length === 0 ? 'rejected' : 'proposed')

  return NextResponse.json({
    proposals: offered,
    opportunities: model.value.opportunities,
    // Echoed so an acceptance can record what produced it and what it was
    // allowed to know. The server re-derives both before storing anything, so
    // this is provenance for the audit trail, not a value that is trusted.
    model: MODEL,
    groundedIn: grounding.facts.map((f) => f.id),
    // Named, not shown: the applicant is told what the assistant tried to add.
    rejected: violations.map((v) => ({ category: v.category, token: v.token, message: v.message })),
  })
}

// ---------------------------------------------------------------------------

/**
 * The grounding for the addressed field, or null if there is none to be had.
 *
 * Null is the refusal: a section with no narrative field, an entry that is
 * gone, or a field the descriptor calls factual all land here and the route
 * answers 400 without spending a token. AI writes prose; a request aimed at a
 * licence number gets no sheet and therefore no proposal.
 */
function groundingFor(
  resume: ResumeV2,
  command: {
    readonly sectionId: string
    readonly targetId: string | null
    readonly field: string | null
    readonly operation: AiOperation
  }
): FactSheet | null {
  const { sectionId, targetId, field, operation } = command

  const section = resume.sections.find((s) => s.id === sectionId)
  if (!section) return null

  if (section.type === 'summary') return factSheetForSummary(resume)

  if (section.type === 'critical_care' || section.type === 'other_clinical') {
    const position = section.positions.find((p) => p.id === targetId)
    if (!position) return null
    // WRITING a new bullet may draw on the ones the applicant has already
    // written for this same job: those are stored text of their own, and a
    // sixth bullet written in ignorance of the first five repeats or
    // contradicts them. IMPROVING one may not -- there the bullets are the
    // subject, and a claim allowed to ground itself would verify against
    // itself. A new candidate is in neither case: it is checked against this
    // sheet, so it can never be in it.
    return factSheetForPosition(position, section.type, {
      includeWrittenBullets: operation === 'generate-bullets',
    })
  }

  // Every other list-shaped section: leadership, quality improvement, research,
  // shadowing, awards, volunteering, publications, custom. Which of their
  // fields may be written is the descriptor's answer, not a list kept here.
  const entry = descriptorFor(section.type).entry
  if (!entry || !targetId) return null
  const name = field ?? entry.fields.find((f) => f.kind === 'authored')?.name
  if (!name) return null
  return factSheetForEntryField(section, targetId, name)
}

async function rateDecision(db: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - rateLedgerWindowMs()).toISOString()
  const { data, error } = await db
    .from('resume_ai_usage')
    .select('created_at')
    .eq('user_id', userId)
    // The Personal Statement Analyzer namespaces its own rows into this table
    // (see lib/statement/usage.ts). They are a different feature with a
    // different, tighter budget, so they must not count against the resume
    // ceiling -- without this, analysing an essay would quietly consume a
    // resume AI allowance the applicant never spent.
    .not('operation', 'like', STATEMENT_OPERATION_PATTERN)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    // Fail CLOSED on an unreadable ledger. An abuse control that opens when its
    // own storage misbehaves is not a control.
    console.error('resume-v2 propose: usage ledger unreadable', error.code, error.message)
    return { allowed: false as const, retryAfterSeconds: 30, message: 'Too many requests just now. Please try again shortly.' }
  }

  const recent = (data ?? []).map((row) => Date.parse((row as { created_at: string }).created_at))
  return checkAiRate(recent.filter((at) => Number.isFinite(at)), Date.now(), AI_RATE_LIMITS)
}

async function recordAttempt(
  db: SupabaseClient,
  command: { resumeId: string; operation: AiOperation }
): Promise<string | null> {
  const { data, error } = await db.rpc('record_ai_usage', {
    p_resume_id: command.resumeId,
    p_operation: command.operation,
    p_outcome: 'attempted',
  })
  if (error) {
    console.error('resume-v2 propose: could not record usage', error.code, error.message)
    return null
  }
  return typeof data === 'string' ? data : null
}

async function settle(db: SupabaseClient, usageId: string | null, outcome: string): Promise<void> {
  if (!usageId) return
  const { error } = await db.rpc('settle_ai_usage', { p_id: usageId, p_outcome: outcome })
  if (error) console.error('resume-v2 propose: could not settle usage', error.code, error.message)
}
