import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  entryFacts, factSheetForEntryField, factSheetForPosition, factSheetForSummary,
  positionFacts,
} from './factSheet.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText, acceptProposal, propose } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * The grounding envelope. What a model is allowed to know, and — far more
 * importantly — what it is not.
 */

const NOW = '2026-09-10T12:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

function position() {
  return createClinicalPosition('p1', {
    employer: 'University Hospital',
    role: 'Registered Nurse',
    unit: '24-bed medical ICU',
    location: 'Newark, NJ',
    dates: { start: resumeDateFromParts(2021, 3), end: { kind: 'absent' }, isCurrent: true },
    devices: ['Ventilator', 'CRRT'],
    therapies: ['Vasoactive infusions'],
    patientPopulations: ['Septic shock'],
    committees: ['Sepsis committee'],
    chargeExperience: false,
    preceptorExperience: true,
  })
}

const valuesOf = (facts: readonly { value: string }[]) => facts.map((f) => f.value)

const shadowingEntry = () => ({
  id: 'sh1', providerName: 'A. Nurse', credential: 'CRNA', setting: 'OR', facility: 'UH',
  hours: '40+', dates: { start: { kind: 'absent' as const }, end: { kind: 'absent' as const }, isCurrent: false },
  reflection: createAuthoredText(''),
})

// ------------------------------------------------- only supplied facts

test('every fact traces to something the applicant supplied', () => {
  const facts = positionFacts(position(), 'critical_care')
  const values = valuesOf(facts)
  for (const expected of [
    'University Hospital', 'Registered Nurse', '24-bed medical ICU', 'Newark, NJ',
    'Ventilator', 'CRRT', 'Vasoactive infusions', 'Septic shock', 'Sepsis committee',
  ]) {
    assert.ok(values.includes(expected), `missing supplied fact: ${expected}`)
  }
})

test('nothing is derived — no span of experience is computed from dates', () => {
  // "Years of experience" is on the prohibited list precisely because it is
  // trivial to compute, and a computed fact is indistinguishable to the model
  // from one a person typed.
  const facts = positionFacts(position(), 'critical_care')
  for (const fact of facts) {
    assert.doesNotMatch(fact.value, /\byears?\b/i, `a span was derived: ${fact.value}`)
  }
  assert.equal(facts.some((f) => f.kind === 'applicant_metric' && /^\d+$/.test(f.value)), false)
})

test('a blank field contributes no fact', () => {
  const sparse = createClinicalPosition('p2', { employer: 'University Hospital' })
  const facts = positionFacts(sparse, 'critical_care')
  assert.deepEqual(valuesOf(facts), ['University Hospital'])
  for (const fact of facts) assert.notEqual(fact.value.trim(), '')
})

test('a false flag is not a fact that something did not happen', () => {
  const facts = positionFacts(position(), 'critical_care')
  assert.equal(facts.some((f) => f.kind === 'charge_role'), false, 'a false flag became a fact')
  assert.equal(facts.some((f) => f.kind === 'preceptor_role'), true, 'a true flag was dropped')
})

test('every fact carries an id and a path back to its field', () => {
  for (const fact of positionFacts(position(), 'critical_care')) {
    assert.match(fact.id, /^f:/, 'a fact has no citable id')
    assert.ok(fact.path.startsWith('critical_care/p1/'), `a fact has no path: ${fact.id}`)
  }
})

test('ids are stable across rebuilds, so a citation keeps its meaning', () => {
  assert.deepEqual(
    positionFacts(position(), 'critical_care').map((f) => f.id),
    positionFacts(position(), 'critical_care').map((f) => f.id)
  )
})

test('every fact is user- or import-supplied, never anything else', () => {
  for (const fact of positionFacts(position(), 'critical_care')) {
    assert.ok(['user', 'import'].includes(fact.provenance), fact.id)
  }
})

// ------------------------------------------------- no AI laundering

test('AI-authored text never becomes grounding', () => {
  // Otherwise a fabrication accepted in one turn becomes a "fact" the next,
  // and the guarantee launders itself away over two rounds.
  const aiText = acceptProposal(
    propose(createAuthoredText(''), {
      text: 'Maintained a 2:1 assignment.', model: 'test', groundedIn: [], requestedAt: NOW,
    }),
    NOW
  )
  const withAi = { ...position(), guided: [{ promptId: 'q1', answer: aiText }] }
  const facts = positionFacts(withAi, 'critical_care')
  assert.equal(
    facts.some((f) => f.value.includes('2:1')), false,
    'AI-written text reached the fact sheet'
  )
})

test('the applicant’s own guided answer does become grounding', () => {
  const withGuided = {
    ...position(),
    guided: [{ promptId: 'q1', answer: createAuthoredText('I ran the sepsis protocol every shift.') }],
  }
  const values = valuesOf(positionFacts(withGuided, 'critical_care'))
  assert.ok(values.includes('I ran the sepsis protocol every shift.'))
})

test('bullets are not grounding — they are the thing being written', () => {
  const withBullets = { ...position(), bullets: [createBullet('Titrated vasopressors nightly.')] }
  const values = valuesOf(positionFacts(withBullets, 'critical_care'))
  assert.equal(values.includes('Titrated vasopressors nightly.'), false)
})

// --------------------------------------------------------- scope

test('a position’s sheet contains only that position', () => {
  const other = createClinicalPosition('p2', { employer: 'Another Hospital', unit: 'Burn ICU' })
  const sheet = factSheetForPosition(position(), 'critical_care')
  const values = valuesOf(sheet.facts)
  assert.equal(values.includes('Another Hospital'), false)
  assert.equal(values.includes('Burn ICU'), false)
  assert.equal(valuesOf(positionFacts(other, 'critical_care')).includes('University Hospital'), false)
})

test('the sheet names the field it is for', () => {
  assert.equal(factSheetForPosition(position(), 'critical_care').subject, 'critical_care/p1/bullets')
  const shadowing = {
    ...createSection('shadowing', 'sh'),
    experiences: [shadowingEntry()],
  } as ResumeSectionV2
  assert.equal(
    factSheetForEntryField(shadowing, 'sh1', 'reflection')?.subject,
    'shadowing/sh1/reflection'
  )
})

test('hours are carried as supplied, not tidied into a number', () => {
  const shadowing = {
    ...createSection('shadowing', 'sh'),
    experiences: [shadowingEntry()],
  } as ResumeSectionV2
  const sheet = factSheetForEntryField(shadowing, 'sh1', 'reflection')
  assert.ok(sheet)
  assert.ok(valuesOf(sheet!.facts).includes('40+'), '"40+" was rewritten')
})

test('the narrative field being written is not its own grounding', () => {
  // It reaches the prompt as the text being rewritten and the verifier as
  // already-present. Listing it as a fact too would let a claim support itself.
  const shadowing = {
    ...createSection('shadowing', 'sh'),
    experiences: [{ ...shadowingEntry(), reflection: createAuthoredText('I learned a great deal.') }],
  } as ResumeSectionV2
  const sheet = factSheetForEntryField(shadowing, 'sh1', 'reflection')
  assert.equal(valuesOf(sheet!.facts).includes('I learned a great deal.'), false)
})

// ------------------------------------------------------- the summary

function resumeWith(sections: readonly ResumeSectionV2[]): ResumeV2 {
  const base = createResume({ id: 'r1', userId: 'u1', title: 'T', sectionIds: ids(20), now: NOW })
  return { ...base, contact: { ...emptyContact(), fullName: 'Jane Doe', email: 'j@example.test' }, sections }
}

test('the summary sheet spans sections but carries no contact details', () => {
  const cc = { ...createSection('critical_care', 'cc'), positions: [position()] } as ResumeSectionV2
  const edu = {
    ...createSection('education', 'ed'),
    entries: [{
      id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
      location: 'Newark, NJ', graduationDate: resumeDateFromParts(2019, 5),
      overallGpa: { raw: '3.85', value: 3.85, showOnResume: true },
      scienceGpa: { raw: '', value: null, showOnResume: false }, honors: '',
    }],
  } as ResumeSectionV2

  const sheet = factSheetForSummary(resumeWith([cc, edu]))
  const values = valuesOf(sheet.facts)
  assert.ok(values.includes('University Hospital'))
  assert.ok(values.includes('Rutgers University'))
  // A summary needs none of this, so the model is never shown it.
  assert.equal(values.includes('Jane Doe'), false, 'the applicant’s name reached the model')
  assert.equal(values.includes('j@example.test'), false, 'an email reached the model')
  assert.equal(values.some((v) => v.includes('3.85')), false, 'a GPA reached the model')
})

test('a hidden section is not grounding', () => {
  const cc = {
    ...createSection('critical_care', 'cc'), visible: false, positions: [position()],
  } as ResumeSectionV2
  const sheet = factSheetForSummary(resumeWith([cc]))
  assert.equal(valuesOf(sheet.facts).includes('University Hospital'), false)
})

test('an untouched resume yields an empty sheet rather than throwing', () => {
  const blank = createResume({ id: 'r', userId: 'u', title: 'T', sectionIds: ids(20), now: NOW })
  assert.deepEqual(factSheetForSummary(blank).facts, [])
})

test('building a sheet mutates nothing', () => {
  const p = position()
  const before = JSON.stringify(p)
  factSheetForPosition(p, 'critical_care')
  assert.equal(JSON.stringify(p), before)
})
