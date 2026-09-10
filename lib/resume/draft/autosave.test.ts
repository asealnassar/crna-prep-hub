import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_AUTOSAVE, describe, hasUnsavedWork, initialState, nextAction, reduce,
} from './autosave.ts'
import type { AutosaveConfig, AutosaveEvent, AutosaveState } from './autosave.ts'

/**
 * Autosave admission and reporting.
 *
 * The failure this guards against is V1's: a save path that reported success
 * without one, and that could overwrite a newer document from another tab.
 */

const CFG: AutosaveConfig = { quietMs: 1000, maxWaitMs: 5000, retryBaseMs: 100, maxRetries: 2 }
const T0 = 1_000_000

/** Folds a sequence so a test reads as the story it is checking. */
function run(events: readonly AutosaveEvent[], from = initialState(4)): AutosaveState {
  return events.reduce((s, e) => reduce(s, e, CFG), from)
}

// ---------------------------------------------------------------- debounce

test('a single edit does not save until the quiet window has passed', () => {
  const s = run([{ type: 'edited', at: T0 }])
  assert.equal(s.status, 'dirty')
  assert.deepEqual(nextAction(s, T0 + 999, CFG), { kind: 'wait', afterMs: 1 })
  assert.deepEqual(nextAction(s, T0 + 1000, CFG), { kind: 'save' })
})

test('each further edit restarts the quiet window', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'edited', at: T0 + 900 },
  ])
  // Without coalescing this would already be due at T0+1000.
  assert.deepEqual(nextAction(s, T0 + 1000, CFG), { kind: 'wait', afterMs: 900 })
  assert.deepEqual(nextAction(s, T0 + 1900, CFG), { kind: 'save' })
})

test('continuous typing still saves at the max-wait cap', () => {
  // An edit every 500ms forever: plain debounce would never fire.
  let s = initialState(4)
  for (let i = 0; i <= 20; i++) s = reduce(s, { type: 'edited', at: T0 + i * 500 }, CFG)
  const now = T0 + 20 * 500
  // dirtySince is still T0, so the 5000ms cap expired at T0+5000.
  assert.deepEqual(nextAction(s, now, CFG), { kind: 'save' })
})

test('the max-wait cap is measured from the first unsaved edit, not the last', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'edited', at: T0 + 4900 },
  ])
  assert.equal(s.dirtySince, T0)
  assert.equal(s.lastEditAt, T0 + 4900)
  assert.deepEqual(nextAction(s, T0 + 5000, CFG), { kind: 'save' })
})

// --------------------------------------------------------------- coalescing

test('many edits in one window produce exactly one save', () => {
  let s = initialState(4)
  let saves = 0
  for (let i = 0; i < 25; i++) {
    s = reduce(s, { type: 'edited', at: T0 + i * 10 }, CFG)
    if (nextAction(s, T0 + i * 10, CFG).kind === 'save') saves++
  }
  assert.equal(saves, 0, 'nothing should be due while the applicant is still typing')

  const settled = T0 + 24 * 10 + CFG.quietMs
  assert.deepEqual(nextAction(s, settled, CFG), { kind: 'save' })
  s = reduce(s, { type: 'save-started', at: settled }, CFG)
  // That one save covers all 25 edits: nothing is left pending.
  assert.equal(s.dirtySince, null)
  assert.deepEqual(nextAction(s, settled, CFG), { kind: 'idle' })
})

test('only one save is ever in flight', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'edited', at: T0 + 1100 },
    { type: 'edited', at: T0 + 1200 },
  ])
  assert.equal(s.status, 'saving')
  // Dirty again, but the driver must not start a second request.
  assert.equal(s.dirtySince, T0 + 1100)
  assert.deepEqual(nextAction(s, T0 + 99_999, CFG), { kind: 'idle' })
})

test('edits arriving during a save are not swallowed by its success', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'edited', at: T0 + 1100 },
    { type: 'save-succeeded', at: T0 + 1500, revision: 5 },
  ])
  assert.equal(s.status, 'dirty', 'the later edit is still unsaved')
  assert.equal(s.revision, 5)
  assert.deepEqual(nextAction(s, T0 + 2100, CFG), { kind: 'save' })
})

// ------------------------------------------------------- honest reporting

test('the indicator says saved only after the server confirms', () => {
  let s = run([{ type: 'edited', at: T0 }])
  assert.equal(describe(s), 'Unsaved changes')

  s = reduce(s, { type: 'save-started', at: T0 + 1000 }, CFG)
  assert.equal(describe(s), 'Saving…', 'a sent request is not a saved document')
  assert.equal(s.revision, 4, 'revision is not advanced optimistically')

  s = reduce(s, { type: 'save-succeeded', at: T0 + 1200, revision: 5 }, CFG)
  assert.equal(describe(s), 'All changes saved')
  assert.equal(s.revision, 5, 'the revision comes from the response')
  assert.equal(s.savedAt, T0 + 1200)
})

test('a failure is reported as a failure, never as saved', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'save-failed', at: T0 + 1200, reason: 'Network error', retryable: true },
  ])
  assert.equal(s.status, 'retrying')
  assert.equal(describe(s), 'Save failed — retrying')
  assert.equal(s.savedAt, null)
})

test('once retries are exhausted the indicator stops promising a retry', () => {
  let s = run([{ type: 'edited', at: T0 }])
  let at = T0 + 1000
  for (let i = 0; i < CFG.maxRetries + 1; i++) {
    s = reduce(s, { type: 'save-started', at }, CFG)
    s = reduce(s, { type: 'save-failed', at: at + 10, reason: 'Network error', retryable: true }, CFG)
    at += 5000
  }
  assert.equal(s.status, 'failed')
  assert.equal(describe(s), 'Not saved: Network error')
  assert.deepEqual(nextAction(s, at + 1_000_000, CFG), { kind: 'idle' }, 'it must not keep hammering')
})

test('a non-retryable failure gives up immediately', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'save-failed', at: T0 + 1100, reason: 'Malformed payload', retryable: false },
  ])
  assert.equal(s.status, 'failed')
  assert.equal(s.attempt, 0)
  assert.deepEqual(nextAction(s, T0 + 99_999, CFG), { kind: 'idle' })
})

test('a failed write leaves the work dirty rather than losing it', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'save-failed', at: T0 + 1100, reason: 'Network error', retryable: false },
  ])
  assert.equal(s.dirtySince, T0, 'the edit that was in flight is unsaved again')
  assert.equal(hasUnsavedWork(s), true)
})

test('retry backs off, then saves', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'save-failed', at: T0 + 1100, reason: 'Network error', retryable: true },
  ])
  assert.deepEqual(nextAction(s, T0 + 1150, CFG), { kind: 'wait', afterMs: 50 })
  assert.deepEqual(nextAction(s, T0 + 1200, CFG), { kind: 'save' })

  const second = run([
    { type: 'save-started', at: T0 + 1200 },
    { type: 'save-failed', at: T0 + 1300, reason: 'Network error', retryable: true },
  ], s)
  assert.equal(second.attempt, 2)
  // Doubled: 100ms then 200ms.
  assert.deepEqual(nextAction(second, T0 + 1450, CFG), { kind: 'wait', afterMs: 50 })
  assert.deepEqual(nextAction(second, T0 + 1500, CFG), { kind: 'save' })
})

test('a success clears the retry budget', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'save-failed', at: T0 + 1100, reason: 'Network error', retryable: true },
    { type: 'save-started', at: T0 + 1200 },
    { type: 'save-succeeded', at: T0 + 1300, revision: 5 },
  ])
  assert.equal(s.attempt, 0)
  assert.equal(s.error, null)
  assert.equal(s.status, 'saved')
})

test('an explicit retry after giving up starts one more save', () => {
  const failed = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'save-failed', at: T0 + 1100, reason: 'Network error', retryable: false },
  ])
  const s = reduce(failed, { type: 'retry', at: T0 + 9000 }, CFG)
  assert.equal(s.status, 'dirty')
  assert.deepEqual(nextAction(s, T0 + 9000, CFG), { kind: 'save' }, 'retry does not wait out the debounce')
})

// ------------------------------------------------------------- conflict

test('a conflict is surfaced and never retried', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'conflict', at: T0 + 1100, storedRevision: 9 },
  ])
  assert.equal(s.status, 'conflict')
  assert.equal(s.storedRevision, 9)
  assert.equal(s.revision, 4, 'the local revision is NOT advanced to the stored one')
  assert.equal(describe(s), 'Changed somewhere else — reload to continue')
  assert.deepEqual(nextAction(s, T0 + 1_000_000, CFG), { kind: 'idle' })
})

test('typing after a conflict does not resume saving over the other writer', () => {
  const conflicted = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'conflict', at: T0 + 1100, storedRevision: 9 },
  ])
  const s = reduce(conflicted, { type: 'edited', at: T0 + 2000 }, CFG)
  assert.equal(s.status, 'conflict', 'still blocked')
  assert.deepEqual(nextAction(s, T0 + 99_999, CFG), { kind: 'idle' })
})

test('flush cannot force a write through a conflict', () => {
  const conflicted = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'conflict', at: T0 + 1100, storedRevision: 9 },
  ])
  const s = reduce(conflicted, { type: 'flush', at: T0 + 1200 }, CFG)
  assert.equal(s.forced, false)
  assert.deepEqual(nextAction(s, T0 + 1200, CFG), { kind: 'idle' })
})

test('reloading resolves a conflict and starts clean at the stored revision', () => {
  const conflicted = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'conflict', at: T0 + 1100, storedRevision: 9 },
  ])
  const s = reduce(conflicted, { type: 'reloaded', at: T0 + 5000, revision: 9 }, CFG)
  assert.equal(s.status, 'clean')
  assert.equal(s.revision, 9)
  assert.equal(hasUnsavedWork(s), false)
  assert.equal(describe(s), '')
})

// ---------------------------------------------------- leaving the page

test('flush saves immediately instead of waiting out the debounce', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'flush', at: T0 + 50 },
  ])
  assert.deepEqual(nextAction(s, T0 + 50, CFG), { kind: 'save' })
})

test('flush with nothing pending does nothing', () => {
  const s = reduce(initialState(4), { type: 'flush', at: T0 }, CFG)
  assert.equal(s.forced, false)
  assert.deepEqual(nextAction(s, T0, CFG), { kind: 'idle' })
})

test('starting a save consumes the forced flag', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'flush', at: T0 + 50 },
    { type: 'save-started', at: T0 + 60 },
  ])
  assert.equal(s.forced, false)
})

test('an in-flight save counts as unsaved work', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
  ])
  // The document is not dirty, but closing the tab now cancels the request.
  assert.equal(s.dirtySince, null)
  assert.equal(hasUnsavedWork(s), true)
})

test('a confirmed save leaves nothing to lose', () => {
  const s = run([
    { type: 'edited', at: T0 },
    { type: 'save-started', at: T0 + 1000 },
    { type: 'save-succeeded', at: T0 + 1100, revision: 5 },
  ])
  assert.equal(hasUnsavedWork(s), false)
})

// ------------------------------------------------------------- defaults

test('the shipped defaults debounce and cap sensibly', () => {
  assert.ok(DEFAULT_AUTOSAVE.quietMs > 0)
  assert.ok(
    DEFAULT_AUTOSAVE.maxWaitMs > DEFAULT_AUTOSAVE.quietMs,
    'a cap below the debounce would save on every keystroke'
  )
  assert.ok(DEFAULT_AUTOSAVE.maxRetries >= 1)
})

test('a fresh state is clean and shows nothing', () => {
  const s = initialState(1)
  assert.equal(s.status, 'clean')
  assert.equal(describe(s), '')
  assert.deepEqual(nextAction(s, T0, CFG), { kind: 'idle' })
})
