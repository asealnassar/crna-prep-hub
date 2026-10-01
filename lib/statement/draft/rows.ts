/**
 * What a statement_drafts ROW is, and how to turn one into a draft. Pure.
 *
 * Mirrors lib/resume/repo/rows.ts in intent: the database's shape and the
 * application's shape are different things, and the conversion between them is
 * worth testing without a database. Nothing here opens a connection.
 *
 * THE ONE REAL PROBLEM THIS SOLVES. PostgREST may return a `bigint` as a JSON
 * STRING, because a bigint can exceed what JSON numbers represent safely. So
 * `revision` arrives as 5 or as "5" depending on nothing this code controls,
 * and both have to mean 5.
 *
 * WHY NOT `Number(value) || 1`. That is what lib/resume/repo/resumeRepo.ts does
 * today, and for a compare-and-swap it is the wrong shape: every malformed
 * stored value -- null, 'abc', '', 0 -- becomes revision 1. A CAS against a
 * fabricated 1 would then either overwrite a newer draft or report a conflict
 * that does not exist, and the corruption that caused it would never surface.
 * parseStoredRevision() refuses instead, and the repository turns a refusal into
 * a data-integrity failure the caller can see.
 *
 * THIS IS NOT THE CLIENT VALIDATOR. checkExpectedRevision() in validate.ts
 * refuses the string '1' on purpose: a caller may not send a revision as text.
 * The two functions guard opposite directions and must not be merged.
 */

/** The row as PostgREST hands it over. Snake case, and bigint may be a string. */
export interface StatementDraftRow {
  id: string | null
  user_id: string | null
  title: string | null
  essay: string | null
  /** bigint. A number OR a decimal string. See parseStoredRevision. */
  revision: number | string | null
  created_at: string | null
  updated_at: string | null

  // ----------------------------------------------- the prompt snapshot
  // All four are nullable in the table and all four are NULL together on a
  // generic draft. They are a SNAPSHOT of a statement_prompts row, copied at
  // the moment a prompt was chosen, so that editing the catalog can never
  // retroactively change the question an essay was written to answer.
  school_id: string | null
  prompt_id: string | null
  prompt_text: string | null
  /** integer, so PostgREST sends a JSON number -- never a string. */
  stated_max_words: number | null
}

/**
 * The narrower row the LIST projection asks for.
 *
 * `essay` is absent on purpose, not merely unused: a library screen showing
 * twenty titles has no business pulling twenty essays -- up to 20,000 characters
 * each -- across the wire. `user_id` is absent too; it is a WHERE clause, not a
 * column anything downstream reads.
 */
export interface StatementDraftSummaryRow {
  id: string | null
  title: string | null
  revision: number | string | null
  created_at: string | null
  updated_at: string | null
}

/** A draft, as the application uses it. Every field present and usable. */
export interface StatementDraft {
  readonly id: string
  readonly userId: string
  readonly title: string
  readonly essay: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string

  // ----------------------------------------------- the prompt snapshot
  // REQUIRED PROPERTIES WHOSE VALUE MAY BE null, and deliberately NOT
  // optional. A generic draft is a draft with no prompt, which is a fact worth
  // stating; `schoolId?: string` would make "this draft has no prompt" and
  // "nobody filled this field in" the same shape, and a consumer could not tell
  // a generic draft from a parser that forgot. undefined never appears here.
  readonly schoolId: string | null
  readonly promptId: string | null
  readonly promptText: string | null
  readonly statedMaxWords: number | null
}

/**
 * One entry in the draft library. Metadata only -- deliberately NOT a
 * StatementDraft with a field missing.
 *
 * A separate type rather than Omit<StatementDraft, 'essay'> because the two are
 * different things a caller may hold: anything typed StatementDraft carries the
 * applicant's essay, and a function that accepts one is entitled to assume so.
 * A summary that merely lacked the field would type-check its way into such a
 * function and arrive with the essay silently undefined.
 */
export interface StatementDraftSummary {
  readonly id: string
  readonly title: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Digits only, no sign, no decimal point, no exponent, no leading zero.
 *
 * DELIBERATELY STRICT. A bigint column reaches PostgREST as a plain run of
 * digits; it never arrives as ' 5', '+5', '5.0', '1e3' or '05'. Accepting those
 * would mean accepting a value that did not come from this column, and for a
 * compare-and-swap "probably 5" is not good enough. Rejecting '0' falls out of
 * the leading digit class for free, which is correct -- revision starts at 1.
 */
const DIGITS = /^[1-9][0-9]*$/

/**
 * A stored revision as a usable number, or null when the stored value is not
 * one.
 *
 * ACCEPTS a safe integer >= 1, or a decimal string of one.
 * REFUSES null, undefined, 0, negatives, fractions, '1.5', 'abc', '', ' 1',
 * '+1', '1e3', '05', booleans, objects, and any digit string past
 * Number.MAX_SAFE_INTEGER -- because a revision that cannot round-trip through
 * a JS number cannot be compared or incremented safely, and a silent loss of
 * precision in a CAS is worse than a refusal.
 *
 * NEVER FALLS BACK. There is no default. A caller that wants one must choose it
 * itself, in the open.
 */
export function parseStoredRevision(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? value : null
  }
  if (typeof value !== 'string') return null
  if (!DIGITS.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

// ---------------------------------------------------------------------------
// THE PROMPT SNAPSHOT
//
// The same contract promptRepo.ts applies to the catalog row these four
// columns were copied FROM, because the draft's CHECKs were deliberately
// written to mirror the catalog's. The rules are repeated here rather than
// imported so that this module keeps the property its header claims -- it
// depends on nothing -- and so that the core draft read path does not reach
// into the prompt resolver. rows.test.ts asserts the two parsers agree on every
// boundary value, which is what stops the copies drifting apart.
// ---------------------------------------------------------------------------

/** uuid, any version, any case. The same shape http.ts and validate.ts use. */
const SNAPSHOT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** statement_drafts_prompt_text_length: char_length(...) <= 5000, in CODE POINTS. */
const MAX_PROMPT_TEXT_CHARS = 5000

/** statement_drafts_stated_max_words_range: between 1 and 5000. */
const MIN_STATED_MAX_WORDS = 1
const MAX_STATED_MAX_WORDS = 5000

/**
 * Whether wording is longer than the column's ceiling, in code points.
 *
 * CODE POINTS, because that is what Postgres char_length() counts and this
 * value came OUT of a column constrained by it. Counting UTF-16 code units
 * would make this parser stricter than the CHECK and refuse wording the
 * database stored quite legitimately -- 3,000 emoji are 3,000 points but 6,000
 * units. validate.ts counts units because it measures what an applicant typed;
 * this counts points because it is reading what Postgres accepted.
 *
 * BOUNDED WORK. A code point is never fewer than one code unit, so anything
 * within the ceiling by .length is within it by char_length too and is never
 * counted. Only a longer value is, and then only its first 2 * ceiling + 2
 * units, which necessarily contain the first ceiling + 1 points.
 */
function tooManyCodePoints(value: string): boolean {
  if (value.length <= MAX_PROMPT_TEXT_CHARS) return false
  return [...value.slice(0, MAX_PROMPT_TEXT_CHARS * 2 + 2)].length > MAX_PROMPT_TEXT_CHARS
}

/** The stored word limit, or null for "no stated limit". undefined = malformed. */
function parseStatedMaxWords(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value !== 'number') return undefined
  if (!Number.isSafeInteger(value)) return undefined
  if (value < MIN_STATED_MAX_WORDS || value > MAX_STATED_MAX_WORDS) return undefined
  return value
}

/** The four snapshot fields of a draft, parsed. */
interface DraftPromptSnapshot {
  readonly schoolId: string | null
  readonly promptId: string | null
  readonly promptText: string | null
  readonly statedMaxWords: number | null
}

/** A generic draft: no prompt, stated once so the four nulls are never retyped. */
const NO_PROMPT: DraftPromptSnapshot = {
  schoolId: null, promptId: null, promptText: null, statedMaxWords: null,
}

/**
 * The four columns as a snapshot, or undefined when the row is incoherent.
 *
 * THREE OUTCOMES, and the middle one is the common case:
 *
 *   NO_PROMPT   all four are NULL -- a generic draft, which is valid and is
 *               what every draft created today looks like.
 *   a snapshot  a prompt was chosen: school, id and wording are all present
 *               and valid, and the word limit is a number or NULL.
 *   undefined   anything else. Reported by draftFromRow as data-integrity.
 *
 * COHERENCE IS THE WHOLE POINT. Any one of the four being non-NULL means a
 * prompt was chosen, and a chosen prompt must carry all three of school, id and
 * wording -- so a row holding a prompt_id with no prompt_text, or a
 * stated_max_words with nothing else, is refused rather than read as a partly
 * generic draft. The columns carry no cross-column CHECK and no foreign key at
 * this checkpoint, which is exactly why the read side has to say so.
 *
 * `statedMaxWords` STAYS NULLABLE FOR A CHOSEN PROMPT, because a school
 * stating no word limit is a real and common fact, distinct from zero.
 *
 * AN ABSENT FIELD IS NOT A NULL ONE. undefined on any of the four means the row
 * did not come from the current projection, which would otherwise make every
 * draft silently look generic -- the precise kind of invisible corruption this
 * module exists to refuse. The same discipline the required fields already get.
 *
 * NOTHING IS TRIMMED, REPAIRED OR INFERRED. The wording is returned exactly as
 * stored, and an out-of-range word limit is a refusal rather than a clamp.
 */
function parseDraftPrompt(row: StatementDraftRow): DraftPromptSnapshot | undefined {
  const { school_id: school, prompt_id: prompt, prompt_text: text } = row
  const words = row.stated_max_words

  if (school === undefined || prompt === undefined || text === undefined || words === undefined) {
    return undefined
  }

  if (school === null && prompt === null && text === null && words === null) return NO_PROMPT

  // A prompt was chosen, so all three identifying fields must be there.
  if (typeof school !== 'string' || !SNAPSHOT_UUID.test(school)) return undefined
  if (typeof prompt !== 'string' || !SNAPSHOT_UUID.test(prompt)) return undefined
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  if (tooManyCodePoints(text)) return undefined

  const statedMaxWords = parseStatedMaxWords(words)
  if (statedMaxWords === undefined) return undefined

  return { schoolId: school, promptId: prompt, promptText: text, statedMaxWords }
}

/**
 * One row as a draft, or null when the row cannot be trusted.
 *
 * A null means the database returned something this application cannot use --
 * a missing id, a null title on a NOT NULL column, an unparseable revision. The
 * repository reports that as a data-integrity failure rather than guessing,
 * because guessing is how corruption becomes invisible.
 *
 * `essay` is the one field where '' is legitimate, so it is checked for type
 * rather than for truthiness.
 */
export function draftFromRow(row: StatementDraftRow | null | undefined): StatementDraft | null {
  if (!row || typeof row !== 'object') return null

  const revision = parseStoredRevision(row.revision)
  if (revision === null) return null

  if (typeof row.id !== 'string' || row.id.length === 0) return null
  if (typeof row.user_id !== 'string' || row.user_id.length === 0) return null
  if (typeof row.title !== 'string') return null
  if (typeof row.essay !== 'string') return null
  if (typeof row.created_at !== 'string') return null
  if (typeof row.updated_at !== 'string') return null

  // An incoherent prompt snapshot makes the WHOLE row unusable, exactly as a
  // malformed revision does. A draft read with its prompt silently dropped
  // would be analysed against the wrong question, or against none.
  const prompt = parseDraftPrompt(row)
  if (prompt === undefined) return null

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    essay: row.essay,
    revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    schoolId: prompt.schoolId,
    promptId: prompt.promptId,
    promptText: prompt.promptText,
    statedMaxWords: prompt.statedMaxWords,
  }
}

/**
 * One list row as a summary, or null when the row cannot be trusted.
 *
 * Same refusal discipline as draftFromRow -- a malformed revision makes the row
 * unusable rather than defaulting -- over the narrower column set. It cannot
 * return an essay because it never received one.
 */
export function draftSummaryFromRow(
  row: StatementDraftSummaryRow | null | undefined,
): StatementDraftSummary | null {
  if (!row || typeof row !== 'object') return null

  const revision = parseStoredRevision(row.revision)
  if (revision === null) return null

  if (typeof row.id !== 'string' || row.id.length === 0) return null
  if (typeof row.title !== 'string') return null
  if (typeof row.created_at !== 'string') return null
  if (typeof row.updated_at !== 'string') return null

  return {
    id: row.id,
    title: row.title,
    revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
