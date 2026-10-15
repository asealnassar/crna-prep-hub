import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { statementDbClient } from '@/lib/statement/devMode/guardedClient'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import {
  STATEMENT_STUDIO_HIDDEN_BODY, statementStudioAccess, statementStudioMode,
} from '@/lib/statement/studioGate'
import { listActivePrompts } from '@/lib/statement/draft/promptRepo'
import {
  SERVER_ERROR_BODY, UNAUTHENTICATED_BODY, UUID, isServerFault, statusForRepo,
} from '@/lib/statement/draft/http'

/**
 * The active prompts one school offers. GET only.
 *
 * WIRING ONLY, for the same reasons as the draft routes beside it: the query
 * lives in lib/statement/draft/promptRepo.ts and is unit-tested without a
 * request. This file never names the table and issues no statement of its own.
 *
 * THE GATE IS WHY THIS ENDPOINT EXISTS AT ALL. public.statement_prompts has a
 * deliberately permissive read path -- `grant select to anon, authenticated`
 * plus a `using (is_active)` policy -- so a browser could read the catalog
 * directly with the anon key. That is fine for the data and wrong for the
 * product: while STATEMENT_STUDIO_MODE is 'internal', Statement Studio does not
 * exist for anyone but an administrator, and a picker fed by a direct Supabase
 * read would be the one Studio data path not behind that gate. Routing the
 * catalog through here keeps the whole feature's visibility in one decision.
 *
 * NOTHING HERE IS A WRITE. The catalog has no write policy and no write grant,
 * and this file issues no insert, update, upsert or delete. The admin write
 * path is a separate, later, deliberately designed checkpoint.
 *
 * ORDER OF GATES, cheapest first, matching the draft routes:
 *
 *   1. THE STUDIO GATE, before anything else.
 *   2. AUTHENTICATION, before the query string is read and before any query.
 *   3. THE SCHOOL ID, validated BEFORE the database is touched.
 *   4. THE READ, by the repository -- not duplicated here.
 *
 * NOTHING INTERNAL IS RETURNED. A repository refusal's `detail` is a Postgres
 * code and message, or a fixed phrase about an unusable row; neither is put in
 * a response and neither is logged. 5xx bodies are a constant.
 */

export const dynamic = 'force-dynamic'

type Caller = { userId: string; db: SupabaseClient }

/**
 * Applies the Studio gate, then authenticates and builds the caller-scoped
 * client. Or answers, having touched nothing.
 *
 * BYTE-FOR-BYTE THE DRAFT ROUTES' admit(), and a test holds it that way. All
 * Studio endpoints must be gated the same way, and the cheapest way to be sure
 * of that is for there to be nothing to compare. The anon key plus the caller's
 * own JWT, so RLS sees the real user; there is no service-role client in this
 * file and none is needed, because the catalog is reference data the signed-in
 * applicant is entitled to read.
 */
async function admit(): Promise<Caller | NextResponse> {
  // 1. The rollout state, read once for this request.
  const mode = statementStudioMode()

  // 2-3. Who is calling, and whether they are an administrator.
  const auth = await authenticateRequest()

  // 4. The same decision app/statement-studio/[id]/page.tsx takes.
  const access = statementStudioAccess({
    isAdmin: isAdminEmail(auth?.email),
    isAuthenticated: auth !== null,
    mode,
  })

  // 5-6. A blocked caller is answered HERE: no token is read, no client is
  // built, and the repository is never reached.
  if (!access.allowed) {
    const body = access.reason === 'hidden' ? STATEMENT_STUDIO_HIDDEN_BODY : UNAUTHENTICATED_BODY
    return NextResponse.json(body, { status: access.status })
  }

  // Unreachable while the gate requires authentication. Kept so that a change
  // to the gate cannot quietly produce an anonymous caller below this line.
  if (!auth) return NextResponse.json(STATEMENT_STUDIO_HIDDEN_BODY, { status: 404 })

  // 7. Only now.
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

/**
 * The one refusal this endpoint can produce on its own.
 *
 * DECLARED HERE RATHER THAN IN http.ts, and only because this checkpoint's
 * scope is these two files. It belongs beside INVALID_ID_BODY and should move
 * there when http.ts is next opened; the shape is deliberately identical to its
 * neighbours so that moving it is a cut and paste.
 *
 * IT SAYS NOTHING ABOUT THE SCHOOL. Not whether the id exists, not whether the
 * directory has one like it -- only that the value supplied is not usable. The
 * caller sent it, so there is nothing to tell them they do not already know.
 */
const INVALID_SCHOOL_BODY = {
  error: 'That school is not one this editor can look up.',
  code: 'invalid-school',
} as const

/**
 * The school id from the query string, or a response refusing it.
 *
 * EXACTLY ONE PARAMETER. `getAll` rather than `get`, because `get` silently
 * returns the first of several -- so `?schoolId=mine&schoolId=theirs` would
 * read as a well-formed request for the first one, and a caller could not tell
 * which was honoured. Zero and two are both refusals.
 *
 * VALIDATED BEFORE ANY QUERY, for the same reason the draft routes check their
 * path id first: Postgres casts this value to uuid, so a malformed one reaching
 * the database is a 22P02 cast error -- a 500 for what is plainly a bad request.
 *
 * `UUID` IS THE SHARED PATTERN, used directly. isDraftId() and isPromptId() are
 * the same predicate under caller-specific names, and a school id is neither a
 * draft nor a prompt; borrowing either name here would make a reader look for a
 * relationship that is not there.
 *
 * A VALID ID WITH NO ACTIVE PROMPTS IS NOT A VALIDATION FAILURE. It is an empty
 * list, which is a successful answer -- see GET below.
 */
function schoolIdOf(request: NextRequest): string | NextResponse {
  const supplied = request.nextUrl.searchParams.getAll('schoolId')
  if (supplied.length !== 1) return NextResponse.json(INVALID_SCHOOL_BODY, { status: 400 })

  const schoolId = supplied[0]
  if (!UUID.test(schoolId)) return NextResponse.json(INVALID_SCHOOL_BODY, { status: 400 })
  return schoolId
}

/**
 * A repository refusal as a response.
 *
 * THE REASON IS LOGGED, THE DETAIL IS NOT, exactly as the draft routes do it.
 * `detail` carries a Postgres code and message, and a CHECK violation message
 * can quote the value that violated it -- which here is a school's wording. An
 * operator still learns which operation failed.
 *
 * BOTH REFUSALS ARE 500. 'read-failed' is the database or network having
 * failed; 'data-integrity' is a stored row this application cannot interpret.
 * Neither is the caller's fault and neither is described to them.
 * listActivePrompts cannot return 'not-found' -- an empty catalog is a success
 * -- so there is no 404 branch to write.
 */
function failed(reason: Parameters<typeof statusForRepo>[0]): NextResponse {
  const status = statusForRepo(reason)
  if (isServerFault(reason)) console.error('statement prompts: failed —', reason)
  return NextResponse.json(SERVER_ERROR_BODY, { status })
}

/**
 * Lists one school's active prompts. Reference data only -- no draft, no essay
 * and no applicant information passes through here.
 *
 * AN EMPTY ARRAY IS A 200. A school that has published no prompt, and a catalog
 * that is empty because nothing has been seeded, are both legitimate answers;
 * the catalog was empty at its last production check, so this is the common
 * case today. Answering 404 would make a picker show an error where the honest
 * answer is "none listed".
 *
 * THE ORDER IS THE REPOSITORY'S. display_order, then label, then id -- decided
 * by the query so the list cannot shuffle between two renders. This file does
 * not re-sort, and it does not reshape the options: what the reader returned is
 * what goes out, so a field cannot be added to a response by being added here.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  const schoolId = schoolIdOf(request)
  if (schoolId instanceof NextResponse) return schoolId

  // THE CALLER'S OWN CLIENT, so RLS decides what they may see and an inactive
  // prompt stays invisible rather than refused.
  const result = await listActivePrompts(caller.db, schoolId)
  if (!result.ok) return failed(result.reason)

  return NextResponse.json({ prompts: result.value })
}
