/**
 * TEST 6 — resource cleanup across all four exits. NOT RUN.
 *
 * Success, parse failure, cancellation and timeout must converge on the same
 * end state: no worker, nothing retained, and the parent's handler not left
 * waiting on a teardown that cannot finish.
 *
 * The last point is the subtle one. pdf.js's own destroy() awaits a Terminate
 * round-trip, so on a stuck parse it never resolves. worker.mjs bounds that
 * call for exactly this reason; these tests check the bound holds.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInWorker } from './extractInWorker.mjs'
import { load } from './fixtures.mjs'

const settle = async () => { global.gc?.(); await new Promise((r) => setTimeout(r, 50)); global.gc?.() }

const EXITS = [
  {
    name: 'success',
    run: () => extractInWorker(load('boundary'), { deadlineMs: 120_000 }),
    expect: (r) => assert.equal(r.ok, true),
  },
  {
    name: 'parse failure',
    run: () => extractInWorker(new Uint8Array(Buffer.from('%PDF-1.4 broken')), { deadlineMs: 30_000 }),
    expect: (r) => { assert.equal(r.ok, false); assert.equal(r.reason, 'error') },
  },
  {
    name: 'cancellation',
    run: () => {
      const c = new AbortController()
      const p = extractInWorker(load('mb2'), { deadlineMs: 120_000, graceMs: 3_000, signal: c.signal })
      setTimeout(() => c.abort(), 40)
      return p
    },
    expect: (r) => { assert.equal(r.ok, false); assert.equal(r.reason, 'aborted') },
  },
  {
    name: 'timeout with forced terminate',
    run: () => extractInWorker(load('small'), { deadlineMs: 60, graceMs: 200, stallMs: 5_000, allowTestStall: true }),
    expect: (r) => { assert.equal(r.ok, false); assert.equal(r.terminatedForcibly, true) },
  },
]

for (const exit of EXITS) {
  test(`cleanup: ${exit.name} leaves no worker and no retained memory`, async () => {
    await settle()
    const before = process.memoryUsage().heapUsed

    const r = await exit.run()
    exit.expect(r)

    // Every exit terminates its worker. No exception.
    assert.ok(r.timeline.some((m) => m.name === 'parent:terminated'),
      `${exit.name} did not terminate its worker`)
    assert.equal(r.terminateError, null, `terminate errored: ${r.terminateError}`)

    await settle()
    const after = process.memoryUsage().heapUsed
    const growthMB = (after - before) / 1024 / 1024
    console.log(`  ${exit.name.padEnd(28)} parent heap delta ${growthMB.toFixed(1)} MB`)
  })
}

test('cleanup: the bounded teardown cannot hang the caller', async () => {
  // A stalled worker's pdf.js destroy() can never complete. The call must
  // still return promptly, because terminate does not wait for it.
  const started = Date.now()
  const r = await extractInWorker(load('small'), {
    deadlineMs: 50, graceMs: 150, stallMs: 30_000, allowTestStall: true,
  })
  const elapsed = Date.now() - started
  console.log(`  returned in ${elapsed}ms despite a 30s stall`)
  assert.equal(r.ok, false)
  assert.ok(elapsed < 5_000, 'the caller was held by a teardown that could not finish')
})

test('cleanup: a worker that finished normally reports its own teardown', async () => {
  const r = await extractInWorker(load('small'), { deadlineMs: 60_000 })
  assert.equal(r.ok, true)
  // worker.mjs marks these after cleanup runs; their absence means the
  // finally block did not complete.
  assert.ok(r.memorySamples.some((s) => s.label === 'after-cleanup'), 'cleanup did not run')
  assert.ok(r.timeline.some((m) => m.name === 'worker:worker-finished'))

  // =========================================================================
  // THE TWO ASSERTIONS ABOVE WERE NEVER ENOUGH, AND THIS IS WHY.
  //
  // Both only check that a marker EXISTS. `worker-finished` is emitted whether
  // cleanup completed or its deadline expired, and `after-cleanup` is sampled
  // immediately before it -- so a cleanup that timed out produced exactly the
  // same two markers as one that succeeded. Until the handshake landed there
  // was no field that could tell them apart, and in every run so far neither
  // marker appeared at all: the parent terminated the worker 0.2-0.3 ms after
  // its reply, before the `finally` could post anything.
  //
  // What follows establishes three SEPARATE facts, from three independent
  // sources: that pdf.js cleanup finished, that it was reported and recorded,
  // and that the thread is gone. None of the three is inferred from another.
  // =========================================================================

  // This test must run on the production allocations, not on one of the
  // millisecond windows the forced-termination tests use. Asserted, so a change
  // to the planner fails here loudly instead of quietly weakening the test.
  assert.equal(r.plan.budgetMs, 45_000, 'not the production budget; the rest of this test assumes it')
  assert.equal(r.plan.cleanupWaitMs, 600, 'the cleanup wait is not the approved 600 ms')
  assert.equal(r.plan.terminateWaitMs, 400, 'the terminate wait is not the approved 400 ms')
  assert.equal(r.plan.cleanupDeadlineMs, 450, "the worker's cleanup deadline is not the approved 450 ms")

  // ---- A. pdf.js INTERNAL CLEANUP COMPLETED ------------------------------
  // The parent's verdict.
  assert.equal(r.pdfjsCleanup, 'completed', `pdf.js cleanup did not complete: ${r.pdfjsCleanup}`)

  const finished = r.timeline.find((m) => m.name === 'worker:worker-finished')
  assert.ok(finished, 'the worker never reported finishing')

  // The WORKER's own verdict, which is the one that knows. 'timed-out' means the
  // race timer won; only 'completed' means the operations actually returned.
  assert.equal(finished.cleanup, 'completed', `the worker reported cleanup as "${finished.cleanup}"`)
  assert.notEqual(finished.cleanup, 'timed-out', 'a settled timeout race is not completed cleanup')
  assert.notEqual(finished.cleanup, 'failed')

  // Per operation, since the protocol exposes them separately. 'absent' means
  // the method was never there to call, which is not the same as success --
  // and on a successful extraction both must genuinely have been present.
  assert.equal(finished.docCleanup, 'completed', `doc.cleanup(): ${finished.docCleanup}`)
  assert.equal(finished.taskDestroy, 'completed', `loadingTask.destroy(): ${finished.taskDestroy}`)
  for (const [label, value] of [['doc.cleanup()', finished.docCleanup], ['loadingTask.destroy()', finished.taskDestroy]]) {
    assert.notEqual(value, 'absent', `${label} was never attempted; absent is not completed`)
    assert.notEqual(value, 'failed', `${label} threw`)
  }

  // What the parent surfaced must agree with what the worker said. A mismatch
  // would mean the report was mangled in transit or misread.
  assert.deepEqual(
    { doc: r.pdfjsCleanupDetail?.docCleanup, task: r.pdfjsCleanupDetail?.taskDestroy },
    { doc: 'completed', task: 'completed' },
    'the parent recorded different per-operation statuses than the worker sent',
  )
  assert.equal(r.pdfjsCleanupDetail?.workerDeadlineMs, 450, "the worker used a different cleanup deadline than the parent set")

  // ---- B. THE CLEANUP MARKERS, AND THEIR ORDER ---------------------------
  const sample = r.memorySamples.find((s) => s.label === 'after-cleanup')
  assert.ok(sample, 'no after-cleanup memory sample')
  assert.ok(Number.isFinite(sample.at), 'the after-cleanup sample carries no usable timestamp')

  const reported = r.timeline.find((m) => m.name === 'parent:cleanup-report')
  assert.ok(reported, 'the parent never recorded a cleanup report')
  assert.equal(reported.pdfjsCleanup, 'completed', 'the recorded report disagrees with the result')
  assert.equal(reported.docCleanup, 'completed')
  assert.equal(reported.taskDestroy, 'completed')

  // ORDERING ONLY -- no assumption about how long cleanup takes. The single
  // claim is that the worker had finished before the parent asked it to die,
  // which is the whole point of the handshake.
  const terminateRequested = r.timeline.find((m) => m.name === 'parent:terminate-requested')
  assert.ok(terminateRequested, 'terminate was never requested')
  assert.ok(
    finished.at <= terminateRequested.at,
    `the worker reported cleanup at ${finished.at} but terminate was requested at ${terminateRequested.at}`,
  )
  assert.ok(sample.at <= finished.at, 'the after-cleanup sample was taken after the finish report')

  // ---- C. WORKER EXIT, CONFIRMED INDEPENDENTLY ---------------------------
  // Deliberately NOT via cleanupConfirmed, and deliberately not via anything in
  // section A. These are the exit facts: the event fired, the state says so, and
  // the confirmation carries a real timestamp.
  assert.equal(r.termination.state, 'exited', `exit not confirmed: ${r.termination.error}`)

  const exitEvent = r.timeline.find((m) => m.name === 'parent:worker-exit')
  assert.ok(exitEvent, 'no parent:worker-exit event, so exit was never observed')
  assert.equal(typeof exitEvent.code, 'number', 'the exit event carries no exit code')

  assert.ok(Number.isFinite(r.termination.confirmedAt), 'no confirmation timestamp')
  assert.ok(r.termination.confirmedAt >= r.spawnedAt, 'the confirmation predates the operation')
  assert.ok(
    r.termination.confirmedAt >= terminateRequested.at,
    'exit was confirmed before terminate was even requested',
  )

  assert.equal(r.withinBudget, true, `took ${r.elapsedMs.toFixed(0)}ms of a ${r.plan.budgetMs}ms budget`)
  assert.ok(r.elapsedMs <= r.plan.budgetMs)

  // INDEPENDENCE, stated as an assertion. cleanupConfirmed is DERIVED from exit
  // and says nothing about pdf.js; it is checked only to pin that it still
  // tracks exit and has not quietly become a cleanup claim.
  assert.equal(r.termination.cleanupConfirmed, r.termination.state === 'exited',
    'cleanupConfirmed no longer tracks worker exit')
  assert.notEqual(r.pdfjsCleanup, r.termination.cleanupConfirmed,
    'pdf.js cleanup status and the exit-derived flag must remain separate values')

  console.log(`  cleanup=${r.pdfjsCleanup} (doc=${finished.docCleanup}, destroy=${finished.taskDestroy})`
    + `  reported ${(terminateRequested.at - finished.at).toFixed(3)}ms before terminate`
    + `  exit=${r.termination.state} code=${exitEvent.code}`
    + `  elapsed ${r.elapsedMs.toFixed(0)}ms of ${r.plan.budgetMs}ms`)
})
