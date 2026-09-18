import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ICU_CATEGORIES, alreadyHasFact, filterCategories, groupSelections, mergeFacts, sameFact,
} from './icuCatalogue.ts'
import type { IcuSelection } from './icuCatalogue.ts'
import { POSITION_LISTS, applyPatches } from './patch.ts'
import type { StudioPatch } from './patch.ts'
import { positionFacts } from '../ai/factSheet.ts'
import { blockFor } from '../document/plan.ts'
import { createResume } from '../model/resume.ts'
import { createClinicalPosition, createSection } from '../model/sections.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * The ICU experience catalogue.
 *
 * A vocabulary, not a claim: what it offers is what an applicant may tick, and
 * an unticked item is the absence of a fact rather than a fact about absence.
 */

test('every category stores into a list the position model already has', () => {
  // No new column, no migration: a selection is a ClinicalFacts list entry, and
  // reaches a proposal by the path facts have always taken.
  for (const category of ICU_CATEGORIES) {
    assert.ok(
      (POSITION_LISTS as readonly string[]).includes(category.field),
      `${category.id} stores into "${category.field}", which is not a position fact list`
    )
  }
})

test('the categories the brief names are all offered', () => {
  const titles = ICU_CATEGORIES.map((c) => c.title.toLowerCase())
  for (const expected of ['devices', 'respiratory', 'medications', 'conditions', 'responsibilities']) {
    assert.ok(titles.some((title) => title.includes(expected)), `${expected} is not offered`)
  }
})

test('the catalogue carries the clinical vocabulary the brief lists', () => {
  const all = ICU_CATEGORIES.flatMap((c) => c.options).join(' | ').toLowerCase()
  for (const expected of [
    'arterial line', 'swan-ganz', 'iabp', 'impella', 'va ecmo', 'vv ecmo', 'crrt',
    'chest tubes', 'temporary pacing', 'evd', 'continuous eeg',
    'invasive mechanical ventilation', 'bipap', 'cpap', 'high-flow nasal cannula',
    'proning', 'massive transfusion', 'targeted temperature management',
    'norepinephrine', 'vasopressin', 'milrinone', 'dexmedetomidine', 'cisatracurium',
    'nicardipine', 'argatroban',
    'septic shock', 'cardiogenic shock', 'ards', 'dka', 'gi bleed', 'pulmonary embolism',
    'post-cardiac surgery', 'neurocritical care', 'trauma',
    'code blue', 'rapid response', 'charge nurse', 'precepting', 'vasoactive titration',
  ]) {
    assert.ok(all.includes(expected), `the catalogue does not offer "${expected}"`)
  }
})

test('no option carries a dose', () => {
  // A resume states that someone titrated norepinephrine, never how much. Keeping
  // numbers out of the vocabulary keeps them out of the grounding.
  for (const category of ICU_CATEGORIES) {
    for (const option of category.options) {
      assert.doesNotMatch(option, /\d+\s*(mcg|mg|ml|unit|kg|min|hr)/i, option)
    }
  }
})

test('nothing in the catalogue is a duplicate of anything else', () => {
  const seen = new Set<string>()
  for (const category of ICU_CATEGORIES) {
    for (const option of category.options) {
      const key = `${category.field}:${option.toLowerCase()}`
      assert.equal(seen.has(key), false, `${option} is offered twice in ${category.field}`)
      seen.add(key)
    }
  }
})

// ------------------------------------------------------------ searching

test('searching narrows to the options that match', () => {
  const found = filterCategories('ecmo').flatMap((c) => c.options)
  assert.deepEqual(found.sort(), ['VA ECMO', 'VV ECMO'])
})

test('searching a category keeps that whole group', () => {
  const respiratory = filterCategories('respiratory').find((c) => c.id === 'respiratory')
  assert.ok(respiratory)
  assert.equal(respiratory!.options.length, ICU_CATEGORIES.find((c) => c.id === 'respiratory')!.options.length)
})

test('an empty search is the whole catalogue, and a hopeless one is empty', () => {
  assert.equal(filterCategories('   ').length, ICU_CATEGORIES.length)
  assert.deepEqual(filterCategories('zzzzz'), [])
})

test('searching is case- and fragment-tolerant', () => {
  assert.ok(filterCategories('NOREPI').some((c) => c.options.includes('Norepinephrine')))
})

// ---------------------------------------------------------- selections

test('selections are grouped into the lists they are stored in', () => {
  const grouped = groupSelections([
    { field: 'devices', value: 'CRRT' },
    { field: 'therapies', value: 'Proning' },
    { field: 'therapies', value: 'Norepinephrine' },
    { field: 'patientPopulations', value: 'Septic shock' },
  ])
  assert.deepEqual(grouped.devices, ['CRRT'])
  // Two categories share one list: an infusion and a ventilation mode are both
  // things done to a patient.
  assert.deepEqual(grouped.therapies, ['Proning', 'Norepinephrine'])
  assert.deepEqual(grouped.patientPopulations, ['Septic shock'])
  assert.equal(grouped.specialResponsibilities, undefined)
})

test('a custom fact is grouped like any other', () => {
  const grouped = groupSelections([{ field: 'devices', value: '  Bronchoscopy assist  ' }])
  assert.deepEqual(grouped.devices, ['Bronchoscopy assist'])
})

test('a blank custom entry selects nothing', () => {
  assert.deepEqual(groupSelections([{ field: 'devices', value: '   ' }]), {})
})

test('the same thing ticked twice is one fact', () => {
  const grouped = groupSelections([
    { field: 'devices', value: 'VA ECMO' },
    { field: 'devices', value: 'va-ecmo' },
  ])
  assert.deepEqual(grouped.devices, ['VA ECMO'], 'the first spelling is what is stored')
})

test('spelling variants are the same claim', () => {
  assert.equal(sameFact('VA ECMO', 'va-ecmo'), true)
  assert.equal(sameFact('CRRT', 'crrt'), true)
  assert.equal(sameFact('CRRT', 'IABP'), false)
  assert.equal(sameFact('', 'CRRT'), false)
})

test('merging keeps what the applicant already told us', () => {
  assert.deepEqual(mergeFacts(['Ventilator'], ['CRRT']), ['Ventilator', 'CRRT'])
  assert.deepEqual(mergeFacts(['CRRT'], ['crrt']), ['CRRT'], 'a re-tick duplicated a fact')
  assert.deepEqual(mergeFacts(['CRRT'], ['  ']), ['CRRT'])
})

test('merging mutates neither list', () => {
  const existing = ['Ventilator']
  const additions = ['CRRT']
  mergeFacts(existing, additions)
  assert.deepEqual(existing, ['Ventilator'])
  assert.deepEqual(additions, ['CRRT'])
})

test('a fact already on the position is recognised', () => {
  assert.equal(alreadyHasFact(['Arterial line'], 'arterial line'), true)
  assert.equal(alreadyHasFact(['Arterial line'], 'Impella'), false)
  assert.equal(alreadyHasFact([], 'Impella'), false)
})

// ------------------------------- what a tick becomes, once it is stored

const NOW = '2026-09-10T12:00:00.000Z'
const SEC = 'sec-cc'
const POS = 'pos-1'

/** A resume holding one critical care position, as the Studio would have it. */
function resumeWithPosition(): ResumeV2 {
  const base = createResume({
    id: 'r1', userId: 'u1', title: 'T',
    sectionIds: Array.from({ length: 20 }, (_, i) => `s${i}`), now: NOW,
  })
  const section = {
    ...createSection('critical_care', SEC),
    positions: [createClinicalPosition(POS, { employer: 'University Hospital' })],
  } as ResumeSectionV2
  return { ...base, sections: [section] }
}

/** What the editor emits when the applicant confirms the picker. */
function applySelections(resume: ResumeV2, selections: readonly IcuSelection[]): ResumeV2 {
  const position = (resume.sections[0] as Extract<ResumeSectionV2, { type: 'critical_care' }>).positions[0]
  const patches: StudioPatch[] = Object.entries(groupSelections(selections)).map(([field, values]) => ({
    op: 'position-fact',
    sectionId: SEC,
    positionId: POS,
    field,
    value: mergeFacts(((position.facts as unknown as Record<string, string[]>)[field]) ?? [], values ?? []),
  }))
  return applyPatches(resume, patches, { now: NOW })
}

const positionOf = (resume: ResumeV2) =>
  (resume.sections[0] as Extract<ResumeSectionV2, { type: 'critical_care' }>).positions[0]

test('a selection persists on the position, in the list it belongs to', () => {
  const after = applySelections(resumeWithPosition(), [
    { field: 'devices', value: 'CRRT' },
    { field: 'therapies', value: 'Norepinephrine' },
    { field: 'patientPopulations', value: 'Septic shock' },
    { field: 'specialResponsibilities', value: 'Charge nurse' },
  ])
  const facts = positionOf(after).facts

  assert.deepEqual(facts.devices, ['CRRT'])
  assert.deepEqual(facts.therapies, ['Norepinephrine'])
  assert.deepEqual(facts.patientPopulations, ['Septic shock'])
  assert.deepEqual(facts.specialResponsibilities, ['Charge nurse'])
})

test('a ticked fact is grounding the applicant supplied', () => {
  const after = applySelections(resumeWithPosition(), [{ field: 'devices', value: 'VA ECMO' }])
  const facts = positionFacts(positionOf(after), 'critical_care')
  const ecmo = facts.find((f) => f.value === 'VA ECMO')

  assert.ok(ecmo, 'a ticked device never reached the fact sheet')
  assert.equal(ecmo!.kind, 'device')
  assert.ok(['user', 'import'].includes(ecmo!.provenance), ecmo!.provenance)
})

test('an unticked catalogue item is not a fact', () => {
  // The catalogue is a vocabulary, not an assertion. Nothing is true of an
  // applicant because it appears on a list they were shown.
  const after = applySelections(resumeWithPosition(), [{ field: 'devices', value: 'CRRT' }])
  const values = positionFacts(positionOf(after), 'critical_care').map((f) => f.value)

  assert.ok(values.includes('CRRT'))
  for (const unticked of ['Impella', 'VA ECMO', 'Swan-Ganz (pulmonary artery) catheter']) {
    assert.equal(values.includes(unticked), false, `${unticked} became a fact without being ticked`)
  }
})

test('a fact in their own words grounds exactly like a catalogue one', () => {
  const after = applySelections(resumeWithPosition(), [
    { field: 'specialResponsibilities', value: 'Sepsis committee lead' },
  ])
  const fact = positionFacts(positionOf(after), 'critical_care')
    .find((f) => f.value === 'Sepsis committee lead')

  assert.ok(fact, 'a custom selection was not grounding')
  assert.match(fact!.path, /^critical_care\/pos-1\//)
})

test('selecting again adds to what is there rather than replacing it', () => {
  const first = applySelections(resumeWithPosition(), [{ field: 'devices', value: 'CRRT' }])
  const second = applySelections(first, [
    { field: 'devices', value: 'Impella' },
    { field: 'devices', value: 'crrt' },
  ])
  assert.deepEqual(positionOf(second).facts.devices, ['CRRT', 'Impella'])
})

test('selections never reach the page, only the proposal', () => {
  // ClinicalFacts is grounding. V1 printed these arrays onto the resume whenever
  // a position had no bullets; ticking twelve devices must not print twelve.
  const after = applySelections(resumeWithPosition(), [{ field: 'devices', value: 'CRRT' }])
  const block = blockFor(after.sections[0])
  assert.equal(JSON.stringify(block ?? {}).includes('CRRT'), false, 'a grounding fact reached the document')
})
