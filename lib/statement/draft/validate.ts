/**
 * What may be PERSISTED as a statement draft. Pure and synchronous.
 *
 * THE BOUNDARY THIS MODULE DRAWS. Extraction may hand Studio up to
 * MAX_EXTRACTED_CHARS (50,000) characters and Studio may show all of them. This
 * module answers a narrower question -- may this text be written to
 * statement_drafts? -- and above MAX_SAVED_CHARS (20,000) the answer is no.
 * NOTHING HERE TRUNCATES: over-length text is refused and its count returned, so
 * the applicant can be told how much has to go. That is the same discipline
 * extractDocument.ts already applies to the same ceiling.
 *
 * NO DATABASE, NO REQUEST, NO CLOCK. Every refusal is decidable from the value
 * alone, which is what lets the whole module be tested without a row. In
 * particular `updated_at` is deliberately absent: the save route sets it on a
 * successful persisted save and at no other time, because it is the 400-day
 * inactivity clock, and nothing here could honestly advance it.
 *
 * THE COMPARE-AND-SWAP IS NOT HERE EITHER. This module validates the expected
 * revision a caller SUPPLIES; deciding whether that revision is stale needs the
 * stored value, which needs a read, which is the repository's job. The approved
 * repository design, recorded here so this module's outputs can be read against
 * it and NOT implemented here:
 *
 *   1. update one owner-scoped row where the id matches AND revision matches
 *      the expected revision;
 *   2. a successful update sets revision = expectedRevision + 1 and updated_at
 *      to the successful-save timestamp;
 *   3. zero rows updated -> an owner-scoped read by id: row present means a
 *      stale-revision conflict carrying the stored revision, row absent means
 *      not-found;
 *   4. no RPC in Phase 3, no last-write-wins, no automatic conflict resolution.
 *
 * CREATE AND UPDATE ARE DIFFERENT OPERATIONS, which is why this module exposes
 * two combined validators rather than one. A new draft has no prior revision --
 * the column supplies 1 -- so asking a caller for one would be asking for a
 * value it cannot know. Only an update compares.
 *
 * ---------------------------------------------------------------------------
 * WHICH 20,000 THIS USES, AND WHY IT MATTERS
 *
 * Two constants hold that number today:
 *
 *   lib/statement/limits.ts          MAX_STATEMENT_CHARS -- the most that may be
 *                                    submitted to the ANALYZER
 *   lib/statement/extract/limits.ts  MAX_SAVED_CHARS     -- "the most that may
 *                                    be SAVED as a statement"
 *
 * This module uses MAX_SAVED_CHARS: its stated meaning is persistence, and
 * extractDocument.ts already computes `saveable: characters <= MAX_SAVED_CHARS`,
 * which the upload endpoint returns to the client. Choosing the analyzer's
 * constant instead would let the upload endpoint promise `saveable: true` for
 * text this module then refuses, if the two numbers ever diverged.
 *
 * They are equal today, and validate.test.ts asserts they stay equal rather than
 * collapsing them -- the approved decision is to leave the two committed Phase
 * 1/2 constants alone for now.
 * ---------------------------------------------------------------------------
 * CHARACTERS ARE UTF-16 CODE UNITS, i.e. String.prototype.length.
 *
 * That is exactly what checkStatement() in lib/statement/limits.ts measures and
 * what extractDocument.ts counts, so a draft is measured the same way the
 * analyzer and the upload endpoint already measure. No Unicode normalisation, no
 * grapheme clustering and no code-point counting is introduced here.
 *
 * ONE CONSEQUENCE, STATED RATHER THAN LEFT TO BE DISCOVERED. Postgres
 * char_length() counts code POINTS, so the database CHECK is slightly MORE
 * permissive than this module for text containing astral characters: 10,001
 * emoji are 20,002 code units but only 10,001 code points. This module is
 * therefore the stricter gate and the one whose count the applicant is shown,
 * and the CHECK stays the backstop it was designed to be. Nothing the database
 * would refuse is accepted here.
 */

import { MAX_SAVED_CHARS } from '../extract/limits.ts'

/**
 * Approved: a draft title is 1-200 characters, measured AFTER trimming.
 *
 * The database enforces the same bounds on btrim(title), so a title this module
 * accepts cannot be refused by the CHECK.
 */
export const MIN_TITLE_CHARS = 1
export const MAX_TITLE_CHARS = 200

// ---------------------------------------------------------------------------
// Refusals. Fixed words, safe to log and safe for a route to branch on. Built
// up per field rather than Extract<>ed down from one union, so each function's
// result type states exactly what it can return.
// ---------------------------------------------------------------------------

export type TitleRefusal =
  /** Not a string, or nothing left once the whitespace is gone. */
  | 'invalid-title'
  /** More than MAX_TITLE_CHARS characters after trimming. */
  | 'title-too-long'

export type EssayRefusal =
  /** Not a string. An absent essay is not an empty one. */
  | 'invalid-essay'
  /** More than MAX_SAVED_CHARS characters. Refused, never truncated. */
  | 'essay-too-long'

export type RevisionRefusal =
  /** Not a safe integer, or below 1. */
  | 'invalid-revision'

/** Everything a CREATE can refuse. It cannot refuse a revision: it has none. */
export type DraftCreateRefusal = TitleRefusal | EssayRefusal
/** Everything an UPDATE can refuse. */
export type DraftUpdateRefusal = DraftCreateRefusal | RevisionRefusal
/** Every refusal this module can produce, for a route mapping codes to status. */
export type DraftRefusal = DraftUpdateRefusal

export type TitleCheck =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly code: TitleRefusal; readonly characters?: number }

export type EssayCheck =
  | { readonly ok: true; readonly essay: string; readonly characters: number }
  | { readonly ok: false; readonly code: EssayRefusal; readonly characters?: number }

export type RevisionCheck =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: RevisionRefusal }

/**
 * A new draft, normalised: exactly what a caller may decide about a row that
 * does not exist yet.
 *
 * NO REVISION, deliberately. `revision bigint not null default 1` supplies it,
 * so a caller has nothing to say about it and is not asked.
 */
export interface DraftCreateInput {
  /** Trimmed. This is the string that should be stored. */
  readonly title: string
  /** Untrimmed and unaltered. See checkEssay. */
  readonly essay: string
}

/** An edit to an existing draft: the same two values, plus what it read. */
export interface DraftUpdateInput extends DraftCreateInput {
  /** The revision the caller read, to be compared and swapped by the repository. */
  readonly expectedRevision: number
}

export type DraftCreateCheck =
  | { readonly ok: true; readonly input: DraftCreateInput; readonly characters: number }
  | { readonly ok: false; readonly code: DraftCreateRefusal; readonly characters?: number }

export type DraftUpdateCheck =
  | { readonly ok: true; readonly input: DraftUpdateInput; readonly characters: number }
  | { readonly ok: false; readonly code: DraftUpdateRefusal; readonly characters?: number }

/**
 * The title, trimmed, or a refusal.
 *
 * MEASURED ON THE TRIMMED TEXT, WHICH IS ALSO WHAT IS RETURNED, so the length
 * that was checked is the length that gets stored. checkStatement() states the
 * reason: checking one string and forwarding another is how a cap gets bypassed
 * with leading whitespace.
 *
 * A non-string is a refusal rather than a thrown error, matching
 * checkStatement(): a body carrying `title: { toString: ... }` is a malformed
 * request, not an exception.
 */
export function checkTitle(value: unknown): TitleCheck {
  if (typeof value !== 'string') return { ok: false, code: 'invalid-title' }

  const title = value.trim()
  // Empty and whitespace-only are the same refusal: after trimming there is no
  // title, and the database would reject both for the same reason.
  if (title.length < MIN_TITLE_CHARS) return { ok: false, code: 'invalid-title', characters: 0 }
  if (title.length > MAX_TITLE_CHARS) {
    return { ok: false, code: 'title-too-long', characters: title.length }
  }
  return { ok: true, title }
}

/**
 * The essay, unaltered, or a refusal.
 *
 * NOT TRIMMED, deliberately, and this is the one place it differs from
 * checkTitle. A personal statement's leading and trailing whitespace is part of
 * what the applicant wrote -- extractDocument.ts makes the same choice and says
 * why: "Nothing here truncates, normalises whitespace or drops blank lines." So
 * the value is measured exactly as it will be stored.
 *
 * EMPTY IS VALID. A draft exists before a word is written, and the column
 * defaults to ''.
 */
export function checkEssay(value: unknown): EssayCheck {
  if (typeof value !== 'string') return { ok: false, code: 'invalid-essay' }

  const characters = value.length
  if (characters > MAX_SAVED_CHARS) {
    // The count, so the caller can say how much has to go. Never the text.
    return { ok: false, code: 'essay-too-long', characters }
  }
  return { ok: true, essay: value, characters }
}

/**
 * The expected revision a caller supplied, or a refusal.
 *
 * SAFE INTEGER, not merely integer. The column is `bigint`, so a value past
 * Number.MAX_SAFE_INTEGER could not survive the JSON round trip intact, and a
 * compare-and-swap on a number that silently changed is worse than a refusal.
 * Number.isSafeInteger also excludes NaN and both infinities, so they need no
 * separate branch.
 *
 * A STRING IS REFUSED. `'1'` is not a revision a client may send. Note the
 * opposite direction is a different problem: PostgREST can return a bigint AS a
 * string, which is why lib/resume/repo/resumeRepo.ts coerces with
 * `Number(row.revision)`. Coercing what the DATABASE returns is the repository's
 * business; this function guards what a CALLER sends.
 */
export function checkExpectedRevision(value: unknown): RevisionCheck {
  if (typeof value !== 'number') return { ok: false, code: 'invalid-revision' }
  if (!Number.isSafeInteger(value)) return { ok: false, code: 'invalid-revision' }
  if (value < 1) return { ok: false, code: 'invalid-revision' }
  return { ok: true, revision: value }
}

/**
 * Forward a field refusal as an operation refusal.
 *
 * The count is carried only when the field produced one, and the key is OMITTED
 * rather than set to undefined, so `'characters' in result` means what it looks
 * like it means.
 */
function forward<R extends DraftRefusal>(
  refusal: { readonly code: R; readonly characters?: number },
): { readonly ok: false; readonly code: R; readonly characters?: number } {
  return refusal.characters === undefined
    ? { ok: false, code: refusal.code }
    : { ok: false, code: refusal.code, characters: refusal.characters }
}

/**
 * A NEW draft, normalised, or the first refusal.
 *
 * NO EXPECTED REVISION IS READ. The parameter names two fields, and an object
 * carrying a third is ignored entirely -- not validated, not forwarded, not
 * reflected in the result. A create is not a comparison, so a revision a caller
 * happened to include cannot change what this returns, and in particular cannot
 * refuse a creation for being "stale" against a row that does not exist.
 *
 * THE ORDER IS FIXED -- title, then essay -- and that is the point: a payload
 * wrong in two ways always reports the same code, so a route built on this
 * behaves deterministically and can be tested for it. The order carries no cost
 * ranking; every check is a comparison on a value already in hand.
 *
 * THE BODY'S SHAPE IS NOT THIS MODULE'S CONCERN. The parameter is an object of
 * unknown fields, so "the request body was not an object at all" stays an HTTP
 * question for the route, the way route.ts already treats a non-multipart
 * upload. A caller passing `{}` gets 'invalid-title', which is true.
 */
export function checkDraftCreate(input: {
  readonly title?: unknown
  readonly essay?: unknown
}): DraftCreateCheck {
  const title = checkTitle(input.title)
  if (!title.ok) return forward(title)

  const essay = checkEssay(input.essay)
  if (!essay.ok) return forward(essay)

  return {
    ok: true,
    input: { title: title.title, essay: essay.essay },
    characters: essay.characters,
  }
}

/**
 * An EDIT to an existing draft, normalised, or the first refusal.
 *
 * Same two fields as a create plus the revision the caller read, validated last
 * so the order stays fixed: title, essay, revision.
 *
 * WHAT THIS DOES NOT DO. It does not decide whether `expectedRevision` is
 * stale -- that needs the stored value and therefore a read. It only refuses a
 * revision that could not be a revision at all.
 */
export function checkDraftUpdate(input: {
  readonly title?: unknown
  readonly essay?: unknown
  readonly expectedRevision?: unknown
}): DraftUpdateCheck {
  const title = checkTitle(input.title)
  if (!title.ok) return forward(title)

  const essay = checkEssay(input.essay)
  if (!essay.ok) return forward(essay)

  const revision = checkExpectedRevision(input.expectedRevision)
  if (!revision.ok) return forward(revision)

  return {
    ok: true,
    input: { title: title.title, essay: essay.essay, expectedRevision: revision.revision },
    characters: essay.characters,
  }
}
