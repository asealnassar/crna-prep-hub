import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeSuccess } from './extractInWorker.ts'

/**
 * LATE-RESULT REJECTION, as a pure decision.
 *
 * WHY THIS IS A UNIT TEST AND NOT AN INTEGRATION ONE. The rejection branch cannot
 * be reached end to end with the real worker: once the worker receives a `cancel`
 * it throws and posts an `error`, never a late `done`. That is cooperative
 * cancellation working correctly, and it leaves the branch unreachable by
 * construction. Extracting the rule is what makes it assertable at all.
 *
 * Every time is supplied, so nothing here depends on a clock.
 */

const BASE = { spawnedAt: 1_000, extractionMs: 100 }

test('judgeSuccess: a result produced inside the allowance is accepted', () => {
  const v = judgeSuccess({ ...BASE, producedAt: 1_050, receivedAt: 1_060 })
  assert.equal(v.accepted, true)
  assert.equal(v.reason, null)
  assert.equal(v.late, false)
  // Negative = allowance still unused.
  assert.equal(v.lateByMs, -50)
  assert.equal(v.usedReceiptFallback, false)
})

test('judgeSuccess: exactly on the allowance boundary is accepted', () => {
  // lateByMs === 0 is not late. The predicate is `> 0`, and an off-by-one here
  // would reject a result that finished precisely on time.
  const v = judgeSuccess({ ...BASE, producedAt: 1_100, receivedAt: 1_100 })
  assert.equal(v.lateByMs, 0)
  assert.equal(v.late, false)
  assert.equal(v.accepted, true)
})

test('judgeSuccess: one millisecond past the allowance is rejected', () => {
  const v = judgeSuccess({ ...BASE, producedAt: 1_101, receivedAt: 1_101 })
  assert.equal(v.lateByMs, 1)
  assert.equal(v.late, true)
  assert.equal(v.accepted, false)
  // Nothing was recorded, so a bare overrun is a deadline by definition.
  assert.equal(v.reason, 'deadline')
})

test('judgeSuccess: a recorded stop beats an otherwise timely result', () => {
  const v = judgeSuccess({ ...BASE, producedAt: 1_050, receivedAt: 1_060, outcome: 'aborted' })
  assert.equal(v.accepted, false)
  // The recorded reason wins; it is not overwritten with 'deadline'.
  assert.equal(v.reason, 'aborted')
  assert.equal(v.late, false)
})

test('judgeSuccess: a recorded stop cannot be overturned by a later success', () => {
  const v = judgeSuccess({ ...BASE, producedAt: 1_010, receivedAt: 1_010, outcome: 'deadline' })
  assert.equal(v.accepted, false)
  assert.equal(v.reason, 'deadline')
})

test('judgeSuccess: the worker stamp is preferred over receipt time', () => {
  // The allowance is about how long EXTRACTION took, not about when the parent got
  // round to reading the message. A late receipt must not condemn a timely result.
  const v = judgeSuccess({ ...BASE, producedAt: 1_050, receivedAt: 9_999 })
  assert.equal(v.accepted, true)
  assert.equal(v.producedAt, 1_050)
  assert.equal(v.usedReceiptFallback, false)
})

test('judgeSuccess: a missing stamp falls back to receipt, which is stricter', () => {
  const v = judgeSuccess({ ...BASE, receivedAt: 1_150 })
  assert.equal(v.usedReceiptFallback, true)
  assert.equal(v.producedAt, 1_150)
  assert.equal(v.accepted, false)
  assert.equal(v.lateByMs, 50)
})

test('judgeSuccess: a non-finite stamp falls back rather than producing NaN', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const v = judgeSuccess({ ...BASE, producedAt: bad as number | undefined, receivedAt: 1_040 })
    assert.equal(v.usedReceiptFallback, true, `fallback for ${String(bad)}`)
    assert.equal(v.producedAt, 1_040, `producedAt for ${String(bad)}`)
    assert.equal(v.accepted, true, `accepted for ${String(bad)}`)
  }
})

test('judgeSuccess: FAILS CLOSED when timeliness cannot be established', () => {
  // A decision function that cannot verify timeliness must not claim it. Each of
  // these leaves the comparison undecidable, and every one must refuse.
  const cases = [
    { spawnedAt: Number.NaN, extractionMs: 100, receivedAt: 1_050 },
    { spawnedAt: 1_000, extractionMs: Number.NaN, receivedAt: 1_050 },
    { spawnedAt: 1_000, extractionMs: 100, receivedAt: Number.NaN },
    { spawnedAt: Number.POSITIVE_INFINITY, extractionMs: 100, receivedAt: 1_050 },
  ]
  for (const input of cases) {
    const v = judgeSuccess(input)
    assert.equal(v.accepted, false, `must refuse ${JSON.stringify(input)}`)
    assert.equal(v.late, true)
    assert.equal(v.reason, 'deadline')
    assert.ok(Number.isNaN(v.lateByMs))
  }
})

test('judgeSuccess: failing closed still reports a recorded reason over the default', () => {
  const v = judgeSuccess({
    spawnedAt: Number.NaN,
    extractionMs: 100,
    receivedAt: 1_050,
    outcome: 'aborted',
  })
  assert.equal(v.accepted, false)
  assert.equal(v.reason, 'aborted')
})
