import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEMPLATE_MAP, mapTemplate, mapV1Resume, migratedIndex, migrationMarker, migrationReference,
} from './mapV1.ts'
import type { V1ResumeRow, V1SectionRow } from './mapV1.ts'
import { duplicateSectionRow, v1Fixtures } from './fixtures.ts'
import { planDocument, textOf } from '../document/plan.ts'
import { authoredTextsIn } from '../model/sections.ts'
import { canRestoreOriginal, canRestoreUserText } from '../ai/proposalFlow.ts'
import type { ResumeV2 } from '../model/types.ts'

/**
 * The mapper, rule by locked rule.
 */

const NOW = '2026-09-11T09:00:00.000Z'
const ids = (v1: string, i: number) => `${v1}-m${i}`
const ctx = (v1: string, already?: ReadonlyMap<string, string>) => ({
  newResumeId: ids(v1, 0),
  idPool: Array.from({ length: 400 }, (_, i) => ids(v1, i + 1)),
  now: NOW,
  alreadyMigrated: already,
})

const fixture = v1Fixtures()
const sectionsFor = (id: string) => fixture.sections.filter((s) => s.resume_id === id)
const mapOne = (index: number, already?: ReadonlyMap<string, string>) => {
  const row = fixture.resumes[index]
  return mapV1Resume(row, sectionsFor(row.id), ctx(row.id, already))
}
const mapped = (index: number): ResumeV2 => {
  const out = mapOne(index)
  assert.equal(out.kind, 'mapped', `resume ${index} did not map`)
  return (out as Extract<typeof out, { kind: 'mapped' }>).resume
}

// ------------------------------------------------------------- status

test('every migrated resume enters as a draft', () => {
  for (let i = 0; i < fixture.resumes.length; i++) {
    assert.equal(mapped(i).status, 'draft', `resume ${i}`)
  }
})

test('no legacy signal is allowed to imply complete', () => {
  const published: V1ResumeRow = { ...fixture.resumes[0], is_published: true, overall_score: 98 }
  const out = mapV1Resume(published, sectionsFor(published.id), ctx(published.id))
  assert.equal(out.kind, 'mapped')
  if (out.kind === 'mapped') assert.equal(out.resume.status, 'draft')
})

// ----------------------------------------------------------- templates

test('the template table is exactly the locked one', () => {
  assert.deepEqual(TEMPLATE_MAP, {
    compact: 'compact', modern: 'modern', ats: 'classic',
    professional: 'classic', creative: 'modern',
  })
  for (const [v1, expected] of Object.entries(TEMPLATE_MAP)) {
    assert.equal(mapTemplate(v1).template, expected, v1)
    assert.equal(mapTemplate(v1).note, null, `${v1} was reported as unknown`)
  }
})

test('an unrecognised template falls back AND is reported', () => {
  for (const id of ['', null, undefined, 'executive', 'minimal']) {
    const result = mapTemplate(id as string)
    assert.equal(result.template, 'classic', String(id))
    assert.ok(result.note, `"${id}" fell back silently`)
    assert.equal(result.note!.kind, 'unknown-template')
  }
})

// ----------------------------------------------------------------- GPA

test('a migrated GPA keeps the visibility V1 gave it', () => {
  // V1 always printed it. Migrating it hidden would quietly remove a line from
  // someone's resume.
  const resume = mapped(0)
  const education = resume.sections.find((s) => s.type === 'education')
  assert.ok(education && education.type === 'education')
  if (education?.type !== 'education') return
  const entry = education.entries[0]
  assert.notEqual(entry.overallGpa.raw, '')
  assert.equal(entry.overallGpa.showOnResume, true)
  assert.ok(textOf(planDocument(resume)).join(' ').includes(entry.overallGpa.raw))
})

test('an absent GPA is not invented, and stays hidden', () => {
  const resume = mapped(15) // no overall_gpa in the fixture beyond index 11
  const education = resume.sections.find((s) => s.type === 'education')
  if (education?.type !== 'education') return
  assert.equal(education.entries[0].overallGpa.raw, '')
  assert.equal(education.entries[0].overallGpa.showOnResume, false)
})

test('the raw GPA text is preserved verbatim', () => {
  const resume = mapped(3)
  const education = resume.sections.find((s) => s.type === 'education')
  if (education?.type !== 'education') return
  assert.equal(education.entries[0].overallGpa.raw, '3.53')
})

// ------------------------------------------------------- other degrees

test('other_degrees graduation dates migrate, malformed ones verbatim', () => {
  const resume = mapped(16) // three other degrees
  const education = resume.sections.find((s) => s.type === 'education')
  if (education?.type !== 'education') return
  assert.equal(education.entries.length, 4, 'nursing degree plus three others')
  const unparsed = education.entries.filter((e) => e.graduationDate.kind === 'unparsed')
  assert.ok(unparsed.length > 0, 'a malformed other-degree date was dropped')
  for (const entry of unparsed) {
    assert.notEqual((entry.graduationDate as { raw: string }).raw.trim(), '')
  }
})

/**
 * other_degrees[].gpa -- preserved, not reported away.
 *
 * It used to be a locked refusal: V1 stored the value, rendered it nowhere,
 * and the mapper would not guess which V2 slot it meant. It is the only GPA
 * field V1's other-degree form has, so the slot is not in doubt after all, and
 * eight real values across six production resumes were about to be dropped.
 *
 * The rule now: it becomes that entry's overallGpa, hidden. Hidden is the
 * whole point -- the data is preserved and the rendered document is unchanged
 * from what the applicant had, which is what makes this a migration rather
 * than an edit of somebody's resume.
 */

/** A one-off V1 resume carrying exactly the education section under test. */
function mapEducation(education: Record<string, unknown>) {
  const row = { ...fixture.resumes[0], id: 'gpa-fixture' } as V1ResumeRow
  const sections = [{
    id: 'gpa-fixture-education',
    resume_id: row.id,
    section_type: 'education',
    section_data: education,
    order_index: 1,
  }] as unknown as V1SectionRow[]
  const out = mapV1Resume(row, sections, ctx(row.id))
  assert.equal(out.kind, 'mapped', 'the education fixture did not map')
  const mapping = out as Extract<typeof out, { kind: 'mapped' }>
  const education2 = mapping.resume.sections.find((s) => s.type === 'education')
  assert.ok(education2 && education2.type === 'education', 'no education section')
  return {
    entries: (education2 as Extract<typeof education2, { type: 'education' }>).entries,
    gpaNotes: mapping.notes.filter((n) => n.kind === 'unmapped-value' && n.path.includes('/gpa')),
  }
}

const NURSING = { degree: 'BSN', field: 'Nursing', university: 'State University', graduation_date: '2018-05' }

test('1-3: other_degrees[].gpa becomes that entry overallGpa, parsed and hidden', () => {
  const { entries, gpaNotes } = mapEducation({
    nursing_degree: NURSING,
    other_degrees: [{ degree: 'BA', field: 'Biology', university: 'Other College', gpa: '3.83' }],
  })
  const other = entries[1]
  assert.equal(other.overallGpa.raw, '3.83', 'the GPA did not survive')
  assert.equal(other.overallGpa.value, 3.83, 'the parsed value is wrong')
  assert.equal(other.overallGpa.showOnResume, false, 'it would now render where V1 never did')
  assert.deepEqual(gpaNotes, [], 'it is preserved, so nothing is left to report')
})

test('4: the raw string survives unusual-but-valid text, byte for byte', () => {
  for (const [raw, value] of [
    ['3.084', 3.084], ['4.0', 4], ['3.2', 3.2], ['0.0', 0], ['5', 5],
  ] as const) {
    const { entries } = mapEducation({
      nursing_degree: NURSING,
      other_degrees: [{ degree: 'BA', university: 'Other College', gpa: raw }],
    })
    assert.equal(entries[1].overallGpa.raw, raw, `"${raw}" was rewritten`)
    assert.equal(entries[1].overallGpa.value, value, `"${raw}" parsed wrong`)
  }
})

test('4b: text the parser cannot read is still preserved, with a null value', () => {
  for (const raw of ['3.9/4.0', '3.5 (major)', 'A- average', '12.0']) {
    const { entries } = mapEducation({
      nursing_degree: NURSING,
      other_degrees: [{ degree: 'BA', university: 'Other College', gpa: raw }],
    })
    assert.equal(entries[1].overallGpa.raw, raw, `"${raw}" was altered`)
    assert.equal(entries[1].overallGpa.value, null, `"${raw}" was guessed into a number`)
    assert.equal(entries[1].overallGpa.showOnResume, false)
  }
})

test('5: it never populates scienceGpa', () => {
  const { entries } = mapEducation({
    nursing_degree: NURSING,
    other_degrees: [{ degree: 'BA', university: 'Other College', gpa: '3.83' }],
  })
  assert.equal(entries[1].scienceGpa.raw, '', 'the legacy GPA landed in the science slot')
  assert.equal(entries[1].scienceGpa.value, null)
})

test('6: a real overall_gpa is never overwritten by the legacy field', () => {
  const { entries } = mapEducation({
    nursing_degree: NURSING,
    other_degrees: [{ degree: 'BA', university: 'Other College', overall_gpa: '3.50', gpa: '3.83' }],
  })
  assert.equal(entries[1].overallGpa.raw, '3.50', 'the legacy gpa overwrote a real overall_gpa')
  assert.equal(entries[1].overallGpa.value, 3.5)
  // overall_gpa is what V1 rendered, so it keeps the visibility it had.
  assert.equal(entries[1].overallGpa.showOnResume, true)
})

test('7: two populated legacy GPA fields are surfaced, not silently resolved', () => {
  const { gpaNotes } = mapEducation({
    nursing_degree: NURSING,
    other_degrees: [{ degree: 'BA', university: 'Other College', overall_gpa: '3.50', gpa: '3.83' }],
  })
  assert.equal(gpaNotes.length, 1, 'the conflict was not reported')
  assert.match(gpaNotes[0].detail, /conflicts with overall_gpa/)
  assert.match(gpaNotes[0].detail, /3\.83/)
  assert.match(gpaNotes[0].detail, /3\.50/)
  assert.match(gpaNotes[0].detail, /Needs a human/)
})

test('the nursing degree is unchanged: a stray gpa there is still only reported', () => {
  const { entries, gpaNotes } = mapEducation({
    nursing_degree: { ...NURSING, gpa: '3.91' },
    other_degrees: [],
  })
  assert.equal(entries[0].overallGpa.raw, '', 'a nursing-degree gpa was guessed into a field')
  assert.equal(entries[0].scienceGpa.raw, '')
  assert.equal(gpaNotes.length, 1)
  assert.match(gpaNotes[0].detail, /on the nursing degree, where V1 has no such field/)
})

test('8: the fixture other-degree GPAs migrate, and their notes are gone', () => {
  const out = mapOne(16)
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return
  const notes = out.notes.filter((n) => n.kind === 'unmapped-value' && n.path.includes('/gpa'))
  assert.deepEqual(notes, [], 'a preserved GPA is still being reported as unmapped')

  const education = out.resume.sections.find((s) => s.type === 'education')
  if (education?.type !== 'education') return
  // The fixture gives each other degree 3.20, 3.21, 3.22 and no overall_gpa.
  assert.deepEqual(
    education.entries.slice(1).map((e) => [e.overallGpa.raw, e.overallGpa.value, e.overallGpa.showOnResume]),
    [['3.20', 3.2, false], ['3.21', 3.21, false], ['3.22', 3.22, false]]
  )
  for (const entry of education.entries.slice(1)) {
    assert.equal(entry.scienceGpa.raw, '', 'a legacy GPA reached the science slot')
  }
})

// ------------------------------------------------------------ ICU unit

test('legacy unit_type lands in both the visible field and the grounding', () => {
  const resume = mapped(16)
  const icu = resume.sections.find((s) => s.type === 'critical_care')
  if (icu?.type !== 'critical_care') return
  const withUnit = icu.positions.find((p) => p.facts.unit !== '')
  assert.ok(withUnit, 'every position lost its unit type')
  assert.equal(withUnit!.facts.unit, 'Medical ICU')
  assert.equal(withUnit!.facts.unitType, 'Medical ICU', 'grounding lost the unit type')
  // Still visible on the page, as it was in V1.
  assert.ok(textOf(planDocument(resume)).join(' | ').includes('Medical ICU'))
})

test('the wording is not altered in either destination', () => {
  const resume = mapped(0)
  const icu = resume.sections.find((s) => s.type === 'critical_care')
  if (icu?.type !== 'critical_care') return
  assert.equal(icu.positions[0].facts.unit, icu.positions[0].facts.unitType)
})

// --------------------------------------------------------- bullets

test('every blank legacy bullet becomes no bullet at all', () => {
  // All 41 production bullet arrays are [''].
  for (let i = 0; i < fixture.resumes.length; i++) {
    const icu = mapped(i).sections.find((s) => s.type === 'critical_care')
    if (icu?.type !== 'critical_care') continue
    for (const position of icu.positions) {
      assert.equal(position.bullets.length, 0, `resume ${i} invented a bullet`)
    }
  }
})

test('a position with no bullets still renders its job header', () => {
  const printed = textOf(planDocument(mapped(16))).join(' | ')
  assert.ok(printed.includes('Hospital 17-1'), 'a position vanished with its bullets')
})

test('a real bullet would survive', () => {
  const row = fixture.resumes[0]
  const rows = sectionsFor(row.id).map((s) =>
    s.section_type !== 'icu_experience' ? s : {
      ...s,
      section_data: {
        positions: [{
          ...((s.section_data as { positions: Record<string, unknown>[] }).positions[0]),
          bullet_points: ['', 'Titrated vasoactive infusions overnight.', '  '],
        }],
      },
    })
  const out = mapV1Resume(row, rows, ctx(row.id))
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return
  const icu = out.resume.sections.find((s) => s.type === 'critical_care')
  if (icu?.type !== 'critical_care') return
  assert.deepEqual(
    icu.positions[0].bullets.map((b) => b.accepted),
    ['Titrated vasoactive infusions overnight.']
  )
})

// ------------------------------------------- grounding stays grounding

test('devices and populations migrate as grounding and never render', () => {
  const resume = mapped(16)
  const icu = resume.sections.find((s) => s.type === 'critical_care')
  if (icu?.type !== 'critical_care') return
  const withDevices = icu.positions.find((p) => p.facts.devices.length > 0)
  assert.ok(withDevices, 'the grounding was lost')

  const printed = textOf(planDocument(resume)).join(' | ')
  for (const grounding of ['Ventilator', 'CRRT', 'Septic shock', 'High']) {
    assert.equal(printed.includes(grounding), false, `${grounding} reached the page`)
  }
})

// -------------------------------------------------------------- dates

test('a malformed date is carried across exactly as typed', () => {
  const row = fixture.resumes[4] // unparseable graduation date
  const out = mapV1Resume(row, sectionsFor(row.id), ctx(row.id))
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return
  const education = out.resume.sections.find((s) => s.type === 'education')
  if (education?.type !== 'education') return
  const date = education.entries[0].graduationDate
  assert.equal(date.kind, 'unparsed')
  assert.equal((date as { raw: string }).raw, 'Jan 2020 - ish')
  assert.ok(out.notes.some((n) => n.kind === 'unparsed-date'))
})

test('a missing date stays missing and is reported', () => {
  const out = mapOne(0)
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return
  const education = out.resume.sections.find((s) => s.type === 'education')
  if (education?.type !== 'education') return
  assert.equal(education.entries[0].graduationDate.kind, 'absent')
  assert.ok(out.notes.some((n) => n.kind === 'missing-date'))
})

// ---------------------------------------------------------- provenance

test('every migrated text is marked import, unproposed, with no history', () => {
  for (let i = 4; i < 8; i++) {
    const resume = mapped(i)
    for (const section of resume.sections) {
      for (const text of authoredTextsIn(section)) {
        if (text.accepted.trim() === '') continue
        assert.equal(text.origin, 'import')
        assert.equal(text.originalOrigin, 'import')
        assert.equal(text.userOrigin, 'import')
        assert.equal(text.accepted, text.originalSource)
        assert.equal(text.accepted, text.userSource)
        assert.equal(text.proposal, null)
        assert.deepEqual(text.history, [])
      }
    }
  }
})

test('both restore controls are hidden immediately after migration', () => {
  // Nothing has moved away from the original yet, so there is nothing to
  // restore to -- and Restore Original would not erase anything either, because
  // the original is the applicant's real V1 prose.
  const resume = mapped(5)
  for (const section of resume.sections) {
    for (const text of authoredTextsIn(section)) {
      if (text.accepted.trim() === '') continue
      assert.equal(canRestoreOriginal(text), false)
      assert.equal(canRestoreUserText(text), false)
      assert.notEqual(text.originalSource.trim(), '', 'the original is empty, which would make restore destructive')
    }
  }
})

// --------------------------------------------------------- long text

test('a 4,214-character summary arrives at 4,214 characters', () => {
  const resume = mapped(4)
  const summary = resume.sections.find((s) => s.type === 'summary')
  if (summary?.type !== 'summary') return
  assert.equal(summary.text.accepted.length, 4_214)
})

test('an empty summary produces no summary section', () => {
  const out = mapOne(0)
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return
  assert.equal(out.resume.sections.some((s) => s.type === 'summary'), false)
  assert.ok(out.notes.some((n) => n.kind === 'empty-section-omitted'))
})

test('no migrated resume carries an empty visible section', () => {
  for (let i = 0; i < fixture.resumes.length; i++) {
    const resume = mapped(i)
    for (const section of resume.sections) {
      const alone = planDocument({ ...resume, sections: [section] })
      assert.notEqual(alone.blocks.length, 0, `resume ${i}: ${section.type} is empty and visible`)
    }
  }
})

// -------------------------------------------------------- duplicates

test('duplicate legacy section rows stop the resume for review', () => {
  const row = fixture.resumes[0]
  const withDuplicate = [...sectionsFor(row.id), duplicateSectionRow(row.id, 'education')]
  const out = mapV1Resume(row, withDuplicate, ctx(row.id))
  assert.equal(out.kind, 'needs-review')
  if (out.kind !== 'needs-review') return
  const reason = out.reasons.find((r) => r.kind === 'duplicate-section')
  assert.ok(reason)
  assert.equal(reason!.kind === 'duplicate-section' && reason!.rowIds.length, 2, 'both rows were not reported')
})

test('a resume needing review produces no output at all', () => {
  const row = fixture.resumes[0]
  const out = mapV1Resume(row, [...sectionsFor(row.id), duplicateSectionRow(row.id, 'education')], ctx(row.id))
  assert.equal(out.kind, 'needs-review')
  assert.equal('resume' in out, false, 'a partial migration was produced anyway')
})

test('a resume with no sections needs review rather than becoming an empty draft', () => {
  const out = mapV1Resume(fixture.resumes[0], [], ctx(fixture.resumes[0].id))
  assert.equal(out.kind, 'needs-review')
})

// ------------------------------------------------------- unknown keys

test('an unknown legacy key is reported, not dropped', () => {
  const out = mapOne(7) // carries volunteer_work
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return
  assert.ok(
    out.notes.some((n) => n.kind === 'unmapped-key' && n.path.includes('volunteer_work')),
    'volunteer_work vanished without a word'
  )
})

test('an unrecognised legacy section type is reported', () => {
  const row = fixture.resumes[0]
  const stray: V1SectionRow = {
    id: 'stray', resume_id: row.id, section_type: 'awards_v1', section_data: {}, order_index: 8,
  }
  const out = mapV1Resume(row, [...sectionsFor(row.id), stray], ctx(row.id))
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return
  assert.ok(out.notes.some((n) => n.kind === 'unknown-section-type'))
})

test("V1's own score is not carried across, and says so", () => {
  const out = mapOne(2) // overall_score 64
  assert.equal(out.kind, 'mapped')
  if (out.kind !== 'mapped') return
  assert.ok(out.notes.some((n) => n.kind === 'legacy-field-not-migrated' && n.path.includes('overall_score')))
  assert.equal(out.resume.strength, null)
})

// ------------------------------------------------------- idempotency

test('a V1 resume already migrated is recognised and skipped', () => {
  const row = fixture.resumes[0]
  const already = new Map([[row.id, 'existing-v2-id']])
  const out = mapV1Resume(row, sectionsFor(row.id), ctx(row.id, already))
  assert.equal(out.kind, 'already-migrated')
  if (out.kind !== 'already-migrated') return
  assert.equal(out.v2ResumeId, 'existing-v2-id')
})

test('the marker identifies the source record, and the index finds it', () => {
  const row = fixture.resumes[0]
  const resume = mapped(0)
  assert.equal(resume.importedFrom?.importId, row.id)
  assert.equal(resume.importedFrom?.sourceFormat, 'v1')
  assert.equal(resume.importedFrom?.documentFingerprint, migrationMarker(row.id))
  // The V1 rows are never deleted, so they genuinely are retained.
  assert.equal(resume.importedFrom?.originalRetained, true)

  const index = migratedIndex([resume])
  assert.equal(index.get(row.id), resume.id)
})

test('re-running over already-migrated resumes produces nothing new', () => {
  const first = fixture.resumes.map((_, i) => mapped(i))
  const index = migratedIndex(first)
  for (let i = 0; i < fixture.resumes.length; i++) {
    assert.equal(mapOne(i, index).kind, 'already-migrated', `resume ${i} would be duplicated`)
  }
})

test('the reference records the moment, not the content', () => {
  const reference = migrationReference('abc', NOW)
  assert.equal(reference.importedAt, NOW)
  assert.equal(reference.documentFingerprint, 'v1:abc')
})

// -------------------------------------------------------------- purity

test('mapping mutates neither the row nor its sections', () => {
  const row = fixture.resumes[16]
  const rows = sectionsFor(row.id)
  const before = JSON.stringify([row, rows])
  mapV1Resume(row, rows, ctx(row.id))
  assert.equal(JSON.stringify([row, rows]), before)
})

test('the same input always produces the same resume', () => {
  const row = fixture.resumes[9]
  assert.deepEqual(
    mapV1Resume(row, sectionsFor(row.id), ctx(row.id)),
    mapV1Resume(row, sectionsFor(row.id), ctx(row.id))
  )
})
