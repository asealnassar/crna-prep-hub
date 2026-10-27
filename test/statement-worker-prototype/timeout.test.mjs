/**
 * TEST 4 — deadline and forced termination. NOT RUN.
 *
 * THE TEST THAT VALIDATES THE ARCHITECTURE. Everything else checks that the
 * happy path is tidy; this one checks that the fallback is load-bearing.
 *
 * The earlier audit established, from pdf.js source, that:
 *   - WorkerTransport.destroy() awaits a Terminate round-trip, and
 *   - the fake worker runs on the same thread via LoopbackPort,
 * so a parse that never yields can neither be cancelled nor cleanly destroyed.
 * Only tearing down the isolate works. These tests are where that claim is
 * either demonstrated or disproved.
 *
 * THE DEADLINE IS CONFIGURABLE HERE and small, so the suite does not take
 * 45 seconds per case. The approved production value is asserted separately,
 * from limits.mjs, so shrinking it for a test cannot quietly change it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInWorker, span } from './extractInWorker.mjs'
import { load } from './fixtures.mjs'
import { PRODUCTION_DEADLINE_MS } from './limits.mjs'

test('timeout: the approved production deadline is unchanged', () => {
  // Guards against a test convenience becoming a product change.
  assert.equal(PRODUCTION_DEADLINE_MS, 45_000)
})

test('timeout: a well-formed but slow extraction stops at the deadline', async () => {
  // The 4 MB fixture with a deadline far below its natural parse time.
  const r = await extractInWorker(load('mb4'), { deadlineMs: 500, graceMs: 1_500 })

  assert.equal(r.ok, false)
  assert.ok(['deadline', 'exited'].includes(r.reason), `unexpected reason: ${r.reason}`)
  assert.ok(r.timeline.some((m) => m.name === 'parent:deadline-expired'))
  assert.ok(r.timeline.some((m) => m.name === 'parent:terminated'))

  const elapsed = r.finishedAt - r.spawnedAt
  console.log(`  stopped after ${elapsed.toFixed(0)}ms (deadline 500ms + grace 1500ms)`)
  assert.ok(elapsed < 10_000, 'termination took far longer than deadline plus grace')
})

test('timeout: COOPERATIVE cancellation succeeds when the parse yields', async () => {
  // WHY THE NUMBERS CHANGED. This was `deadlineMs: 5, graceMs: 20_000` -- a 5 ms
  // deadline with a 20-second grace bolted on AFTER it. The total-budget model
  // makes that unrepresentable on purpose: the grace is carved OUT of the budget
  // and capped at a share of it, so a 5 ms budget buys a 1 ms grace and the
  // worker would be force-killed long before it could answer. The old settings
  // would have turned this test into a second forced-termination test.
  //
  // 400 ms splits into 200 extraction / 120 cancel / 80 terminate:
  //
  //   200 ms extraction   fires DURING the parse. mb2 is 74 pages, and the one
  //                       measured comparison -- 14 pages of the boundary
  //                       fixture at similar bytes-per-page -- puts a full mb2
  //                       parse appreciably beyond 200 ms, so cancellation
  //                       lands mid-document rather than after it.
  //   120 ms cancel       far more than a cooperative exit needs. worker.mjs
  //                       checks the flag every chunk (lines 121, 129) and posts
  //                       its 'error' reply from the CATCH block, before its own
  //                       bounded cleanup runs in `finally`. The parent
  //                       therefore hears back in milliseconds and never waits
  //                       on the 1,000 ms cleanup bound.
  //    80 ms terminate    slack. The worker is already on its way out.
  //
  // graceMs is deliberately NOT passed. The production 2,000 ms reserve scales
  // itself down to 120 ms here, and exercising that path is worth more than
  // hard-coding the number a second time.
  const r = await extractInWorker(load('mb2'), { deadlineMs: 400 })

  console.log(`  budget ${r.plan.budgetMs}ms = ${r.plan.extractionMs} extraction`
    + ` + ${r.plan.graceMs} cancel + ${r.plan.terminateMs} terminate`)
  console.log(`  returned in ${r.elapsedMs.toFixed(0)}ms  reason=${r.reason}`
    + `  forcibly=${r.terminatedForcibly}  termination=${r.termination.state}`)

  // -------------------------------------------------------------------------
  // DIAGNOSTICS, printed BEFORE any assertion that can fail.
  //
  // The first run of this test failed at assertion 2 and told us almost nothing:
  // extraction had completed, but not whether the deadline fired, whether a
  // cancel was posted, or how far through the document the worker was when it
  // was. Those three facts sit in the timeline that never got printed.
  //
  // WHITELISTED FIELDS ONLY. No extracted text, no document bytes, no error
  // message text, no `usage` blobs. Anything error-shaped is reduced to
  // present/none, because a parser error can quote the document it was parsing.
  // -------------------------------------------------------------------------
  const SAFE = ['reason', 'code', 'state', 'numPages', 'extractionMs', 'budgetMs',
    'graceFor', 'ms', 'late', 'exited', 'exitCode']
  const rel = (at) => `${(at - r.spawnedAt >= 0 ? '+' : '')}${(at - r.spawnedAt).toFixed(3)}`
  const detail = (m) => {
    const bits = SAFE.filter((k) => m[k] !== undefined).map((k) => `${k}=${m[k]}`)
    // Presence only, never the text.
    for (const k of ['error', 'terminateError']) {
      if (k in m) bits.push(`${k}=${m[k] ? 'present' : 'none'}`)
    }
    return bits.join(' ')
  }

  console.log('\n  --- timeline, chronological, ms from spawn ---')
  // Copied before sorting: the assertions below read r.timeline and it must not
  // be reordered underneath them.
  const events = [...r.timeline].sort((a, b) => a.at - b.at)
  for (const m of events) console.log(`  ${rel(m.at).padStart(11)}  ${m.name.padEnd(32)} ${detail(m)}`)

  console.log('\n  --- worker progress samples, ms from spawn ---')
  console.log('  ' + (r.memorySamples.length
    ? r.memorySamples.map((s) => `${rel(s.at)} ${s.label}`).join('   ')
    : '(none arrived)'))

  console.log('\n  --- outcome, whitelisted result fields ---')
  console.log(`  ok=${r.ok}  reason=${r.reason}  errorName=${r.errorName}`)
  console.log(`  terminatedForcibly=${r.terminatedForcibly}`
    + `  elapsedMs=${r.elapsedMs.toFixed(3)}  withinBudget=${r.withinBudget}`)
  console.log(`  termination: state=${r.termination.state}`
    + ` cleanupConfirmed=${r.termination.cleanupConfirmed}`
    + ` waitedMs=${r.termination.waitedMs?.toFixed(3)}`
    + ` boundMs=${r.termination.boundMs}`
    + ` confirmedAt=${r.termination.confirmedAt === null ? 'null' : rel(r.termination.confirmedAt)}`
    + ` error=${r.termination.error ? 'present' : 'none'}`)
  // Counts, not content.
  console.log(`  numPages=${r.numPages}  chars=${r.chars}  exitCode=${r.exitCode}`)

  console.log('\n  --- what the timeline does and does not establish ---')
  const at = (name) => events.find((m) => m.name === name)
  const line = (label, found, note = '') =>
    console.log(`  ${label.padEnd(34, '.')} ${found ? `yes  ${rel(found.at)}` : 'no'}  ${note}`)
  line('worker created', at('parent:worker-created'))
  line('worker entered', at('worker:worker-entry'))
  line('pdf.js loaded', at('worker:pdfjs-loaded'))
  line('document loaded', at('worker:document-loaded'))
  line('extraction started', at('worker:extraction-started'))
  line('extraction deadline expired', at('parent:deadline-expired'))
  line('parent requested cancellation', at('parent:cancel-requested'))
  // NO SUCH EVENT EXISTS. worker.mjs sets its `cancelled` flag in the
  // parentPort message handler without emitting a phase, so the timeline cannot
  // say whether the message was ever DELIVERED. errorName === 'Cancelled' is
  // the only positive proof, and it only appears when the flag was also ACTED
  // on. Closing this gap needs a phase() in worker.mjs, which is out of scope.
  console.log(`  ${'worker acknowledged cancellation'.padEnd(34, '.')} `
    + `NO SUCH EVENT — inferred: ${r.errorName === 'Cancelled' ? 'received AND acted on' : 'unknown'}`)
  line('cooperative grace expired', at('parent:grace-expired'))
  line('forced termination requested', at('parent:terminate-requested'))
  line('worker exit confirmed', at('parent:worker-exit'))
  line('worker reported its own finish', at('worker:worker-finished'))
  console.log(`  ${'extraction finished normally'.padEnd(34, '.')} ${r.ok ? 'yes' : 'no'}`)
  if (at('parent:deadline-expired') && r.memorySamples.length) {
    // The discriminator: where the deadline landed relative to page progress.
    const d = at('parent:deadline-expired').at
    const before = r.memorySamples.filter((s) => s.at <= d).at(-1)
    const after = r.memorySamples.find((s) => s.at > d)
    console.log(`  deadline landed between samples: ${before ? before.label : '(start)'}`
      + ` and ${after ? after.label : '(end)'}`)
  }
  console.log('')

  // 1. THE PARSE HAD GENUINELY STARTED. Without this, a cancellation that landed
  //    before pdf.js even began would read as a cooperative success.
  assert.ok(
    r.timeline.some((m) => m.name === 'worker:extraction-started'),
    'extraction never started, so nothing yielding was cancelled',
  )

  // 2. IT DID NOT SIMPLY FINISH FIRST. This is the failure mode worth naming
  //    precisely: if mb2 ever parses inside the extraction share, the test stops
  //    testing anything and should say so rather than pass quietly.
  assert.equal(
    r.ok,
    false,
    'the extraction COMPLETED before the deadline, so cooperative cancellation was'
      + ' never exercised -- the extraction share of the budget is too generous for this fixture',
  )

  // 3. A CANCELLATION WAS ACTUALLY REQUESTED, and by the deadline rather than by
  //    an abort signal.
  assert.ok(
    r.timeline.some((m) => m.name === 'parent:cancel-requested'),
    'no cancellation was ever requested',
  )
  assert.ok(
    r.timeline.some((m) => m.name === 'parent:deadline-expired'),
    'the deadline never fired, so something else stopped this run',
  )
  assert.equal(r.reason, 'deadline', `stopped for the wrong reason: ${r.reason}`)

  // 4. THE WORKER COOPERATED -- it raised its own Cancelled error, rather than
  //    dying mid-parse or failing for an unrelated reason that also yields
  //    ok:false.
  assert.equal(r.errorName, 'Cancelled', `the worker stopped for another reason: ${r.errorName}`)

  // 5. THE FALLBACK WAS NOT NEEDED. Two independent signals. The absent grace
  //    mark is the strong one: the grace timer never got to fire, which can only
  //    mean the worker answered inside the window and finish() cleared it.
  assert.equal(r.terminatedForcibly, false, 'the parse should have stopped when asked')
  assert.equal(
    r.timeline.some((m) => m.name === 'parent:grace-expired'),
    false,
    'the cancellation grace expired, so this was a forced termination, not a cooperative one',
  )

  // 6. THE EXIT WAS CONFIRMED, not merely requested.
  assert.equal(r.termination.state, 'exited', `exit not confirmed: ${r.termination.error}`)
  assert.equal(r.termination.cleanupConfirmed, true)
  assert.notEqual(r.termination.confirmedAt, null, 'no confirmation timestamp was recorded')

  // 7. CLEANUP IS NEVER REPORTED SUCCESSFUL WHEN EXIT IS UNCONFIRMED. Asserted
  //    as an equivalence in both directions, so it holds whatever the outcome
  //    rather than only on the happy path.
  assert.equal(r.termination.cleanupConfirmed, r.termination.state === 'exited')
  assert.equal(r.terminateError === null, r.termination.cleanupConfirmed)

  // 8. THE BUDGET HELD, and was not even needed in full: a cooperative stop
  //    skips the grace entirely, so this must land well short of 400 ms.
  assert.equal(r.withinBudget, true, `took ${r.elapsedMs.toFixed(0)}ms of a ${r.plan.budgetMs}ms budget`)
  assert.ok(
    r.elapsedMs < r.plan.budgetMs,
    'the call consumed its entire budget, which a cooperative stop should not need',
  )
})

test('timeout: FORCED termination when the worker cannot yield', async () => {
  // The test-only synthetic stall busy-waits, so the cancel message is never
  // delivered. This is the stand-in for a pathological document, which Phase 0
  // was forbidden from creating -- and it is why the label matters: this
  // exercises the TERMINATE path, not pdf.js's behaviour under a hostile file.
  const r = await extractInWorker(load('small'), {
    deadlineMs: 100,
    graceMs: 300,
    stallMs: 8_000,
    allowTestStall: true,
  })

  assert.equal(r.ok, false)
  assert.equal(r.terminatedForcibly, true, 'the fallback did not fire on an unyielding worker')
  assert.ok(r.timeline.some((m) => m.name === 'parent:grace-expired'))

  const elapsed = r.finishedAt - r.spawnedAt
  console.log(`  forcibly terminated after ${elapsed.toFixed(0)}ms despite an 8000ms stall`)
  assert.ok(elapsed < 5_000, 'terminate did not preempt the stall')

  // =======================================================================
  // THE RESTORED FORCED-TERMINATION ALLOWANCE.
  //
  // The reserve was split 600/400 for cooperative workers, which was right --
  // but it was applied unconditionally, so the one path with no cleanup to wait
  // for, and the only path genuinely up against an uncooperative thread, had its
  // allowance cut to 40%. The correction gives the forced path the whole reserve
  // back. Until now nothing OBSERVED that: this test printed only `elapsed`.
  // =======================================================================
  console.log(`  plan: budget ${r.plan.budgetMs} = extraction ${r.plan.extractionMs}`
    + ` + grace ${r.plan.graceMs} + reserve ${r.plan.terminateMs}`
    + `  (cooperative share would be ${r.plan.terminateWaitMs})`)

  // The allocation this test's assertions depend on. graceMs:300 is requested
  // above and clamped to 30% of the budget, which is why graceMs is 30 not 300.
  assert.equal(r.plan.budgetMs, 100)
  assert.equal(r.plan.extractionMs, 50)
  assert.equal(r.plan.graceMs, 30)
  assert.equal(r.plan.terminateMs, 20)
  assert.equal(r.plan.terminateWaitMs, 8)

  // Forced, and therefore no cleanup wait. Both halves matter: the flag selects
  // the allowance, and the absent mark proves nothing was spent waiting.
  assert.equal(r.terminatedForcibly, true)
  assert.equal(
    r.timeline.some((m) => m.name === 'parent:cleanup-wait-started'),
    false,
    'a cleanup wait was entered on the forced path',
  )
  assert.equal(
    r.pdfjsCleanup,
    'not-attempted-forced-termination',
    `pdfjsCleanup was "${r.pdfjsCleanup}"; a stalled worker never reaches its cleanup block`,
  )

  // ---- WHICH ALLOWANCE WAS ACTUALLY SELECTED ----------------------------
  // boundMs = Math.max(0, Math.min(allowanceMs, remaining())), so it is not
  // simply the allowance -- elapsed time can cap it. That is why this does NOT
  // assert boundMs === 20.
  const spawnMark = r.timeline.find((m) => m.name === 'parent:spawn-requested')
  const requestMark = r.timeline.find((m) => m.name === 'parent:terminate-requested')
  assert.ok(spawnMark && requestMark, 'the timeline lacks the marks needed to check the bound')

  const elapsedAtRequest = requestMark.at - spawnMark.at
  const remainingAtRequest = r.plan.budgetMs - elapsedAtRequest
  const expectedBound = Math.max(0, Math.min(r.plan.terminateMs, remainingAtRequest))

  console.log(`  termination: state=${r.termination.state} boundMs=${r.termination.boundMs}`
    + ` waitedMs=${r.termination.waitedMs.toFixed(3)}`
    + `  (at request: elapsed ${elapsedAtRequest.toFixed(3)}ms, remaining ${remainingAtRequest.toFixed(3)}ms,`
    + ` so min(${r.plan.terminateMs}, remaining) = ${expectedBound.toFixed(3)})`)

  // It can never exceed the allowance that was selected.
  assert.ok(
    r.termination.boundMs <= r.plan.terminateMs,
    `boundMs ${r.termination.boundMs} exceeds the ${r.plan.terminateMs}ms reserve`,
  )

  // Consistent with the same formula. 2ms of tolerance because remaining() is
  // read a few microseconds after the mark's timestamp, and timers fire late.
  assert.ok(
    Math.abs(r.termination.boundMs - expectedBound) <= 2,
    `boundMs ${r.termination.boundMs} is not min(${r.plan.terminateMs}, remaining ${remainingAtRequest.toFixed(3)})`,
  )

  // THE DISCRIMINATOR. Had the cooperative share been selected, boundMs would be
  // EXACTLY 8 -- because 8 is below the remaining budget, so the allowance, not
  // remaining(), would bind. A bound above 8 can only come from the 20ms reserve.
  //
  // Guarded, because the discrimination is only possible while the budget still
  // holds more than the cooperative share. If timers ran so late that remaining()
  // fell below 8, both allowances would produce the same number and this run
  // simply cannot tell them apart -- which it says, rather than failing.
  if (remainingAtRequest > r.plan.terminateWaitMs) {
    assert.ok(
      r.termination.boundMs > r.plan.terminateWaitMs,
      `boundMs ${r.termination.boundMs} <= the cooperative share ${r.plan.terminateWaitMs}ms,`
        + ` with ${remainingAtRequest.toFixed(3)}ms still remaining: the reduced allowance appears to have been selected`,
    )
    console.log(`  => the FULL ${r.plan.terminateMs}ms reserve was selected, not the ${r.plan.terminateWaitMs}ms share`)
  } else {
    console.log(`  => NOT DISCRIMINATING this run: only ${remainingAtRequest.toFixed(3)}ms remained,`
      + ` so remaining() caps the bound and both allowances look identical`)
  }

  // Reported honestly whichever it is. A 20ms bound against a measured 1.1-2.5ms
  // terminate latency should confirm, but nothing here requires it to.
  assert.ok(
    ['exited', 'failed', 'unconfirmed'].includes(r.termination.state),
    `unexpected termination state: ${r.termination.state}`,
  )
})

test('timeout: an AbortSignal (a closed browser) stops the worker', async () => {
  const controller = new AbortController()
  const promise = extractInWorker(load('mb2'), { deadlineMs: 60_000, graceMs: 2_000, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  const r = await promise

  assert.equal(r.ok, false)
  assert.equal(r.reason, 'aborted')
  assert.ok(r.timeline.some((m) => m.name === 'parent:terminated'))
})
