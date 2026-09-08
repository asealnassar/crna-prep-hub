import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  analysisNameFromInstitutions, smartAnalysisName, DEFAULT_NEW_ANALYSIS_NAME,
} from './analyses.ts'

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const PAGE = read('app/gpa-calculator/page.tsx')
const USE_ANALYSES = read('lib/gpa/useAnalyses.ts')

const RUN_IMPORT = PAGE.slice(PAGE.indexOf('const runImport ='), PAGE.indexOf('const saveCalculation'))
const FILL = RUN_IMPORT.slice(RUN_IMPORT.indexOf("// 'fill': the open analysis is empty"))
const NEW_ANALYSIS = FILL.slice(FILL.indexOf('if (!currentId)'), FILL.indexOf('// D36:'))

/** Executable text only, so a comment about a rule is never mistaken for it. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

// ------------------------------------------------ 1, 2: the analysis is made
test('1: a first transcript with no analysis open creates one', () => {
  assert.ok(NEW_ANALYSIS.includes('await createAnalysis('),
    'the null-analysis branch must create an analysis')
  assert.ok(/analysisNameFromInstitutions\(namesIn\(fresh\)\)/.test(NEW_ANALYSIS))
})

test('1: the courses are written by the insert that creates the row', () => {
  // Seeded at creation, exactly as 'separate' does. Not created empty and then
  // filled -- there must be no moment when the analysis exists without them.
  assert.ok(/\{ courses: fresh, policies: DEFAULT_POLICIES \}/.test(NEW_ANALYSIS))
  const create = NEW_ANALYSIS.indexOf('createAnalysis(')
  const setCourses = NEW_ANALYSIS.indexOf('setCourses(')
  assert.ok(create > 0)
  assert.equal(setCourses, -1, 'the branch must not depend on a separate state write')
})

test('2: creating an analysis selects it, so currentId stops being null', () => {
  const fn = USE_ANALYSES.slice(
    USE_ANALYSES.indexOf('const createAnalysis ='), USE_ANALYSES.indexOf('const renameAnalysis ='))
  assert.ok(/selectAnalysis\(created\)/.test(fn))
  assert.ok(/return created/.test(fn))
})

// ------------------------------------------------------- 3: it comes back
test('3: nothing in the branch is scoped to a null analysis id', () => {
  // The defect: every notice, and the import itself, addressed `currentId`
  // while it was null. Now the created analysis's own id is used throughout.
  for (const call of ['finish(fresh.length, created.id)',
                      'scopedTo(created.id, fresh.length)',
                      'setImportNote(scopedTo(created.id']) {
    assert.ok(NEW_ANALYSIS.includes(call), `missing ${call}`)
  }
  // Past the guard that detects it, currentId is never referenced again: the
  // body addresses the analysis it just created and nothing else.
  const body = NEW_ANALYSIS.slice(NEW_ANALYSIS.indexOf('\n'))
  assert.ok(!/currentId/.test(codeOnly(body)),
    'the created-analysis branch must never address currentId')
})

test('3: the persisted seed is what the browser reloads', () => {
  const fn = USE_ANALYSES.slice(
    USE_ANALYSES.indexOf('const createAnalysis ='), USE_ANALYSES.indexOf('const renameAnalysis ='))
  // The insert carries the seed's courses, so the row is complete on the server
  // before the function returns.
  assert.ok(/courses: seed\?\.courses \?\? \[\]/.test(fn))
})

// ------------------------------------------------------------ 4: naming
test('4: the created analysis takes the same name the rename would have given', () => {
  const names = ['NORTH RIVER UNIVERSITY']
  const created = analysisNameFromInstitutions(names)
  const renamed = smartAnalysisName({
    currentName: DEFAULT_NEW_ANALYSIS_NAME, institutionNames: names, otherAnalyses: [],
  })
  assert.equal(created, 'NORTH RIVER UNIVERSITY')
  assert.equal(renamed, created)

  // And the multi-school rule is the same one, so a bundle names identically.
  const two = ['Ridgeview State University', 'Meridian College of Nursing']
  assert.equal(analysisNameFromInstitutions(two), 'Ridgeview + Meridian')
  assert.equal(
    smartAnalysisName({ currentName: 'Untitled Analysis', institutionNames: two, otherAnalyses: [] }),
    'Ridgeview + Meridian')
})

test('4: a transcript naming no school falls back, never to an empty name', () => {
  assert.equal(analysisNameFromInstitutions([]), DEFAULT_NEW_ANALYSIS_NAME)
  assert.equal(analysisNameFromInstitutions(['   ']), DEFAULT_NEW_ANALYSIS_NAME)
})

// -------------------------------------------- 5, 6, 10: nothing else moved
test('5: filling an analysis that DOES exist is unchanged', () => {
  const existing = FILL.slice(FILL.indexOf('// D36:'))
  assert.ok(/const smart = smartAnalysisName\(\{/.test(existing))
  assert.ok(/if \(smart\) await renameAnalysis\(currentId, smart\)/.test(existing))
  assert.ok(/setCourses\(prev => \[\.\.\.prev, \.\.\.fresh\]\)/.test(existing))
  assert.ok(/finish\(fresh\.length, currentId\)/.test(existing))
  // The old `currentId ?` guards are gone only because the branch above now
  // returns first -- currentId is non-null by the time this code runs.
  assert.ok(!/currentId \? smartAnalysisName/.test(existing))
})

test('6: the separate and combine destinations are untouched', () => {
  const separate = RUN_IMPORT.slice(
    RUN_IMPORT.indexOf("if (destination === 'separate')"),
    RUN_IMPORT.indexOf("// 'fill': the open analysis is empty"))
  assert.ok(/analysisNameFromInstitutions\(namesIn\(coursesWithIds\)\)/.test(separate))
  assert.ok(/\{ courses: coursesWithIds, policies: DEFAULT_POLICIES \}/.test(separate))
  const combine = RUN_IMPORT.slice(
    RUN_IMPORT.indexOf("if (destination === 'combine')"),
    RUN_IMPORT.indexOf("if (destination === 'separate')"))
  assert.ok(/planCombineWithNewCourses\(\{/.test(combine))
  assert.ok(/await createAnalysis\(plan\.name, \{/.test(combine))
})

test('10: the manual New Analysis flow is unchanged', () => {
  assert.ok(/if \(kind === 'blank'\) createAnalysis\(\)/.test(PAGE))
  assert.ok(/onChoose=\{kind => \{/.test(PAGE))
})

// ------------------------------------------------- 7: exactly one analysis
test('7: one first import creates exactly one analysis', () => {
  assert.equal((NEW_ANALYSIS.match(/createAnalysis\(/g) ?? []).length, 1)
  // The branch returns, so it can never fall through into the fill path and
  // create or rename a second time.
  assert.ok(/\n\s+return\n\s+\}/.test(NEW_ANALYSIS))
  // Across the whole import there is one creation per destination, never two.
  const perDestination = RUN_IMPORT.match(/await createAnalysis\(/g) ?? []
  assert.equal(perDestination.length, 3, 'combine, separate, and the new first-import path')
})

// ------------------------------------- 8: a failure leaves nothing behind
test('8: a failed import creates no empty analysis', () => {
  // Creation sits inside the `if (parsed)` block, after the analyzer returned
  // coursework -- every failure path throws before reaching it.
  const parsedAt = RUN_IMPORT.indexOf('if (parsed) {')
  const createAt = RUN_IMPORT.indexOf('if (!currentId)')
  assert.ok(parsedAt > 0 && createAt > parsedAt)
  const beforeParsed = RUN_IMPORT.slice(0, parsedAt)
  assert.ok(!/createAnalysis\(/.test(beforeParsed),
    'nothing may be created before the transcript has been read')
  // The catch handler still only records the failure.
  const katch = RUN_IMPORT.slice(RUN_IMPORT.indexOf('} catch (error: any) {'))
  assert.ok(!/createAnalysis\(/.test(katch))
})

// --------------------------------------------------- 9: D60 provenance
test('9: the server-issued transcriptSourceId travels into the new draft', () => {
  // `fresh` is coursesWithIds, which every imported row was stamped on.
  assert.ok(/const fresh = coursesWithIds/.test(FILL))
  assert.ok(/\{ courses: fresh, policies: DEFAULT_POLICIES \}/.test(NEW_ANALYSIS))
  assert.ok(/\n\s+transcriptSourceId,\n/.test(RUN_IMPORT))
  // No filtering or reshaping between the stamp and the insert.
  assert.ok(!/fresh\.map\(/.test(NEW_ANALYSIS))
})
