import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import OpenAI from 'openai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { BLOCKED_BODY, UNAUTHORIZED_BODY, resumeV2Access } from '@/lib/resume/gate'
import { resumeBuilderMode } from '@/lib/resume/rollout'
import {
  AI_RATE_LIMITS, RATE_LIMIT_CODE, checkAiRate, decideCreateResume, rateLedgerWindowMs,
} from '@/lib/resume/entitlement'
import { createResumeRows, listResumes } from '@/lib/resume/repo/resumeRepo'
import {
  IMAGE_ONLY_CODE, IMAGE_ONLY_MESSAGE, MAX_UPLOAD_BYTES, checkPaste, checkUpload,
} from '@/lib/resume/import/upload'
import { sourceFromDocx, sourceFromPdf, sourceFromText } from '@/lib/resume/import/source'
import type { SourceDocument } from '@/lib/resume/import/source'
import {
  hasSomethingToCreate, parseConfirmRequest, toReviewPayload,
} from '@/lib/resume/import/review'
import { buildImportPlan, buildOrganiserPrompt, parseOrganised } from '@/lib/resume/import/organise'
import { draftFromPlan } from '@/lib/resume/import/draft'

/**
 * Upload an existing resume, or paste its text. Two steps, never one.
 *
 *   ANALYSE  -> extract, organise, verify, and return a review. Creates
 *              nothing. Consumes no resume slot.
 *   REVIEW   -> the applicant looks at what was found and what was not.
 *   CREATE   -> only on explicit confirmation. Re-checks the limit, re-traces
 *              every value, then writes the draft.
 *
 * WHY THE SPLIT. Creating first and reviewing afterwards spends a Free user's
 * only resume slot on a result they have not seen, and leaves nothing to
 * cancel -- the resume already exists. Splitting it means abandoning a review
 * costs exactly nothing.
 *
 * NOTHING IS PERSISTED BETWEEN THE TWO. The reviewed plan lives in the browser
 * and comes back on confirmation, where `buildImportPlan` traces it against the
 * source again. That function is pure, so the second run reproduces the first
 * verdict exactly -- which is what makes the round trip safe without a
 * server-side draft or a temporary row holding resume text. A tampered payload
 * simply fails to trace, and a tampered source is the applicant pasting their
 * own text, which the paste path already allows.
 *
 * THE ORDER WITHIN ANALYSE IS ALSO THE DESIGN.
 *
 *   1. Authenticate, then the V2 gate.
 *   2. The RESUME LIMIT, before a single expensive thing happens. Nobody pays
 *      for extraction and an AI call they could not have used.
 *   3. Extract. A scanned PDF is refused here, not OCR'd.
 *   4. Fingerprint, and stop if this user already imported this exact document.
 *      Scoped to the caller by RLS, so it can never reveal anyone else.
 *   5. The invisible rate ceiling, then the organiser.
 *   6. Trace every value back to the source, discarding what is not there.
 *
 * THE FILE DOES NOT SURVIVE THE REQUEST. Bytes are read into text and dropped.
 * Nothing reaches storage, because there is no storage: the ledger keeps a
 * fingerprint, which cannot be read back into a document.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const MODEL = process.env.RESUME_AI_MODEL || 'gpt-4o'
const PARSE_TIMEOUT_MS = 45_000

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

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  // The body can only be read once, so it is read here and handed on.
  const contentType = request.headers.get('content-type') ?? ''
  const json = contentType.includes('application/json')
    ? await request.json().catch(() => null)
    : null

  if ((json as { action?: unknown } | null)?.action === 'create') {
    return confirmImport(db, auth.userId, auth.tier, json)
  }
  return analyseImport(db, auth.userId, auth.tier, request, json)
}

// ---------------------------------------------------------------------------
// Analyse -- creates nothing
// ---------------------------------------------------------------------------

async function analyseImport(
  db: SupabaseClient,
  userId: string,
  tier: string,
  request: NextRequest,
  json: unknown
): Promise<NextResponse> {
  // 2. The limit, before anything expensive. Checked again on confirmation,
  //    because minutes of reading can pass in between.
  const room = await roomForAnother(db, userId, tier)
  if (room instanceof NextResponse) return room

  // 3. Extract.
  let source: SourceDocument
  try {
    const extracted = await withTimeout(extractSource(request, json), PARSE_TIMEOUT_MS)
    if (!extracted.ok) {
      await record(db, extracted.format, '', 'refused', extracted.code)
      return NextResponse.json(
        { error: extracted.code, message: extracted.message },
        { status: extracted.code === 'too-large' ? 413 : 400 }
      )
    }
    source = extracted.source
  } catch (error) {
    console.error('resume-v2 import: extraction failed', (error as { name?: string })?.name)
    return NextResponse.json(
      { error: 'extraction-failed', message: 'That file could not be read. Try pasting the text instead.' },
      { status: 422 }
    )
  }

  // 4. Already imported this exact document?
  const duplicate = await priorImport(db, userId, source.fingerprint)
  if (duplicate) {
    return NextResponse.json({
      duplicate: true,
      resumeId: duplicate,
      message:
        'You have already imported this document, so we have opened the resume it created. ' +
        'If you want a second version to tailor differently, use Duplicate on that resume — ' +
        'it is faster than importing again and keeps the work you have already done.',
    })
  }

  const importId = await record(db, source.format, source.fingerprint, 'attempted', null)

  // 5. Rate ceiling, then the organiser.
  const rate = await rateDecision(db, userId)
  if (!rate.allowed) {
    await settle(db, importId, { outcome: 'failed', refusalCode: RATE_LIMIT_CODE })
    return NextResponse.json(
      { error: RATE_LIMIT_CODE, message: rate.message },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
    )
  }

  if (!process.env.OPENAI_API_KEY) {
    await settle(db, importId, { outcome: 'failed', refusalCode: 'ai-unavailable' })
    return NextResponse.json({ error: 'ai-unavailable' }, { status: 503 })
  }

  let organisedRaw: string
  try {
    const { system, user } = buildOrganiserPrompt(source)
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      max_tokens: 4_000,
      response_format: { type: 'json_object' },
    })
    organisedRaw = response.choices[0]?.message?.content ?? ''
  } catch (error) {
    console.error('resume-v2 import: organiser failed', (error as { name?: string })?.name)
    await settle(db, importId, { outcome: 'failed', refusalCode: 'ai-failed' })
    return NextResponse.json({ error: 'ai-failed' }, { status: 502 })
  }

  // 6. Trace everything back to the source. STOP HERE: no draft, no slot.
  const plan = buildImportPlan(parseOrganised(organisedRaw), source)
  await settle(db, importId, {
    outcome: 'attempted',
    mapped: plan.mapped.length,
    uncertain: plan.uncertain.length,
    unmapped: plan.unmapped.length,
    rejected: plan.rejected.length,
  })

  if (!hasSomethingToCreate(plan)) {
    return NextResponse.json({
      error: 'nothing-found',
      message:
        'Nothing in that document could be matched to a resume section. ' +
        'Try pasting the text instead, so we can read it directly.',
    }, { status: 422 })
  }

  // The payload is the FILTERED plan. The model's own reply never leaves here.
  return NextResponse.json({ review: toReviewPayload(plan, source, importId ?? '') })
}

// ---------------------------------------------------------------------------
// Create -- only on explicit confirmation
// ---------------------------------------------------------------------------

async function confirmImport(
  db: SupabaseClient,
  userId: string,
  tier: string,
  json: unknown
): Promise<NextResponse> {
  const parsed = parseConfirmRequest(json)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const command = parsed.value

  // The importId must be the caller's own. RLS already scopes the read; the
  // explicit filter says so in code as well.
  const ledger = await readImport(db, userId, command.importId)
  if (!ledger) return NextResponse.json({ error: 'not-found' }, { status: 404 })

  // IDEMPOTENT. A double submission, a retried request or a refreshed tab
  // returns the resume that was already made rather than making a second one.
  if (ledger.outcome === 'created' && ledger.resumeId) {
    return NextResponse.json({ resumeId: ledger.resumeId, alreadyCreated: true })
  }

  const room = await roomForAnother(db, userId, tier)
  if (room instanceof NextResponse) return room

  // Re-traced, not trusted. NO SECOND MODEL CALL: `buildImportPlan` is pure and
  // free, and running it again over the same source reproduces the verdict the
  // applicant reviewed. Anything tampered with in between fails to trace and is
  // dropped exactly as it would have been the first time.
  const source = sourceFromText(command.sourceText, command.format)
  const plan = buildImportPlan(parseOrganised(command.organised), source)

  if (!hasSomethingToCreate(plan)) {
    return NextResponse.json({ error: 'nothing-found' }, { status: 422 })
  }

  const resumeId = randomUUID()
  const draft = draftFromPlan({
    plan,
    userId,
    title: plan.organised.contact.fullName
      ? `${plan.organised.contact.fullName} — imported`
      : 'Imported resume',
    ids: { resumeId, pool: Array.from({ length: 400 }, () => randomUUID()) },
    now: new Date().toISOString(),
    importedFrom: {
      importId: command.importId,
      sourceFormat: source.format === 'paste' ? 'pdf' : source.format,
      documentFingerprint: source.fingerprint,
      importedAt: new Date().toISOString(),
      originalRetained: false,
    },
  })

  const created = await createResumeRows(db, draft)
  if (!created.ok) {
    // The ledger stays 'attempted', so the document remains re-importable.
    console.error('resume-v2 import: draft creation failed', created.reason, created.detail)
    return NextResponse.json({ error: created.reason }, { status: 500 })
  }

  await settle(db, command.importId, {
    outcome: 'created',
    resumeId,
    mapped: plan.mapped.length,
    uncertain: plan.uncertain.length,
    unmapped: plan.unmapped.length,
    rejected: plan.rejected.length,
  })

  return NextResponse.json({ resumeId })
}

/** The resume limit, taken server-side. Used by both steps. */
async function roomForAnother(
  db: SupabaseClient,
  userId: string,
  tier: string
): Promise<NextResponse | null> {
  const existing = await listResumes(db, userId)
  if (!existing.ok) {
    console.error('resume-v2 import: count failed', existing.reason, existing.detail)
    return NextResponse.json({ error: 'read-failed' }, { status: 500 })
  }
  const room = decideCreateResume({ tier, currentCount: existing.value.length })
  if (!room.allowed) {
    return NextResponse.json({ error: room.code, message: room.message }, { status: 403 })
  }
  return null
}

/** One import row, the caller's own. Also the idempotency lookup. */
async function readImport(
  db: SupabaseClient,
  userId: string,
  importId: string
): Promise<{ outcome: string; resumeId: string | null } | null> {
  const { data, error } = await db
    .from('resume_imports')
    .select('outcome, resume_id')
    .eq('id', importId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as { outcome: string; resume_id: string | null }
  return { outcome: row.outcome, resumeId: row.resume_id }
}

// ---------------------------------------------------------------------------

type Extracted =
  | { ok: true; source: SourceDocument }
  | { ok: false; code: string; message: string; format: 'pdf' | 'docx' | 'paste'; fingerprint?: string }

/** Reads the request, whichever way the applicant chose to send their resume. */
async function extractSource(request: NextRequest, json: unknown): Promise<Extracted> {
  if (json !== null) {
    const text = (json as { text?: unknown } | null)?.text
    const check = checkPaste(typeof text === 'string' ? text : '')
    if (!check.ok) return { ok: false, code: check.code, message: check.message, format: 'paste' }
    return { ok: true, source: sourceFromText(text as string, 'paste') }
  }

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof Blob)) {
    return { ok: false, code: 'unrecognised-format', message: 'No file was uploaded.', format: 'paste' }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: 'too-large', message: 'That file is larger than 15 MB.', format: 'pdf' }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  // The format comes from the file's own signature, never its name or the MIME
  // type the browser volunteered.
  const check = checkUpload(bytes)
  if (!check.ok) return { ok: false, code: check.code, message: check.message, format: 'pdf' }

  if (check.format === 'pdf') {
    const result = await sourceFromPdf(bytes)
    if (!result.ok) {
      return { ok: false, code: IMAGE_ONLY_CODE, message: IMAGE_ONLY_MESSAGE, format: 'pdf' }
    }
    return { ok: true, source: result.source }
  }

  const result = await sourceFromDocx(bytes)
  if (!result.ok) {
    return {
      ok: false, code: 'empty-text', format: 'docx',
      message: 'That Word document has no text in it. Paste your resume text instead.',
    }
  }
  return { ok: true, source: result.source }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('parse-timeout')), ms)),
  ])
}

/**
 * A previous successful import of the same document by THIS user.
 *
 * RLS scopes the read to the caller, and the query filters on their own id as
 * well, so a fingerprint can never be used to learn what anyone else uploaded.
 */
async function priorImport(
  db: SupabaseClient,
  userId: string,
  fingerprint: string
): Promise<string | null> {
  const { data, error } = await db
    .from('resume_imports')
    .select('resume_id')
    .eq('user_id', userId)
    .eq('document_fingerprint', fingerprint)
    .eq('outcome', 'created')
    .not('resume_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return null
  return (data[0] as { resume_id: string | null }).resume_id
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
    console.error('resume-v2 import: usage ledger unreadable', error.code, error.message)
    return {
      allowed: false as const, retryAfterSeconds: 30,
      message: 'Too many requests just now. Please try again shortly.',
    }
  }
  const recent = (data ?? [])
    .map((row) => Date.parse((row as { created_at: string }).created_at))
    .filter((at) => Number.isFinite(at))
  return checkAiRate(recent, Date.now(), AI_RATE_LIMITS)
}

async function record(
  db: SupabaseClient,
  format: string,
  fingerprint: string,
  outcome: string,
  refusalCode: string | null
): Promise<string | null> {
  const { data, error } = await db.rpc('record_resume_import', {
    p_source_format: format,
    p_fingerprint: fingerprint,
    p_outcome: outcome,
    p_refusal_code: refusalCode,
  })
  if (error) {
    console.error('resume-v2 import: could not record', error.code, error.message)
    return null
  }
  return typeof data === 'string' ? data : null
}

async function settle(
  db: SupabaseClient,
  importId: string | null,
  result: {
    outcome: string
    resumeId?: string
    refusalCode?: string
    mapped?: number
    uncertain?: number
    unmapped?: number
    rejected?: number
  }
): Promise<void> {
  if (!importId) return
  const { error } = await db.rpc('settle_resume_import', {
    p_id: importId,
    p_outcome: result.outcome,
    p_resume_id: result.resumeId ?? null,
    p_refusal_code: result.refusalCode ?? null,
    p_mapped_count: result.mapped ?? null,
    p_uncertain_count: result.uncertain ?? null,
    p_unmapped_count: result.unmapped ?? null,
    p_rejected_count: result.rejected ?? null,
  })
  if (error) console.error('resume-v2 import: could not settle', error.code, error.message)
}
