/**
 * Coalescing the inbox refresh.
 *
 * WHAT THIS EXISTS TO STOP. `loadThreads()` ends in `fetchInboxMeta()`, which
 * calls /api/messages/participants. For the admin account that one call reads
 * ~1,097 threads, ~2,410 message bodies, every participant row and every read
 * receipt -- roughly 37 Supabase requests and a few megabytes, EVERY TIME.
 *
 * Measured on 2026-09-22: 8,999 outbound Supabase calls from that route in a
 * day, against 24 messages actually sent. The messages were never the problem.
 * The triggers were:
 *
 *   - every Realtime INSERT fired a full reload, undebounced;
 *   - every `visibilitychange` back to the tab fired another, unthrottled --
 *     so a development session spent switching between editor and browser
 *     reloaded the entire inbox on every single switch.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Nothing here drops a refresh. Every
 * trigger still results in a refresh; they are merely coalesced, and both
 * paths carry a ceiling so a refresh can never be postponed indefinitely:
 *
 *   - a burst of Realtime events settles after `debounceMs`, but a SUSTAINED
 *     stream still refreshes every `maxWaitMs` rather than starving behind a
 *     timer that keeps being pushed back;
 *   - a `visibilitychange` inside the throttle window is DEFERRED to the end
 *     of that window, not discarded, so the longest a new message or unread
 *     count can wait is `minVisibleIntervalMs` after the previous refresh.
 *
 * The clock and the timer are injected so every branch is testable offline,
 * with no React, no DOM and no network.
 */

/** A burst of Realtime events settles this long after the last one. */
export const DEFAULT_DEBOUNCE_MS = 1_500

/** ...but a sustained stream still refreshes at least this often. */
export const DEFAULT_MAX_WAIT_MS = 5_000

/** Returning to the tab refreshes at most this often. */
export const DEFAULT_MIN_VISIBLE_INTERVAL_MS = 30_000

export type TimerHandle = unknown

export type Timer = {
  set: (fn: () => void, ms: number) => TimerHandle
  clear: (handle: TimerHandle) => void
}

export type SchedulerOptions = {
  /**
   * What to run. May return a promise; if it does, the scheduler will not
   * start a second run until it settles. Rejection is treated as completion —
   * a failed refresh must not wedge the scheduler.
   */
  readonly run: () => void | Promise<unknown>
  readonly now?: () => number
  readonly timer?: Timer
  readonly debounceMs?: number
  readonly maxWaitMs?: number
  readonly minVisibleIntervalMs?: number
}

export type RefreshScheduler = {
  /** A Realtime INSERT arrived. */
  onRealtimeEvent: () => void
  /** The tab became visible. */
  onVisible: () => void
  /** Run immediately, cancelling anything pending. */
  runNow: () => void
  /** Drop anything pending. Used on unmount. */
  cancel: () => void
  /** Absolute time the next run is due, or null. Test seam. */
  dueAt: () => number | null
  /** When the last run happened. Test seam. */
  lastRunAt: () => number
}

const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function createRefreshScheduler(options: SchedulerOptions): RefreshScheduler {
  const run = options.run
  const now = options.now ?? Date.now
  const timer = options.timer ?? realTimer
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const minVisibleIntervalMs = options.minVisibleIntervalMs ?? DEFAULT_MIN_VISIBLE_INTERVAL_MS

  /**
   * The mount's own `loadThreads()` counts as a refresh, so a visibilitychange
   * landing immediately after mount does not fire a second full read.
   */
  let lastRun = now()

  /** When the current Realtime burst began, for the max-wait ceiling. */
  let burstStartedAt: number | null = null

  /** The two independent desired times. The earlier one wins. */
  let realtimeDueAt: number | null = null
  let visibilityDueAt: number | null = null

  let handle: TimerHandle | null = null
  /** The absolute time `handle` is currently set for. */
  let scheduledFor: number | null = null

  /**
   * A refresh is running. `loadThreads()` on a large inbox is ~37 Supabase
   * requests and takes seconds, so without this a second trigger could start
   * an overlapping full read -- doubling exactly the cost this file exists to
   * cut. A trigger arriving mid-flight is REMEMBERED, not dropped, and runs
   * once the current one settles.
   */
  let inFlight = false
  let queuedWhileInFlight = false

  const effectiveDue = (): number | null => {
    if (realtimeDueAt === null) return visibilityDueAt
    if (visibilityDueAt === null) return realtimeDueAt
    return Math.min(realtimeDueAt, visibilityDueAt)
  }

  const clearTimer = () => {
    if (handle !== null) timer.clear(handle)
    handle = null
    scheduledFor = null
  }

  const fire = () => {
    clearTimer()
    realtimeDueAt = null
    visibilityDueAt = null
    burstStartedAt = null

    // Never two full inbox reads at once. The request is not lost: it is
    // re-scheduled below the moment the running one settles.
    if (inFlight) {
      queuedWhileInFlight = true
      return
    }

    lastRun = now()
    inFlight = true

    const settle = () => {
      inFlight = false
      if (!queuedWhileInFlight) return
      queuedWhileInFlight = false
      // Through the normal path, not immediately: consecutive refreshes stay
      // at least a debounce apart rather than running back to back.
      realtimeDueAt = now() + debounceMs
      reschedule()
    }

    let result: void | Promise<unknown>
    try {
      result = run()
    } catch {
      // A synchronous throw still counts as a completed attempt.
      settle()
      return
    }

    if (result && typeof (result as Promise<unknown>).then === 'function') {
      // Rejection settles exactly like success: a failed refresh must never
      // leave `inFlight` stuck true and block every later refresh.
      ;(result as Promise<unknown>).then(settle, settle)
    } else {
      settle()
    }
  }

  /** Points the single timer at whichever desired time is earliest. */
  const reschedule = () => {
    const due = effectiveDue()
    if (due === null) {
      clearTimer()
      return
    }
    if (scheduledFor === due) return
    clearTimer()
    scheduledFor = due
    handle = timer.set(fire, Math.max(0, due - now()))
  }

  return {
    onRealtimeEvent() {
      const at = now()
      if (burstStartedAt === null) burstStartedAt = at
      // Push the settle time back, but never past the ceiling for this burst.
      realtimeDueAt = Math.min(at + debounceMs, burstStartedAt + maxWaitMs)
      reschedule()
    },

    onVisible() {
      const at = now()
      const earliest = lastRun + minVisibleIntervalMs
      // Inside the window the refresh is DEFERRED to the window's end, never
      // dropped -- that is what bounds how stale the inbox can get.
      visibilityDueAt = at >= earliest ? at : earliest
      reschedule()
    },

    runNow() {
      fire()
    },

    cancel() {
      clearTimer()
      realtimeDueAt = null
      visibilityDueAt = null
      burstStartedAt = null
      // An in-flight run cannot be recalled, but it must not schedule another
      // one after unmount. loadThreads() re-resolves the user itself, so a
      // late completion can only ever write the current session's inbox.
      queuedWhileInFlight = false
    },

    dueAt: () => effectiveDue(),
    lastRunAt: () => lastRun,
  }
}
