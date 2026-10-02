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

/**
 * The largest revision a caller may claim to have read: one below the largest
 * a JS number can hold exactly.
 *
 * WHY ONE BELOW, AND WHY HERE. An expected revision exists for exactly one
 * purpose -- to be compared and then incremented by the save. So the real rule
 * is not "is this a revision" but "does this revision survive being incremented",
 * and at Number.MAX_SAFE_INTEGER it does not: the repository would compute
 * expectedRevision + 1, which is no longer a safe integer, write it, and then
 * fail to read its own result back, because parseStoredRevision() in rows.ts
 * refuses anything past MAX_SAFE_INTEGER. The write would land and the response
 * would be a data-integrity error.
 *
 * THE ASYMMETRY WITH THE STORED PARSER IS DELIBERATE. parseStoredRevision still
 * accepts MAX_SAFE_INTEGER, because a value already in the column can be READ
 * exactly -- it just cannot be incremented again. A draft that somehow reached
 * that revision stays readable and listable; only a further edit is refused,
 * which is the honest answer rather than a silent overflow.
 *
 * Reaching this would take about nine quadrillion saves. The bound is not there
 * because it is likely; it is there so the impossible state is impossible.
 */
export const MAX_EXPECTED_REVISION = Number.MAX_SAFE_INTEGER - 1

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
 *
 * AND IT MUST SURVIVE BEING INCREMENTED. The upper bound is
 * MAX_EXPECTED_REVISION, one below MAX_SAFE_INTEGER -- see that constant for why
 * the ceiling here is deliberately stricter than the one parseStoredRevision()
 * applies to a value it merely reads. Refusing here means the impossible update
 * never reaches the database at all: no statement is issued, so nothing is
 * written that could not then be read back.
 */
export function checkExpectedRevision(value: unknown): RevisionCheck {
  if (typeof value !== 'number') return { ok: false, code: 'invalid-revision' }
  if (!Number.isSafeInteger(value)) return { ok: false, code: 'invalid-revision' }
  if (value < 1) return { ok: false, code: 'invalid-revision' }
  // expectedRevision + 1 must still be a safe integer, or the repository would
  // write a revision it could not read back.
  if (value > MAX_EXPECTED_REVISION) return { ok: false, code: 'invalid-revision' }
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

// ===========================================================================
// PROMPT SELECTION
//
// Which school prompt a draft answers. THE ONLY PROMPT FIELD A BROWSER MAY
// SEND IS AN ID, and this section is where that rule is enforced.
//
// WHAT IS DELIBERATELY ABSENT, AND MUST STAY ABSENT. There is no check for
// `schoolId`, `promptText` or `statedMaxWords` anywhere below. Those three are
// canonical: the server resolves them from public.statement_prompts and
// snapshots what the DATABASE returned. A validator for them would be the first
// step towards trusting them, because a field that can be validated is a field
// something will eventually accept. So they are not validated and refused --
// they are never read at all, exactly as `userId` and `revision` already are
// not read by checkDraftCreate.
//
// NOTHING HERE IS WIRED INTO A ROUTE YET. checkDraftCreate and
// checkDraftUpdate are untouched: a prompt selection is not part of
// DraftCreateInput or DraftUpdateInput at this checkpoint, and no endpoint
// reads it. This is the validation layer only.
//
// AND 'invalid-prompt' IS NOT IN DraftRefusal, on purpose. http.ts builds
// VALIDATION_MESSAGES as Record<DraftRefusal, string> and switches
// exhaustively on the same union, so adding a member here would silently
// require a message and a status for a code no endpoint can yet produce.
// Folding the two unions together belongs to the checkpoint that wires PATCH.
// ===========================================================================

/** Everything a prompt selection can refuse. One code: the value is not one. */
export type PromptSelectionRefusal =
  /** Neither a uuid, nor null, nor absent. */
  | 'invalid-prompt'

/**
 * The uuid shape a prompt id must have.
 *
 * DUPLICATED FROM http.ts's UUID, and the duplication is the lesser evil.
 * http.ts imports DraftRefusal from this file, so importing its regex back
 * would close a cycle between the two modules; and this file otherwise depends
 * on nothing but one limits constant, which is what lets the whole validation
 * layer be read in one sitting. validate.test.ts asserts the two patterns stay
 * character-for-character identical, so they cannot drift apart unnoticed.
 *
 * ANY VERSION, ANY VARIANT, like the draft-id predicate beside it. The column
 * defaults to gen_random_uuid() and is therefore v4 in practice, but a
 * validator that refused a v7 id would be refusing a row the database was
 * perfectly willing to store.
 */
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a value can be a prompt id.
 *
 * CHECKED BEFORE ANY QUERY, for the same reason isDraftId is: Postgres casts
 * the value to uuid, so a malformed id reaching the database is a 22P02 cast
 * error -- a 500 for what is plainly a bad request.
 */
export function isPromptId(value: unknown): value is string {
  return typeof value === 'string' && PROMPT_ID.test(value)
}

/**
 * THREE STATES, and they are three because a request has three things to say.
 *
 *   'unchanged'  the request expressed no opinion. Leave the stored prompt
 *                alone -- all four columns keep whatever they hold.
 *   'clear'      the applicant deliberately removed the prompt. All four
 *                columns become NULL and the draft becomes generic again.
 *   'select'     this prompt, by id. The server resolves the canonical
 *                school, wording and word limit and snapshots those.
 *
 * WHY 'unchanged' AND 'clear' MUST NOT BE ONE STATE. An autosave sends the
 * whole document every 1.2 seconds. If a body that simply omits the prompt
 * meant "clear it", every keystroke in the essay would quietly wipe the
 * applicant's prompt selection. And if an explicit null meant "leave it", there
 * would be no way to remove a prompt at all. Collapsing them breaks one feature
 * or the other, so the distinction is load-bearing rather than tidy.
 */
export type PromptSelection =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'select'; readonly promptId: string }

export type PromptSelectionCheck =
  | { readonly ok: true; readonly selection: PromptSelection }
  | { readonly ok: false; readonly code: PromptSelectionRefusal }

/** The key, named once. Anything else in a body is not a prompt selection. */
export const PROMPT_SELECTION_KEY = 'promptId'

const UNCHANGED: PromptSelectionCheck = { ok: true, selection: { kind: 'unchanged' } }
const CLEAR: PromptSelectionCheck = { ok: true, selection: { kind: 'clear' } }

/**
 * One value as a prompt selection, or a refusal.
 *
 * `undefined` AND AN ABSENT KEY ARE THE SAME ANSWER, necessarily: reading a
 * missing property yields undefined, so JavaScript cannot tell the two apart
 * and neither can this function. Both mean "no opinion", which is the safe
 * reading -- a request that forgot to mention the prompt must not change it.
 *
 * NULL IS NOT FALSY HERE. It is the one value that means something, so it is
 * matched exactly rather than falling into a truthiness test that would also
 * swallow '' and 0 and call them a deliberate clear.
 *
 * A NON-STRING IS A REFUSAL, NOT A THROW, matching checkTitle: a body carrying
 * `promptId: 42` or `promptId: { id: '...' }` is a malformed request.
 */
export function checkPromptSelection(value: unknown): PromptSelectionCheck {
  if (value === undefined) return UNCHANGED
  if (value === null) return CLEAR
  if (!isPromptId(value)) return { ok: false, code: 'invalid-prompt' }
  return { ok: true, selection: { kind: 'select', promptId: value } }
}

/**
 * A request body's prompt selection: exactly ONE key is read, and it is named
 * by PROMPT_SELECTION_KEY.
 *
 * THIS FUNCTION IS THE NARROW DOOR. It exists so that "the browser may send an
 * id and nothing else" is a property of one testable function rather than a
 * habit spread across two routes. A body carrying `schoolId`, `promptText`,
 * `statedMaxWords`, `school_id`, `prompt_text`, `stated_max_words` or
 * `prompt_id` reaches nothing: those keys are not read, so they cannot be
 * forwarded, logged or stored, and a test asserts exactly that.
 */
export function promptSelectionOf(
  body: { readonly [key: string]: unknown },
): PromptSelectionCheck {
  return checkPromptSelection(body[PROMPT_SELECTION_KEY])
}

// ===========================================================================
// CREATING a draft that already answers a prompt.
//
// A CREATE HAS NO 'clear' STATE, and that is the whole difference from the
// update side. A row that does not exist yet holds no prompt, so there is
// nothing to remove and `promptId: null` cannot mean "remove it". It is
// REFUSED rather than read as "no prompt", because the two requests an
// applicant can make are "a general statement" and "this school's question",
// and a null is neither: it is a browser that meant to name a prompt and sent
// an empty variable instead. Quietly creating a general draft there would hand
// somebody a blank statement when they had chosen a school -- the exact
// accident this file exists to prevent -- and they would not find out until
// they opened the editor.
//
// SO A GENERAL CREATE OMITS THE KEY ENTIRELY. That is not a convention this
// module hopes callers follow; it is the only way to say it.
//
// NOTHING BELOW RE-IMPLEMENTS THE UUID RULE. checkPromptSelection does the
// reading and PROMPT_ID does the matching, exactly as they do for PATCH, and
// this function only decides what to do with the three answers it gets back.
// ===========================================================================

/**
 * What a create request says about the prompt. TWO states, not three.
 *
 * 'none'    no prompt was named. A general statement.
 * 'select'  this prompt, by id. The server resolves the school, the wording
 *           and the word limit, and snapshots those onto the new row.
 */
export type CreatePromptSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'select'; readonly promptId: string }

export type CreatePromptSelectionCheck =
  | { readonly ok: true; readonly selection: CreatePromptSelection }
  | { readonly ok: false; readonly code: PromptSelectionRefusal }

const NO_PROMPT: CreatePromptSelectionCheck = { ok: true, selection: { kind: 'none' } }
const UNUSABLE: CreatePromptSelectionCheck = { ok: false, code: 'invalid-prompt' }

/**
 * One value as a create's prompt selection, or a refusal.
 *
 * ABSENT IS THE ONLY WAY TO ASK FOR A GENERAL DRAFT. undefined and a missing
 * key are the same answer here for the same reason they are in
 * checkPromptSelection -- reading a missing property yields undefined and
 * JavaScript cannot tell them apart -- and that answer is 'none'.
 *
 * EVERYTHING ELSE THAT IS NOT A UUID IS A REFUSAL, null included.
 */
export function checkCreatePromptSelection(value: unknown): CreatePromptSelectionCheck {
  const checked = checkPromptSelection(value)
  if (!checked.ok) return checked

  const { selection } = checked
  switch (selection.kind) {
    case 'unchanged':
      return NO_PROMPT
    case 'select':
      return { ok: true, selection }
    // An explicit null. The update side calls this 'clear'; a create has
    // nothing to clear, so it is the one answer that becomes a refusal.
    case 'clear':
      return UNUSABLE
  }
}

/**
 * A create body's prompt selection: ONE key is read, the same key PATCH reads.
 *
 * THE NARROW DOOR AGAIN, and it is the same door. A body carrying `schoolId`,
 * `promptText`, `statedMaxWords` or any snake_case spelling of them reaches
 * nothing, because those keys are not read here and the route has no other way
 * to learn them. The canonical values come out of the catalog or they do not
 * exist.
 */
export function createPromptSelectionOf(
  body: { readonly [key: string]: unknown },
): CreatePromptSelectionCheck {
  return checkCreatePromptSelection(body[PROMPT_SELECTION_KEY])
}
