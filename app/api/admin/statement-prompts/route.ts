import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'
import { isSubmissionStatus } from '@/lib/statement/draft/promptSubmission'
import { decideSubmission, listSubmissionsForReview } from '@/lib/statement/draft/submissionRepo'
import { listSchoolPickerOptions } from '@/lib/statement/draft/schoolPicker'
import { promptSubmissionsEnabled } from '@/lib/statement/draft/rollout'

/**
 * Admin-only moderation of applicant-submitted school prompts.
 *
 * THE SAME SHAPE AS app/api/admin/reports/route.ts, deliberately: authenticate,
 * then authorize against the shared allowlist, and only THEN construct the
 * service-role client. Nothing privileged is built for a caller who has not
 * passed both, so an unauthorized request never reaches a client that could
 * bypass RLS.
 *
 * NO BROWSER FLAG DECIDES ANYTHING. isAdminEmail reads the verified session's
 * address, not a header, a body field or a cookie the caller controls. There is
 * no `isAdmin` in any request this route accepts.
 *
 * TWO INDEPENDENT BARRIERS ON THE CATALOG. This route is the only caller of
 * decide_statement_prompt_submission, and that function's EXECUTE is granted to
 * service_role alone -- so even a mistake here cannot be reached by a browser,
 * and even a stolen session cannot publish without the service key.
 *
 * THERE IS NO GENERAL-PURPOSE UPDATE. PATCH takes one of three decisions from a
 * fixed set and passes them to a function whose statements are fixed. The body
 * cannot name a column, so no other field of any table is writable from here.
 *
 * THE APPLICANT'S ESSAY IS NOWHERE IN THIS FILE. Moderation is about a question,
 * not about what anyone wrote in answer to it; statement_drafts is never read,
 * and `essay` appears in neither the query nor the response.
 */

export const dynamic = 'force-dynamic'

type Guard =
  | { ok: true; admin: SupabaseClient; reviewerId: string }
  | { ok: false; response: NextResponse }

async function requireAdmin(): Promise<Guard> {
  const auth = await authenticateRequest()
  if (!auth) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!isAdminEmail(auth.email)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  if (!promptSubmissionsEnabled()) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    console.error('Admin statement prompts: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return {
      ok: false,
      response: NextResponse.json({ error: 'Server configuration error' }, { status: 500 }),
    }
  }

  return {
    ok: true,
    reviewerId: auth.userId,
    admin: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DECISIONS = ['approved', 'rejected', 'duplicate'] as const
type Decision = (typeof DECISIONS)[number]

const isDecision = (value: unknown): value is Decision =>
  typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)

const optionalId = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null

const optionalText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/** The review queue, optionally narrowed to one status. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const asked = request.nextUrl.searchParams.get('status')
  const status = asked !== null && isSubmissionStatus(asked) ? asked : undefined

  const listed = await listSubmissionsForReview(guard.admin, { status })
  if (!listed.ok) {
    console.error('Admin statement prompts: list failed —', listed.reason)
    return NextResponse.json({ error: 'Could not load submissions' }, { status: 500 })
  }

  // THE SAME DIRECTORY THE PICKER OFFERS, not a second source of school names.
  // listSchoolPickerOptions reads three columns and is what the applicant saw
  // when they chose, so a reviewer and a submitter are looking at one list.
  //
  // A FAILED DIRECTORY READ DOES NOT FAIL THE QUEUE. Names are how a reviewer
  // recognises a school; ids are how the decision is applied. Losing the first
  // costs legibility, and the page falls back to showing the id.
  const schools = await listSchoolPickerOptions(guard.admin)
  return NextResponse.json({
    submissions: listed.value,
    schools: schools.ok ? schools.value : [],
    schoolsUnavailable: !schools.ok,
  })
}

/**
 * One decision. Approve, reject, or mark duplicate.
 *
 * NOTHING IS PUBLISHED AUTOMATICALLY. Approval requires a label an
 * administrator typed, so no path exists on which a submission becomes a
 * catalog row without a person having looked at it.
 *
 * CORRECTED WORDING IS PUBLISHED, THE ORIGINAL IS KEPT. `promptText` here is
 * what goes into the catalog; the submission row is never overwritten, so the
 * audit trail survives a typo fix.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const id = optionalId(body.id)
  if (!id) return NextResponse.json({ error: 'Invalid submission id' }, { status: 400 })
  if (!isDecision(body.decision)) {
    return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })
  }

  // A label is required to publish, and is checked here as well as inside the
  // function so an obviously incomplete request costs no round trip.
  const label = optionalText(body.label, 200)
  if (body.decision === 'approved' && label === null) {
    return NextResponse.json({ error: 'A catalog label is required' }, { status: 400 })
  }
  const duplicateOf = optionalId(body.duplicateOf)
  if (body.decision === 'duplicate' && duplicateOf === null) {
    return NextResponse.json({ error: 'A duplicate target is required' }, { status: 400 })
  }

  const decided = await decideSubmission(guard.admin, {
    submissionId: id,
    decision: body.decision,
    reviewerId: guard.reviewerId,
    label,
    promptText: optionalText(body.promptText, 5000),
    duplicateOf,
    supersedes: optionalId(body.supersedes),
    deactivateOld: body.deactivateOld === true,
    reviewNote: optionalText(body.reviewNote, 2000),
  })

  if (decided.ok) return NextResponse.json(decided.value)

  // A settled submission is reported, not re-decided. Two administrators
  // clicking at once, or one retrying after a timeout, both land here.
  if (decided.reason === 'already-decided') {
    return NextResponse.json({ error: 'That submission was already reviewed.' }, { status: 409 })
  }
  if (decided.reason === 'not-found') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (decided.reason === 'invalid') {
    return NextResponse.json({ error: 'That decision could not be applied.' }, { status: 400 })
  }
  console.error('Admin statement prompts: decide failed —', decided.reason)
  return NextResponse.json({ error: 'Could not apply that decision' }, { status: 500 })
}
