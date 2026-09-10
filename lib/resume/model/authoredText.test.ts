import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_HISTORY, acceptProposal, createAuthoredText, editSource, hasBeenEdited,
  hasPendingProposal, isAiAuthored, isBlankAuthoredText, isImported, keepOriginal,
  propose, rejectProposal, restoreOriginal, restorePrevious, restoreUserText,
} from './authoredText.ts'
import type { AIProposal, AuthoredText } from './authoredText.ts'

/**
 * The truthfulness contract.
 *
 * V1 assigned generated bullets straight over the field the applicant typed
 * into -- no diff, no confirmation, no way back. Two invariants are defended
 * here: no AI path writes `originalSource`, and no AI path writes
 * `userSource`. Between them the applicant's first words and their latest
 * words both survive anything a model does.
 */

const T1 = '2026-09-10T10:00:00.000Z'
const T2 = '2026-09-10T11:00:00.000Z'
const T3 = '2026-09-10T12:00:00.000Z'
const T4 = '2026-09-10T13:00:00.000Z'

const aiProposal = (text: string, grounded: string[] = ['f:x#0']): AIProposal => ({
  text, model: 'test-model', groundedIn: grounded, createdAt: T1,
})

/** Every transition AI can reach. `editSource` is excluded on purpose. */
const AI_REACHABLE: Array<[string, (at: AuthoredText) => AuthoredText]> = [
  ['propose', (at) => propose(at, aiProposal('AI text'))],
  ['acceptProposal', (at) => acceptProposal(propose(at, aiProposal('AI text')), T2)],
  ['keepOriginal', (at) => keepOriginal(propose(at, aiProposal('AI text')))],
  ['rejectProposal', (at) => rejectProposal(propose(at, aiProposal('AI text')))],
  ['restoreOriginal', (at) => restoreOriginal(propose(at, aiProposal('AI text')), T2)],
  ['restoreUserText', (at) => restoreUserText(propose(at, aiProposal('AI text')), T2)],
  ['restorePrevious', (at) => restorePrevious(propose(at, aiProposal('AI text')), T2)],
]

// ------------------------------------------------------------ construction

test('a new AuthoredText has one text in all three slots', () => {
  const at = createAuthoredText('I ran the unit.')
  assert.equal(at.originalSource, 'I ran the unit.')
  assert.equal(at.userSource, 'I ran the unit.')
  assert.equal(at.accepted, 'I ran the unit.')
  assert.equal(at.originalOrigin, 'user')
  assert.equal(at.userOrigin, 'user')
  assert.equal(at.origin, 'user')
  assert.equal(at.proposal, null)
  assert.deepEqual(at.history, [])
  assert.equal(hasBeenEdited(at), false)
})

test('imported text is distinguishable from typed text', () => {
  const at = createAuthoredText('From a PDF', 'import')
  assert.equal(at.originalOrigin, 'import')
  assert.equal(at.userOrigin, 'import')
  assert.equal(isImported(at), true)
  assert.equal(isImported(createAuthoredText('typed')), false)
})

// ------------------------------------------- THE CENTRAL INVARIANTS

test('NO AI-reachable transition can write originalSource', () => {
  const at = createAuthoredText('the applicant wrote this')
  for (const [name, transition] of AI_REACHABLE) {
    const after = transition(at)
    assert.equal(after.originalSource, 'the applicant wrote this', `${name} must not touch it`)
    assert.equal(after.originalOrigin, 'user', `${name} must not touch its origin`)
  }
})

test('NO AI-reachable transition can write userSource', () => {
  const at = editSource(createAuthoredText('first draft'), 'my latest words', T2)
  for (const [name, transition] of AI_REACHABLE) {
    const after = transition(at)
    assert.equal(after.userSource, 'my latest words', `${name} must not touch it`)
    assert.equal(after.userOrigin, 'user', `${name} must not touch its origin`)
  }
})

test('the original survives a proposal', () => {
  const at = propose(createAuthoredText('mine'), aiProposal('suggested'))
  assert.equal(at.originalSource, 'mine')
  assert.equal(at.userSource, 'mine')
  assert.equal(at.accepted, 'mine', 'and nothing has changed on the page')
})

test('the original survives acceptance', () => {
  const at = acceptProposal(propose(createAuthoredText('mine'), aiProposal('polished')), T2)
  assert.equal(at.accepted, 'polished', 'AI text renders')
  assert.equal(at.originalSource, 'mine', 'the first words survive')
  assert.equal(at.userSource, 'mine', 'and so do the latest human words')
  assert.equal(isAiAuthored(at), true)
})

test('the original survives repeated manual edits — the whole point of the split', () => {
  let at = createAuthoredText('draft one')
  at = editSource(at, 'draft two', T2)
  at = editSource(at, 'draft three', T3)
  at = acceptProposal(propose(at, aiProposal('ai version')), T4)
  assert.equal(at.originalSource, 'draft one', 'still recoverable after two edits and an accept')
  assert.equal(at.userSource, 'draft three', 'latest human text tracked separately')
  assert.equal(at.accepted, 'ai version')
})

test('a manual edit updates userSource but never originalSource', () => {
  const at = editSource(createAuthoredText('first'), 'second', T2)
  assert.equal(at.originalSource, 'first')
  assert.equal(at.userSource, 'second')
  assert.equal(at.accepted, 'second')
  assert.equal(at.origin, 'user')
  assert.equal(hasBeenEdited(at), true)
})

test('editing imported text marks the edit as the applicant’s, keeping import history', () => {
  const at = editSource(createAuthoredText('extracted line', 'import'), 'my correction', T2)
  assert.equal(at.originalOrigin, 'import', 'where it started is remembered')
  assert.equal(at.userOrigin, 'user', 'who wrote the latest version')
  assert.equal(at.origin, 'user')
  assert.equal(at.originalSource, 'extracted line')
})

// ------------------------------------------------------------- proposals

test('a proposal changes nothing that renders', () => {
  const proposed = propose(createAuthoredText('original'), aiProposal('suggested'))
  assert.equal(proposed.accepted, 'original')
  assert.equal(proposed.origin, 'user')
  assert.equal(hasPendingProposal(proposed), true)
  assert.deepEqual(proposed.proposal?.groundedIn, ['f:x#0'], 'grounding is recorded')
})

test('keep original discards the proposal and moves nothing else', () => {
  const kept = keepOriginal(propose(createAuthoredText('original'), aiProposal('suggested')))
  assert.equal(kept.proposal, null)
  assert.equal(kept.accepted, 'original')
  assert.deepEqual(kept.history, [], 'declining is not a history event')
})

test('regenerating replaces the pending proposal and nothing else', () => {
  const at = propose(createAuthoredText('original'), aiProposal('first try'))
  const again = propose(at, aiProposal('second try'))
  assert.equal(again.proposal?.text, 'second try')
  assert.equal(again.accepted, 'original')
  assert.deepEqual(again.history, [])
})

test('accepting or keeping with no proposal is a no-op', () => {
  const at = createAuthoredText('original')
  assert.equal(acceptProposal(at, T2), at)
  assert.equal(keepOriginal(at), at)
})

// --------------------------------------------------------------- restore

test('Restore Original returns the TRUE first text, not the latest edit', () => {
  let at = createAuthoredText('what I first wrote')
  at = editSource(at, 'my revision', T2)
  at = acceptProposal(propose(at, aiProposal('ai text')), T3)
  const restored = restoreOriginal(at, T4)
  assert.equal(restored.accepted, 'what I first wrote')
  assert.equal(restored.origin, 'user')
  assert.equal(restored.history[0]?.text, 'ai text', 'the AI version stays recoverable')
})

test('Restore Original restores import provenance when that is where it began', () => {
  let at = createAuthoredText('extracted', 'import')
  at = editSource(at, 'edited', T2)
  const restored = restoreOriginal(at, T3)
  assert.equal(restored.accepted, 'extracted')
  assert.equal(restored.origin, 'import', 'not relabelled as user-written')
})

test('Restore My Text returns the latest human version, not the first draft', () => {
  let at = createAuthoredText('draft one')
  at = editSource(at, 'draft two', T2)
  at = acceptProposal(propose(at, aiProposal('ai version')), T3)
  const restored = restoreUserText(at, T4)
  assert.equal(restored.accepted, 'draft two', 'the edit, not the original')
  assert.equal(restored.origin, 'user')
  assert.equal(restored.originalSource, 'draft one', 'and the original is still there')
})

test('both restores are no-ops when already showing that text', () => {
  const at = createAuthoredText('mine')
  assert.deepEqual(restoreOriginal(at, T2).history, [])
  assert.deepEqual(restoreUserText(at, T2).history, [])
})

test('restore clears a pending proposal', () => {
  const at = acceptProposal(propose(createAuthoredText('mine'), aiProposal('ai')), T2)
  assert.equal(restoreOriginal(propose(at, aiProposal('another')), T3).proposal, null)
  assert.equal(restoreUserText(propose(at, aiProposal('another')), T3).proposal, null)
})

test('Restore Previous steps back one accepted value', () => {
  let at = createAuthoredText('v1')
  at = acceptProposal(propose(at, aiProposal('v2')), T2)
  const back = restorePrevious(at, T3)
  assert.equal(back.accepted, 'v1')
  assert.equal(back.origin, 'user')
  assert.deepEqual(back.history, [], 'the entry is consumed — undo walks back, it does not toggle')
})

test('Restore Previous is not a redo toggle', () => {
  let at = createAuthoredText('a')
  at = editSource(at, 'b', T2)
  at = editSource(at, 'c', T3)
  assert.equal(restorePrevious(restorePrevious(at, T4), T4).accepted, 'a',
    'two presses move two states back, not back-and-forward')
})

test('Restore Previous walks back through a mixed edit/accept sequence', () => {
  let at = createAuthoredText('a')
  at = editSource(at, 'b', T2)
  at = acceptProposal(propose(at, aiProposal('c')), T3)
  assert.equal(at.accepted, 'c')
  at = restorePrevious(at, T4)
  assert.equal(at.accepted, 'b')
  at = restorePrevious(at, T4)
  assert.equal(at.accepted, 'a')
})

test('Restore Previous with no history is a no-op', () => {
  const at = createAuthoredText('only')
  assert.equal(restorePrevious(at, T2), at)
})

test('history is bounded so stored personal text cannot grow without limit', () => {
  let at = createAuthoredText('v0')
  for (let i = 1; i <= MAX_HISTORY + 4; i++) {
    at = acceptProposal(propose(at, aiProposal(`v${i}`)), T2)
  }
  assert.equal(at.history.length, MAX_HISTORY)
  assert.equal(at.history[0].text, `v${MAX_HISTORY + 3}`, 'most recent first')
  assert.equal(at.originalSource, 'v0', 'the original outlives the history window')
})

// ------------------------------------------------------------- editing

test('editing takes ownership of whatever was on screen', () => {
  const at = acceptProposal(propose(createAuthoredText('mine'), aiProposal('ai text')), T2)
  const edited = editSource(at, 'ai text, but better', T3)
  assert.equal(edited.userSource, 'ai text, but better', 'the rewrite is theirs')
  assert.equal(edited.accepted, 'ai text, but better')
  assert.equal(edited.origin, 'user')
  assert.equal(edited.originalSource, 'mine', 'the first draft is untouched')
  assert.equal(edited.history[0]?.text, 'ai text', 'the AI version is recoverable')
})

test('editing to the identical value is a no-op', () => {
  const at = createAuthoredText('same')
  assert.equal(editSource(at, 'same', T2), at)
})

test('editing clears a pending proposal', () => {
  const at = propose(createAuthoredText('original'), aiProposal('suggested'))
  assert.equal(editSource(at, 'typed instead', T2).proposal, null)
})

// ---------------------------------------------------------------- misc

test('blankness ignores whitespace', () => {
  assert.equal(isBlankAuthoredText(createAuthoredText('')), true)
  assert.equal(isBlankAuthoredText(createAuthoredText('   \n\t ')), true)
  assert.equal(isBlankAuthoredText(createAuthoredText('x')), false)
})

test('very long text is representable and untouched', () => {
  // One live V1 summary is 4,214 characters. Nothing here may truncate.
  const long = 'a'.repeat(4214)
  const at = createAuthoredText(long)
  const accepted = acceptProposal(propose(at, aiProposal('b'.repeat(9000))), T2)
  assert.equal(accepted.accepted.length, 9000)
  assert.equal(accepted.originalSource.length, 4214, 'the long original still survives')
  assert.equal(accepted.userSource.length, 4214)
})

test('transitions never mutate their input', () => {
  const at = editSource(createAuthoredText('original'), 'edited', T2)
  const snapshot = JSON.stringify(at)
  propose(at, aiProposal('x'))
  acceptProposal(propose(at, aiProposal('x')), T3)
  editSource(at, 'y', T3)
  restoreOriginal(at, T3)
  restoreUserText(at, T3)
  restorePrevious(at, T3)
  assert.equal(JSON.stringify(at), snapshot, 'input object is unchanged')
})

test('a full session keeps all three texts distinct and recoverable', () => {
  let at = createAuthoredText('imported from my old resume', 'import')
  at = editSource(at, 'my rewritten version', T2)
  at = propose(at, aiProposal('the model’s polish'))
  at = acceptProposal(at, T3)

  assert.equal(at.accepted, 'the model’s polish')
  assert.equal(at.userSource, 'my rewritten version')
  assert.equal(at.originalSource, 'imported from my old resume')
  assert.equal(at.originalOrigin, 'import')
  assert.equal(at.userOrigin, 'user')

  assert.equal(restoreUserText(at, T4).accepted, 'my rewritten version')
  assert.equal(restoreOriginal(at, T4).accepted, 'imported from my old resume')
  assert.equal(restorePrevious(at, T4).accepted, 'my rewritten version')
})
