import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { statementDbClient } from '@/lib/statement/devMode/guardedClient'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import {
  STATEMENT_STUDIO_HIDDEN_BODY, statementStudioAccess, statementStudioMode,
} from '@/lib/statement/studioGate'
import { SERVER_ERROR_BODY, UNAUTHENTICATED_BODY } from '@/lib/statement/draft/http'
import { listOwnSubmissions, withdrawSubmission } from '@/lib/statement/draft/submissionRepo'
import { promptSubmissionsEnabled } from '@/lib/statement/draft/rollout'

/**
 * An applicant's OWN prompt submissions. GET lists them, PATCH withdraws one.
 *
 * WIRING ONLY, like every other Studio endpoint: what a submission is lives in
 * promptSubmission.ts, how it is read and written in submissionRepo.ts, and
 * what the database will permit in 20261002_000 and _003. What remains here is
 * the gate, the body, and calling those in order.
 *
 * NOBODY ELSE'S ROW IS REACHABLE, and that is not a promise this file makes --
 * it is one the database makes. Every statement runs on a caller-scoped client,
 * so the own-rows policy filters the result and a bug here could return fewer
 * rows than it should, never more. The reviewer's note and identity are not
 * merely left unselected: the applicant's SELECT grant does not include those
 * columns, so asking for them fails rather than succeeding quietly.
 *
 * THE ROLLOUT GATE ANSWERS WITH THE STUDIO'S OWN HIDDEN BODY, so a caller
 * probing this path while the feature is off learns exactly what they learn
 * from every other gated Studio endpoint: nothing.
 */

export const dynamic = 'force-dynamic'

type Caller = { userId: string; db: SupabaseClient }

/** The same shape as the drafts collection route's admit(), plus the flag. */
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

  // The feature's table does not exist until its migrations run. While it is
  // off, this endpoint is indistinguishable from one that was never built.
  if (!promptSubmissionsEnabled()) {
    return NextResponse.json(STATEMENT_STUDIO_HIDDEN_BODY, { status: 404 })
  }

  const token = await readAccessToken()
  if (!token) return NextResponse.json(UNAUTHENTICATED_BODY, { status: 401 })

  // THE VERIFIED SESSION'S OWN ANSWER, passed for simulated-live only: the
  // local stand-in for the submission functions has no auth.uid() to read.
  // Production ignores it. Nothing here comes from the request body.
  const db = statementDbClient(token, {
    userId: auth.userId,
    isAdmin: isAdminEmail(auth.email),
  })
  return { userId: auth.userId, db }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BAD_REQUEST = { error: 'Invalid request body', code: 'bad-request' } as const
const MISSING = { error: 'Not found', code: 'not-found' } as const

/** The caller's own submissions and their statuses. Never a reviewer's note. */
export async function GET(): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  const listed = await listOwnSubmissions(caller.db)
  if (!listed.ok) return NextResponse.json(SERVER_ERROR_BODY, { status: 500 })
  return NextResponse.json({ submissions: listed.value })
}

/**
 * Withdraw one. The only state change an applicant may make.
 *
 * NO BODY FIELD NAMES A STATUS. The action IS the endpoint, not a value the
 * caller chooses, so no request exists that could ask for 'approved' -- and if
 * one were somehow built, the function ignores everything but withdrawal and
 * the applicant holds no UPDATE privilege to fall back on.
 *
 * PUBLISHED CONTENT IS NOT WITHDRAWABLE HERE. The function moves a row only
 * while it is still pending; an approved submission has already produced a
 * catalog row other applicants may be using, and retracting that is a
 * moderation decision rather than a submitter's.
 *
 * THE DRAFT IS NEVER TOUCHED, here or in the function this calls. No statement
 * on this path mentions statement_drafts at all.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return NextResponse.json(BAD_REQUEST, { status: 400 })
  }
  const id = (parsed as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !ID.test(id)) {
    return NextResponse.json(BAD_REQUEST, { status: 400 })
  }

  const done = await withdrawSubmission(caller.db, id)
  if (done.ok) return NextResponse.json({ status: 'withdrawn' })

  // A submission that is not the caller's reads exactly as one that is absent.
  if (done.reason === 'not-found') return NextResponse.json(MISSING, { status: 404 })
  // Already decided is a SAFE answer to a retry, not a failure.
  if (done.reason === 'already-decided') {
    return NextResponse.json(
      { error: 'That submission has already been reviewed.', code: 'already-decided' },
      { status: 409 },
    )
  }
  return NextResponse.json(SERVER_ERROR_BODY, { status: 500 })
}
