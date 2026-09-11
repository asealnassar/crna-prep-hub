import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IDLE, canRegenerate, canRestoreOriginal, canRestoreUserText, reduceProposal,
  selectedProposal,
} from './proposalFlow.ts'
import type { ProposalState } from './proposalFlow.ts'
import {
  acceptProposal, createAuthoredText, editSource, propose,
} from '../model/authoredText.ts'

const NOW = '2026-09-10T12:00:00.000Z'
const LATER = '2026-09-10T13:00:00.000Z'
const REJECTED = [{ category: 'quantity', token: '2:1', message: 'states a figure you have not given: “2:1”.' }]
const OPP = [{ question: 'How many beds?', why: 'It would sharpen the first line.' }]

const offered = (): ProposalState =>
  reduceProposal(IDLE, { type: 'received', proposals: ['One.', 'Two.'], opportunities: OPP, rejected: [] })

// -------------------------------------------------------- transitions

test('asking puts it to work', () => {
  assert.deepEqual(reduceProposal(IDLE, { type: 'request' }), { kind: 'working' })
})

test('proposals are offered, the first one selected', () => {
  const state = offered()
  assert.equal(state.kind, 'offered')
  assert.equal(selectedProposal(state), 'One.')
})

test('another proposal can be chosen', () => {
  const state = reduceProposal(offered(), { type: 'choose', index: 1 })
  assert.equal(selectedProposal(state), 'Two.')
})

test('choosing something that is not there changes nothing', () => {
  const state = offered()
  for (const index of [-1, 2, 99]) {
    assert.equal(reduceProposal(state, { type: 'choose', index }), state, String(index))
  }
})

test('accepting resets — the patch is the driver’s job, not this module’s', () => {
  assert.deepEqual(reduceProposal(offered(), { type: 'accepted' }), IDLE)
})

test('keeping the original writes nothing anywhere', () => {
  assert.deepEqual(reduceProposal(offered(), { type: 'keep-original' }), IDLE)
})

test('regenerate replaces the proposal and moves nothing else', () => {
  const again = reduceProposal(offered(), { type: 'request' })
  assert.deepEqual(again, { kind: 'working' })
  const replaced = reduceProposal(again, {
    type: 'received', proposals: ['Three.'], opportunities: [], rejected: [],
  })
  assert.equal(selectedProposal(replaced), 'Three.')
})

// ----------------------------------------------------------- refusal

test('when everything was refused, the refusal is named and nothing is offered', () => {
  const state = reduceProposal(IDLE, {
    type: 'received', proposals: [], opportunities: OPP, rejected: REJECTED,
  })
  assert.equal(state.kind, 'refused')
  assert.equal(selectedProposal(state), null, 'refused text must never be selectable')
  if (state.kind === 'refused') {
    assert.equal(state.rejected[0].token, '2:1')
    assert.match(state.rejected[0].message, /2:1/)
  }
})

test('a partly refused batch offers the clean ones and names the rest', () => {
  const state = reduceProposal(IDLE, {
    type: 'received', proposals: ['Grounded.'], opportunities: [], rejected: REJECTED,
  })
  assert.equal(state.kind, 'offered')
  assert.equal(selectedProposal(state), 'Grounded.')
  if (state.kind === 'offered') assert.equal(state.rejected.length, 1)
})

test('no state ever carries the text that was refused', () => {
  // The route returns violations, not the sentences. If that ever changes, a
  // fabrication ends up one click from the resume.
  const states = [
    reduceProposal(IDLE, { type: 'received', proposals: [], opportunities: [], rejected: REJECTED }),
    reduceProposal(IDLE, { type: 'received', proposals: ['Clean.'], opportunities: [], rejected: REJECTED }),
  ]
  for (const state of states) {
    const json = JSON.stringify(state)
    assert.equal(json.includes('Maintained a 2:1'), false)
  }
})

test('nothing offered and nothing refused is reported honestly', () => {
  const state = reduceProposal(IDLE, { type: 'received', proposals: [], opportunities: [], rejected: [] })
  assert.equal(state.kind, 'error')
  if (state.kind === 'error') assert.equal(state.retryable, false)
})

// ------------------------------------------------------------- errors

test('a failure is reported with whether trying again is worth it', () => {
  const retryable = reduceProposal(IDLE, { type: 'failed', message: 'Network error', retryable: true })
  assert.deepEqual(retryable, { kind: 'error', message: 'Network error', retryable: true })
  assert.equal(canRegenerate(retryable), true)

  const permanent = reduceProposal(IDLE, { type: 'failed', message: 'Not available', retryable: false })
  assert.equal(canRegenerate(permanent), false)
})

test('regenerate is offered where it makes sense and nowhere else', () => {
  assert.equal(canRegenerate(IDLE), false)
  assert.equal(canRegenerate({ kind: 'working' }), false)
  assert.equal(canRegenerate(offered()), true)
  assert.equal(
    canRegenerate(reduceProposal(IDLE, { type: 'received', proposals: [], opportunities: [], rejected: REJECTED })),
    true
  )
})

test('dismissing returns to idle from anywhere', () => {
  for (const state of [offered(), { kind: 'working' as const }, IDLE]) {
    assert.deepEqual(reduceProposal(state, { type: 'dismiss' }), IDLE)
  }
})

// --------------------------------------------- Restore Original gating

test('Restore Original is hidden when the original is empty', () => {
  // The carry-forward. An entry created blank in the Studio was originally
  // blank, so the control would erase rather than restore.
  const fresh = createAuthoredText('')
  const written = editSource(fresh, 'Something I wrote.', NOW)
  assert.equal(written.originalSource, '')
  assert.equal(canRestoreOriginal(written), false, 'the control would have erased their work')
})

test('Restore Original is offered when the original is real', () => {
  const imported = createAuthoredText('Imported prose from a PDF.', 'import')
  const edited = editSource(imported, 'My rewrite.', NOW)
  assert.equal(canRestoreOriginal(edited), true)
})

test('Restore Original is hidden when nothing has moved away from the original', () => {
  assert.equal(canRestoreOriginal(createAuthoredText('Imported prose.', 'import')), false)
  assert.equal(canRestoreOriginal(null), false)
  assert.equal(canRestoreOriginal(undefined), false)
})

test('Restore My Text is the control that matters for Studio-written prose', () => {
  const mine = editSource(createAuthoredText(''), 'What I actually wrote.', NOW)
  const withAi = acceptProposal(
    propose(mine, { text: 'What the assistant wrote.', model: 'test', groundedIn: [], createdAt: LATER }),
    LATER
  )
  assert.equal(withAi.accepted, 'What the assistant wrote.')
  assert.equal(canRestoreUserText(withAi), true, 'their own words must be recoverable')
  assert.equal(canRestoreOriginal(withAi), false, 'but Restore Original would still erase')
})

test('Restore My Text is hidden when the accepted text already is their text', () => {
  const mine = editSource(createAuthoredText(''), 'Mine.', NOW)
  assert.equal(canRestoreUserText(mine), false)
  assert.equal(canRestoreUserText(createAuthoredText('')), false)
})

test('the reducer mutates nothing', () => {
  const state = offered()
  const before = JSON.stringify(state)
  reduceProposal(state, { type: 'choose', index: 1 })
  reduceProposal(state, { type: 'accepted' })
  assert.equal(JSON.stringify(state), before)
})
