import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  V1_SECTION_TYPES, isV1SectionType, readV1Certifications, readV1Education,
  readV1IcuExperience, readV1Leadership, readV1Personal, readV1Position,
  readV1Research, readV1Section, readV1Shadowing, v1SectionIssues,
} from './v1Shapes.ts'

/**
 * V1 compatibility, against fixtures that mirror what Phase 0 actually
 * measured in production. No database is read; these shapes are synthetic but
 * their pathologies are real:
 *
 *   - every bullet array is `['']`
 *   - 22% of position dates and 35% of graduation dates are empty or unparseable
 *   - `other_degrees[]` carries gpa and graduation_date that V1 never renders
 *   - one summary is 4,214 characters
 */

/** A position exactly as V1 stores one, including the blank bullet. */
const v1Position = (over: Record<string, unknown> = {}) => ({
  position: 'ICU Registered Nurse',
  unit_type: 'Surgical ICU',
  hospital: 'Mercy General',
  location: 'Sacramento, CA',
  start_date: '2020-03-01',
  end_date: '',
  is_current: true,
  acuity: 'high',
  devices: ['CRRT', 'Arterial line', 'Swan-Ganz'],
  patient_population: ['Post-op cardiac', 'Septic shock'],
  bullet_points: [''],
  ...over,
})

test('every V1 section type is recognised', () => {
  assert.equal(V1_SECTION_TYPES.length, 7)
  for (const t of V1_SECTION_TYPES) assert.equal(isV1SectionType(t), true)
  for (const t of ['licensure', 'awards', '', null, 42]) {
    assert.equal(isV1SectionType(t), false, String(t))
  }
})

test('every V1 section type parses without throwing', () => {
  const samples: Array<[string, unknown]> = [
    ['personal', { full_name: 'A', email: 'a@b.c', phone: '', city: 'X', state: 'Y', linkedin: '', professional_summary: 'S' }],
    ['education', { nursing_degree: { degree: 'BSN', university: 'U', graduation_date: '2018-05', overall_gpa: '3.6', science_gpa: '' }, other_degrees: [] }],
    ['certifications', { certifications: ['CCRN'], custom_certifications: [] }],
    ['icu_experience', { positions: [v1Position()] }],
    ['shadowing', { experiences: [{ crna_name: 'N', hours: '20', setting: 'OR', description: 'D' }] }],
    ['leadership', { roles: ['Charge Nurse'] }],
    ['research', { projects: ['A QI project'] }],
  ]
  for (const [type, data] of samples) {
    const parsed = readV1Section(type, data)
    assert.ok(parsed, `${type} parsed`)
    assert.equal(parsed?.type, type)
  }
})

test('an unknown section type returns null instead of throwing', () => {
  assert.equal(readV1Section('licensure', {}), null)
  assert.equal(readV1Section(null, {}), null)
  assert.equal(readV1Section('personal', null)?.type, 'personal', 'null data still parses')
})

test('every reader survives null, undefined, wrong types and arrays', () => {
  const junk = [null, undefined, 42, 'a string', [], true, { unexpected: 1 }]
  for (const input of junk) {
    assert.doesNotThrow(() => readV1Personal(input), String(input))
    assert.doesNotThrow(() => readV1Education(input), String(input))
    assert.doesNotThrow(() => readV1Certifications(input), String(input))
    assert.doesNotThrow(() => readV1IcuExperience(input), String(input))
    assert.doesNotThrow(() => readV1Shadowing(input), String(input))
    assert.doesNotThrow(() => readV1Leadership(input), String(input))
    assert.doesNotThrow(() => readV1Research(input), String(input))
    assert.doesNotThrow(() => readV1Position(input), String(input))
  }
})

// ------------------------------------------------------- blank bullets

test('the universal V1 blank bullet is dropped and counted', () => {
  const p = readV1Position(v1Position())
  assert.deepEqual(p.bullets, [], 'nothing renders')
  assert.equal(p.rawBulletCount, 1, 'but we know one was there')
})

test('mixed real and blank bullets keep only the real ones', () => {
  const p = readV1Position(v1Position({ bullet_points: ['', 'Real bullet', '   ', 'Another'] }))
  assert.deepEqual(p.bullets, ['Real bullet', 'Another'])
  assert.equal(p.rawBulletCount, 4)
})

test('a blank-only bullet array is reported as an issue', () => {
  const section = readV1Section('icu_experience', { positions: [v1Position()] })!
  const issues = v1SectionIssues(section, 'r1')
  assert.ok(issues.some((i) => i.kind === 'blank-bullets'), 'flagged for review')
})

// -------------------------------------------------------------- dates

test('invalid legacy dates are preserved, never corrected', () => {
  const p = readV1Position(v1Position({ start_date: 'Spring 2019', is_current: false, end_date: 'n/a' }))
  assert.equal(p.dates.start.kind, 'unparsed')
  assert.equal(p.dates.start.kind === 'unparsed' && p.dates.start.raw, 'Spring 2019')
  assert.equal(p.dates.end.kind, 'unparsed')
})

test('empty legacy dates are absent, not zero', () => {
  const p = readV1Position(v1Position({ start_date: '', is_current: false, end_date: '' }))
  assert.equal(p.dates.start.kind, 'absent')
  assert.equal(p.dates.end.kind, 'absent')
})

test('date problems are reported per position with their raw text', () => {
  const section = readV1Section('icu_experience', {
    positions: [
      v1Position({ start_date: '', is_current: false, end_date: '' }),
      v1Position({ start_date: 'Spring 2019', is_current: false, end_date: '2020-13-01' }),
      v1Position(),
    ],
  })!
  const issues = v1SectionIssues(section, 'r1')
  assert.ok(issues.some((i) => i.kind === 'missing-date' && i.path.includes('#0/start_date')))
  assert.ok(issues.some((i) => i.kind === 'unparsed-date' && i.detail === 'Spring 2019'))
  assert.ok(issues.some((i) => i.kind === 'unparsed-date' && i.detail === '2020-13-01'))
  assert.ok(!issues.some((i) => i.path.includes('#2/start_date')), 'the good one is not flagged')
})

test('a current position is not flagged for a missing end date', () => {
  const section = readV1Section('icu_experience', { positions: [v1Position()] })!
  const issues = v1SectionIssues(section, 'r1')
  assert.ok(!issues.some((i) => i.path.includes('end_date')), 'still there is not missing')
})

test('a bad graduation date is reported without being changed', () => {
  const section = readV1Section('education', {
    nursing_degree: { degree: 'BSN', university: 'U', graduation_date: 'sometime 2018', overall_gpa: '', science_gpa: '' },
    other_degrees: [],
  })!
  assert.ok(v1SectionIssues(section, 'r1').some((i) => i.kind === 'unparsed-date' && i.detail === 'sometime 2018'))
})

// ------------------------------------------------- lossless-ness

test('unknown future keys are preserved rather than dropped', () => {
  const p = readV1Position(v1Position({ some_future_key: 'value', another: 42 }))
  assert.deepEqual(p.extras, { some_future_key: 'value', another: 42 })
  assert.equal(p.hospital, 'Mercy General', 'known data is unaffected')
})

test('other_degrees keeps the gpa and graduation_date V1 never rendered', () => {
  const edu = readV1Education({
    nursing_degree: { degree: 'BSN', university: 'U', graduation_date: '2018-05' },
    other_degrees: [{ degree: 'BS', field: 'Biology', university: 'State', gpa: '3.4', graduation_date: '2014-05' }],
  })
  assert.equal(edu.otherDegrees[0].gpaRaw, '3.4', 'read, not discarded')
  assert.equal(edu.otherDegrees[0].graduationDate.kind, 'exact')
})

test('a 4,214-character summary survives intact', () => {
  const long = 'a'.repeat(4214)
  const p = readV1Personal({ professional_summary: long })
  assert.equal(p.professionalSummary.length, 4214, 'never truncated')
})

test('shadowing hours stay text so "40+" survives', () => {
  const s = readV1Shadowing({ experiences: [{ crna_name: 'N', hours: '40+', setting: 'OR', description: '' }] })
  assert.equal(s.experiences[0].hours, '40+')
  const numeric = readV1Shadowing({ experiences: [{ hours: 20 }] })
  assert.equal(numeric.experiences[0].hours, '', 'a non-string is not coerced into a wrong value')
})

test('no clinical fact is ever fabricated for a missing field', () => {
  const p = readV1Position({})
  assert.equal(p.hospital, '')
  assert.equal(p.unitType, '')
  assert.equal(p.acuity, '', 'no default acuity invented')
  assert.deepEqual(p.devices, [])
  assert.deepEqual(p.patientPopulation, [])
  assert.deepEqual(p.bullets, [])
})

test('structured facts stay separate from anything that renders', () => {
  const p = readV1Position(v1Position())
  assert.equal(p.devices.length, 3)
  assert.equal(p.patientPopulation.length, 2)
  assert.deepEqual(p.bullets, [], 'checkbox facts did NOT become bullets')
})

test('malformed nested shapes degrade to empty rather than throwing', () => {
  assert.deepEqual(readV1IcuExperience({ positions: 'not an array' }).positions, [])
  assert.deepEqual(readV1IcuExperience({ positions: [null, 42, 'x'] }).positions.map((p) => p.hospital), ['', '', ''])
  assert.deepEqual(readV1Leadership({ roles: [1, 2, null] }).roles, [], 'non-strings filtered')
  assert.deepEqual(readV1Certifications({ certifications: null }).certifications, [])
})
