import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_AUTOSAVE,
  hasUnsavedWork,
  initialState,
  nextAction,
  reduce,
  type AutosaveState,
} from '../../resume/draft/autosave.ts'
import { SAVE_MESSAGES, saveEventFrom } from './save.ts'
import { MAX_TITLE_CHARS, checkTitle } from './validate.ts'
import { MAX_SAVED_CHARS } from '../extract/limits.ts'
import {
  BLOCKED_MESSAGES,
  COPY_MESSAGES,
  NAV_MESSAGES,
  RELOAD_MESSAGES,
  STATEMENT_STATUS,
  canRetrySave,
  draftApiPath,
  reloadOutcomeFrom,
  saveAttemptFor,
  settleVerdict,
  statementDriverAction,
  statementSaveRequest,
  statementStatus,
  titleAfterSave,
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
  assert.equal(draftApiPath('d1e2f3a4-0000-4000-8000-000000000001'),
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

test('the initial draft comes from props; the only GET is the deliberate reload', () => {
  // Two requests exist in the whole component and no more: the autosave PATCH,
  // and the GET that happens ONLY when the applicant clicks Reload.
  assert.equal(CLIENT.split('fetch(').length - 1, 3)
  assert.deepEqual([...new Set(CLIENT.match(/method: '[A-Z]+'/g) ?? [])].sort(), [
    "method: 'GET'",
    "method: 'PATCH'",
    // The extraction POST. It persists nothing; see upload.test.ts.
    "method: 'POST'",
  ])
  // Nothing loads the draft on mount: the essay is seeded from the prop.
  assert.match(CLIENT, /useState\(draft\.essay\)/)
  assert.match(CLIENT, /useState\(draft\.title\)/)
  // The GET lives inside reloadLatest, and reloadLatest is only ever called by
  // the button -- never from an effect.
  const reload = CLIENT.slice(CLIENT.indexOf('const reloadLatest'), CLIENT.indexOf('const retrySave'))
  assert.match(reload, /method: 'GET'/)
  assert.match(reload, /cache: 'no-store'/)
  assert.deepEqual(CLIENT.match(/void reloadLatest\(\)/g), ['void reloadLatest()'])
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

test('the client never invents a revision, on any path', () => {
  assert.match(CLIENT, /initialState\(draft\.revision\)/)
  assert.match(CLIENT, /startSave\(save\.revision, title, essay\)/)
  // A reload adopts the SERVER's revision, never storedRevision.
  assert.match(CLIENT, /revision: outcome\.draft\.revision/)
  assert.doesNotMatch(CLIENT, /storedRevision/)
  assert.doesNotMatch(CLIENT, /revision \+ 1|revision\+\+|\+\+revision/)
})

test('both fields are editable, and neither is ever truncated', () => {
  assert.match(CLIENT, /<textarea/)
  assert.match(CLIENT, /value=\{essay\}/)
  assert.match(CLIENT, /<input\n[\s\S]*?value=\{title\}/)
  // No maxLength on either: it would silently shorten pasted text. The only
  // trim in the whole component is the character COUNT, which is display.
  assert.doesNotMatch(CLIENT, /maxLength/)
  assert.doesNotMatch(CLIENT, /\.slice\(0,|substring\(/)
  assert.deepEqual(CLIENT.match(/\.trim\(\)/g), ['.trim()'])
  assert.match(CLIENT, /const titleCharacters = title\.trim\(\)\.length/)
})

test('a title edit takes the SAME path as an essay edit', () => {
  const onTitle = CLIENT.slice(CLIENT.indexOf('const onTitleChange'), CLIENT.indexOf('const onEssayChange'))
  assert.match(onTitle, /setTitle\(value\)/)
  assert.match(onTitle, /type: 'edited', at: Date\.now\(\)/)
  // No second endpoint and no title-only request anywhere.
  assert.doesNotMatch(onTitle, /fetch\(/)
  assert.equal(CLIENT.split('fetch(').length - 1, 3, 'the PATCH, the reload GET, the extraction POST')
})

test('a conflicted editor stays SELECTABLE, and a FAILED one stays editable', () => {
  // readOnly, not disabled: a disabled field cannot be selected in most
  // browsers, and copying your own text is the point of a frozen conflict.
  //
  // AND IT IS KEYED ON THE CONFLICT, NOT ON `frozen`. `frozen` is also true for
  // a terminal failure, but the engine clears error/attempt/retryAt on an edit
  // from 'failed' -- editing is its designed recovery -- so a readOnly field
  // there would trap the applicant with work they could not fix.
  assert.match(CLIENT, /readOnly=\{conflicted\}/)
  assert.equal(CLIENT.split('readOnly={conflicted}').length - 1, 2, 'title and essay')
  assert.doesNotMatch(CLIENT, /readOnly=\{status\.frozen\}/)
  assert.doesNotMatch(CLIENT, /disabled=\{status\.frozen\}/)
})

test('none of the deferred features crept in', () => {
  // Judged on WIRING, not on words: the banner legitimately says that upload
  // and analysis are not connected yet, which is a notice, not a feature.
  for (const deferred of [
    // Upload has landed, so a file input, FormData and the extraction endpoint
    // are expected now; upload.test.ts owns their invariants. These remain out
    // of scope.
    /\/api\/analyze-statement/, /recordStatementAttempt/,
    /schoolId/, /promptId/,
    /method: 'DELETE'/,
    /versionHistory/, /\bmerge\b/i,
    /onDrop/, /onDragOver/, /dataTransfer/,
  ]) {
    assert.doesNotMatch(CLIENT, deferred, `${deferred} belongs to a later step`)
  }
  // Every autosave event this checkpoint dispatches, and no other. All six are
  // the shared engine's PUBLIC events; none was added to it.
  assert.deepEqual(
    [...new Set((CLIENT.match(/type: '[a-z-]+'/g) ?? []))].sort(),
    [
      "type: 'edited'", "type: 'flush'", "type: 'reloaded'",
      "type: 'retry'", "type: 'save-failed'", "type: 'save-started'",
    ]
  )
})

// =============================================== PART 3: recovery, runtime

const ID = 'd1e2f3a4-0000-4000-8000-000000000001'
const OTHER = 'aaaaaaaa-1111-4111-8111-111111111111'
const ok = (over: Record<string, unknown> = {}) => ({
  draft: { id: ID, title: 'Server title', essay: 'Server essay.', revision: 9, ...over },
})

/** A conflicted state, reached the way production reaches it. */
function conflicted(revision = 4): AutosaveState {
  let state = reduce(initialState(revision), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  return reduce(state, saveEventFrom({ status: 409, body: { storedRevision: '9' }, at: T0 + 1300 }))
}

/** A terminally failed state, reached the way production reaches it. */
function failedState(revision = 4): AutosaveState {
  let state = reduce(initialState(revision), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  return reduce(state, saveEventFrom({ status: 422, body: { error: 'x' }, at: T0 + 1300 }))
}

test('a conflict freezes saving and typing cannot clear it', () => {
  let state = conflicted()
  assert.equal(state.status, 'conflict')
  for (let i = 0; i < 5; i += 1) {
    state = reduce(state, { type: 'edited', at: T0 + 2000 + i * 100 })
    assert.equal(state.status, 'conflict', 'typing must not clear a conflict')
  }
  for (const now of [T0 + 1300, T0 + 60_000, T0 + 60_000_000]) {
    assert.deepEqual(act(state, now), { kind: 'idle' }, 'no PATCH after a conflict')
  }
  // A flush cannot force one either -- the engine refuses it in conflict.
  assert.equal(reduce(state, { type: 'flush', at: T0 + 3000 }).forced, false)
  assert.deepEqual(act(reduce(state, { type: 'flush', at: T0 + 3000 }), T0 + 4000), { kind: 'idle' })
})

test('the conflict wording is Statement’s, and never the engine’s sentence', () => {
  const state = conflicted()
  assert.equal(state.error, 'This resume was changed somewhere else.')
  const shown = statementStatus(state, null)
  assert.equal(shown.text, STATEMENT_STATUS.conflict)
  assert.equal(shown.frozen, true)
  assert.doesNotMatch(shown.text, /resume/i)
  // And nothing the component can render says it either.
  assert.doesNotMatch(CLIENT, /was changed somewhere else/)
  assert.doesNotMatch(CLIENT, /save\.error|state\.error/)
})

test('a reload accepts only a genuinely usable draft', () => {
  const outcome = reloadOutcomeFrom({ status: 200, body: ok(), expectedId: ID })
  assert.deepEqual(outcome, {
    ok: true,
    draft: { id: ID, title: 'Server title', essay: 'Server essay.', revision: 9 },
  })
  // The title goes through the same checkTitle the API validates with.
  const padded = reloadOutcomeFrom({ status: 200, body: ok({ title: '  Padded  ' }), expectedId: ID })
  assert.equal(padded.ok && padded.draft.title, 'Padded')
  // An empty essay is legitimate and must not be mistaken for a bad response.
  const empty = reloadOutcomeFrom({ status: 200, body: ok({ essay: '' }), expectedId: ID })
  assert.equal(empty.ok && empty.draft.essay, '')
})

test('a malformed 200 is REFUSED, so local text is never destroyed by one', () => {
  for (const [name, body] of [
    ['no body', null],
    ['no draft', {}],
    ['null draft', { draft: null }],
    ['empty draft', { draft: {} }],
    ['non-uuid id', ok({ id: 'nope' })],
    ['missing id', ok({ id: undefined })],
    ['essay absent', ok({ essay: undefined })],
    ['essay not a string', ok({ essay: 42 })],
    ['title empty', ok({ title: '   ' })],
    ['title not a string', ok({ title: 7 })],
    ['revision 0', ok({ revision: 0 })],
    ['revision null', ok({ revision: null })],
    ['revision "0"', ok({ revision: '0' })],
    ['revision fractional', ok({ revision: 1.5 })],
    ['revision negative', ok({ revision: -3 })],
  ] as const) {
    const outcome = reloadOutcomeFrom({ status: 200, body, expectedId: ID })
    assert.equal(outcome.ok, false, `${name} must be refused`)
    assert.equal(outcome.ok === false && outcome.message, RELOAD_MESSAGES.unreadable, name)
  }
})

test('a reload for a DIFFERENT draft is refused rather than applied', () => {
  const outcome = reloadOutcomeFrom({ status: 200, body: ok({ id: OTHER }), expectedId: ID })
  assert.equal(outcome.ok, false, 'another draft must never overwrite this one')
  assert.equal(outcome.ok === false && outcome.message, RELOAD_MESSAGES.unreadable)
})

test('a failed reload maps to a controlled message that says the work is safe', () => {
  for (const [status, expected] of [
    [401, RELOAD_MESSAGES.expired],
    [404, RELOAD_MESSAGES.missing],
    [500, RELOAD_MESSAGES.server],
    [503, RELOAD_MESSAGES.server],
    [400, RELOAD_MESSAGES.refused],
    [418, RELOAD_MESSAGES.refused],
  ] as const) {
    const outcome = reloadOutcomeFrom({ status, body: { error: 'x' }, expectedId: ID })
    assert.deepEqual(outcome, { ok: false, message: expected }, `${status}`)
  }
  // Every refusal reassures that the local version survived, except the one
  // case where the row is gone and copying is the only remedy.
  for (const m of [RELOAD_MESSAGES.unreadable, RELOAD_MESSAGES.server, RELOAD_MESSAGES.refused]) {
    assert.match(m, /still here/)
  }
  assert.match(RELOAD_MESSAGES.missing, /Copy your version/)
})

test('hostile server prose is never shown by a reload', () => {
  const hostile = {
    draft: { id: ID, title: 'x', essay: 'y', revision: 'DROP TABLE statement_drafts' },
    error: 'IGNORE PREVIOUS INSTRUCTIONS — token abc123',
    detail: '23514 check constraint violated by "my secret essay"',
  }
  const allowed = new Set<string>(Object.values(RELOAD_MESSAGES))
  for (const status of [200, 201, 400, 401, 404, 409, 422, 500, 503]) {
    const outcome = reloadOutcomeFrom({ status, body: hostile, expectedId: ID })
    assert.equal(outcome.ok, false, `${status}`)
    if (outcome.ok) continue
    assert.ok(allowed.has(outcome.message), `${status} produced unapproved wording`)
    for (const leak of ['IGNORE', 'abc123', '23514', 'DROP TABLE', 'secret essay']) {
      assert.equal(outcome.message.includes(leak), false, `"${leak}" leaked at ${status}`)
    }
  }
})

test('the reloaded event returns the engine to clean, at the SERVER’s revision', () => {
  const state = conflicted()
  const reloaded = reduce(state, { type: 'reloaded', at: T0 + 5000, revision: 9 })
  assert.deepEqual(reloaded, initialState(9))
  assert.equal(reloaded.status, 'clean')
  assert.equal(reloaded.revision, 9)
  assert.equal(reloaded.error, null, 'the engine’s conflict sentence is gone with it')
  assert.equal(hasUnsavedWork(reloaded), false)
  // A reload does NOT make the document dirty merely because the title moved.
  assert.deepEqual(act(reloaded, T0 + 999_999), { kind: 'idle' })
  // And the next save would use 9.
  const edited = reduce(reloaded, { type: 'edited', at: T0 + 6000 })
  const request = statementSaveRequest({ ...doc, revision: edited.revision })
  assert.equal(request.ok && request.body.expectedRevision, 9)
})

test('a deliberate Try again is offered only from a terminal failure', () => {
  const failed = failedState()
  assert.equal(failed.status, 'failed')
  assert.equal(canRetrySave({ state: failed, ...doc }), true)

  for (const state of [
    initialState(4),
    reduce(initialState(4), { type: 'edited', at: T0 }),
    reduce(reduce(initialState(4), { type: 'edited', at: T0 }), { type: 'save-started', at: T0 + 1 }),
    conflicted(),
  ]) {
    assert.equal(canRetrySave({ state, ...doc }), false, `${state.status} must not offer a retry`)
  }
})

test('Try again restarts the CURRENT document at the CURRENT revision', () => {
  const failed = failedState(4)
  const retried = reduce(failed, { type: 'retry', at: T0 + 5000 })
  assert.equal(retried.status, 'dirty')
  assert.equal(retried.forced, true)
  assert.equal(retried.revision, 4, 'a retry must not reset or invent a revision')
  assert.equal(retried.attempt, 0)
  assert.equal(retried.error, null)
  // Forced, so it saves at once rather than waiting out another debounce.
  assert.deepEqual(act(retried, T0 + 5000), { kind: 'save' })
  const request = statementSaveRequest({ ...doc, revision: retried.revision })
  assert.equal(request.ok && request.body.expectedRevision, 4)
})

test('Try again is refused while the local document is unsaveable', () => {
  const failed = failedState()
  const tooLong = 'a'.repeat(MAX_SAVED_CHARS + 1)
  assert.equal(canRetrySave({ state: failed, title: doc.title, essay: tooLong }), false)
  assert.equal(canRetrySave({ state: failed, title: '   ', essay: doc.essay }), false)
  // And even if it were dispatched, the driver would not PATCH.
  const retried = reduce(failed, { type: 'retry', at: T0 + 5000 })
  assert.equal(act(retried, T0 + 5000, { essay: tooLong }).kind, 'blocked')
})

test('nothing retries itself beyond the engine’s own budget', () => {
  const failed = failedState()
  for (const now of [T0 + 1300, T0 + 10_000, T0 + 10_000_000]) {
    assert.deepEqual(act(failed, now), { kind: 'idle' }, 'a failed save waits for the applicant')
  }
})

test('settleVerdict answers saved, not saved, or not yet — and never guesses', () => {
  assert.equal(settleVerdict(initialState(4)), true)

  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  state = reduce(state, saveEventFrom({ status: 200, body: { draft: { revision: 5 } }, at: T0 + 1300 }))
  assert.equal(settleVerdict(state), true, 'a confirmed save is settled')

  // In progress: 'retrying' is still trying, so it is NOT an answer either way.
  const dirty = reduce(initialState(4), { type: 'edited', at: T0 })
  const saving = reduce(dirty, { type: 'save-started', at: T0 + 1200 })
  const retrying = reduce(saving, saveEventFrom({ status: 500, body: null, at: T0 + 1300 }))
  for (const [name, s2] of [['dirty', dirty], ['saving', saving], ['retrying', retrying]] as const) {
    assert.equal(settleVerdict(s2), null, `${name} must keep the waiter waiting`)
  }

  assert.equal(settleVerdict(failedState()), false, 'failed means stay')
  assert.equal(settleVerdict(conflicted()), false, 'conflict means stay')

  // It is the engine's own definition of unsaved work, not a second one.
  for (const s2 of [initialState(4), dirty, saving, retrying, failedState(), conflicted()]) {
    if (settleVerdict(s2) === true) assert.equal(hasUnsavedWork(s2), false)
    else assert.equal(hasUnsavedWork(s2), true)
  }
})

test('a hiding tab’s flush is meaningful only when there is work to flush', () => {
  // Clean: the engine returns the same state, so nothing is forced.
  const clean = initialState(4)
  assert.equal(reduce(clean, { type: 'flush', at: T0 }).forced, false)
  assert.equal(hasUnsavedWork(clean), false)

  // Dirty: forced, and the driver saves at once instead of waiting 1200 ms.
  const dirty = reduce(initialState(4), { type: 'edited', at: T0 })
  const flushed = reduce(dirty, { type: 'flush', at: T0 + 100 })
  assert.equal(flushed.forced, true)
  assert.deepEqual(act(flushed, T0 + 100), { kind: 'save' })
})

test('every recovery and navigation message is one of ours', () => {
  const all = [
    ...Object.values(RELOAD_MESSAGES),
    ...Object.values(COPY_MESSAGES),
    ...Object.values(NAV_MESSAGES),
  ]
  for (const message of all) {
    const lower = message.toLowerCase()
    for (const word of [
      'resume', 'admin', 'internal', 'flag', 'beta', 'forbidden', 'permission',
      'sql', 'postgres', 'pgrst', 'constraint', 'revision',
    ]) {
      assert.equal(lower.includes(word), false, `"${message}" names "${word}"`)
    }
  }
  assert.equal(new Set(all).size, all.length, 'no two notices should be identical by accident')
})

// =========================================== PART 4: recovery wiring, source

test('the conflict panel offers exactly Copy and Reload, and resolves nothing itself', () => {
  assert.match(CLIENT, /const conflicted = save\.status === 'conflict'/)
  assert.match(CLIENT, /This draft changed somewhere else\. Saving is paused\./)
  assert.match(CLIENT, /Copy my version/)
  assert.match(CLIENT, /Reload latest version/)
  // No automatic resolution: reloadLatest is only reachable from its button.
  const effects = CLIENT.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\)/g) ?? []
  for (const effect of effects) {
    assert.doesNotMatch(effect, /reloadLatest|copyMine/, 'recovery must never fire from an effect')
  }
})

test('Copy takes the essay ALONE, and changes nothing', () => {
  const copy = CLIENT.slice(CLIENT.indexOf('const copyMine'), CLIENT.indexOf('const reloadLatest'))
  assert.match(copy, /clipboard\.writeText\(essay\)/)
  // Not the title, not the revision, not the status, and nowhere else.
  assert.doesNotMatch(copy, /title|revision|status|fetch\(/)
  // It dispatches nothing at all: no save, no reload, no clearing the conflict.
  assert.doesNotMatch(copy, /setSave|setEssay|reduce\(/)
  // And it never logs the essay.
  assert.doesNotMatch(CLIENT, /console\./)
  assert.match(copy, /setCopied\('failed'\)/, 'clipboard failure must be handled')
})

test('Reload fetches the document, not just the stored revision', () => {
  const reload = CLIENT.slice(CLIENT.indexOf('const reloadLatest'), CLIENT.indexOf('const retrySave'))
  assert.match(reload, /fetch\(draftApiPath\(draft\.id\), \{ method: 'GET'/)
  assert.match(reload, /reloadOutcomeFrom\(\{/)
  assert.match(reload, /expectedId: draft\.id/)
  // A refusal changes nothing: no setEssay, no setTitle, no dispatch.
  const refusal = reload.slice(reload.indexOf('if (!outcome.ok)'), reload.indexOf('setTitle('))
  assert.match(refusal, /setNotice\(outcome\.message\)/)
  assert.match(refusal, /return/)
  assert.doesNotMatch(refusal, /setEssay|setSave|reduce\(/)
  // Success replaces all three from the server, then returns to clean.
  assert.match(reload, /setTitle\(outcome\.draft\.title\)/)
  assert.match(reload, /setEssay\(outcome\.draft\.essay\)/)
  assert.match(reload, /type: 'reloaded', at: Date\.now\(\), revision: outcome\.draft\.revision/)
  // One reload at a time.
  assert.match(reload, /if \(reloadInFlight\.current\) return/)
})

test('the failed-save Retry goes through the engine’s own retry event', () => {
  const retry = CLIENT.slice(CLIENT.indexOf('const retrySave'), CLIENT.indexOf('const leave ='))
  assert.match(retry, /canRetrySave\(\{ state: save, title, essay \}\)/)
  assert.match(retry, /type: 'retry', at: Date\.now\(\)/)
  assert.doesNotMatch(retry, /fetch\(|initialState\(|revision:/)
  assert.match(CLIENT, /Try again/)
})

test('beforeunload uses the engine’s hasUnsavedWork, once, via a ref', () => {
  assert.match(CLIENT, /const saveRef = useRef\(save\)/)
  assert.match(CLIENT, /saveRef\.current = save/)
  const listener = CLIENT.slice(CLIENT.indexOf('const onBeforeUnload'), CLIENT.indexOf("window.addEventListener"))
  assert.match(listener, /if \(!hasUnsavedWork\(saveRef\.current\)\) return/)
  assert.match(listener, /event\.preventDefault\(\)/)
  assert.match(listener, /event\.returnValue = ''/)
  // Registered once and cleaned up.
  assert.match(CLIENT, /window\.addEventListener\('beforeunload', onBeforeUnload\)\n\s*return \(\) => window\.removeEventListener\('beforeunload', onBeforeUnload\)/)
})

test('visibilitychange dispatches a flush and never fetches', () => {
  const vis = CLIENT.slice(CLIENT.indexOf('const onVisibility'), CLIENT.indexOf("document.addEventListener"))
  assert.match(vis, /document\.visibilityState !== 'hidden'/)
  assert.match(vis, /hasUnsavedWork\(saveRef\.current\)/)
  assert.match(vis, /type: 'flush', at: Date\.now\(\)/)
  assert.doesNotMatch(vis, /fetch\(/, 'the visibility handler must not issue a request')
  assert.match(CLIENT, /document\.addEventListener\('visibilitychange', onVisibility\)\n\s*return \(\) => document\.removeEventListener\('visibilitychange', onVisibility\)/)
})

test('guarded navigation waits on a future transition, not on stale state', () => {
  const nav = CLIENT.slice(CLIENT.indexOf('const goToLibrary'), CLIENT.indexOf('// --- render'))
  // The waiter is registered BEFORE the flush is dispatched.
  const waiter = nav.indexOf('const settled = whenSettled()')
  const flush = nav.indexOf("type: 'flush'")
  const awaited = nav.indexOf('await settled')
  assert.ok(waiter !== -1 && flush !== -1 && awaited !== -1)
  assert.ok(waiter < flush, 'the waiter must exist before the dispatch it waits on')
  assert.ok(flush < awaited)
  // And it never re-reads state after dispatching to decide it is safe to go.
  assert.doesNotMatch(nav.slice(flush), /settleVerdict|hasUnsavedWork/)
  // Terminal states stay put; only a true verdict navigates.
  assert.match(nav, /if \(verdict === true\) \{\n\s*leave\(\)/)
  assert.match(nav, /if \(verdict === false\) \{/)
  assert.match(nav, /if \(saved\) leave\(\)\n\s*else setNotice\(NAV_MESSAGES\.stayed\)/)
  // An unsaveable document is not flushed into a waiter that can never resolve.
  assert.match(nav, /if \(!request\.ok\) \{\n\s*setNotice\(NAV_MESSAGES\.blocked\)/)
})

test('a modified click is not pretended to be savable', () => {
  const nav = CLIENT.slice(CLIENT.indexOf('const goToLibrary'), CLIENT.indexOf('// --- render'))
  assert.match(nav, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey \|\| event\.button !== 0/)
  assert.match(nav, /setNotice\(NAV_MESSAGES\.modified\)/)
  // It is an anchor, so an unmodified click is interceptable and a clean
  // document still navigates normally.
  assert.match(CLIENT, /<a\n\s*href=\{LIBRARY\}\n\s*onClick=\{goToLibrary\}/)
})

test('nothing can resolve or write into an unmounted editor', () => {
  assert.match(CLIENT, /const alive = useRef\(true\)/)
  assert.match(CLIENT, /alive\.current = false/)
  // Every late continuation checks it.
  for (const guard of [/if \(!alive\.current\) return/, /if \(alive\.current\) setNotice/]) {
    assert.match(CLIENT, guard)
  }
  // Pending navigation waiters are resolved on unmount rather than left hanging.
  assert.match(CLIENT, /for \(const resolve of waiting\) resolve\(false\)/)
  // The autosave timer is cleared.
  assert.match(CLIENT, /return \(\) => clearTimeout\(timer\)/)
  // Exactly one registration of each listener, each with a matching removal.
  for (const name of ['beforeunload', 'visibilitychange']) {
    assert.equal(CLIENT.split(`addEventListener('${name}'`).length - 1, 1, name)
    assert.equal(CLIENT.split(`removeEventListener('${name}'`).length - 1, 1, name)
  }
})

// ================================== PART 5: title snapshot + reconciliation

const PADDED = 'My Statement '
const TRIMMED = 'My Statement'

test('the snapshot records the RAW title and sends the NORMALISED one', () => {
  const attempt = saveAttemptFor({ title: PADDED, essay: doc.essay, revision: 7 })
  assert.equal(attempt.ok, true)
  if (!attempt.ok) return

  assert.deepEqual(attempt.snapshot, {
    raw: PADDED,
    sent: TRIMMED,
    essay: doc.essay,
    expectedRevision: 7,
  })
  // The body is the normalised one, and still exactly three fields.
  assert.deepEqual(Object.keys(attempt.body), ['title', 'essay', 'expectedRevision'])
  assert.deepEqual(attempt.body, { title: TRIMMED, essay: doc.essay, expectedRevision: 7 })
  // Normalisation happened once, in the validator, and the raw is untouched.
  assert.notEqual(attempt.snapshot.raw, attempt.body.title)
  assert.equal(attempt.snapshot.sent, attempt.body.title)
})

test('the snapshot essay is verbatim and the revision is the engine’s', () => {
  const essay = '  leading, trailing and\n\ninternal whitespace  '
  const state = reduce(initialState(12), { type: 'edited', at: T0 })
  const attempt = saveAttemptFor({ title: PADDED, essay, revision: state.revision })
  assert.equal(attempt.ok, true)
  if (!attempt.ok) return
  assert.equal(attempt.snapshot.essay, essay, 'the essay is never trimmed')
  assert.equal(attempt.body.essay, essay)
  assert.equal(attempt.snapshot.expectedRevision, 12)
})

test('an unsaveable document yields no snapshot at all', () => {
  for (const over of [
    { title: '   ' },
    { title: 'a'.repeat(MAX_TITLE_CHARS + 1) },
    { essay: 'a'.repeat(MAX_SAVED_CHARS + 1) },
  ]) {
    const attempt = saveAttemptFor({ ...doc, revision: 4, ...over })
    assert.equal(attempt.ok, false)
    assert.equal(attempt.ok === false && 'snapshot' in attempt, false)
  }
})

test('CASE A: nobody typed, so the field adopts what was persisted', () => {
  const attempt = saveAttemptFor({ title: PADDED, essay: doc.essay, revision: 7 })
  assert.equal(attempt.ok, true)
  if (!attempt.ok) return
  // The field still reads exactly what it read when the request left.
  assert.equal(titleAfterSave({ snapshot: attempt.snapshot, currentTitle: PADDED }), TRIMMED)
})

test('CASE B: somebody typed, so the newer title is NOT overwritten', () => {
  const attempt = saveAttemptFor({ title: PADDED, essay: doc.essay, revision: 7 })
  assert.equal(attempt.ok, true)
  if (!attempt.ok) return
  for (const typed of ['My Final Statement', 'My Statement  ', 'M', '', 'My Statementx']) {
    assert.equal(
      titleAfterSave({ snapshot: attempt.snapshot, currentTitle: typed }),
      null,
      `"${typed}" must survive an older response`
    )
  }
})

test('the comparison is against the RAW title, not the normalised one', () => {
  const attempt = saveAttemptFor({ title: PADDED, essay: doc.essay, revision: 7 })
  assert.equal(attempt.ok, true)
  if (!attempt.ok) return
  // Someone who trimmed it themselves during the request has typed. The field
  // already equals `sent`, so there is nothing to do -- but the reason is that
  // it matches, not that the raw comparison was skipped.
  assert.equal(titleAfterSave({ snapshot: attempt.snapshot, currentTitle: TRIMMED }), null)
  // And a title that merely NORMALISES to the same thing is still newer text.
  const other = saveAttemptFor({ title: '  Spaced  ', essay: doc.essay, revision: 7 })
  assert.equal(other.ok, true)
  if (!other.ok) return
  assert.equal(titleAfterSave({ snapshot: other.snapshot, currentTitle: ' Spaced ' }), null)
})

test('a title that needed no normalisation causes no needless update', () => {
  const attempt = saveAttemptFor({ title: TRIMMED, essay: doc.essay, revision: 7 })
  assert.equal(attempt.ok, true)
  if (!attempt.ok) return
  assert.equal(titleAfterSave({ snapshot: attempt.snapshot, currentTitle: TRIMMED }), null)
})

test('no snapshot means no reconciliation', () => {
  assert.equal(titleAfterSave({ snapshot: null, currentTitle: PADDED }), null)
})

test('nothing normalises the title BEFORE the server has confirmed it', () => {
  // The whole point: the visible field keeps the applicant's spacing while the
  // request is in flight, and only changes once the write is confirmed.
  let state = reduce(initialState(7), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  assert.equal(state.status, 'saving')
  // Mid-flight there is nothing to reconcile to.
  assert.equal(titleAfterSave({ snapshot: null, currentTitle: PADDED }), null)
  // The component only calls titleAfterSave inside the save-succeeded branch.
  const body = CLIENT.slice(CLIENT.indexOf('const event = saveEventFrom'), CLIENT.indexOf('setSave((state) => reduce(state, event))'))
  assert.match(body, /event\.type === 'save-succeeded' && snapshotRef\.current === snapshot/)
  assert.equal(CLIENT.split('titleAfterSave(').length - 1, 1, 'exactly one reconciliation site')
})

test('an essay edit during a title save still lets the title reconcile', () => {
  const attempt = saveAttemptFor({ title: PADDED, essay: 'before', revision: 7 })
  assert.equal(attempt.ok, true)
  if (!attempt.ok) return
  // The essay moved, the title did not: the title may still be corrected, and
  // the engine independently keeps the document dirty for the newer essay.
  assert.equal(titleAfterSave({ snapshot: attempt.snapshot, currentTitle: PADDED }), TRIMMED)

  let state = reduce(initialState(7), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  state = reduce(state, { type: 'edited', at: T0 + 1300 })
  state = reduce(state, saveEventFrom({ status: 200, body: { draft: { revision: 8 } }, at: T0 + 1400 }))
  assert.equal(state.status, 'dirty', 'the newer essay is still unsaved')
  assert.equal(state.revision, 8, 'and the revision advanced from the server')
})

test('a title-only edit during an essay save leaves the document dirty', () => {
  let state = reduce(initialState(7), { type: 'edited', at: T0 })
  state = reduce(state, { type: 'save-started', at: T0 + 1200 })
  // The applicant retitles mid-flight. Same event as any other edit.
  state = reduce(state, { type: 'edited', at: T0 + 1250 })
  state = reduce(state, saveEventFrom({ status: 200, body: { draft: { revision: 8 } }, at: T0 + 1400 }))
  assert.equal(state.status, 'dirty')
  assert.equal(statementStatus(state, null).text, STATEMENT_STATUS.dirty)
  assert.deepEqual(act(state, T0 + 2500), { kind: 'save' })
  // And that next save carries the SERVER's new revision.
  const next = saveAttemptFor({ title: 'My Final Statement', essay: doc.essay, revision: state.revision })
  assert.equal(next.ok && next.body.expectedRevision, 8)
})

test('sequential saves reconcile only their OWN snapshot', () => {
  const first = saveAttemptFor({ title: 'One ', essay: doc.essay, revision: 7 })
  const second = saveAttemptFor({ title: 'Two ', essay: doc.essay, revision: 8 })
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return

  // The first response arriving while the field reads "Two " must do nothing.
  assert.equal(titleAfterSave({ snapshot: first.snapshot, currentTitle: 'Two ' }), null)
  // The second, against its own raw, reconciles.
  assert.equal(titleAfterSave({ snapshot: second.snapshot, currentTitle: 'Two ' }), 'Two')
  assert.notEqual(first.snapshot.expectedRevision, second.snapshot.expectedRevision)
})

test('a failed save normalises nothing', () => {
  // The component reconciles only in the save-succeeded branch, so a failure
  // leaves the field exactly as typed. Proven at the state level too: a failure
  // does not advance the revision the next attempt will use.
  const failed = failedState(7)
  assert.equal(failed.revision, 7)
  const attempt = saveAttemptFor({ title: PADDED, essay: doc.essay, revision: failed.revision })
  assert.equal(attempt.ok && attempt.snapshot.raw, PADDED)
})

test('Retry uses the CURRENT title, never the old snapshot’s', () => {
  const failed = failedState(7)
  // The old attempt was about "My Statement ".
  const stale = saveAttemptFor({ title: PADDED, essay: doc.essay, revision: 7 })
  assert.equal(stale.ok && stale.snapshot.sent, TRIMMED)

  // The applicant has since retitled. Retry validates what is on screen now.
  assert.equal(canRetrySave({ state: failed, title: 'Renamed after failing', essay: doc.essay }), true)
  const retried = reduce(failed, { type: 'retry', at: T0 + 5000 })
  const fresh = saveAttemptFor({
    title: 'Renamed after failing',
    essay: doc.essay,
    revision: retried.revision,
  })
  assert.equal(fresh.ok && fresh.body.title, 'Renamed after failing')
  assert.equal(fresh.ok && fresh.snapshot.raw, 'Renamed after failing')
  assert.equal(fresh.ok && fresh.body.expectedRevision, 7, 'the revision is not reset')
})

test('an invalid title blocks the save without touching the text', () => {
  const dirty = reduce(initialState(7), { type: 'edited', at: T0 })
  for (const [name, title] of [
    ['whitespace only', '   '],
    ['empty', ''],
    ['201 characters', 'a'.repeat(MAX_TITLE_CHARS + 1)],
  ] as const) {
    for (const now of [T0, T0 + 1200, T0 + 100_000]) {
      assert.equal(act(dirty, now, { title }).kind, 'blocked', `${name} at ${now - T0}ms`)
    }
  }
  // Exactly 200 after trimming is fine.
  assert.deepEqual(
    act(dirty, T0 + 1200, { title: `  ${'a'.repeat(MAX_TITLE_CHARS)}  ` }),
    { kind: 'save' }
  )
  // And the blocked message names the title, so the applicant knows what to fix.
  const blocked = act(dirty, T0 + 1200, { title: '  ' })
  assert.equal(
    blocked.kind === 'blocked' && blocked.message,
    BLOCKED_MESSAGES['invalid-title']
  )
})

test('title-only unsaved work blocks navigation exactly like essay work', () => {
  // There is no title-specific state: a title edit is an `edited` event, so
  // every guard reads the same autosave state.
  const dirty = reduce(initialState(7), { type: 'edited', at: T0 })
  assert.equal(hasUnsavedWork(dirty), true)
  assert.equal(settleVerdict(dirty), null, 'navigation must wait, not leave')

  let saved = reduce(dirty, { type: 'save-started', at: T0 + 1200 })
  saved = reduce(saved, saveEventFrom({ status: 200, body: { draft: { revision: 8 } }, at: T0 + 1300 }))
  assert.equal(hasUnsavedWork(saved), false)
  assert.equal(settleVerdict(saved), true, 'a settled title save may leave')
})

test('a conflict preserves the local title, and no stale snapshot may alter it', () => {
  const state = conflicted(7)
  assert.equal(state.status, 'conflict')
  // A snapshot from the save that conflicted exists, but the component only
  // reconciles on save-succeeded, and the reload retires it outright.
  const reload = CLIENT.slice(CLIENT.indexOf('const reloadLatest'), CLIENT.indexOf('const retrySave'))
  assert.match(reload, /snapshotRef\.current = null\n\s*uploadRef\.current = null\n\s*setTitle\(outcome\.draft\.title\)/)
  // Identity, not a flag: a response holding a retired snapshot cannot match.
  assert.match(CLIENT, /snapshotRef\.current === snapshot/)
  assert.match(CLIENT, /if \(snapshotRef\.current === snapshot\) snapshotRef\.current = null/)
  // Unmount retires it too.
  assert.match(CLIENT, /alive\.current = false\n\s*snapshotRef\.current = null/)
})

test('a reload replaces the title from the validated server draft', () => {
  const outcome = reloadOutcomeFrom({
    status: 200,
    body: { draft: { id: ID, title: '  Server title  ', essay: 'Server essay.', revision: 9 } },
    expectedId: ID,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.draft.title, 'Server title', 'trimmed by checkTitle')
  // And the engine is clean afterwards, so the reloaded title is not dirty.
  const reloaded = reduce(conflicted(7), { type: 'reloaded', at: T0, revision: 9 })
  assert.equal(hasUnsavedWork(reloaded), false)
})

test('arbitrary server prose can never reach the title field', () => {
  // The only server value that ever becomes the title is a reload's, and it
  // must survive checkTitle first.
  for (const hostile of ['', '   ', 'a'.repeat(MAX_TITLE_CHARS + 1), 42, null, undefined, {}]) {
    const outcome = reloadOutcomeFrom({
      status: 200,
      body: { draft: { id: ID, title: hostile, essay: '', revision: 9 } },
      expectedId: ID,
    })
    assert.equal(outcome.ok, false, `${JSON.stringify(hostile) ?? 'undefined'} must be refused`)
  }
  // A save response never supplies a title at all: reconciliation uses the
  // snapshot this client built, not anything the server sent back.
  const attempt = saveAttemptFor({ title: PADDED, essay: doc.essay, revision: 7 })
  assert.equal(attempt.ok && attempt.snapshot.sent, TRIMMED)
  assert.doesNotMatch(CLIENT, /body\.draft\.title|body\.title/)
})
