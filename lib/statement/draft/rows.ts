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

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    essay: row.essay,
    revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
