import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contactPieces, formatDateRange, formatGpa, formatLocation, formatName,
  formatResumeDate, join, paragraphsOf,
} from './format.ts'
import { ABSENT_DATE, resumeDateFromParts } from '../model/dates.ts'
import { emptyContact } from '../model/resume.ts'
import { emptyGpa, parseGpa } from '../model/sections.ts'
import type { ResumeDate } from '../model/dates.ts'

const MAR_2021 = resumeDateFromParts(2021, 3)
const JUN_2023 = resumeDateFromParts(2023, 6)
const unparsed = (raw: string): ResumeDate => ({ kind: 'unparsed', raw })

// --------------------------------------------------------------- dates

test('an exact date prints as month and year', () => {
  assert.equal(formatResumeDate(MAR_2021), 'Mar 2021')
  assert.equal(formatResumeDate(resumeDateFromParts(2024, 12)), 'Dec 2024')
  assert.equal(formatResumeDate(resumeDateFromParts(2019, 1)), 'Jan 2019')
})

test('an absent date prints nothing at all', () => {
  assert.equal(formatResumeDate(ABSENT_DATE), '')
})

test('an unparsed date prints what the applicant typed', () => {
  assert.equal(formatResumeDate(unparsed('Spring 2024')), 'Spring 2024')
  assert.equal(formatResumeDate(unparsed('  expected 2026 ')), 'expected 2026')
})

test('no date ever renders as Invalid Date or NaN', () => {
  const dates = [ABSENT_DATE, MAR_2021, unparsed('whenever'), unparsed('')]
  for (const d of dates) {
    const out = formatResumeDate(d)
    assert.doesNotMatch(out, /Invalid|NaN|undefined|null/, JSON.stringify(d))
  }
})

// -------------------------------------------------------------- ranges

test('a closed range prints both ends', () => {
  const out = formatDateRange({ start: MAR_2021, end: JUN_2023, isCurrent: false })
  assert.match(out, /^Mar 2021 – Jun 2023$/)
})

test('a current role says Present regardless of the end date', () => {
  assert.match(
    formatDateRange({ start: MAR_2021, end: ABSENT_DATE, isCurrent: true }),
    /^Mar 2021 – Present$/
  )
  // isCurrent wins: "still here" is a stored fact, not an inference.
  assert.match(
    formatDateRange({ start: MAR_2021, end: JUN_2023, isCurrent: true }),
    /^Mar 2021 – Present$/
  )
})

test('a start with no end and no current flag prints alone, with no dangling dash', () => {
  const out = formatDateRange({ start: MAR_2021, end: ABSENT_DATE, isCurrent: false })
  assert.equal(out, 'Mar 2021')
  assert.doesNotMatch(out, /–/)
})

test('an entirely empty range prints nothing', () => {
  assert.equal(formatDateRange({ start: ABSENT_DATE, end: ABSENT_DATE, isCurrent: false }), '')
})

// ----------------------------------------------------------------- gpa

test('a GPA is withheld unless the applicant chose to show it', () => {
  const hidden = parseGpa('3.85')
  assert.equal(hidden.showOnResume, false, 'the model default is not to show it')
  assert.equal(formatGpa(hidden), '')
})

test('a shown GPA prints the applicant’s own text, not a reformatted number', () => {
  assert.equal(formatGpa(parseGpa('3.85', true)), 'GPA 3.85')
  assert.equal(formatGpa(parseGpa('3.4/4.0', true)), 'GPA 3.4/4.0')
  assert.equal(formatGpa(parseGpa('3.9 (major)', true)), 'GPA 3.9 (major)')
})

test('a science GPA can carry its own label', () => {
  assert.equal(formatGpa(parseGpa('3.7', true), 'Science GPA'), 'Science GPA 3.7')
})

test('an empty GPA prints nothing even when shown', () => {
  assert.equal(formatGpa({ ...emptyGpa(), showOnResume: true }), '')
  assert.equal(formatGpa({ raw: '   ', value: null, showOnResume: true }), '')
})

// ------------------------------------------------------------- contact

test('a location never renders a dangling comma', () => {
  assert.equal(formatLocation('Newark', 'NJ'), 'Newark, NJ')
  assert.equal(formatLocation('Newark', ''), 'Newark')
  assert.equal(formatLocation('', 'NJ'), 'NJ')
  assert.equal(formatLocation('', ''), '')
})

test('a name carries credentials when there are any', () => {
  assert.equal(formatName({ ...emptyContact(), fullName: 'Jane Doe', credentials: 'BSN, RN, CCRN' }),
    'Jane Doe, BSN, RN, CCRN')
  assert.equal(formatName({ ...emptyContact(), fullName: 'Jane Doe' }), 'Jane Doe')
  assert.equal(formatName(emptyContact()), '')
})

test('contact pieces drop the blanks and keep reading order', () => {
  const pieces = contactPieces({
    ...emptyContact(),
    email: 'a@example.test', phone: '', city: 'Newark', state: 'NJ',
    linkedin: 'linkedin.com/in/x', website: '',
  })
  assert.deepEqual(pieces, ['a@example.test', 'Newark, NJ', 'linkedin.com/in/x'])
})

test('an untouched contact block yields nothing to print', () => {
  assert.deepEqual(contactPieces(emptyContact()), [])
})

// --------------------------------------------------------------- prose

test('paragraphs split on blank lines and soft-wrap inside', () => {
  assert.deepEqual(paragraphsOf('One line.\nStill one.\n\nSecond.'), ['One line. Still one.', 'Second.'])
})

test('prose that is only whitespace yields no paragraphs', () => {
  for (const value of ['', '   ', '\n\n\n', '\t \n \t']) {
    assert.deepEqual(paragraphsOf(value), [], JSON.stringify(value))
  }
})

test('join is what stops presenters building strings by hand', () => {
  assert.equal(join(['a', '', 'b'], ' · '), 'a · b')
  assert.equal(join([null, undefined, 'only'], ', '), 'only')
  assert.equal(join(['  ', ''], ', '), '')
})
