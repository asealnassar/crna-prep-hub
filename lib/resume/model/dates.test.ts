import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABSENT_DATE, compareResumeDates, isUsableDate, monthsInRange, parseResumeDate,
  parseResumeDateRange, rangeOrder, rawDateText, resumeDateFromParts,
} from './dates.ts'

/**
 * Legacy dates.
 *
 * V1 fed raw strings to `new Date(...)`, so "Invalid Date" reached printed
 * PDFs and a missing end date produced NaN years of experience -- which was
 * then stated as fact inside an AI prompt. Phase 0 measured the scale: 22% of
 * ICU positions and 35% of degrees carry an empty or unparseable date.
 *
 * The contract these tests pin: three states, raw text always survives, and
 * no function can produce an Invalid Date or a NaN.
 */

test('valid month precision parses', () => {
  const d = parseResumeDate('2019-06')
  assert.equal(d.kind, 'exact')
  if (d.kind !== 'exact') return
  assert.equal(d.year, 2019)
  assert.equal(d.month, 6)
  assert.equal(d.day, null)
  assert.equal(d.raw, '2019-06')
})

test('valid day precision parses', () => {
  const d = parseResumeDate('2019-06-15')
  assert.equal(d.kind, 'exact')
  if (d.kind !== 'exact') return
  assert.deepEqual([d.year, d.month, d.day], [2019, 6, 15])
})

test('empty and whitespace are absent, not errors', () => {
  for (const input of ['', '   ', '\t', '\n  ']) {
    assert.equal(parseResumeDate(input).kind, 'absent', JSON.stringify(input))
  }
})

test('non-strings are absent', () => {
  for (const input of [undefined, null, 0, 42, {}, [], true, NaN]) {
    assert.equal(parseResumeDate(input).kind, 'absent', String(input))
  }
})

test('malformed strings are preserved verbatim, never guessed', () => {
  const cases = ['Spring 2019', 'n/a', '06/2019', 'June 2019', '2019', 'sometime', '--']
  for (const raw of cases) {
    const d = parseResumeDate(raw)
    assert.equal(d.kind, 'unparsed', raw)
    if (d.kind !== 'unparsed') continue
    assert.equal(d.raw, raw, 'raw text survives exactly')
  }
})

test('impossible calendar dates are unparsed, not silently rolled over', () => {
  // `new Date('2024-02-30')` in V1 would roll to March 1. Nothing here does.
  for (const raw of ['2024-02-30', '2023-13-01', '2024-00-10', '2024-06-31', '2019-04-31']) {
    const d = parseResumeDate(raw)
    assert.equal(d.kind, 'unparsed', raw)
    if (d.kind === 'unparsed') assert.equal(d.raw, raw)
  }
})

test('leap day is real in a leap year and not otherwise', () => {
  assert.equal(parseResumeDate('2024-02-29').kind, 'exact')
  assert.equal(parseResumeDate('2023-02-29').kind, 'unparsed')
})

test('no parse can ever produce an Invalid Date or NaN', () => {
  const inputs = ['', 'garbage', '2024-02-30', '2019-06', undefined, null, '2019-06-15']
  for (const input of inputs) {
    const d = parseResumeDate(input)
    if (d.kind === 'exact') {
      assert.ok(Number.isInteger(d.year) && Number.isInteger(d.month))
      assert.ok(d.day === null || Number.isInteger(d.day))
    }
    assert.ok(!('getTime' in (d as object)), 'never a Date object')
  }
})

test('raw text is readable back for showing the applicant what they typed', () => {
  assert.equal(rawDateText(parseResumeDate('Spring 2019')), 'Spring 2019')
  assert.equal(rawDateText(parseResumeDate('2019-06')), '2019-06')
  assert.equal(rawDateText(ABSENT_DATE), '')
})

test('comparison returns null rather than ordering an unusable date', () => {
  const good = parseResumeDate('2020-01')
  assert.equal(compareResumeDates(good, parseResumeDate('bad')), null)
  assert.equal(compareResumeDates(ABSENT_DATE, good), null)
  assert.ok((compareResumeDates(parseResumeDate('2019-01'), good) ?? 0) < 0)
  assert.equal(compareResumeDates(good, good), 0)
  assert.ok((compareResumeDates(parseResumeDate('2020-06'), good) ?? 0) > 0)
})

test('day precision refines the comparison within a month', () => {
  assert.ok((compareResumeDates(parseResumeDate('2020-01-02'), parseResumeDate('2020-01-20')) ?? 0) < 0)
})

// ---------------------------------------------------------------- ranges

test('a current position needs no end date', () => {
  const r = parseResumeDateRange({ start: '2021-03', end: '', isCurrent: true })
  assert.equal(r.isCurrent, true)
  assert.equal(r.end.kind, 'absent')
  assert.equal(rangeOrder(r), 'ok')
})

test('a current position ignores any end date that was left behind', () => {
  const r = parseResumeDateRange({ start: '2021-03', end: '2020-01', isCurrent: true })
  assert.equal(r.end.kind, 'absent', 'not carried forward as a contradiction')
  assert.equal(rangeOrder(r), 'ok')
})

test('end before start is reported, not corrected', () => {
  const r = parseResumeDateRange({ start: '2022-01', end: '2020-01', isCurrent: false })
  assert.equal(rangeOrder(r), 'end-before-start')
  assert.equal(r.start.kind, 'exact', 'both values survive')
  assert.equal(r.end.kind, 'exact')
})

test('an unusable end makes the order indeterminate, not wrong', () => {
  assert.equal(rangeOrder(parseResumeDateRange({ start: '2020-01', end: 'n/a' })), 'indeterminate')
  assert.equal(rangeOrder(parseResumeDateRange({ start: '', end: '2020-01' })), 'indeterminate')
  assert.equal(rangeOrder(parseResumeDateRange({ start: 'x', end: 'y' })), 'indeterminate')
})

test('a current position with no start is indeterminate', () => {
  assert.equal(rangeOrder(parseResumeDateRange({ start: '', isCurrent: true })), 'indeterminate')
})

// -------------------------------------------------------------- duration

test('duration is null whenever it cannot be known — never NaN', () => {
  const asOf = resumeDateFromParts(2026, 9)
  const unknowable = [
    { start: '', end: '2020-01' },
    { start: '2020-01', end: 'Spring 2021' },
    { start: 'n/a', end: 'n/a' },
    { start: '', isCurrent: true },
  ]
  for (const input of unknowable) {
    const months = monthsInRange(parseResumeDateRange(input), asOf)
    assert.equal(months, null, JSON.stringify(input))
    assert.ok(!Number.isNaN(months as unknown as number))
  }
})

test('duration is computed for a complete range', () => {
  const asOf = resumeDateFromParts(2026, 9)
  assert.equal(monthsInRange(parseResumeDateRange({ start: '2020-01', end: '2022-01' }), asOf), 24)
  assert.equal(monthsInRange(parseResumeDateRange({ start: '2020-01', end: '2020-01' }), asOf), 0)
})

test('a current position measures to the supplied asOf, not the clock', () => {
  const r = parseResumeDateRange({ start: '2025-09', isCurrent: true })
  assert.equal(monthsInRange(r, resumeDateFromParts(2026, 9)), 12)
  assert.equal(monthsInRange(r, resumeDateFromParts(2027, 9)), 24, 'deterministic in tests')
})

test('an inverted range yields null rather than a negative duration', () => {
  const asOf = resumeDateFromParts(2026, 9)
  assert.equal(monthsInRange(parseResumeDateRange({ start: '2022-01', end: '2020-01' }), asOf), null)
})

test('resumeDateFromParts rejects impossible parts without throwing', () => {
  assert.equal(resumeDateFromParts(2024, 13).kind, 'unparsed')
  assert.equal(resumeDateFromParts(2024, 2, 30).kind, 'unparsed')
  assert.equal(resumeDateFromParts(2024, 2, 29).kind, 'exact')
})

test('isUsableDate narrows correctly', () => {
  assert.equal(isUsableDate(parseResumeDate('2020-01')), true)
  assert.equal(isUsableDate(parseResumeDate('nope')), false)
  assert.equal(isUsableDate(ABSENT_DATE), false)
})
