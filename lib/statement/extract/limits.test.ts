import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLEANUP_DEADLINE_MS,
  CLEANUP_WAIT_MS,
  COOPERATIVE_GRACE_MS,
  MAX_EXTRACTED_CHARS,
  MAX_SAVED_CHARS,
  MAX_UPLOAD_BYTES,
  PRODUCTION_DEADLINE_MS,
  TERMINATE_RESERVE_MS,
  TERMINATE_WAIT_MS,
  planBudget,
} from './limits.ts'

/**
 * The approved numbers, and the arithmetic that divides the budget.
 *
 * Pure. Nothing here launches a worker or reads a PDF.
 */

test('limits: the approved application limits are exactly the approved values', () => {
  // UNITS ARE ASSERTED, not just magnitudes. 4,000,000 is decimal bytes; the
  // binary reading (4 MiB) is 4,194,304 and is NOT what was approved.
  assert.equal(MAX_UPLOAD_BYTES, 4_000_000)
  assert.notEqual(MAX_UPLOAD_BYTES, 4 * 1024 * 1024)
  assert.equal(MAX_EXTRACTED_CHARS, 50_000)
  assert.equal(MAX_SAVED_CHARS, 20_000)
  // The temporary ceiling must be above the save ceiling, or the 20,001-50,000
  // "editable but not saveable" band cannot exist.
  assert.ok(MAX_EXTRACTED_CHARS > MAX_SAVED_CHARS)
})

test('limits: the budget constants are the approved values', () => {
  assert.equal(PRODUCTION_DEADLINE_MS, 45_000)
  assert.equal(COOPERATIVE_GRACE_MS, 2_000)
  assert.equal(TERMINATE_RESERVE_MS, 1_000)
  assert.equal(CLEANUP_WAIT_MS, 600)
  assert.equal(CLEANUP_DEADLINE_MS, 450)
  assert.equal(TERMINATE_WAIT_MS, 400)
  // The reserve divides; it does not grow.
  assert.equal(CLEANUP_WAIT_MS + TERMINATE_WAIT_MS, TERMINATE_RESERVE_MS)
  // The worker's own deadline must be shorter than the parent's wait, or a worker
  // that finishes on time is never heard.
  assert.ok(CLEANUP_DEADLINE_MS < CLEANUP_WAIT_MS)
})

test('limits: the default plan is 42,000 / 2,000 / 1,000 and sums to the budget', () => {
  const p = planBudget()
  assert.equal(p.budgetMs, 45_000)
  assert.equal(p.extractionMs, 42_000)
  assert.equal(p.graceMs, 2_000)
  assert.equal(p.terminateMs, 1_000)
  assert.equal(p.cleanupWaitMs, 600)
  assert.equal(p.terminateWaitMs, 400)
  assert.equal(p.cleanupDeadlineMs, 450)
  assert.equal(p.clampedFromMs, null)
  // NOTHING IS ADDED AFTER THE BUDGET.
  assert.equal(p.extractionMs + p.graceMs + p.terminateMs, p.budgetMs)
  assert.equal(p.cleanupWaitMs + p.terminateWaitMs, p.terminateMs)
})

test('limits: an omitted or invalid budget cannot disable the timeout', () => {
  // `undefined > 0` is false, which is how an earlier version armed no timer at
  // all. Every one of these must fall back to the approved value.
  for (const bad of [undefined, 0, -1, -45_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    const p = planBudget(bad as number | undefined)
    assert.equal(p.budgetMs, PRODUCTION_DEADLINE_MS, `budget for ${String(bad)}`)
    assert.ok(p.extractionMs > 0, `extraction allowance for ${String(bad)}`)
  }
})

test('limits: a budget above the ceiling is clamped down and says so', () => {
  const p = planBudget(120_000)
  assert.equal(p.budgetMs, PRODUCTION_DEADLINE_MS)
  assert.equal(p.clampedFromMs, 120_000)
})

test('limits: short test budgets scale the reserves instead of exhausting them', () => {
  const p = planBudget(400, 300)
  assert.equal(p.budgetMs, 400)
  // 30% and 20% shares bind at this size.
  assert.equal(p.graceMs, 120)
  assert.equal(p.terminateMs, 80)
  assert.equal(p.extractionMs, 200)
  assert.equal(p.extractionMs + p.graceMs + p.terminateMs, p.budgetMs)
  assert.equal(p.cleanupWaitMs + p.terminateWaitMs, p.terminateMs)
  // Extraction must never be starved to nothing by the reserves.
  assert.ok(p.extractionMs > 0)
})

test('limits: every plan keeps its invariants across a range of budgets', () => {
  for (const budget of [20, 50, 100, 400, 1_000, 5_000, 45_000]) {
    const p = planBudget(budget)
    assert.equal(p.extractionMs + p.graceMs + p.terminateMs, p.budgetMs, `sum at ${budget}`)
    assert.equal(p.cleanupWaitMs + p.terminateWaitMs, p.terminateMs, `reserve at ${budget}`)
    assert.ok(p.extractionMs > 0, `extraction positive at ${budget}`)
    assert.ok(p.cleanupDeadlineMs <= p.cleanupWaitMs, `worker deadline bounded at ${budget}`)
    assert.ok(p.budgetMs <= PRODUCTION_DEADLINE_MS, `ceiling at ${budget}`)
  }
})
