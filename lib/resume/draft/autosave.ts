/**
 * Autosave, as a pure state machine.
 *
 * V1 saved by issuing one UPDATE per section, discarding every error, and
 * telling the applicant "Saved!" regardless. This module exists so that cannot
 * happen again: nothing here reports a save until the server has confirmed it,
 * and a rejected write is surfaced rather than retried into an overwrite.
 *
 * No timers, no network, no React. The driver owns the clock and the payload;
 * this owns the decisions. `reduce` folds an event into state, `nextAction`
 * says what the driver should do at a given instant, and both are total
 * functions of their inputs -- which is what makes the debounce, the
 * coalescing and the conflict handling testable without waiting in real time.
 *
 * WHY THE PAYLOAD IS NOT HERE. The driver always holds the current resume, so
 * "coalescing" needs no queue: when a save starts, whatever the resume is at
 * that moment goes. Ten edits during one debounce window are one save because
 * they are one document, not because anything merged them. Keeping the payload
 * out also keeps this module free of the domain model entirely.
 */

/** What the indicator is showing. */
export type SaveStatus =
  /** Nothing has changed since the document loaded. */
  | 'clean'
  /** Edits are waiting for the debounce to expire. */
  | 'dirty'
  /** A request is in flight. */
  | 'saving'
  /** The server confirmed the last write and nothing is pending. */
  | 'saved'
  /** The last write failed for a reason worth retrying; backing off. */
  | 'retrying'
  /** Retries are exhausted. Only the applicant can move this on. */
  | 'failed'
  /** Another writer advanced the revision. Never resolved automatically. */
  | 'conflict'

export interface AutosaveState {
  readonly status: SaveStatus
  /** When the OLDEST unsaved edit arrived. Drives the max-wait cap. */
  readonly dirtySince: number | null
  /** When the NEWEST unsaved edit arrived. Drives the debounce. */
  readonly lastEditAt: number | null
  /** `dirtySince` as it was when the in-flight save started, so a failure can
   *  put that work back rather than losing track of it. */
  readonly inFlightSince: number | null
  /** Set by `flush`: save at the next opportunity, debounce notwithstanding. */
  readonly forced: boolean
  /** Last revision the SERVER confirmed. Never incremented optimistically. */
  readonly revision: number
  readonly savedAt: number | null
  /** Consecutive retryable failures. Reset by any success. */
  readonly attempt: number
  readonly retryAt: number | null
  readonly error: string | null
  /** Only set on conflict: the revision the server actually holds. */
  readonly storedRevision: number | null
}

export interface AutosaveConfig {
  /** Wait this long after the last keystroke before saving. */
  readonly quietMs: number
  /** ...but never defer a save longer than this. Continuous typing must not
   *  starve the save forever, which plain debounce does. */
  readonly maxWaitMs: number
  /** First retry delay; doubles per attempt. */
  readonly retryBaseMs: number
  /** Consecutive retryable failures before giving up and asking the user. */
  readonly maxRetries: number
}

/**
 * Chosen for typing, not for machines. 1.2s is past the gap between words but
 * short enough that a tab closed in a hurry has usually already saved; the 8s
 * cap bounds how much continuous typing can be at risk. Together with the
 * driver's single-flight rule these are the "debounce plus payload caps" the
 * blueprint relies on to keep autosave from becoming a write storm.
 */
export const DEFAULT_AUTOSAVE: AutosaveConfig = {
  quietMs: 1200,
  maxWaitMs: 8000,
  retryBaseMs: 2000,
  maxRetries: 3,
}

export type AutosaveEvent =
  | { readonly type: 'edited'; readonly at: number }
  /** The tab is closing or hiding: stop waiting, save now. */
  | { readonly type: 'flush'; readonly at: number }
  | { readonly type: 'save-started'; readonly at: number }
  | { readonly type: 'save-succeeded'; readonly at: number; readonly revision: number }
  | { readonly type: 'save-failed'; readonly at: number; readonly reason: string; readonly retryable: boolean }
  | { readonly type: 'conflict'; readonly at: number; readonly storedRevision: number }
  /** The applicant asked to try again after `failed`. */
  | { readonly type: 'retry'; readonly at: number }
  /** The applicant reloaded, resolving a conflict. Local edits are gone. */
  | { readonly type: 'reloaded'; readonly at: number; readonly revision: number }

export function initialState(revision: number): AutosaveState {
  return {
    status: 'clean',
    dirtySince: null,
    lastEditAt: null,
    inFlightSince: null,
    forced: false,
    revision,
    savedAt: null,
    attempt: 0,
    retryAt: null,
    error: null,
    storedRevision: null,
  }
}

/** `config` must match the one given to `nextAction`; they share the retry budget. */
export function reduce(
  state: AutosaveState,
  event: AutosaveEvent,
  config: AutosaveConfig = DEFAULT_AUTOSAVE
): AutosaveState {
  switch (event.type) {
    case 'edited': {
      // A conflict is not cleared by typing. The applicant has unsaved work
      // AND a stale revision; writing anyway is the overwrite this prevents.
      if (state.status === 'conflict') {
        return { ...state, lastEditAt: event.at, dirtySince: state.dirtySince ?? event.at }
      }
      return {
        ...state,
        status: state.status === 'saving' ? 'saving' : 'dirty',
        dirtySince: state.dirtySince ?? event.at,
        lastEditAt: event.at,
        // A fresh edit means the previous failure is no longer the last word.
        error: state.status === 'failed' ? null : state.error,
        attempt: state.status === 'failed' ? 0 : state.attempt,
        retryAt: state.status === 'failed' ? null : state.retryAt,
      }
    }

    case 'flush': {
      if (state.dirtySince === null) return state
      if (state.status === 'conflict' || state.status === 'saving') return state
      return { ...state, forced: true }
    }

    case 'save-started': {
      return {
        ...state,
        status: 'saving',
        // This work is in flight now. Edits arriving during the request start a
        // new dirty window, so success can tell "clean" from "more to do".
        inFlightSince: state.dirtySince,
        dirtySince: null,
        lastEditAt: null,
        forced: false,
        error: null,
      }
    }

    case 'save-succeeded': {
      const stillDirty = state.dirtySince !== null
      return {
        ...state,
        status: stillDirty ? 'dirty' : 'saved',
        inFlightSince: null,
        revision: event.revision,
        savedAt: event.at,
        attempt: 0,
        retryAt: null,
        error: null,
        storedRevision: null,
      }
    }

    case 'save-failed': {
      // The in-flight work was never written. Put it back, keeping the older
      // of the two timestamps so the max-wait cap counts from the real start.
      const restored = earliest(state.inFlightSince, state.dirtySince)
      const attempt = event.retryable ? state.attempt + 1 : state.attempt
      // Decided here, not by the indicator, so the state can never say
      // "retrying" when nothing is going to retry.
      const exhausted = !event.retryable || attempt > config.maxRetries
      return {
        ...state,
        status: exhausted ? 'failed' : 'retrying',
        inFlightSince: null,
        dirtySince: restored,
        forced: false,
        attempt,
        error: event.reason,
        retryAt: exhausted ? null : event.at,
      }
    }

    case 'conflict': {
      // Terminal until the applicant acts. No backoff, no retry: the write was
      // refused because someone else's work is newer, and trying again with the
      // same stale revision either fails again or, worse, succeeds.
      return {
        ...state,
        status: 'conflict',
        inFlightSince: null,
        dirtySince: earliest(state.inFlightSince, state.dirtySince),
        forced: false,
        attempt: 0,
        retryAt: null,
        storedRevision: event.storedRevision,
        error: 'This resume was changed somewhere else.',
      }
    }

    case 'retry': {
      if (state.status !== 'failed') return state
      return { ...state, status: 'dirty', attempt: 0, retryAt: null, error: null, forced: true }
    }

    case 'reloaded': {
      return initialState(event.revision)
    }
  }
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

export type AutosaveAction =
  /** Start a save now, with whatever the document currently is. */
  | { readonly kind: 'save' }
  /** Nothing to do yet; come back after this many milliseconds. */
  | { readonly kind: 'wait'; readonly afterMs: number }
  /** Nothing to do, and no timer will change that. */
  | { readonly kind: 'idle' }

/**
 * What the driver should do at `now`.
 *
 * Single-flight is enforced here rather than by the driver: while a request is
 * in flight this returns 'idle' no matter how dirty the document is, so two
 * saves can never race and arrive out of order.
 */
export function nextAction(
  state: AutosaveState,
  now: number,
  config: AutosaveConfig = DEFAULT_AUTOSAVE
): AutosaveAction {
  if (state.status === 'saving') return { kind: 'idle' }
  // Both need the applicant. Retrying a conflict overwrites; retrying an
  // exhausted failure just fails again.
  if (state.status === 'conflict' || state.status === 'failed') return { kind: 'idle' }
  if (state.dirtySince === null) return { kind: 'idle' }

  if (state.status === 'retrying') {
    // Only reachable if reduce() was given a different config than this call.
    if (state.attempt > config.maxRetries) return { kind: 'idle' }
    const delay = config.retryBaseMs * Math.pow(2, Math.max(0, state.attempt - 1))
    const due = (state.retryAt ?? now) + delay
    return now >= due ? { kind: 'save' } : { kind: 'wait', afterMs: due - now }
  }

  if (state.forced) return { kind: 'save' }

  const quietDue = (state.lastEditAt ?? state.dirtySince) + config.quietMs
  const capDue = state.dirtySince + config.maxWaitMs
  const due = Math.min(quietDue, capDue)
  return now >= due ? { kind: 'save' } : { kind: 'wait', afterMs: due - now }
}

/**
 * Whether anything would be lost by closing the tab right now. Drives the
 * beforeunload guard, and is the honest answer to "did my refresh lose work" --
 * it counts an in-flight request too, because a request in flight has not been
 * confirmed and the tab closing cancels it.
 */
export function hasUnsavedWork(state: AutosaveState): boolean {
  return (
    state.dirtySince !== null ||
    state.inFlightSince !== null ||
    state.status === 'saving' ||
    state.status === 'conflict'
  )
}

/**
 * The indicator's words. A pure function of confirmed state, so the indicator
 * cannot say "Saved" on the strength of a request having been sent.
 */
export function describe(state: AutosaveState): string {
  switch (state.status) {
    case 'clean': return ''
    case 'dirty': return 'Unsaved changes'
    case 'saving': return 'Saving…'
    case 'saved': return 'All changes saved'
    case 'retrying': return 'Save failed — retrying'
    case 'failed': return state.error ? `Not saved: ${state.error}` : 'Not saved'
    case 'conflict': return 'Changed somewhere else — reload to continue'
  }
}
