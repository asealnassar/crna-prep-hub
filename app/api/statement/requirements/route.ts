import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import {
  STATEMENT_STUDIO_HIDDEN_BODY, statementStudioAccess, statementStudioMode,
} from '@/lib/statement/studioGate'
import { UNAUTHENTICATED_BODY } from '@/lib/statement/draft/http'
import { requirementsEnabled } from '@/lib/statement/draft/rollout'
import { listRequirementSets } from '@/lib/statement/requirements/repo'

/**
 * The structured school writing-requirement catalog, read by the New Draft
 * dialog.
 *
 * GATED THREE WAYS, AND THE ORDER MATTERS. The Studio gate first, exactly as
 * every other statement endpoint does it -- a blocked visitor is answered
 * before a token is read or a client is built. Then the rollout flag, because
 * until 20261002_005 is applied the tables do not exist and naming them would
 * fail the request rather than return nothing. Then RLS, which is the one that
 * actually decides WHICH rows come back.
 *
 * AND RLS IS WHAT MAKES THIS SAFE TO EXPOSE. The policy admits a requirement
 * only when its own is_active is true AND its set's is_active is true, and the
 * migration's CHECK makes an active set necessarily 'verified' with a source
 * URL and a date. So an unverified research entry cannot be returned by this
 * endpoint even if somebody inserted one: there is no query shape here that
 * reaches it, because the caller's client cannot see it.
 *
 * READ ONLY. One GET. No POST, no PATCH, no DELETE -- the catalog is written by
 * an operator in the SQL editor, and the migration grants browsers SELECT and
 * nothing else.
 *
 * THE RESEARCH FIXTURES ARE NOT SERVED HERE. They are TypeScript constants
 * behind a development-and-administrator preview; this endpoint reads the
 * database and nothing else, so the 83 researched programmes cannot reach an
 * applicant through it.
 */

/** Per-request by construction: the gate reads the session cookie. */
export const dynamic = 'force-dynamic'

interface Caller {
  readonly userId: string
  readonly db: SupabaseClient
}

/** A malformed or missing school id. The same shape the prompts endpoint uses. */
const INVALID_SCHOOL_BODY = {
  error: 'A single valid school id is required.',
  code: 'invalid-school',
}

/** The flag is off, so the feature does not exist for this deployment. */
const UNAVAILABLE_BODY = {
  error: 'School writing requirements are not available yet.',
  code: 'requirements-unavailable',
}

const SERVER_ERROR_BODY = { error: 'Something went wrong.', code: 'server-error' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The gate, BYTE-FOR-BYTE the prompts endpoint's.
 *
 * A test asserts the two function bodies are identical. Every statement
 * endpoint must be gated the same way, and the cheapest way to be sure of that
 * is for there to be nothing to compare.
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

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    },
  )
  return { userId: auth.userId, db }
}

/**
 * The school id, validated BEFORE the database is touched.
 *
 * EXACTLY ONE VALUE. `?schoolId=a&schoolId=b` is refused rather than silently
 * taking the first, because a caller sending two does not know what it is
 * asking and the answer would look authoritative anyway.
 */
function schoolIdOf(request: NextRequest): string | NextResponse {
  const supplied = request.nextUrl.searchParams.getAll('schoolId')
  if (supplied.length !== 1) return NextResponse.json(INVALID_SCHOOL_BODY, { status: 400 })

  const schoolId = supplied[0]
  if (!UUID.test(schoolId)) return NextResponse.json(INVALID_SCHOOL_BODY, { status: 400 })
  return schoolId
}

/**
 * One school's published, verified writing requirements.
 *
 * AN EMPTY ARRAY IS A SUCCESS, not a 404. A school with no researched
 * requirements is the overwhelmingly common case -- it is every school today --
 * and the dialog falls back to the statement_prompts catalog, which is the
 * shipped behaviour.
 *
 * THE SCHOOL NAME IS NOT SENT BACK. The caller already has it: it picked the
 * school from the directory it was given. Echoing a name read from a different
 * table would be this endpoint vouching for a join it did not make.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  // AFTER THE GATE, so an unadmitted visitor never learns whether the feature
  // exists, and BEFORE the school id, because a deployment without the tables
  // has nothing to say about any school.
  if (!requirementsEnabled()) {
    return NextResponse.json(UNAVAILABLE_BODY, { status: 404 })
  }

  const schoolId = schoolIdOf(request)
  if (schoolId instanceof NextResponse) return schoolId

  const result = await listRequirementSets(caller.db, schoolId, '')
  if (!result.ok) {
    // 'disabled' cannot be reached -- the flag was checked above -- and the
    // other two are this site failing rather than the caller erring. `detail`
    // is a Postgres code and message and is neither logged nor sent.
    console.error('statement requirements: failed —', result.reason)
    return NextResponse.json(SERVER_ERROR_BODY, { status: 500 })
  }

  return NextResponse.json({ sets: result.value })
}
