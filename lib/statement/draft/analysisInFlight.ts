/**
 * AI-QA-017: one analysis at a time per draft and inputs, in THIS process.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * Production's protection against paying twice for one analysis is the claim
 * in migration 004: a unique constraint on (draft_id, fingerprint), a token
 * rotated on every claim, and a 10-minute staleness window. It is durable, it
 * works across instances, and nothing here replaces it.
 *
 * But the claim is taken only when the analysis cache is switched on, and there
 * is a third state. With the cache off:
 *
 *   IN PRODUCTION the route answers 503 and no analysis runs at all, so there
 *   is nothing to protect.
 *   ON A DEVELOPER'S MACHINE the route runs the model anyway and says so --
 *   'development-no-cache' -- because that is the only way to exercise the real
 *   pipeline locally.
 *
 * In that third state the claim block is skipped entirely, so four simultaneous
 * requests for the same draft and the same essay made FOUR model calls. The
 * audit measured exactly that. It is localhost-only, which is also where the
 * real API key lives: an owner double-clicking Analyze, or validating against
 * the real model, pays for every click.
 *
 * ---------------------------------------------------------------------------
 * WHY IN-PROCESS IS THE RIGHT SIZE FOR IT
 * ---------------------------------------------------------------------------
 * A durable claim is what the cache flag turns on, and writing a second durable
 * mechanism to cover the state where the first is off would be two things to
 * keep in step. This is a Map in one process: it collapses the burst that a
 * double-click or two tabs on one dev server produces, which is the whole of
 * the exposure, and it claims nothing more.
 *
 * SO IT IS BEST-EFFORT AND SAYS SO. Two instances do not see each other, a
 * restart forgets everything, and neither matters for the case it exists for.
 * The route still asks the real claim first whenever the cache is on; this is
 * consulted only when it is off.
 *
 * THE KEY IS THE FINGERPRINT, NOT THE DRAFT. Two different essays of the same
 * draft are two different analyses and must both run; the same essay twice is
 * the duplicate. That is the same question the claim asks.
 */

/** Keys currently being analysed, with when they started. */
const running = new Map<string, number>()

/**
 * How long a key may be held before it is treated as abandoned.
 *
 * ABOVE THE ROUTE'S OWN BUDGET. MODEL_TIMEOUT_MS is 50s and maxDuration is 60s,
 * so a request that is still holding a key after 90 seconds did not finish
 * normally -- the process was killed, or a bug skipped the release. Expiring is
 * what stops that becoming a draft nobody can analyse until the server
 * restarts.
 */
export const IN_FLIGHT_TTL_MS = 90_000

/** Caller-supplied clock, so a test does not sleep. */
export type Clock = () => number

/**
 * Take the slot for this key, or report that someone else holds it.
 *
 * SYNCHRONOUS AND SINGLE-STEP on purpose: a check followed by a set would let
 * two requests in the same tick both see it free. There is no await between
 * reading and writing.
 */
export function beginAnalysis(key: string, now: Clock = Date.now): boolean {
  const started = running.get(key)
  if (started !== undefined && now() - started < IN_FLIGHT_TTL_MS) return false
  running.set(key, now())
  return true
}

/**
 * Give the slot back.
 *
 * CALLED ON EVERY EXIT, including the failures. A key left behind would read as
 * "already running" to the applicant's next attempt for the whole TTL, which is
 * the same mistake an unreleased claim would be.
 */
export function endAnalysis(key: string): void {
  running.delete(key)
}

/** Test seam. Nothing in production calls this. */
export function resetAnalysisInFlight(): void {
  running.clear()
}

/** How many keys are held. Test seam, and a leak detector. */
export function analysesInFlight(): number {
  return running.size
}
