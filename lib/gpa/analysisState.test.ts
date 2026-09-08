import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnalysisBook } from './analysisState.ts'
import type { DraftSnapshot } from './merge.ts'
import { DEFAULT_POLICIES, type Course } from './types.ts'

const C = (id: string): Course => ({
  id, institutionId: null, courseCode: null, name: 'c' + id, grade: 'A', credits: 3,
  categories: ['general'], categorySource: 'default', level: 'undergraduate',
  levelSource: 'default', recordType: 'coursework', transferredIn: false,
  needsReview: false, reviewReasons: [],
})
const snap = (ids: string[]): DraftSnapshot => ({ courses: ids.map(C), policies: { ...DEFAULT_POLICIES } })

test('state is keyed per analysis, never global', () => {
  const b = new AnalysisBook()
  b.select('A', snap(['a1']), 7)
  b.select('B', snap(['b1']), 2)
  assert.equal(b.revisionOf('A'), 7)
  assert.equal(b.revisionOf('B'), 2)
  b.completeSave('B', snap(['b1', 'b2']))
  assert.equal(b.revisionOf('A'), 7, 'A untouched by B')
  assert.equal(b.revisionOf('B'), 3)
})

test('RAPID SWITCH: a save started on A lands on A after switching to B', () => {
  const b = new AnalysisBook()
  b.select('A', snap(['a1']), 5)
  const aPayload = snap(['a1', 'a2'])       // user edits A
  b.select('B', snap(['b1']), 9)            // switches before the debounce fires
  b.completeSave('A', aPayload)             // A's save completes against A
  assert.equal(b.revisionOf('A'), 6, 'A advanced')
  assert.equal(b.revisionOf('B'), 9, 'B revision untouched')
  assert.deepEqual(b.baseOf('B').courses.map(c => c.id), ['b1'], 'B content untouched')
  assert.deepEqual(b.baseOf('A').courses.map(c => c.id), ['a1', 'a2'], 'A got A\'s edit')
})

test('IN-FLIGHT: A\'s late response cannot repaint B', () => {
  const b = new AnalysisBook()
  b.select('A', snap(['a1']), 5)
  b.slot('A').inFlight = true
  b.select('B', snap(['b1']), 9)            // switch while A is in flight
  // A's response arrives now:
  assert.equal(b.applyUi('A', 'saved'), false, 'A may not touch the UI')
  b.completeSave('A', snap(['a1', 'a2']))   // bookkeeping still lands on A
  assert.equal(b.revisionOf('A'), 6)
  assert.equal(b.revisionOf('B'), 9, 'B revision unchanged')
  assert.deepEqual(b.baseOf('B').courses.map(c => c.id), ['b1'], 'B baseline unchanged')
  assert.deepEqual(b.applied, [], 'no UI effect applied at all')
})

test('the viewed analysis DOES drive visible state', () => {
  const b = new AnalysisBook()
  b.select('A', snap(['a1']), 1)
  assert.equal(b.applyUi('A', 'saving'), true)
  assert.equal(b.applyUi('A', 'saved'), true)
  assert.deepEqual(b.applied.map(x => x.kind), ['saving', 'saved'])
})

test('D25: selecting an analysis records the baseline and schedules no write', () => {
  const b = new AnalysisBook()
  const a = snap(['a1', 'a2'])
  b.select('A', a, 4)
  assert.deepEqual(b.baseOf('A'), a, 'baseline equals loaded content')
  assert.equal(b.revisionOf('A'), 4, 'hydration does not advance revision')
})

test('D25: A -> B -> A with no edits leaves both revisions untouched', () => {
  const b = new AnalysisBook()
  b.select('A', snap(['a1']), 7)
  b.select('B', snap(['b1']), 2)
  b.select('A', snap(['a1']), 7)
  assert.equal(b.revisionOf('A'), 7)
  assert.equal(b.revisionOf('B'), 2)
})

test('conflict identity is per analysis: same revision number is not a conflict', () => {
  const b = new AnalysisBook()
  b.select('A', snap(['a1']), 3)
  b.select('B', snap(['b1']), 3)   // same number, different analyses
  b.completeSave('A', snap(['a1', 'a2']))
  assert.equal(b.revisionOf('A'), 4)
  assert.equal(b.revisionOf('B'), 3, 'B is not implicated by A advancing')
})

test('deleting an analysis forgets only its slot', () => {
  const b = new AnalysisBook()
  b.select('A', snap(['a1']), 7)
  b.select('B', snap(['b1']), 2)
  b.forget('B')
  assert.equal(b.revisionOf('A'), 7, 'A intact')
  assert.equal(b.revisionOf('B'), 0, 'B slot gone (fresh)')
})

test('queued follow-up writes stay on their own analysis', () => {
  const b = new AnalysisBook()
  b.select('A', snap(['a1']), 1)
  const s = b.slot('A')
  s.inFlight = true
  s.pending = snap(['a1', 'a2'])
  b.select('B', snap(['b1']), 1)
  // A's in-flight completes, then drains its own queue:
  b.completeSave('A', s.pending!)
  assert.deepEqual(b.baseOf('A').courses.map(c => c.id), ['a1', 'a2'])
  assert.deepEqual(b.baseOf('B').courses.map(c => c.id), ['b1'], 'B never received A\'s queued payload')
})
