/**
 * How often the inbox may ask for metadata that is currently failing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS EXISTS TO STOP
 * ---------------------------------------------------------------------------
 * /api/messages/participants answers 500 whenever SUPABASE_SERVICE_ROLE_KEY is
 * absent, which is the ordinary state of a local development environment. The
 * route was made cheap -- it checks the key before it reads anything, so a
 * failure costs one environment read instead of ~37 Supabase queries -- but
 * the client went on asking, and asking faster than before precisely because
 * each answer now comes back instantly. Measured in the browser: nine requests
 * in 48 milliseconds.
 *
 * TWO RULES, AND NEITHER IS "IGNORE ERRORS":
 *
 *   SINGLE FLIGHT. While a request is outstanding, a second caller waits for
 *   that one instead of starting another. A burst of triggers becomes a
 *   request.
 *
 *   BACKOFF AFTER FAILURE. A failing endpoint is left alone for a growing
 *   interval, capped. The refresh is not dropped -- the inbox still renders,
 *   degraded exactly as it already degrades -- it is deferred.
 *
 * GENERIC, NOT KEYED ON THE ENVIRONMENT OR ON ANY MESSAGE. Nothing here looks
 * at NODE_ENV, at a status code's meaning or at a response body. Hammering an
 * endpoint that is failing is wrong everywhere, and so is this cure's absence;
 * production behaviour on SUCCESS is untouched, which is the thing that must
 * not move.
 *
 * THE CLOCK IS INJECTED so every branch is testable with no timers.
 */

/** Doubling from here. The first retry is prompt; a wedged endpoint is not. */
export const DEFAULT_META_BACKOFF_MS = 2_000

/** However long it keeps failing, it is retried at least this often. */
export const DEFAULT_META_BACKOFF_CEILING_MS = 60_000

export interface MetaGateOptions {
  readonly now?: () => number
  readonly backoffMs?: number
  readonly ceilingMs?: number
}

export interface MetaGate {
  /** Whether a request may be made right now. */
  readonly mayRequest: () => boolean
  /** When the next attempt becomes allowed, or null when one may go now. */
  readonly nextAllowedAt: () => number | null
  /** Record a success: the endpoint is healthy and the backoff resets. */
  readonly succeeded: () => void
  /**
   * Record a failure. Returns whether this failure should be LOGGED -- the
   * first of a run is worth a line, the hundredth is noise.
   */
  readonly failed: () => boolean
  /** Consecutive failures. Test seam, and what the backoff is computed from. */
  readonly failures: () => number
}

export function createMetaGate(options: MetaGateOptions = {}): MetaGate {
  const now = options.now ?? (() => Date.now())
  const base = options.backoffMs ?? DEFAULT_META_BACKOFF_MS
  const ceiling = options.ceilingMs ?? DEFAULT_META_BACKOFF_CEILING_MS

  let failures = 0
  let blockedUntil = 0

  return {
    mayRequest: () => failures === 0 || now() >= blockedUntil,
    nextAllowedAt: () => (failures === 0 || now() >= blockedUntil ? null : blockedUntil),
    succeeded: () => { failures = 0; blockedUntil = 0 },
    failed: () => {
      failures += 1
      // CAPPED BY THE EXPONENT, not only by the result, so a long outage cannot
      // overflow its way back to zero.
      const delay = Math.min(ceiling, base * Math.pow(2, Math.min(failures - 1, 20)))
      blockedUntil = now() + delay
      // THE FIRST OF A RUN, and nothing after it until something succeeds.
      return failures === 1
    },
    failures: () => failures,
  }
}

/**
 * The gate the inbox actually uses, and the request it has in flight.
 *
 * ---------------------------------------------------------------------------
 * MODULE SCOPE, NOT COMPONENT STATE
 * ---------------------------------------------------------------------------
 * Held in a ref, the gate died with its component -- and the inbox modal
 * remounts (it is keyed on the signed-in user, and React's development double
 * mount does it again). Every remount started a fresh gate with zero failures,
 * so every remount was allowed a request and allowed to log, which is exactly
 * the burst this exists to stop: the console showed "backing off" over and
 * over, each one believing it was the first of its run.
 *
 * ONE ENDPOINT, ONE CIRCUIT BREAKER. Its health is a fact about the server,
 * not about any component's lifetime, so it outlives them all. A page load
 * starts a new module instance and therefore a clean slate, which is right:
 * that is a new session with the server.
 */
export const inboxMetaGate = createMetaGate()

/** The single-flight slot, beside the gate for the same reason. */
let inFlight: Promise<unknown> | null = null

export function inboxMetaInFlight<T>(): Promise<T> | null {
  return inFlight as Promise<T> | null
}

export function setInboxMetaInFlight(promise: Promise<unknown> | null): void {
  inFlight = promise
}
