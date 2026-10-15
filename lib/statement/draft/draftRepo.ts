/**
 * The only module that reads or writes statement_drafts rows.
 *
 * Deliberately thin, in the same shape as lib/resume/repo/resumeRepo.ts: every
 * decision that can be made without a database -- what may be persisted, what a
 * stored row means -- lives in validate.ts and rows.ts beside it and is tested
 * there. What remains here is the wiring.
 *
 * THE CLIENT IS SUPPLIED BY THE CALLER, never constructed here, so a route can
 * pass a request-scoped client carrying the user's JWT and RLS stays in force.
 * Nothing in this file creates a service-role client, and nothing needs one:
 * every statement below is a query the signed-in applicant is entitled to make
 * about their own rows.
 *
 * RLS IS THE SECURITY BOUNDARY, not the filters. Another user's row is not
 * hidden by a `.eq('user_id', ...)` this code could forget -- it is invisible to
 * the query, which is why a row belonging to somebody else and a row that does
 * not exist both come back as 'not-found'. There is deliberately no
 * 'forbidden' outcome: telling a caller that a draft exists but is not theirs
 * would confirm the id, which is information they have no claim to.
 *
 * updated_at IS THIS MODULE'S RESPONSIBILITY. The table has no touch trigger, on
 * purpose, because updated_at is the 400-day inactivity clock and a trigger
 * would advance it on writes the retention policy does not count as activity.
 * So exactly one function sets it -- updateDraft, on the one statement that
 * persists an edit -- and create leaves it to the column default. Nothing else
 * here writes it: readDraft, listDrafts and deleteDraft issue no UPDATE at all.
 *
 * AND NO CALLER CAN SUPPLY IT. updateDraft takes no timestamp and
 * DraftUpdateInput carries none, so the value written is always one this module
 * generated during the attempt. A route that could pass its own could set the
 * retention clock to anything -- including a date far in the future, which would
 * make a draft effectively immortal, or one in the past, which would age it out
 * early.
 *
 * NOT YET WIRED TO ANYTHING. The route is the next layer.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DraftCreateInput, DraftUpdateInput } from './validate.ts'
// TYPE ONLY, and that matters: the snapshot's SHAPE is shared with the module
// that resolves one, but no code from it is imported and none runs here. This
// module never resolves a prompt -- see PromptWrite below.
import type { StatementPromptSnapshot } from './promptRepo.ts'
import { draftFromRow, draftSummaryFromRow } from './rows.ts'
import type {
  StatementDraft, StatementDraftRow, StatementDraftSummary, StatementDraftSummaryRow,
} from './rows.ts'
import {
  documentFontEnabled, editorDocumentsEnabled, promptSubmissionsEnabled, requirementsEnabled,
} from './rollout.ts'
import { legacyProjection, type RequirementSnapshot } from '../requirements/snapshot.ts'

const DRAFTS = 'statement_drafts'

/**
 * Columns this module reads: ALL ELEVEN, named explicitly so a schema addition
 * cannot silently start arriving, and so no column is selected that is not
 * used.
 *
 * THE FOUR PROMPT COLUMNS ARE READ BY ALL THREE STATEMENTS, and written by
 * exactly one: updateDraft, and only when a caller supplies an already-resolved
 * snapshot. createDraft still sends three columns, so every new draft is
 * generic. SUMMARY_COLUMNS is deliberately not widened with them: see below.
 */
const DRAFT_COLUMNS_BASE =
  'id, user_id, title, essay, revision, created_at, updated_at, '
  + 'school_id, prompt_id, prompt_text, stated_max_words'

/**
 * The columns a draft read asks for, which depends on whether the requirement
 * migration has been applied.
 *
 * THIS IS THE ROLLOUT GATE DOING REAL WORK, not a feature toggle on a finished
 * schema. requirement_id and requirement_snapshot are added by 20261002_005,
 * which is written and NOT applied. Naming an absent column in a PostgREST
 * select does not degrade -- it fails the whole request with a 42703, so every
 * draft read in the product would break, not just a new feature. So the column
 * list is computed per call from the flag: off, and the query is byte-identical
 * to the one shipped today.
 *
 * READ PER CALL, NOT ONCE AT MODULE LOAD. A constant captured at import time
 * would freeze whichever value the environment had when the first module in the
 * process happened to pull this one in, which is not something a test or a
 * deployment can reason about.
 */
function draftColumns(): string {
  const base = requirementsEnabled()
    ? `${DRAFT_COLUMNS_BASE}, requirement_id, requirement_snapshot`
    : DRAFT_COLUMNS_BASE
  // AND prompt_submission_id ON ITS OWN FLAG, for the reason above: the column
  // arrives with 20261002_001, and naming an absent column fails the whole
  // request rather than degrading.
  //
  // WITHOUT IT A PASTED DRAFT CANNOT BE READ. draftPromptFrom admits a draft
  // whose only id is a submission id; if the projection does not ask for that
  // column the parser sees "not pasted", finds no id at all, and refuses the
  // row -- which is how the editor lost the ability to open one.
  const withSubmission = promptSubmissionsEnabled()
    ? `${base}, prompt_submission_id` : base
  // AND THE EDITOR DOCUMENT ON ITS OWN FLAG, same reason again: 013 adds the
  // columns, and naming one PostgREST cannot find fails the whole read.
  const withDocument = editorDocumentsEnabled()
    ? `${withSubmission}, editor_document, editor_document_version`
    : withSubmission
  // 20261013_015. SELECTED ONLY BEHIND THE FLAG, for the reason every other
  // column list here gives: naming a column PostgREST cannot find fails the
  // whole request with a 42703 rather than degrading.
  return documentFontEnabled() ? `${withDocument}, document_font` : withDocument
}

/**
 * Columns the LIST projection asks for. No `essay`, and no `user_id`.
 *
 * The library screen needs titles and timestamps; pulling the essays would move
 * up to 20,000 characters per draft for nothing, and an unlimited draft count
 * makes that unbounded. `user_id` is the WHERE clause below, not a column any
 * caller reads.
 *
 * AND NOT prompt_text EITHER, deliberately, for the same arithmetic: it is up
 * to 5,000 characters per row, on an unbounded list, for a screen that shows
 * titles. Whether the library should say which prompt a draft answers is a
 * separate decision; if it ever should, the answer is an id or a short label
 * and never the wording. This projection stays exactly five columns.
 */
const SUMMARY_COLUMNS = 'id, title, revision, created_at, updated_at'

/**
 * WHAT A CALLER MAY SAY ABOUT THE STORED PROMPT. Three states, and the third
 * one is the absence of the value entirely:
 *
 *   undefined / omitted   say nothing. All four stored columns keep whatever
 *                         they hold, and the UPDATE payload names none of them.
 *   null                  clear. All four become NULL and the draft is generic
 *                         again.
 *   a snapshot            set. All four are written from it.
 *
 * WHY THIS IS NOT A promptId. A repository that took an id would have to resolve
 * it, which means reading statement_prompts, which means this module deciding
 * what a prompt IS -- and the canonical school, wording and word limit are the
 * one thing a browser must never be able to choose. By the time a snapshot
 * reaches here it has already come out of the catalog, through
 * promptRepo.readActivePrompt, under the caller's own RLS. Nothing in this file
 * resolves anything, and nothing in this file reads statement_prompts.
 *
 * WHY undefined AND null MUST STAY DIFFERENT. Autosave sends the whole document
 * every 1.2 seconds. If an omitted snapshot meant "clear", every keystroke would
 * wipe the applicant's prompt; if an explicit null meant "leave it", a prompt
 * could never be removed. validate.ts draws the same distinction for the
 * request side, and for the same reason.
 *
 * THE SHAPE IS StatementPromptSnapshot, imported as a type only. A caller
 * constructing one by hand is constructing something the catalog never
 * returned, which is why the resolver and not this type is the trust boundary.
 */
export type PromptWrite = StatementPromptSnapshot | null

/**
 * Why a repository call did not produce a value.
 *
 * 'conflict' and 'not-found' are ANSWERS -- the database did its job and the
 * answer was no. The '*-failed' reasons are the database or the network having
 * failed, which is a different thing and must never be reported as a conflict:
 * an autosave that treats a dropped connection as "someone else saved" freezes
 * on a conflict that never happened.
 *
 * 'data-integrity' is a third category again: the query succeeded and returned a
 * row this application cannot interpret.
 */
export type DraftRepoRefusal =
  | 'not-found'
  | 'conflict'
  | 'data-integrity'
  | 'create-failed'
  | 'read-failed'
  | 'list-failed'
  | 'update-failed'
  | 'delete-failed'

/**
 * Same shape as lib/resume/repo/resumeRepo.ts's RepoResult, declared here rather
 * than imported: statement code does not depend on resume code, and a shared
 * result type would be the first thread of exactly that coupling.
 */
export type DraftRepoResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly reason: DraftRepoRefusal
      readonly detail: string
      /** Set only on 'conflict': the revision the database actually holds, so a
       *  caller can resync without a second round trip that could race with yet
       *  another writer. */
      readonly storedRevision?: number
    }

/**
 * A database error, reduced to something safe to log.
 *
 * CODE AND MESSAGE ONLY. A PostgREST error's `details` and `hint` can echo the
 * row that failed, and for a statement draft that row is somebody's essay. The
 * same rule as resumeRepo's failure() and for a stronger reason.
 */
function failure(reason: DraftRepoRefusal, error: unknown): DraftRepoResult<never> {
  const err = error as { code?: string; message?: string } | null
  return { ok: false, reason, detail: `${err?.code ?? ''} ${err?.message ?? ''}`.trim() }
}

/** The row came back but could not be read. Fixed words: never the row. */
function integrity(where: string): DraftRepoResult<never> {
  return { ok: false, reason: 'data-integrity', detail: `unusable stored row (${where})` }
}

/**
 * An argument this module was handed cannot be used. Fixed words: never the
 * value.
 *
 * THE SAME REASON A BAD ROW GETS, deliberately: 'data-integrity' already means
 * "the data this application is working with cannot be interpreted", it is
 * already in DraftRepoRefusal, statusForRepo() already maps it to 500 through
 * its default branch, and isServerFault() already makes it a logged server
 * fault. So nothing about the refusal union, the status table or any route
 * changes -- a caller that was already handling 'data-integrity' handles this.
 *
 * ONLY THE `detail` DIFFERS from integrity(), because this is not a stored row
 * and saying so would send an operator looking in the wrong place. `detail` is
 * logged at most and never reaches a client: routes build every 5xx from
 * SERVER_ERROR_BODY, and the statement routes do not log `detail` at all.
 */
function badArgument(what: string): DraftRepoResult<never> {
  return { ok: false, reason: 'data-integrity', detail: `unusable argument (${what})` }
}

const notFound: DraftRepoResult<never> = {
  ok: false, reason: 'not-found', detail: '',
}

/**
 * Creates a draft and returns it as stored.
 *
 * ONLY THREE COLUMNS ARE SENT. `id`, `revision`, `created_at` and `updated_at`
 * are the database's to choose -- gen_random_uuid(), 1, now(), now() -- and
 * sending any of them would either duplicate a default or let a client set a
 * value it has no business setting. A client-supplied revision in particular
 * would break the compare-and-swap before the first edit.
 *
 * `user_id` IS sent, because the column is NOT NULL and there is no default. RLS
 * still has the last word: its insert policy refuses any row whose user_id is
 * not the caller's, so this value cannot be used to create a draft for someone
 * else.
 *
 * The title and essay arrive already normalised from checkDraftCreate(); this
 * function revalidates nothing.
 */
export async function createDraft(
  db: SupabaseClient,
  userId: string,
  input: DraftCreateInput,
  prompt?: StatementPromptSnapshot,
  /**
   * A structured requirement to be born against, instead of a prompt.
   *
   * MUTUALLY EXCLUSIVE WITH `prompt`, and refused below rather than merged:
   * they are two descriptions of the same three columns, and a caller passing
   * both has a bug that must not become a stored draft.
   *
   * REQUIRES THE ROLLOUT FLAG, because the two columns it writes do not exist
   * until 20261002_005 is applied. Refused rather than silently downgraded to a
   * prompt-only insert: a draft that kept the wording but lost the requirement
   * identity would be analysed as an ordinary single-prompt draft, against a
   * question whose components and character limit had been dropped.
   */
  requirement?: RequirementSnapshot,
): Promise<DraftRepoResult<StatementDraft>> {
  // BEFORE THE STATEMENT IS BUILT, for the reason updateDraft gives: a fourth
  // argument that is neither absent nor a snapshot is an internal error, and
  // the one outcome that must not follow from it is a draft existing anyway.
  // Refusing here means no row is inserted at all.
  if (!isCreatePrompt(prompt)) return badArgument('prompt')
  if (requirement !== undefined) {
    if (prompt !== undefined) return badArgument('requirement')
    if (!requirementsEnabled()) return badArgument('requirement')
  }

  const { data, error } = await db
    .from(DRAFTS)
    // ONE INSERT, AND THE SNAPSHOT RIDES IT. A school-specific draft is born
    // answering its prompt rather than created generic and patched a moment
    // later: no second statement, no second revision, and no window in which
    // the row exists without the question it was started for. On a general
    // create promptColumns() spreads {}, so the payload is byte-for-byte the
    // three columns it has always been.
    .insert({
      user_id: userId,
      title: input.title,
      essay: input.essay,
      ...promptColumns(prompt),
      // SPREAD SECOND, AND NEVER ALONGSIDE A PROMPT: the branch above already
      // refused both together, so these keys and promptColumns' keys can never
      // both be present and no spread can quietly overwrite the other.
      ...requirementColumns(requirement),
    })
    .select(draftColumns())
    .maybeSingle()
  if (error) return failure('create-failed', error)
  if (!data) return failure('create-failed', { code: 'NO_ROW', message: 'insert returned no row' })

  const draft = draftFromRow(data as unknown as StatementDraftRow)
  // A fresh row must read back as revision 1. If it does not parse, the column
  // default or the bigint transport has changed and a CAS built on it would be
  // unsound -- so say so rather than hand back a guess.
  if (!draft) return integrity('create')
  return { ok: true, value: draft }
}

/**
 * Reads one draft by id. Issues no write, so updated_at is untouched.
 *
 * No `.eq('user_id', ...)`: the row is either visible to this caller or it is
 * not, and RLS decides. maybeSingle() then returns null for both "invisible" and
 * "absent", which is exactly the indistinguishability that is wanted.
 */
export async function readDraft(
  db: SupabaseClient,
  draftId: string,
): Promise<DraftRepoResult<StatementDraft>> {
  const { data, error } = await db
    .from(DRAFTS)
    .select(draftColumns())
    .eq('id', draftId)
    .maybeSingle()
  if (error) return failure('read-failed', error)
  if (!data) return notFound

  const draft = draftFromRow(data as unknown as StatementDraftRow)
  if (!draft) return integrity('read')
  return { ok: true, value: draft }
}

/**
 * Lists the caller's drafts, newest edit first. METADATA ONLY, and no write.
 *
 * NO ESSAY BODIES. The full text of one draft comes from readDraft(); this
 * returns StatementDraftSummary, a distinct type rather than a StatementDraft
 * with a field missing, so nothing downstream can mistake a library entry for a
 * loaded draft.
 *
 * The explicit user_id filter is kept alongside RLS, matching listResumes(), and
 * together with the ORDER BY it is what statement_drafts_user_updated_idx
 * (user_id, updated_at DESC) was created to serve.
 *
 * NO LIMIT. Drafts are unlimited for every tier and pagination is a separate
 * decision; dropping the essay is what makes an unbounded count affordable in
 * the meantime.
 *
 * ONE MALFORMED ROW FAILS THE WHOLE LIST. Returning the other nine would mean
 * silently hiding a draft the applicant wrote, which is worse than an error
 * page: they would conclude it was lost.
 */
export async function listDrafts(
  db: SupabaseClient,
  userId: string,
): Promise<DraftRepoResult<StatementDraftSummary[]>> {
  const { data, error } = await db
    .from(DRAFTS)
    .select(SUMMARY_COLUMNS)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
  if (error) return failure('list-failed', error)

  const summaries: StatementDraftSummary[] = []
  for (const row of (data ?? []) as unknown as StatementDraftSummaryRow[]) {
    const summary = draftSummaryFromRow(row)
    if (!summary) return integrity('list')
    summaries.push(summary)
  }
  return { ok: true, value: summaries }
}

/**
 * Whether a value is STRUCTURALLY a snapshot. A lightweight shape check.
 *
 * It does NOT revalidate the snapshot's CONTENT -- no uuid format, no 5,000
 * character ceiling, no 1..5000 word range. Those belong to the resolver that
 * produced the value and to the CHECKs on the columns; repeating them here
 * would be a second opinion about what a prompt IS, which is exactly what this
 * module must not have. promptRepo.ts remains the authority on canonical
 * validity.
 *
 * `statedMaxWords` may be null, because a school stating no limit is a real
 * snapshot and not a defective one.
 */
function isSnapshot(value: unknown): value is StatementPromptSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const fields = value as Record<string, unknown>
  return typeof fields.schoolId === 'string'
    && typeof fields.promptId === 'string'
    && typeof fields.promptText === 'string'
    && (fields.statedMaxWords === null || typeof fields.statedMaxWords === 'number')
}

/**
 * Whether a fourth argument is one of the THREE valid runtime states.
 *
 * THERE IS NO FOURTH STATE. undefined, null and a snapshot are the whole
 * contract, and anything else is an internal programming or data error rather
 * than a condition to absorb. The type system is the first gate; this is what
 * happens when a value gets past it.
 */
function isPromptWrite(value: unknown): value is PromptWrite | undefined {
  return value === undefined || value === null || isSnapshot(value)
}

/**
 * Whether a fourth argument to createDraft is one of its TWO valid states.
 *
 * TWO, NOT THREE. updateDraft has a third -- an explicit null, meaning "remove
 * the prompt this row holds". A row being created holds nothing, so null is not
 * an instruction a create can carry and is refused here exactly as a malformed
 * object would be. validate.ts refuses the same value on the request side, so
 * a null is stopped twice: once as a request, once as an argument.
 */
function isCreatePrompt(value: unknown): value is StatementPromptSnapshot | undefined {
  return value === undefined || isSnapshot(value)
}

/**
 * The columns a draft born against a STRUCTURED requirement carries.
 *
 * SIX COLUMNS FROM ONE SOURCE. The requirement snapshot is the only input: the
 * two new columns hold its identity and its frozen copy, and the prompt columns
 * are PROJECTED from it by legacyProjection(). The caller does not get to pass
 * a prompt snapshot as well, because two sources for prompt_text would
 * eventually disagree and the draft would be analysed against whichever won.
 *
 * prompt_id IS EXPLICITLY NULL, and that is the correction this function
 * exists to record. An earlier version wrote the REQUIREMENT's id into it,
 * reasoning that the existing parser refused a partial prompt snapshot and that
 * prompt_id has no foreign key. Both were true and the conclusion was still
 * wrong: 20260930_001 documents prompt_id as "the canonical prompt, same uuid
 * as public.statement_prompts.id", so a statement_requirements id in that
 * column is a value that resolves to nothing in the table the column names.
 * Anything later joining on it -- including verifiedProvenance, which looks the
 * id up in statement_prompts -- gets a miss it cannot distinguish from a
 * withdrawn prompt.
 *
 * THE PARSER WAS WIDENED INSTEAD. draftPromptFrom() now admits a third shape in
 * which prompt_id is null and requirement_id carries the identity, so the
 * all-or-none rule still holds for legacy drafts and this one needs no
 * overload. requirement_id and requirement_snapshot are the authoritative
 * identity and saved instructions for these drafts; prompt_id is left to mean
 * what it has always meant.
 */
function requirementColumns(
  requirement: RequirementSnapshot | undefined
): Record<string, unknown> {
  if (requirement === undefined) return {}
  const legacy = legacyProjection(requirement)
  return {
    school_id: requirement.schoolId,
    // NULL, NOT THE REQUIREMENT'S ID. See the note above: this column means a
    // public.statement_prompts row and nothing else.
    prompt_id: null,
    prompt_text: legacy.promptText,
    // NULL FOR A PAGE OR CHARACTER LIMIT, which is the truth: those schools
    // stated no word maximum, and null already means that everywhere.
    stated_max_words: legacy.statedMaxWords,
    requirement_id: requirement.requirementId,
    requirement_snapshot: requirement,
  }
}

/**
 * The prompt columns an UPDATE should carry, or NO KEYS AT ALL.
 *
 * THREE BRANCHES, ONE PER VALID STATE. Validity is already settled by
 * isPromptWrite() before any statement is built, so there is no fallback branch
 * here and a malformed value never reaches this function.
 *
 * SPREADING {} ADDS NOTHING, which is the whole mechanism: on the omitted state
 * the payload is byte-for-byte the four keys it has always been, so an ordinary
 * autosave cannot touch a stored prompt even by accident. A test asserts the
 * exact key set for all three states.
 *
 * `stated_max_words` IS PRESENT AND NULL for a prompt that states no limit --
 * not omitted. A school with no word limit must CLEAR a limit a previous prompt
 * left behind, and an omitted key would leave the old number in place beside
 * the new question.
 */
function promptColumns(prompt: PromptWrite | undefined): Record<string, unknown> {
  if (prompt === undefined) return {}
  // An explicit clear. Checked before the snapshot branch because null is not
  // a snapshot, and after undefined because the two mean opposite things.
  if (prompt === null) {
    return { school_id: null, prompt_id: null, prompt_text: null, stated_max_words: null }
  }
  return {
    school_id: prompt.schoolId,
    prompt_id: prompt.promptId,
    prompt_text: prompt.promptText,
    stated_max_words: prompt.statedMaxWords,
  }
}

/**
 * The two editor-document columns, or nothing at all.
 *
 * NOTHING AT ALL IS THE DEFAULT. Writing `editor_document: null` when a caller
 * said nothing would ERASE an applicant's formatting on every save from a
 * surface that does not carry it.
 */
/**
 * The chosen face, when one was sent and the column exists.
 *
 * NOTHING AT ALL IS THE DEFAULT, exactly as for the document: a caller that
 * said nothing about the font must not have its stored choice cleared by an
 * ordinary keystroke's autosave.
 *
 * null IS A REAL INSTRUCTION, though: it means "back to the Studio default",
 * and the column is nullable for precisely that.
 */
function documentFontColumns(input: DraftUpdateInput): Record<string, unknown> {
  if (input.documentFont === undefined) return {}
  if (!documentFontEnabled()) return {}
  return { document_font: input.documentFont }
}

function editorDocumentColumns(input: DraftUpdateInput): Record<string, unknown> {
  if (input.editorDocument === undefined) return {}
  if (!editorDocumentsEnabled()) return {}
  return {
    editor_document: input.editorDocument,
    editor_document_version: input.editorDocumentVersion ?? 1,
  }
}

/**
 * Saves an edit, or refuses. COMPARE AND SWAP, in one conditional statement.
 *
 * THE SEQUENCE, and it is fixed:
 *
 *   1. ONE update, conditional on `id = draftId AND revision = expectedRevision`.
 *      The condition IS the concurrency control -- there is no read-then-write
 *      window for another writer to land in, because the comparison and the write
 *      are the same statement.
 *   2. One row back  -> success. Its revision is expectedRevision + 1.
 *   3. Zero rows back -> ONE follow-up read by id, and only then:
 *        row present -> 'conflict', carrying the revision actually stored;
 *        row absent  -> 'not-found'.
 *
 * WHY THE FOLLOW-UP READ IS NEEDED AT ALL. A conditional update that matches
 * nothing cannot say why it matched nothing: the id may not exist, the row may
 * belong to someone else and be invisible, or the revision may have moved. Only
 * a second look distinguishes them, and it happens exactly once.
 *
 * WHAT THIS NEVER DOES. It does not retry. It does not overwrite on conflict. It
 * does not resolve anything automatically. A stale save performs NO write at all
 * -- the condition fails, so the UPDATE touches no row, and updated_at does not
 * move. That matters beyond concurrency: updated_at is the retention clock, so a
 * refused save must not look like activity.
 *
 * `created_at`, `user_id` and `id` are not in the payload and never will be.
 *
 * THE PROMPT TRAVELS IN THE SAME STATEMENT, when a caller supplies one. That is
 * not an optimisation, it is the correctness requirement: a prompt change and
 * the document it belongs to must consume ONE revision, under ONE compare and
 * swap. Two statements would leave a window in which a draft held a new
 * prompt_id beside the old prompt_text, and `updated_at` would move twice for
 * one save. So choosing a prompt costs a revision exactly as typing does, and a
 * caller who lost the race loses the prompt change with the rest of the save --
 * no write happens at all.
 *
 * AND THE SNAPSHOT IS NOT RESOLVED HERE. The fourth parameter is already
 * canonical; see PromptWrite. updateDraft issues one statement against
 * statement_drafts and never reads statement_prompts.
 *
 * THE TIMESTAMP IS NOT A PARAMETER. It is generated here, once, and there is no
 * way for a caller to supply one -- see the header. Tests therefore assert its
 * shape and that it was produced during the call, not a literal value.
 */
export async function updateDraft(
  db: SupabaseClient,
  draftId: string,
  input: DraftUpdateInput,
  prompt?: PromptWrite,
): Promise<DraftRepoResult<StatementDraft>> {
  // BEFORE ANYTHING ELSE, and that ordering is the point. A fourth argument
  // that is none of the three valid states is an internal error, so this
  // refuses before a timestamp is taken, before a statement is built and before
  // the database is touched: no row is read, no revision is consumed, and
  // updated_at -- the retention clock -- does not move. The alternative,
  // treating a malformed value as "unchanged", would turn a bug into a silent
  // no-op that looks exactly like a successful save.
  if (!isPromptWrite(prompt)) return badArgument('prompt')

  // ONCE per attempt, before the statement is built, and reused nowhere else.
  // The row records the instant this save was made, not whenever the database
  // got round to it.
  const savedAt = new Date().toISOString()

  const { data, error } = await db
    .from(DRAFTS)
    .update({
      title: input.title,
      essay: input.essay,
      revision: input.expectedRevision + 1,
      updated_at: savedAt,
      ...promptColumns(prompt),
      /*
        THE DOCUMENT, WHEN ONE WAS SENT.

        Spread, so a body without one writes the columns it always wrote and a
        draft keeps whatever formatting it had. The API has already refused any
        document whose text disagrees with `essay`, so by here the two are
        known to match.

        A BOLD-ONLY EDIT STILL BUMPS THE REVISION, because the revision counts
        saves of this row and this row changed. What does NOT change is
        `essay`, and the analysis fingerprint is taken over `essay`.
      */
      ...editorDocumentColumns(input),
      ...documentFontColumns(input),
    })
    .eq('id', draftId)
    .eq('revision', input.expectedRevision)
    .select(draftColumns())
    .maybeSingle()
  if (error) return failure('update-failed', error)

  if (data) {
    const draft = draftFromRow(data as unknown as StatementDraftRow)
    if (!draft) return integrity('update')
    return { ok: true, value: draft }
  }

  // Zero rows matched. One read decides which of the two answers it is.
  const { data: current, error: readError } = await db
    .from(DRAFTS)
    .select(draftColumns())
    .eq('id', draftId)
    .maybeSingle()
  // A FAILED FOLLOW-UP READ IS NOT A CONFLICT. Reporting one would tell the
  // caller their work is stale on the evidence of a dropped connection.
  if (readError) return failure('read-failed', readError)
  if (!current) return notFound

  const stored = draftFromRow(current as unknown as StatementDraftRow)
  // AND AN UNPARSEABLE REVISION IS NOT CONFLICT-AT-1. Without this, a corrupt
  // stored value would become a conflict against a revision nobody ever wrote,
  // and the client would resync onto a fiction.
  if (!stored) return integrity('update-conflict-read')
  return {
    ok: false,
    reason: 'conflict',
    detail: `stored revision ${stored.revision}`,
    storedRevision: stored.revision,
  }
}

/**
 * Deletes one draft by id. Explicit user deletion only -- no soft delete, no
 * retention sweep, and no write to updated_at.
 *
 * `.select('id')` is what makes "nothing was deleted" observable: without it
 * PostgREST returns no representation and a delete that matched nothing is
 * indistinguishable from one that matched. An invisible row and an absent row
 * both land on 'not-found', for the same reason readDraft does.
 */
export async function deleteDraft(
  db: SupabaseClient,
  draftId: string,
): Promise<DraftRepoResult<{ readonly id: string }>> {
  const { data, error } = await db
    .from(DRAFTS)
    .delete()
    .eq('id', draftId)
    .select('id')
    .maybeSingle()
  if (error) return failure('delete-failed', error)
  if (!data) return notFound

  const id = (data as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) return integrity('delete')
  return { ok: true, value: { id } }
}
