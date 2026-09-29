import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, readAccessToken } from '@/lib/apiAuth'
import { checkDraftCreate } from '@/lib/statement/draft/validate'
import { createDraft, listDrafts } from '@/lib/statement/draft/draftRepo'
import {
  MALFORMED_JSON_BODY, NOT_AN_OBJECT_BODY, SERVER_ERROR_BODY, UNAUTHENTICATED_BODY,
  checkBodyShape, isServerFault, publicDraft, statusForRepo, statusForValidation,
  validationBody,
} from '@/lib/statement/draft/http'

/**
 * The statement draft collection. GET lists, POST creates.
 *
 * WIRING ONLY. What may be saved is decided by lib/statement/draft/validate.ts,
 * how it is saved by draftRepo.ts, and which status a refusal earns by http.ts.
 * Each is unit-tested without a request. What remains here is authentication,
 * body reading, and calling the three in order.
 *
 * THIS FILE NEVER TOUCHES THE TABLE. There is no `db.from('statement_drafts')`
 * anywhere in it; every statement is issued by draftRepo, which is the only
 * module that knows the table exists.
 *
 * ORDER OF GATES, cheapest first, matching /api/statement/extract:
 *
 *   1. AUTHENTICATION, before the body is read and before any query.
 *   2. BODY, parsed and checked for being an object at all.
 *   3. VALIDATION, by checkDraftCreate -- not duplicated here.
 *   4. PERSISTENCE, by the repository.
 *
 * NOTHING FROM THE REQUEST DECIDES OWNERSHIP. `user_id` comes from the verified
 * session, never from the body, and RLS refuses any row whose owner is not the
 * caller even if that were bypassed. A body carrying `userId`, `id`, `revision`
 * or a timestamp is not rejected -- it is simply never read: checkDraftCreate
 * returns a normalised object of exactly `title` and `essay`, and that object is
 * what the repository receives.
 *
 * NOTHING INTERNAL IS RETURNED. A repository failure's `detail` is a Postgres
 * code and message; it is never put in a response. 5xx bodies are a constant.
 */

export const dynamic = 'force-dynamic'

type Caller = { userId: string; db: SupabaseClient }

/**
 * Authenticates and builds the caller-scoped client, or answers 401.
 *
 * The anon key plus the caller's own JWT, exactly as
 * app/api/resume-v2/draft/route.ts does, so RLS sees the real user. There is no
 * service-role client in this file and none is needed: every statement is one
 * the signed-in applicant may make about their own rows.
 */
async function admit(): Promise<Caller | NextResponse> {
  const auth = await authenticateRequest()
  if (!auth) return NextResponse.json(UNAUTHENTICATED_BODY, { status: 401 })

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
 * A repository refusal as a response.
 *
 * THE REASON IS LOGGED, THE DETAIL IS NOT. app/api/resume-v2/draft/route.ts logs
 * both, and its `detail` is a Postgres code and message for a resume row. Here
 * the row is somebody's personal statement, and a CHECK violation message can in
 * principle quote the value that violated it -- so only the fixed reason word is
 * logged. An operator still learns which operation failed.
 */
function failed(reason: Parameters<typeof statusForRepo>[0]): NextResponse {
  const status = statusForRepo(reason)
  if (isServerFault(reason)) console.error('statement drafts: failed —', reason)
  return NextResponse.json(SERVER_ERROR_BODY, { status })
}

/** Lists the caller's drafts. Metadata only -- no essay bodies leave here. */
export async function GET(): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  const result = await listDrafts(caller.db, caller.userId)
  if (!result.ok) return failed(result.reason)

  // The repository already returns summaries: five fields, no essay, no userId.
  return NextResponse.json({ drafts: result.value })
}

/** Creates a draft. 201 with the persisted row. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  // A body that is not JSON is the caller's mistake, not a crash.
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return NextResponse.json(MALFORMED_JSON_BODY, { status: 400 })
  }

  const shape = checkBodyShape(parsed)
  if (!shape.ok) return NextResponse.json(NOT_AN_OBJECT_BODY, { status: 400 })

  // The ONLY validation. Its result is a normalised { title, essay } and nothing
  // else from the body is carried forward.
  const checked = checkDraftCreate({ title: shape.body.title, essay: shape.body.essay })
  if (!checked.ok) {
    return NextResponse.json(
      validationBody(checked.code, checked.characters),
      { status: statusForValidation(checked.code) },
    )
  }

  // The user id is the SESSION's, never the body's.
  const created = await createDraft(caller.db, caller.userId, checked.input)
  if (!created.ok) return failed(created.reason)

  return NextResponse.json({ draft: publicDraft(created.value) }, { status: 201 })
}
