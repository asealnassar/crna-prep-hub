import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_AUTOSAVE, initialState, reduce, saveTimedOut,
  type AutosaveEvent, type AutosaveState,
} from '../../resume/draft/autosave.ts'
import { settleVerdict, statementDriverAction, statementStatus } from './editor.ts'
import { SAVE_MESSAGES } from './save.ts'

/**
 * "Saving…" MUST NOT BE A PLACE A DRAFT CAN GET STUCK.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THESE ARE WRITTEN AGAINST
 * ---------------------------------------------------------------------------
 * Every status but one is left by something observable: the applicant edits,
 * the server answers, the applicant retries. 'saving' is left only by the
 * driver's own continuation after a request settles -- and a continuation that
 * does not run leaves the editor claiming forever that a save is in progress.
 *
 * It happened. StatementStudioClient held `const alive = useRef(true)` with a
 * cleanup-only effect; React's StrictMode runs that cleanup during its
 * simulated unmount, nothing restored the ref, and from then on every save
 * response was parsed and then dropped at `if (!alive.current) return`. The
 * PATCH succeeded, the revision moved on the server, and the indicator said
 * "Saving…" for ever. Because nextAction() reports 'idle' while saving, no
 * later save was ever scheduled either -- so everything typed afterwards was
 * never persisted and a refresh lost it.
 *
 * THE FIX IS TWO-PART AND SO ARE THESE TESTS. The ref is restored on mount,
 * which is asserted over the source because there is no DOM here to mount in;
 * and the status itself is given a deadline, which is asserted behaviourally,
 * because a deadline is the only thing that would have caught the first part
 * going wrong.
 */

const started = (at: number): AutosaveState =>
  reduce(reduce(initialState(1), { type: 'edited', at }), { type: 'save-started', at })

// ===========================================================================
// THE CLOCK
// ===========================================================================

test('save-started records WHEN THE REQUEST began, not when the work did', () => {
  // The edit is at 1000; the debounce means the request starts at 2200. The
  // deadline is the request's, so a long debounce cannot eat it.
  const edited = reduce(initialState(1), { type: 'edited', at: 1000 })
  const saving = reduce(edited, { type: 'save-started', at: 2200 })
  assert.equal(saving.status, 'saving')
  assert.equal(saving.savingSince, 2200)
  // inFlightSince is the age of the WORK and stays the edit's timestamp.
  assert.equal(saving.inFlightSince, 1000)
})

test('every terminal event clears it, so a settled save has no deadline', () => {
  const at = 10_000
  const saving = started(at)
  const outcomes: AutosaveEvent[] = [
    { type: 'save-succeeded', at: at + 10, revision: 2 },
    { type: 'save-failed', at: at + 10, reason: 'x', retryable: true },
    { type: 'save-failed', at: at + 10, reason: 'x', retryable: false },
    { type: 'conflict', at: at + 10, storedRevision: 9 },
  ]
  for (const event of outcomes) {
    const next = reduce(saving, event)
    assert.equal(next.savingSince, null, event.type)
    assert.equal(saveTimedOut(next, at + 1_000_000), false, event.type)
  }
  // And a reload starts from scratch.
  assert.equal(reduce(saving, { type: 'reloaded', at, revision: 3 }).savingSince, null)
})

test('the deadline is the request age, and only while a request is in flight', () => {
  const at = 500
  const saving = started(at)
  const limit = DEFAULT_AUTOSAVE.saveTimeoutMs
  assert.equal(saveTimedOut(saving, at), false)
  assert.equal(saveTimedOut(saving, at + limit - 1), false)
  assert.equal(saveTimedOut(saving, at + limit), true, 'the deadline must be inclusive')
  assert.equal(saveTimedOut(saving, at + limit * 10), true)
  // Not saving: no deadline, however old the state is.
  assert.equal(saveTimedOut(initialState(1), at + limit * 10), false)
  assert.equal(
    saveTimedOut(reduce(initialState(1), { type: 'edited', at }), at + limit * 10), false)
  // A state from before this field existed is not retroactively expired.
  const legacy = { ...saving, savingSince: null }
  assert.equal(saveTimedOut(legacy, at + limit * 10), false)
})

// ===========================================================================
// THE DRIVER ALWAYS HAS SOMETHING TO DO WHILE SAVING
// ===========================================================================

test('while saving the driver WAITS rather than idling, so a timer exists', () => {
  /*
   * nextAction() reports 'idle' while a request is in flight -- correct for
   * scheduling, fatal for recovery: 'idle' means no timer, and a status only a
   * continuation can leave needs something else to come back and look at it.
   */
  const at = 1_000
  const saving = started(at)
  const action = statementDriverAction({ state: saving, now: at + 100, title: 'T', essay: 'e' })
  assert.equal(action.kind, 'wait')
  if (action.kind === 'wait') {
    assert.equal(action.afterMs, DEFAULT_AUTOSAVE.saveTimeoutMs - 100)
    assert.ok(action.afterMs > 0, 'a wait of zero would spin')
  }
})

test('AND AT THE DEADLINE IT REPORTS timed-out', () => {
  const at = 1_000
  const saving = started(at)
  const action = statementDriverAction({
    state: saving, now: at + DEFAULT_AUTOSAVE.saveTimeoutMs, title: 'T', essay: 'e',
  })
  assert.equal(action.kind, 'timed-out')
})

test('A SAVE CAN NEVER BE IN FLIGHT FOREVER — exhaustively, over the clock', () => {
  /*
   * The property, not an example: from the moment a request starts, there is
   * no instant at or after its deadline at which the driver has nothing to do
   * -- and no instant before it at which the driver has no timer pending.
   *
   * Run over a spread of start times and offsets so an off-by-one in either
   * direction fails.
   */
  for (const at of [0, 1, 999, 1_700_000_000_000]) {
    const saving = started(at)
    for (const offset of [0, 1, 50, 1_200, 8_000, 14_999]) {
      const action = statementDriverAction({
        state: saving, now: at + offset, title: 'T', essay: 'e',
      })
      assert.equal(action.kind, 'wait', `t+${offset} must schedule a timer`)
    }
    for (const offset of [15_000, 15_001, 60_000, 86_400_000]) {
      const action = statementDriverAction({
        state: saving, now: at + offset, title: 'T', essay: 'e',
      })
      assert.equal(action.kind, 'timed-out', `t+${offset} must give up`)
    }
  }
})

test('a timed-out save becomes a RETRYABLE failure the applicant can see', () => {
  const at = 1_000
  const saving = started(at)
  // What the driver dispatches on 'timed-out'.
  const failed = reduce(saving, {
    type: 'save-failed', at: at + DEFAULT_AUTOSAVE.saveTimeoutMs,
    reason: SAVE_MESSAGES.timeout, retryable: true,
  })
  // Retryable, so the engine's own backoff tries again rather than giving up on
  // a slow connection.
  assert.equal(failed.status, 'retrying')
  assert.equal(failed.savingSince, null)
  // The work is put back, not lost.
  assert.equal(failed.dirtySince, at)

  // Exhausted, it lands somewhere the applicant can act on -- and the sentence
  // is one the editor is allowed to render.
  let exhausted = failed
  for (let i = 0; i < DEFAULT_AUTOSAVE.maxRetries + 1; i += 1) {
    exhausted = reduce(reduce(exhausted, { type: 'save-started', at: at + i }), {
      type: 'save-failed', at: at + i, reason: SAVE_MESSAGES.timeout, retryable: true,
    })
  }
  assert.equal(exhausted.status, 'failed')
  const shown = statementStatus(exhausted, null)
  assert.equal(shown.text, `Not saved: ${SAVE_MESSAGES.timeout}`)
  assert.equal(shown.frozen, true)
  assert.equal(shown.unsaved, true)
  assert.doesNotMatch(shown.text, /Saving/)
})

test('and leaving the page gets a verdict instead of waiting on nothing', () => {
  const at = 1_000
  // settleVerdict is null while saving -- which is why the WAIT is bounded.
  assert.equal(settleVerdict(started(at)), null)
  const failed = reduce(started(at), {
    type: 'save-failed', at, reason: SAVE_MESSAGES.timeout, retryable: false,
  })
  assert.equal(settleVerdict(failed), false, 'a failure is an answer, not a wait')
  const saved = reduce(started(at), { type: 'save-succeeded', at, revision: 2 })
  assert.equal(settleVerdict(saved), true)
})

// ===========================================================================
// THE ROOT CAUSE, AS A RULE OVER THE SOURCE
// ===========================================================================

test('EVERY liveness ref is re-asserted on mount, not only withdrawn on unmount', () => {
  /*
   * There is no DOM in this runner, so the lifecycle cannot be exercised here.
   * What can be asserted is the shape that broke: a ref initialised to true and
   * an effect that ONLY returns a cleanup. React StrictMode runs that cleanup
   * once during its simulated unmount, and nothing puts the ref back -- a ref
   * initialiser runs once.
   *
   * The rule is therefore: wherever `alive` exists, its effect body must set it
   * true. Checked for every component that has one, so a third copy of the
   * pattern cannot be added with the same defect.
   */
  const files = [
    'app/statement-studio/components/StatementStudioClient.tsx',
    'app/statement-studio/components/PromptPicker.tsx',
  ]
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    if (!source.includes('const alive = useRef(true)')) continue
    assert.match(source, /alive\.current = true/,
      `${file}: the mount effect must re-assert liveness`)
    assert.match(source, /alive\.current = false/, `${file}: unmount must withdraw it`)
    // AND THE ORDER: asserted before it is withdrawn, which is what a body
    // followed by a cleanup looks like.
    assert.ok(source.indexOf('alive.current = true') < source.indexOf('alive.current = false'),
      `${file}: liveness must be asserted in the effect body, not only in its cleanup`)
    // The defect itself, spelled out: an effect that is nothing but a cleanup.
    assert.doesNotMatch(source, /useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\s*\n?\s*alive\.current = false/,
      `${file}: a cleanup-only liveness effect is the StrictMode bug`)
  }
})

test('the editor bounds its own request, with the same number as the status', () => {
  const client = readFileSync(
    'app/statement-studio/components/StatementStudioClient.tsx', 'utf8')
  // A request the editor has stopped believing in must not still be running.
  assert.match(client, /new AbortController\(\)/)
  assert.match(client, /setTimeout\(\(\) => deadline\.abort\(\), DEFAULT_AUTOSAVE\.saveTimeoutMs\)/)
  assert.match(client, /signal: deadline\.signal/)
  // ONE NUMBER. Two would leave a window where the status has given up and the
  // request has not.
  assert.equal(client.includes('DEFAULT_AUTOSAVE.saveTimeoutMs'), true)
  // And the navigation wait is bounded by the same one.
  assert.match(client, /timeoutMs = DEFAULT_AUTOSAVE\.saveTimeoutMs/)
})
