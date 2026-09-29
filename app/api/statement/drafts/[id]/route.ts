import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, readAccessToken } from '@/lib/apiAuth'
import { checkDraftUpdate } from '@/lib/statement/draft/validate'
import { deleteDraft, readDraft, updateDraft } from '@/lib/statement/draft/draftRepo'
import {
  INVALID_ID_BODY, MALFORMED_JSON_BODY, NOT_AN_OBJECT_BODY, NOT_FOUND_BODY,
  SERVER_ERROR_BODY, UNAUTHENTICATED_BODY, checkBodyShape, conflictBody, isDraftId,
  isServerFault, publicDraft, statusForRepo, statusForValidation, validationBody,
} from '@/lib/statement/draft/http'

/**
 * One statement draft. GET reads, PATCH saves, DELETE removes.
 *
 * WIRING ONLY, for the same reasons as the collection route beside it: the rules
 * live in validate.ts, the statements in draftRepo.ts, the status table in
 * http.ts. This file never names the table.
 *
 * THE ID COMES FROM THE PATH, NEVER FROM THE BODY. A PATCH body carrying `id`
 * cannot redirect the write: checkDraftUpdate returns exactly
 * { title, essay, expectedRevision }, and the id passed to the repository is the
 * awaited path parameter. The same is true of `userId` and of any timestamp --
 * updateDraft generates `updated_at` itself and accepts none.
 *
 * NO OWNERSHIP CHECK HAPPENS HERE, deliberately. RLS decides what is visible, so
 * another user's draft and a draft that never existed are the same 404. Asking
 * the database "does this id exist for somebody else" and answering 403 would
 * confirm the id to someone with no claim to it.
 *
 * PARAMS ARE A PROMISE in Next 16 -- AppRouteHandlerFnContext declares
 * `params?: Promise<Record<string, string | string[] | undefined>>`, and
 * app/resume-studio/[id]/page.tsx already awaits its own. A param may therefore
 * be an array or absent, which is why the id is type-checked and not merely
 * pattern-matched.
 */

export const dynamic = 'force-dynamic'

type Caller = { userId: string; db: SupabaseClient }
type Context = { params: Promise<{ id: string }> }

/** Identical to the collection route's. Anon key plus the caller's JWT; no service role. */
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
 * 'conflict' is the one refusal that carries a value out: the stored revision,
 * which a client needs to resync. NOT the stored title or essay -- a caller who
 * lost the race is told the revision moved, not what it moved to.
 */
function failed(
  result: { reason: Parameters<typeof statusForRepo>[0]; storedRevision?: number },
): NextResponse {
  const status = statusForRepo(result.reason)

  if (result.reason === 'conflict' && typeof result.storedRevision === 'number') {
    return NextResponse.json(conflictBody(result.storedRevision), { status })
  }
  if (result.reason === 'not-found') {
    return NextResponse.json(NOT_FOUND_BODY, { status })
  }
  // Everything else. The reason is logged; `detail` -- a Postgres code and
  // message about a row that is somebody's essay -- is neither logged nor sent.
  if (isServerFault(result.reason)) console.error('statement drafts: failed —', result.reason)
  return NextResponse.json(SERVER_ERROR_BODY, { status })
}

/** The path id, or a response refusing it. Checked BEFORE any query is issued. */
async function draftIdOf(context: Context): Promise<string | NextResponse> {
  const params = await context.params
  const id = (params as { id?: unknown } | undefined)?.id
  if (!isDraftId(id)) return NextResponse.json(INVALID_ID_BODY, { status: 400 })
  return id
}

/** Reads one draft in full. Issues no write, so updated_at does not move. */
export async function GET(_request: NextRequest, context: Context): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  const id = await draftIdOf(context)
  if (id instanceof NextResponse) return id

  const result = await readDraft(caller.db, id)
  if (!result.ok) return failed(result)

  return NextResponse.json({ draft: publicDraft(result.value) })
}

/** Saves an edit, by compare-and-swap. 409 with the stored revision if stale. */
export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  const id = await draftIdOf(context)
  if (id instanceof NextResponse) return id

  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return NextResponse.json(MALFORMED_JSON_BODY, { status: 400 })
  }

  const shape = checkBodyShape(parsed)
  if (!shape.ok) return NextResponse.json(NOT_AN_OBJECT_BODY, { status: 400 })

  // ONLY `expectedRevision` is read. A body's `revision` is not a synonym for it
  // and is never looked at -- a caller that sends one gets 'invalid-revision',
  // because expectedRevision is absent.
  const checked = checkDraftUpdate({
    title: shape.body.title,
    essay: shape.body.essay,
    expectedRevision: shape.body.expectedRevision,
  })
  if (!checked.ok) {
    return NextResponse.json(
      validationBody(checked.code, checked.characters),
      { status: statusForValidation(checked.code) },
    )
  }

  // The PATH id, and the validator's normalised input. Nothing else from the body.
  const saved = await updateDraft(caller.db, id, checked.input)
  if (!saved.ok) return failed(saved)

  return NextResponse.json({ draft: publicDraft(saved.value) })
}

/** Deletes one draft. Explicit user deletion; no soft delete. */
export async function DELETE(_request: NextRequest, context: Context): Promise<NextResponse> {
  const caller = await admit()
  if (caller instanceof NextResponse) return caller

  const id = await draftIdOf(context)
  if (id instanceof NextResponse) return id

  const result = await deleteDraft(caller.db, id)
  if (!result.ok) return failed(result)

  return NextResponse.json({ id: result.value.id })
}
