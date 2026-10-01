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
 */
function tooManyCodePoints(value: string): boolean {
  if (value.length <= MAX_PROMPT_TEXT_CHARS) return false
  const head = [...value.slice(0, MAX_PROMPT_TEXT_CHARS * 2 + 2)]
  return head.length > MAX_PROMPT_TEXT_CHARS
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
