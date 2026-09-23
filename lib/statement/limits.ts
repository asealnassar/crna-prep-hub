/**
 * What may be submitted to the Personal Statement Analyzer, decided before a
 * byte reaches OpenAI.
 *
 * WHY THIS EXISTS. The route checked `length < 100` and nothing else. There was
 * no ceiling on the statement and no ceiling on the request body, and Next's
 * App Router route handlers impose neither -- `request.json()` reads whatever
 * arrives. So a single paste could fill gpt-4o's context window, and anything
 * larger was read fully into memory before failing.
 *
 * ORDER MATTERS, and it is the caller's job to keep it: the BODY is measured
 * first, as raw bytes, before it is parsed; the STATEMENT is measured second,
 * after parsing; the model is called last. A refusal at either gate costs no
 * tokens.
 *
 * Pure and synchronous, so every refusal is unit-tested without a request.
 */

/** Below this there is not enough essay to say anything useful about. */
export const MIN_STATEMENT_CHARS = 100

/**
 * The ceiling, in characters.
 *
 * CRNA programmes ask for 500-1,500 words. 20,000 characters is roughly 3,000
 * words -- double the longest prompt anyone is answering, so a legitimate
 * applicant never meets it, including one who pastes an essay twice by mistake.
 */
export const MAX_STATEMENT_CHARS = 20_000

/**
 * The raw body ceiling for an analysis request, in bytes.
 *
 * 64 KB holds MAX_STATEMENT_CHARS of any realistic text -- four bytes per
 * character -- plus JSON overhead, and is small enough that a hostile body is
 * rejected before it is parsed rather than after.
 */
export const MAX_ANALYZE_BODY_BYTES = 64 * 1024

/**
 * The raw body ceiling for a rewrite request.
 *
 * Larger because a rewrite carries the statement AND the analysis of it back.
 * Still a hard cap: the analysis is bounded by lib/statement/analysis.ts, so
 * anything approaching this is not a well-formed request.
 */
export const MAX_REWRITE_BODY_BYTES = 256 * 1024

export type StatementRefusal = 'missing' | 'too-short' | 'too-long'

export type StatementCheck =
  | { readonly ok: true; readonly statement: string }
  | { readonly ok: false; readonly code: StatementRefusal; readonly message: string }

const REFUSALS: Record<StatementRefusal, string> = {
  missing: 'Please paste your personal statement.',
  'too-short': `Statement must be at least ${MIN_STATEMENT_CHARS} characters long`,
  'too-long': `That is longer than a personal statement. Please paste up to ${MAX_STATEMENT_CHARS.toLocaleString('en-US')} characters.`,
}

function refuse(code: StatementRefusal): StatementCheck {
  return { ok: false, code, message: REFUSALS[code] }
}

/**
 * The statement, or a refusal.
 *
 * Measured on the TRIMMED text, which is also what is returned, so the length
 * that was checked is the length that is sent. Checking one string and
 * forwarding another is how a cap gets bypassed with leading whitespace.
 *
 * Non-strings are 'missing' rather than a thrown error: a body carrying
 * `statement: { toString: ... }` is a malformed request, not an exception.
 */
export function checkStatement(value: unknown): StatementCheck {
  if (typeof value !== 'string') return refuse('missing')
  const statement = value.trim()
  if (statement.length === 0) return refuse('missing')
  if (statement.length < MIN_STATEMENT_CHARS) return refuse('too-short')
  if (statement.length > MAX_STATEMENT_CHARS) return refuse('too-long')
  return { ok: true, statement }
}

/** Whether a raw body may be parsed at all. Bytes, not characters. */
export function withinBodyLimit(raw: string, max: number): boolean {
  return Buffer.byteLength(raw, 'utf8') <= max
}

/**
 * Whether a request declares itself too large to accept, BEFORE it is read.
 *
 * `request.text()` buffers the whole body into memory, so a check that runs
 * after it has already paid the memory cost it is meant to prevent. An honest
 * client states its size in Content-Length, and an honest oversized request can
 * therefore be refused without reading a byte.
 *
 * A LIAR IS NOT TRUSTED. A missing, malformed, negative or understated header
 * returns false -- "not known to be oversized" -- and the real measurement
 * still runs on the bytes that actually arrive. This narrows the window; it is
 * not the control. `withinBodyLimit` is.
 */
export function declaredTooLarge(contentLength: string | null | undefined, max: number): boolean {
  if (typeof contentLength !== 'string') return false
  const trimmed = contentLength.trim()
  if (!/^\d{1,19}$/.test(trimmed)) return false
  return Number(trimmed) > max
}
