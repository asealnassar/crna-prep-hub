/**
 * A save response, as an autosave event. Pure.
 *
 * THE ONE JOB. lib/resume/draft/autosave.ts is a state machine that knows
 * nothing about HTTP; it takes events. This module is the translation between
 * `PATCH /api/statement/drafts/[id]` and those events, and it is the whole of
 * the Statement-specific glue -- the engine itself is reused in place,
 * unmodified, and nothing here imports Resume logic.
 *
 * NO REACT, NO FETCH, NO TIMER, NO DATABASE. It receives a status, a body and a
 * timestamp, and returns one event. That makes every mapping below testable
 * without a request, which is the same reason judgeSuccess() in
 * extractInWorker.ts takes its clock as an argument.
 *
 * NETWORK ERRORS ARE NOT HERE, deliberately. A thrown fetch never produced a
 * status or a body, so there is nothing for this function to read. The driver
 * turns a throw straight into
 * `{ type: 'save-failed', retryable: true, reason: … }`, which is one line at
 * the call site and needs no abstraction here.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES THIS MODULE EXISTS TO ENFORCE
 *
 * 1. NO REVISION IS EVER INVENTED. Not incremented locally, not defaulted to 1,
 *    not coerced from something unparseable. A revision the client made up would
 *    be sent as the next `expectedRevision`, and the compare-and-swap would then
 *    either overwrite newer work or report a conflict against a number nobody
 *    wrote. When a revision cannot be read, the answer is a failure.
 *
 * 2. NOTHING FROM THE SERVER'S PROSE IS PASSED ON. Every `reason` below is a
 *    fixed string chosen here. The route's own bodies are already safe -- a 5xx
 *    is a constant and a `detail` never leaves the repository -- but a reason
 *    that echoed `body.error` would make that guarantee depend on the route
 *    forever. So the body is read for exactly two numbers and nothing else.
 * ---------------------------------------------------------------------------
 */

import type { AutosaveEvent } from '../../resume/draft/autosave.ts'
import { parseStoredRevision } from './rows.ts'

/**
 * The three events a save response can produce.
 *
 * Narrowed from AutosaveEvent on purpose: `edited`, `flush`, `retry` and
 * `reloaded` come from the applicant, never from a response, and a driver should
 * not have to consider them when handling one.
 */
export type SaveResultEvent = Extract<
  AutosaveEvent,
  { type: 'save-succeeded' } | { type: 'save-failed' } | { type: 'conflict' }
>

/**
 * What the applicant is told. Fixed strings, chosen here.
 *
 * These read as the tail of `describe()`'s failed branch -- "Not saved: …" --
 * which is the only place autosave surfaces `error`. None of them names a
 * table, a column, a status code or anything the server said.
 */
export const SAVE_MESSAGES = {
  /** 401. The session went away mid-edit; retrying cannot fix it. */
  expired: 'Your session expired. Sign in again to continue saving.',
  /** 404. Deleted here or on another device, or never existed. */
  missing: 'This draft no longer exists.',
  /** 400 / 422, and any other unexpected status. */
  refused: 'That change could not be saved.',
  /** A reply this editor could not read. See the note on ambiguity below. */
  unreadable: 'The server sent a reply this editor could not read.',
  /** 5xx. The only retryable case. */
  server: 'The server could not save this.',
  /**
   * The save was never acknowledged inside its deadline.
   *
   * SAID PLAINLY, BECAUSE THE ALTERNATIVE WAS SAYING NOTHING. Before this,
   * an unacknowledged save left "Saving…" on screen for ever: the applicant
   * was told a save was in progress when nothing was going to report on it,
   * every later save was refused by the single-flight rule, and leaving the
   * page waited on a promise that could not resolve. "Not saved" with a
   * working Try again is the honest version of that situation.
   */
  timeout: 'That save was not confirmed in time.',
} as const

/** `2xx`, matching what `Response.ok` means, so a driver need not re-decide. */
const succeeded = (status: number): boolean => status >= 200 && status < 300

/**
 * The revision from a success body: `{ draft: { revision } }`.
 *
 * REUSES parseStoredRevision, whose semantics fit exactly -- a positive safe
 * integer, or a decimal string of one, and null for everything else with no
 * fallback. A third revision parser would be a third place for the rules to
 * drift.
 *
 * THE CONTRACT SENDS A NUMBER. The route serialises publicDraft(), whose
 * `revision` is already normalised by draftFromRow(), so JSON carries a number.
 * The string branch is therefore defence in depth rather than a documented
 * shape: if a bigint ever reached the wire as text, this would still read it
 * rather than fail.
 *
 * NO UPPER BOUND IS APPLIED HERE. A stored revision may legitimately be
 * Number.MAX_SAFE_INTEGER, which the parser accepts. If a draft ever reached it,
 * the NEXT save would send it as `expectedRevision`, checkExpectedRevision()
 * would refuse it as un-incrementable, and this module would map the resulting
 * 400 to a non-retryable refusal. That is the correct place for that refusal --
 * bounding it here would misreport a readable draft as an unreadable reply.
 */
function revisionOfSuccess(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const draft = (body as { draft?: unknown }).draft
  if (typeof draft !== 'object' || draft === null) return null
  return parseStoredRevision((draft as { revision?: unknown }).revision)
}

/** The revision from a conflict body: `{ code: 'conflict', storedRevision }`. */
function storedRevisionOfConflict(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  return parseStoredRevision((body as { storedRevision?: unknown }).storedRevision)
}

const fail = (
  at: number,
  reason: string,
  retryable: boolean,
): SaveResultEvent => ({ type: 'save-failed', at, reason, retryable })

/**
 * One save response, as one event.
 *
 * @param status the HTTP status. A thrown request has none -- see the header.
 * @param body   the parsed JSON body, or anything at all if parsing failed.
 *               Read for two numbers only; never for prose.
 * @param at     the clock, supplied so this stays pure.
 *
 * THE MAPPING, in the order it is decided:
 *
 *   2xx + readable revision -> save-succeeded, carrying the SERVER's revision
 *   2xx + unreadable        -> save-failed, NOT retryable  (see below)
 *   409 + readable stored   -> conflict, carrying the stored revision
 *   409 + unreadable        -> save-failed, NOT retryable
 *   401                     -> save-failed, NOT retryable, 'expired'
 *   404                     -> save-failed, NOT retryable, 'missing'
 *   5xx                     -> save-failed, RETRYABLE
 *   anything else           -> save-failed, NOT retryable, 'refused'
 *
 * WHY AN UNREADABLE 2xx IS NOT RETRYABLE, which is the subtlest line here. The
 * write may well have landed -- the status said so -- and only the reply was
 * unreadable. Retrying would re-send the same `expectedRevision`, which is now
 * stale, producing a conflict the applicant did nothing to cause. Stopping and
 * saying so lets them reload and see the truth. What this must never do is
 * report success: a revision that was not read cannot be claimed.
 *
 * WHY 409 KEYS ON THE STATUS, NOT ON `code`. The stored revision is the thing a
 * client needs, and the status is what carries the meaning. The route does send
 * `code: 'conflict'`, but requiring it would turn a 409 that arrived with a
 * usable revision and an unexpected code into a generic failure, throwing away
 * the one value that lets the editor resync.
 *
 * 429 IS NOT PRODUCED BY THIS ROUTE, so it falls to 'refused' and stops. If rate
 * limiting is ever added, it wants its own retryable line here.
 */
export function saveEventFrom(input: {
  readonly status: number
  readonly body: unknown
  readonly at: number
}): SaveResultEvent {
  const { status, body, at } = input

  if (succeeded(status)) {
    const revision = revisionOfSuccess(body)
    if (revision === null) return fail(at, SAVE_MESSAGES.unreadable, false)
    return { type: 'save-succeeded', at, revision }
  }

  if (status === 409) {
    const storedRevision = storedRevisionOfConflict(body)
    // No usable revision means there is nothing to resync to, so this is a
    // failure rather than a conflict against a fabricated 1.
    if (storedRevision === null) return fail(at, SAVE_MESSAGES.unreadable, false)
    return { type: 'conflict', at, storedRevision }
  }

  if (status === 401) return fail(at, SAVE_MESSAGES.expired, false)
  if (status === 404) return fail(at, SAVE_MESSAGES.missing, false)
  if (status >= 500) return fail(at, SAVE_MESSAGES.server, true)

  // 400, 422, and anything unexpected. Not known to be transient, so it stops
  // and asks rather than retrying into the same refusal three more times.
  return fail(at, SAVE_MESSAGES.refused, false)
}
