import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  applyWritingCeilings, assessWording, bulletWeight, contentCurve, countWords, developedCeiling,
  isConcrete, isStock, measureEvidence, summaryFloor, writingCeilings,
} from './evidence.ts'
import { category } from './types.ts'
import type { CategoryResult } from './types.ts'
import { containsAdmissionsClaim } from './language.ts'
import { createResume, emptyContact } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createBullet, createClinicalPosition, createSection } from '../model/sections.ts'
import { resumeDateFromParts } from '../model/dates.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * How much there is to judge, measured by code rather than by the reviewer.
 * These ceilings are what stop a summary and a job title scoring like a finished
 * resume, so every rule is pinned: how a bullet is weighed, what counts once,
 * and the deliberately narrow wording check.
 */

const NOW = '2026-09-15T09:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)
const DATES = { start: resumeDateFromParts(2021, 3), end: { kind: 'absent' as const }, isCurrent: true }

function resumeWith(sections: readonly ResumeSectionV2[]): ResumeV2 {
  const base = createResume({ id: 'r', userId: 'u', title: 'T', sectionIds: ids(20), now: NOW })
  return { ...base, contact: { ...emptyContact(), fullName: 'Jordan Ellery' }, sections }
}
const summary = (text: string) =>
  ({ ...createSection('summary', 'sm'), text: createAuthoredText(text) }) as ResumeSectionV2
const role = (type: 'critical_care' | 'other_clinical', bullets: string[], id = 'p1') =>
  ({
    ...createSection(type, `sec-${type}-${id}`),
    positions: [{
      ...createClinicalPosition(id, { employer: 'University Hospital', role: 'RN', dates: DATES }),
      bullets: bullets.map((b) => createBullet(b)),
    }],
  }) as ResumeSectionV2
const close = (actual: number, expected: number, label = '') =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label} expected ${expected}, got ${actual}`)

const STRONG = [
  'Managed ventilated septic shock patients on vasoactive infusions in a 24-bed medical ICU.',
  'Initiated and troubleshot CRRT circuits, coordinating anticoagulation and fluid goals with nephrology.',
  'Titrated sedation and paralytics during proning for ARDS, tracking plateau pressures with respiratory therapy.',
]
const UAT_SUMMARY =
  'Critical care registered nurse with four years of MICU/CCU experience. Experienced with CRRT, ECMO, ' +
  'arterial lines, and vasoactive infusions. Charge nurse experience and active participation in code response.'

// ------------------------------------------------------------------ counting

test('words are counted by whitespace, however the text is spaced', () => {
  assert.equal(countWords('Titrated   vasoactive\ninfusions overnight.'), 4)
  assert.equal(countWords('   '), 0)
})

test('a bullet weighs by whether it says enough to be judged', () => {
  for (const [words, weight] of [[0, 0], [5, 0], [6, 0.6], [9, 0.6], [10, 1], [40, 1]] as const) {
    assert.equal(bulletWeight(words), weight, `${words} words`)
  }
})

test('the developed-bullet ladder rises in straight lines to full at five', () => {
  for (const [weight, ceiling] of [[0, 0], [1, 0.45], [2, 0.65], [3, 0.8], [4, 0.9], [5, 1], [9, 1]] as const) {
    close(developedCeiling(weight), ceiling, `weight ${weight}`)
  }
  close(developedCeiling(0.6), 0.27, 'one short bullet')
  close(developedCeiling(2.5), 0.725, 'between steps')
})

test('a summary lifts a resume with no bullets a little, and never near full', () => {
  for (const [words, floor] of [[0, 0], [9, 0], [10, 0.08], [24, 0.08], [25, 0.15], [300, 0.15]] as const) {
    assert.equal(summaryFloor(words), floor, `${words} words`)
  }
})

test('the clarity and organisation curve is gentle, and full at eighty words', () => {
  assert.equal(contentCurve(0), 0)
  close(contentCurve(20), 0.5)
  close(contentCurve(80), 1)
  assert.equal(contentCurve(500), 1)
  assert.ok(contentCurve(60) > 0.85, 'a concise resume is held back for brevity')
})

// ------------------------------------------------------------ what counts once

test('a repeated bullet counts once, whatever its casing or position', () => {
  const line = 'Managed CRRT circuits for septic patients overnight.'
  const evidence = measureEvidence(resumeWith([
    role('critical_care', [line, line.toUpperCase()], 'p1'),
    role('other_clinical', [line], 'p2'),
  ]))
  assert.equal(evidence.substantiveRoleBullets, 1)
  close(evidence.roleWeight, 0.6)
})

test('a short line is not a developed bullet', () => {
  const evidence = measureEvidence(resumeWith([role('critical_care', ['Charge.', 'Vent care.', 'ICU nurse on nights.'])]))
  assert.equal(evidence.substantiveRoleBullets, 0)
  assert.equal(evidence.roleWeight, 0)
})

test('critical-care evidence comes only from the critical-care section', () => {
  const evidence = measureEvidence(resumeWith([role('other_clinical', STRONG)]))
  assert.equal(evidence.criticalCarePositions, 0)
  assert.equal(evidence.criticalCareWeight, 0)
  close(evidence.roleWeight, 3)
  const ceilings = writingCeilings(evidence)
  assert.equal(ceilings['critical-care-presentation'], 0, 'a non-ICU job was scored as critical-care work')
  close(ceilings['clinical-specificity'], 0.8)
})

test('a summary alone never supports a high clinical score', () => {
  const ceilings = writingCeilings(measureEvidence(resumeWith([summary(UAT_SUMMARY), role('critical_care', [])])))
  close(ceilings['clinical-specificity'], 0.15)
  close(ceilings['accomplishment-focus'], 0.15)
  close(ceilings['critical-care-presentation'], 0.15)
})

test('a bare job title supports nothing', () => {
  const ceilings = writingCeilings(measureEvidence(resumeWith([role('critical_care', [])])))
  for (const [id, value] of Object.entries(ceilings)) assert.equal(value, 0, id)
})

test('described leadership entries add half credit, to accomplishment focus only', () => {
  const leadership = {
    ...createSection('leadership', 'ld'),
    entries: [{
      id: 'l1', role: 'Committee member', organization: 'University Hospital', dates: DATES,
      detail: createAuthoredText('Audited sepsis bundle compliance monthly and presented the findings to staff.'),
    }],
  } as ResumeSectionV2
  const evidence = measureEvidence(resumeWith([role('critical_care', STRONG.slice(0, 2)), leadership]))
  close(evidence.roleWeight, 2)
  close(evidence.accomplishmentWeight, 2.5)
  const ceilings = writingCeilings(evidence)
  assert.ok(ceilings['accomplishment-focus'] > ceilings['clinical-specificity'])
})

test('organisation is halved only for a single-section resume', () => {
  const words = Array.from({ length: 100 }, () => 'word').join(' ')
  assert.equal(writingCeilings(measureEvidence(resumeWith([summary(words)])))['organisation-readability'], 0.5)
  assert.equal(
    writingCeilings(measureEvidence(resumeWith([summary(words), role('critical_care', STRONG)])))['organisation-readability'], 1
  )
})

// ---------------------------------------------------------- the wording check

test('clinical detail is recognised as concrete', () => {
  for (const line of [
    'Titrated norepinephrine to maintain perfusion goals.',
    'Managed CRRT and ECMO circuits overnight.',
    'Cared for 2 patients on continuous infusions.',
    'Precepted new graduate nurses through orientation.',
    'Responsible for titrating vasoactive infusions in septic shock.',
  ]) assert.equal(isConcrete(line), true, line)
  assert.equal(isConcrete('Provided quality patient care to critically ill patients.'), false)
})

test('only clearly stock phrasing is stock', () => {
  for (const line of [
    'Provided quality patient care to critically ill patients.',
    'Responsible for various nursing duties as assigned.',
    'Worked closely with the healthcare team to meet patient needs.',
  ]) assert.equal(isStock(line), true, line)
  for (const line of [
    'Administered medications and documented care in the electronic health record.',
    'Educated patients and families about discharge plans and follow-up appointments.',
    'Communicated changes in patient condition promptly to the covering provider.',
  ]) assert.equal(isStock(line), false, line)
})

test('ordinary nursing language stays neutral and never triggers the check', () => {
  const report = assessWording([
    'Administered medications and documented care in the electronic health record.',
    'Educated patients and families about discharge plans and follow-up appointments.',
    'Communicated changes in patient condition promptly to the covering provider.',
  ])
  assert.equal(report.stock, 0)
  assert.equal(report.neutral, 3)
  assert.equal(report.predominantlyStock, false)
  assert.equal(report.factor, 1)
})

test('a stock phrase beside clinical detail counts as concrete, not stock', () => {
  const report = assessWording(['Responsible for titrating vasoactive infusions in septic shock.'])
  assert.equal(report.concrete, 1)
  assert.equal(report.stock, 0)
  assert.equal(report.factor, 1)
})

test('predominantly stock bullets with no concrete detail are capped', () => {
  const report = assessWording([
    'Provided quality patient care to critically ill patients.',
    'Responsible for various nursing duties as assigned.',
    'Worked closely with the healthcare team to meet patient needs.',
    'Administered medications and documented care in the electronic health record.',
  ])
  assert.equal(report.stock, 3)
  assert.equal(report.predominantlyStock, true)
  close(report.factor, 0.35)
})

test('the check stays off once concrete detail is more than a fifth of the bullets', () => {
  const report = assessWording([
    'Provided quality patient care to critically ill patients.',
    'Responsible for various nursing duties as assigned.',
    'Worked closely with the healthcare team to meet patient needs.',
    'Titrated vasoactive infusions for septic shock patients.',
    'Managed CRRT circuits and anticoagulation overnight.',
  ])
  assert.equal(report.predominantlyStock, false)
  assert.equal(report.factor, 1)
})

test('the wording factor eases as stock lines thin out, and never falls below 0.35', () => {
  close(assessWording(['Provided quality patient care to all patients.', 'Responsible for various nursing duties as assigned.']).factor, 0.35)
  close(assessWording([
    'Provided quality patient care to critically ill patients.',
    'Responsible for various nursing duties as assigned.',
    'Administered medications and documented care in the electronic health record.',
    'Educated patients and families about discharge plans and follow-up appointments.',
  ]).factor, 0.5)
})

// ------------------------------------------------------- applying the ceilings

const sparse = () => measureEvidence(resumeWith([summary(UAT_SUMMARY), role('critical_care', [])]))

test('a reviewer score above its ceiling is lowered, and the reason is given', () => {
  const [capped] = applyWritingCeilings([category('clinical-specificity', 12, { strengths: ['Specific.'] })], sparse())
  close(capped.earned!, 2.1)
  assert.deepEqual(capped.strengths, ['Specific.'])
  assert.ok(capped.weaknesses.length > 0 && capped.improvements.length > 0, 'a lowered score was not explained')
})

test('a score within its ceiling is left exactly as the reviewer gave it', () => {
  const input = category('clarity-and-tone', 3, { strengths: ['Clear.'] })
  assert.deepEqual(applyWritingCeilings([input], sparse()), [input])
})

test('leadership and the data-quality categories are never capped', () => {
  const input: CategoryResult[] = [
    category('leadership-framing', 8),
    category('leadership-framing', null, { notAssessed: 'None recorded.' }),
    category('section-completeness', 10),
    category('content-hygiene', 8),
  ]
  assert.deepEqual(applyWritingCeilings(input, sparse()), input)
})

test('a category the reviewer declined scores zero when almost nothing is written', () => {
  const [declined] = applyWritingCeilings([category('accomplishment-focus', null, { notAssessed: 'Nothing to assess.' })], sparse())
  assert.equal(declined.earned, 0, 'an unwritten category left the denominator')
  assert.ok(declined.weaknesses.length > 0)
})

test('a category the reviewer declined on a developed resume stays unassessed', () => {
  const developed = measureEvidence(resumeWith([
    summary('A focused summary of critical care work in a busy medical intensive care unit over several years.'),
    role('critical_care', [...STRONG, 'Recognised early deterioration and escalated to rapid response before an unplanned intubation.']),
  ]))
  const input = category('clarity-and-tone', null, { notAssessed: 'The reviewer did not return this category.' })
  assert.deepEqual(applyWritingCeilings([input], developed), [input])
})

test('stock wording lowers the clinical ceilings and says so', () => {
  const vague = measureEvidence(resumeWith([role('critical_care', [
    'Provided quality patient care to critically ill patients.',
    'Responsible for various nursing duties as assigned.',
    'Worked closely with the healthcare team to meet patient needs.',
    'Assisted with admissions, discharges and transfers as needed.',
    'Maintained a safe and clean environment for patients and staff.',
  ])]))
  assert.equal(vague.wording.predominantlyStock, true)
  const [capped] = applyWritingCeilings([category('clinical-specificity', 14)], vague)
  assert.ok(capped.earned! < 7, `stock bullets kept ${capped.earned}/14`)
  assert.ok(capped.weaknesses.some((w) => /stock/i.test(w)), 'the wording reason was not given')
})

test('nothing the ceilings say mentions admission', () => {
  const ids = ['clinical-specificity', 'accomplishment-focus', 'critical-care-presentation', 'clarity-and-tone', 'organisation-readability'] as const
  const lines = applyWritingCeilings(ids.map((id) => category(id, null)), measureEvidence(resumeWith([])))
    .flatMap((c) => [...c.weaknesses, ...c.improvements])
  assert.ok(lines.length > 0)
  for (const line of lines) assert.equal(containsAdmissionsClaim(line), false, line)
})

test('measuring and capping mutate nothing they are given', () => {
  const resume = resumeWith([summary('Short summary.'), role('critical_care', STRONG)])
  const before = JSON.stringify(resume)
  const input = [category('clinical-specificity', 14)]
  const snapshot = JSON.stringify(input)
  applyWritingCeilings(input, measureEvidence(resume))
  assert.equal(JSON.stringify(resume), before)
  assert.equal(JSON.stringify(input), snapshot)
})

test('the evidence layer never reads a GPA, an hour count or a credential', () => {
  const source = readFileSync(fileURLToPath(new URL('./evidence.ts', import.meta.url)), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const forbidden of ['overallGpa', 'scienceGpa', 'showOnResume', '.hours', 'gpa', 'certifications']) {
    assert.equal(code.includes(forbidden), false, `evidence.ts consults "${forbidden}"`)
  }
})
