import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  countBy,
  countByBucket,
  cumulative,
  distinctByBucket,
  distinctSet,
  earliest,
  mean,
  percent,
  rank,
} from './aggregate.ts'

const KEYS = ['2026-09-20', '2026-09-21', '2026-09-22']

test('rows land in their own bucket and empty buckets stay in the series', () => {
  const rows = [
    { at: '2026-09-20T14:00:00.000Z' },
    { at: '2026-09-22T14:00:00.000Z' },
    { at: '2026-09-22T15:00:00.000Z' },
  ]

  assert.deepEqual(countByBucket(rows, (r) => r.at, KEYS, 'day'), [1, 0, 2])
})

test('a row outside the window is ignored rather than folded into an edge bucket', () => {
  const rows = [{ at: '2026-09-01T14:00:00.000Z' }, { at: '2026-10-01T14:00:00.000Z' }]

  assert.deepEqual(countByBucket(rows, (r) => r.at, KEYS, 'day'), [0, 0, 0])
})

test('missing and malformed timestamps are skipped, not counted as now', () => {
  const rows = [{ at: null }, { at: '' }, { at: 'whenever' }, { at: '2026-09-21T14:00:00.000Z' }]

  assert.deepEqual(countByBucket(rows, (r) => r.at, KEYS, 'day'), [0, 1, 0])
})

test('distinct-by-bucket counts a person once per bucket, however busy they were', () => {
  const rows = [
    { at: '2026-09-20T14:00:00.000Z', who: 'a' },
    { at: '2026-09-20T15:00:00.000Z', who: 'a' },
    { at: '2026-09-20T16:00:00.000Z', who: 'b' },
    { at: '2026-09-22T16:00:00.000Z', who: 'a' },
  ]

  assert.deepEqual(
    distinctByBucket(rows, (r) => r.at, (r) => r.who, KEYS, 'day'),
    [2, 0, 1]
  )
})

test('a cumulative line can start from the total that came before the window', () => {
  assert.deepEqual(cumulative([1, 0, 2]), [1, 1, 3])
  assert.deepEqual(cumulative([1, 0, 2], 500), [501, 501, 503])
})

test('grouping labels blanks instead of dropping them', () => {
  const rows = [{ k: 'clinical' }, { k: 'clinical' }, { k: null }, { k: '' }, { k: 'mixed' }]
  const counts = countBy(rows, (r) => r.k)

  assert.equal(counts.get('clinical'), 2)
  assert.equal(counts.get('mixed'), 1)
  assert.equal(counts.get('(not recorded)'), 2)
})

test('a breakdown is ordered by size, with a stable tie-break', () => {
  const counts = new Map([
    ['mixed', 3],
    ['clinical', 7],
    ['custom', 3],
  ])

  assert.deepEqual(rank(counts), [
    { key: 'clinical', value: 7 },
    { key: 'custom', value: 3 },
    { key: 'mixed', value: 3 },
  ])
})

test('distinct ignores blanks', () => {
  const rows = [{ id: 'a' }, { id: 'a' }, { id: null }, { id: 'b' }]

  assert.deepEqual([...distinctSet(rows, (r) => r.id)].sort(), ['a', 'b'])
})

test('a percentage refuses to divide by nothing', () => {
  assert.equal(percent(5, 20), 25)
  assert.equal(percent(0, 20), 0)
  assert.equal(percent(5, 0), null, 'no denominator means no rate, not zero')
  assert.equal(percent(null, 20), null)
  assert.equal(percent(5, null), null)
})

test('an average of nothing is null, not zero', () => {
  assert.equal(mean([]), null)
  assert.equal(mean([null, undefined]), null)
  assert.equal(mean([4, 6]), 5)
  assert.equal(mean([4, null, 6]), 5, 'missing scores do not drag the average down')
})

test('the earliest record is found, and absent timestamps do not win', () => {
  const rows = [{ at: '2026-09-05T00:00:00.000Z' }, { at: null }, { at: '2026-08-30T00:00:00.000Z' }]

  assert.equal(earliest(rows, (r) => r.at), '2026-08-30T00:00:00.000Z')
  assert.equal(earliest([], (r: { at: string }) => r.at), null)
})
