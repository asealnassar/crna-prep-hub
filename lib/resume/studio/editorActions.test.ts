import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  QUALITY_IMPROVEMENT_NEEDS_DETAILS, SHADOWING_NEEDS_DETAILS, SUMMARY_NEEDS_TEXT,
  VOLUNTEER_NEEDS_DETAILS,
} from '../ai/gating.ts'
import { BULLET_CANDIDATES, MAX_BULLET_ITEMS, MAX_ITEMS } from '../ai/request.ts'
import { descriptorFor } from './fields.ts'

/**
 * The Studio's AI and bulk-add controls, checked as source.
 *
 * There is no DOM runner, so the editor is asserted the way ai/coverage.test.ts
 * already asserts it: comments stripped first, so prose about a rule can never
 * satisfy an assertion about code. What these tests protect is that the RULES
 * live in one place -- a refusal the editor spells out for itself is a refusal
 * that drifts from the one the server gives.
 */

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const sectionEditor = () => source('../../../app/resume-studio/components/sections/SectionEditor.tsx')
const picker = () => source('../../../app/resume-studio/components/sections/IcuExperiencePicker.tsx')
const aiAssist = () => source('../../../app/resume-studio/components/ai/AiAssist.tsx')
const proposalCard = () => source('../../../app/resume-studio/components/ai/ProposalCard.tsx')

// ------------------------------------------------- the approved wording

test('the summary refusal says what the applicant should do', () => {
  assert.equal(SUMMARY_NEEDS_TEXT, 'Write your summary first, then use AI to tighten it.')
})

test('the gated refusals say AI will not invent their experience', () => {
  assert.match(SHADOWING_NEEDS_DETAILS, /shadowing details first/i)
  for (const reason of [
    SHADOWING_NEEDS_DETAILS, VOLUNTEER_NEEDS_DETAILS, QUALITY_IMPROVEMENT_NEEDS_DETAILS,
  ]) {
    assert.match(reason, /will not invent/i, reason)
  }
})

// ------------------------------------------------------- the summary gate

test('the summary gate reads the summary, not the resume’s status', () => {
  const code = sectionEditor()
  assert.match(code, /summaryAssist\(section\.text\)/, 'the editor does not use the shared gate')
  assert.match(code, /unavailable=\{assist\.reason\}/, 'the refusal is not passed to the control')
  assert.equal(code.includes('resumeStatus'), false, 'the editor still reads Draft vs Complete')
})

test('no refusal is spelled out a second time in the editor', () => {
  // Two copies of a sentence are two sentences to keep in step. The editor shows
  // what gating.ts returns, and the route returns the same string.
  const code = sectionEditor()
  assert.equal(code.includes('Write your summary first'), false)
  assert.equal(code.includes('shadowing details first'), false)
})

test('the narrative gate is asked by field, not by section name', () => {
  const code = sectionEditor()
  assert.match(code, /unavailable=\{fieldAssist\(section, entryId, field\.name\)\.reason\}/)
  assert.equal(code.includes("'shadowing'"), false, 'the editor special-cases a section instead of asking the rule')
})

// --------------------------------------------- unavailable, not hidden

test('an unavailable action is disabled and explained, not removed', () => {
  const code = aiAssist()
  assert.match(code, /const blocked = Boolean\(unavailable\)/)
  assert.match(code, /disabled: working \|\| blocked/, 'a blocked action is still clickable')
  assert.match(code, /aria-describedby/, 'the reason is not tied to the control it explains')
  assert.match(code, /if \(inFlight\.current \|\| blocked\) return/, 'a blocked control can still call the route')
})

test('the server’s own refusal is shown when it has one', () => {
  assert.match(aiAssist(), /typeof body\.message === 'string'/)
})

// ------------------------------------------------ several bullets at once

test('generation asks for several candidates, within the bullet ceiling', () => {
  assert.ok(BULLET_CANDIDATES >= 5 && BULLET_CANDIDATES <= 8, String(BULLET_CANDIDATES))
  assert.ok(BULLET_CANDIDATES <= MAX_BULLET_ITEMS, 'the editor would ask for more than the parser accepts')
  // Letting generation offer more did not raise the ceiling for everything
  // else: rewriting one field still offers what a person can choose between.
  assert.equal(MAX_ITEMS, 6, 'the general AI item ceiling moved')
  assert.match(aiAssist(), /maxItems: multi \? BULLET_CANDIDATES : 3/)
})

// ------------------------------------------- picking the facts first

test('generation opens the fact picker rather than asking straight away', () => {
  const code = sectionEditor()
  assert.match(code, /<IcuExperiencePicker/, 'bullets are still generated from four fields')
  assert.match(code, /onClick=\{\(\) => setPicking\(\(open\) => !open\)\}/)
  assert.match(picker(), /Select your ICU experience/)
})

test('a tick is stored as a position fact, in the list it belongs to', () => {
  const code = sectionEditor()
  assert.match(code, /groupSelections\(selections\)/)
  assert.match(code, /op: 'position-fact'/)
  assert.match(code, /value: mergeFacts\(existing, values\)/, 'confirming would replace facts rather than add to them')
})

test('the request waits until the selections are saved', () => {
  // The route grounds a proposal in the STORED position. Asking before the save
  // lands hands the model the facts that were there a moment ago.
  const code = sectionEditor()
  assert.match(code, /if \(!awaitingSave \|\| unsaved\) return/)
  assert.match(code, /onFlush\(\)/, 'the queue is never flushed, so the request waits for the debounce')
})

test('nothing in the picker is ticked for the applicant', () => {
  const code = picker()
  assert.match(code, /useState<readonly IcuSelection\[\]>\(\[\]\)/, 'the picker starts with something selected')
  assert.match(code, /checked=\{already \|\| isTicked\(category\.field, option\)\}/)
  assert.match(code, /disabled=\{already\}/, 'a fact they already have could be unticked here')
})

test('the picker is searchable and says how much is selected', () => {
  const code = picker()
  assert.match(code, /filterCategories\(query\)/)
  assert.match(code, /\{count\} selected/)
  assert.match(code, /Generate bullet options/)
})

test('candidates are offered as a multiple choice with nothing pre-ticked', () => {
  const code = proposalCard()
  assert.match(code, /Add selected bullets/)
  assert.match(code, /disabled=\{tickedCount === 0\}/, 'adding nothing is offered as an action')
  assert.match(code, /isSelected\(state, i\)/, 'candidates are not individually selectable')
})

test('each bullet taken is added and filled in the same save', () => {
  const code = sectionEditor()
  assert.match(code, /acceptManyPatch=\{\(proposals, model, groundedIn\) =>/)
  assert.match(code, /op: 'bullet-add'/)
  assert.match(code, /index: position\.bullets\.length \+ offset/, 'several accepted bullets would overwrite one another')
})

test('every accepted bullet carries what produced it', () => {
  // Provenance is the audit trail: which model, and what it was allowed to know.
  const code = sectionEditor()
  const accept = code.slice(code.indexOf('acceptManyPatch'), code.indexOf('{({ run, busy }) =>'))
  assert.match(accept, /op: 'ai-accept-bullet'/)
  assert.match(accept, /text: proposal, model, groundedIn/)
})

test('bullets they already have are not offered back to them', () => {
  assert.match(sectionEditor(), /existingText=\{position\.bullets\.map\(\(bullet\) => bullet\.accepted\)\}/)
  assert.match(aiAssist(), /usableCandidates\(/, 'the editor keeps no duplicate filter of its own')
})

// ------------------------------------------------- certifications

test('the certification picker adds an entry and a name, and nothing else', () => {
  const code = sectionEditor()
  assert.match(code, /op: 'entry-add', sectionId: section\.id, entryId/)
  assert.match(code, /field: 'name', value: name/)
  for (const invented of ["field: 'issuer'", "field: 'earned'", "field: 'identifier'", "field: 'expires'"]) {
    assert.equal(code.includes(invented), false, `the picker fills in ${invented}, which only the applicant knows`)
  }
})

test('the picker writes a field the descriptor declares', () => {
  const fields = descriptorFor('certifications').entry!.fields.map((f) => f.name)
  assert.ok(fields.includes('name'))
})

test('the picker asks the shared list and the shared de-duplication', () => {
  const code = sectionEditor()
  assert.match(code, /COMMON_CERTIFICATIONS\.map/)
  assert.match(code, /certificationsToAdd\(existing, \[\.\.\.picked, custom\]\)/)
  assert.match(code, /alreadyHasCertification\(existing, certification\.name\)/)
})

test('nothing is added until the applicant asks for it', () => {
  const code = sectionEditor()
  assert.match(code, /disabled=\{chosen\.length === 0\}/)
  assert.match(code, /onClick=\{\(\) => \{\s*onAdd\(chosen\)/)
})

// --------------------------------------------------- still true elsewhere

test('the editor still offers AI on narrative fields through the descriptor', () => {
  // Restated here because these changes rewrote the file that ai/coverage.test.ts
  // reads: the one rule that decides eligibility must survive them.
  assert.match(sectionEditor(), /field\.kind === 'authored' && \(\s*<AiAssist/)
})
