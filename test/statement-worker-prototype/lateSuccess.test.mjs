/**
 * TEST 8 -- the late-success gate. NOT RUN.
 *
 * WHAT THE GATE IS. `extractInWorker.finish()` refuses to resolve `ok: true`
 * when either of two things is true: a stop was already decided (`outcome` is
 * set), or the result was produced after the extraction allowance elapsed. It is
 * judged on the worker's own `at` stamp, not on when the parent dequeued the
 * message, so a parent-side scheduling delay cannot punish a worker that
 * finished in time.
 *
 * WHY IT EXISTS. Phase 1B observed the deadline expire at +200.7 ms, the worker
 * carry on, and its `done` arrive at +236 ms -- inside the cooperative grace
 * window, so `finish` had not run and the `done` handler resolved the call as a
 * success 36 ms past its own deadline.
 *
 * ---------------------------------------------------------------------------
 * ONE INTEGRATION TEST, THEN UNIT TESTS OF THE RULE ITSELF.
 *
 * The rejection paths cannot be reached end-to-end through the real worker,
 * because the cooperative-cancellation fix works. Tracing worker.mjs:
 *
 *   165  testOnlyStall(stallMs)      deaf while busy-waiting, but also idle
 *   166  throwIfCancelled()          SYNCHRONOUS -- the flag is not set yet,
 *                                    because delivery is a macrotask
 *   169  await import('pdfjs-dist')  yields; the handler runs; flag becomes true
 *   174  throwIfCancelled()          THROWS
 *
 * So a worker that has been sent a cancel posts an `error`, never a late `done`.
 * The only way it stays deaf is the busy-wait stall -- during which it produces
 * nothing and is force-terminated. "Deaf but productive" is not a state the
 * prototype can be put into with its existing test-only controls.
 *
 * The proportional budget split closes the other door. The extraction allowance
 * is always at least half the budget and the grace at most 30% of it, so the
 * window in which a late `done` could still be received is (0.5B, 0.8B). Landing
 * a real parse inside it would mean betting on a narrow timing window, which is
 * exactly the flakiness this file is meant to avoid.
 *
 * So the rule was extracted into `judgeSuccess()`, and the rejection paths are
 * asserted against it directly, with fixed timestamps and no worker at all.
 *
 * WHAT THAT DOES AND DOES NOT BUY. `judgeSuccess` is the SAME function finish()
 * calls -- there is no second copy of the deadline rule to drift. So these tests
 * do cover the decision the parent actually makes. They do NOT cover worker
 * message delivery, the ordering of `done` against the deadline timer, or the
 * parent's result shaping on the rejection path; only the integration test below
 * exercises a real worker, and only on the accepting path.
 * ---------------------------------------------------------------------------
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractInWorker, judgeSuccess } from './extractInWorker.mjs'
import { load } from './fixtures.mjs'
import { PRODUCTION_DEADLINE_MS } from './limits.mjs'

// ---------------------------------------------------------------------------
// A. ON-TIME SUCCESS -- implemented, and deterministic by a wide margin.
// ---------------------------------------------------------------------------

test('late-success: an on-time result is accepted, with its text, and the gate says so', async () => {
  // No deadlineMs: this exercises the PRODUCTION default, 45,000 ms, which
  // leaves a 42,000 ms extraction allowance. The 109 KB fixture has measured at
  // roughly 120 ms end to end, so the margin is ~350x. There is no race to lose.
  const r = await extractInWorker(load('small'))

  assert.equal(r.plan.budgetMs, PRODUCTION_DEADLINE_MS, 'the default budget was not applied')
  assert.equal(r.ok, true, `extraction failed: ${r.errorName}`)

  // THIS TEST CANNOT PASS WITHOUT REACHING THE GATE. The mark is emitted only by
  // the gate's accepting branch, so its presence proves the code under test ran
  // rather than being skipped over.
  const accepted = r.timeline.find((m) => m.name === 'parent:success-within-allowance')
  assert.ok(accepted, 'the gate never ran: no parent:success-within-allowance mark')
  assert.equal(
    r.timeline.some((m) => m.name === 'parent:late-success-rejected'),
    false,
    'an on-time result was routed through the rejection branch',
  )

  // Judged on the worker's own stamp, and comfortably inside the allowance.
  assert.ok(Number.isFinite(r.producedAt), 'no producedAt stamp survived to the caller')
  const usedMs = r.producedAt - r.spawnedAt
  assert.ok(usedMs > 0, 'the result claims to predate the budget start')
  assert.ok(
    usedMs < r.plan.extractionMs,
    `used ${usedMs.toFixed(1)}ms of a ${r.plan.extractionMs}ms allowance`,
  )
  console.log(`  accepted: produced at +${usedMs.toFixed(1)}ms of ${r.plan.extractionMs}ms allowed`
    + ` (${accepted.lateByMs}ms spare)`)

  // The whole text comes back. r.chars sums per-page lengths and the pages are
  // joined with a newline, so the returned string is longer by one separator per
  // page boundary -- see textBoundary.test.mjs.
  assert.equal(typeof r.text, 'string')
  assert.ok(r.text.length > 0, 'an accepted success returned no text')
  assert.equal(
    r.text.length,
    r.chars + r.numPages - 1,
    'the returned string is not the counted text plus one newline per page boundary',
  )

  // Worker exit confirmed -- which is NOT a claim about pdf.js internal
  // teardown, and this test makes no such claim.
  assert.equal(r.termination.state, 'exited', `exit not confirmed: ${r.termination.error}`)
  assert.equal(r.termination.cleanupConfirmed, true)
  assert.equal(r.terminateError, null)

  // INTERNAL CONSISTENCY. An accepted success must not carry any of the
  // vocabulary of a refusal. This is the contradiction the gate exists to make
  // impossible, asserted directly.
  assert.equal(r.reason, undefined, `an ok result also carried reason=${r.reason}`)
  assert.equal(r.lateSuccessRejected, undefined)
  assert.equal(r.rejectedChars, undefined)
  assert.equal(r.rejectedNumPages, undefined)
  assert.equal(r.terminatedForcibly, false)
  assert.equal(r.withinBudget, true)
})

// ---------------------------------------------------------------------------
// THE RULE ITSELF -- deterministic, fixed timestamps, no worker.
//
// One fixed scenario reused throughout: a budget that started at t=1,000,000 on
// some arbitrary clock, with the approved 42,000 ms extraction allowance. Every
// `producedAt` below is that origin plus a chosen offset, so "late by 36 ms"
// means exactly that and nothing depends on machine speed.
// ---------------------------------------------------------------------------

const ORIGIN = 1_000_000          // fictional, and deliberately not zero
const ALLOWANCE = 42_000          // the approved startup + extraction share
const at = (offsetMs) => ORIGIN + offsetMs
const judge = (overrides) => judgeSuccess({
  spawnedAt: ORIGIN,
  extractionMs: ALLOWANCE,
  // A receipt time well inside the allowance, so it is never the reason a case
  // fails. Individual tests override it where the fallback is the point.
  receivedAt: at(100),
  outcome: null,
  ...overrides,
})

// B. A result produced after the allowance, with the deadline already recorded.
test('late-success: a result produced after the allowance is rejected as a deadline', () => {
  // The Phase 1B shape, in numbers: the deadline fired, the parent recorded it,
  // and the worker's result turned up 36 ms past the allowance.
  const v = judge({ producedAt: at(ALLOWANCE + 36), outcome: 'deadline' })

  assert.equal(v.accepted, false, 'a result 36ms past the allowance was accepted')
  assert.equal(v.reason, 'deadline')
  assert.equal(v.late, true)
  assert.equal(v.lateByMs, 36)
  assert.equal(v.usedReceiptFallback, false, 'the worker stamp should have been used')
})

// B'. The same overrun, but the deadline timer callback has not run yet.
test('late-success: an allowance overrun is rejected even when the deadline timer runs late', () => {
  // `outcome` is null: setTimeout has not fired, so nothing is recorded. The
  // elapsed-time half of the rule has to carry this on its own, which is the
  // reason the rule is two conditions and not one.
  const v = judge({ producedAt: at(ALLOWANCE + 0.5), outcome: null })

  assert.equal(v.accepted, false, 'an overrun passed because no outcome was recorded yet')
  assert.equal(v.reason, 'deadline', 'an unrecorded overrun must still read as a deadline')
  assert.equal(v.late, true)
  assert.equal(v.lateByMs, 0.5)
})

// C. On time, but a stop was already recorded.
test('late-success: an in-time result is still refused once cancellation is recorded', () => {
  // Produced with 2,000 ms of allowance to spare -- and refused anyway, because
  // an abort had already been decided. The RECORDED reason must survive; this is
  // the "a late done must not overwrite an existing outcome" requirement.
  const v = judge({ producedAt: at(ALLOWANCE - 2_000), outcome: 'aborted' })

  assert.equal(v.accepted, false, 'a recorded cancellation was overturned by a success')
  assert.equal(v.reason, 'aborted', 'the recorded reason was replaced')
  assert.equal(v.late, false, 'this result was NOT late; it was cancelled')
  assert.ok(v.lateByMs < 0, 'the spare allowance should read as negative lateness')
})

test('late-success: a recorded deadline also survives an in-time result', () => {
  // The same precedence, with the other reason, so the rule is not accidentally
  // specific to 'aborted'.
  const v = judge({ producedAt: at(1_000), outcome: 'deadline' })
  assert.equal(v.accepted, false)
  assert.equal(v.reason, 'deadline')
  assert.equal(v.late, false)
})

// The boundary.
test('late-success: the allowance boundary is inclusive, and one tick over is not', () => {
  const exactly = judge({ producedAt: at(ALLOWANCE) })
  assert.equal(exactly.accepted, true, 'a result at exactly the allowance was refused')
  assert.equal(exactly.lateByMs, 0)

  const justOver = judge({ producedAt: at(ALLOWANCE + 1) })
  assert.equal(justOver.accepted, false, 'a result 1ms past the allowance was accepted')
  assert.equal(justOver.reason, 'deadline')

  const justUnder = judge({ producedAt: at(ALLOWANCE - 1) })
  assert.equal(justUnder.accepted, true)
  assert.equal(justUnder.lateByMs, -1)
})

// The receipt-time fallback.
test('late-success: a missing production stamp falls back to receipt time', () => {
  // In time by receipt -> accepted. Receipt is never earlier than posting, so
  // the fallback can only ever be stricter than the truth, never laxer.
  const inTime = judge({ producedAt: undefined, receivedAt: at(500) })
  assert.equal(inTime.accepted, true)
  assert.equal(inTime.usedReceiptFallback, true)
  assert.equal(inTime.producedAt, at(500), 'the fallback time was not adopted')

  // Late by receipt -> rejected.
  const tooLate = judge({ producedAt: undefined, receivedAt: at(ALLOWANCE + 10) })
  assert.equal(tooLate.accepted, false)
  assert.equal(tooLate.reason, 'deadline')
  assert.equal(tooLate.usedReceiptFallback, true)

  // A non-numeric stamp is treated as absent, not coerced.
  for (const bad of [null, NaN, Infinity, 'soon', {}]) {
    const v = judge({ producedAt: bad, receivedAt: at(500) })
    assert.equal(v.usedReceiptFallback, true, `producedAt=${String(bad)} was treated as usable`)
    assert.equal(v.accepted, true)
  }
})

test('late-success: an unverifiable pair of times fails closed', () => {
  // Unreachable from finish(), which always supplies a finite now(). Asserted
  // because a decision function that cannot verify timeliness must refuse to
  // claim it, rather than letting NaN comparisons fall through to "accepted".
  const v = judgeSuccess({
    producedAt: undefined, receivedAt: undefined,
    spawnedAt: ORIGIN, extractionMs: ALLOWANCE, outcome: null,
  })
  assert.equal(v.accepted, false, 'an unverifiable result was accepted')
  assert.equal(v.reason, 'deadline')
  assert.equal(v.late, true)
  assert.ok(Number.isNaN(v.lateByMs))
})

// The decision cannot leak the document.
test('late-success: the decision carries no extracted text, on either branch', () => {
  // judgeSuccess never receives the text and never returns it. Dropping the text
  // from a rejected result is finish()'s job -- it builds a fresh object -- and
  // that step is NOT covered here. This asserts the narrower, checkable thing:
  // the decision path has no channel through which the document could travel.
  const expected = ['accepted', 'reason', 'producedAt', 'lateByMs', 'late', 'usedReceiptFallback']
  for (const [label, v] of [
    ['accepted', judge({ producedAt: at(1_000) })],
    ['rejected', judge({ producedAt: at(ALLOWANCE + 1), outcome: 'deadline' })],
  ]) {
    assert.deepEqual(Object.keys(v).sort(), [...expected].sort(), `${label}: unexpected keys`)
    for (const key of ['text', 'chars', 'numPages', 'rejectedChars', 'buffer', 'bytes']) {
      assert.equal(key in v, false, `${label}: the verdict exposed ${key}`)
    }
  }
})

// A guard on the guard.
test('late-success: acceptance requires BOTH conditions, exhaustively', () => {
  // Every combination of (late, outcome recorded). Only one cell may accept.
  const rows = [
    { late: false, outcome: null,       expect: true  },
    { late: false, outcome: 'deadline', expect: false },
    { late: false, outcome: 'aborted',  expect: false },
    { late: true,  outcome: null,       expect: false },
    { late: true,  outcome: 'deadline', expect: false },
    { late: true,  outcome: 'aborted',  expect: false },
  ]
  for (const row of rows) {
    const v = judge({
      producedAt: at(row.late ? ALLOWANCE + 5 : ALLOWANCE - 5),
      outcome: row.outcome,
    })
    assert.equal(v.accepted, row.expect,
      `late=${row.late} outcome=${row.outcome} should be ${row.expect ? 'accepted' : 'rejected'}`)
    // And the invariant: an accepted verdict never carries a reason.
    assert.equal(v.reason === null, v.accepted, 'reason and accepted disagree')
  }
  assert.equal(rows.filter((r) => r.expect).length, 1, 'exactly one cell may accept')
})

// ---------------------------------------------------------------------------
// THE PARENT'S REJECTION PATH, END TO END -- with a stub worker that disobeys.
//
// The nine tests above verify the DECISION. This one verifies what the parent
// DOES with a rejecting verdict: that finish() really builds the refusal object
// and really drops the text. That branch had never executed, because the real
// worker cooperates -- see simulatedLateWorker.mjs for why a stub is the only
// way in.
//
// IT PROVES NOTHING ABOUT PDF.JS. No document is parsed and no teardown is
// simulated. It is not evidence that a real PDF worker would ignore a cancel.
// ---------------------------------------------------------------------------

/**
 * Must match the sentinel inside simulatedLateWorker.mjs.
 *
 * Not imported: that module runs its protocol on import and would throw outside
 * a worker thread. The coupling is deliberate and noted in both files.
 */
const STUB_SENTINEL = 'SIMULATED-LATE-WORKER-FICTIONAL-TEXT'

test('late-success: the parent refuses a worker result that lands after the deadline', async () => {
  // 800ms splits into 400 extraction / 240 cancel / 160 terminate. The stub sits
  // idle until the deadline fires at ~400ms, then answers with `done` from its
  // message handler -- immediately, so it lands early in a 240ms grace window.
  // Nothing here depends on how fast anything runs.
  const bytes = new Uint8Array(Buffer.from('fictional bytes; this stub never parses them\n'))
  const r = await extractInWorker(bytes, {
    deadlineMs: 800,
    __testWorkerUrl: './simulatedLateWorker.mjs',
  })

  const named = (name) => r.timeline.find((m) => m.name === name)
  const has = (name) => Boolean(named(name))

  assert.equal(r.plan.budgetMs, 800)
  assert.equal(r.plan.extractionMs, 400, 'the split changed; the rest of this test assumes 400/240/160')

  // 1. The extraction deadline expired.
  assert.ok(has('parent:deadline-expired'), 'the deadline never fired')

  // 2. The parent sent cancellation.
  const cancelled = named('parent:cancel-requested')
  assert.ok(cancelled, 'the parent never requested cancellation')
  assert.equal(cancelled.reason, 'deadline')

  // 3. The stub answered with `done` DURING the grace, not after it. The absent
  //    grace mark is the proof: had the grace expired first, finish() would have
  //    run as a forced termination and the `done` would have been ignored.
  assert.ok(has('worker:cancel-received'), 'the stub never received the cancel')
  assert.ok(has('worker:simulated-insubordinate-done'), 'the stub never disobeyed; it cannot test anything')
  assert.equal(has('parent:grace-expired'), false, 'the grace expired first, so this became a forced termination')
  assert.equal(r.terminatedForcibly, false)

  // 4. The parent's rejection path executed.
  const rejected = named('parent:late-success-rejected')
  assert.ok(rejected, 'the rejection branch did not run')
  assert.equal(rejected.reason, 'deadline')
  assert.equal(has('parent:success-within-allowance'), false, 'a late result was marked as accepted')

  // 5. The outcome.
  assert.equal(r.ok, false, 'a post-deadline result was returned as a success')
  assert.equal(r.reason, 'deadline')
  assert.equal(r.lateSuccessRejected, true)

  // COULD THIS PASS WITHOUT finish() BUILDING THE REFUSAL? No. These two fields
  // exist nowhere else in the codebase -- only in the object finish() constructs
  // on the rejecting branch. Their presence, with the stub's own page count, is
  // proof that the parent received the text, counted it, and chose to drop it.
  assert.equal(typeof r.rejectedChars, 'number', 'no rejectedChars: finish() did not build the refusal')
  assert.ok(r.rejectedChars > 0, 'the stub sent no text, so nothing was dropped')
  assert.equal(r.rejectedNumPages, 2, "the stub's page count did not survive as a count")

  // 6. The fictional text is gone from the result.
  assert.equal(r.text, undefined, 'the rejected result still carries extracted text')
  assert.equal(r.chars, undefined, 'a rejected result must report counts as rejectedChars, not chars')

  // 7. And gone from the diagnostics. One scan of the whole returned object
  //    catches it wherever it might hide -- result field, timeline mark or
  //    memory sample -- rather than only in the places we thought to look.
  const serialised = JSON.stringify(r)
  assert.equal(
    serialised.includes(STUB_SENTINEL),
    false,
    'the fictional text leaked into the result or the timeline',
  )
  assert.equal(JSON.stringify(r.timeline).includes(STUB_SENTINEL), false, 'text leaked into the timeline')

  // 8. Bounded termination was used, and reported for what it was.
  assert.ok(r.termination, 'no termination report')
  assert.ok(
    r.termination.boundMs <= r.plan.terminateMs,
    `terminate waited on a ${r.termination.boundMs}ms bound, over the ${r.plan.terminateMs}ms reserve`,
  )
  assert.ok(['exited', 'failed', 'unconfirmed'].includes(r.termination.state), `odd state: ${r.termination.state}`)
  // Accuracy, not optimism: confirmed cleanup iff exit was confirmed, and an
  // error reported iff it was not. Asserted as equivalences so this holds
  // whichever of the three states occurs.
  assert.equal(r.termination.cleanupConfirmed, r.termination.state === 'exited')
  assert.equal(r.terminateError === null, r.termination.cleanupConfirmed)

  // 9. The whole operation stayed inside its budget.
  assert.equal(r.withinBudget, true, `took ${r.elapsedMs.toFixed(0)}ms of a ${r.plan.budgetMs}ms budget`)
  assert.ok(r.elapsedMs <= r.plan.budgetMs)

  console.log(`  refused after ${r.elapsedMs.toFixed(0)}ms of ${r.plan.budgetMs}ms:`
    + ` reason=${r.reason} lateByMs=${r.lateByMs} dropped ${r.rejectedChars} chars`
    + ` over ${r.rejectedNumPages} pages; termination=${r.termination.state}`)
})
