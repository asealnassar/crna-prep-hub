import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_NARRATIVE_WORDS, QUALITY_IMPROVEMENT_NEEDS_DETAILS, SHADOWING_NEEDS_DETAILS,
  SUMMARY_NEEDS_TEXT, VOLUNTEER_NEEDS_DETAILS,
  assistDecision, fieldAssist, hasApplicantNarrative, summaryAssist,
} from './gating.ts'
import { createResume } from '../model/resume.ts'
import { createSection } from '../model/sections.ts'
import {
  acceptProposal, createAuthoredText, editSource, propose,
} from '../model/authoredText.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * Whether an AI action may be offered at all.
 *
 * The question asked before the five grounding layers: is there enough of the
 * applicant's own work for a proposal to be an improvement rather than an
 * invention? The verifier cannot answer it -- it can only refuse what a model
 * states, not notice that the model had nothing to work from.
 */

const NOW = '2026-09-10T12:00:00.000Z'
const LATER = '2026-09-10T13:00:00.000Z'
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

const WRITTEN = 'I watched an induction and saw how the CRNA prepared the airway trolley.'

function resume(over: Partial<ResumeV2> = {}): ResumeV2 {
  const base = createResume({ id: 'r1', userId: 'u1', title: 'T', sectionIds: ids(20), now: NOW })
  return { ...base, ...over }
}

const summarySection = (written: string): ResumeSectionV2 =>
  ({ ...createSection('summary', 'sum'), text: createAuthoredText(written) }) as ResumeSectionV2

const shadowingWith = (reflection: unknown): ResumeSectionV2 => ({
  ...(createSection('shadowing', 'sh') as unknown as Record<string, unknown>),
  experiences: [{
    id: 'sh1', providerName: 'A. Nurse', credential: 'CRNA', setting: 'OR',
    facility: 'University Hospital', hours: '40',
    dates: { start: { kind: 'absent' }, end: { kind: 'absent' }, isCurrent: false },
    reflection,
  }],
} as unknown as ResumeSectionV2)

const entrySection = (type: 'volunteer' | 'quality_improvement', detail: unknown): ResumeSectionV2 => ({
  ...(createSection(type, 'e') as unknown as Record<string, unknown>),
  entries: [{
    id: 'e1', role: 'Volunteer', title: 'CLABSI reduction', organization: 'Free clinic',
    dates: { start: { kind: 'absent' }, end: { kind: 'absent' }, isCurrent: false },
    detail,
  }],
} as unknown as ResumeSectionV2)

// ------------------------------------------------------- the summary

test('the summary may be tightened once there is a summary to tighten', () => {
  assert.equal(summaryAssist(createAuthoredText(WRITTEN)).allowed, true)
  assert.equal(summaryAssist(createAuthoredText(WRITTEN)).reason, '', 'an allowed action carried a message')
})

test('an empty or barely started summary has nothing to tighten', () => {
  for (const text of [null, undefined, createAuthoredText(''), createAuthoredText('Hard-working ICU nurse.')]) {
    const decision = summaryAssist(text)
    assert.equal(decision.allowed, false, JSON.stringify(text))
    assert.equal(decision.reason, SUMMARY_NEEDS_TEXT)
  }
})

test('tightening does not wait for the resume to be marked complete', () => {
  // It used to. Someone who wrote a good summary on day one could not tighten
  // it, and Draft vs Complete was never a statement about the summary.
  const written = summarySection(WRITTEN)
  for (const status of ['draft', 'complete'] as const) {
    const decision = assistDecision({
      resume: resume({ status, sections: [written] }),
      section: written, operation: 'tighten-summary', targetId: null, field: null,
    })
    assert.equal(decision.allowed, true, status)
  }
})

test('a draft with no summary is still refused, and says why', () => {
  const blank = summarySection('')
  const decision = assistDecision({
    resume: resume({ status: 'draft', sections: [blank] }),
    section: blank, operation: 'tighten-summary', targetId: null, field: null,
  })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, SUMMARY_NEEDS_TEXT)
})

test('the refusal says what would change it', () => {
  assert.match(SUMMARY_NEEDS_TEXT, /write your summary first/i)
})

// ----------------------------------------------------- the applicant's own

test('a field the applicant has not written has nothing to improve', () => {
  assert.equal(hasApplicantNarrative(null), false)
  assert.equal(hasApplicantNarrative(undefined), false)
  assert.equal(hasApplicantNarrative(createAuthoredText('')), false)
  assert.equal(hasApplicantNarrative(createAuthoredText('   ')), false)
})

test('a few words are not yet a narrative', () => {
  const short = createAuthoredText('It was good.')
  assert.ok(short.accepted.split(' ').length < MIN_NARRATIVE_WORDS)
  assert.equal(hasApplicantNarrative(short), false)
})

test('what the applicant actually wrote counts', () => {
  assert.equal(hasApplicantNarrative(createAuthoredText(WRITTEN)), true)
  assert.equal(hasApplicantNarrative(editSource(createAuthoredText(''), WRITTEN, NOW)), true)
})

test('accepted AI text does not unlock the next proposal', () => {
  // Otherwise one suggestion would authorise the next, and an entry would walk
  // away from anything the applicant ever said, two clicks at a time.
  const aiOnly = acceptProposal(
    propose(createAuthoredText(''), {
      text: 'Observed a range of anaesthetic techniques across a busy operating list.',
      model: 'test', groundedIn: [], createdAt: NOW,
    }),
    NOW
  )
  assert.equal(aiOnly.accepted.split(' ').length > MIN_NARRATIVE_WORDS, true)
  assert.equal(hasApplicantNarrative(aiOnly), false, 'AI text counted as the applicant’s own work')
})

test('their own words still count underneath an accepted proposal', () => {
  const mine = editSource(createAuthoredText(''), WRITTEN, NOW)
  const withAi = acceptProposal(
    propose(mine, { text: 'A tightened version.', model: 'test', groundedIn: [], createdAt: LATER }),
    LATER
  )
  assert.equal(hasApplicantNarrative(withAi), true, 'their recoverable text was ignored')
})

// ------------------------------------------------------ gated entries

test('a shadowing entry with no account of it gets no AI', () => {
  const decision = fieldAssist(shadowingWith(createAuthoredText('')), 'sh1', 'reflection')
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, SHADOWING_NEEDS_DETAILS)
})

test('volunteering waits for what they actually did', () => {
  // A role, an organisation and a date range describe a slot on a rota. Asked to
  // improve that, a model invents the contribution.
  const decision = fieldAssist(entrySection('volunteer', createAuthoredText('')), 'e1', 'detail')
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, VOLUNTEER_NEEDS_DETAILS)
})

test('quality improvement waits for what they actually improved', () => {
  const decision = fieldAssist(entrySection('quality_improvement', createAuthoredText('')), 'e1', 'detail')
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, QUALITY_IMPROVEMENT_NEEDS_DETAILS)
})

test('both open up once the applicant has written the narrative', () => {
  const written = createAuthoredText(
    'I ran the weekly audit and rewrote the line-care checklist the unit uses.'
  )
  assert.equal(fieldAssist(entrySection('volunteer', written), 'e1', 'detail').allowed, true)
  assert.equal(fieldAssist(entrySection('quality_improvement', written), 'e1', 'detail').allowed, true)
  assert.equal(fieldAssist(shadowingWith(createAuthoredText(WRITTEN)), 'sh1', 'reflection').allowed, true)
})

test('a gated refusal never promises what AI will invent', () => {
  for (const reason of [
    SHADOWING_NEEDS_DETAILS, VOLUNTEER_NEEDS_DETAILS, QUALITY_IMPROVEMENT_NEEDS_DETAILS,
  ]) {
    assert.match(reason, /will not invent/i, reason)
  }
})

test('an entry that is no longer there is refused rather than thrown at', () => {
  const section = shadowingWith(createAuthoredText(WRITTEN))
  assert.equal(fieldAssist(section, 'gone', 'reflection').allowed, false)
  assert.equal(fieldAssist(section, null, 'reflection').allowed, false)
})

// ------------------------------------------------- every other section

test('sections with nothing to gate are left alone', () => {
  for (const type of ['leadership', 'awards', 'research', 'custom'] as const) {
    const section = createSection(type, 'x') as ResumeSectionV2
    assert.equal(fieldAssist(section, 'e1', 'detail').allowed, true, type)
  }
})

test('the route and the editor ask the same question', () => {
  // fieldAssist is what the editor calls; assistDecision is what the route
  // calls. A gate that existed in only one of them would be a control a stale
  // tab could walk straight past.
  const section = entrySection('volunteer', createAuthoredText(''))
  const decision = assistDecision({
    resume: resume({ status: 'complete', sections: [section] }),
    section, operation: 'improve-text', targetId: 'e1', field: 'detail',
  })
  assert.equal(decision.allowed, false, 'a complete resume let an empty entry through')
  assert.equal(decision.reason, VOLUNTEER_NEEDS_DETAILS)
})
