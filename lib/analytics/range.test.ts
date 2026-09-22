import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REPORTING_TIMEZONE,
  bucketFor,
  bucketKey,
  bucketKeys,
  bucketLabel,
  bucketOf,
  dayKey,
  resolveRange,
  weekStart,
  within,
} from './range.ts'

/**
 * Every bucket on the dashboard is a calendar day in one stated zone. These
 * pin the two things that silently corrupt a daily chart: an instant landing
 * in the wrong day near midnight, and the two days a year when a local day is
 * not 24 hours long.
 */

// --- which day an instant belongs to ---------------------------------------

test('an instant after midnight UTC still belongs to the previous day in New York', () => {
  // 02:00 UTC on 22 September is 22:00 on 21 September in New York.
  assert.equal(dayKey('2026-09-22T02:00:00.000Z'), '2026-09-21')
  assert.equal(dayKey('2026-09-22T05:00:00.000Z'), '2026-09-22', 'and 01:00 ET is the 22nd')
})

test('the zone is explicit, not the machine running this', () => {
  assert.equal(dayKey('2026-09-22T02:00:00.000Z', 'UTC'), '2026-09-22')
  assert.equal(REPORTING_TIMEZONE, 'America/New_York')
})

test('a malformed date is refused rather than bucketed as now', () => {
  assert.throws(() => dayKey('not-a-date'), RangeError)
})

// --- daylight saving --------------------------------------------------------

test('the spring-forward day is one bucket, and no day is skipped', () => {
  // US clocks go forward on 8 March 2026: that local day is 23 hours long.
  const keys = bucketKeys('2026-03-06T12:00:00.000Z', '2026-03-10T12:00:00.000Z', 'day')

  assert.deepEqual(keys, ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'])
  assert.equal(new Set(keys).size, keys.length, 'no day appears twice')
})

test('the autumn fall-back day is one bucket, not two', () => {
  // US clocks go back on 1 November 2026: that local day is 25 hours long.
  const keys = bucketKeys('2026-10-30T12:00:00.000Z', '2026-11-03T12:00:00.000Z', 'day')

  assert.deepEqual(keys, ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'])
})

test('01:30 twice on the fall-back night lands in the same bucket both times', () => {
  // Both instants are 01:30 local on 1 November, before and after the change.
  const first = bucketKey('2026-11-01T05:30:00.000Z', 'day')
  const second = bucketKey('2026-11-01T06:30:00.000Z', 'day')

  assert.equal(first, '2026-11-01')
  assert.equal(second, '2026-11-01')
})

// --- weeks and months -------------------------------------------------------

test('weeks start on Monday', () => {
  assert.equal(weekStart('2026-09-22'), '2026-09-21', 'Tuesday belongs to its Monday')
  assert.equal(weekStart('2026-09-21'), '2026-09-21', 'Monday is its own start')
  assert.equal(weekStart('2026-09-20'), '2026-09-14', 'Sunday belongs to the Monday before')
})

test('a week bucket spanning a month boundary stays one bucket', () => {
  const keys = bucketKeys('2026-08-29T12:00:00.000Z', '2026-09-05T12:00:00.000Z', 'week')

  assert.deepEqual(keys, ['2026-08-24', '2026-08-31'])
})

test('month buckets are year-month keys', () => {
  assert.equal(bucketOf('2026-09-22', 'month'), '2026-09')
  assert.deepEqual(bucketKeys('2026-07-15T12:00:00.000Z', '2026-09-02T12:00:00.000Z', 'month'), [
    '2026-07',
    '2026-08',
    '2026-09',
  ])
})

test('bucket labels read as dates, not keys', () => {
  assert.equal(bucketLabel('2026-09-04', 'day'), '4 Sep')
  assert.equal(bucketLabel('2026-09-21', 'week'), 'w/c 21 Sep')
  assert.equal(bucketLabel('2026-09', 'month'), 'Sep 2026')
})

test('bucket size follows the span, so a year does not draw 365 bars', () => {
  assert.equal(bucketFor(7), 'day')
  assert.equal(bucketFor(92), 'day')
  assert.equal(bucketFor(93), 'week')
  assert.equal(bucketFor(400), 'week')
  assert.equal(bucketFor(401), 'month')
})

// --- resolving what the page asked for --------------------------------------

const NOW = new Date('2026-09-22T16:00:00.000Z') // midday in New York

test('the default window is the last 30 days', () => {
  const range = resolveRange({ now: NOW })

  assert.equal(range.preset, '30d')
  assert.equal(range.bucket, 'day')
  assert.equal(range.label, 'Last 30 days')
  assert.equal(dayKey(range.from!), '2026-08-24', '30 days inclusive of today')
  assert.equal(range.to, NOW.toISOString())
})

test('a window starts at local midnight, not at the current time of day', () => {
  const range = resolveRange({ preset: '7d', now: NOW })

  assert.equal(dayKey(range.from!), '2026-09-16')
  assert.equal(range.from, '2026-09-16T04:00:00.000Z', 'midnight New York, in UTC')
})

test('the comparison window is the same length and ends where this one starts', () => {
  const range = resolveRange({ preset: '30d', now: NOW })
  const from = Date.parse(range.from!)
  const comparisonFrom = Date.parse(range.comparison!.from)

  assert.equal(range.comparison!.to, range.from)
  assert.equal((from - comparisonFrom) / (24 * 60 * 60 * 1000), 30)
  assert.equal(range.comparison!.label, 'previous 30 days')
})

test('all time has no lower bound and nothing to compare against', () => {
  const range = resolveRange({ preset: 'all', now: NOW })

  assert.equal(range.from, null)
  assert.equal(range.comparison, null)
  assert.equal(range.bucket, 'month')
})

test('a custom range covers both endpoint days in full', () => {
  const range = resolveRange({ preset: 'custom', from: '2026-09-01', to: '2026-09-07', now: NOW })

  assert.equal(dayKey(range.from!), '2026-09-01')
  assert.equal(range.to, '2026-09-08T04:00:00.000Z', 'exclusive end is the start of the next day')
  assert.equal(range.bucket, 'day')
  assert.equal(range.comparison!.label, 'previous 7 days')
})

test('a long custom range switches to a readable bucket', () => {
  const range = resolveRange({ preset: 'custom', from: '2026-01-01', to: '2026-09-01', now: NOW })

  assert.equal(range.bucket, 'week')
})

test('a nonsense range falls back to the default rather than failing', () => {
  for (const input of [
    { preset: 'custom', from: 'yesterday', to: 'today' },
    { preset: 'custom', from: '2026-09-07', to: '2026-09-01' },
    { preset: 'banana' },
    {},
  ]) {
    const range = resolveRange({ ...input, now: NOW })
    assert.equal(range.label, 'Last 30 days')
  }
})

// --- membership -------------------------------------------------------------

test('the window includes its start and excludes its end', () => {
  const from = '2026-09-01T00:00:00.000Z'
  const to = '2026-09-02T00:00:00.000Z'

  assert.equal(within(from, from, to), true)
  assert.equal(within('2026-09-01T23:59:59.999Z', from, to), true)
  assert.equal(within(to, from, to), false)
  assert.equal(within('2026-08-31T23:59:59.999Z', from, to), false)
})

test('all time accepts anything before the end', () => {
  assert.equal(within('2020-01-01T00:00:00.000Z', null, '2026-09-22T00:00:00.000Z'), true)
  assert.equal(within('not a date', null, '2026-09-22T00:00:00.000Z'), false)
})
