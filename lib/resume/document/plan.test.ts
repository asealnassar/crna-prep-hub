import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockFor, planDocument, textOf } from './plan.ts'
import type { DocumentBlock } from './plan.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createBullet, createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { ABSENT_DATE, EMPTY_RANGE, resumeDateFromParts } from '../model/dates.ts'
import { SECTION_TYPES } from '../model/types.ts'
import type { ResumeSectionType, ResumeSectionV2, ResumeV2 } from '../model/types.ts'

const NOW = '2026-09-10T12:00:00.000Z'
const MAR_2021 = resumeDateFromParts(2021, 3)
const JUN_2023 = resumeDateFromParts(2023, 6)
const RANGE = { start: MAR_2021, end: JUN_2023, isCurrent: false }

const ids = (n: number, p = 's') => Array.from({ length: n }, (_, i) => `${p}${i}`)

/** A populated section of every type, so coverage tests are not hand-written. */
function populated(type: ResumeSectionType, id = `sec-${type}`): ResumeSectionV2 {
  const base = createSection(type, id)
  switch (type) {
    case 'summary':
      return { ...base, text: createAuthoredText('Critical care nurse of six years.') } as ResumeSectionV2
    case 'education':
      return { ...base, entries: [{
        id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
        location: 'Newark, NJ', graduationDate: JUN_2023,
        overallGpa: parseGpa('3.85', true), scienceGpa: parseGpa('3.7', true), honors: 'Cum laude',
      }] } as ResumeSectionV2
    case 'critical_care':
    case 'other_clinical': {
      const p = createClinicalPosition('p1', {
        employer: 'University Hospital', role: 'Registered Nurse',
        unit: 'Medical ICU', location: 'Newark, NJ', dates: RANGE,
      })
      return { ...base, positions: [{ ...p, bullets: [createBullet('Managed vasoactive drips.')] }] } as ResumeSectionV2
    }
    case 'licensure':
      return { ...base, licenses: [{
        id: 'l1', licenseType: 'RN', state: 'NJ', identifier: '26NR12345600',
        isCompact: true, expires: JUN_2023,
      }] } as ResumeSectionV2
    case 'certifications':
      return { ...base, certifications: [{
        id: 'c1', name: 'CCRN', issuer: 'AACN', identifier: '999999',
        earned: MAR_2021, expires: JUN_2023,
      }] } as ResumeSectionV2
    case 'shadowing':
      return { ...base, experiences: [{
        id: 'sh1', providerName: 'A. Nurse', credential: 'CRNA', setting: 'OR',
        facility: 'University Hospital', hours: '40+', dates: RANGE,
        reflection: createAuthoredText('Observed regional technique.'),
      }] } as ResumeSectionV2
    case 'leadership':
      return { ...base, entries: [{
        id: 'ld1', role: 'Charge Nurse', organization: 'University Hospital',
        dates: RANGE, detail: createAuthoredText('Coordinated a 24-bed unit.'),
      }] } as ResumeSectionV2
    case 'quality_improvement':
    case 'research':
      return { ...base, entries: [{
        id: 'pr1', title: 'CLABSI reduction', role: 'Co-lead', organization: 'MICU',
        dates: RANGE, detail: createAuthoredText('Cut line infections by a third.'),
      }] } as ResumeSectionV2
    case 'organizations':
      return { ...base, memberships: [{
        id: 'm1', organization: 'AACN', role: 'Member', dates: RANGE,
      }] } as ResumeSectionV2
    case 'awards':
      return { ...base, awards: [{
        id: 'aw1', title: 'DAISY Award', issuer: 'University Hospital',
        awarded: MAR_2021, detail: createAuthoredText('Nominated by a family.'),
      }] } as ResumeSectionV2
    case 'volunteer':
      return { ...base, entries: [{
        id: 'v1', role: 'Volunteer', organization: 'Free clinic',
        dates: RANGE, detail: createAuthoredText('Ran blood-pressure screening.'),
      }] } as ResumeSectionV2
    case 'publications':
      return { ...base, entries: [{
        id: 'pb1', title: 'Sedation practice', venue: 'AACN Conference',
        kind: 'Poster', date: MAR_2021, citation: createAuthoredText('Poster presentation.'),
      }] } as ResumeSectionV2
    case 'custom':
      return { ...base, heading: 'Languages', entries: [{
        id: 'cu1', title: 'Spanish', detail: createAuthoredText('Professional working proficiency.'),
      }] } as ResumeSectionV2
  }
}

function resumeWith(sections: readonly ResumeSectionV2[]): ResumeV2 {
  const base = createResume({
    id: 'r1', userId: 'u1', title: 'Test', sectionIds: ids(20), now: NOW,
  })
  return {
    ...base,
    contact: { ...emptyContact(), fullName: 'Jane Doe', credentials: 'BSN, RN, CCRN', email: 'j@example.test' },
    sections,
  }
}

const allPopulated = () => SECTION_TYPES.map((t) => populated(t))

// ------------------------------------------------- every section type

test('every section type produces a block', () => {
  for (const type of SECTION_TYPES) {
    const block = blockFor(populated(type))
    assert.ok(block, `${type} produced no block`)
    assert.equal(block?.sectionType, type)
  }
})

test('every block is one of exactly two primitives', () => {
  for (const type of SECTION_TYPES) {
    const block = blockFor(populated(type))
    assert.ok(block && (block.kind === 'prose' || block.kind === 'entries'), `${type}`)
  }
})

test('every block carries a heading', () => {
  for (const type of SECTION_TYPES) {
    const block = blockFor(populated(type))
    assert.notEqual(block?.heading.trim(), '', `${type} has no heading`)
  }
})

test('a custom label overrides the default heading', () => {
  const section = { ...populated('critical_care'), label: 'ICU Experience' } as ResumeSectionV2
  assert.equal(blockFor(section)?.heading, 'ICU Experience')
})

test('a stored label never replaces the Professional Summary heading', () => {
  const section = { ...populated('summary'), label: 'About Me' } as ResumeSectionV2
  assert.equal(blockFor(section)?.heading, 'Professional Summary')
})

// ----------------------------------------- hidden and empty omitted

test('a hidden section is omitted even when it has content', () => {
  const hidden = { ...populated('education'), visible: false } as ResumeSectionV2
  const plan = planDocument(resumeWith([populated('summary'), hidden]))
  assert.deepEqual(plan.blocks.map((b) => b.sectionType), ['summary'])
})

test('an empty section is omitted', () => {
  const plan = planDocument(resumeWith([
    populated('summary'),
    createSection('awards', 'empty-awards'),
    createSection('research', 'empty-research'),
  ]))
  assert.deepEqual(plan.blocks.map((b) => b.sectionType), ['summary'])
})

test('a section whose entries are all blank is omitted, not printed as blank lines', () => {
  // The model counts entries, so this section is "not empty" — but it would
  // print nothing, and a heading over nothing is worse than no heading.
  const section = {
    ...createSection('awards', 'a1'),
    awards: [{ id: 'x', title: '', issuer: '', awarded: ABSENT_DATE, detail: createAuthoredText('') }],
  } as ResumeSectionV2
  assert.equal(blockFor(section), null)
  assert.equal(planDocument(resumeWith([section])).blocks.length, 0)
})

test('blank entries are dropped while real ones in the same section survive', () => {
  const good = populated('awards') as Extract<ResumeSectionV2, { type: 'awards' }>
  const section = {
    ...good,
    awards: [
      { id: 'blank', title: '', issuer: '', awarded: ABSENT_DATE, detail: createAuthoredText('') },
      ...good.awards,
    ],
  } as ResumeSectionV2
  const block = blockFor(section)
  assert.equal(block?.kind, 'entries')
  if (block?.kind === 'entries') {
    assert.equal(block.entries.length, 1)
    assert.equal(block.entries[0].title, 'DAISY Award')
  }
})

test('a summary of only whitespace produces no block', () => {
  const section = { ...createSection('summary', 's'), text: createAuthoredText('   \n\n  ') } as ResumeSectionV2
  assert.equal(blockFor(section), null)
})

// ------------------------------------------------------ custom order

test('the applicant’s order is the document order', () => {
  const order: ResumeSectionType[] = ['awards', 'summary', 'licensure', 'education']
  const plan = planDocument(resumeWith(order.map((t) => populated(t))))
  assert.deepEqual(plan.blocks.map((b) => b.sectionType), order)
})

test('reordering changes only the order, never the content', () => {
  const forward = allPopulated()
  const backward = [...forward].reverse()
  const a = planDocument(resumeWith(forward))
  const b = planDocument(resumeWith(backward))
  assert.deepEqual(
    b.blocks.map((x) => x.sectionType),
    [...a.blocks.map((x) => x.sectionType)].reverse()
  )
  assert.deepEqual(new Set(textOf(a)), new Set(textOf(b)))
})

test('hiding a section in the middle does not disturb the rest', () => {
  const sections = allPopulated()
  const withHidden = sections.map((s, i) => (i === 3 ? { ...s, visible: false } : s))
  const plan = planDocument(resumeWith(withHidden))
  const expected = sections.filter((_, i) => i !== 3).map((s) => s.type)
  assert.deepEqual(plan.blocks.map((b) => b.sectionType), expected)
})

// ------------------------------- clinical facts are grounding, not output

test('a position with facts but no bullets prints its job header and nothing else', () => {
  const section = {
    ...createSection('critical_care', 'cc'),
    positions: [createClinicalPosition('p1', {
      employer: 'University Hospital', role: 'Registered Nurse', unit: 'Medical ICU',
      location: 'Newark, NJ', dates: RANGE,
      patientPopulations: ['Sepsis', 'ARDS', 'Post-CABG'],
      devices: ['Ventilator', 'CRRT', 'Arterial line'],
      therapies: ['Vasoactive infusions', 'Therapeutic hypothermia'],
      unitType: 'Medical ICU', acuity: 'High',
      chargeExperience: true, preceptorExperience: true,
      committees: ['Sepsis committee'], specialResponsibilities: ['Rapid response'],
    })],
  } as ResumeSectionV2

  const block = blockFor(section)
  assert.ok(block && block.kind === 'entries')
  if (!block || block.kind !== 'entries') return

  const [only] = block.entries
  assert.equal(only.title, 'University Hospital')
  assert.equal(only.detail.length, 0, 'no bullets means no detail lines')

  // The V1 regression: none of the grounding may reach the page.
  const printed = textOf(planDocument(resumeWith([section]))).join(' | ')
  for (const leaked of [
    'Sepsis', 'ARDS', 'Post-CABG', 'Ventilator', 'CRRT', 'Arterial line',
    'Vasoactive infusions', 'Therapeutic hypothermia', 'High',
    'Sepsis committee', 'Rapid response',
  ]) {
    assert.equal(printed.includes(leaked), false, `grounding reached the page: "${leaked}"`)
  }
})

test('a position renders exactly the bullets that were accepted', () => {
  const p = createClinicalPosition('p1', { employer: 'UH', dates: EMPTY_RANGE })
  const section = {
    ...createSection('critical_care', 'cc'),
    positions: [{ ...p, bullets: [createBullet('Titrated vasopressors.'), createBullet('   '), createBullet('Precepted new graduates.')] }],
  } as ResumeSectionV2
  const block = blockFor(section)
  assert.ok(block && block.kind === 'entries')
  if (block?.kind === 'entries') {
    assert.deepEqual(block.entries[0].detail, ['Titrated vasopressors.', 'Precepted new graduates.'])
  }
})

test('guided answers are raw material and never render', () => {
  const p = createClinicalPosition('p1', { employer: 'UH' })
  const section = {
    ...createSection('critical_care', 'cc'),
    positions: [{
      ...p,
      guided: [{ promptId: 'q1', answer: createAuthoredText('I ran the sepsis protocol every shift.') }],
      bullets: [createBullet('Led sepsis response.')],
    }],
  } as ResumeSectionV2
  const printed = textOf(planDocument(resumeWith([section]))).join(' | ')
  assert.equal(printed.includes('I ran the sepsis protocol'), false)
  assert.equal(printed.includes('Led sepsis response.'), true)
})

// ------------------------------------------------------------- header

test('the header carries the name, credentials and contact pieces', () => {
  const plan = planDocument(resumeWith([populated('summary')]))
  assert.equal(plan.name, 'Jane Doe, BSN, RN, CCRN')
  assert.deepEqual(plan.contact, ['j@example.test'])
})

test('an untouched resume plans to an empty document rather than throwing', () => {
  const blank = createResume({ id: 'r', userId: 'u', title: 'T', sectionIds: ids(20), now: NOW })
  const plan = planDocument(blank)
  assert.equal(plan.name, '')
  assert.deepEqual(plan.contact, [])
  assert.deepEqual(plan.blocks, [])
  assert.deepEqual(textOf(plan), [])
})

// -------------------------------------------------------- gpa on page

test('a GPA reaches the page only when the applicant asked for it', () => {
  const shown = populated('education')
  assert.ok(textOf(planDocument(resumeWith([shown]))).join(' ').includes('GPA 3.85'))

  const section = shown as Extract<ResumeSectionV2, { type: 'education' }>
  const hidden = {
    ...section,
    entries: section.entries.map((e) => ({
      ...e,
      overallGpa: { ...e.overallGpa, showOnResume: false },
      scienceGpa: { ...e.scienceGpa, showOnResume: false },
    })),
  } as ResumeSectionV2
  const printed = textOf(planDocument(resumeWith([hidden]))).join(' ')
  assert.equal(printed.includes('3.85'), false)
  assert.equal(printed.includes('Rutgers University'), true, 'the rest of the entry still renders')
})

// --------------------------------------------------------------- purity

test('planning does not mutate the resume it is given', () => {
  const resume = resumeWith(allPopulated())
  const before = JSON.stringify(resume)
  planDocument(resume)
  assert.equal(JSON.stringify(resume), before)
})

test('planning the same resume twice gives the same document', () => {
  const resume = resumeWith(allPopulated())
  assert.deepEqual(planDocument(resume), planDocument(resume))
})

test('a full resume plans every section into a block', () => {
  const plan = planDocument(resumeWith(allPopulated()))
  assert.equal(plan.blocks.length, SECTION_TYPES.length)
  assert.deepEqual(plan.blocks.map((b) => b.sectionType), [...SECTION_TYPES])
})
