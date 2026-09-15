import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRubricPrompt, parseRubric, rubricEligibility, rubricUnavailable, rubricSystemPrompt,
} from './rubric.ts'
import { compose } from './compose.ts'
import { containsAdmissionsClaim, withoutAdmissionsClaims } from './language.ts'
import { categoriesOf } from './types.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * The Writing Quality half. What the model is asked, and — more importantly —
 * what the code refuses to let it decide.
 */

const NOW = '2026-09-11T09:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)
const WRITING = categoriesOf('writing-quality').map((c) => c.id)

function resumeWith(sections: readonly ResumeSectionV2[]): ResumeV2 {
  const base = createResume({ id: 'r', userId: 'u', title: 'T', sectionIds: ids(20), now: NOW })
  return {
    ...base,
    contact: { ...emptyContact(), fullName: 'Jordan Ellery', email: 'j@example.test' },
    sections,
  }
}

const summary = (text: string) =>
  ({ ...createSection('summary', 'sm'), text: createAuthoredText(text) }) as ResumeSectionV2

const clinical = (over = {}) =>
  ({
    ...createSection('critical_care', 'cc'),
    positions: [{
      ...createClinicalPosition('p1', {
        employer: 'University Hospital', role: 'RN',
        dates: { start: resumeDateFromParts(2021, 3), end: { kind: 'absent' }, isCurrent: true },
        ...over,
      }),
      bullets: [createBullet('Titrated vasoactive infusions through haemodynamic collapse.')],
    }],
  }) as ResumeSectionV2

const populated = () => resumeWith([summary('Six years in a medical ICU.'), clinical()])

// -------------------------------------------------------- eligibility

test('leadership is not assessed when none is recorded, and says so kindly', () => {
  const eligibility = rubricEligibility(populated())
  assert.ok(eligibility['leadership-framing'], 'leadership was marked assessable with none recorded')
  assert.match(eligibility['leadership-framing']!, /not counted against you/i)
})

test('leadership becomes assessable once any of its forms exists', () => {
  for (const over of [
    { chargeExperience: true },
    { preceptorExperience: true },
    { committees: ['Sepsis committee'] },
    { specialResponsibilities: ['Rapid response'] },
  ]) {
    const eligibility = rubricEligibility(resumeWith([summary('A.'), clinical(over)]))
    assert.equal(eligibility['leadership-framing'], null, JSON.stringify(over))
  }
})

test('critical-care presentation is always assessed — what is written decides its ceiling', () => {
  // Without a critical-care role it scores zero through the evidence ceiling
  // (see evidence.test.ts); it no longer drops out of the denominator.
  assert.equal(rubricEligibility(resumeWith([summary('A summary with words in it.')]))['critical-care-presentation'], null)
  assert.equal(rubricEligibility(populated())['critical-care-presentation'], null)
})

test('only Leadership can be excluded for being absent; unwritten categories stay in', () => {
  // Nothing written is not the same as not applicable. An empty resume keeps
  // every other writing category in the denominator, where the evidence
  // ceilings score it zero.
  const empty = createResume({ id: 'r', userId: 'u', title: 'T', sectionIds: ids(20), now: NOW })
  const eligibility = rubricEligibility(empty)
  assert.ok(eligibility['leadership-framing'], 'leadership was assessable with none recorded')
  for (const id of WRITING.filter((w) => w !== 'leadership-framing')) {
    assert.equal(eligibility[id], null, `${id} was excluded on an empty resume`)
  }
})

// ---------------------------------------------- eligibility overrules

test('a model that scores an absent category is overruled', () => {
  // The load-bearing guarantee. A prompt instruction is advice; this is not.
  const eligibility = rubricEligibility(populated())
  const { categories } = parseRubric(
    { categories: [{ id: 'leadership-framing', score: 2, strengths: [], weaknesses: ['No leadership shown.'], improvements: [] }] },
    eligibility
  )
  const leadership = categories.find((c) => c.id === 'leadership-framing')!
  assert.equal(leadership.earned, null, 'a 2/8 for having no leadership survived')
  assert.match(leadership.notAssessed!, /not counted against you/i)
})

test('an overruled category cannot drag the sub-score down', () => {
  const eligibility = rubricEligibility(populated())
  const { categories } = parseRubric(
    {
      categories: [
        ...WRITING.filter((id) => id !== 'leadership-framing').map((id) => ({
          id, score: categoriesOf('writing-quality').find((c) => c.id === id)!.maxPoints,
          strengths: ['Clear.'], weaknesses: [], improvements: [],
        })),
        { id: 'leadership-framing', score: 0, strengths: [], weaknesses: [], improvements: [] },
      ],
    },
    eligibility
  )
  const result = compose({ categories, revision: 1, now: NOW })
  assert.equal(result.writingQuality.points, 60)
})

// ------------------------------------------------------- the prompt

test('the prompt forbids every penalty the design forbids', () => {
  const system = rubricSystemPrompt()
  for (const phrase of ['admission', 'competitiveness', 'GPA', 'certification', 'shadowing hours', 'leadership']) {
    assert.ok(system.includes(phrase), `the prompt does not mention "${phrase}"`)
  }
  assert.match(system, /PRESENTATION/)
  assert.match(system, /never score such a category zero/i)
  assert.match(system, /not have figures|no figures|without figures|has no figures/i)
})

test('the prompt judges presentation, not the applicant', () => {
  const system = rubricSystemPrompt()
  assert.match(system, /small community ICU can score full marks/i)
})

test('the prompt tells the reviewer to score only what is written', () => {
  assert.match(rubricSystemPrompt(), /only what is written/i)
  const { user } = buildRubricPrompt(populated())
  assert.equal(/never the amount/i.test(user), false, 'the reviewer is still told to ignore how much is written')
})

test('the prompt shows the resume as it would print, and no contact details', () => {
  const resume = populated()
  const { user } = buildRubricPrompt(resume)
  assert.ok(user.includes('Titrated vasoactive infusions'), 'the bullets are missing')
  assert.equal(user.includes('j@example.test'), false, 'an email reached the reviewer')
  assert.equal(user.includes('Jordan Ellery'), false, 'the applicant’s name reached the reviewer')
})

test('the prompt marks the unassessable categories as such', () => {
  const { user } = buildRubricPrompt(populated())
  assert.match(user, /leadership-framing[^\n]*NOT ASSESSABLE/)
  assert.match(user, /clinical-specificity \(max 14\)/)
})

test('the same resume builds the same prompt', () => {
  const resume = populated()
  assert.deepEqual(buildRubricPrompt(resume), buildRubricPrompt(resume))
})

// -------------------------------------------- reading the reply

test('a well-formed reply is read', () => {
  const eligibility = rubricEligibility(populated())
  const { categories } = parseRubric(
    {
      categories: WRITING.map((id) => ({
        id, score: 5, strengths: ['Specific.'], weaknesses: ['Long.'], improvements: ['Trim it.'],
      })),
    },
    eligibility
  )
  const specificity = categories.find((c) => c.id === 'clinical-specificity')!
  assert.equal(specificity.earned, 5)
  assert.deepEqual(specificity.improvements, ['Trim it.'])
})

test('a score above the category maximum is clamped', () => {
  const { categories } = parseRubric(
    { categories: [{ id: 'clinical-specificity', score: 99, strengths: [], weaknesses: [], improvements: [] }] },
    rubricEligibility(populated())
  )
  assert.equal(categories.find((c) => c.id === 'clinical-specificity')!.earned, 14)
})

test('a malformed reply yields not-assessed, never zeros', () => {
  // A parsing failure is our problem. Charging the applicant points for it
  // would be absurd.
  for (const raw of ['not json', null, 42, { categories: 'nope' }, {}, { categories: [{ id: 'nonsense' }] }]) {
    const { categories } = parseRubric(raw, rubricEligibility(populated()))
    for (const c of categories) {
      assert.notEqual(c.earned, 0, `a malformed reply produced a zero for ${c.id}`)
    }
  }
})

test('a fenced JSON reply is still read', () => {
  const raw = '```json\n{"categories":[{"id":"clarity-and-tone","score":7,"strengths":["Clear."],"weaknesses":[],"improvements":[]}]}\n```'
  const { categories } = parseRubric(raw, rubricEligibility(populated()))
  assert.equal(categories.find((c) => c.id === 'clarity-and-tone')!.earned, 7)
})

test('every writing category comes back, whether the model mentioned it or not', () => {
  const { categories } = parseRubric({ categories: [] }, rubricEligibility(populated()))
  assert.deepEqual(categories.map((c) => c.id).sort(), [...WRITING].sort())
})

test('an unreachable model leaves the writing half unassessed, not zero', () => {
  const categories = rubricUnavailable('The writing review could not be run just now.')
  assert.equal(categories.length, WRITING.length)
  for (const c of categories) assert.equal(c.earned, null)

  // And the applicant still gets their Data Quality score.
  const result = compose({ categories, revision: 1, now: NOW })
  assert.equal(result.writingQuality.points, 0)
  assert.ok(result.writingQuality.notAssessed)
})

// -------------------------------------------------- admissions language

test('an admissions claim from the model is dropped before anyone reads it', () => {
  const eligibility = rubricEligibility(populated())
  const { categories, droppedLines } = parseRubric(
    {
      categories: [{
        id: 'clinical-specificity',
        score: 10,
        strengths: ['Specific and concrete.'],
        weaknesses: ['This will hurt your chances of admission.'],
        improvements: ['Most programs require 2000 ICU hours.', 'Name the therapy you titrated.'],
      }],
    },
    eligibility
  )
  const result = categories.find((c) => c.id === 'clinical-specificity')!
  assert.deepEqual(result.weaknesses, [], 'an admissions claim reached the applicant')
  assert.deepEqual(result.improvements, ['Name the therapy you titrated.'])
  assert.equal(droppedLines, 2, 'the drop was not reported for logging')
  assert.equal(result.earned, 10, 'dropping a line changed the score')
})

test('the filter catches the phrasings that turn a note into a prediction', () => {
  for (const line of [
    'This improves your chances.',
    'Programs require CCRN.',
    'Most programs expect 3 years.',
    'You have a 40% chance of being accepted.',
    'This makes you more competitive.',
    'Required by admissions committees.',
  ]) {
    assert.equal(containsAdmissionsClaim(line), true, `missed: "${line}"`)
  }
})

test('ordinary writing feedback survives the filter', () => {
  const lines = [
    'Your bullets are specific and concrete.',
    'This line reads like a job description.',
    'Say what you decided, not what the unit does.',
    'A figure here would make the line stronger — what was it?',
    'Strong, clear opening sentence.',
    'The second role could be tightened.',
  ]
  assert.deepEqual(withoutAdmissionsClaims(lines), lines)
})

test('parsing is pure and mutates nothing', () => {
  const raw = { categories: [{ id: 'clarity-and-tone', score: 6, strengths: ['A.'], weaknesses: [], improvements: [] }] }
  const before = JSON.stringify(raw)
  parseRubric(raw, rubricEligibility(populated()))
  assert.equal(JSON.stringify(raw), before)
})

// -------------------------------------------------------- fixed headings

test('the writing review sees the fixed summary heading, never a stored label', () => {
  const labelled = { ...summary('Six years in a medical ICU.'), label: 'About Me' } as ResumeSectionV2
  const { user } = buildRubricPrompt(resumeWith([labelled, clinical()]))
  assert.ok(user.includes('## Professional Summary'), 'the model was not shown the heading that prints')
  assert.equal(user.includes('About Me'), false, 'the model was shown a heading that prints nowhere')
})
