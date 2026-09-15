import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreDeterministic } from './deterministic.ts'
import { rubricEligibility } from './rubric.ts'
import { applyWritingCeilings, measureEvidence } from './evidence.ts'
import { compose } from './compose.ts'
import { CATEGORY_BY_ID, categoriesOf, category } from './types.ts'
import type { CategoryId, StrengthResult } from './types.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * The calibration ladder: what a score in each band has to mean.
 *
 * The UAT resume -- a summary, one job title with no bullets and a CCRN -- scored
 * 85. Each rung below is a resume, and each assertion is a sentence about what
 * its number must say. The reviewer is a model and cannot run in a test, so it
 * is simulated twice: GENEROUS gives every resume the ratios the UAT reviewer
 * actually gave that near-empty resume, and HIGH rates the writing as excellent.
 * The ceilings have to hold under both, because the UAT showed the reviewer
 * will be generous.
 */

const NOW = '2026-09-15T09:00:00.000Z'
const WRITING = categoriesOf('writing-quality').map((c) => c.id)
const d = resumeDateFromParts
const CURRENT = { start: d(2021, 3), end: { kind: 'absent' as const }, isCurrent: true }
const PAST = { start: d(2018, 6), end: d(2021, 2), isCurrent: false }

type Ratios = Partial<Record<CategoryId, number>>
const GENEROUS: Ratios = {
  'clinical-specificity': 12 / 14, 'accomplishment-focus': 10 / 12, 'critical-care-presentation': 11 / 12,
  'leadership-framing': 7 / 8, 'clarity-and-tone': 7 / 8, 'organisation-readability': 5 / 6,
}
const HIGH: Ratios = {
  'clinical-specificity': 0.93, 'accomplishment-focus': 0.9, 'critical-care-presentation': 0.93,
  'leadership-framing': 0.88, 'clarity-and-tone': 0.9, 'organisation-readability': 0.9,
}
const STRICT_VAGUE: Ratios = {
  'clinical-specificity': 0.3, 'accomplishment-focus': 0.25, 'critical-care-presentation': 0.35,
  'clarity-and-tone': 0.6, 'organisation-readability': 0.5,
}

/** The route, with the reviewer simulated: eligibility, then the ceilings, then composition. */
function score(resume: ResumeV2, ratios: Ratios): StrengthResult {
  const eligibility = rubricEligibility(resume)
  const reviewed = WRITING.map((id) => eligibility[id]
    ? category(id, null, { notAssessed: eligibility[id]! })
    : category(id, (ratios[id] ?? 0) * CATEGORY_BY_ID[id].maxPoints))
  const writing = applyWritingCeilings(reviewed, measureEvidence(resume))
  return compose({ categories: [...scoreDeterministic(resume), ...writing], revision: 1, now: NOW })
}
const earned = (result: StrengthResult, id: CategoryId) =>
  [...result.dataQuality.categories, ...result.writingQuality.categories].find((c) => c.id === id)!.earned

// ------------------------------------------------------------------ the resumes

const CONTACT = { ...emptyContact(), fullName: 'Jordan Ellery', email: 'j@example.test', phone: '555-0142', city: 'Newark', state: 'NJ' }
const blank = () => createResume({ id: 'r', userId: 'u', title: 'T', sectionIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], now: NOW })
const build = (sections: readonly ResumeSectionV2[]): ResumeV2 => ({ ...blank(), contact: CONTACT, sections })
const summary = (text: string) => ({ ...createSection('summary', 'sum'), text: createAuthoredText(text) }) as ResumeSectionV2
const job = (id: string, facts: object, bullets: readonly string[]) =>
  ({ ...createClinicalPosition(id, facts), bullets: bullets.map((b) => createBullet(b)) })
const section = (type: 'critical_care' | 'other_clinical', positions: readonly object[]) =>
  ({ ...createSection(type, `sec-${type}`), positions }) as ResumeSectionV2
const MICU = { employer: 'University Hospital', role: 'Registered Nurse', unit: 'MICU/CCU', location: 'Newark, NJ', dates: CURRENT }
const EDUCATION = {
  ...createSection('education', 'edu'),
  entries: [{ id: 'e1', degree: 'BSN', field: 'Nursing', institution: 'Rutgers University', location: 'Newark, NJ', graduationDate: d(2018, 5), overallGpa: parseGpa('3.9', true), scienceGpa: parseGpa('3.8', true), honors: '' }],
} as ResumeSectionV2
const LICENSURE = { ...createSection('licensure', 'lic'), licenses: [{ id: 'l1', licenseType: 'RN', state: 'NJ', identifier: '', isCompact: true, expires: d(2027, 6) }] } as ResumeSectionV2
const certifications = (withDates: boolean) => ({
  ...createSection('certifications', 'cert'),
  certifications: [{ id: 'c1', name: 'CCRN', issuer: 'AACN', identifier: '', earned: withDates ? d(2023, 1) : { kind: 'absent' as const }, expires: withDates ? d(2026, 1) : { kind: 'absent' as const } }],
}) as ResumeSectionV2

const STRONG = [
  'Managed ventilated septic shock patients on vasoactive infusions in a 24-bed medical ICU.',
  'Initiated and troubleshot CRRT circuits, coordinating anticoagulation and fluid goals with nephrology.',
  'Titrated sedation and paralytics during proning for ARDS, tracking plateau pressures with respiratory therapy.',
  'Recognised early deterioration and escalated to rapid response, preventing unplanned intubations on nights.',
]
const VAGUE = [
  'Provided quality patient care to critically ill patients.',
  'Responsible for various nursing duties as assigned.',
  'Worked closely with the healthcare team to meet patient needs.',
  'Assisted with admissions, discharges and transfers as needed.',
  'Administered medications and documented care in the electronic health record.',
  'Communicated with patients and families about their plan of care.',
  'Maintained a safe and clean environment for patients and staff.',
]
const CONCISE_SUMMARY = 'Critical care registered nurse with four years in a high-acuity medical ICU, experienced with CRRT, vasoactive titration and ventilator management. Known for early recognition of deterioration and calm escalation.'

const EMPTY = { ...blank(), contact: emptyContact() }
const BARE_TITLE = build([section('critical_care', [job('p1', MICU, [])])])
/** The UAT resume: its dates reproduce the report's 4/8, and its CCRN has none. */
const SPARSE_UAT = build([
  summary('Critical care registered nurse with four years of MICU/CCU experience. Experienced with CRRT, ECMO, arterial lines, and vasoactive infusions. Charge nurse experience and active participation in code response.'),
  section('critical_care', [job('p1', { ...MICU, dates: { start: { kind: 'unparsed', raw: 'Spring 2021' }, end: { kind: 'absent' }, isCurrent: true } }, [])]),
  certifications(false),
])
const LONG_VAGUE = build([
  summary('Dedicated and compassionate registered nurse with a strong work ethic and a passion for helping others. Hard-working team player who is detail-oriented and committed to providing excellent patient care in a fast-paced environment. Eager to keep growing professionally and contribute to a dynamic healthcare team.'),
  section('critical_care', [job('p1', MICU, VAGUE), job('p2', { ...MICU, employer: 'Mercy Medical Center', dates: PAST }, VAGUE.slice(0, 6))]),
  section('other_clinical', [job('p3', { employer: 'Valley Hospital', role: 'Registered Nurse', unit: 'Med-Surg', location: 'Paterson, NJ', dates: { start: d(2016, 6), end: d(2018, 5), isCurrent: false } }, VAGUE.slice(0, 5))]),
  EDUCATION, LICENSURE,
])
const concise = (bullets: number) => build([summary(CONCISE_SUMMARY), section('critical_care', [job('p1', MICU, STRONG.slice(0, bullets))])])
const DETAILED = build([
  summary('Critical care registered nurse with six years across medical ICU and cardiac step-down care, experienced with CRRT, proning, vasoactive titration and ventilator management. Trusted as relief charge nurse and preceptor, known for early recognition of deterioration and clear communication.'),
  section('critical_care', [job('p1', { ...MICU, chargeExperience: true, preceptorExperience: true }, [...STRONG,
    'Precepted six new graduate nurses through twelve-week orientation using unit competency checklists.',
    'Served as relief charge nurse for a 20-bed unit, balancing acuity-based assignments and bed flow.'])]),
  section('other_clinical', [job('p2', { employer: 'Mercy Medical Center', role: 'Registered Nurse', unit: 'Cardiac step-down', location: 'Newark, NJ', dates: PAST }, [
    'Monitored telemetry after cardiac catheterisation and managed heparin and nitroglycerin infusions.',
    'Taught heart-failure self-management to patients and families before discharge.',
    'Floated across three cardiac units, adapting quickly to differing protocols.'])]),
  EDUCATION, LICENSURE, certifications(true),
  { ...createSection('leadership', 'lead'), entries: [{ id: 'ld1', role: 'Sepsis committee member', organization: 'University Hospital', dates: CURRENT, detail: createAuthoredText('Audited sepsis bundle compliance monthly and presented findings that shortened time to first antibiotic on nights.') }] } as ResumeSectionV2,
])

// ---------------------------------------------------------------- the report

test('the reported 85 is exactly what the displayed categories compose to', () => {
  const displayed = [
    category('section-completeness', 10), category('contact-completeness', 8), category('date-integrity', 4),
    category('content-hygiene', 8), category('length-and-fit', 3), category('clinical-specificity', 12),
    category('accomplishment-focus', 10), category('critical-care-presentation', 11),
    category('leadership-framing', null, { notAssessed: 'None recorded.' }), category('clarity-and-tone', 7),
    category('organisation-readability', 5),
  ]
  assert.equal(compose({ categories: displayed, revision: 1, now: NOW }).score, 85)
})

test('the UAT fixture reproduces the report where the report was right', () => {
  const result = score(SPARSE_UAT, GENEROUS)
  assert.equal(earned(result, 'contact-completeness'), 8)
  assert.equal(earned(result, 'date-integrity'), 4)
  assert.equal(earned(result, 'length-and-fit'), 3)
})

// ------------------------------------------------------------------ the ladder

test('an empty resume scores near zero', () => {
  for (const ratios of [GENEROUS, HIGH]) assert.ok(score(EMPTY, ratios).score <= 5)
})

test('a name and a bare job title stay at or under 25', () => {
  for (const ratios of [GENEROUS, HIGH]) {
    const result = score(BARE_TITLE, ratios)
    assert.ok(result.score <= 25, `bare job title scored ${result.score}`)
  }
})

test('the sparse UAT resume lands at 30–40, even with the reviewer that gave it 85', () => {
  const result = score(SPARSE_UAT, GENEROUS)
  assert.ok(result.score >= 30 && result.score <= 40, `sparse UAT resume scored ${result.score}`)
})

test('a long, vague resume sits well below a concise strong one', () => {
  assert.ok(score(concise(4), GENEROUS).score - score(LONG_VAGUE, GENEROUS).score >= 15, 'generous reviewer')
  assert.ok(score(concise(4), HIGH).score - score(LONG_VAGUE, STRICT_VAGUE).score >= 15, 'realistic reviewer')
})

test('a concise strong resume with three or four developed critical-care bullets can reach 85', () => {
  for (const bullets of [3, 4]) {
    const result = score(concise(bullets), HIGH)
    assert.ok(result.score >= 85, `${bullets} bullets scored ${result.score}`)
  }
})

test('a detailed strong resume reaches the low-to-mid 90s', () => {
  const result = score(DETAILED, HIGH)
  assert.ok(result.score >= 90 && result.score <= 96, `detailed resume scored ${result.score}`)
})

test('the rungs stay in order under a generous reviewer', () => {
  const [empty, bare, sparse, vague, strong, detailed] =
    [EMPTY, BARE_TITLE, SPARSE_UAT, LONG_VAGUE, concise(4), DETAILED].map((r) => score(r, GENEROUS).score)
  assert.ok(empty < bare && bare < sparse && sparse < vague && vague < strong && strong <= detailed,
    `order broke: ${[empty, bare, sparse, vague, strong, detailed].join(' < ')}`)
})

// ------------------------------------------------------------- the locked rules

test('the concise resume has no optional sections, and Leadership is excluded rather than scored', () => {
  const types = concise(4).sections.map((s) => s.type)
  assert.deepEqual(types, ['summary', 'critical_care'])
  assert.equal(earned(score(concise(4), HIGH), 'leadership-framing'), null)
})

test('adding certifications, a GPA or shadowing never lowers the score', () => {
  const shadowing = {
    ...createSection('shadowing', 'sh'),
    experiences: [{ id: 'sh1', providerName: 'A. Smith', credential: 'CRNA', setting: 'OR', facility: 'University Hospital', hours: '24', dates: CURRENT, reflection: createAuthoredText('Observed induction and emergence for cardiac cases.') }],
  } as ResumeSectionV2
  const without = score(concise(4), HIGH).score
  const withAll = score({ ...concise(4), sections: [...concise(4).sections, EDUCATION, certifications(true), shadowing] }, HIGH).score
  assert.ok(withAll >= without, `optional sections lowered the score: ${without} → ${withAll}`)
})

test('categories with nothing written score zero rather than leaving the denominator', () => {
  const result = score(BARE_TITLE, GENEROUS)
  for (const id of ['clinical-specificity', 'accomplishment-focus', 'critical-care-presentation', 'clarity-and-tone', 'organisation-readability'] as const) {
    assert.equal(earned(result, id), 0, id)
  }
  assert.equal(earned(result, 'leadership-framing'), null)
})
