import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RESUME_SORTS, dashboardMeta, groupByStatus, lastEditedLabel, nextStatus, pageCountLabel,
  sortForDashboard, sortResumes, statusLabel, statusToggleLabel, strengthLabel, templateLabel,
} from './summary.ts'
import type { ResumeSummary } from './summary.ts'

const NOW = Date.parse('2026-09-10T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const summary = (over: Partial<ResumeSummary> = {}): ResumeSummary => ({
  id: 'a', title: 'Duke', status: 'draft', template: 'classic',
  revision: 1, updatedAt: ago(0), createdAt: ago(0), ...over,
})

// ------------------------------------------------------------- status

test('the two statuses are labelled as the applicant set them', () => {
  assert.equal(statusLabel('draft'), 'Draft')
  assert.equal(statusLabel('complete'), 'Complete')
})

test('the toggle offers the other state', () => {
  assert.equal(statusToggleLabel('draft'), 'Mark as complete')
  assert.equal(statusToggleLabel('complete'), 'Mark as draft')
  assert.equal(nextStatus('draft'), 'complete')
  assert.equal(nextStatus('complete'), 'draft')
})

test('marking complete is reversible', () => {
  assert.equal(nextStatus(nextStatus('draft')), 'draft')
})

// ----------------------------------------------------------- template

test('a template id is shown as a word, not an id', () => {
  assert.equal(templateLabel('classic'), 'Classic')
  assert.equal(templateLabel('two_column'), 'Two column')
  assert.equal(templateLabel('modern-clean'), 'Modern clean')
})

test('a missing template does not render as blank', () => {
  assert.equal(templateLabel(''), 'No template')
})

// -------------------------------------------------------- last edited

test('recent edits are phrased in relative time', () => {
  assert.equal(lastEditedLabel(ago(0), NOW), 'Edited just now')
  assert.equal(lastEditedLabel(ago(30_000), NOW), 'Edited just now')
  assert.equal(lastEditedLabel(ago(60_000), NOW), 'Edited 1 minute ago')
  assert.equal(lastEditedLabel(ago(5 * 60_000), NOW), 'Edited 5 minutes ago')
  assert.equal(lastEditedLabel(ago(60 * 60_000), NOW), 'Edited 1 hour ago')
  assert.equal(lastEditedLabel(ago(3 * 60 * 60_000), NOW), 'Edited 3 hours ago')
  assert.equal(lastEditedLabel(ago(24 * 60 * 60_000), NOW), 'Edited 1 day ago')
})

test('older edits fall back to a date', () => {
  const label = lastEditedLabel(ago(30 * 24 * 60 * 60_000), NOW)
  assert.match(label, /^Edited /)
  assert.doesNotMatch(label, /ago$/)
})

test('a missing or unparseable timestamp never renders as Invalid Date', () => {
  for (const value of [null, undefined, '', 'not a date', 'yesterday']) {
    assert.equal(lastEditedLabel(value, NOW), 'Never edited', String(value))
  }
})

test('a clock skew into the future does not produce negative time', () => {
  const future = new Date(NOW + 60_000).toISOString()
  assert.equal(lastEditedLabel(future, NOW), 'Edited just now')
})

// -------------------------------------------------------------- order

test('the dashboard lists most recently edited first', () => {
  const list = [
    summary({ id: 'old', updatedAt: ago(5 * 24 * 60 * 60_000) }),
    summary({ id: 'new', updatedAt: ago(60_000) }),
    summary({ id: 'mid', updatedAt: ago(60 * 60_000) }),
  ]
  assert.deepEqual(sortForDashboard(list).map((r) => r.id), ['new', 'mid', 'old'])
})

test('sorting does not mutate the caller’s array', () => {
  const list = [summary({ id: 'b', updatedAt: ago(0) }), summary({ id: 'a', updatedAt: ago(1000) })]
  const before = list.map((r) => r.id)
  sortForDashboard(list)
  assert.deepEqual(list.map((r) => r.id), before)
})

test('identical timestamps produce a stable order rather than a flicker', () => {
  const same = ago(1000)
  const list = [summary({ id: 'c', updatedAt: same }), summary({ id: 'a', updatedAt: same }), summary({ id: 'b', updatedAt: same })]
  assert.deepEqual(sortForDashboard(list).map((r) => r.id), ['a', 'b', 'c'])
  assert.deepEqual(sortForDashboard([...list].reverse()).map((r) => r.id), ['a', 'b', 'c'])
})

test('a row with no usable timestamp sorts last instead of disappearing', () => {
  const list = [
    summary({ id: 'broken', updatedAt: 'nonsense' }),
    summary({ id: 'fine', updatedAt: ago(10 * 24 * 60 * 60_000) }),
  ]
  const sorted = sortForDashboard(list)
  assert.equal(sorted.length, 2, 'nothing is dropped')
  assert.equal(sorted[1].id, 'broken')
})

// --------------------------------------------------- the card's metadata line

test('a card describes a resume in one line: template, pages, last edited', () => {
  const resume = summary({ template: 'modern', pages: 2, updatedAt: ago(9 * 60_000) })
  assert.equal(dashboardMeta(resume, NOW).join(' · '), 'Modern · 2 pages · Edited 9 minutes ago')
})

test('a page count nobody measured is left out rather than guessed', () => {
  const line = dashboardMeta(summary({ template: 'compact' }), NOW).join(' · ')
  assert.equal(line, 'Compact · Edited just now')
  assert.equal(/page/.test(line), false, 'a page count was invented')
  for (const absent of [undefined, null, 0, -1, Number.NaN]) {
    assert.equal(pageCountLabel(absent as number), null, String(absent))
  }
  assert.equal(pageCountLabel(1), '1 page')
  assert.equal(pageCountLabel(3), '3 pages')
})

test('a Strength score is shown only when the list carries one', () => {
  assert.equal(strengthLabel(82), 'Strength 82')
  assert.equal(strengthLabel(81.6), 'Strength 82')
  for (const absent of [undefined, null, Number.NaN]) {
    assert.equal(strengthLabel(absent as number), null, String(absent))
  }
})

// ------------------------------------------------------------- sorting

test('the applicant can order by title, and ties keep the last-edited order', () => {
  const list = [
    summary({ id: 'b', title: 'Emory', updatedAt: ago(5000) }),
    summary({ id: 'a', title: 'duke', updatedAt: ago(1000) }),
    summary({ id: 'c', title: 'Duke', updatedAt: ago(10) }),
  ]
  assert.deepEqual(sortResumes(list, 'title').map((r) => r.id), ['c', 'a', 'b'])
  // The default is what the dashboard has always done.
  assert.deepEqual(sortResumes(list).map((r) => r.id), sortForDashboard(list).map((r) => r.id))
  assert.deepEqual(sortResumes(list, 'edited').map((r) => r.id), ['c', 'a', 'b'])
  assert.deepEqual(list.map((r) => r.id), ['b', 'a', 'c'], 'the caller’s array was reordered')
})

test('each sort the dashboard offers is one this module implements', () => {
  assert.deepEqual(RESUME_SORTS.map((option) => option.key), ['edited', 'title'])
  for (const option of RESUME_SORTS) {
    assert.notEqual(option.label, '', option.key)
    assert.equal(sortResumes([summary({})], option.key).length, 1, option.key)
  }
})

test('a group is ordered the way the applicant asked', () => {
  const list = [
    summary({ id: 'z', title: 'Zurich', status: 'draft', updatedAt: ago(10) }),
    summary({ id: 'a', title: 'Alabama', status: 'draft', updatedAt: ago(5000) }),
  ]
  assert.deepEqual(groupByStatus(list, 'title').drafts.map((r) => r.id), ['a', 'z'])
  assert.deepEqual(groupByStatus(list).drafts.map((r) => r.id), ['z', 'a'])
})

// ------------------------------------------------------------ grouping

test('drafts and complete resumes are listed separately', () => {
  const list = [
    summary({ id: 'd1', status: 'draft', updatedAt: ago(1000) }),
    summary({ id: 'c1', status: 'complete', updatedAt: ago(2000) }),
    summary({ id: 'd2', status: 'draft', updatedAt: ago(3000) }),
  ]
  const { drafts, complete } = groupByStatus(list)
  assert.deepEqual(drafts.map((r) => r.id), ['d1', 'd2'])
  assert.deepEqual(complete.map((r) => r.id), ['c1'])
})

test('both groups exist even when one is empty', () => {
  const { drafts, complete } = groupByStatus([])
  assert.deepEqual(drafts, [])
  assert.deepEqual(complete, [])
})

test('every resume appears in exactly one group', () => {
  const list = [
    summary({ id: 'a', status: 'draft' }),
    summary({ id: 'b', status: 'complete' }),
    summary({ id: 'c', status: 'draft' }),
  ]
  const { drafts, complete } = groupByStatus(list)
  assert.equal(drafts.length + complete.length, list.length)
  const ids = new Set([...drafts, ...complete].map((r) => r.id))
  assert.equal(ids.size, list.length)
})

test('an unexpected status is shown as a draft rather than hidden', () => {
  // The check constraint allows only two values, but a row that somehow held a
  // third must still be reachable by the applicant who owns it.
  const list = [summary({ id: 'x', status: 'archived' as never })]
  const { drafts, complete } = groupByStatus(list)
  assert.deepEqual(drafts.map((r) => r.id), ['x'])
  assert.deepEqual(complete, [])
})

test('grouping sorts within each group', () => {
  const list = [
    summary({ id: 'old', status: 'draft', updatedAt: ago(90_000) }),
    summary({ id: 'new', status: 'draft', updatedAt: ago(1000) }),
  ]
  assert.deepEqual(groupByStatus(list).drafts.map((r) => r.id), ['new', 'old'])
})
