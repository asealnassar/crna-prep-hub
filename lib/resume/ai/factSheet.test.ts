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

test('bullets are not grounding by default — on an improve they are the subject', () => {
  // A caller has to ask for them, and only generation does. See "stored bullets
  // as context, candidates as neither" below.
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

const summaryOf = (written: string): ResumeSectionV2 =>
  ({ ...createSection('summary', 'sum'), text: createAuthoredText(written) }) as ResumeSectionV2

const WROTE = 'Six years in a medical ICU, most of it on nights.'

test('the summary is grounded in the summary the applicant wrote', () => {
  const sheet = factSheetForSummary(resumeWith([summaryOf(WROTE)]))
  assert.ok(valuesOf(sheet.facts).includes(WROTE))
  assert.equal(sheet.subject, 'summary/text')
})

test('a fact elsewhere on the resume does not license a claim in the summary', () => {
  // The sheet is PERMISSION. Listing an employer and a degree here invited a
  // "tightened" summary to state things the applicant never said about
  // themselves -- true of the resume, but never their own words.
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

  const values = valuesOf(factSheetForSummary(resumeWith([summaryOf(WROTE), cc, edu])).facts)
  assert.ok(values.includes(WROTE), 'their own summary was withheld')
  assert.equal(values.includes('University Hospital'), false, 'an employer licensed a summary claim')
  assert.equal(values.includes('Rutgers University'), false, 'an institution licensed a summary claim')
  // A summary needs none of this either, and never did.
  assert.equal(values.includes('Jane Doe'), false, 'the applicant’s name reached the model')
  assert.equal(values.includes('j@example.test'), false, 'an email reached the model')
  assert.equal(values.some((v) => v.includes('3.85')), false, 'a GPA reached the model')
})

test('a summary an assistant tightened grounds in their words, not its own', () => {
  const tightened = acceptProposal(
    propose(createAuthoredText(WROTE), {
      text: 'Seasoned nocturnal critical-care clinician.', model: 'test', groundedIn: [], requestedAt: NOW,
    }),
    NOW
  )
  const section = { ...createSection('summary', 'sum'), text: tightened } as ResumeSectionV2
  const values = valuesOf(factSheetForSummary(resumeWith([section])).facts)

  assert.ok(values.includes(WROTE), 'their own source was discarded')
  assert.equal(
    values.includes('Seasoned nocturnal critical-care clinician.'), false,
    'the assistant’s own sentence became the grounding for the next round'
  )
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

// --------------------------------- the summary sees the whole resume

test('an education record written before start dates existed still builds', () => {
  // `startDate` is optional on purpose: nothing rewrites stored rows to add it.
  // A formatter reading `.kind` off an absent field would throw, and the
  // applicant would lose a proposal rather than a date.
  const legacy = {
    id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
    location: 'Newark, NJ', graduationDate: resumeDateFromParts(2019, 5),
    overallGpa: { raw: '', value: null, showOnResume: false },
    scienceGpa: { raw: '', value: null, showOnResume: false }, honors: '',
  } as unknown as Record<string, unknown>

  const values = valuesOf(entryFacts('education', legacy, 'education/e1'))
  assert.ok(values.includes('Rutgers University'))
  assert.ok(values.includes('May 2019'), 'the graduation date was lost')
})

test('an education start date is a fact once it is given', () => {
  const withStart = {
    id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University',
    location: 'Newark, NJ',
    startDate: resumeDateFromParts(2015, 8), graduationDate: resumeDateFromParts(2019, 5),
    overallGpa: { raw: '', value: null, showOnResume: false },
    scienceGpa: { raw: '', value: null, showOnResume: false }, honors: '',
  } as unknown as Record<string, unknown>

  const values = valuesOf(entryFacts('education', withStart, 'education/e1'))
  assert.ok(values.includes('Aug 2015'), 'the start date the applicant gave was withheld')
})

test('entry facts survive a record missing a field entirely', () => {
  const sparse = { id: 'e1', degree: 'BSN' } as unknown as Record<string, unknown>
  assert.doesNotThrow(() => entryFacts('education', sparse, 'education/e1'))
  assert.deepEqual(valuesOf(entryFacts('education', sparse, 'education/e1')), ['BSN'])
})

// ------------------- stored bullets as context, candidates as neither

test('writing a new bullet may draw on the ones they have already written', () => {
  // Their own account of this job, in their own words. A sixth bullet written
  // in ignorance of the first five is how an assistant repeats or contradicts
  // what is already on the page.
  const withBullets = { ...position(), bullets: [createBullet('Ran the sepsis protocol every shift.')] }
  const sheet = factSheetForPosition(withBullets, 'critical_care', { includeWrittenBullets: true })
  assert.ok(valuesOf(sheet.facts).includes('Ran the sepsis protocol every shift.'))
})

test('improving one bullet grounds in the facts, not in the bullets', () => {
  // The default, and what an improve uses. There the bullets ARE the subject,
  // and a claim allowed to ground itself would verify against itself.
  const withBullets = { ...position(), bullets: [createBullet('Ran the sepsis protocol every shift.')] }
  const sheet = factSheetForPosition(withBullets, 'critical_care')
  assert.equal(valuesOf(sheet.facts).includes('Ran the sepsis protocol every shift.'), false)
})

test('an AI sentence never grounds the next generation', () => {
  // The recursion that must not happen: a figure invented once, accepted, and
  // then treated as a supplied fact forever after.
  const aiBullet = acceptProposal(
    propose(createAuthoredText(''), {
      text: 'Maintained a 2:1 assignment.', model: 'test', groundedIn: [], requestedAt: NOW,
    }),
    NOW
  )
  const sheet = factSheetForPosition(
    { ...position(), bullets: [aiBullet] }, 'critical_care', { includeWrittenBullets: true }
  )
  assert.equal(
    valuesOf(sheet.facts).some((v) => v.includes('2:1')), false,
    'a fabrication became grounding for the next round'
  )
})

test('their own words survive an assistant having tightened them', () => {
  // The distinction this rule turns on: the proposal is not a fact, but the
  // applicant's source underneath it never stopped being one.
  const mine = createAuthoredText('I ran the sepsis protocol on every night shift.')
  const tightened = acceptProposal(
    propose(mine, {
      text: 'Ran sepsis protocols nightly.', model: 'test', groundedIn: [], requestedAt: NOW,
    }),
    NOW
  )
  const values = valuesOf(factSheetForPosition(
    { ...position(), bullets: [tightened] }, 'critical_care', { includeWrittenBullets: true }
  ).facts)

  assert.ok(
    values.includes('I ran the sepsis protocol on every night shift.'),
    'their own source was thrown away with the assistant’s wording'
  )
  assert.equal(values.includes('Ran sepsis protocols nightly.'), false, 'the AI’s sentence became a fact')
})

test('a generation sheet still carries only that position', () => {
  const other = createClinicalPosition('p2', { employer: 'Another Hospital' })
  const values = valuesOf(factSheetForPosition(
    { ...position(), bullets: [createBullet('Mine.')] }, 'critical_care', { includeWrittenBullets: true }
  ).facts)
  assert.equal(values.includes('Another Hospital'), false)
  assert.equal(
    valuesOf(positionFacts(other, 'critical_care', { includeWrittenBullets: true })).includes('Mine.'),
    false
  )
})

test('a bullet used as context is a fact like any other', () => {
  const sheet = factSheetForPosition(
    { ...position(), bullets: [createBullet('Mine.')] }, 'critical_care', { includeWrittenBullets: true }
  )
  const bullet = sheet.facts.find((f) => f.value === 'Mine.')
  assert.ok(bullet, 'the bullet reached the sheet without a fact of its own')
  assert.match(bullet!.id, /^f:/, 'a bullet fact cannot be cited')
  assert.equal(bullet!.path, 'critical_care/p1/bullets#0')
  assert.ok(['user', 'import'].includes(bullet!.provenance), bullet!.provenance)
})
