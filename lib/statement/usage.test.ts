import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATEMENT_OPERATIONS, STATEMENT_OPERATION_PATTERN, STATEMENT_OPERATION_PREFIX,
  isStatementOperation, timestampsFrom,
} from './usage.ts'

test('every statement operation carries the namespace prefix', () => {
  for (const operation of Object.values(STATEMENT_OPERATIONS)) {
    assert.ok(isStatementOperation(operation), operation)
    assert.ok(operation.startsWith(STATEMENT_OPERATION_PREFIX))
    // record_ai_usage truncates to 64 characters.
    assert.ok(operation.length <= 64)
  }
})

test('resume operations are not statement operations', () => {
  // These are the values the resume propose route writes into the same table.
  for (const operation of [
    'improve-bullet', 'generate-bullets', 'rewrite-summary', 'tighten', 'organise-import',
  ]) {
    assert.equal(isStatementOperation(operation), false, operation)
  }
})

test('a missing or non-string operation is not a statement operation', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.equal(isStatementOperation(value as string), false, String(value))
  }
})

test('the PostgREST pattern matches the prefix it is built from', () => {
  assert.equal(STATEMENT_OPERATION_PATTERN, `${STATEMENT_OPERATION_PREFIX}%`)
})

test('the budget counts only this feature’s rows', () => {
  // Two features share one table. Heavy resume use must not throttle an essay.
  const rows = [
    { created_at: '2026-09-23T10:00:00Z', operation: 'statement-analyze' },
    { created_at: '2026-09-23T10:01:00Z', operation: 'improve-bullet' },
    { created_at: '2026-09-23T10:02:00Z', operation: 'statement-rewrite' },
    { created_at: '2026-09-23T10:03:00Z', operation: 'generate-bullets' },
  ]
  assert.equal(timestampsFrom(rows).length, 2)
})

test('unparseable timestamps are dropped rather than counted as now', () => {
  const rows = [
    { created_at: 'not a date', operation: 'statement-analyze' },
    { created_at: null, operation: 'statement-analyze' },
    { created_at: undefined, operation: 'statement-analyze' },
    { created_at: '2026-09-23T10:00:00Z', operation: 'statement-analyze' },
  ]
  const stamps = timestampsFrom(rows)
  assert.equal(stamps.length, 1)
  assert.ok(Number.isFinite(stamps[0]))
})

test('an empty ledger yields no timestamps', () => {
  assert.deepEqual(timestampsFrom([]), [])
})

// ----------------------------------------------- the concurrency window

test('the caller’s own attempt is discounted, so the limit does not shift', () => {
  // The attempt is written BEFORE the ledger is read, so the read always
  // includes it. Discounting exactly one row keeps the sequential behaviour
  // identical to a check-then-record order.
  const rows = [
    { created_at: '2026-09-23T10:00:04Z', operation: 'statement-analyze' },
    { created_at: '2026-09-23T10:00:03Z', operation: 'statement-analyze' },
    { created_at: '2026-09-23T10:00:02Z', operation: 'statement-analyze' },
  ]
  assert.equal(timestampsFrom(rows).length, 3)
  assert.equal(timestampsFrom(rows, true).length, 2)
})

test('the row discounted is the newest one', () => {
  const rows = [
    { created_at: '2026-09-23T10:00:01Z', operation: 'statement-analyze' },
    { created_at: '2026-09-23T10:00:09Z', operation: 'statement-analyze' },
    { created_at: '2026-09-23T10:00:05Z', operation: 'statement-analyze' },
  ]
  const kept = timestampsFrom(rows, true)
  assert.equal(kept.length, 2)
  assert.equal(kept.includes(Date.parse('2026-09-23T10:00:09Z')), false)
})

test('discounting never removes a row that is not ours to remove', () => {
  // With nothing in the ledger there is nothing to discount, and the result is
  // empty rather than negative or thrown.
  assert.deepEqual(timestampsFrom([], true), [])
  assert.deepEqual(timestampsFrom([{ created_at: 'bad', operation: 'statement-analyze' }], true), [])
})

test('discounting only ever removes one row', () => {
  const same = Array.from({ length: 5 }, () => ({
    created_at: '2026-09-23T10:00:00Z', operation: 'statement-analyze',
  }))
  // Five identical timestamps: exactly one goes, not all five.
  assert.equal(timestampsFrom(same, true).length, 4)
})

test('a resume row is never the one discounted', () => {
  const rows = [
    { created_at: '2026-09-23T10:00:09Z', operation: 'improve-bullet' },
    { created_at: '2026-09-23T10:00:01Z', operation: 'statement-analyze' },
  ]
  // The resume row is newer but is not ours and is not counted at all.
  assert.deepEqual(timestampsFrom(rows, true), [])
})
