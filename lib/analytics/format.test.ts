import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MISSING,
  formatAgo,
  formatDate,
  formatDelta,
  formatNumber,
  formatPercent,
  formatScore,
  formatValue,
} from './format.ts'

/**
 * The formatting rule this dashboard exists to keep: unknown renders as a
 * dash, never as zero.
 */

test('a missing number is a dash, not a zero', () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatNumber(value as number), MISSING)
    assert.equal(formatPercent(value as number), MISSING)
    assert.equal(formatScore(value as number), MISSING)
    assert.equal(formatValue(value as number, 'currency'), MISSING)
  }
})

test('a real zero still renders as zero', () => {
  assert.equal(formatNumber(0), '0')
  assert.equal(formatPercent(0), '0.0%')
})

test('counts are grouped and rounded', () => {
  assert.equal(formatNumber(3842), '3,842')
  assert.equal(formatNumber(1234567), '1,234,567')
  assert.equal(formatNumber(12.6), '13')
})

test('units decide the shape of the value', () => {
  assert.equal(formatValue(42, 'count'), '42')
  assert.equal(formatValue(42.123, 'percent'), '42.1%')
  assert.equal(formatValue(7.25, 'score'), '7.3')
  assert.equal(formatValue(39.99, 'currency'), '$39.99')
})

// --- comparisons ------------------------------------------------------------

test('no previous figure means no delta at all', () => {
  assert.equal(formatDelta(10, null), null)
  assert.equal(formatDelta(10, undefined), null)
  assert.equal(formatDelta(null, 10), null)
})

test('a rise and a fall are both described as a percentage', () => {
  assert.deepEqual(formatDelta(120, 100), { direction: 'up', label: '+20%', meaningful: true })
  assert.deepEqual(formatDelta(80, 100), { direction: 'down', label: '-20%', meaningful: true })
})

test('small changes keep a decimal so they are not rounded to nothing', () => {
  assert.equal(formatDelta(101, 100)?.label, '+1.0%')
  assert.equal(formatDelta(1050, 1000)?.label, '+5.0%')
})

test('growth from zero is stated in whole numbers, never as a percentage', () => {
  // A jump from 0 to 3 is not a 300% rise, and printing one would be a lie.
  assert.deepEqual(formatDelta(3, 0), { direction: 'up', label: '+3 from 0', meaningful: true })
  assert.deepEqual(formatDelta(0, 4), { direction: 'down', label: '-100%', meaningful: true })
})

test('no movement says so in words rather than a hollow 0.0%', () => {
  assert.deepEqual(formatDelta(100, 100), { direction: 'flat', label: 'no change', meaningful: false })
  assert.deepEqual(formatDelta(0, 0), { direction: 'flat', label: 'no change', meaningful: false })
})

// --- dates ------------------------------------------------------------------

test('dates render in the reporting zone, not the machine zone', () => {
  // 02:00 UTC is still the previous evening in New York.
  assert.equal(formatDate('2026-09-22T02:00:00.000Z'), '21 Sep 2026')
  assert.equal(formatDate('2026-09-22T02:00:00.000Z', 'UTC'), '22 Sep 2026')
  assert.equal(formatDate(null), MISSING)
  assert.equal(formatDate('nonsense'), MISSING)
})

test('last-seen reads as an interval, and never is never', () => {
  const now = new Date('2026-09-22T12:00:00.000Z')

  assert.equal(formatAgo(null, now), 'never')
  assert.equal(formatAgo('2026-09-22T11:59:30.000Z', now), 'just now')
  assert.equal(formatAgo('2026-09-22T11:30:00.000Z', now), '30 min ago')
  assert.equal(formatAgo('2026-09-22T06:00:00.000Z', now), '6 hr ago')
  assert.equal(formatAgo('2026-09-21T12:00:00.000Z', now), '1 day ago')
  assert.equal(formatAgo('2026-09-01T12:00:00.000Z', now), '21 days ago')
  assert.equal(formatAgo('2026-06-22T12:00:00.000Z', now), '3 mo ago')
  assert.equal(formatAgo('2024-09-22T12:00:00.000Z', now), '2 yr ago')
})
