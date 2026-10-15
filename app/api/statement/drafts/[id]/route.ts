import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { statementDbClient } from '@/lib/statement/devMode/guardedClient'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import {
  STATEMENT_STUDIO_HIDDEN_BODY, statementStudioAccess, statementStudioMode,
} from '@/lib/statement/studioGate'
import { checkDraftUpdate, promptSelectionOf } from '@/lib/statement/draft/validate'
import {
  constrainDocument, documentMatchesEssay,
} from '@/lib/statement/layout/plainText'
import { EDITOR_DOCUMENT_VERSION } from '@/lib/statement/draft/editor'
import { studioFontFor } from '@/lib/statement/layout/studioFonts'
import { deleteDraft, readDraft, updateDraft } from '@/lib/statement/draft/draftRepo'
import type { PromptWrite } from '@/lib/statement/draft/draftRepo'
import { readActivePrompt } from '@/lib/statement/draft/promptRepo'
import {
  INVALID_ID_BODY, MALFORMED_JSON_BODY, NOT_AN_OBJECT_BODY, NOT_FOUND_BODY,
  SERVER_ERROR_BODY, UNAUTHENTICATED_BODY, checkBodyShape, conflictBody, isDraftId,
  isServerFault, promptRefusalBody, publicDraft, statusForPrompt, statusForRepo,
  statusForValidation, validationBody,
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
 * AND THE PROMPT IS THE SAME RULE AGAIN. A PATCH may name a prompt, by id, and
 * that is the whole of what a browser may say about one. The school, the wording
 * and the word limit are canonical: they come out of the catalog, through
 * promptRepo, with the caller's own client, and are snapshotted onto the draft
 * by updateDraft inside the one compare-and-swap. This file does not name those
 * three values anywhere -- a test asserts that -- so there is no code path on
 * which a request could supply them.
 *
 * ONE READ AT MOST, AND ONLY FOR A SELECTION. A body that says nothing about the
 * prompt reads no catalog and calls updateDraft with three arguments, exactly as
 * it did before any of this existed; an explicit clear reads no catalog either.
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

/**
 * Byte-for-byte the collection route's, and a test holds it that way.
 *
 * The Studio gate runs first, so while STATEMENT_STUDIO_MODE is 'internal' a
 * non-admin caller is answered with the gate's neutral hidden body -- before a
 * token is read, before a client is built, before any statement is issued. That
 * is a DIFFERENT body from the one failed() below sends for a draft this caller
 * may open but which does not exist; studioGate.ts says why the two must not be
 * merged. Anon key plus the caller's JWT; no service role.
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
  /*
    THE BODY WAS INCOMPLETE, SO IT GETS ITS OWN CODE AND SENTENCE.

    A formatted draft's save must carry its document; one that does not is
    refused rather than applied, because applying it lets the two
    representations diverge (AI-QA-001). Falling through to SERVER_ERROR_BODY
    paired a 422 with a 'server-error' code, which is neither true nor
    actionable -- the caller sent the wrong thing and can fix it.
  */
  if (result.reason === 'document-required') {
    return NextResponse.json({
      error: 'This draft keeps formatting, so a save has to include it. Reload the draft '
        + 'and try again.',
      code: 'document-required',
    }, { status })
  }
  // Everything else. The reason is logged; `detail` -- a Postgres code and
  // message about a row that is somebody's essay -- is neither logged nor sent.
  if (isServerFault(result.reason)) console.error('statement drafts: failed —', result.reason)
  return NextResponse.json(SERVER_ERROR_BODY, { status })
}

/**
 * What this request says about the prompt, already resolved -- or a response
 * refusing it.
 *
 * THE ONLY FIELD READ IS promptId, and it is not read here: promptSelectionOf()
 * in validate.ts reads it, from the one key it is allowed to read. The three
 * canonical values a prompt carries are never taken from a body. A request may
 * carry them and they reach nothing -- not validated and rejected, simply never
 * looked at, exactly as `userId` and `revision` already are not looked at.
 *
 * THE RETURN VALUE IS WHAT updateDraft TAKES AS ITS FOURTH ARGUMENT:
 *
 *   undefined   the body said nothing. The catalog is NOT read, and the caller
 *               below passes three arguments, exactly as before this existed.
 *   null        an explicit clear. The catalog is NOT read either: clearing
 *               needs no prompt.
 *   a snapshot  resolved from the catalog, with the CALLER'S OWN CLIENT, so RLS
 *               decides what they may select and an inactive prompt is
 *               invisible rather than refused.
 *
 * ONE READ AT MOST, and only for a real selection.
 */
async function promptFor(
  db: SupabaseClient,
  body: { readonly [key: string]: unknown },
): Promise<PromptWrite | undefined | NextResponse> {
  const selection = promptSelectionOf(body)
  if (!selection.ok) {
    return NextResponse.json(
      promptRefusalBody(selection.code),
      { status: statusForPrompt(selection.code) },
    )
  }

  if (selection.selection.kind === 'unchanged') return undefined
  if (selection.selection.kind === 'clear') return null

  const resolved = await readActivePrompt(db, selection.selection.promptId)
  if (resolved.ok) return resolved.value

  // UNKNOWN AND WITHDRAWN ARE ONE ANSWER, and 422 rather than 404: the request
  // was well formed, the draft was found, and it is the selection that cannot
  // be honoured. A 404 would say the draft was missing.
  if (resolved.reason === 'not-found') {
    return NextResponse.json(
      promptRefusalBody('prompt-not-found'),
      { status: statusForPrompt('prompt-not-found') },
    )
  }

  // read-failed and data-integrity: this site failing, not the caller erring.
  // The existing generic answer, and `detail` -- a Postgres code and message --
  // is neither logged nor sent.
  return failed({ reason: resolved.reason })
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

  /*
    THE EDITOR DOCUMENT, AND THE INVARIANT IT LIVES UNDER.

    `essay` is the canonical text: the analyser reads it, the counters count
    it and the fingerprint is taken over it. `editorDocument` holds one extra
    fact -- which characters are bold -- and it may NEVER disagree about the
    characters themselves. A body claiming essay "ABC" with a document that
    spells something else would leave the applicant assessed on text they
    cannot see.

    REFUSED HERE, ON THE SERVER. The browser checks it too so an obviously
    bad body costs no round trip, but a guarantee about stored data cannot
    live in a client.

    ABSENT IS FINE, AND COMMON: the plain textarea sends no document, and a
    draft keeps whatever it had.
  */
  const document = documentFrom(shape.body)
  if (document instanceof NextResponse) return document

  // THE FONT, after the document, so the refusal order the tests pin is
  // unchanged: a body wrong in both ways still reports the document's code.
  const font = fontFrom(shape.body)
  if (font instanceof NextResponse) return font

  // THE PROMPT, after the document, so the refusal order above is unchanged: a
  // body wrong in both ways still reports the document's code.
  const prompt = await promptFor(caller.db, shape.body)
  if (prompt instanceof NextResponse) return prompt

  // The PATH id, and the validator's normalised input. Nothing else from the
  // body. THREE ARGUMENTS WHEN THE BODY SAID NOTHING, so an ordinary autosave
  // takes the identical code path it took before prompt selection existed and
  // cannot touch a stored snapshot even by accident.
  const input = {
    ...checked.input,
    ...(document ?? {}),
    ...(font ?? {}),
  }
  const saved = prompt === undefined
    ? await updateDraft(caller.db, id, input)
    : await updateDraft(caller.db, id, input, prompt)
  if (!saved.ok) return failed(saved)

  return NextResponse.json({ draft: publicDraft(saved.value) })
}

/**
 * The constrained document from a body, or a refusal.
 *
 * THREE OUTCOMES, AND THEY ARE DIFFERENT. Absent means "this surface has no
 * formatting, leave the stored document alone". Present and consistent is
 * stored. Present and inconsistent with the essay is refused outright -- it is
 * not silently dropped, because a caller that sent a document meant to store
 * one, and quietly keeping the old formatting over new text would be its own
 * kind of wrong.
 *
 * CONSTRAINED BEFORE IT IS COMPARED, so a document carrying marks this build
 * does not know is reduced to what it can store and judged on that -- the
 * same reduction the editor applies.
 */
function documentFrom(
  body: Record<string, unknown>,
): { editorDocument: unknown; editorDocumentVersion: number } | undefined | NextResponse {
  const raw = body.editorDocument
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return NextResponse.json(
      validationBody('invalid-essay', undefined), { status: statusForValidation('invalid-essay') })
  }
  const constrained = constrainDocument(raw)
  const essay = typeof body.essay === 'string' ? body.essay : ''
  if (!documentMatchesEssay(constrained, essay)) {
    return NextResponse.json(
      validationBody('invalid-essay', undefined), { status: statusForValidation('invalid-essay') })
  }
  return { editorDocument: constrained, editorDocumentVersion: EDITOR_DOCUMENT_VERSION }
}

/**
 * The chosen face from a body, or a refusal.
 *
 * ---------------------------------------------------------------------------
 * CHECKED AGAINST THE FACES THIS BUILD SHIPS, NOT AGAINST A FAMILY NAME
 * ---------------------------------------------------------------------------
 * A family the Studio does not bundle renders from whatever the reader's
 * machine happens to have, so the page count -- the thing this whole feature
 * exists to report -- would depend on who was looking. studioFontFor() is the
 * same registry the renderer resolves with, so a value that reaches the
 * database is a value the Studio can actually draw.
 *
 * THREE STATES, AS THE COLUMN HAS THREE. Absent leaves the stored preference
 * alone, which is what every keystroke's autosave sends; null is an explicit
 * return to the Studio default; an id selects that face.
 *
 * THE DATABASE REFUSES IT TOO. 20261013_015 carries a CHECK over the same
 * list, so a row written by anything other than this route is bounded as well.
 */
function fontFrom(
  body: Record<string, unknown>,
): { documentFont: string | null } | undefined | NextResponse {
  if (!('documentFont' in body)) return undefined
  const raw = body.documentFont
  if (raw === null) return { documentFont: null }
  if (typeof raw !== 'string' || studioFontFor(raw) === null) {
    return NextResponse.json(
      { error: 'That font is not available.', code: 'invalid-font' }, { status: 400 })
  }
  return { documentFont: raw }
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
