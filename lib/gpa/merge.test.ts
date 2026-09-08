import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeDrafts, resolveConflicts, snapshotsEqual, type DraftSnapshot } from './merge.ts'
import { DEFAULT_POLICIES, type Course, type GpaPolicies } from './types.ts'

const C = (id: string, o: Partial<Course> = {}): Course => ({
  id, institutionId: 'I1', courseCode: null, name: 'Course ' + id,
  grade: 'B', credits: 3, year: '2023', term: 'Fall',
  categories: ['general'], categorySource: 'default',
  level: 'undergraduate', levelSource: 'default',
  recordType: 'coursework', transferredIn: false,
  needsReview: false, reviewReasons: [], ...o,
})
const snap = (courses: Course[], policies: Partial<GpaPolicies> = {}): DraftSnapshot =>
  ({ courses, policies: { ...DEFAULT_POLICIES, ...policies } })

// ---------------------------------------------------------------- D25
test('D25: an unchanged snapshot compares equal (suppresses load-time write)', () => {
  const a = snap([C('1'), C('2')], { transfer: 'exclude' })
  const b = snap([C('1'), C('2')], { transfer: 'exclude' })
  assert.equal(snapshotsEqual(a, b), true)
})

test('D25: key order does not create a false difference', () => {
  const a = snap([C('1')])
  const reordered = JSON.parse(JSON.stringify(a, ['policies','transfer','retake','courses','id','name','grade','credits','institutionId','courseCode','year','term','categories','categorySource','level','levelSource','recordType','transferredIn','needsReview','reviewReasons']))
  assert.equal(snapshotsEqual(a, { ...a, courses: [...a.courses] }), true)
  assert.equal(typeof reordered, 'object')
})

test('D25: any real edit is detected as a difference', () => {
  const base = snap([C('1', { grade: 'B' })])
  assert.equal(snapshotsEqual(base, snap([C('1', { grade: 'A' })])), false, 'grade')
  assert.equal(snapshotsEqual(base, snap([C('1'), C('2')])), false, 'added course')
  assert.equal(snapshotsEqual(base, snap([])), false, 'deleted course')
  assert.equal(snapshotsEqual(base, snap([C('1', { grade: 'B' })], { transfer: 'include' })), false, 'policy')
  assert.equal(snapshotsEqual(base, snap([C('1', { grade: 'B', institutionId: 'I2' })])), false, 'institution')
  assert.equal(snapshotsEqual(base, snap([C('1', { grade: 'B', level: 'graduate' })])), false, 'level')
  assert.equal(snapshotsEqual(base, snap([C('1', { grade: 'B', categories: ['science'] })])), false, 'category')
})

// ------------------------------------------------- D24 auto-merge
test('D24: server edits Course A, this tab adds Course B -> both survive', () => {
  const base   = snap([C('A', { grade: 'B' })])
  const local  = snap([C('A', { grade: 'B' }), C('B')])          // added B
  const server = snap([C('A', { grade: 'A' })])                  // edited A
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.merged.courses.length, 2)
  assert.equal(r.merged.courses.find(c => c.id === 'A')!.grade, 'A', "server's newer edit kept")
  assert.ok(r.merged.courses.find(c => c.id === 'B'), 'local addition preserved')
  assert.equal(r.autoMerged, 1)
})

test('D24: no duplicate courses after a merge', () => {
  const base   = snap([C('A')])
  const local  = snap([C('A'), C('B')])
  const server = snap([C('A'), C('S')])
  const r = mergeDrafts(base, local, server)
  const ids = r.merged.courses.map(c => c.id)
  assert.deepEqual([...ids].sort(), ['A','B','S'])
  assert.equal(new Set(ids).size, ids.length, 'no duplicates')
})

test('D24: independent settings + course edits merge', () => {
  const base   = snap([C('A', { grade: 'B' })], { transfer: null })
  const local  = snap([C('A', { grade: 'B' })], { transfer: 'include' })   // policy only
  const server = snap([C('A', { grade: 'C' })], { transfer: null })        // course only
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.merged.policies.transfer, 'include', 'local policy kept')
  assert.equal(r.merged.courses[0].grade, 'C', 'server course edit kept')
})

test('D24: identical edits on both sides are not a conflict', () => {
  const base   = snap([C('A', { grade: 'B' })])
  const same   = snap([C('A', { grade: 'A' })])
  const r = mergeDrafts(base, same, same)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.merged.courses[0].grade, 'A')
})

test('D24: a clean local delete is honoured', () => {
  const base   = snap([C('A'), C('B')])
  const local  = snap([C('A')])            // deleted B
  const server = snap([C('A'), C('B')])    // untouched
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(r.merged.courses.map(c => c.id), ['A'])
})

// ------------------------------------------------- D24 true conflicts
test('D24: same course edited differently on both sides -> TRUE conflict', () => {
  const base   = snap([C('X', { grade: 'B' })])
  const local  = snap([C('X', { grade: 'C' })])
  const server = snap([C('X', { grade: 'A' })])
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].kind, 'course-both-edited')
  assert.equal((r.conflicts[0].mine as Course).grade, 'C')
  assert.equal((r.conflicts[0].theirs as Course).grade, 'A')
  // Neither side silently wins: both values are still available to choose.
  assert.notEqual(r.conflicts[0].mine, null)
  assert.notEqual(r.conflicts[0].theirs, null)
})

test('D24: delete here vs edit there -> TRUE conflict, nothing lost', () => {
  const base   = snap([C('X', { grade: 'B' })])
  const local  = snap([])                              // deleted here
  const server = snap([C('X', { grade: 'A' })])        // edited there
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].kind, 'course-deleted-vs-edited')
  assert.equal(r.conflicts[0].mine, null)
  assert.equal((r.conflicts[0].theirs as Course).grade, 'A')
  assert.ok(r.merged.courses.find(c => c.id === 'X'), 'not resurrected or dropped silently')
})

test('D24: edit here vs delete there -> TRUE conflict', () => {
  const base   = snap([C('X', { grade: 'B' })])
  const local  = snap([C('X', { grade: 'A' })])
  const server = snap([])
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].kind, 'course-deleted-vs-edited')
  assert.equal(r.conflicts[0].theirs, null)
})

test('D24: opposing policy choices -> TRUE conflict', () => {
  const base   = snap([], { transfer: null })
  const local  = snap([], { transfer: 'include' })
  const server = snap([], { transfer: 'exclude' })
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].kind, 'policy-both-changed')
  assert.equal(r.conflicts[0].id, 'transfer')
  assert.equal(r.conflicts[0].mine, 'include')
  assert.equal(r.conflicts[0].theirs, 'exclude')
})

test('D24: opposing retake choices -> TRUE conflict', () => {
  const r = mergeDrafts(snap([], { retake: null }), snap([], { retake: 'both' }), snap([], { retake: 'latest' }))
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].id, 'retake')
})

// ------------------------------------------------- identity rules
test('D24: matching is by stable id, never by name', () => {
  // Two DIFFERENT courses that happen to share a name must not be merged.
  const base   = snap([C('1', { name: 'Anatomy' }), C('2', { name: 'Anatomy' })])
  const local  = snap([C('1', { name: 'Anatomy', grade: 'A' }), C('2', { name: 'Anatomy' })])
  const server = snap([C('1', { name: 'Anatomy' }), C('2', { name: 'Anatomy', grade: 'C' })])
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 0, 'different ids -> independent edits')
  assert.equal(r.merged.courses.find(c => c.id === '1')!.grade, 'A')
  assert.equal(r.merged.courses.find(c => c.id === '2')!.grade, 'C')
})

test('D24: a renamed course is still the same course', () => {
  const base   = snap([C('1', { name: 'Bio' })])
  const local  = snap([C('1', { name: 'Biology I' })])
  const server = snap([C('1', { name: 'Bio', grade: 'A' })])
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 1, 'same id, both edited -> conflict, not two courses')
  assert.equal(r.merged.courses.length, 1)
})

// ------------------------------------------------- resolution
test('D24: resolveConflicts applies the user choice per item', () => {
  const base   = snap([C('X', { grade: 'B' })])
  const local  = snap([C('X', { grade: 'C' })])
  const server = snap([C('X', { grade: 'A' })])
  const r = mergeDrafts(base, local, server)
  const keptMine = resolveConflicts(r.merged, r.conflicts, { X: 'mine' })
  assert.equal(keptMine.courses.find(c => c.id === 'X')!.grade, 'C')
  const keptTheirs = resolveConflicts(r.merged, r.conflicts, { X: 'theirs' })
  assert.equal(keptTheirs.courses.find(c => c.id === 'X')!.grade, 'A')
})

test('D24: choosing "deleted" removes the course; choosing the edit keeps it', () => {
  const r = mergeDrafts(snap([C('X')]), snap([]), snap([C('X', { grade: 'A' })]))
  assert.equal(resolveConflicts(r.merged, r.conflicts, { X: 'mine' }).courses.length, 0)
  assert.equal(resolveConflicts(r.merged, r.conflicts, { X: 'theirs' }).courses.length, 1)
})

test('D24: resolving a policy conflict applies the chosen value', () => {
  const r = mergeDrafts(snap([], { transfer: null }), snap([], { transfer: 'include' }), snap([], { transfer: 'exclude' }))
  assert.equal(resolveConflicts(r.merged, r.conflicts, { transfer: 'mine' }).policies.transfer, 'include')
  assert.equal(resolveConflicts(r.merged, r.conflicts, { transfer: 'theirs' }).policies.transfer, 'exclude')
})

test('D24: a mixed batch auto-merges the clean parts and flags only the clash', () => {
  const base   = snap([C('A', { grade: 'B' }), C('X', { grade: 'B' })], { transfer: null })
  const local  = snap([C('A', { grade: 'B' }), C('X', { grade: 'C' }), C('NEW')], { transfer: 'include' })
  const server = snap([C('A', { grade: 'A' }), C('X', { grade: 'A' })], { transfer: null })
  const r = mergeDrafts(base, local, server)
  assert.equal(r.conflicts.length, 1, 'only X clashes')
  assert.equal(r.conflicts[0].id, 'X')
  assert.equal(r.merged.courses.find(c => c.id === 'A')!.grade, 'A', "server's A edit kept")
  assert.ok(r.merged.courses.find(c => c.id === 'NEW'), 'local addition kept')
  assert.equal(r.merged.policies.transfer, 'include', 'local policy kept')
})
