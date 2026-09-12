import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dryRun, formatReport, inventedStrings } from './report.ts'
import type { DryRunReport } from './report.ts'
import { duplicateSectionRow, v1Fixtures, RESUME_COUNT, TOTAL_POSITIONS } from './fixtures.ts'
import { mapV1Resume, migratedIndex } from './mapV1.ts'

/**
 * The dry run is the gate. Nothing runs for real until every check passes, so
 * these tests are as much about the checks failing correctly as about them
 * passing.
 */

const NOW = '2026-09-11T09:00:00.000Z'
const idFor = (v1: string, i: number) => `${v1}-m${i}`

function run(over: Parameters<typeof v1Fixtures>[0] = {}, existingV2 = []): DryRunReport {
  const fixture = v1Fixtures(over)
  return dryRun({ ...fixture, existingV2, now: NOW, idFor })
}

const named = (report: DryRunReport, name: string) => report.checks.find((c) => c.name === name)!

// ------------------------------------------------------- the happy run

test('the known distribution migrates cleanly and passes every check', () => {
  const report = run()
  const failed = report.checks.filter((c) => !c.passed)
  assert.deepEqual(failed.map((c) => `${c.name}: ${c.detail}`), [], 'a check failed')
  assert.equal(report.passed, true)
})

test('every source resume is accounted for', () => {
  const report = run()
  assert.equal(report.source.resumes, RESUME_COUNT)
  assert.equal(report.resumes.length, RESUME_COUNT)
  assert.equal(report.outcome.mapped + report.outcome.needsReview + report.outcome.alreadyMigrated, RESUME_COUNT)
  assert.equal(named(report, 'every-source-resume-accounted-for').passed, true)
})

test('41 critical-care positions stay 41', () => {
  const report = run()
  assert.equal(report.source.positions, TOTAL_POSITIONS)
  assert.equal(report.source.positions, 41)
  assert.equal(report.produced.positions, 41)
  assert.equal(named(report, 'positions-preserved').passed, true)
})

test('every blank legacy bullet produces zero V2 bullets', () => {
  const report = run()
  assert.equal(report.produced.bullets, 0, 'a bullet was invented from [""]')
  assert.equal(report.notes.blankBulletsDropped, 41, 'the dropped blanks were not all reported')
  assert.equal(named(report, 'blank-bullets-produce-no-bullets').passed, true)
})

test('nothing is invented', () => {
  const report = run()
  assert.equal(named(report, 'zero-invented-strings').passed, true, named(report, 'zero-invented-strings').detail)
})

test('no source record is modified', () => {
  const fixture = v1Fixtures()
  const before = JSON.stringify(fixture)
  const report = dryRun({ ...fixture, now: NOW, idFor })
  assert.equal(JSON.stringify(fixture), before, 'the dry run wrote to its input')
  assert.equal(named(report, 'zero-source-records-modified').passed, true)
})

test('malformed dates are preserved, and counted', () => {
  const report = run()
  assert.ok(report.notes.unparsedDates > 0, 'the fixture has unparseable dates and none were noticed')
  assert.equal(named(report, 'malformed-dates-preserved').passed, true)
})

test('migrated GPA values are visible', () => {
  const report = run()
  assert.equal(named(report, 'migrated-gpa-visible').passed, true)
})

test('the template mapping matches the locked table', () => {
  const report = run()
  const check = named(report, 'template-mapping-locked')
  assert.equal(check.passed, true, check.detail)
})

test('unknown keys are reported', () => {
  const report = run()
  assert.ok(report.notes.unmappedKeys > 0, 'volunteer_work was not reported')
  assert.ok(report.notes.unmappedValues >= 13, 'the 13 other-degree GPAs were not all reported')
  assert.equal(named(report, 'unknown-keys-reported').passed, true)
})

test('AuthoredText provenance is correct throughout', () => {
  const report = run()
  assert.equal(named(report, 'authored-text-provenance').passed, true)
})

test('every legacy section is accounted for', () => {
  const report = run()
  assert.equal(named(report, 'every-legacy-section-accounted-for').passed, true)
  assert.equal(report.source.sections, RESUME_COUNT * 7)
})

// ----------------------------------------------------- duplicates

test('a duplicate legacy section row blocks the run', () => {
  const target = v1Fixtures().resumes[0].id
  const report = run({ extraSections: [duplicateSectionRow(target, 'education')] })
  assert.equal(report.outcome.needsReview, 1)
  assert.equal(report.outcome.mapped, RESUME_COUNT - 1)
  const entry = report.resumes.find((r) => r.v1ResumeId === target)!
  assert.equal(entry.outcome, 'needs-review')
  assert.ok(entry.reviewReasons[0].includes('ambiguous'))
  assert.equal(named(report, 'duplicates-need-review').passed, true)
  // And the resume produced nothing.
  assert.equal(entry.sectionsOut, 0)
})

test('a duplicate reduces the produced count rather than being merged away', () => {
  const target = v1Fixtures().resumes[16].id // the ten-position resume
  const report = run({ extraSections: [duplicateSectionRow(target, 'education')] })
  assert.equal(report.produced.positions, 41 - 10, 'a reviewed resume still produced output')
  assert.equal(named(report, 'positions-preserved').passed, true, 'the count check ignored the review')
})

// ------------------------------------------------- the checks can fail

test('an invented value fails the run', () => {
  // Proving the strongest check is not vacuous.
  const fixture = v1Fixtures()
  const row = fixture.resumes[0]
  const sections = fixture.sections.filter((s) => s.resume_id === row.id)
  const out = mapV1Resume(row, sections, {
    newResumeId: 'x', idPool: Array.from({ length: 400 }, (_, i) => `x${i}`), now: NOW,
  })
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return

  const tampered = {
    ...out.resume,
    contact: { ...out.resume.contact, fullName: 'Somebody Who Was Never In The Source' },
  }
  const invented = inventedStrings(tampered, row, sections)
  assert.ok(invented.includes('Somebody Who Was Never In The Source'))
  assert.deepEqual(inventedStrings(out.resume, row, sections), [], 'the clean mapping reported inventions')
})

test('an unknown template is reported without failing the locked-table check', () => {
  const report = run({ templates: { 5: 'executive' } })
  assert.equal(named(report, 'template-mapping-locked').passed, true)
  const entry = report.resumes.find((r) => r.outcome === 'mapped' && r.notes.some((n) => n.kind === 'unknown-template'))
  assert.ok(entry, 'an unrecognised template slipped through unreported')
})

// ------------------------------------------------------- idempotency

test('a second run over already-migrated resumes creates nothing', () => {
  const first = run()
  const produced = first.resumes
    .filter((r) => r.outcome === 'mapped')
    .map((r) => {
      const fixture = v1Fixtures()
      const row = fixture.resumes.find((x) => x.id === r.v1ResumeId)!
      const out = mapV1Resume(row, fixture.sections.filter((s) => s.resume_id === row.id), {
        newResumeId: idFor(row.id, 0),
        idPool: Array.from({ length: 400 }, (_, i) => idFor(row.id, i + 1)),
        now: NOW,
      })
      return out.kind === 'mapped' ? out.resume : null
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  const second = run({}, produced as never)
  assert.equal(second.outcome.alreadyMigrated, RESUME_COUNT)
  assert.equal(second.outcome.mapped, 0)
  assert.equal(second.produced.resumes, 0, 'a second run would duplicate every resume')
  assert.equal(second.passed, true)
  assert.equal(migratedIndex(produced).size, RESUME_COUNT)
})

// ------------------------------------------------------------ report

test('the report says what happened, in full', () => {
  const report = run()
  assert.equal(report.resumes.length, RESUME_COUNT)
  for (const entry of report.resumes) {
    assert.notEqual(entry.v1ResumeId, '')
    assert.ok(['mapped', 'needs-review', 'already-migrated'].includes(entry.outcome))
  }
  const text = formatReport(report)
  assert.match(text, /17 resumes, 119 sections, 41 positions/)
  assert.match(text, /PASS\s+zero-invented-strings/)
  assert.equal(text.includes('FAIL'), false)
})

test('a blocked run says so at the top', () => {
  const target = v1Fixtures().resumes[0].id
  const report = run({ extraSections: [duplicateSectionRow(target, 'personal')] })
  const text = formatReport(report)
  assert.match(text, /NEEDS REVIEW/)
  assert.ok(text.includes(target))
})

test('the run is deterministic', () => {
  assert.deepEqual(run(), run())
})
