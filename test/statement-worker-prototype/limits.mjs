/**
 * The approved V2 limits, in one place, plus the prototype's own knobs.
 *
 * WHY A SEPARATE COPY. The prototype must not import from lib/statement or
 * lib/pdf -- Phase 1A is forbidden from touching production code, and a
 * prototype that reaches into it would make the two hard to tell apart later.
 * These are transcribed, and the transcription is the thing to check if a
 * production limit ever moves.
 */

/** Approved: the largest upload a person may send. */
export const MAX_UPLOAD_BYTES = 4_000_000

/** Approved: the most extracted text that may be held for editing. */
export const MAX_EXTRACTED_CHARS = 50_000

/** Approved: the most that may be SAVED as an essay. */
export const MAX_SAVED_CHARS = 20_000

/**
 * Approved: the TOTAL budget for one worker operation, end to end.
 *
 * ---------------------------------------------------------------------------
 * THIS NUMBER CHANGED MEANING. It did not change value.
 *
 * It used to be the EXTRACTION deadline, with the cooperative grace period and
 * the terminate wait added on afterwards. The audit showed where that leads: a
 * frozen worker held the request for 45,000 + 2,000 + an UNBOUNDED terminate
 * await -- 47 seconds at best, with no ceiling at worst, against a 60-second
 * function limit that is not 60 seconds of usable time.
 *
 * It is now the whole budget: parent-side copy, worker spawn, pdf.js load,
 * document load, extraction, cooperative cancellation, cleanup and forced
 * termination all come out of these 45,000 ms. Nothing is added after it.
 *
 * The two reserves below are carved OUT of it, not appended TO it.
 * ---------------------------------------------------------------------------
 */
export const PRODUCTION_DEADLINE_MS = 45_000

/**
 * Reserve, INSIDE the budget, for cooperative cancellation.
 *
 * The window in which a parse that reaches a yield point can notice the cancel
 * flag, run its own cleanup and exit on its own terms. When it elapses the
 * parent terminates the worker, which needs nobody's cooperation.
 *
 * STILL UNVERIFIED AS A VALUE. Cancellation is checked every chunk
 * (CANCEL_CHECK_EVERY_CHUNKS below), so when it can land at all it should land
 * in milliseconds -- which suggests 2,000 is generous by an order of magnitude.
 * Nobody has measured it. It is a reserve, and reserving too much only costs
 * extraction time; reserving too little costs a clean shutdown.
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
 * What it IS: the longest the parent will WAIT for confirmation before it
 * answers the caller. Past that point the call returns with the termination
 * state reported as `unconfirmed` -- never as success. Bounding the wait is the
 * only reason the 45,000 ms budget can be honoured at all.
 *
 * 1,000 ms is ~250x the one measured sample (~4 ms), and that sample had no
 * pdf.js state to tear down, so it is the best case rather than a typical one.
 */
export const TERMINATE_RESERVE_MS = 1_000

/**
 * THE FINAL RESERVE IS NOW SPLIT IN TWO. Its total is unchanged at 1,000 ms.
 *
 *      |<-------------- TERMINATE_RESERVE_MS 1,000 -------------->|
 *      |<------ cleanup wait 600 ------>|<-- terminate wait 400 ->|
 *      |<-- worker deadline 450 -->|      <- 150ms reporting margin
 *
 * WHY. The audit found an ORDERING defect, not a cleanup defect: the worker
 * posts its result and only then starts pdf.js teardown, while the parent's
 * `finish()` reaches `worker.terminate()` with no yield in between. The worker
 * got 0.2-0.3 ms -- measured -- and `worker:worker-finished` was absent from
 * every run. Nothing suggested cleanup could not finish; it was never given the
 * chance.
 *
 * The parent now waits, INSIDE this same reserve, so the 45,000 ms total does
 * not move. The worker's own deadline is deliberately shorter than the parent's
 * wait: the 150 ms difference is the margin for the report to be posted and
 * delivered, so a worker that finishes right on its deadline is still heard.
 *
 * WHAT THIS COSTS. The bounded-termination wait shrinks from 1,000 ms to 400 ms.
 * That reserve is the guard against a thread `terminate()` cannot stop, so the
 * margin is smaller. Measured terminate latency has been 1.3-2.5 ms, leaving
 * ~160x headroom, but it IS a reduction and was accepted knowingly.
 */
export const CLEANUP_WAIT_MS = 600
export const CLEANUP_DEADLINE_MS = 450
export const TERMINATE_WAIT_MS = 400

/** How the reserve divides. Applied proportionally to shorter test budgets. */
const CLEANUP_WAIT_SHARE_OF_RESERVE = 0.60
const CLEANUP_DEADLINE_SHARE_OF_WAIT = 0.75

/** Where a worker checks whether it has been asked to stop. */
export const CANCEL_CHECK_EVERY_CHUNKS = 1

/**
 * A reserve may never eat more than this share of a small budget.
 *
 * Offline tests run budgets of 20-500 ms. Subtracting a flat 2,000 + 1,000 from
 * those would leave nothing for extraction, so the reserves scale down
 * proportionally instead. At the approved 45,000 ms neither cap binds.
 */
const GRACE_MAX_SHARE = 0.30
const TERMINATE_MAX_SHARE = 0.20

/**
 * Split a total budget into extraction, cancellation and termination.
 *
 * Pure, so it can be reasoned about without launching anything.
 *
 *   planBudget()               -> 45,000 total: 42,000 / 2,000 / 1,000
 *   planBudget(400, 300)       ->    400 total:    200 /   120 /    80
 *   planBudget(0) / (NaN) / () -> 45,000. AN OMITTED OR INVALID BUDGET CANNOT
 *                                 DISABLE THE TIMEOUT; it falls back to the
 *                                 approved value. The old code armed no timer
 *                                 at all when the argument was missing, because
 *                                 `undefined > 0` is false.
 *
 * A budget ABOVE the approved maximum is clamped down to it. 45,000 ms is a
 * ceiling, so no caller -- and no test -- may quietly exceed it. Raising it is
 * a one-line change here, which is where such a decision belongs.
 *
 * @param {number} [budgetMs]        total budget; defaults to and is capped at
 *                                   PRODUCTION_DEADLINE_MS
 * @param {number} [graceOverrideMs] TEST ONLY: a shorter cooperative reserve.
 *                                   Still clamped by GRACE_MAX_SHARE, so it can
 *                                   never push the total past the budget.
 */
export function planBudget(budgetMs, graceOverrideMs) {
  const requested = Number.isFinite(budgetMs) && budgetMs > 0
    ? Math.floor(budgetMs)
    : PRODUCTION_DEADLINE_MS
  const budget = Math.min(requested, PRODUCTION_DEADLINE_MS)

  const wantedGrace = Number.isFinite(graceOverrideMs) && graceOverrideMs >= 0
    ? Math.floor(graceOverrideMs)
    : COOPERATIVE_GRACE_MS

  const graceMs = Math.min(wantedGrace, Math.floor(budget * GRACE_MAX_SHARE))
  const terminateMs = Math.min(TERMINATE_RESERVE_MS, Math.floor(budget * TERMINATE_MAX_SHARE))

  // The reserve divides; it does not grow. cleanupWaitMs + terminateWaitMs is
  // exactly terminateMs, so `extractionMs` below is unchanged and the total
  // budget is untouched.
  const cleanupWaitMs = Math.min(CLEANUP_WAIT_MS, Math.floor(terminateMs * CLEANUP_WAIT_SHARE_OF_RESERVE))
  const terminateWaitMs = terminateMs - cleanupWaitMs
  // Shorter than the parent's wait on purpose: the remainder is the margin for
  // posting and delivering the report.
  const cleanupDeadlineMs = Math.min(CLEANUP_DEADLINE_MS, Math.floor(cleanupWaitMs * CLEANUP_DEADLINE_SHARE_OF_WAIT))

  return {
    budgetMs: budget,
    // What is left for spawn + pdf.js load + document load + extraction.
    extractionMs: budget - graceMs - terminateMs,
    graceMs,
    // The whole final reserve, unchanged in meaning and value.
    terminateMs,
    // Its two halves.
    cleanupWaitMs,
    terminateWaitMs,
    // Handed to the worker so its internal bound cannot outlast the parent's.
    cleanupDeadlineMs,
    // True when the caller asked for more than the approved ceiling.
    clampedFromMs: requested > budget ? requested : null,
  }
}
