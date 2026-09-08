import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeAnalysisName, resolveAnalysisName, analysisNameFromInstitutions,
  nameCollides, canCreateAnalysis, nextSelectionAfterDelete, sortAnalyses,
  institutionsStillReferenced, isDefaultAnalysisName, smartAnalysisName,
  MAX_ANALYSES_PER_USER, MAX_COURSES_PER_ANALYSIS,
  DEFAULT_NEW_ANALYSIS_NAME, MIGRATED_ANALYSIS_NAME,
  type GpaAnalysis,
} from './analyses.ts'
import { DEFAULT_POLICIES, type Course, type Institution } from './types.ts'

const A = (id: string, name: string, courses: Course[] = [], updatedAt = '2026-01-01'): GpaAnalysis =>
  ({ id, userId: 'u1', name, courses, policies: { ...DEFAULT_POLICIES }, revision: 1, updatedAt })
const C = (id: string, institutionId: string | null = null): Course => ({
  id, institutionId, courseCode: null, name: 'c' + id, grade: 'A', credits: 3,
  categories: ['general'], categorySource: 'default', level: 'undergraduate',
  levelSource: 'default', recordType: 'coursework', transferredIn: false,
  needsReview: false, reviewReasons: [],
})

// ---------------------------------------------------------------- D34
test('D34: names normalize case, trim and inner whitespace', () => {
  assert.equal(normalizeAnalysisName('Rutgers Transcript'), 'rutgers transcript')
  assert.equal(normalizeAnalysisName('  rutgers transcript  '), 'rutgers transcript')
  assert.equal(normalizeAnalysisName('RUTGERS   TRANSCRIPT'), 'rutgers transcript')
})

test('D34: the three spec variants all collide', () => {
  const existing = [{ name: 'Rutgers Transcript' }]
  for (const v of ['Rutgers Transcript', 'rutgers transcript', '  Rutgers Transcript  ']) {
    assert.equal(nameCollides(v, existing), true, v)
  }
})

test('D34: collision resolution increments deterministically', () => {
  assert.equal(resolveAnalysisName('Rutgers University', []), 'Rutgers University')
  assert.equal(resolveAnalysisName('Rutgers University', [{ name: 'Rutgers University' }]),
    'Rutgers University (2)')
  assert.equal(resolveAnalysisName('Rutgers University',
    [{ name: 'Rutgers University' }, { name: 'Rutgers University (2)' }]),
    'Rutgers University (3)')
})

test('D34: resolution is case-insensitive against existing names', () => {
  assert.equal(resolveAnalysisName('Rutgers', [{ name: 'RUTGERS' }]), 'Rutgers (2)')
})

test('D34: renaming ignores the analysis being renamed', () => {
  const all = [A('1', 'Rutgers'), A('2', 'Bergen')]
  assert.equal(nameCollides('Rutgers', [], '1', all), false, 'its own name is fine')
  assert.equal(nameCollides('Bergen', [], '1', all), true, 'another analysis blocks it')
  assert.equal(nameCollides('BERGEN', [], '1', all), true, 'case-insensitively')
})

// ---------------------------------------------------------------- D35
test('D35: caps are 50 analyses and 500 courses per analysis', () => {
  assert.equal(MAX_ANALYSES_PER_USER, 50)
  assert.equal(MAX_COURSES_PER_ANALYSIS, 500)
})

test('D35: creation blocked at 50, allowed at 49', () => {
  assert.equal(canCreateAnalysis(new Array(49).fill(0)), true)
  assert.equal(canCreateAnalysis(new Array(50).fill(0)), false)
  assert.equal(canCreateAnalysis(new Array(51).fill(0)), false)
})

test('D35: the 500 cap is per analysis, never a global total', () => {
  const a = A('1', 'A', new Array(500).fill(0).map((_, i) => C('a' + i)))
  const b = A('2', 'B', new Array(500).fill(0).map((_, i) => C('b' + i)))
  assert.equal(a.courses.length, MAX_COURSES_PER_ANALYSIS)
  assert.equal(b.courses.length, MAX_COURSES_PER_ANALYSIS)
  assert.equal(a.courses.length + b.courses.length, 1000, 'both may be full simultaneously')
})

// ---------------------------------------------------------------- D36
test('D36: default names', () => {
  assert.equal(DEFAULT_NEW_ANALYSIS_NAME, 'Untitled Analysis')
  assert.equal(MIGRATED_ANALYSIS_NAME, 'My Analysis')
})

test('D36: New Analysis never fails just because the default exists', () => {
  assert.equal(resolveAnalysisName(DEFAULT_NEW_ANALYSIS_NAME, []), 'Untitled Analysis')
  assert.equal(resolveAnalysisName(DEFAULT_NEW_ANALYSIS_NAME,
    [{ name: 'Untitled Analysis' }]), 'Untitled Analysis (2)')
  assert.equal(resolveAnalysisName(DEFAULT_NEW_ANALYSIS_NAME,
    [{ name: 'Untitled Analysis' }, { name: 'Untitled Analysis (2)' }]), 'Untitled Analysis (3)')
})

test('D36: one institution uses its own name', () => {
  assert.equal(analysisNameFromInstitutions(['Rutgers University']), 'Rutgers University')
})

test('D36: two institutions produce a concise combined label', () => {
  assert.equal(
    analysisNameFromInstitutions(['Rutgers University', 'Bergen Community College']),
    'Rutgers + Bergen')
})

test('D36: many institutions never concatenate full legal names', () => {
  const name = analysisNameFromInstitutions([
    'Rutgers University', 'Bergen Community College',
    'Lakeshore Metropolitan University', 'Brookstone Community College',
  ])
  assert.equal(name, 'Rutgers + 3 others')
  assert.ok(name.length < 40, 'stays a usable UI label')
})

test('D36: naming is deterministic and de-duplicates institutions', () => {
  const once = analysisNameFromInstitutions(['Rutgers University', 'Rutgers University'])
  assert.equal(once, 'Rutgers University')
  assert.equal(analysisNameFromInstitutions(['A University', 'B College']),
               analysisNameFromInstitutions(['A University', 'B College']))
})

test('D36: no detected institution falls back to the default name', () => {
  assert.equal(analysisNameFromInstitutions([]), 'Untitled Analysis')
  assert.equal(analysisNameFromInstitutions(['', '   ']), 'Untitled Analysis')
})

test('D36: a generated transcript name feeds through collision resolution', () => {
  const generated = analysisNameFromInstitutions(['Rutgers University'])
  assert.equal(resolveAnalysisName(generated, [{ name: 'Rutgers University' }]),
    'Rutgers University (2)')
})

// ------------------------------------------------- isolation & selection
test('D33: analyses hold independent courses and policies', () => {
  const a: GpaAnalysis = { ...A('1', 'A', [C('x'), C('y')]),
    policies: { transfer: 'exclude', retake: 'both' } }
  const b: GpaAnalysis = { ...A('2', 'B', [C('z')]),
    policies: { transfer: 'include', retake: 'latest' } }
  assert.equal(a.courses.length, 2)
  assert.equal(b.courses.length, 1)
  assert.notDeepEqual(a.policies, b.policies)
  // Editing B must not touch A.
  const bEdited = { ...b, courses: [...b.courses, C('w')] }
  assert.equal(a.courses.length, 2, 'A unchanged')
  assert.equal(bEdited.courses.length, 2)
})

test('D33: revisions are per analysis, never shared', () => {
  const list = [{ ...A('1', 'A'), revision: 7 }, { ...A('2', 'B'), revision: 2 },
                { ...A('3', 'C'), revision: 19 }]
  const updated = list.map(x => x.id === '2' ? { ...x, revision: x.revision + 1 } : x)
  assert.deepEqual(updated.map(x => x.revision), [7, 3, 19])
})

test('D33: deleting selects the most recently updated survivor', () => {
  const all = [A('1', 'A', [], '2026-01-01'), A('2', 'B', [], '2026-03-01'),
               A('3', 'C', [], '2026-02-01')]
  assert.equal(nextSelectionAfterDelete(all, '1'), '2')
  assert.equal(nextSelectionAfterDelete(all, '2'), '3')
  assert.equal(nextSelectionAfterDelete([A('1', 'only')], '1'), null, 'none left')
})

test('switcher orders most recently updated first', () => {
  const all = [A('1', 'old', [], '2026-01-01'), A('2', 'new', [], '2026-05-01')]
  assert.deepEqual(sortAnalyses(all).map(a => a.name), ['new', 'old'])
})

// ------------------------------------------------- shared institutions
test('institutions are user-level and shared across analyses', () => {
  const inst: Institution[] = [
    { id: 'i1', name: 'Rutgers', creditSystem: 'semester' },
    { id: 'i2', name: 'Bergen', creditSystem: 'semester' },
  ]
  const a = A('1', 'A', [C('x', 'i1'), C('y', 'i1')])
  const b = A('2', 'B', [C('z', 'i1')])
  assert.equal(institutionsStillReferenced([a, b], inst).length, 1)
  assert.equal(institutionsStillReferenced([a, b], inst)[0].id, 'i1',
    'both analyses reference the SAME institution row')
})

test('deleting an analysis does not delete institutions', () => {
  const inst: Institution[] = [{ id: 'i1', name: 'Rutgers', creditSystem: 'semester' }]
  const a = A('1', 'A', [C('x', 'i1')])
  const b = A('2', 'B', [C('z', 'i1')])
  const afterDelete = [b]                       // analysis A removed
  assert.equal(inst.length, 1, 'institution row untouched')
  assert.equal(afterDelete[0].courses.length, 1, 'other analysis unaffected')
  assert.equal(institutionsStillReferenced(afterDelete, inst).length, 1)
})

// ------------------------------------------- D36 smart naming after import
const NORTH_RIVER = 'North River University'

test('D36: a default-named analysis takes the transcript institution name', () => {
  assert.equal(smartAnalysisName({
    currentName: DEFAULT_NEW_ANALYSIS_NAME,
    institutionNames: [NORTH_RIVER],
    otherAnalyses: [],
  }), NORTH_RIVER)
})

test('D36: Student A — one institution, 34 courses, one name', () => {
  // The real UAT case: the transcript names one school, and every imported row
  // resolves to it, so the analysis stops being called "Untitled Analysis".
  const institutionNames = Array.from({ length: 34 }, () => NORTH_RIVER)
  assert.equal(smartAnalysisName({
    currentName: 'Untitled Analysis', institutionNames, otherAnalyses: [],
  }), NORTH_RIVER, 'repeated rows of the same school are one name, not 34')
})

test('D36: a blank name is a default name too', () => {
  for (const name of ['', '   ', null, undefined]) {
    assert.equal(isDefaultAnalysisName(name), true, String(name))
    assert.equal(smartAnalysisName({
      currentName: name, institutionNames: [NORTH_RIVER], otherAnalyses: [],
    }), NORTH_RIVER)
  }
})

test('D36: the auto-numbered default name is still a default name', () => {
  assert.equal(isDefaultAnalysisName('Untitled Analysis (2)'), true)
  assert.equal(isDefaultAnalysisName('untitled analysis (17)'), true)
  assert.equal(smartAnalysisName({
    currentName: 'Untitled Analysis (3)', institutionNames: [NORTH_RIVER], otherAnalyses: [],
  }), NORTH_RIVER)
})

test('D36: D34 uniqueness applies, and no existing analysis is overwritten', () => {
  const existing = [{ name: NORTH_RIVER }]
  assert.equal(smartAnalysisName({
    currentName: DEFAULT_NEW_ANALYSIS_NAME, institutionNames: [NORTH_RIVER], otherAnalyses: existing,
  }), `${NORTH_RIVER} (2)`)
  assert.equal(smartAnalysisName({
    currentName: DEFAULT_NEW_ANALYSIS_NAME, institutionNames: [NORTH_RIVER],
    otherAnalyses: [...existing, { name: `${NORTH_RIVER} (2)` }],
  }), `${NORTH_RIVER} (3)`)
  assert.deepEqual(existing, [{ name: NORTH_RIVER }], 'the other analysis keeps its name')
})

test('D36: a name the user typed is never overwritten', () => {
  for (const chosen of ['Fall CRNA Application GPA', 'My Analysis', 'untitled', 'Rutgers']) {
    assert.equal(isDefaultAnalysisName(chosen), false, chosen)
    assert.equal(smartAnalysisName({
      currentName: chosen, institutionNames: [NORTH_RIVER], otherAnalyses: [],
    }), null, chosen)
  }
})

test('D36: nothing to name from means nothing is renamed', () => {
  assert.equal(smartAnalysisName({
    currentName: DEFAULT_NEW_ANALYSIS_NAME, institutionNames: [], otherAnalyses: [],
  }), null, 'coursework with no school assigned names nothing')
  assert.equal(smartAnalysisName({
    currentName: DEFAULT_NEW_ANALYSIS_NAME, institutionNames: ['', '   '], otherAnalyses: [],
  }), null)
})

test('D36: the analysis is not renamed to what it is already called', () => {
  assert.equal(smartAnalysisName({
    currentName: NORTH_RIVER, institutionNames: [NORTH_RIVER], otherAnalyses: [],
  }), null, 'and this one was the user’s name anyway')
})

test('D36: several institutions use the existing combined-name convention', () => {
  assert.equal(smartAnalysisName({
    currentName: DEFAULT_NEW_ANALYSIS_NAME,
    institutionNames: ['Rutgers University', 'Montclair State University'],
    otherAnalyses: [],
  }), 'Rutgers + Montclair')
  assert.equal(smartAnalysisName({
    currentName: DEFAULT_NEW_ANALYSIS_NAME,
    institutionNames: ['Rutgers University', 'Montclair State University', 'Hudson County College'],
    otherAnalyses: [],
  }), 'Rutgers + 2 others')
  // Exactly what the shared helper produces, so naming stays in one place.
  assert.equal(
    smartAnalysisName({ currentName: '', institutionNames: [NORTH_RIVER], otherAnalyses: [] }),
    analysisNameFromInstitutions([NORTH_RIVER]))
})

test('D36: smart naming is pure, so it cannot cost an analyzer call', () => {
  const before = { currentName: DEFAULT_NEW_ANALYSIS_NAME, institutionNames: [NORTH_RIVER], otherAnalyses: [] }
  const snapshot = JSON.stringify(before)
  const out = smartAnalysisName(before)
  assert.equal(typeof out, 'string')
  assert.ok(!(out instanceof Promise), 'nothing is awaited, so nothing is fetched')
  assert.equal(JSON.stringify(before), snapshot, 'its inputs are untouched')
})

test('D36: the migration placeholder is left alone', () => {
  // "My Analysis" was assigned once during the V1 migration and is what those
  // users have called their work ever since. It is not ours to rename.
  assert.equal(isDefaultAnalysisName(MIGRATED_ANALYSIS_NAME), false)
})
