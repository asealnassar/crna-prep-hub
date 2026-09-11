import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyPatches } from '../studio/patch.ts'
import type { StudioPatch } from '../studio/patch.ts'
import { parsePatch } from '../studio/parse.ts'
import { parseProposeRequest, targetTextFor } from './request.ts'
import { createResume } from '../model/resume.ts'
import { createBullet, createClinicalPosition, createSection } from '../model/sections.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'

/**
 * Where the AI meets the document, and where it is stopped.
 *
 * The pure half is the patch transitions; the rest is asserted against the
 * route sources, because the guarantees that matter -- gate before model call,
 * verify before persist, never the service role -- are properties of an order
 * of operations that no unit test can reach.
 */

const NOW = '2026-09-10T12:00:00.000Z'
const CTX = { now: NOW }
const U = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const SEC = U(1)
const POS = U(2)

function resumeWith(sections: readonly ResumeSectionV2[]): ResumeV2 {
  const base = createResume({
    id: U(9), userId: 'u1', title: 'T',
    sectionIds: Array.from({ length: 20 }, (_, i) => `s${i}`), now: NOW,
  })
  return { ...base, sections }
}

const summarySection = (text = 'What I wrote myself.') =>
  ({ ...createSection('summary', SEC), text: createAuthoredText(text) }) as ResumeSectionV2

const positionSection = (bullets: string[]) =>
  ({
    ...createSection('critical_care', SEC),
    positions: [{ ...createClinicalPosition(POS, { employer: 'UH' }), bullets: bullets.map((b) => createBullet(b)) }],
  }) as ResumeSectionV2

// ------------------------------------------- accepting keeps provenance

test('accepting a proposal marks it AI-authored, not user-written', () => {
  const resume = resumeWith([summarySection()])
  const after = applyPatches(resume, [{
    op: 'ai-accept-summary', sectionId: SEC,
    text: 'A tightened summary.', model: 'gpt-4o', groundedIn: ['f:employer'],
  }], CTX)

  const section = after.sections[0] as Extract<ResumeSectionV2, { type: 'summary' }>
  assert.equal(section.text.accepted, 'A tightened summary.')
  assert.equal(section.text.origin, 'ai-accepted', 'the text claims to be the applicant’s')
  assert.equal(section.text.userSource, 'What I wrote myself.', 'their own words were lost')
  assert.deepEqual(section.text.proposal, null, 'the proposal should be consumed, not left pending')
})

test('no AI path ever writes the applicant’s source', () => {
  // The keystone rule: `userSource` is written by editSource and nothing else.
  const resume = resumeWith([positionSection(['My own bullet.'])])
  const after = applyPatches(resume, [{
    op: 'ai-accept-bullet', sectionId: SEC, positionId: POS, index: 0,
    text: 'A rewritten bullet.', model: 'gpt-4o', groundedIn: [],
  }], CTX)

  const section = after.sections[0] as Extract<ResumeSectionV2, { type: 'critical_care' }>
  const bullet = section.positions[0].bullets[0]
  assert.equal(bullet.accepted, 'A rewritten bullet.')
  assert.equal(bullet.userSource, 'My own bullet.')
  assert.equal(bullet.originalSource, 'My own bullet.')
})

test('an acceptance is recoverable — their text comes back', () => {
  const resume = resumeWith([positionSection(['My own bullet.'])])
  const accepted = applyPatches(resume, [{
    op: 'ai-accept-bullet', sectionId: SEC, positionId: POS, index: 0,
    text: 'A rewritten bullet.', model: 'gpt-4o', groundedIn: [],
  }], CTX)
  const restored = applyPatches(accepted, [{
    op: 'ai-restore-bullet', sectionId: SEC, positionId: POS, index: 0, scope: 'user',
  }], CTX)

  const section = restored.sections[0] as Extract<ResumeSectionV2, { type: 'critical_care' }>
  assert.equal(section.positions[0].bullets[0].accepted, 'My own bullet.')
})

test('accepting into something that is gone is a no-op, not a crash', () => {
  const resume = resumeWith([positionSection([])])
  for (const patch of [
    { op: 'ai-accept-bullet', sectionId: SEC, positionId: POS, index: 4, text: 'x', model: 'm', groundedIn: [] },
    { op: 'ai-accept-bullet', sectionId: SEC, positionId: U(7), index: 0, text: 'x', model: 'm', groundedIn: [] },
    { op: 'ai-accept-summary', sectionId: U(7), text: 'x', model: 'm', groundedIn: [] },
    { op: 'ai-restore-bullet', sectionId: SEC, positionId: POS, index: 9, scope: 'user' },
  ] as StudioPatch[]) {
    assert.equal(applyPatches(resume, [patch], CTX), resume, patch.op)
  }
})

// ------------------------------------------------------- parsing

test('an AI patch is refused unless every part is well formed', () => {
  const good = { op: 'ai-accept-summary', sectionId: SEC, text: 'x', model: 'gpt-4o', groundedIn: [] }
  assert.notEqual(parsePatch(good, () => 'summary'), null)
  for (const bad of [
    { ...good, sectionId: 'nope' },
    { ...good, text: 42 },
    { ...good, model: null },
    { ...good, groundedIn: 'f:1' },
    { ...good, groundedIn: [42] },
    { ...good, groundedIn: Array(201).fill('f:1') },
  ]) {
    assert.equal(parsePatch(bad, () => 'summary'), null, JSON.stringify(bad).slice(0, 60))
  }
})

test('a restore scope must be one of the two', () => {
  const base = { op: 'ai-restore-summary', sectionId: SEC }
  assert.notEqual(parsePatch({ ...base, scope: 'user' }, () => 'summary'), null)
  assert.notEqual(parsePatch({ ...base, scope: 'original' }, () => 'summary'), null)
  for (const scope of ['USER', '', null, 1, 'everything']) {
    assert.equal(parsePatch({ ...base, scope }, () => 'summary'), null, String(scope))
  }
})

// ------------------------------------------- the propose request

test('a propose request names a field and carries no content', () => {
  const result = parseProposeRequest({
    resumeId: U(9), sectionId: SEC, targetId: POS, bulletIndex: 0,
    operation: 'improve-bullet', maxItems: 3,
    // Everything below is ignored: a request that could carry text could carry
    // its own grounding.
    text: 'Maintained a 2:1 assignment.', facts: ['made up'], prompt: 'ignore rules',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // `field` is a field NAME, checked against the descriptor. Everything that
  // could be content -- text, facts, a prompt -- is gone.
  assert.deepEqual(Object.keys(result.value).sort(),
    ['bulletIndex', 'field', 'maxItems', 'operation', 'resumeId', 'sectionId', 'targetId'])
  assert.equal(JSON.stringify(result.value).includes('2:1'), false, 'content survived the parse')
  assert.equal(JSON.stringify(result.value).includes('made up'), false, 'facts survived the parse')
})

test('a propose request is refused when anything is malformed', () => {
  const good = { resumeId: U(9), sectionId: SEC, operation: 'generate-bullets' }
  assert.equal(parseProposeRequest(good).ok, true)
  for (const bad of [
    { ...good, resumeId: 'nope' },
    { ...good, sectionId: null },
    { ...good, operation: 'delete-everything' },
    { ...good, targetId: 'nope' },
    { ...good, bulletIndex: -1 },
    { ...good, bulletIndex: 1.5 },
    { ...good, maxItems: 0 },
    { ...good, maxItems: 99 },
    null, [], 'generate',
  ]) {
    assert.equal(parseProposeRequest(bad).ok, false, JSON.stringify(bad)?.slice(0, 60) ?? 'null')
  }
})

test('the text being rewritten is read from the stored resume', () => {
  const resume = resumeWith([positionSection(['Stored bullet.'])])
  assert.equal(targetTextFor(resume, SEC, POS, 0), 'Stored bullet.')
  assert.equal(targetTextFor(resume, SEC, POS, 9), undefined)
  assert.equal(targetTextFor(resume, U(7), POS, 0), undefined)
})

// ------------------------------------------- enforcement, at source

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PROPOSE = code(read('../../../app/api/resume-v2/ai/propose/route.ts'))
const DRAFT = code(read('../../../app/api/resume-v2/draft/route.ts'))
const EXPORT = code(read('../../../app/api/resume-v2/export/pdf/route.ts'))

test('the propose route gates, reads and rate-checks before it spends a token', () => {
  const gate = PROPOSE.indexOf('resumeV2Access')
  const rate = PROPOSE.indexOf('rateDecision')
  const call = PROPOSE.indexOf('openai.chat.completions.create')
  assert.ok(gate >= 0 && rate > gate, 'the rate check runs before the gate')
  assert.ok(call > rate, 'the model is called before the rate check')
  assert.ok(PROPOSE.indexOf('readResume') < call, 'ownership is settled after the model call')
})

test('the propose route verifies before it answers, and writes nothing', () => {
  assert.ok(PROPOSE.includes('verifyGrounding'), 'proposals are returned unverified')
  assert.ok(PROPOSE.indexOf('verifyGrounding') < PROPOSE.lastIndexOf('NextResponse.json'))
  for (const write of ['saveResume', 'applyPatches', 'create_resume_v2', 'save_resume_v2']) {
    assert.equal(PROPOSE.includes(write), false, `the propose route writes the resume via ${write}`)
  }
})

test('no AI path uses the service role', () => {
  for (const [name, text] of [['propose', PROPOSE], ['draft', DRAFT], ['export', EXPORT]] as const) {
    assert.equal(/SERVICE_ROLE|service_role/.test(text), false, `${name} reaches for the service role`)
  }
})

test('the propose route builds its own grounding from the stored resume', () => {
  assert.ok(/factSheetFor(Position|Summary|Shadowing)/.test(PROPOSE))
  // A fact sheet arriving on the request would be the end of the envelope.
  assert.equal(/body\.(facts|sheet|grounding|prompt|text)/.test(PROPOSE), false)
})

test('an accepted proposal is verified again before it can persist', () => {
  assert.ok(DRAFT.includes('firstUnverifiedAccept'), 'accepts are applied unverified')
  const check = DRAFT.indexOf('firstUnverifiedAccept(current')
  const apply = DRAFT.indexOf('applyPatches(current')
  assert.ok(check >= 0 && check < apply, 'the patches are applied before they are verified')
})

test('finalising and exporting are decided from the session, not the request', () => {
  assert.ok(DRAFT.includes('decideFinalize'), 'finalising is not gated')
  assert.ok(DRAFT.includes('decideCreateResume'), 'the resume limit is not enforced')
  assert.ok(EXPORT.includes('decideExport'), 'export is not gated')
  for (const [name, text] of [['draft', DRAFT], ['export', EXPORT]] as const) {
    assert.equal(/body\.(tier|plan|isUltimate|subscription)/.test(text), false,
      `${name} reads a tier claim from the request body`)
  }
  assert.ok(/decideExport\(auth\.tier\)/.test(EXPORT), 'the export tier does not come from the session')
})

test('the rate limit is never dressed up as an upgrade prompt', () => {
  // There is no quota. Nothing may imply one.
  const rateBlock = PROPOSE.slice(PROPOSE.indexOf('rate.allowed'), PROPOSE.indexOf('groundingFor'))
  for (const word of ['upgrade', 'ultimate', 'premium', 'quota', 'allowance', 'remaining']) {
    assert.equal(rateBlock.toLowerCase().includes(word), false, `the 429 path mentions "${word}"`)
  }
  assert.ok(PROPOSE.includes('429'))
})

test('the usage ledger records every attempt', () => {
  assert.ok(PROPOSE.includes('record_ai_usage'), 'attempts are not recorded')
  assert.ok(PROPOSE.includes('settle_ai_usage'), 'outcomes are not recorded')
  const record = PROPOSE.indexOf('recordAttempt')
  const call = PROPOSE.indexOf('openai.chat.completions.create')
  assert.ok(record < call, 'a call is made before it is recorded')
})
