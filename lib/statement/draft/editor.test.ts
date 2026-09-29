import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_AUTOSAVE,
  initialState,
  nextAction,
  reduce,
  type AutosaveState,
} from '../../resume/draft/autosave.ts'
import { SAVE_MESSAGES, saveEventFrom } from './save.ts'
import { checkTitle } from './validate.ts'
import { MAX_SAVED_CHARS } from '../extract/limits.ts'
import {
  BLOCKED_MESSAGES,
  STATEMENT_STATUS,
  draftSavePath,
  statementDriverAction,
  statementSaveRequest,
  statementStatus,
} from './editor.ts'

/**
 * The statement editor's driver.
 *
 * PART 1 RUNS THE REAL ENGINE. lib/resume/draft/autosave.ts is imported and
 * driven, not stubbed, so every timing, single-flight and edit-during-save
 * assertion below is a statement about the engine Statement Studio actually
 * ships with. The clock is a number passed in, which is what makes an 8-second
 * cap testable in under a millisecond.
 *
 * PART 2 READS THE SOURCE of the page and the client component, which
 * `node --test` cannot import: next/navigation, next/link and react's client
 * runtime do not resolve under bare Node. Structural, and the report says so.
 */

const path = (r: string) => fileURLToPath(new URL(r, import.meta.url))
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const CLIENT = strip(readFileSync(path('../../../app/statement-studio/components/StatementStudioClient.tsx'), 'utf8'))
const PAGE = strip(readFileSync(path('../../../app/statement-studio/[id]/page.tsx'), 'utf8'))

const T0 = 1_700_000_000_000
const doc = { title: 'Why I want to become a CRNA', essay: 'Opening line.' }
const act = (state: AutosaveState, now: number, over: Partial<typeof doc> = {}) =>
  statementDriverAction({ state, now, ...doc, ...over })

// ========================================================== PART 1: the driver

test('the initial revision is the SERVER’s, never a literal 1', () => {
  for (const revision of [1, 2, 47, 9007199254740990]) {
    const state = initialState(revision)
    assert.equal(state.revision, revision)
    assert.equal(state.status, 'clean')
    assert.equal(state.savedAt, null)
  }
  // And the client seeds it from the draft rather than from a constant.
  assert.match(CLIENT, /initialState\(draft\.revision\)/)
  assert.doesNotMatch(CLIENT, /initialState\(1\)/)
})

test('an edit makes the document dirty, and nothing saves immediately', () => {
  const state = reduce(initialState(3), { type: 'edited', at: T0 })
  assert.equal(state.status, 'dirty')
  assert.equal(state.dirtySince, T0)
  assert.deepEqual(act(state, T0), { kind: 'wait', afterMs: DEFAULT_AUTOSAVE.quietMs })
})

test('the quiet delay is the shared engine’s 1200 ms, not a Statement number', () => {
  assert.equal(DEFAULT_AUTOSAVE.quietMs, 1200)
  const state = reduce(initialState(3), { type: 'edited', at: T0 })
  assert.deepEqual(act(state, T0 + 1199), { kind: 'wait', afterMs: 1 })
  assert.deepEqual(act(state, T0 + 1200), { kind: 'save' })
  // Each new keystroke restarts the window.
  const again = reduce(state, { type: 'edited', at: T0 + 1000 })
  assert.deepEqual(act(again, T0 + 1200), { kind: 'wait', afterMs: 1000 })
})

test('the max wait is the shared engine’s 8000 ms: typing cannot starve the save', () => {
  assert.equal(DEFAULT_AUTOSAVE.maxWaitMs, 8000)
  let state = reduce(initialState(3), { type: 'edited', at: T0 })
  // A keystroke every 500 ms would defer a plain debounce for ever.
  for (let at = T0 + 500; at <= T0 + 8000; at += 500) {
    state = reduce(state, { type: 'edited', at })
  }
  assert.deepEqual(act(state, T0 + 8000), { kind: 'save' })
})

test('the save payload is EXACTLY { title, essay, expectedRevision }', () => {
  const request = statementSaveRequest({ ...doc, revision: 7 })
  assert.equal(request.ok, true)
  if (!request.ok) return
  assert.deepEqual(Object.keys(request.body), ['title', 'essay', 'expectedRevision'])
  assert.deepEqual(request.body, { ...doc, expectedRevision: 7 })

  const wire = JSON.stringify(request.body)
  for (const forbidden of [
    'userId', 'user_id', '"id"', 'revision"', 'createdAt', 'created_at', 'updatedAt',
    'updated_at', 'savedAt', 'schoolId', 'promptId', 'prompt', 'status',
  ]) {
    assert.equal(wire.includes(forbidden), false, `${forbidden} must never be sent`)
  }
})

test('expectedRevision is the autosave state’s revision, and the essay is untouched', () => {
  const state = reduce(initialState(12), { type: 'edited', at: T0 })
  const essay = '  Leading and trailing spaces, and\n\nblank lines.  '
  const request = statementSaveRequest({ title: doc.title, essay, revision: state.revision })
  assert.equal(request.ok, true)
  if (!request.ok) return
  assert.equal(request.body.expectedRevision, 12)
  // Byte-for-byte. checkEssay does not trim, and neither does this.
  assert.equal(request.body.essay, essay)
})

test('the stored title round-trips unchanged, which is why it may be sent as-is', () => {
  // The justification for a read-only title in this checkpoint: whatever the
  // database holds already went through checkTitle on the way in, so sending it
  // back cannot change it and the indicator cannot say Saved over a difference.
  for (const typed of ['  My essay  ', 'My essay', '\tTitle\n']) {
    const first = checkTitle(typed)
    assert.equal(first.ok, true)
    if (!first.ok) continue
    const again = checkTitle(first.title)
    assert.equal(again.ok && again.title, first.title, 'trimming must be idempotent')
  }
})

test('a success advances the revision ONLY to what the server returned', () => {
  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  assert.equal(state.status, 'saving')
  assert.equal(state.revision, 4, 'the revision must not move optimistically')

  const event = saveEventFrom({ status: 200, body: { draft: { revision: 5 } }, at: T0 + 1300 })
  assert.deepEqual(event, { type: 'save-succeeded', at: T0 + 1300, revision: 5 })
  state = reduce(state, event)
  assert.equal(state.status, 'saved')
  assert.equal(state.revision, 5)
  assert.deepEqual(act(state, T0 + 9999), { kind: 'idle' })
})

test('the NEXT save uses the revision the previous success returned', () => {
  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  state = reduce(state, saveEventFrom({ status: 200, body: { draft: { revision: 5 } }, at: T0 + 1300 }))
  state = reduce(state, { type: 'edited', at: T0 + 2000 })

  assert.deepEqual(act(state, T0 + 3200), { kind: 'save' })
  const request = statementSaveRequest({ ...doc, revision: state.revision })
  assert.equal(request.ok && request.body.expectedRevision, 5)
})

test('only one save may be in flight: a dirty document is idle while saving', () => {
  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  state = reduce(state, { type: 'edited', at: T0 + 1300 })
  // Dirty again, and still idle: the engine, not the driver, enforces this.
  assert.equal(state.dirtySince, T0 + 1300)
  for (const now of [T0 + 1300, T0 + 2600, T0 + 20_000]) {
    assert.deepEqual(act(state, now), { kind: 'idle' }, `still idle at ${now - T0}ms`)
  }
})

test('an edit DURING a save is not lost, and success does not call it clean', () => {
  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  state = reduce(state, { type: 'edited', at: T0 + 1300 })
  state = reduce(state, saveEventFrom({ status: 200, body: { draft: { revision: 5 } }, at: T0 + 1400 }))

  assert.equal(state.status, 'dirty', 'newer edits exist, so this is NOT saved')
  assert.equal(state.revision, 5, 'but the confirmed revision did advance')
  assert.equal(statementStatus(state, null).text, STATEMENT_STATUS.dirty)
  // And the newer work is scheduled, not dropped.
  assert.deepEqual(act(state, T0 + 2500), { kind: 'save' })
})

test('a failed save puts the in-flight work back rather than losing it', () => {
  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  state = reduce(state, saveEventFrom({ status: 500, body: null, at: T0 + 1300 }))
  assert.equal(state.status, 'retrying')
  assert.equal(state.dirtySince, T0, 'the max-wait cap counts from the original edit')
})

test('5xx retries with the engine’s backoff; a network failure takes the same path', () => {
  assert.equal(DEFAULT_AUTOSAVE.retryBaseMs, 2000)
  assert.equal(DEFAULT_AUTOSAVE.maxRetries, 3)

  const server = saveEventFrom({ status: 503, body: null, at: T0 })
  assert.deepEqual(server, {
    type: 'save-failed', at: T0, reason: SAVE_MESSAGES.server, retryable: true,
  })

  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  state = reduce(state, saveEventFrom({ status: 500, body: null, at: T0 + 1300 }))
  assert.deepEqual(act(state, T0 + 1300), { kind: 'wait', afterMs: 2000 })
  assert.deepEqual(act(state, T0 + 3300), { kind: 'save' })

  // Exhausting the budget stops, rather than hammering.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    state = reduce(state, { type: 'save-started', at: T0 + 4000 + attempt })
    state = reduce(state, saveEventFrom({ status: 500, body: null, at: T0 + 4100 + attempt }))
  }
  assert.equal(state.status, 'failed')
  assert.deepEqual(act(state, T0 + 999_999), { kind: 'idle' }, 'a failed save never retries itself')
})

test('401, 404 and 422 are terminal, not retried', () => {
  for (const [status, reason] of [
    [401, SAVE_MESSAGES.expired], [404, SAVE_MESSAGES.missing], [422, SAVE_MESSAGES.refused],
    [400, SAVE_MESSAGES.refused],
  ] as const) {
    const event = saveEventFrom({ status, body: { error: 'x' }, at: T0 })
    assert.deepEqual(event, { type: 'save-failed', at: T0, reason, retryable: false })

    let state = reduce(initialState(4), { type: 'edited', at: T0 })
    state = reduce(state, { type: 'save-started', at: T0 + 1200 })
    state = reduce(state, event)
    assert.equal(state.status, 'failed', `${status} must stop`)
    assert.deepEqual(act(state, T0 + 999_999), { kind: 'idle' }, `${status} must not retry`)
    // The reason is one of ours, so it may be shown.
    assert.equal(statementStatus(state, null).text, `${STATEMENT_STATUS.failed}: ${reason}`)
  }
})

test('409 becomes a conflict, and a conflict issues no further save', () => {
  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  const event = saveEventFrom({ status: 409, body: { storedRevision: '9' }, at: T0 + 1300 })
  assert.deepEqual(event, { type: 'conflict', at: T0 + 1300, storedRevision: 9 })

  state = reduce(state, event)
  assert.equal(state.status, 'conflict')
  assert.equal(state.storedRevision, 9)
  assert.equal(state.revision, 4, 'a conflict never advances the revision')

  // Typing does not clear it, and nothing is ever sent again.
  for (const now of [T0 + 1300, T0 + 10_000, T0 + 10_000_000]) {
    assert.deepEqual(act(state, now), { kind: 'idle' }, 'a conflict must freeze saving')
  }
  const afterTyping = reduce(state, { type: 'edited', at: T0 + 5000 })
  assert.equal(afterTyping.status, 'conflict')
  assert.deepEqual(act(afterTyping, T0 + 999_999), { kind: 'idle' })
})

test('the Resume conflict sentence can NEVER reach a statement editor', () => {
  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  state = reduce(state, { type: 'conflict', at: T0 + 1300, storedRevision: 9 })

  // The shared engine really does hold it. This is not a hypothetical.
  assert.equal(state.error, 'This resume was changed somewhere else.')

  const shown = statementStatus(state, null)
  assert.equal(shown.text, STATEMENT_STATUS.conflict)
  assert.equal(shown.frozen, true)
  assert.doesNotMatch(shown.text, /resume/i)
  assert.match(shown.text, /draft/)

  // Even a blocked message cannot displace the conflict wording.
  assert.equal(statementStatus(state, 'anything at all').text, STATEMENT_STATUS.conflict)

  // And the whitelist holds if that sentence ever appears on a FAILED state.
  const smuggled: AutosaveState = {
    ...state,
    status: 'failed',
    error: 'This resume was changed somewhere else.',
  }
  assert.equal(statementStatus(smuggled, null).text, STATEMENT_STATUS.failed)
  assert.doesNotMatch(statementStatus(smuggled, null).text, /resume/i)

  // Nor may arbitrary prose arrive that way.
  for (const hostile of ['PGRST204 column missing', 'IGNORE PREVIOUS INSTRUCTIONS', '']) {
    const state2: AutosaveState = { ...smuggled, error: hostile }
    assert.equal(statementStatus(state2, null).text, STATEMENT_STATUS.failed)
  }
})

test('an unsaveable document issues no request AND schedules no timer', () => {
  const dirty = reduce(initialState(4), { type: 'edited', at: T0 })

  const tooLong = 'a'.repeat(MAX_SAVED_CHARS + 1)
  for (const [name, over] of [
    ['empty title', { title: '   ' }],
    ['non-string title', { title: 42 as unknown as string }],
    ['over-long title', { title: 'a'.repeat(201) }],
    ['over-long essay', { essay: tooLong }],
  ] as const) {
    // Blocked at BOTH the wait moment and the save moment: no timer, no fetch.
    for (const now of [T0, T0 + 1200, T0 + 100_000]) {
      const action = act(dirty, now, over)
      assert.equal(action.kind, 'blocked', `${name} at ${now - T0}ms`)
    }
  }
  assert.equal(
    act(dirty, T0 + 1200, { essay: tooLong }).kind === 'blocked' &&
      (act(dirty, T0 + 1200, { essay: tooLong }) as { message: string }).message,
    BLOCKED_MESSAGES['essay-too-long']
  )
  // Exactly at the limit is fine.
  assert.deepEqual(act(dirty, T0 + 1200, { essay: 'a'.repeat(MAX_SAVED_CHARS) }), { kind: 'save' })
})

test('saving resumes the moment the document is valid again', () => {
  const dirty = reduce(initialState(4), { type: 'edited', at: T0 })
  const tooLong = 'a'.repeat(MAX_SAVED_CHARS + 500)
  assert.equal(act(dirty, T0 + 1200, { essay: tooLong }).kind, 'blocked')

  const trimmedBack = reduce(dirty, { type: 'edited', at: T0 + 3000 })
  assert.deepEqual(act(trimmedBack, T0 + 4200, { essay: 'Back in range.' }), { kind: 'save' })

  // Blocked is NOT frozen: the indicator says what to fix, not that it is stuck.
  const blocked = statementStatus(dirty, BLOCKED_MESSAGES['essay-too-long'])
  assert.equal(blocked.frozen, false)
  assert.equal(blocked.unsaved, true)
  assert.equal(blocked.text, BLOCKED_MESSAGES['essay-too-long'])
})

test('a clean document costs no validation and no work', () => {
  assert.deepEqual(act(initialState(4), T0), { kind: 'idle' })
  assert.deepEqual(act(initialState(4), T0, { title: '' }), { kind: 'idle' })
})

test('every status the editor can show is Statement’s own wording', () => {
  const statuses = ['clean', 'dirty', 'saving', 'saved', 'retrying', 'failed', 'conflict'] as const
  const approved = new Set<string>([
    ...Object.values(STATEMENT_STATUS),
    ...Object.values(SAVE_MESSAGES).map((m) => `${STATEMENT_STATUS.failed}: ${m}`),
  ])
  for (const status of statuses) {
    const state: AutosaveState = { ...initialState(4), status, error: SAVE_MESSAGES.refused }
    const shown = statementStatus(state, null)
    assert.ok(approved.has(shown.text), `"${shown.text}" is not approved wording`)
    assert.doesNotMatch(shown.text, /resume/i)
  }
})

test('the save path carries the id, and the body does not', () => {
  assert.equal(draftSavePath('d1e2f3a4-0000-4000-8000-000000000001'),
    '/api/statement/drafts/d1e2f3a4-0000-4000-8000-000000000001')
})

// ========================================================== PART 2: the wiring

test('the page still gates, still reads server-side, and hands the draft down', () => {
  // Unchanged layers.
  assert.match(PAGE, /statementStudioAccess\(\{/)
  assert.match(PAGE, /mode: statementStudioMode\(\)/)
  assert.match(PAGE, /if \(!isDraftId\(id\)\) notFound\(\)/)
  assert.match(PAGE, /read\.reason === 'not-found'\) notFound\(\)/)
  assert.match(PAGE, /throw new Error\(UNREADABLE\)/)
  assert.doesNotMatch(PAGE, /SERVICE_ROLE/i)
  assert.doesNotMatch(PAGE, /\.from\(|statement_drafts/)
  assert.doesNotMatch(PAGE, /\.detail\b/)
  // The one new thing.
  assert.match(PAGE, /<StatementStudioClient draft=\{draft\} \/>/)
  assert.doesNotMatch(PAGE, /'use client'/)
  const gate = PAGE.indexOf('statementStudioAccess({')
  assert.ok(gate !== -1 && gate < PAGE.indexOf('readDraft(db'))
})

test('the client never re-fetches the draft it was handed', () => {
  assert.doesNotMatch(CLIENT, /\bGET\b/)
  // The only request in the whole component is the PATCH.
  assert.equal(CLIENT.split('fetch(').length - 1, 1)
  assert.match(CLIENT, /method: 'PATCH'/)
  assert.match(CLIENT, /fetch\(draftSavePath\(draft\.id\)/)
})

test('the client uses the shared engine in place, and forks nothing', () => {
  assert.match(CLIENT, /from '@\/lib\/resume\/draft\/autosave'/)
  for (const used of [/\binitialState\(/, /\breduce\(/]) assert.match(CLIENT, used)
  // The timings are the engine's defaults: no config object is passed.
  assert.doesNotMatch(CLIENT, /quietMs|maxWaitMs|retryBaseMs|maxRetries|DEFAULT_AUTOSAVE/)
  // And the decision of when to save is the engine's, via the driver.
  assert.match(CLIENT, /statementDriverAction\(\{/)
})

test('the client maps responses through saveEventFrom and nothing else', () => {
  assert.match(CLIENT, /saveEventFrom\(\{ status: response\.status, body, at: Date\.now\(\) \}\)/)
  assert.doesNotMatch(CLIENT, /status === 409|status === 401|status === 404|status >= 500/)
  assert.doesNotMatch(CLIENT, /body\.error|\.detail\b|statusText/)
})

test('the client holds a synchronous single-flight guard', () => {
  assert.match(CLIENT, /const inFlight = useRef\(false\)/)
  const check = CLIENT.indexOf('if (inFlight.current) return')
  const take = CLIENT.indexOf('inFlight.current = true')
  const request = CLIENT.indexOf('await fetch(')
  assert.ok(check !== -1 && take !== -1 && request !== -1)
  assert.ok(check < take && take < request, 'the guard is taken before anything awaits')
})

test('the client never displays state.error directly', () => {
  assert.match(CLIENT, /statementStatus\(save, blocked\)/)
  assert.match(CLIENT, /\{status\.text\}/)
  assert.doesNotMatch(CLIENT, /save\.error|state\.error|describe\(/)
})

test('the client never invents a revision', () => {
  assert.match(CLIENT, /initialState\(draft\.revision\)/)
  assert.match(CLIENT, /startSave\(save\.revision, essay\)/)
  assert.doesNotMatch(CLIENT, /revision \+ 1|revision\+\+|\+\+revision/)
})

test('the editor edits the essay, does not truncate, and leaves the title alone', () => {
  assert.match(CLIENT, /<textarea/)
  assert.match(CLIENT, /value=\{essay\}/)
  assert.doesNotMatch(CLIENT, /maxLength/)
  assert.doesNotMatch(CLIENT, /\.slice\(0,|substring\(|\.trim\(\)/)
  // The title is rendered, not edited.
  assert.match(CLIENT, /\{draft\.title\}/)
  assert.doesNotMatch(CLIENT, /setTitle|<input/)
})

test('none of the deferred features crept in', () => {
  // Judged on WIRING, not on words: the banner legitimately says that upload
  // and analysis are not connected yet, which is a notice, not a feature.
  for (const deferred of [
    /beforeunload/, /visibilitychange/, /addEventListener/,
    /<input[^>]*type="file"/, /FormData/,
    /\/api\/statement\/extract/, /\/api\/analyze-statement/,
    /schoolId/, /promptId/,
    /method: '(DELETE|POST)'/,
    /type: 'reloaded'/, /type: 'flush'/, /type: 'retry'/,
  ]) {
    assert.doesNotMatch(CLIENT, deferred, `${deferred} belongs to a later step`)
  }
  // The only autosave events this checkpoint dispatches.
  assert.deepEqual(
    [...new Set((CLIENT.match(/type: '[a-z-]+'/g) ?? []))].sort(),
    ["type: 'edited'", "type: 'save-failed'", "type: 'save-started'"]
  )
})
