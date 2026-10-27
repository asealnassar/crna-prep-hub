/**
 * The only module that reads public.statement_prompts.
 *
 * Deliberately thin, in the same shape as draftRepo.ts beside it: the client is
 * supplied by the caller, the refusal union names answers separately from
 * failures, and a row that cannot be read is a refusal rather than a guess.
 *
 * WHAT THIS EXISTS TO MAKE POSSIBLE. A draft records which prompt it answers,
 * and the canonical school, wording and word limit belong to the catalog, not
 * to the browser. So a request may name a prompt by id and nothing more; this
 * module turns that id into the four values the server will snapshot. The
 * browser never supplies them and is never asked to.
 *
 * A SNAPSHOT, NOT A REFERENCE. What comes back here is copied into the draft's
 * own columns by a later checkpoint. The catalog migration says why: "A draft
 * stores its own snapshot of this, so editing a row here can never
 * retroactively change the question an essay was written to answer." Nothing
 * that scores a draft should ever join back to this table.
 *
 * THE CLIENT IS THE CALLER'S, never constructed here, so a route passes the
 * request-scoped client carrying the applicant's JWT and RLS stays in force.
 * NO SERVICE ROLE, and none is needed: `grant select on public.statement_prompts
 * to anon, authenticated` already covers this read. The table has no write
 * policy and no write grant, and this module issues no write either.
 *
 * RLS IS THE BOUNDARY, NOT THE FILTER. The catalog's only policy is
 * `for select to anon, authenticated using (is_active)`, so an inactive prompt
 * is already invisible to this read. The explicit `.eq('is_active', true)`
 * below is kept alongside it anyway, exactly as listDrafts keeps its
 * `.eq('user_id', ...)` next to the policy that makes it redundant: if the
 * policy is ever loosened, the filter is what stops a withdrawn question being
 * snapshotted into a new draft.
 *
 * WHICH MEANS 'not-found' COVERS TWO CASES, and must: a prompt that never
 * existed and a prompt that has been deactivated are one answer. A draft that
 * already references a deactivated prompt keeps working -- its snapshot is in
 * its own columns -- but it cannot be re-resolved, which is the whole reason
 * the snapshot exists.
 *
 * THE ID IS NOT REVALIDATED HERE. checkPromptSelection() in validate.ts is the
 * gate, and a caller runs it first, exactly as the draft routes run isDraftId
 * before reaching draftRepo. An unchecked non-uuid arriving here becomes a
 * Postgres 22P02 and therefore a 'read-failed', which is the same bargain
 * readDraft already makes.
 *
 * NOT YET WIRED TO ANYTHING. No route, no draft write and no editor state reads
 * this module at this checkpoint.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isPromptId } from './validate.ts'

const PROMPTS = 'statement_prompts'

/**
 * Columns this module reads. Named explicitly -- never `*` -- so a schema
 * addition cannot silently start arriving and no column is selected that is not
 * used.
 *
 * `is_active` IS FILTERED ON BUT NOT SELECTED, deliberately: the query needs
 * the predicate, and nothing downstream needs the value. `label`,
 * `application_cycle`, `display_order` and the timestamps are a picker's
 * business, not a snapshot's.
 */
const PROMPT_COLUMNS = 'id, school_id, prompt_text, stated_max_words'

/** The largest word limit the catalog's CHECK permits. */
const MAX_STATED_MAX_WORDS = 5000

/**
 * The longest wording the catalog's CHECK permits, in CODE POINTS.
 *
 * Numerically equal to MAX_STATED_MAX_WORDS and unrelated to it: one counts
 * words a school asks for, the other characters a column holds. Kept separate
 * so that changing either cannot silently move the other.
 */
const MAX_PROMPT_TEXT_CHARS = 5000

/**
 * The row as PostgREST hands it over. Snake case, every field nullable,
 * because a projection's type is a promise about the query and not about the
 * data that came back.
 *
 * `stated_max_words` IS THE ONE COLUMN THAT MAY BE NULL LEGITIMATELY -- NULL
 * means "this school states no limit", which is a different fact from zero and
 * stays distinguishable all the way to the snapshot.
 */
export interface StatementPromptRow {
  id: string | null
  school_id: string | null
  prompt_text: string | null
  stated_max_words: number | null
}

/**
 * The canonical prompt data a draft snapshots. Camel case, every field
 * present, and `statedMaxWords` explicitly nullable rather than optional: a
 * prompt with no stated limit is a real state, not a missing field.
 */
export interface StatementPromptSnapshot {
  readonly promptId: string
  readonly schoolId: string
  readonly promptText: string
  readonly statedMaxWords: number | null
}

/**
 * Why a read did not produce a snapshot.
 *
 * THE SAME THREE CATEGORIES draftRepo.ts draws, and for the same reason.
 * 'not-found' is an ANSWER -- the database did its job and there is no such
 * active prompt. 'read-failed' is the database or the network having failed,
 * which must never be reported as absence: a dropped connection that surfaced
 * as "that prompt does not exist" would invite a caller to conclude the catalog
 * had lost a row. 'data-integrity' is a third thing again: the query succeeded
 * and returned a row this application cannot interpret.
 *
 * THERE IS NO 'forbidden'. The catalog is public reference data, so there is
 * nothing to forbid; and an inactive prompt is invisible rather than refused.
 */
export type PromptRepoRefusal =
  | 'not-found'
  | 'read-failed'
  | 'data-integrity'

/** Same shape as DraftRepoResult, declared here rather than imported: this
 *  module is not the draft repository and a shared result type would be the
 *  first thread of exactly that coupling. */
export type PromptRepoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: PromptRepoRefusal; readonly detail: string }

/**
 * A database error, reduced to something safe to log: CODE AND MESSAGE ONLY.
 * A PostgREST error's `details` and `hint` can echo the row that failed, and a
 * prompt row carries a school's wording. Same rule as draftRepo's failure().
 */
function failure(reason: PromptRepoRefusal, error: unknown): PromptRepoResult<never> {
  const err = error as { code?: string; message?: string } | null
  return { ok: false, reason, detail: `${err?.code ?? ''} ${err?.message ?? ''}`.trim() }
}

/** The row came back but could not be read. Fixed words: never the row. */
function integrity(where: string): PromptRepoResult<never> {
  return { ok: false, reason: 'data-integrity', detail: `unusable stored row (${where})` }
}

const notFound: PromptRepoResult<never> = { ok: false, reason: 'not-found', detail: '' }

/**
 * A stated word limit as a usable number, or null when the column is NULL.
 * `undefined` on failure, so the three outcomes stay distinct.
 *
 * ACCEPTS null, and a safe integer within the range the catalog's CHECK
 * enforces: `stated_max_words is null or stated_max_words between 1 and 5000`.
 *
 * REFUSES A NUMERIC STRING, and this is the deliberate asymmetry with
 * parseStoredRevision() in rows.ts. That function accepts '5' because its
 * column is `bigint`, which PostgREST may legitimately send as a string to
 * protect precision. This column is `integer`: it arrives as a JSON number or
 * it did not come from this column. Accepting text here would be accepting a
 * value from somewhere else.
 *
 * AND REFUSES 0, NEGATIVES AND ANYTHING PAST 5,000 rather than clamping. Those
 * are values the CHECK cannot have permitted, so seeing one means the
 * constraint is gone -- and a snapshot quietly repaired is a schema failure
 * nobody ever learns about. NEVER FALLS BACK: there is no default word limit,
 * because "no stated limit" is already a meaning NULL carries.
 */
function parseStatedMaxWords(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number') return undefined
  if (!Number.isSafeInteger(value)) return undefined
  if (value < 1 || value > MAX_STATED_MAX_WORDS) return undefined
  return value
}

/**
 * Whether wording is longer than the column's ceiling, in code points.
 *
 * TWO STEPS, SO THE WORK IS BOUNDED. A code point is never fewer than one code
 * unit, so a value within the ceiling by .length is within it by char_length as
 * well and needs no counting at all -- which is every real prompt. Only a value
 * that fails that cheap test is counted, and then only its first
 * 2 * ceiling + 2 code units are examined, because a code point is at most two
 * units: that prefix necessarily contains the first ceiling + 1 points, which
 * is all it takes to decide. A corrupt megabyte-long value therefore costs the
 * same as a 10,002-unit one.
 *
 * THE CEILING IS A PARAMETER because two columns have one: prompt_text at 5,000
 * and label at 200. It defaults to prompt_text's, so every existing caller is
 * unchanged.
 */
function tooManyCodePoints(value: string, ceiling = MAX_PROMPT_TEXT_CHARS): boolean {
  if (value.length <= ceiling) return false
  const head = [...value.slice(0, ceiling * 2 + 2)]
  return head.length > ceiling
}

/**
 * One row as a snapshot, or null when the row cannot be trusted.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE. `id` and `school_id` are `uuid not null`
 * columns, so a non-uuid in either means the projection or the table has
 * changed under this code. `prompt_text` is `text not null` with a
 * `char_length(btrim(...)) >= 1` CHECK, so wording that is absent or entirely
 * whitespace is not a question -- and a blank prompt snapshotted into a draft
 * would later be fed to a scorer as the thing the essay answers.
 *
 * AND THE 5,000-CHARACTER CEILING IS ENFORCED HERE TOO, even though the
 * catalog's CHECK already enforces it. This parser is a trust boundary, not a
 * convenience: the snapshot it returns is written straight into
 * statement_drafts.prompt_text, which carries the SAME ceiling. A row that has
 * drifted past it -- a loosened constraint, a hand-edited row, a restored dump
 * -- would otherwise be read happily here and then fail at the write, as a
 * constraint violation on the draft the applicant was saving. Refusing it at
 * the read makes the failure belong to the prompt that is actually wrong.
 *
 * MEASURED IN CODE POINTS, which is what Postgres char_length() counts, and
 * deliberately NOT String.prototype.length. The two differ for astral
 * characters, and the difference has a direction that matters: counting code
 * units would make this parser STRICTER than both CHECKs and refuse wording
 * the database stored quite legitimately. This is the one place in the
 * statement code that counts points rather than units, because it is the one
 * place whose job is to predict what a Postgres CHECK will say -- validate.ts
 * counts units because it measures what an applicant typed.
 *
 * NOTHING IS TRUNCATED OR REPAIRED. Over-long wording is a row this
 * application cannot use, and a snapshot quietly cut to fit would put a
 * half-sentence in front of an applicant as the question they must answer.
 *
 * NOTHING IS TRIMMED. `btrim` decides whether the wording is empty; what is
 * returned is the string exactly as stored, because a school's own indentation
 * and paragraph breaks are part of the question.
 */
export function promptSnapshotFromRow(
  row: StatementPromptRow | null | undefined,
): StatementPromptSnapshot | null {
  if (!row || typeof row !== 'object') return null

  if (!isPromptId(row.id)) return null
  // The same uuid shape; the predicate is named for its first caller, not for
  // a column. schools.id is confirmed uuid in production.
  if (!isPromptId(row.school_id)) return null
  if (typeof row.prompt_text !== 'string' || row.prompt_text.trim().length === 0) return null
  if (tooManyCodePoints(row.prompt_text)) return null

  const statedMaxWords = parseStatedMaxWords(row.stated_max_words)
  if (statedMaxWords === undefined) return null

  return {
    promptId: row.id,
    schoolId: row.school_id,
    promptText: row.prompt_text,
    statedMaxWords,
  }
}

/**
 * Reads one ACTIVE prompt by id. ONE statement, and it writes nothing.
 *
 * maybeSingle() returns null for both "no such prompt" and "inactive, and
 * therefore invisible", which is the indistinguishability the policy was
 * written to produce.
 *
 * THE RETURNED ID IS COMPARED TO THE ONE ASKED FOR. It cannot differ while the
 * `.eq('id', ...)` holds -- which is the point: if it ever does, a filter
 * silently stopped applying, and snapshotting some other school's question into
 * an applicant's draft is not a failure worth absorbing.
 */
export async function readActivePrompt(
  db: SupabaseClient,
  promptId: string,
): Promise<PromptRepoResult<StatementPromptSnapshot>> {
  const { data, error } = await db
    .from(PROMPTS)
    .select(PROMPT_COLUMNS)
    .eq('id', promptId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) return failure('read-failed', error)
  if (!data) return notFound

  const snapshot = promptSnapshotFromRow(data as unknown as StatementPromptRow)
  if (!snapshot) return integrity('prompt')
  if (snapshot.promptId !== promptId) return integrity('prompt-id-mismatch')
  return { ok: true, value: snapshot }
}

// ===========================================================================
// THE PICKER'S LIST
//
// A SIBLING OF readActivePrompt, NOT A REUSE OF IT. That function resolves ONE
// prompt into the four canonical values a draft snapshots; this one lists the
// prompts a school offers, which needs `label` and `application_cycle` -- the
// two fields a snapshot deliberately excludes -- and does not need school_id,
// because the caller supplied it. Two questions, two projections.
//
// NOTHING BELOW CHANGES readActivePrompt OR promptSnapshotFromRow. The shared
// value rules -- the uuid shape, the 5,000-code-point ceiling, the 1..5,000
// word range -- are called, not copied.
// ===========================================================================

/** The longest label the catalog's CHECK permits, in CODE POINTS, trimmed. */
const MAX_LABEL_CHARS = 200

/**
 * 'YYYY' or 'YYYY-YYYY', anchored at both ends.
 *
 * THE SAME PATTERN statement_prompts_cycle_format ENFORCES, repeated here
 * because a value that reached this application from that column should be
 * refused if it does not match -- seeing one means the constraint is gone.
 * Whether the second year must be the first plus one is deliberately NOT
 * decided, exactly as the migration leaves it: '2026-2031' is accepted.
 */
const CYCLE = /^[0-9]{4}(-[0-9]{4})?$/

/**
 * Columns the LIST projection asks for. Five, named explicitly -- never `*`.
 *
 * `school_id` IS FILTERED ON BUT NOT SELECTED: the caller already knows which
 * school it asked about, so returning it would be returning the question.
 * `is_active` is the other predicate, and every returned row is active by
 * construction. `display_order` is the ORDER BY, not a value anything displays.
 * The timestamps are nobody's business here.
 */
const PROMPT_OPTION_COLUMNS = 'id, label, prompt_text, stated_max_words, application_cycle'

/** One row of the list projection, as PostgREST hands it over. */
export interface StatementPromptOptionRow {
  id: string | null
  label: string | null
  prompt_text: string | null
  stated_max_words: number | null
  application_cycle: string | null
}

/**
 * One prompt a school offers, as a picker may show it.
 *
 * DELIBERATELY NOT A StatementPromptSnapshot. An option is something to choose;
 * a snapshot is what gets copied onto a draft. An option carries `label` and
 * `applicationCycle`, which a draft never stores, and carries no `schoolId`,
 * which a draft must. Making them one type would let a list entry be passed
 * where a resolved snapshot is required.
 *
 * `statedMaxWords` null means the school states no limit -- a real fact,
 * distinct from zero. `applicationCycle` null means the prompt is not
 * cycle-specific.
 */
export interface StatementPromptOption {
  readonly id: string
  readonly label: string
  readonly promptText: string
  readonly statedMaxWords: number | null
  readonly applicationCycle: string | null
}

/**
 * One list row as an option, or null when the row cannot be trusted.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE, against the committed CHECKs:
 *
 *   id                uuid not null            -- a non-uuid means the
 *                                                 projection or the table moved
 *   label             btrim 1..200 code points -- a label of spaces is not a
 *                                                 label, and a picker would
 *                                                 render an unclickable blank
 *   prompt_text       btrim >= 1, <= 5,000     -- blank wording is not a
 *                                                 question; over-length means
 *                                                 the constraint is gone
 *   stated_max_words  null, or 1..5,000        -- shared parser
 *   application_cycle null, or YYYY/YYYY-YYYY  -- anchored both ends
 *
 * THE WORDING AND THE LABEL ARE RETURNED VERBATIM. `btrim` decides whether
 * either is empty; what comes back is the string exactly as stored, because a
 * school's own indentation and paragraph breaks are part of the question. The
 * label is MEASURED trimmed, matching its CHECK, but not returned trimmed.
 *
 * NOTHING IS REPAIRED. There is no fallback label, no truncated wording and no
 * default word limit.
 */
export function promptOptionFromRow(
  row: StatementPromptOptionRow | null | undefined,
): StatementPromptOption | null {
  if (!row || typeof row !== 'object') return null

  if (!isPromptId(row.id)) return null

  if (typeof row.label !== 'string') return null
  const trimmedLabel = row.label.trim()
  if (trimmedLabel.length === 0) return null
  if (tooManyCodePoints(trimmedLabel, MAX_LABEL_CHARS)) return null

  if (typeof row.prompt_text !== 'string' || row.prompt_text.trim().length === 0) return null
  if (tooManyCodePoints(row.prompt_text)) return null

  const statedMaxWords = parseStatedMaxWords(row.stated_max_words)
  if (statedMaxWords === undefined) return null

  const cycle = row.application_cycle
  if (cycle !== null) {
    if (typeof cycle !== 'string' || !CYCLE.test(cycle)) return null
  }

  return {
    id: row.id,
    label: row.label,
    promptText: row.prompt_text,
    statedMaxWords,
    applicationCycle: cycle,
  }
}

/**
 * Every ACTIVE prompt one school offers, in a deterministic order. One
 * statement, and it writes nothing.
 *
 * ZERO ROWS IS A SUCCESS, NOT 'not-found'. A school that has published no
 * prompt yet, and a catalog that is empty because nothing has been seeded, are
 * both legitimate answers -- and the catalog WAS empty at its last production
 * check, so this is the common case today. 'not-found' would make the picker
 * show an error where the honest answer is "none listed". listDrafts draws the
 * same line. This function therefore never returns 'not-found' at all.
 *
 * BUT ZERO ROWS MEANS AN EMPTY ARRAY, AND NOTHING ELSE. A `data` that is null,
 * or is not an array at all, is 'read-failed' -- see the check below. The two
 * must not be conflated: "no prompts" is a fact about a school, and "no usable
 * response" is a fact about this request, and only one of them is safe to show
 * an applicant as an empty picker.
 *
 * ORDER: display_order, THEN label, THEN id. The first is the school's intended
 * order; the other two exist because no uniqueness is enforced on
 * display_order -- the migration says ties are the reader's to break -- and an
 * unbroken tie would let the list shuffle between two renders of the same data.
 *
 * ONE MALFORMED ROW FAILS THE WHOLE LIST. Returning the other four would
 * silently hide a prompt a school published, and an applicant would conclude
 * the question was not offered. Same discipline as listDrafts.
 *
 * RLS IS THE BOUNDARY, NOT THE FILTER. `.eq('is_active', true)` is kept beside
 * the active-only policy that already makes it redundant, so that a loosened
 * policy cannot start offering withdrawn questions in a picker.
 *
 * THE SCHOOL ID IS NOT REVALIDATED HERE, matching readActivePrompt: the caller
 * checks it before this is reached, exactly as the draft routes run isDraftId
 * before reaching draftRepo. An unchecked non-uuid becomes a Postgres 22P02 and
 * therefore a 'read-failed'.
 */
export async function listActivePrompts(
  db: SupabaseClient,
  schoolId: string,
): Promise<PromptRepoResult<StatementPromptOption[]>> {
  const { data, error } = await db
    .from(PROMPTS)
    .select(PROMPT_OPTION_COLUMNS)
    .eq('school_id', schoolId)
    .eq('is_active', true)
    .order('display_order', { ascending: true })
    .order('label', { ascending: true })
    .order('id', { ascending: true })
  if (error) return failure('read-failed', error)

  // AN EMPTY ARRAY IS THE ONLY EMPTY ANSWER. `data` must actually BE an array:
  // null, undefined, an object or a string are not "this school has no
  // prompts", they are a response this code did not expect, and reporting one
  // as an empty catalog would tell an applicant a school asks no questions when
  // the truth is that something went wrong. There is no `?? []` here on
  // purpose. createDraft takes the same line on an insert that returns no row,
  // with the same synthetic code, because PostgREST gave no error to forward.
  if (!Array.isArray(data)) {
    return failure('read-failed', { code: 'NO_ROWS', message: 'select returned no array' })
  }

  const options: StatementPromptOption[] = []
  for (const row of data as unknown as StatementPromptOptionRow[]) {
    const option = promptOptionFromRow(row)
    if (!option) return integrity('prompt-option')
    options.push(option)
  }
  return { ok: true, value: options }
}
