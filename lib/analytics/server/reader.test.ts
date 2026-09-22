import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyError, pageAll, type PageFetcher } from './reader.ts'

/**
 * The paging loop is the part of the reader that used to be wrong in the old
 * dashboard, so it is tested by running it rather than by reading it.
 */

/** A fake table of `total` rows that answers range requests like PostgREST. */
function fakeTable(total: number, pageSize = 900): { fetch: PageFetcher<number>; calls: number[][] } {
  const calls: number[][] = []
  return {
    calls,
    fetch: async (from, to) => {
      calls.push([from, to])
      const rows: number[] = []
      for (let index = from; index <= to && index < total; index++) rows.push(index)
      assert.ok(rows.length <= pageSize, 'a page never exceeds the page size')
      return { ok: true, rows }
    },
  }
}

test('a table smaller than one page is read in a single request', async () => {
  const table = fakeTable(42)
  const result = await pageAll(table.fetch)

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.rows.length, 42)
  assert.equal(result.ok && result.truncated, false)
  assert.equal(table.calls.length, 1)
})

test('3,842 rows are all read, not the first 1,000', async () => {
  // The exact number the old page reported as a total.
  const table = fakeTable(3842)
  const result = await pageAll(table.fetch)

  assert.equal(result.ok && result.rows.length, 3842)
  assert.equal(result.ok && result.truncated, false)
  assert.deepEqual(table.calls[0], [0, 899])
  assert.equal(table.calls.length, 5)
})

test('a table that is an exact multiple of the page size is not cut short', async () => {
  const table = fakeTable(1800)
  const result = await pageAll(table.fetch)

  assert.equal(result.ok && result.rows.length, 1800)
  assert.equal(table.calls.length, 3, 'the empty third page is what proves the end')
})

test('rows come back in order, so nothing is skipped or repeated between pages', async () => {
  const table = fakeTable(2500)
  const result = await pageAll(table.fetch)

  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.rows.slice(0, 3), [0, 1, 2])
    assert.equal(new Set(result.rows).size, result.rows.length, 'no duplicates')
    assert.equal(result.rows[result.rows.length - 1], 2499)
  }
})

test('hitting the ceiling is reported, never returned as a smaller total', async () => {
  const table = fakeTable(10_000)
  const result = await pageAll(table.fetch, { maxRows: 1800 })

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.rows.length, 1800)
  assert.equal(result.ok && result.truncated, true, 'the page must be able to say the number is incomplete')
})

test('a failed page fails the whole read rather than returning what it got', async () => {
  let call = 0
  const result = await pageAll<number>(async (from, to) => {
    call++
    if (call === 2) return { ok: false, reason: 'denied', detail: 'permission denied for table gpa_drafts' }
    const rows: number[] = []
    for (let index = from; index <= to; index++) rows.push(index)
    return { ok: true, rows }
  })

  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.reason, 'denied')
  assert.match(!result.ok ? result.detail : '', /permission denied/)
})

test('an empty table reads as empty, not as a failure', async () => {
  const result = await pageAll(fakeTable(0).fetch)

  assert.equal(result.ok, true)
  assert.equal(result.ok && result.rows.length, 0)
})

// --- what a database error means --------------------------------------------

test('a revoked table is denied, which is what tells the page a migration is needed', () => {
  assert.equal(classifyError({ code: '42501', message: 'permission denied for table gpa_drafts' }).reason, 'denied')
})

test('a 403 with an empty body is a denial, which is what the live database actually returns', () => {
  // gpa_drafts answers 403 Forbidden with no code and no message at all. Read
  // from the error alone that looks like an unknown failure, and the page said
  // "Reading gpa_drafts failed:" with nothing after the colon.
  const classified = classifyError({ message: '' }, 403)

  assert.equal(classified.reason, 'denied')
  assert.equal(classified.detail, 'HTTP 403')
})

test('the status wins over an empty error body, and 404 means missing', () => {
  assert.equal(classifyError(null, 401).reason, 'denied')
  assert.equal(classifyError({ message: '' }, 404).reason, 'missing')
})

test('a success status with an error still classifies from the code', () => {
  assert.equal(classifyError({ code: '42P01', message: 'relation does not exist' }, 200).reason, 'missing')
})

test('an absent table or column is missing, not a crash', () => {
  assert.equal(classifyError({ code: '42P01', message: 'relation does not exist' }).reason, 'missing')
  assert.equal(classifyError({ code: '42703', message: 'column does not exist' }).reason, 'missing')
})

test('anything else is a plain failure and keeps its message for the log', () => {
  const classified = classifyError({ code: '08006', message: 'connection failure' })

  assert.equal(classified.reason, 'failed')
  assert.equal(classified.detail, 'connection failure')
  assert.equal(classifyError(null).reason, 'failed')
})

test('a failure with no message says so rather than trailing off', () => {
  assert.equal(classifyError({ message: '' }).detail, 'no error message was returned')
})
