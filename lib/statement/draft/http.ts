/**
 * How a draft outcome becomes an HTTP answer. Pure.
 *
 * WHY THIS IS NOT IN THE ROUTE. The same reason resumeRepo.ts gives for its own
 * split: every decision that can be made without a request -- which status a
 * refusal earns, what the client is told, what must never be said -- is worth
 * testing without one. It also matters practically here: `npm test`'s glob is
 * `lib/**\/*.test.ts`, so a decision table living in app/ would never run in the
 * suite, while this one does.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. A repository failure carries a `detail`
 * string -- a Postgres code and message -- and that string never reaches a
 * client. Routes build their 5xx body from SERVER_ERROR_BODY, which is a
 * constant, so there is no code path on which a database message can be
 * interpolated into a response by accident.
 */

import type { DraftRefusal } from './validate.ts'
import type { DraftRepoRefusal } from './draftRepo.ts'
import type { StatementDraft } from './rows.ts'

/**
 * The same shape app/api/resume-v2/draft/route.ts uses inline. Repeated rather
 * than imported: that one is a private constant in a resume route, and statement
 * code does not depend on resume code.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a path segment can be a draft id.
 *
 * CHECKED BEFORE ANY QUERY. Postgres casts the value to uuid, so a malformed id
 * reaching the database is a 22P02 cast error -- a 500 for what is plainly a bad
 * request. The Next 16 handler context types a param as
 * `string | string[] | undefined`, so the type check is not decoration.
 */
export function isDraftId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export type BodyShape =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly code: 'not-an-object' }

/**
 * Whether a parsed JSON value is a body fields can be read from.
 *
 * `null`, arrays, strings, numbers and booleans are all valid JSON and none of
 * them is a request body. Arrays are excluded explicitly: `typeof [] === 'object'`
 * and `[].title` is undefined, so an array would otherwise slip through and be
 * reported as a missing title -- true, but the wrong reason.
 *
 * NOTHING IS COERCED. A body is usable or it is refused.
 */
export function checkBodyShape(value: unknown): BodyShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, code: 'not-an-object' }
  }
  return { ok: true, body: value as Record<string, unknown> }
}

/**
 * A validation refusal's status.
 *
 * 400 vs 422 FOLLOWS THE EXTRACT ROUTE, not a new policy. There, a request whose
 * SHAPE is wrong is 400 ('no-file', 'empty-file', 'malformed-upload') and a
 * well-formed request whose CONTENT is unacceptable is 422 ('text-too-long',
 * 'image-only', 'malformed'). The same line is drawn here: a missing or
 * wrong-typed field is a malformed request; an essay the applicant really wrote
 * that is simply too long is not malformed, it is unacceptable.
 */
export function statusForValidation(code: DraftRefusal): number {
  switch (code) {
    case 'title-too-long':
    case 'essay-too-long':
      return 422
    case 'invalid-title':
    case 'invalid-essay':
    case 'invalid-revision':
      return 400
  }
}

/**
 * A repository refusal's status.
 *
 * 'not-found' COVERS A HIDDEN ROW TOO. RLS makes another user's draft invisible,
 * so the repository cannot tell absent from forbidden -- and must not, because
 * a 403 would confirm that an id exists. There is deliberately no 403 here.
 *
 * Everything that is not an answer is a 500: the '*-failed' reasons are the
 * database or the network having failed, and 'data-integrity' is a row this
 * application cannot read. Neither is the caller's fault and neither is
 * described to them.
 */
export function statusForRepo(reason: DraftRepoRefusal): number {
  switch (reason) {
    case 'not-found': return 404
    case 'conflict': return 409
    default: return 500
  }
}

/** Whether a refusal is this server's fault, and therefore worth a log line. */
export function isServerFault(reason: DraftRepoRefusal): boolean {
  return statusForRepo(reason) >= 500
}

/**
 * What a client is told, per validation refusal. Fixed strings chosen here --
 * never a validator internal, never the rejected text.
 */
export const VALIDATION_MESSAGES: Record<DraftRefusal, string> = {
  'invalid-title': 'Give the draft a title.',
  'title-too-long': 'That title is too long. Use 200 characters or fewer.',
  'invalid-essay': 'The essay must be text.',
  'essay-too-long': 'That is longer than a saved statement may be. Shorten it and try again.',
  'invalid-revision': 'That draft version is not one this editor can save against. Reload the draft.',
}

/**
 * The ONLY body a 5xx ever carries. A constant, so no database message can be
 * interpolated into a response by a future edit without deleting this comment.
 */
export const SERVER_ERROR_BODY = {
  error: 'Something went wrong saving your draft. Please try again.',
  code: 'server-error',
} as const

export const NOT_FOUND_BODY = {
  error: 'That draft could not be found.',
  code: 'not-found',
} as const

export const UNAUTHENTICATED_BODY = {
  error: 'You must be signed in to work on a statement.',
  code: 'unauthenticated',
} as const

export const MALFORMED_JSON_BODY = {
  error: 'That request body could not be read as JSON.',
  code: 'malformed-json',
} as const

export const NOT_AN_OBJECT_BODY = {
  error: 'That request body is not a JSON object.',
  code: 'not-an-object',
} as const

export const INVALID_ID_BODY = {
  error: 'That draft id is not valid.',
  code: 'invalid-id',
} as const

// ---------------------------------------------------------------------------
// PROMPT SELECTION, as HTTP
//
// A SEPARATE UNION, NOT MEMBERS OF DraftRefusal, deliberately. VALIDATION_MESSAGES
// is Record<DraftRefusal, string> and statusForValidation() switches
// exhaustively over the same union, so folding these two codes in would change
// the type of both and force every existing caller to be re-read -- for two
// codes that only one handler can produce. Keeping them in their own union is
// the smaller surface: the title, essay, revision, not-found, conflict and
// server-fault paths are untouched, and a reader of either table still sees one
// code per row.
// ---------------------------------------------------------------------------

/** What a prompt selection can be refused for, as a client sees it. */
export type PromptRefusalCode =
  /** The body's promptId was neither a uuid, nor null, nor absent. */
  | 'invalid-prompt'
  /** A well-formed id that names no ACTIVE prompt: unknown, or withdrawn. */
  | 'prompt-not-found'

/**
 * What a client is told. Fixed strings chosen here -- never a resolver internal,
 * never the id, never a database message.
 *
 * NEITHER MESSAGE CONFIRMS WHETHER THE ID EXISTS. "no longer available" covers
 * an id that never existed, one belonging to a school the catalog dropped, and
 * one deactivated this morning, because the resolver cannot distinguish them
 * either -- the active-only policy makes a withdrawn prompt invisible rather
 * than refused.
 */
export const PROMPT_MESSAGES: Record<PromptRefusalCode, string> = {
  'invalid-prompt': 'That prompt selection is not one this editor can save. Reload the page.',
  'prompt-not-found': 'That prompt is no longer available. Choose another and try again.',
}

/**
 * A prompt refusal's status.
 *
 * THE SAME 400-vs-422 LINE the rest of this file draws. A promptId that is not
 * a uuid is a malformed REQUEST -- no client should ever send one, so it is 400,
 * beside 'invalid-title' and 'invalid-revision'. A well-formed id that names no
 * active prompt is a well-formed request whose CONTENT cannot be honoured, which
 * is 422, beside 'essay-too-long'.
 *
 * NOT 404. A 404 here would mean the DRAFT was not found, which is a different
 * answer to a different question and would send an editor looking for work it
 * has not lost.
 */
export function statusForPrompt(code: PromptRefusalCode): number {
  switch (code) {
    case 'invalid-prompt': return 400
    case 'prompt-not-found': return 422
  }
}

/** A prompt refusal, with its machine code. No count, no id, no detail. */
export function promptRefusalBody(
  code: PromptRefusalCode,
): { error: string; code: PromptRefusalCode } {
  return { error: PROMPT_MESSAGES[code], code }
}

/** A conflict, carrying the one fact a client needs to resync: the revision. */
export function conflictBody(storedRevision: number): {
  error: string; code: 'conflict'; storedRevision: number
} {
  return {
    error: 'This draft was saved somewhere else. Reload it before saving again.',
    code: 'conflict',
    storedRevision,
  }
}

/** A validation refusal, with its machine code and -- when counted -- its count. */
export function validationBody(
  code: DraftRefusal,
  characters?: number,
): { error: string; code: DraftRefusal; characters?: number } {
  return {
    error: VALIDATION_MESSAGES[code],
    code,
    ...(characters === undefined ? {} : { characters }),
  }
}

/** A draft as a client may see it. `userId` is the one field deliberately dropped. */
export interface PublicDraft {
  readonly id: string
  readonly title: string
  readonly essay: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string

  // ----------------------------------------------- the prompt snapshot
  // PRESENT AND null ON A GENERIC DRAFT, never omitted. A client that receives
  // four explicit nulls knows this draft has no prompt; one that receives four
  // absent keys cannot tell that from a server too old to send them.
  readonly schoolId: string | null
  readonly promptId: string | null
  readonly promptText: string | null
  readonly statedMaxWords: number | null
}

/**
 * BUILT, NOT SPREAD. `{ ...draft }` would carry userId today and whatever is
 * added to StatementDraft tomorrow; naming the ten fields means a new column
 * cannot reach a client by being added upstream.
 *
 * THE FOUR PROMPT FIELDS ARE COPIED AS THEY ARE, nulls included. There is no
 * `?? undefined`, no omit-when-null and no reshaping into a nested object: a
 * generic draft serialises `"schoolId": null`, so a client reads the absence of
 * a prompt rather than inferring it from a missing key.
 */
export function publicDraft(draft: StatementDraft): PublicDraft {
  return {
    id: draft.id,
    title: draft.title,
    essay: draft.essay,
    revision: draft.revision,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    schoolId: draft.schoolId,
    promptId: draft.promptId,
    promptText: draft.promptText,
    statedMaxWords: draft.statedMaxWords,
  }
}
