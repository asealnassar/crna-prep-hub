/**
 * The approved Personal Statement Studio V2 limits, and the worker budget.
 *
 * PORTED FROM test/statement-worker-prototype/limits.mjs, values unchanged. The
 * prototype keeps its own copy deliberately -- it must not import production
 * code -- so these two files now state the same numbers twice. If one moves, the
 * other has to move with it, and limits.test.ts is what catches a drift.
 *
 * UNITS ARE PART OF THE VALUE. `MAX_UPLOAD_BYTES` is bytes, decimal. The two
 * character limits are UTF-16 code units, which is what `String.prototype.length`
 * counts and therefore what every check in this codebase compares against.
 */

// ---------------------------------------------------------------------------
// Approved application limits. NOTHING IN THIS DIRECTORY ENFORCES THEM.
//
// The worker returns the complete extracted text. Deciding what is eligible --
// rejecting rather than truncating -- belongs to the upload route, which does
// not exist yet. These are here so that route has one place to read them from.
// ---------------------------------------------------------------------------

/**
 * Approved: the largest upload a person may send, in BYTES.
 *
 * DECIMAL, NOT BINARY. 4,000,000 bytes, not 4 MiB (4,194,304). The difference is
 * 194,304 bytes, so a file between the two is accepted under one reading and
 * refused under the other. The prototype was built and measured against this
 * value; the largest synthetic fixture is 3,911,780 bytes, under both.
 */
import { simulatedLiveEnabled } from '../devMode/gate.ts'

export const MAX_UPLOAD_BYTES = 4_000_000

/** Approved: the most extracted text that may be held for editing. */
export const MAX_EXTRACTED_CHARS = 50_000

/**
 * Approved: the most that may be SAVED as a statement.
 *
 * THE VALUE THE DATABASE ACTUALLY ENFORCES TODAY, from
 * 20260928_000's statement_drafts_essay_length. Read it through
 * maxSavedChars() rather than directly: the ceiling moves with migration 016,
 * and a client that refused at a different number than the database would
 * either reject saveable work or let an unsaveable write leave the machine.
 */
export const MAX_SAVED_CHARS = 20_000

/**
 * The ceiling once 20261013_016 is applied.
 *
 * ---------------------------------------------------------------------------
 * WHY IT HAD TO MOVE
 * ---------------------------------------------------------------------------
 * The catalog publishes a requirement the old ceiling could not hold.
 * University of Tennessee Knoxville asks for up to 18,000 characters
 * EXCLUDING spaces; the column counts what is stored, which includes them.
 * Prose at exactly that maximum measures 18,000 excluding spaces and 22,287
 * stored -- so an applicant writing to their school's published limit could
 * not save at all.
 *
 * 30,000 is read off the catalog, not chosen for roundness: the worst case
 * each kind of bound can demand is ~24,000 (18,000 excluding spaces with
 * three-letter words), ~22,800 (five single-spaced pages at the Studio's own
 * geometry) and ~7,000 (the largest word maximum, 1,000 words). It clears all
 * three and stays under MAX_EXTRACTED_CHARS, so extraction can still deliver
 * more than a draft may hold and be refused explicitly.
 */
export const EXPANDED_SAVED_CHARS = 30_000

/**
 * Which ceiling is in force.
 *
 * ---------------------------------------------------------------------------
 * THE ANSWER IS ABOUT THE SCHEMA IN FRONT OF US, NOT ABOUT THE ENVIRONMENT
 * ---------------------------------------------------------------------------
 * There are three situations and only two answers:
 *
 *   simulated live       the local JSON store stands in for the table, and it
 *                        emulates the POST-016 CHECK. 30,000.
 *   the real database,   whatever NODE_ENV says, the column still holds
 *   016 not applied      statement_drafts_essay_length at 20,000. 20,000.
 *   016 applied          the flag is turned on deliberately, once, by whoever
 *                        applied it. 30,000.
 *
 * THE MIDDLE CASE IS WHY THIS IS NOT KEYED ON NODE_ENV. A first version of
 * this function answered 30,000 for `development` alone -- so a dev server run
 * with STATEMENT_SIMULATED_LIVE=off, which talks to the real database, would
 * have accepted 30,000 characters from the applicant and then had PostgREST
 * refuse them mid-save. That is precisely the failure validate.ts exists to
 * prevent: "nothing the database would refuse is accepted here".
 *
 * FAILS CLOSED, like every other unapplied-migration flag: anything but the
 * exact string 'on' is off.
 *
 * THE ENV IS THREADED THROUGH so a test can ask all three questions without
 * mutating process.env.
 */
export const DRAFT_LENGTH_CEILING_ENV = 'STATEMENT_DRAFT_LENGTH_CEILING'

export function maxSavedChars(env: NodeJS.ProcessEnv = process.env): number {
  if (env[DRAFT_LENGTH_CEILING_ENV] === 'on') return EXPANDED_SAVED_CHARS
  if (simulatedLiveEnabled(env)) return EXPANDED_SAVED_CHARS
  return MAX_SAVED_CHARS
}

/**
 * A ceiling the SERVER resolved, as the browser must read it.
 *
 * ---------------------------------------------------------------------------
 * THE BROWSER MUST NOT INFER WHICH SCHEMA IS BEHIND THE API
 * ---------------------------------------------------------------------------
 * maxSavedChars() answers from the environment, and the environment is a
 * server fact. Inside the client bundle the env object it is handed carries
 * neither NODE_ENV nor the simulated-live opt-out, so it answered 20,000 while
 * the server accepted 30,000: the editor refused to send an essay that met the
 * school's published maximum and that the API would have stored. That is the
 * whole of QA-004, and no amount of guessing in the browser is the fix -- the
 * client is told the number by the side that knows it.
 *
 * FAILS CLOSED, and this is the parser's reason for existing. A value that is
 * missing, malformed, not finite, below the floor or above what this build
 * knows how to honour becomes MAX_SAVED_CHARS -- the ceiling every schema has
 * had. A client that cannot read the capability refuses more than the server
 * would, never less.
 */
export function ceilingFromServer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_SAVED_CHARS
  if (!Number.isInteger(value)) return MAX_SAVED_CHARS
  if (value < MAX_SAVED_CHARS || value > EXPANDED_SAVED_CHARS) return MAX_SAVED_CHARS
  return value
}

// ---------------------------------------------------------------------------
// The worker budget.
// ---------------------------------------------------------------------------

/**
 * Approved: the TOTAL budget for one worker operation, end to end.
 *
 * NOT an extraction deadline. Parent-side copy, worker spawn, pdf.js load,
 * document load, extraction, cooperative cancellation, pdf.js cleanup and forced
 * termination all come out of these 45,000 ms. Nothing is added afterwards, and
 * the two reserves below are carved OUT of it rather than appended TO it.
 *
 * It is also a CEILING: `planBudget()` clamps anything larger down to it.
 */
export const PRODUCTION_DEADLINE_MS = 45_000

/**
 * Reserve, INSIDE the budget, for cooperative cancellation.
 *
 * The window in which a parse that reaches a yield point can notice the cancel
 * flag, run its own cleanup and exit on its own terms. When it elapses the
 * parent terminates the worker, which needs nobody's cooperation.
 *
 * Generous on purpose: reserving too much only costs extraction time, while
 * reserving too little costs a clean shutdown.
 */
export const COOPERATIVE_GRACE_MS = 2_000

/**
 * Reserve, INSIDE the budget, for forced termination.
 *
 * WHAT THIS IS NOT. It is not a guarantee that the worker dies within 1,000 ms.
 * `worker.terminate()` has no documented upper bound: V8 can interrupt JS, but
 * it cannot interrupt arbitrary native code, and this dependency tree contains
 * native bindings. Nothing in JavaScript can promise a thread has physically
 * stopped.
 *
 * What it IS: the longest the parent will WAIT for confirmation before it answers
 * the caller. Past that point the call returns with the termination state
 * reported as `unconfirmed` -- never as success. Bounding the wait is the only
 * reason the 45,000 ms budget can be honoured at all.
 */
export const TERMINATE_RESERVE_MS = 1_000

/**
 * THE FINAL RESERVE IS SPLIT IN TWO. Its total is unchanged at 1,000 ms.
 *
 *      |<-------------- TERMINATE_RESERVE_MS 1,000 -------------->|
 *      |<------ cleanup wait 600 ------>|<-- terminate wait 400 ->|
 *      |<-- worker deadline 450 -->|      <- 150ms reporting margin
 *
 * WHY. The worker posts its result and only then starts pdf.js teardown, while
 * the parent's finish() would otherwise reach `worker.terminate()` with no yield
 * in between -- measured, the worker got 0.2-0.3 ms and its cleanup report was
 * absent from every run. Nothing suggested cleanup could not finish; it was never
 * given the chance. The parent now waits, INSIDE this same reserve, so the total
 * does not move.
 *
 * The worker's own deadline is deliberately shorter than the parent's wait: the
 * 150 ms difference is the margin for the report to be posted and delivered, so a
 * worker that finishes right on its deadline is still heard.
 */
export const CLEANUP_WAIT_MS = 600
export const CLEANUP_DEADLINE_MS = 450
export const TERMINATE_WAIT_MS = 400

/** How the reserve divides. Applied proportionally to shorter test budgets. */
const CLEANUP_WAIT_SHARE_OF_RESERVE = 0.6
const CLEANUP_DEADLINE_SHARE_OF_WAIT = 0.75

/**
 * A reserve may never eat more than this share of a small budget.
 *
 * Tests run budgets of 20-500 ms. Subtracting a flat 2,000 + 1,000 from those
 * would leave nothing for extraction, so the reserves scale down proportionally
 * instead. At the approved 45,000 ms neither cap binds.
 */
const GRACE_MAX_SHARE = 0.3
const TERMINATE_MAX_SHARE = 0.2

/** How one total budget divides. Every field is milliseconds. */
export interface BudgetPlan {
  /** The total, after clamping to PRODUCTION_DEADLINE_MS. */
  readonly budgetMs: number
  /** What is left for spawn + pdf.js load + document load + extraction. */
  readonly extractionMs: number
  readonly graceMs: number
  /** The whole final reserve. */
  readonly terminateMs: number
  /** Its two halves: cleanupWaitMs + terminateWaitMs === terminateMs. */
  readonly cleanupWaitMs: number
  readonly terminateWaitMs: number
  /** Handed to the worker so its internal bound cannot outlast the parent's. */
  readonly cleanupDeadlineMs: number
  /** Set when the caller asked for more than the approved ceiling. */
  readonly clampedFromMs: number | null
}

/**
 * Split a total budget into extraction, cancellation and termination.
 *
 * Pure, so it can be reasoned about without launching anything.
 *
 *   planBudget()               -> 45,000 total: 42,000 / 2,000 / 1,000
 *   planBudget(400, 300)       ->    400 total:    200 /   120 /    80
 *   planBudget(0) / (NaN) / () -> 45,000. AN OMITTED OR INVALID BUDGET CANNOT
 *                                 DISABLE THE TIMEOUT; it falls back to the
 *                                 approved value.
 *
 * A budget ABOVE the approved maximum is clamped down to it. 45,000 ms is a
 * ceiling, so no caller -- and no test -- may quietly exceed it.
 *
 * @param budgetMs        total budget; defaults to and is capped at PRODUCTION_DEADLINE_MS
 * @param graceOverrideMs TEST ONLY: a shorter cooperative reserve. Still clamped
 *                        by GRACE_MAX_SHARE, so it can never push the total past
 *                        the budget.
 */
export function planBudget(budgetMs?: number, graceOverrideMs?: number): BudgetPlan {
  const requested =
    typeof budgetMs === 'number' && Number.isFinite(budgetMs) && budgetMs > 0
      ? Math.floor(budgetMs)
      : PRODUCTION_DEADLINE_MS
  const budget = Math.min(requested, PRODUCTION_DEADLINE_MS)

  const wantedGrace =
    typeof graceOverrideMs === 'number' && Number.isFinite(graceOverrideMs) && graceOverrideMs >= 0
      ? Math.floor(graceOverrideMs)
      : COOPERATIVE_GRACE_MS

  const graceMs = Math.min(wantedGrace, Math.floor(budget * GRACE_MAX_SHARE))
  const terminateMs = Math.min(TERMINATE_RESERVE_MS, Math.floor(budget * TERMINATE_MAX_SHARE))

  // The reserve divides; it does not grow. cleanupWaitMs + terminateWaitMs is
  // exactly terminateMs, so extractionMs is unchanged and the total is untouched.
  const cleanupWaitMs = Math.min(
    CLEANUP_WAIT_MS,
    Math.floor(terminateMs * CLEANUP_WAIT_SHARE_OF_RESERVE),
  )
  const terminateWaitMs = terminateMs - cleanupWaitMs
  // Shorter than the parent's wait on purpose: the remainder is the margin for
  // posting and delivering the report.
  const cleanupDeadlineMs = Math.min(
    CLEANUP_DEADLINE_MS,
    Math.floor(cleanupWaitMs * CLEANUP_DEADLINE_SHARE_OF_WAIT),
  )

  return {
    budgetMs: budget,
    extractionMs: budget - graceMs - terminateMs,
    graceMs,
    terminateMs,
    cleanupWaitMs,
    terminateWaitMs,
    cleanupDeadlineMs,
    clampedFromMs: requested > budget ? requested : null,
  }
}
