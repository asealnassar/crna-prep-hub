import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import {
  STATEMENT_STUDIO_HIDDEN_BODY, statementStudioAccess, statementStudioMode,
} from '@/lib/statement/studioGate'
import {
  PROMPT_SELECTION_KEY, checkDraftCreate, createPromptSelectionOf, requirementSelectionOf,
} from '@/lib/statement/draft/validate'
import { checkPromptSubmission } from '@/lib/statement/draft/promptSubmission'
import { createDraftWithSubmission, verifySchoolListed } from '@/lib/statement/draft/submissionRepo'
import { promptSubmissionsEnabled, requirementsEnabled } from '@/lib/statement/draft/rollout'
import { readActiveRequirement } from '@/lib/statement/requirements/repo'
import { snapshotOf } from '@/lib/statement/requirements/snapshot'
import { createDraft, listDrafts } from '@/lib/statement/draft/draftRepo'
import type { StatementPromptSnapshot } from '@/lib/statement/draft/promptRepo'
import { readActivePrompt } from '@/lib/statement/draft/promptRepo'
import {
  MALFORMED_JSON_BODY, NOT_AN_OBJECT_BODY, SERVER_ERROR_BODY, UNAUTHENTICATED_BODY,
  checkBodyShape, isServerFault, promptRefusalBody, publicDraft, statusForPrompt,
  statusForRepo, statusForValidation, validationBody,
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
 *   1. THE STUDIO GATE. While STATEMENT_STUDIO_MODE is 'internal' this endpoint
 *      does not exist for anyone but an administrator.
 *   2. AUTHENTICATION, before the body is read and before any query.
 *   3. BODY, parsed and checked for being an object at all.
 *   4. VALIDATION, by checkDraftCreate -- not duplicated here.
 *   5. PERSISTENCE, by the repository.
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

/**
 * The three fixed answers the pasted-prompt branch can give.
 *
 * FIXED, like every other body in this family: a refusal's wording is ours, so
 * no database message, constraint text or function detail can reach a reader.
 * The 404 is the gate's own shape -- while the feature is off, this branch does
 * not exist, and saying so in any other words would advertise it.
 */
const SUBMISSION_UNAVAILABLE_BODY = { error: 'Not found', code: 'not-found' } as const
const SUBMISSION_REFUSED = 'That prompt could not be submitted.'
const SUBMISSION_RATE_LIMITED =
  'You have submitted several prompts recently. Try again a little later.'

type Caller = { userId: string; db: SupabaseClient }

/**
 * Applies the Studio gate, then authenticates and builds the caller-scoped
 * client. Or answers, having touched nothing.
 *
 * THE GATE IS FIRST, and it is the same decision the Studio page takes --
 * lib/statement/studioGate.ts, reading STATEMENT_STUDIO_MODE. Gating the page
 * alone would leave this endpoint open to any signed-in user, which is not what
 * "internal only" means.
 *
 * THE HIDDEN ANSWER IS STATEMENT_STUDIO_HIDDEN_BODY, the gate's own neutral
 * body, shared by all five Studio endpoints so that a blocked caller gets one
 * identical response whichever they probed. It is deliberately NOT this family's
 * draft not-found body, which means "you may use this, the row is not there" and
 * belongs only to a caller already admitted. There is no 403 anywhere: a 403
 * confirms both that the endpoint exists and that somebody else may use it.
 *
 * IDENTICAL TO THE ITEM ROUTE'S, deliberately -- a test asserts the two function
 * bodies are byte-for-byte the same. Both families must be gated the same way,
 * and the cheapest way to be sure of that is for there to be nothing to compare.
 *
 * The anon key plus the caller's own JWT, exactly as
 * app/api/resume-v2/draft/route.ts does, so RLS sees the real user. There is no
 * service-role client in this file and none is needed: every statement is one
 * the signed-in applicant may make about their own rows.
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

/**
 * What this create says about the prompt, ALREADY RESOLVED -- or a response
 * refusing it.
 *
 * THE ONLY FIELD READ IS promptId, and it is not read here:
 * createPromptSelectionOf() reads it, by the one key name validate.ts owns.
 * The canonical school, wording and word limit are never taken from a body --
 * they come out of the catalog under the caller's own client, or the create
 * does not happen. A browser naming them is naming keys nothing reads.
 *
 *   absent    a general statement. No catalog read at all, and createDraft is
 *             called with three arguments exactly as it always was.
 *   a uuid    this prompt. Resolved through the prompt repository, whose
 *             active-only filter decides what may still be chosen.
 *   anything  refused, null included: a create has no prompt to clear, so a
 *   else      null is a browser that meant to name one. Refusing is what stops
 *             a school-specific intention becoming a blank general draft.
 *
 * ONE READ AT MOST, and only for a real selection.
 */
async function createPromptFor(
  db: SupabaseClient,
  body: { readonly [key: string]: unknown },
): Promise<StatementPromptSnapshot | undefined | NextResponse> {
  const selection = createPromptSelectionOf(body)
  if (!selection.ok) {
    return NextResponse.json(
      promptRefusalBody(selection.code),
      { status: statusForPrompt(selection.code) },
    )
  }

  if (selection.selection.kind === 'none') return undefined

  const resolved = await readActivePrompt(db, selection.selection.promptId)
  if (resolved.ok) return resolved.value

  // UNKNOWN AND WITHDRAWN ARE ONE ANSWER, and 422 rather than 404: the request
  // was well formed and it is the selection that cannot be honoured. NO DRAFT
  // IS CREATED -- the caller asked for this school's question and would
  // otherwise be handed a blank statement they did not ask for.
  if (resolved.reason === 'not-found') {
    return NextResponse.json(
      promptRefusalBody('prompt-not-found'),
      { status: statusForPrompt('prompt-not-found') },
    )
  }

  // read-failed and data-integrity: this site failing, not the caller erring.
  // The existing generic answer, and `detail` -- a Postgres code and message --
  // is neither logged nor sent.
  return failed(resolved.reason)
}

/**
 * What a caller is told when a requirement selection cannot be honoured.
 *
 * ONE FIXED SENTENCE FOR EVERY REASON, with a machine code beside it. Whether
 * the id is unknown, withdrawn, or belongs to a set nobody has verified is not
 * an applicant's business and is not something to leak: they are all "this is
 * not available", and distinguishing them in the response would describe the
 * catalog's contents to anybody who asked.
 */
const REQUIREMENT_REFUSED = 'That writing requirement is not available.'

/** The flag is off, so the feature does not exist for this deployment. */
const REQUIREMENT_UNAVAILABLE_BODY = {
  error: 'School writing requirements are not available yet.',
  code: 'requirements-unavailable',
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

  // ---------------------------------------------------------------- pasted
  // A SCHOOL'S QUESTION THE CATALOG DOES NOT HAVE YET.
  //
  // GATED, AND OFF BY DEFAULT. Until 20261002_000..003 are applied there is no
  // submissions table and no function to call, so with the flag unset this
  // branch is not entered and the body key is simply never read -- the route
  // behaves exactly as it did before this feature existed.
  //
  // THIS IS NOT THE promptId BRANCH, and the two can never be reached by one
  // request: the pasted path is taken first and returns, so a body carrying
  // both a submission and a promptId never reaches the resolver. A pasted
  // prompt must not travel the path that means "the catalog vouches for this".
  const pasted = (shape.body as { promptSubmission?: unknown }).promptSubmission
  if (pasted !== undefined) {
    if (!promptSubmissionsEnabled()) {
      return NextResponse.json(SUBMISSION_UNAVAILABLE_BODY, { status: 404 })
    }

    // The whole object is handed to the validator and the result is never
    // destructured here, so this file still names no canonical prompt field.
    const submission = checkPromptSubmission(pasted as Record<string, unknown>)
    if (!submission.ok) {
      return NextResponse.json(
        { error: SUBMISSION_REFUSED, code: submission.code },
        { status: 400 },
      )
    }

    // The school must be one the directory actually lists. Checked before any
    // write, so a submission naming a school nobody was offered creates nothing.
    const listed = await verifySchoolListed(caller.db, submission.input)
    if (!listed.ok) {
      if (listed.reason === 'invalid') {
        // A DISTINCT CODE FROM THE CATALOG ENDPOINT'S, which reports a
        // malformed uuid in a query string. This reports the opposite kind of
        // thing: a well-formed id naming a school the directory does not list.
        // Two conditions, two words -- and this file deliberately does not
        // spell the other endpoint's code, because naming it is how a route
        // starts knowing about an endpoint it has no business knowing.
        return NextResponse.json(
          { error: SUBMISSION_REFUSED, code: 'school-not-listed' },
          { status: 400 },
        )
      }
      return NextResponse.json(SERVER_ERROR_BODY, { status: 500 })
    }

    // ONE TRANSACTION. Both rows or neither -- see 20261002_003.
    const made = await createDraftWithSubmission(caller.db, {
      title: checked.input.title,
      essay: checked.input.essay,
      ...submission.input,
    })
    if (!made.ok) {
      if (made.reason === 'rate-limited') {
        return NextResponse.json(
          { error: SUBMISSION_RATE_LIMITED, code: 'rate-limited' },
          { status: 429 },
        )
      }
      if (made.reason === 'invalid') {
        return NextResponse.json(
          { error: SUBMISSION_REFUSED, code: 'invalid-submission' },
          { status: 400 },
        )
      }
      return NextResponse.json(SERVER_ERROR_BODY, { status: 500 })
    }

    return NextResponse.json(
      { draft: publicDraft(made.value.draft), submissionId: made.value.submissionId },
      { status: 201 },
    )
  }

  // ------------------------------------------------- a structured requirement
  // A SCHOOL'S SEPARATE WRITING DOCUMENT, chosen from the requirement catalog.
  //
  // GATED, AND OFF BY DEFAULT. Until 20261002_005 is applied there are no
  // requirement tables and no requirement columns on statement_drafts, so with
  // the flag unset this branch answers 404 and the body key is never read --
  // the route behaves exactly as it does today for every other request.
  //
  // THE BODY SENDS ONE ID AND NOTHING ELSE. requirementSelectionOf() reads a
  // single key; the document type, label, wording, every limit, the chosen
  // alternative and the provenance all come out of the catalog under the
  // caller's own client. A body carrying `requirementSnapshot` or a fabricated
  // `verification` object reaches nothing, because nothing reads those keys.
  const requirementChoice = requirementSelectionOf(shape.body)
  if (!requirementChoice.ok) {
    return NextResponse.json(
      { error: REQUIREMENT_REFUSED, code: requirementChoice.code },
      { status: 400 },
    )
  }

  if (requirementChoice.requirementId !== null) {
    if (!requirementsEnabled()) {
      return NextResponse.json(REQUIREMENT_UNAVAILABLE_BODY, { status: 404 })
    }

    // TWO SOURCES FOR ONE QUESTION IS A BUG, NOT A MERGE. A body naming both a
    // prompt and a requirement cannot be honoured: they write the same three
    // columns from different catalogs. Refused before any read.
    if (shape.body[PROMPT_SELECTION_KEY] !== undefined) {
      return NextResponse.json(
        { error: REQUIREMENT_REFUSED, code: 'prompt-and-requirement' },
        { status: 400 },
      )
    }

    const resolved = await readActiveRequirement(caller.db, requirementChoice.requirementId)
    if (!resolved.ok) {
      // UNKNOWN, WITHDRAWN AND UNVERIFIED ARE ONE ANSWER, and 422 rather than
      // 404: the request was well formed and the selection cannot be honoured.
      // RLS admits a requirement only when its set is active, and the
      // migration's CHECK makes an active set a verified one with a source and
      // a date -- so "not-found" here covers a requirement that exists but is
      // not fit to be shown to an applicant. NO DRAFT IS CREATED.
      if (resolved.reason === 'not-found' || resolved.reason === 'disabled') {
        return NextResponse.json(
          { error: REQUIREMENT_REFUSED, code: 'requirement-not-found' },
          { status: 422 },
        )
      }
      return NextResponse.json(SERVER_ERROR_BODY, { status: 500 })
    }

    // FROZEN FROM THE CATALOG'S OWN ROW. snapshotOf needs a schoolName for the
    // set type and the draft never stores one, so the resolved set is widened
    // with an empty name rather than the route inventing a school's name.
    const snapshot = snapshotOf(
      { ...resolved.value.set, schoolName: '', requirements: [] },
      resolved.value.requirement,
    )

    const born = await createDraft(
      caller.db, caller.userId, checked.input, undefined, snapshot)
    if (!born.ok) return failed(born.reason)
    return NextResponse.json({ draft: publicDraft(born.value) }, { status: 201 })
  }

  // THE PROMPT IS RESOLVED AFTER THE TITLE, cheapest first and matching the
  // gate order above: a body that could never be saved costs no catalog read.
  const prompt = await createPromptFor(caller.db, shape.body)
  if (prompt instanceof NextResponse) return prompt

  // The user id is the SESSION's, never the body's.
  //
  // A GENERAL CREATE TAKES THE PATH IT TOOK BEFORE ANY OF THIS EXISTED --
  // three arguments, no fourth -- so there is no new way for an ordinary draft
  // to go wrong. The same arrangement the item route uses for PATCH.
  const created = prompt === undefined
    ? await createDraft(caller.db, caller.userId, checked.input)
    : await createDraft(caller.db, caller.userId, checked.input, prompt)
  if (!created.ok) return failed(created.reason)

  return NextResponse.json({ draft: publicDraft(created.value) }, { status: 201 })
}
