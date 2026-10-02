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
import { MAX_EXPECTED_REVISION, MAX_TITLE_CHARS, checkTitle } from './validate.ts'
// Imported ONLY to assert the reload parser and the row parser are the SAME
// rules, not two copies that could drift.
import { draftPromptFrom } from './rows.ts'
import { MAX_SAVED_CHARS } from '../extract/limits.ts'
import {
  BLOCKED_MESSAGES,
  PROMPT_BLOCKED_MESSAGE,
  SAVE_BLOCKED_MESSAGES,
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
  wordCount,
  wordLimitProgress,
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
  // The draft is still handed over whole, and is still the FIRST prop. It is no
  // longer the only one -- the server now also reads the school options behind
  // the same gate -- so the assertion names the props rather than the whole tag.
  assert.match(PAGE, /<StatementStudioClient\s*\n?\s*draft=\{draft\}/)
  assert.match(PAGE, /schools=\{schools\.ok \? schools\.value : \[\]\}/)
  assert.match(PAGE, /schoolsUnavailable=\{!schools\.ok\}/)
  // THE SCHOOL READ IS LAST, after every access check and after the draft, so a
  // blocked visitor can never reach it.
  assert.ok(
    PAGE.indexOf('listSchoolPickerOptions(db)') > PAGE.indexOf('readDraft(db'),
    'the directory is read after the draft'
  )
  // The SAME caller-scoped client, not a second one.
  assert.match(PAGE, /listSchoolPickerOptions\(db\)/)
  assert.equal((PAGE.match(/createClient\(/g) ?? []).length, 1, 'one client on the page')
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
    /method: 'DELETE'/,
    /versionHistory/, /\bmerge\b/i,
    /onDrop/, /onDragOver/, /dataTransfer/,
    // THE PICKER IS STILL DEFERRED. The editor now CARRIES prompt metadata --
    // see the test below -- but it cannot choose any: no catalog endpoint, no
    // school list, no control of any kind.
    /\/api\/statement\/prompts/, /<select/, /<option/,
    /setSchool/, /listPrompts/, /readActivePrompt/, /promptSelectionOf/,
    // The school options now ARRIVE as a prop -- see the test below -- so the
    // ban narrows to FETCHING or RENDERING them, which is the picker's job.
    /from\('schools'\)/, /useState<.*SchoolOption/, /schools\.map/,
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

test('SCHOOL OPTIONS PASS STRAIGHT THROUGH TO THE PICKER', () => {
  // Retargeted from "not yet read": the picker exists now and is the only
  // thing that reads them. The guarantees underneath are unchanged -- the
  // editor does not fetch a directory, does not hold a Supabase client, and
  // renders no control of its own.
  assert.match(CLIENT, /schools: readonly SchoolOption\[\]/)
  assert.match(CLIENT, /schoolsUnavailable: boolean/)
  assert.match(CLIENT, /import type \{ SchoolOption \} from '@\/lib\/statement\/draft\/schoolPicker'/)

  // HANDED OVER, NOT COPIED. A second copy in local state would be a second
  // thing to keep correct, and the server already read them once.
  assert.match(CLIENT, /<PromptPicker/)
  assert.match(CLIENT, /schools=\{schools\}/)
  assert.match(CLIENT, /schoolsUnavailable=\{schoolsUnavailable\}/)
  assert.doesNotMatch(CLIENT, /useState<.*SchoolOption/)
  assert.doesNotMatch(CLIENT, /schools\.map/)
  assert.doesNotMatch(CLIENT, /schools\.filter/)
  assert.doesNotMatch(CLIENT, /data-school/)

  // AND NO BROWSER-SIDE DATABASE QUERY, which is the whole reason the server
  // reads this: the gate runs there.
  for (const forbidden of [/createClient/, /supabase/i, /anon[_-]?key/i, /@supabase/]) {
    assert.doesNotMatch(CLIENT, forbidden, 'the browser must not query the database')
  }
  // Still exactly the three fetches THIS editor has always made. The picker's
  // own catalog request lives in its own file -- picker.test.ts owns it.
  assert.equal((CLIENT.match(/await fetch\(/g) ?? []).length, 3)
  assert.doesNotMatch(CLIENT, /\/api\/statement\/prompts/)
})

test('THE PICKER IS HANDED THE SNAPSHOT AND NO WAY TO CHANGE IT', () => {
  // Browsing must not be able to reach the draft's prompt state. It cannot,
  // because nothing that could change one is passed down.
  assert.match(CLIENT, /saved=\{prompt\}/)
  for (const forbidden of [
    /setPrompt=\{/, /onPrompt/, /onSelect/, /onSave/, /onChange=\{setPrompt/,
  ]) {
    assert.doesNotMatch(CLIENT, forbidden, 'no writer may reach the picker')
  }
  // setPrompt is called in exactly TWO places, and BOTH take the server's
  // snapshot: the conflict reload, and the successful-save reconciliation. The
  // picker reaches neither.
  assert.equal((CLIENT.match(/setPrompt\(/g) ?? []).length, 2)
  assert.match(CLIENT, /setPrompt\(\{\n\s*schoolId: outcome\.draft\.schoolId/)
  assert.match(CLIENT, /setPrompt\(saved\)/)
  // Neither is ever handed a browser-authored value.
  assert.doesNotMatch(CLIENT, /setPrompt\(preview/)
  assert.doesNotMatch(CLIENT, /setPrompt\(choice/)
})

test('ONLY A PROMPT ID EVER ENTERS A REQUEST', () => {
  // Retargeted for J2b: the editor now sends a chosen id. The line that matters
  // is narrower than before -- the three CANONICAL fields must still never be
  // browser-authored, and the id must only ever come from the picker.

  // 1. The canonical three are READ from the server and written nowhere else.
  //
  // `prompt.<field>` JOINED THIS LIST WITH THE TWO-COLUMN EDITOR, and it is a
  // read rather than a write: `prompt` is the draft's own saved snapshot, seeded
  // from draft.* and replaced only from outcome.draft.* -- both server values --
  // and the reference panel renders it. That is the point of a snapshot, and
  // part 2 below is what still guarantees none of it travels outwards.
  for (const field of ['schoolId', 'promptText', 'statedMaxWords']) {
    const uses = [...new Set(CLIENT.match(new RegExp(`[\\w.]*${field}[\\w.]*`, 'g')) ?? [])].sort()
    assert.deepEqual(
      uses,
      [field, `draft.${field}`, `outcome.draft.${field}`, `prompt.${field}`].sort(),
      field,
    )
  }

  // 2. THE ONLY VALUE THAT TRAVELS OUT is promptForRequest(captured) -- a uuid
  // or null, taken from the pending instruction and nothing else.
  assert.match(CLIENT, /prompt: promptForRequest\(captured\)/)
  assert.equal((CLIENT.match(/prompt: /g) ?? []).length, 1, 'one prompt field in one body')
  // No canonical value is ever put in a request.
  for (const field of ['schoolId:', 'promptText:', 'statedMaxWords:']) {
    const inRequest = new RegExp(`body:[\\s\\S]{0,400}${field}`)
    assert.doesNotMatch(CLIENT, inRequest, `${field} must never be sent`)
  }
  // And the handler validates the id with the SAME predicate the route uses.
  assert.match(CLIENT, /if \(!isPromptId\(promptId\)\) return/)

  // 3. THE SAVE BODY IS THE VALIDATOR'S OBJECT AND NOTHING ELSE. One PATCH, one
  // body expression, built by nothing in this file -- so there is no place for a
  // fourth field to be merged in.
  assert.equal(CLIENT.split('body: JSON.stringify(attempt.body)').length - 1, 1)
  assert.equal((CLIENT.match(/JSON\.stringify\(/g) ?? []).length, 1, 'exactly one JSON body')
  assert.doesNotMatch(CLIENT, /\.\.\.attempt\.body/, 'the body is never spread and extended')

  // 4. And no snake_case column name appears anywhere: the client speaks the
  // API's language, never the database's.
  for (const column of ['school_id', 'prompt_id', 'prompt_text', 'stated_max_words']) {
    assert.equal(CLIENT.includes(column), false, `${column} is a column, not a field`)
  }
})

test('INITIAL STATE takes all four fields from the server-rendered draft', () => {
  // The component cannot be imported -- next/navigation is unresolvable under
  // node --test -- so the seed is asserted on the source. Each field must come
  // from `draft`, which is the prop the server page passes, and from nothing
  // else: not a default, not a literal, not a previous selection.
  const seed = CLIENT.slice(
    CLIENT.indexOf('const [prompt, setPrompt]'),
    CLIENT.indexOf('const [save, setSave]'),
  )
  assert.ok(seed.length > 0, 'the seed was located')
  for (const field of ['schoolId', 'promptId', 'promptText', 'statedMaxWords']) {
    assert.ok(seed.includes(`${field}: draft.${field},`), `${field} must come from the draft`)
  }
  // A GENERIC draft therefore seeds four nulls and a CHOSEN one seeds four
  // values, because StatementDraft carries exactly what the row held -- there
  // is no branch here that could treat one case differently from the other.
  assert.doesNotMatch(seed, /\?\?/, 'no fallback may stand in for a null')
  assert.doesNotMatch(seed, /\|\|/, 'no truthiness test may stand in for a null')
  assert.doesNotMatch(seed, /null/, 'the nulls come from the draft, not from here')
})

test('ORDINARY AUTOSAVE still sends exactly title, essay and expectedRevision', () => {
  // The body the 1.2-second autosave sends, built by the committed validator.
  const request = statementSaveRequest({ title: 'A title', essay: 'Some words.', revision: 7 })
  assert.equal(request.ok, true)
  if (!request.ok) return
  assert.deepEqual(Object.keys(request.body), ['title', 'essay', 'expectedRevision'])

  // And no prompt field can be in it, however the document is shaped.
  const wire = JSON.stringify(request.body)
  for (const forbidden of [
    'promptId', 'schoolId', 'promptText', 'statedMaxWords',
    'prompt_id', 'school_id', 'prompt_text', 'stated_max_words',
  ]) {
    assert.equal(wire.includes(forbidden), false, `${forbidden} must never be sent`)
  }

  // Including when the draft being saved HAS a prompt: the save request is
  // built from the title, the essay and the revision only -- it is not handed
  // the snapshot at all, so there is nothing for it to leak.
  assert.equal(statementSaveRequest.length, 1, 'one argument: the document')
})

test('THE SHARED RESUME AUTOSAVE ENGINE IS UNTOUCHED', () => {
  // Statement has never forked it and must not start now. The engine is
  // imported and run for real by PART 1 of this file; what is asserted here is
  // that it knows nothing about prompts.
  const engine = readFileSync(
    fileURLToPath(new URL('../../resume/draft/autosave.ts', import.meta.url)), 'utf8',
  )
  for (const foreign of [
    'prompt', 'school', 'statedMaxWords', 'statement_prompts', 'DraftPromptSnapshot',
  ]) {
    assert.equal(engine.includes(foreign), false, `the engine must not know ${foreign}`)
  }
  // And the events this editor dispatches are still only the engine's own.
  for (const event of ['edited', 'flush', 'save-started', 'save-failed', 'retry', 'reloaded']) {
    assert.ok(engine.includes(`'${event}'`), `${event} is the engine's own event`)
  }
})

test('the carried prompt is ONE piece of state, replaced wholesale', () => {
  // Four separate useStates would make a half-replaced snapshot representable.
  assert.match(CLIENT, /const \[prompt, setPrompt\] = useState<DraftPromptSnapshot>/)
  // Replaced in exactly two places, both from a SERVER response: the conflict
  // reload, and the successful-save reconciliation.
  assert.equal((CLIENT.match(/setPrompt\(/g) ?? []).length, 2)
  assert.match(CLIENT, /const saved = savedPromptFromResponse\(body\)/)
  // And the reload sets it beside the essay and the revision, not separately.
  const reload = CLIENT.slice(
    CLIENT.indexOf('const reloadLatest'),
    CLIENT.indexOf('const retrySave'),
  )
  assert.ok(reload.length > 0, 'the reload handler was located')
  assert.match(reload, /setEssay\(outcome\.draft\.essay\)/)
  assert.match(reload, /setPrompt\(\{/)
  assert.match(reload, /type: 'reloaded'/)
})

// ============================================ PART 2b: the optional promptId

const PICK = 'c0ffee00-0000-4000-8000-00000000000a'
const DOC = { title: 'Why I want to become a CRNA', essay: 'Opening line.', revision: 7 }

/** The body a request produced, or null if it was refused. */
const bodyOf = (over: Record<string, unknown> = {}) => {
  const request = statementSaveRequest({ ...DOC, ...over })
  return request.ok ? (request.body as Record<string, unknown>) : null
}

test('prompt: an OMITTED prompt produces exactly the original three keys', () => {
  // The body every keystroke sends. It must not have changed at all.
  const body = bodyOf()
  assert.notEqual(body, null)
  assert.deepEqual(Object.keys(body as object), ['title', 'essay', 'expectedRevision'])
  assert.equal('promptId' in (body as object), false)
  assert.deepEqual(body, {
    title: 'Why I want to become a CRNA', essay: 'Opening line.', expectedRevision: 7,
  })
})

test('prompt: EXPLICIT undefined is identical to omission', () => {
  const omitted = bodyOf()
  const explicit = bodyOf({ prompt: undefined })
  assert.deepEqual(explicit, omitted)
  assert.deepEqual(Object.keys(explicit as object), ['title', 'essay', 'expectedRevision'])
  assert.equal('promptId' in (explicit as object), false)
  // And the key is OMITTED, not present-and-undefined: JSON would drop such a
  // key, but Object.keys would report it, so a three-keyed body would not be.
  assert.equal(JSON.stringify(explicit), JSON.stringify(omitted))
})

test('prompt: NULL carries promptId: null -- an explicit clear', () => {
  const body = bodyOf({ prompt: null })
  assert.deepEqual(Object.keys(body as object).sort(),
    ['essay', 'expectedRevision', 'promptId', 'title'])
  assert.equal((body as Record<string, unknown>).promptId, null)
  assert.equal('promptId' in (body as object), true)
  // Over the wire too: null survives serialisation, absence does not.
  assert.match(JSON.stringify(body), /"promptId":null/)
})

test('prompt: A UUID carries exactly that id', () => {
  const body = bodyOf({ prompt: PICK })
  assert.equal((body as Record<string, unknown>).promptId, PICK)
  assert.deepEqual(Object.keys(body as object).sort(),
    ['essay', 'expectedRevision', 'promptId', 'title'])
  // Any case, unchanged: Postgres compares uuids by value.
  assert.equal((bodyOf({ prompt: PICK.toUpperCase() }) as Record<string, unknown>).promptId,
    PICK.toUpperCase())
})

test('prompt: OMITTED, NULL AND A UUID ARE THREE DIFFERENT BODIES', () => {
  const omitted = JSON.stringify(bodyOf())
  const cleared = JSON.stringify(bodyOf({ prompt: null }))
  const selected = JSON.stringify(bodyOf({ prompt: PICK }))
  assert.equal(new Set([omitted, cleared, selected]).size, 3)
  // An autosave that omitted the prompt must not read as a clear.
  assert.equal(omitted.includes('promptId'), false)
  assert.equal(cleared.includes('promptId'), true)
})

test('prompt: AN INVALID PROMPT IS REFUSED, never a dropped field', () => {
  // Silently omitting a malformed id would turn "save this prompt" into
  // "change nothing" -- a save reporting success with the selection gone.
  for (const bogus of [
    'not-a-uuid', '', ' ', `${PICK}0`, PICK.slice(0, -1), 42, 0, true, false,
    [], [PICK], {}, { id: PICK }, () => PICK, NaN,
  ]) {
    const request = statementSaveRequest({ ...DOC, prompt: bogus })
    assert.equal(request.ok, false, JSON.stringify(bogus) ?? String(bogus))
    if (request.ok) return
    assert.equal(request.code, 'invalid-prompt')
    assert.equal(request.message, PROMPT_BLOCKED_MESSAGE)
    // Never an echo of what was supplied.
    assert.equal(request.message.includes(String(bogus)) && String(bogus).length > 2, false)
  }
})

test('prompt: the DOCUMENT is validated FIRST, so the refusal order is unchanged', () => {
  // A body wrong in both ways still reports the document's code.
  const both = statementSaveRequest({ title: '   ', essay: 'e', revision: 1, prompt: 'nope' })
  assert.equal(both.ok, false)
  assert.equal(both.ok === false && both.code, 'invalid-title')

  const essayFirst = statementSaveRequest({
    title: 'Fine', essay: 42 as never, revision: 1, prompt: 'nope',
  })
  assert.equal(essayFirst.ok === false && essayFirst.code, 'invalid-essay')

  const revisionNext = statementSaveRequest({
    title: 'Fine', essay: 'e', revision: 0, prompt: 'nope',
  })
  assert.equal(revisionNext.ok === false && revisionNext.code, 'invalid-revision')
})

test('prompt: title, essay and revision validation are UNTOUCHED', () => {
  // The same normalisation, with and without a prompt.
  for (const prompt of [undefined, null, PICK] as const) {
    const body = bodyOf({ title: '  Padded title  ', essay: '  kept  ', prompt })
    assert.equal((body as Record<string, unknown>).title, 'Padded title', 'trimmed')
    assert.equal((body as Record<string, unknown>).essay, '  kept  ', 'NOT trimmed')
    assert.equal((body as Record<string, unknown>).expectedRevision, 7)
  }
  // The ceilings still refuse, whatever the prompt says.
  const long = statementSaveRequest({
    title: 'Fine', essay: 'a'.repeat(MAX_SAVED_CHARS + 1), revision: 7, prompt: PICK,
  })
  assert.equal(long.ok === false && long.code, 'essay-too-long')
  assert.equal(long.ok === false && long.message, BLOCKED_MESSAGES['essay-too-long'])
})

test('prompt: the revision is the engine’s, and a prompt does not add one', () => {
  for (const prompt of [undefined, null, PICK] as const) {
    for (const revision of [1, 7, MAX_EXPECTED_REVISION]) {
      const body = bodyOf({ revision, prompt })
      assert.equal((body as Record<string, unknown>).expectedRevision, revision)
    }
  }
  // And an un-incrementable revision is still refused, prompt or no prompt.
  const over = statementSaveRequest({
    ...DOC, revision: MAX_EXPECTED_REVISION + 1, prompt: PICK,
  })
  assert.equal(over.ok === false && over.code, 'invalid-revision')
})

test('prompt: NO CANONICAL FIELD CAN ENTER THE BODY', () => {
  // The whole trust boundary. A caller supplying the school, the wording or the
  // word limit changes nothing: the builder reads one key and builds the rest.
  const hostile = {
    ...DOC,
    prompt: PICK,
    schoolId: 'aaaaaaaa-0000-4000-8000-00000000beef',
    school_id: 'aaaaaaaa-0000-4000-8000-00000000beef',
    promptText: 'Write about anything at all, with no limit.',
    prompt_text: 'Write about anything at all, with no limit.',
    statedMaxWords: 999999,
    stated_max_words: 999999,
    promptId: 'bbbbbbbb-0000-4000-8000-00000000dead',
  }
  const body = bodyOf(hostile)
  assert.deepEqual(Object.keys(body as object).sort(),
    ['essay', 'expectedRevision', 'promptId', 'title'])
  // `prompt` is the parameter; a stray `promptId` on the INPUT is not read.
  assert.equal((body as Record<string, unknown>).promptId, PICK)
  const wire = JSON.stringify(body)
  for (const spoof of ['beef', 'dead', '999999', 'anything at all', 'school', 'stated']) {
    assert.equal(wire.includes(spoof), false, `${spoof} must never be sent`)
  }
})

test('prompt: saveAttemptFor forwards the prompt and leaves the SNAPSHOT alone', () => {
  for (const [prompt, expected] of [
    [undefined, undefined], [null, null], [PICK, PICK],
  ] as const) {
    const attempt = saveAttemptFor({ ...DOC, title: '  Padded  ', prompt })
    assert.equal(attempt.ok, true)
    if (!attempt.ok) return

    // The body carries the prompt exactly as the builder decided.
    if (expected === undefined) assert.equal('promptId' in attempt.body, false)
    else assert.equal(attempt.body.promptId, expected)

    // THE SNAPSHOT IS THE SAME FOUR FIELDS IT HAS ALWAYS BEEN, and carries no
    // prompt: it exists to reconcile the TITLE, and titleAfterSave reads only
    // `raw`. Which prompt the draft answers comes back in the response.
    assert.deepEqual(Object.keys(attempt.snapshot).sort(),
      ['essay', 'expectedRevision', 'raw', 'sent'])
    assert.equal(attempt.snapshot.raw, '  Padded  ')
    assert.equal(attempt.snapshot.sent, 'Padded')
    assert.equal(attempt.snapshot.essay, 'Opening line.')
    assert.equal(attempt.snapshot.expectedRevision, 7)
    assert.equal('promptId' in attempt.snapshot, false)
    assert.equal('prompt' in attempt.snapshot, false)
  }
})

test('prompt: RECONCILIATION IS UNCHANGED by a prompt travelling with the save', () => {
  // titleAfterSave is the behaviour a prompt could plausibly have disturbed.
  const withPrompt = saveAttemptFor({ ...DOC, title: '  Padded  ', prompt: PICK })
  assert.equal(withPrompt.ok, true)
  if (!withPrompt.ok) return
  const snapshot = withPrompt.snapshot

  // Nobody typed since: the field takes the normalised title.
  assert.equal(titleAfterSave({ snapshot, currentTitle: '  Padded  ' }), 'Padded')
  // Somebody typed since: the newer text wins.
  assert.equal(titleAfterSave({ snapshot, currentTitle: 'Something newer' }), null)
  // Already right: nothing to do.
  assert.equal(titleAfterSave({ snapshot, currentTitle: 'Padded' }), null)
  // And identical to the no-prompt case, field for field.
  const without = saveAttemptFor({ ...DOC, title: '  Padded  ' })
  assert.equal(without.ok, true)
  if (!without.ok) return
  assert.deepEqual(without.snapshot, snapshot)
})

test('prompt: NO SECOND SAVE PATH was introduced', () => {
  // One builder, one attempt builder, one body shape. The editor source is
  // asserted elsewhere; this pins the module's own surface.
  const EDITOR = readFileSync(path('./editor.ts'), 'utf8')
  const code = EDITOR
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.equal(code.includes('export function statementSaveRequest'), true)
  assert.equal(code.includes('export function saveAttemptFor'), true)
  for (const forbidden of [
    'fetch(', "method: 'PATCH'", "method: 'POST'", 'XMLHttpRequest',
    'promptSavePath', 'savePrompt', 'patchPrompt',
  ]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} must not appear`)
  }
  // draftApiPath is still the ONE address, and still built from the id alone.
  assert.equal((code.match(/export function draftApiPath/g) ?? []).length, 1)
  assert.match(code, /return `\/api\/statement\/drafts\/\$\{id\}`/)
})

test('prompt: SAVE_BLOCKED_MESSAGES extends BLOCKED_MESSAGES without changing it', () => {
  // http.ts keys VALIDATION_MESSAGES and statusForValidation on DraftRefusal,
  // so 'invalid-prompt' stays out of that union and out of this map.
  assert.equal(Object.keys(BLOCKED_MESSAGES).length, 5)
  assert.equal('invalid-prompt' in BLOCKED_MESSAGES, false)
  assert.equal(Object.keys(SAVE_BLOCKED_MESSAGES).length, 6)
  assert.equal(SAVE_BLOCKED_MESSAGES['invalid-prompt'], PROMPT_BLOCKED_MESSAGE)
  for (const [code, message] of Object.entries(BLOCKED_MESSAGES)) {
    assert.equal(SAVE_BLOCKED_MESSAGES[code as keyof typeof BLOCKED_MESSAGES], message)
  }
  // Six distinct sentences: two identical ones would be two states a reader
  // cannot tell apart.
  const messages = Object.values(SAVE_BLOCKED_MESSAGES)
  assert.equal(new Set(messages).size, messages.length)
})

test('prompt: THE SELECTION HANDLER IS THE ONLY WAY TO SET A PENDING PROMPT', () => {
  // Retargeted for J2b: the applicant can choose now. The invariant is that
  // exactly ONE handler assigns a selection, and it dispatches an ordinary edit
  // rather than reaching for a request.
  assert.match(CLIENT, /const pendingPrompt = useRef<PendingPrompt \| null>\(null\)/)
  assert.match(CLIENT, /const lastPromptToken = useRef\(0\)/)

  // Exactly two kinds of assignment: the one selection, and clearing.
  const writes = [...new Set(CLIENT.match(/pendingPrompt\.current = [^\n]+/g) ?? [])].sort()
  assert.deepEqual(writes, ['pendingPrompt.current = next', 'pendingPrompt.current = null'])
  // The assignment happens once, inside choosePrompt, and nowhere else.
  const choose = CLIENT.slice(CLIENT.indexOf('const choosePrompt'), CLIENT.indexOf('const retryPromptSave'))
  assert.ok(choose.length > 0, 'choosePrompt was located')
  assert.equal((choose.match(/pendingPrompt\.current = next/g) ?? []).length, 1)
  assert.match(choose, /lastPromptToken\.current \+= 1/)
  assert.match(choose, /setSave\(\(state\) => reduce\(state, \{ type: 'edited'/)
  // AND IT ISSUES NO REQUEST. No endpoint, no fetch, no startSave.
  for (const forbidden of ['fetch(', 'draftApiPath', 'startSave(', "method: 'PATCH'"]) {
    assert.equal(choose.includes(forbidden), false, `choosePrompt must not ${forbidden}`)
  }
  // The ref and its render mirror move together.
  assert.match(choose, /setPendingView\(next\)/)
})

test('prompt: THE ATTACH BUTTON IS LIVE, and carries only an id', () => {
  // STRIPPED, because both components' comments say in prose that they hold no
  // Supabase client -- and a blacklist over the raw text would match that
  // sentence rather than any code. CLIENT is already stripped; this matches it.
  const PICKER = strip(readFileSync(
    path('../../../app/statement-studio/components/PromptPicker.tsx'), 'utf8'
  ))
  assert.match(CLIENT, /onUsePrompt=\{choosePrompt\}/)
  assert.match(CLIENT, /onRetryPromptSave=\{retryPromptSave\}/)
  assert.match(PICKER, /onClick=\{\(\) => onUsePrompt\(preview\.id\)\}/)
  assert.match(PICKER, /onUsePrompt: \(promptId: string\) => void/)
  // Still no persistence path in the picker.
  assert.equal(PICKER.includes("method: 'PATCH'"), false)
  assert.equal((PICKER.match(/await fetch\(/g) ?? []).length, 1)
  // And no browser-side database access, in either component.
  for (const source of [CLIENT, PICKER]) {
    for (const forbidden of [/createClient/, /supabase/i, /@supabase/]) {
      assert.doesNotMatch(source, forbidden)
    }
  }
})

test('lifecycle: the SAVE SITE captures the pending selection exactly once', () => {
  // Synchronously, before anything can await, and the captured value stays in
  // the request's closure -- the ref may move on while it is in the air.
  const start = CLIENT.slice(CLIENT.indexOf('const startSave'), CLIENT.indexOf('useEffect(() => {\n    const action'))
  assert.ok(start.length > 0, 'startSave was located')

  assert.equal((start.match(/const captured = pendingPrompt\.current/g) ?? []).length, 1)
  // Captured BEFORE the attempt is built, and the attempt is built before the
  // fetch -- so nothing awaited can change what this request sends.
  assert.ok(start.indexOf('const captured') < start.indexOf('saveAttemptFor({'))
  assert.ok(start.indexOf('saveAttemptFor({') < start.indexOf('await fetch('))
  assert.match(start, /prompt: promptForRequest\(captured\)/)
  // And the ref is not re-read after the await.
  const afterFetch = start.slice(start.indexOf('await fetch('))
  assert.equal(afterFetch.includes('pendingPrompt.current = pendingPrompt'), false)
})

test('lifecycle: RETIREMENT IS GUARDED BY IDENTITY AND BY A USABLE SNAPSHOT', () => {
  const start = CLIENT.slice(CLIENT.indexOf('const startSave'), CLIENT.indexOf('useEffect(() => {\n    const action'))

  // Only on save-succeeded, only for this snapshot, only when the server's
  // snapshot parsed, and only when the pending selection is still the same one.
  assert.match(start, /event\.type === 'save-succeeded' && snapshotRef\.current === snapshot/)
  assert.match(start, /const saved = savedPromptFromResponse\(body\)/)
  assert.match(start, /if \(saved !== null\) \{/)
  assert.match(start, /if \(samePendingPrompt\(pendingPrompt\.current, captured\)\) \{/)

  // THE ORDER MATTERS: the snapshot must be read before the retirement, so a
  // malformed body retires nothing.
  assert.ok(start.indexOf('const saved = savedPromptFromResponse') < start.indexOf('samePendingPrompt('))
  // And the display is only ever set from the server's snapshot.
  assert.match(start, /setPrompt\(saved\)/)
})

test('lifecycle: NO FAILURE PATH TOUCHES THE PENDING SELECTION', () => {
  const start = CLIENT.slice(CLIENT.indexOf('const startSave'), CLIENT.indexOf('useEffect(() => {\n    const action'))

  // The catch block and the finally block retire the SNAPSHOT, never the
  // pending prompt -- so a network error, a 409, a 401, a 400 and a 500 all
  // leave the selection standing for the engine's next save.
  const tail = start.slice(start.indexOf('} catch {'))
  assert.ok(tail.length > 0, 'the catch/finally was located')
  assert.equal(tail.includes('pendingPrompt'), false, 'failures must not clear it')
  assert.match(tail, /if \(snapshotRef\.current === snapshot\) snapshotRef\.current = null/)
  // No new retry machinery was added.
  assert.equal((CLIENT.match(/setTimeout\(/g) ?? []).length, 1, 'only the driver’s wait timer')
  assert.equal((CLIENT.match(/type: 'retry'/g) ?? []).length, 1, 'only the manual retry')
})

test('lifecycle: THE CONFLICT RELOAD DISCARDS IT, AND SAYS SO', () => {
  const reload = CLIENT.slice(CLIENT.indexOf('const reloadLatest'), CLIENT.indexOf('const retrySave'))

  // Recorded before it is cleared, so the notice can be conditional.
  assert.match(reload, /const discarded = pendingPrompt\.current !== null/)
  assert.match(reload, /pendingPrompt\.current = null/)
  assert.ok(reload.indexOf('const discarded') < reload.indexOf('pendingPrompt.current = null'))

  // ONLY WHEN SOMETHING WAS PENDING.
  assert.match(reload, /if \(discarded\) setNotice\(PICKER_MESSAGES\.selectionDiscarded\)/)
  // The server's snapshot still replaces the display, as before.
  assert.match(reload, /setPrompt\(\{\n\s*schoolId: outcome\.draft\.schoolId/)
  // AND NO SAVE IS STARTED: the discarded selection is not re-applied.
  assert.equal(reload.includes('startSave('), false)
  assert.equal(reload.includes("type: 'edited'"), false)
  assert.match(reload, /type: 'reloaded'/)
})

test('lifecycle: an in-flight response cannot act after a reload', () => {
  const reload = CLIENT.slice(CLIENT.indexOf('const reloadLatest'), CLIENT.indexOf('const retrySave'))
  // Both guards are disarmed by the reload: the snapshot identity (so no title
  // or prompt is written) and the pending identity (so nothing is retired).
  assert.match(reload, /snapshotRef\.current = null/)
  assert.match(reload, /pendingPrompt\.current = null/)
  // Unmount does the same.
  assert.match(CLIENT, /alive\.current = false\n\s*snapshotRef\.current = null\n\s*uploadRef\.current = null\n\s*pendingPrompt\.current = null/)
})

test('lifecycle: STILL ONE PATCH, ONE BODY, ONE ENGINE', () => {
  // No second persistence request and no second save path.
  assert.equal((CLIENT.match(/method: 'PATCH'/g) ?? []).length, 1)
  assert.equal((CLIENT.match(/JSON\.stringify\(/g) ?? []).length, 1)
  assert.equal(CLIENT.split('body: JSON.stringify(attempt.body)').length - 1, 1)
  assert.equal((CLIENT.match(/await fetch\(/g) ?? []).length, 3)
  // And the engine is used through its public events only -- the same six.
  assert.deepEqual(
    [...new Set((CLIENT.match(/type: '[a-z-]+'/g) ?? []))].sort(),
    [
      "type: 'edited'", "type: 'flush'", "type: 'reloaded'",
      "type: 'retry'", "type: 'save-failed'", "type: 'save-started'",
    ]
  )
})

test('unconfirmed: AN UNREADABLE 200 WARNS AND RETIRES NOTHING', () => {
  const start = CLIENT.slice(CLIENT.indexOf('const startSave'), CLIENT.indexOf('const action = statementDriverAction'))

  // The else-branch: a 200 whose canonical fields did not parse, for a request
  // that actually carried a selection.
  assert.match(start, /\} else if \(captured !== null\) \{\n\s*setPromptConfirmFailed\(captured\.token\)/)
  // The pending selection is NOT retired there: the only retirement sits inside
  // the `saved !== null` branch.
  const elseBranch = start.slice(start.indexOf('} else if (captured !== null) {'))
  assert.equal(elseBranch.includes('pendingPrompt.current = null'), false)
  assert.equal(elseBranch.includes('setPendingView(null)'), false)
  // AND NOTHING AUTOMATIC SCHEDULES ANOTHER SAVE. No edited, no flush, no
  // timer: a server returning malformed bodies would otherwise be saved
  // against for ever.
  assert.equal(elseBranch.includes("type: 'edited'"), false, 'no automatic retry')
  assert.equal(elseBranch.includes("type: 'flush'"), false)
  assert.equal(elseBranch.includes('setTimeout'), false)
  assert.equal(elseBranch.includes('startSave('), false)
})

test('unconfirmed: THE DELIBERATE RETRY IS THE ONLY RESCHEDULER', () => {
  const retry = CLIENT.slice(CLIENT.indexOf('const retryPromptSave'), CLIENT.indexOf('const onTitleChange'))
  assert.ok(retry.length > 0, 'retryPromptSave was located')

  // It needs something pending, uses the engine's own edited event, and starts
  // no request of its own -- so the existing driver and in-flight guard apply.
  assert.match(retry, /if \(pendingPrompt\.current === null\) return/)
  assert.match(retry, /setSave\(\(state\) => reduce\(state, \{ type: 'edited'/)
  for (const forbidden of ['fetch(', 'startSave(', 'draftApiPath', "method: 'PATCH'", 'setTimeout']) {
    assert.equal(retry.includes(forbidden), false, `the retry must not ${forbidden}`)
  }
  // It does NOT invent a revision: the driver uses save.revision, which only a
  // server response ever sets.
  assert.equal(retry.includes('revision'), false)

  // AND IT IS REACHED ONLY FROM A CLICK.
  assert.match(CLIENT, /onRetryPromptSave=\{retryPromptSave\}/)
  assert.equal((CLIENT.match(/retryPromptSave/g) ?? []).length, 2, 'declared once, passed once')
})

test('unconfirmed: the warning is CLEARED on a new choice, a success and a reload', () => {
  // Four places, and no more: superseded, confirmed, reloaded, and the one
  // place it is set.
  const sets = CLIENT.match(/setPromptConfirmFailed\([^\n]*/g) ?? []
  assert.equal(sets.length, 4, 'one set, three clears')

  const choose = CLIENT.slice(CLIENT.indexOf('const choosePrompt'), CLIENT.indexOf('const retryPromptSave'))
  assert.match(choose, /setPromptConfirmFailed\(null\)/)            // superseded

  const start = CLIENT.slice(CLIENT.indexOf('const startSave'), CLIENT.indexOf('const action = statementDriverAction'))
  assert.match(start, /setPromptConfirmFailed\(\(failed\) =>/)       // confirmed
  assert.match(start, /setPromptConfirmFailed\(captured\.token\)/)   // set

  const reload = CLIENT.slice(CLIENT.indexOf('const reloadLatest'), CLIENT.indexOf('const retrySave'))
  assert.match(reload, /setPromptConfirmFailed\(null\)/)             // reloaded
})

test('unconfirmed: the render mirror moves with the ref, except at unmount', () => {
  // pendingView exists only so the picker can render; a divergence would show a
  // state the editor is not in. UNMOUNT IS THE ONE EXCEPTION, and deliberately
  // so: the component is going away, and setting state on it would be a
  // meaningless update on something nothing will render.
  const refWrites = (CLIENT.match(/pendingPrompt\.current = /g) ?? []).length
  const viewWrites = (CLIENT.match(/setPendingView\(/g) ?? []).length
  assert.equal(refWrites, 4, 'select, retire, reload, unmount')
  assert.equal(viewWrites, 3, 'select, retire, reload -- not unmount')

  // Each of the three live sites pairs them.
  for (const [name, from, to] of [
    ['choosePrompt', 'const choosePrompt', 'const retryPromptSave'],
    ['startSave', 'const startSave', 'const action = statementDriverAction'],
    ['reloadLatest', 'const reloadLatest', 'const retrySave'],
  ] as const) {
    const region = CLIENT.slice(CLIENT.indexOf(from), CLIENT.indexOf(to))
    assert.ok(region.length > 0, `${name} was located`)
    assert.equal(
      (region.match(/pendingPrompt\.current = /g) ?? []).length,
      (region.match(/setPendingView\(/g) ?? []).length,
      `${name} must move both together`
    )
  }

  // And unmount retires the ref without touching state.
  const unmount = CLIENT.slice(CLIENT.indexOf('alive.current = false'), CLIENT.indexOf('const startSave'))
  assert.match(unmount, /pendingPrompt\.current = null/)
  assert.equal(unmount.includes('setPendingView'), false, 'no state update on a dead component')
})

test('unconfirmed: THE SELECTION ALONE SCHEDULES A SAVE', () => {
  // choosePrompt dispatches `edited`, and nextAction reads only timers and
  // status -- never the title or the essay -- so a prompt change with no text
  // change still saves. The engine proves it; this pins the dispatch.
  const choose = CLIENT.slice(CLIENT.indexOf('const choosePrompt'), CLIENT.indexOf('const retryPromptSave'))
  assert.match(choose, /type: 'edited'/)
  // And it does not touch the document.
  for (const forbidden of ['setTitle(', 'setEssay(', 'essayRef.current =']) {
    assert.equal(choose.includes(forbidden), false, `choosePrompt must not ${forbidden}`)
  }
  // The engine still sees only its six public events.
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
const SCHOOL = 'bbbbbbbb-2222-4222-8222-222222222222'
const PROMPT = 'c0ffee00-3333-4333-8333-333333333333'
const WORDING = 'Why have you chosen nurse anaesthesia?'

/**
 * A reload body. GENERIC BY DEFAULT -- four explicit nulls -- because that is
 * what every draft looks like today, and because leaving the four off would
 * make these fixtures exercise the absent-field path by accident.
 */
const ok = (over: Record<string, unknown> = {}) => ({
  draft: {
    id: ID, title: 'Server title', essay: 'Server essay.', revision: 9,
    schoolId: null, promptId: null, promptText: null, statedMaxWords: null,
    ...over,
  },
})

/** The same body with a prompt chosen. */
const okChosen = (over: Record<string, unknown> = {}) => ok({
  schoolId: SCHOOL, promptId: PROMPT, promptText: WORDING, statedMaxWords: 500, ...over,
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
    draft: {
      id: ID, title: 'Server title', essay: 'Server essay.', revision: 9,
      schoolId: null, promptId: null, promptText: null, statedMaxWords: null,
    },
  })
  // The title goes through the same checkTitle the API validates with.
  const padded = reloadOutcomeFrom({ status: 200, body: ok({ title: '  Padded  ' }), expectedId: ID })
  assert.equal(padded.ok && padded.draft.title, 'Padded')
  // An empty essay is legitimate and must not be mistaken for a bad response.
  const empty = reloadOutcomeFrom({ status: 200, body: ok({ essay: '' }), expectedId: ID })
  assert.equal(empty.ok && empty.draft.essay, '')
})

test('reload: a CHOSEN prompt comes back with all four exact values', () => {
  const outcome = reloadOutcomeFrom({ status: 200, body: okChosen(), expectedId: ID })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.draft.schoolId, SCHOOL)
  assert.equal(outcome.draft.promptId, PROMPT)
  assert.equal(outcome.draft.promptText, WORDING)
  assert.equal(outcome.draft.statedMaxWords, 500)
})

test('reload: a GENERIC draft comes back as four explicit nulls', () => {
  const outcome = reloadOutcomeFrom({ status: 200, body: ok(), expectedId: ID })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  for (const key of ['schoolId', 'promptId', 'promptText', 'statedMaxWords'] as const) {
    assert.equal(key in outcome.draft, true, `${key} must be present`)
    assert.equal(outcome.draft[key], null, `${key} must be null`)
  }
})

test('reload: statedMaxWords null SURVIVES on a chosen prompt', () => {
  // A school stating no word limit is a real snapshot, not a defective one.
  const outcome = reloadOutcomeFrom({
    status: 200, body: okChosen({ statedMaxWords: null }), expectedId: ID,
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.draft.promptId, PROMPT)
  assert.equal(outcome.draft.statedMaxWords, null)
  assert.equal('statedMaxWords' in outcome.draft, true)
})

test('reload: MISSING prompt properties are REFUSED, not read as null', () => {
  // A response that omits the four is a stale deployment or a rewritten body.
  // Reading it as "no prompt" would make a reload silently discard the
  // applicant's selection -- the exact loss this parser prevents.
  for (const key of ['schoolId', 'promptId', 'promptText', 'statedMaxWords'] as const) {
    const body = okChosen()
    delete (body.draft as Record<string, unknown>)[key]
    const outcome = reloadOutcomeFrom({ status: 200, body, expectedId: ID })
    assert.equal(outcome.ok, false, `a body missing ${key} must be refused`)
    assert.equal(outcome.ok === false && outcome.message, RELOAD_MESSAGES.unreadable)

    // Explicit undefined is the same answer, since it is indistinguishable.
    const explicit = reloadOutcomeFrom({
      status: 200, body: okChosen({ [key]: undefined }), expectedId: ID,
    })
    assert.equal(explicit.ok, false, `an undefined ${key} must be refused`)
  }
  // A pre-prompt response -- the four simply absent -- is refused too.
  const stale = { draft: { id: ID, title: 'T', essay: 'E', revision: 9 } }
  assert.equal(reloadOutcomeFrom({ status: 200, body: stale, expectedId: ID }).ok, false)
})

test('reload: PARTIAL or malformed prompt metadata is REFUSED', () => {
  const broken: Record<string, unknown>[] = [
    { schoolId: SCHOOL },                                   // school alone
    { promptId: PROMPT },                                   // id alone
    { promptText: WORDING },                                // wording alone
    { statedMaxWords: 500 },                                // a limit alone
    { schoolId: SCHOOL, promptId: PROMPT },                 // no wording
    { schoolId: null, promptId: PROMPT, promptText: WORDING, statedMaxWords: 500 },
    { schoolId: SCHOOL, promptId: null, promptText: WORDING, statedMaxWords: 500 },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: null, statedMaxWords: 500 },
    { schoolId: 'not-a-uuid', promptId: PROMPT, promptText: WORDING, statedMaxWords: 1 },
    { schoolId: SCHOOL, promptId: 'not-a-uuid', promptText: WORDING, statedMaxWords: 1 },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: '   ', statedMaxWords: 1 },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: WORDING, statedMaxWords: 0 },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: WORDING, statedMaxWords: 5001 },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: WORDING, statedMaxWords: '500' },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: 'a'.repeat(5001), statedMaxWords: 1 },
  ]
  for (const over of broken) {
    const outcome = reloadOutcomeFrom({ status: 200, body: ok(over), expectedId: ID })
    assert.equal(outcome.ok, false, JSON.stringify(over))
    assert.equal(outcome.ok === false && outcome.message, RELOAD_MESSAGES.unreadable)
  }
})

test('reload: the SAME RULES as a database row, not a second interpretation', () => {
  // reloadOutcomeFrom calls rows.ts's parser rather than repeating it. This is
  // what would fail if a copy were introduced and then drifted.
  const cases: Record<string, unknown>[] = [
    { schoolId: SCHOOL, promptId: PROMPT, promptText: WORDING, statedMaxWords: 500 },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: WORDING, statedMaxWords: null },
    { schoolId: null, promptId: null, promptText: null, statedMaxWords: null },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: WORDING, statedMaxWords: 5001 },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: '  ', statedMaxWords: 1 },
    { schoolId: SCHOOL, promptId: PROMPT, promptText: '\u{1f642}'.repeat(3000), statedMaxWords: 1 },
  ]
  for (const over of cases) {
    const viaReload = reloadOutcomeFrom({ status: 200, body: ok(over), expectedId: ID }).ok
    const viaRows = draftPromptFrom(over as never) !== undefined
    assert.equal(viaReload, viaRows, `disagreed about ${JSON.stringify(over)}`)
  }
})

test('reload: THE CONFLICT RELOAD REPLACES THE PROMPT, in every direction', () => {
  // The four transitions a conflict can produce. In each, what the reload hands
  // back is the SERVER's prompt, never a merge with what was held locally.
  const OTHER_SCHOOL = 'dddddddd-4444-4444-8444-444444444444'
  const OTHER_PROMPT = 'eeeeeeee-5555-4555-8555-555555555555'

  // selected -> a DIFFERENT selected prompt
  const moved = reloadOutcomeFrom({
    status: 200,
    body: okChosen({
      schoolId: OTHER_SCHOOL, promptId: OTHER_PROMPT,
      promptText: 'Describe a time you advocated for a patient.', statedMaxWords: 750,
    }),
    expectedId: ID,
  })
  assert.equal(moved.ok, true)
  if (!moved.ok) return
  assert.deepEqual(
    [moved.draft.schoolId, moved.draft.promptId, moved.draft.promptText, moved.draft.statedMaxWords],
    [OTHER_SCHOOL, OTHER_PROMPT, 'Describe a time you advocated for a patient.', 750],
  )
  // Nothing of the losing revision's prompt is left.
  assert.notEqual(moved.draft.promptId, PROMPT)
  assert.equal(JSON.stringify(moved.draft).includes(WORDING), false)

  // selected -> GENERIC: all four cleared.
  const cleared = reloadOutcomeFrom({ status: 200, body: ok(), expectedId: ID })
  assert.equal(cleared.ok, true)
  if (!cleared.ok) return
  assert.deepEqual(
    [cleared.draft.schoolId, cleared.draft.promptId, cleared.draft.promptText,
      cleared.draft.statedMaxWords],
    [null, null, null, null],
  )

  // generic -> SELECTED: all four installed.
  const installed = reloadOutcomeFrom({ status: 200, body: okChosen(), expectedId: ID })
  assert.equal(installed.ok, true)
  if (!installed.ok) return
  assert.deepEqual(
    [installed.draft.schoolId, installed.draft.promptId, installed.draft.promptText,
      installed.draft.statedMaxWords],
    [SCHOOL, PROMPT, WORDING, 500],
  )

  // statedMaxWords: number -> null, and null -> number.
  const toNull = reloadOutcomeFrom({
    status: 200, body: okChosen({ statedMaxWords: null }), expectedId: ID,
  })
  assert.equal(toNull.ok && toNull.draft.statedMaxWords, null)
  const toNumber = reloadOutcomeFrom({
    status: 200, body: okChosen({ statedMaxWords: 250 }), expectedId: ID,
  })
  assert.equal(toNumber.ok && toNumber.draft.statedMaxWords, 250)
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
  // ORDERING, not adjacency: both refs are retired BEFORE the local version is
  // replaced. The pending prompt is now retired between them, so the lines are
  // no longer consecutive -- but the guarantee is the order, not the spacing.
  for (const retired of [
    'snapshotRef.current = null', 'uploadRef.current = null', 'pendingPrompt.current = null',
  ]) {
    assert.ok(reload.includes(retired), `${retired} must happen in the reload`)
    assert.ok(
      reload.indexOf(retired) < reload.indexOf('setTitle(outcome.draft.title)'),
      `${retired} must come before the local version is replaced`
    )
  }
  // Identity, not a flag: a response holding a retired snapshot cannot match.
  assert.match(CLIENT, /snapshotRef\.current === snapshot/)
  assert.match(CLIENT, /if \(snapshotRef\.current === snapshot\) snapshotRef\.current = null/)
  // Unmount retires it too.
  assert.match(CLIENT, /alive\.current = false\n\s*snapshotRef\.current = null/)
})

test('a reload replaces the title from the validated server draft', () => {
  const outcome = reloadOutcomeFrom({
    status: 200,
    body: ok({ title: '  Server title  ' }),
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

/* ===========================================================================
 * THE WRITING WORKSPACE.
 *
 * The counters RUN; the layout assertions read the component's source, which
 * node --test cannot import. Neither is a browser, and none of this says how
 * anything looks.
 * ======================================================================== */

test('a word count is words, and an empty page is zero', () => {
  assert.equal(wordCount(''), 0)
  assert.equal(wordCount('   \n\n\t '), 0, 'whitespace is not a word')
  assert.equal(wordCount('one'), 1)
  assert.equal(wordCount('  one  '), 1, 'the ends do not count')
  assert.equal(wordCount('one two three'), 3)
  // A paragraph break is one separator, not an extra word.
  assert.equal(wordCount('one two\n\n\nthree   four'), 4)
  assert.equal(wordCount('line one\nline two'), 4)
})

test('hyphens and apostrophes stay inside one word', () => {
  assert.equal(wordCount("evidence-based practice"), 2)
  assert.equal(wordCount("I'm a nurse"), 3)
})

test('the word count is display only and refuses nothing', () => {
  // The stored ceiling is MAX_SAVED_CHARS, counted in characters. A word count
  // that could block a save would be a second limit nobody agreed to.
  assert.equal(wordCount(42 as never), 0, 'a non-string is zero, never a throw')
  assert.doesNotMatch(CLIENT, /wordCount\([^)]*\)\s*>\s*\d/, 'no save decision reads it')
  assert.doesNotMatch(CLIENT, /blocked.*wordCount|wordCount.*blocked/)
})

test('a school that stated no limit gets no progress at all', () => {
  // NULL IS NOT ZERO. A school that published no limit has not published a
  // limit of nothing, and an empty bar would read as "none of your allowance".
  assert.equal(wordLimitProgress({ words: 100, statedMaxWords: null }), null)
  assert.equal(wordLimitProgress({ words: 100, statedMaxWords: 0 }), null)
  assert.equal(wordLimitProgress({ words: 100, statedMaxWords: -5 }), null)
})

test('progress reports going over without clamping the truth', () => {
  const under = wordLimitProgress({ words: 250, statedMaxWords: 500 })
  assert.deepEqual(under, { words: 250, limit: 500, ratio: 0.5, over: false, remaining: 250 })

  const over = wordLimitProgress({ words: 600, statedMaxWords: 500 })
  assert.equal(over?.over, true)
  assert.equal(over?.remaining, -100, 'the overshoot is reported honestly')
  // The RATIO is clamped so a bar stays inside its track; the numbers are not.
  assert.equal(over?.ratio, 1)

  const empty = wordLimitProgress({ words: 0, statedMaxWords: 500 })
  assert.equal(empty?.ratio, 0)
  assert.equal(empty?.over, false)
})

test('the editor reserves the fixed nav, exactly as the library does', () => {
  // Without it, mx-auto centres against the viewport and the nav covers the
  // left of the result. The width is read from the shared context so the
  // editor reflows when the nav is collapsed.
  assert.match(CLIENT, /useSidebarCollapsed/)
  assert.match(CLIENT, /sidebarCollapsed \? 'lg:ml-20' : 'lg:ml-64'/)
  assert.match(CLIENT, /min-w-0 flex-1/, 'a flex item must be allowed to shrink')
  assert.match(CLIENT, /pt-16 lg:pt-0/, 'the floating menu button needs clearing below lg')
  assert.equal(
    (CLIENT.match(/ml-64/g) ?? []).length, (CLIENT.match(/lg:ml-64/g) ?? []).length,
    'the offset is lg-only',
  )
})

test('two columns on desktop, one on everything smaller', () => {
  assert.match(CLIENT, /lg:grid-cols-12/)
  assert.match(CLIENT, /lg:col-span-8/, 'the statement takes two thirds')
  assert.match(CLIENT, /lg:col-span-4/, 'the prompt takes one')
  // Nothing is a column below lg, so the sections stack.
  assert.doesNotMatch(CLIENT, /(?<!lg:)grid-cols-12/)
})

test('the prompt panel sticks without covering anything or trapping scroll', () => {
  assert.match(CLIENT, /lg:sticky lg:top-5 lg:self-start/)
  // self-start keeps it at content height: a stretched grid item has nowhere
  // to stick. Its own max-height and overflow keep a long question inside it.
  assert.match(CLIENT, /lg:max-h-\[calc\(100vh-2\.5rem\)\] lg:overflow-y-auto/)
  assert.match(CLIENT, /lg:overscroll-contain/, 'scrolling the panel must not chain to the page')
  assert.match(CLIENT, /items-start/, 'and the row must not stretch its children')
})

test('the writing area is still a textarea, and still refuses to truncate', () => {
  assert.match(CLIENT, /<textarea/)
  assert.match(CLIENT, /value=\{essay\}/)
  assert.match(CLIENT, /readOnly=\{conflicted\}/)
  assert.doesNotMatch(CLIENT, /maxLength/)
  assert.doesNotMatch(CLIENT, /\.slice\(0,|substring\(/)
  // No rich-text editor arrived wearing a layout change's clothes.
  assert.doesNotMatch(CLIENT, /contentEditable|dangerouslySetInnerHTML|execCommand/)
  assert.match(CLIENT, /min-h-\[32rem\]/, 'and it is generous before anything is typed')
})

test('the import control is still reachable by keyboard', () => {
  // sr-only, NOT hidden: a display:none input is not focusable, so the label
  // would be unreachable without a mouse.
  const input = CLIENT.slice(CLIENT.indexOf('ref={fileInput}'))
  assert.match(input.slice(0, 320), /className="sr-only"/)
  assert.doesNotMatch(input.slice(0, 320), /className="hidden"/)
  assert.match(CLIENT, /accept=\{ACCEPT_ATTRIBUTE\}/)
})

test('the banner says what is actually built', () => {
  // Import shipped; the analyser did not. The old wording claimed the opposite
  // about upload.
  assert.doesNotMatch(CLIENT, /not wired up/i)
  assert.match(CLIENT, /Drafting and document import are available/)
  assert.match(CLIENT, /AI analyzer is not built yet/)
})

test('the analyzer area is a label, not a button', () => {
  const area = CLIENT.slice(CLIENT.indexOf('Analyze this draft'))
  assert.match(area.slice(0, 400), /Coming soon/)
  assert.doesNotMatch(area.slice(0, 400), /<button/, 'nothing clickable with nothing behind it')
  assert.doesNotMatch(CLIENT, /onAnalyze|analyzeDraft|\/api\/statement\/analyze/)
})

test('the redesign added no request, and no database access', () => {
  // Still exactly the three fetches this editor has always made.
  assert.equal((CLIENT.match(/await fetch\(/g) ?? []).length, 3)
  for (const forbidden of [/createClient/, /supabase/i, /@supabase/]) {
    assert.doesNotMatch(CLIENT, forbidden)
  }
  // And no write of any kind for a counter or a layout preference.
  assert.doesNotMatch(CLIENT, /localStorage|sessionStorage/)
})

test('the saved snapshot is what is rendered, never the catalog', () => {
  assert.match(CLIENT, /\{prompt\.promptText\}/)
  assert.match(CLIENT, /saved=\{prompt\}/)
  // The school NAME is looked up, which is a label for an id the draft already
  // holds -- not a second source for the wording.
  assert.match(CLIENT, /schoolNameFor\(schools, prompt\.schoolId\)/)
  assert.doesNotMatch(CLIENT, /schools\.map|schools\.filter/)
})

/* ===========================================================================
 * ONE PROMPT ON SCREEN, AND CONTROLS THAT STAY OUT OF THE WAY.
 * ======================================================================== */

test('the saved prompt is rendered once, by the panel, not twice', () => {
  // The editor shows the snapshot; the picker is told the parent has it and
  // omits its own copy. Two renderings of one question on one screen is the
  // thing this removes.
  assert.match(CLIENT, /savedShownByParent/)
  assert.match(CLIENT, /\{prompt\.promptText\}/)
  assert.equal((CLIENT.match(/\{prompt\.promptText\}/g) ?? []).length, 1)
  // And the panel keeps everything the applicant needs beside it.
  assert.match(CLIENT, /schoolNameFor\(schools, prompt\.schoolId\)/)
  assert.match(CLIENT, /wordLimitLabel\(prompt\.statedMaxWords\)/)
  assert.match(CLIENT, /\{promptNotice\}/)
})

test('the controls are collapsed once a prompt is attached, and reachable', () => {
  assert.match(CLIENT, /const \[pickerExpanded, setPickerExpanded\] = useState\(false\)/)
  assert.match(CLIENT, /Change school or prompt/)
  assert.match(CLIENT, /aria-expanded=\{pickerOpen\}/)
  assert.match(CLIENT, /aria-controls="statement-prompt-controls"/)
  assert.match(CLIENT, /id="statement-prompt-controls"/)
  // A general draft opens on the picker: it is the whole point of that panel.
  assert.match(CLIENT, /const pickerOpen = !hasPrompt \|\| pickerExpanded \|\| confirmPending/)
})

test('AN UNCONFIRMED PROMPT SAVE CANNOT BE COLLAPSED AWAY FROM', () => {
  // The warning and its deliberate retry live inside the picker. A draft whose
  // prompt save came back unreadable must never leave the applicant believing
  // it was saved, so while that warning applies the panel is forced open and
  // the toggle is withdrawn.
  assert.match(CLIENT, /const confirmPending = confirmationApplies\(\{/)
  assert.match(CLIENT, /failedToken: promptConfirmFailed/)
  assert.match(CLIENT, /pending: pendingView/)
  assert.match(CLIENT, /\{hasPrompt && !confirmPending && \(/, 'no toggle while it applies')
})

test('collapsing hides without unmounting, so nothing is thrown away', () => {
  // `hidden` removes the subtree from layout, tab order and the accessibility
  // tree while the component keeps its state -- a search in progress survives,
  // and a reply still in flight lands on a component that is still mounted.
  assert.match(CLIENT, /hidden=\{!pickerOpen\}/)
  assert.doesNotMatch(CLIENT, /\{pickerOpen && <PromptPicker/, 'unmounting would discard state')
})

test('opening or closing the controls saves nothing', () => {
  // The toggle writes one boolean and touches no draft state, no engine event
  // and no request.
  // Sliced to the button's CLOSING TAG, not to the first '>': the arrow
  // function in onClick contains one, and cutting there would read nothing.
  const from = CLIENT.indexOf('aria-expanded={pickerOpen}')
  assert.notEqual(from, -1, 'the toggle was not found')
  const handler = CLIENT.slice(from, CLIENT.indexOf('</button>', from))
  assert.ok(handler.length > 0)
  assert.match(handler, /setPickerExpanded\(\(open\) => !open\)/)
  for (const forbidden of [/setPrompt\(/, /dispatch/, /startSave/, /fetch\(/, /choosePrompt/]) {
    assert.doesNotMatch(handler, forbidden, 'the toggle is presentation only')
  }
})
