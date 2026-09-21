import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyGrantAuthority,
  blockerMessage,
  evaluateResume,
  isExpired,
  restoreTranscript,
  validatePendingTurn,
  validateState,
  RESUME_WINDOW_MS,
} from './resume.ts'
import type { GrantRow, SessionRow } from './resume.ts'
import { createInitialState, applyTurn } from './state.ts'
import { MAX_TURNS_PER_INTERVIEW } from '../interviewSession.ts'
import { TURN_TIMEOUT_NOTICE } from './turnProtocol.ts'
import { buildSessionRow } from './sessionSaver.ts'
import type { ChatMessage, InterviewState, ModelTurn, TurnAction } from './types.ts'

/**
 * Resuming an interview after a refresh.
 *
 * The defect this closes: an interview lived in three pieces of React memory
 * -- transcript, engine state, and the grant id -- and a refresh destroyed all
 * three. The transcript and state were persisted, but the grant id was not, so
 * even a perfect restore produced an interview whose next turn was a 403.
 * Starting again charged the applicant a second time.
 *
 * The security shape of the fix is what most of these tests are about. The
 * browser never presents a grant id to resume: it presents a session id it
 * already owns, and the SERVER resolves the grant from the binding it wrote
 * itself. Nothing here is inferred from timing, type or mode.
 */

const PAGE = readFileSync(new URL('../../app/interview/page.tsx', import.meta.url), 'utf8')
const RESUME_ROUTE = readFileSync(new URL('../../app/api/interview/resume/route.ts', import.meta.url), 'utf8')
const BIND_ROUTE = readFileSync(new URL('../../app/api/interview/bind/route.ts', import.meta.url), 'utf8')
const SESSION_SRC = readFileSync(new URL('../interviewSession.ts', import.meta.url), 'utf8')
const SAVER_SRC = readFileSync(new URL('./sessionSaver.ts', import.meta.url), 'utf8')
const MIGRATION = readFileSync(
  new URL('../../supabase/migrations/20260921_001_interview_resume.sql', import.meta.url),
  'utf8'
)
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

const USER = 'user-1'
const OTHER = 'user-2'
const SESSION_ID = 'session-1'

const turn = (action: TurnAction, over: Partial<ModelTurn> = {}): ModelTurn => ({
  action,
  display_text: 'text',
  question_asked: 'q',
  scenario_label: 'label',
  category: 'clinical',
  question_format: 'scenario',
  concepts_tested: [],
  difficulty_level: 3,
  evaluation: null,
  final_report: null,
  internal_note: '',
  ...over,
})

/** An interview that has asked two questions and taken one answer. */
function liveState(over: Partial<InterviewState> = {}): InterviewState {
  let s = createInitialState({ mode: 'practice', type: 'clinical', followUpsEnabled: true })
  s = applyTurn(s, turn('next_primary'))
  s = applyTurn(s, turn('next_primary'))
  return { ...s, ...over }
}

const msgs = (n = 4): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: i % 2 === 0 ? `question ${i / 2 + 1}` : 'an answer',
  }))

const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
  id: 'grant-1',
  user_id: USER,
  session_id: SESSION_ID,
  turns_used: 3,
  completed: false,
  abandoned_at: null,
  created_at: new Date().toISOString(),
  follow_ups_enabled: true,
  ...over,
})

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: SESSION_ID,
  user_id: USER,
  conversation: msgs(),
  engine_state: liveState(),
  pending_turn: null,
  ...over,
})

// ==========================================================================
// 1. Eligibility
// ==========================================================================

test('a live, owned, bound interview is resumable', () => {
  const v = evaluateResume(session(), grant(), USER)
  assert.equal(v.resumable, true)
  if (!v.resumable) return
  assert.equal(v.state.primaryQuestionNumber, 2)
  assert.equal(v.messages.length, 4)
  assert.equal(v.pendingTurn, null)
})

test('every disqualifying condition is refused, with its own reason', () => {
  const cases: [string, SessionRow | null, GrantRow | null, string][] = [
    ['completed grant', session(), grant({ completed: true }), 'completed'],
    ['abandoned grant', session(), grant({ abandoned_at: new Date().toISOString() }), 'abandoned'],
    ['turn cap reached', session(), grant({ turns_used: MAX_TURNS_PER_INTERVIEW }), 'turn_cap_reached'],
    ['no engine state', session({ engine_state: null }), grant(), 'no_state'],
    ['finished interview', session({ engine_state: { ...liveState(), complete: true } }), grant(), 'completed'],
    ['missing grant', session(), null, 'not_found'],
    ['missing session', null, grant(), 'not_found'],
  ]
  for (const [label, s, g, reason] of cases) {
    const v = evaluateResume(s, g, USER)
    assert.equal(v.resumable, false, label)
    if (!v.resumable) assert.equal(v.reason, reason, label)
  }
})

test('an interview expires 24 hours after the grant was issued', () => {
  const now = Date.now()
  const fresh = grant({ created_at: new Date(now - 23 * 60 * 60 * 1000).toISOString() })
  assert.equal(evaluateResume(session(), fresh, USER, now).resumable, true, '23h is still live')

  const stale = grant({ created_at: new Date(now - 25 * 60 * 60 * 1000).toISOString() })
  const v = evaluateResume(session(), stale, USER, now)
  assert.equal(v.resumable, false)
  if (!v.resumable) assert.equal(v.reason, 'expired')
  assert.equal(RESUME_WINDOW_MS, 24 * 60 * 60 * 1000)
})

test('expiry is measured from the server-issued grant, never the session row', () => {
  // interview_sessions is written by the browser. If its timestamp decided
  // expiry, a client could hold an interview open forever.
  assert.match(strip(RESUME_ROUTE) + strip(SESSION_SRC), /created_at/)
  const g = grant({ created_at: 'not-a-date' })
  assert.equal(isExpired(g), true, 'an unreadable grant timestamp fails closed')
})

test('an unbound grant makes an interview non-resumable, which is what retires old sessions', () => {
  // Every grant predating this feature has session_id null and is never
  // backfilled, so history becomes read-only with no special-case code.
  const v = evaluateResume(session(), grant({ session_id: null }), USER)
  assert.equal(v.resumable, false)
  if (!v.resumable) assert.equal(v.reason, 'not_found')
  assert.match(MIGRATION, /NOT backfilled/i)
})

test('a grant bound to a different session cannot be aimed at this one', () => {
  const v = evaluateResume(session(), grant({ session_id: 'some-other-session' }), USER)
  assert.equal(v.resumable, false)
})

// ==========================================================================
// 2. Authorization
// ==========================================================================

test('ownership is checked on BOTH rows', () => {
  assert.equal(evaluateResume(session({ user_id: OTHER }), grant(), USER).resumable, false, 'session')
  assert.equal(evaluateResume(session(), grant({ user_id: OTHER }), USER).resumable, false, 'grant')
})

test('cross-user probing leaks no information', () => {
  // Unknown, not-yours and never-bound must be indistinguishable, or the
  // difference maps out which session ids exist.
  const reasons = [
    evaluateResume(null, null, USER),
    evaluateResume(session({ user_id: OTHER }), grant({ user_id: OTHER }), USER),
    evaluateResume(session(), grant({ session_id: null }), USER),
  ].map((v) => (v.resumable ? 'resumable' : v.reason))
  assert.deepEqual(reasons, ['not_found', 'not_found', 'not_found'])
  assert.equal(new Set(reasons.map(blockerMessage as any)).size, 1, 'and they read identically')
})

test('the client never supplies a grant id to resume', () => {
  const route = strip(RESUME_ROUTE)
  assert.match(route, /findGrantBySession\(admin, sessionId, userId\)|findGrantBySession\(admin, sessionId, auth\.userId\)/)
  assert.doesNotMatch(route, /body\?\.grantId|searchParams\.get\('grantId'\)/, 'no grant id is read from the request')
  // The one place a grant id is accepted is the one-time bind.
  assert.match(strip(BIND_ROUTE), /body\?\.grantId/)
})

test('binding is a conditional write, not read-then-write', () => {
  const src = strip(SESSION_SRC)
  assert.match(src, /\.is\('session_id', null\)/, 'the WHERE clause is what makes it one-time')
  assert.match(src, /\.eq\('user_id', userId\)/, 'and it can only ever bind your own grant')
  // Session ownership is proved with the service role, not taken on trust.
  assert.match(src, /from\('interview_sessions'\)[\s\S]{0,200}\.eq\('id', sessionId\)/)
})

// ==========================================================================
// 3. Entitlements — resume must never charge
// ==========================================================================

test('no resume path charges an interview or reserves a turn', () => {
  for (const [name, src] of [['resume', RESUME_ROUTE], ['bind', BIND_ROUTE]] as const) {
    const s = strip(src)
    assert.doesNotMatch(s, /chargeInterview/, `${name} never charges`)
    assert.doesNotMatch(s, /reserveTurn|consume_interview_turn/, `${name} never reserves a turn`)
    assert.doesNotMatch(s, /createGrant/, `${name} never issues a new grant`)
    assert.doesNotMatch(s, /openai|OPENAI|gpt-/i, `${name} never calls the model`)
  }
})

test('resume reuses the existing row rather than starting a second one', () => {
  const page = strip(PAGE)
  assert.match(page, /existingRowId: resumable\.sessionId/)
  assert.match(page, /grantIdRef\.current = body\.grantId/)
})

test('only a genuine start is charged, and resume cannot look like one', () => {
  // The turn route charges on isOpeningTurn(state) && messages.length === 0.
  // A resumed interview restores a transcript and a question number, so it can
  // never satisfy either half.
  const v = evaluateResume(session(), grant(), USER)
  assert.equal(v.resumable, true)
  if (!v.resumable) return
  assert.ok(v.messages.length > 0, 'messages are restored')
  assert.ok(v.state.primaryQuestionNumber > 0, 'and the question number with them')
})

// ==========================================================================
// 4. Transcript restoration
// ==========================================================================

test('the transcript is restored in order, without duplication', () => {
  const conversation = msgs(6)
  const restored = restoreTranscript(conversation)
  assert.deepEqual(restored, conversation)
  assert.equal(restored!.length, 6, 'nothing added')
})

test('a Phase 0 failure notice is never restored as an interviewer turn', () => {
  const polluted: ChatMessage[] = [
    { role: 'assistant', content: 'question 1' },
    { role: 'user', content: 'an answer' },
    { role: 'assistant', content: TURN_TIMEOUT_NOTICE },
    { role: 'assistant', content: 'question 2' },
  ]
  const restored = restoreTranscript(polluted)!
  assert.equal(restored.length, 3)
  assert.ok(!restored.some((m) => m.content === TURN_TIMEOUT_NOTICE))
})

test('a malformed transcript is refused rather than repaired', () => {
  assert.equal(restoreTranscript(null), null)
  assert.equal(restoreTranscript('not an array'), null)
  assert.equal(restoreTranscript([{ role: 'assistant' }]), null)
  assert.equal(evaluateResume(session({ conversation: 'nope' }), grant(), USER).resumable, false)
})

test('the answer box comes back empty', () => {
  const page = strip(PAGE)
  const fn = page.slice(page.indexOf('const resumeInterview'), page.indexOf('const discardResumable'))
  assert.match(fn, /setInput\(''\)/, 'never pre-filled with the previous answer')
})

// ==========================================================================
// 5. Engine state validation
// ==========================================================================

test('state must agree with the transcript it claims to belong to', () => {
  // Question 7 against a two-message transcript is not a state to clamp; it is
  // two different interviews written into one row.
  const mismatched = session({ engine_state: { ...liveState(), primaryQuestionNumber: 7 }, conversation: msgs(2) })
  const v = evaluateResume(mismatched, grant(), USER)
  assert.equal(v.resumable, false)
  if (!v.resumable) assert.equal(v.reason, 'state_transcript_mismatch')
})

test('malformed state is refused, not guessed at', () => {
  for (const bad of [null, 'string', 42, {}, { primaryQuestionNumber: 'two' }, { primaryQuestionNumber: 2 }]) {
    const r = validateState(bad, msgs())
    assert.equal(r.ok, false, JSON.stringify(bad))
  }
})

test('a completed interview is never resumable, by state or by report', () => {
  assert.equal(validateState({ ...liveState(), complete: true }, msgs()).ok, false)
  assert.equal(validateState({ ...liveState(), finalReport: { overall_score: 7 } }, msgs()).ok, false)
})

test('policy and version data are preserved, never silently upgraded', () => {
  const legacy = { ...liveState(), followUpsEnabled: true, maxFollowUps: 3, followUpBudget: 8, maxFollowUpBudget: 8 }
  const v = evaluateResume(session({ engine_state: legacy }), grant(), USER)
  assert.equal(v.resumable, true)
  if (!v.resumable) return
  assert.equal(v.state.maxFollowUpBudget, 8, 'the budget it started with')
  assert.equal(v.state.maxFollowUps, 3)
})

test('the grant overrides the browser copy of what it owns', () => {
  // Otherwise a refresh would be a way to launder an edited state back in.
  const tampered = { ...liveState(), followUpsEnabled: true }
  const v = evaluateResume(session({ engine_state: tampered }), grant({ follow_ups_enabled: false }), USER)
  assert.equal(v.resumable, true)
  if (!v.resumable) return
  assert.equal(v.state.followUpsEnabled, false, 'the grant wins')
})

test('a future server-authoritative length would override too, with no redesign', () => {
  // Phase 3 adds max_primary_questions to the grant; resume already applies it.
  const s = applyGrantAuthority(liveState(), grant({ max_primary_questions: 5 }))
  assert.equal(s.maxPrimaryQuestions, 5)
  assert.equal(applyGrantAuthority(liveState(), grant()).maxPrimaryQuestions, 10, 'absent changes nothing')
})

// ==========================================================================
// 6. Practice checkpoint
// ==========================================================================

const checkpoint = (over: Record<string, unknown> = {}) => ({
  message: { role: 'assistant', content: 'question 3' },
  state: liveState({ primaryQuestionNumber: 3 }),
  questionAsked: 'question 3',
  isFinal: false,
  ...over,
})

test('an open checkpoint is restored with the question already paid for', () => {
  const v = evaluateResume(session({ pending_turn: checkpoint() }), grant(), USER)
  assert.equal(v.resumable, true)
  if (!v.resumable) return
  assert.ok(v.pendingTurn, 'the deferred half survives the refresh')
  assert.equal(v.pendingTurn!.message.content, 'question 3')
  assert.equal(v.pendingTurn!.isFinal, false)
})

test('the final checkpoint, which legitimately carries a complete state, survives', () => {
  const final = checkpoint({
    isFinal: true,
    state: { ...liveState(), complete: true, finalReport: { overall_score: 7 } },
  })
  const v = evaluateResume(session({ pending_turn: final }), grant(), USER)
  assert.equal(v.resumable, true)
  if (!v.resumable) return
  assert.equal(v.pendingTurn!.isFinal, true)
})

test('a malformed checkpoint fails the resume rather than being dropped', () => {
  // Dropping it would strand the applicant on a review whose Continue button
  // has nothing to continue to, and the only rebuild is a model call the
  // interview has already paid for.
  for (const bad of [{ message: 'not a message' }, checkpoint({ isFinal: 'yes' }), checkpoint({ state: null }), 'x']) {
    const v = evaluateResume(session({ pending_turn: bad }), grant(), USER)
    assert.equal(v.resumable, false, JSON.stringify(bad).slice(0, 40))
  }
})

test('no checkpoint is the normal case and is not an error', () => {
  assert.deepEqual(validatePendingTurn(null, msgs()), { ok: true, pending: null })
  assert.deepEqual(validatePendingTurn(undefined, msgs()), { ok: true, pending: null })
})

test('the checkpoint is persisted when opened and cleared when consumed', () => {
  const page = strip(PAGE)
  assert.match(page, /await saveSession\(shown, engineState, checkpoint\)/, 'opened')
  assert.match(page, /await saveSession\(revealed, next\.state, null\)/, 'consumed')
})

test('Continue reveals the stored question without calling the model', () => {
  const page = strip(PAGE)
  const fn = page.slice(page.indexOf('const resumeInterview'), page.indexOf('const discardResumable'))
  assert.match(fn, /setPendingNext\(body\.pendingTurn/)
  assert.doesNotMatch(fn, /requestTurn|\/api\/interview'/, 'resume asks for no turn')
})

test('the saver carries pending_turn and clears it explicitly', () => {
  const row = buildSessionRow(
    { userId: USER, interviewType: 'clinical', customTopic: '', mode: 'practice' },
    { conversation: msgs(), state: liveState(), pendingTurn: checkpoint() as any },
    true
  )
  assert.ok(row.pending_turn, 'written when open')
  const cleared = buildSessionRow(
    { userId: USER, interviewType: 'clinical', customTopic: '', mode: 'practice' },
    { conversation: msgs(), state: liveState() },
    true
  )
  assert.equal(cleared.pending_turn, null, 'explicitly nulled, not omitted')
})

test('a deployment without the column still saves engine_state', () => {
  // The fallback steps down one column at a time; collapsing straight to the
  // base row would re-open the defect Phase 0 closed.
  const row = buildSessionRow(
    { userId: USER, interviewType: 'clinical', customTopic: '', mode: 'practice' },
    { conversation: msgs(), state: liveState() },
    true,
    false
  )
  assert.equal('pending_turn' in row, false)
  assert.ok(row.engine_state, 'engine_state survives the step down')
})

// ==========================================================================
// 7. Abandonment
// ==========================================================================

test('abandoning is not completing', () => {
  const src = strip(SESSION_SRC)
  const fn = src.slice(src.indexOf('export async function abandonGrant'))
  assert.match(fn, /abandoned_at: new Date\(\)\.toISOString\(\)/)
  assert.doesNotMatch(fn.slice(0, fn.indexOf('}')), /completed: true/, 'never marks it complete')
  assert.match(MIGRATION, /abandoned_at timestamptz/)
})

test('an abandoned grant stops authorizing turns, not just resumes', () => {
  // Otherwise a tab still holding the old grant id could keep taking turns in
  // an interview the applicant has already replaced.
  assert.match(strip(SESSION_SRC), /if \(data\.abandoned_at\)/)
  const v = evaluateResume(session(), grant({ abandoned_at: new Date().toISOString() }), USER)
  assert.equal(v.resumable, false)
})

test('discarding refunds nothing', () => {
  const page = strip(PAGE)
  const fn = page.slice(page.indexOf('const discardResumable'), page.indexOf('const retrySave'))
  assert.doesNotMatch(fn, /interview_count|setInterviewCount/, 'no entitlement is handed back')
})

// ==========================================================================
// 8. UX and wiring
// ==========================================================================

test('the page never auto-enters a resumed interview', () => {
  const page = strip(PAGE)
  const init = page.slice(page.indexOf('const init = async'), page.indexOf('const loadInterviewHistory'))
  assert.match(init, /checkResumable/)
  assert.doesNotMatch(init, /setStarted\(true\)/, 'the applicant has to ask')
  assert.match(page, /Interview in progress/)
  assert.match(page, /onClick=\{resumeInterview\}/)
  assert.match(page, /onClick=\{discardResumable\}/)
})

test('a failed binding is surfaced rather than hidden', () => {
  const page = strip(PAGE)
  assert.match(page, /setBindFailed\(true\)/)
  assert.match(page, /may not be recoverable if you refresh/)
})

test('binding happens before the applicant gets far, and is retried', () => {
  const page = strip(PAGE)
  assert.match(page, /await bindSession\(String\(saved\.rowId\), grantIdRef\.current\)/)
  const fn = page.slice(page.indexOf('const bindSession'), page.indexOf('const retrySave'))
  assert.match(fn, /attempt <= 3/, 'retried')
  assert.match(fn, /res\.status !== 500 && res\.status !== 503/, 'but a refusal is final')
})

test('the migration adds only what resume needs, and no table', () => {
  assert.match(MIGRATION, /alter table public\.interview_grants\s+add column if not exists session_id uuid/)
  assert.match(MIGRATION, /add column if not exists abandoned_at timestamptz/)
  assert.doesNotMatch(MIGRATION, /resume_count/, 'a counter would make POST /resume unsafe to retry')
  assert.match(MIGRATION, /alter table public\.interview_sessions\s+add column if not exists pending_turn jsonb/)
  assert.doesNotMatch(MIGRATION, /create table/i, 'no new tables')
  // One session, one grant, enforced by Postgres rather than by application code.
  assert.match(
    MIGRATION,
    /create unique index if not exists interview_grants_session_id_key\s+on public\.interview_grants \(session_id\)\s+where session_id is not null/
  )
})

// ==========================================================================
// 9. Correction 1 — one session, one grant, enforced by Postgres
// ==========================================================================

test('the binding uniqueness is a database constraint, not application logic', () => {
  // A conditional UPDATE narrows the race; it cannot close it. Two requests can
  // both see session_id IS NULL on two DIFFERENT grants and both aim at one
  // session. Only a unique index arbitrates that.
  assert.match(
    MIGRATION,
    /create unique index if not exists interview_grants_session_id_key\s+on public\.interview_grants \(session_id\)\s+where session_id is not null/
  )
  // Checked against DDL only: the file explains at length WHY there is no
  // foreign key, and the prose must not fail its own test.
  const ddl = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  assert.doesNotMatch(ddl, /foreign key|references /i, 'still no hard FK')
})

test('all four binding outcomes are handled', () => {
  const src = strip(SESSION_SRC)
  const fn = src.slice(src.indexOf('export async function bindGrantToSession'), src.indexOf('export async function findGrantBySession'))

  // A -> X: the conditional UPDATE is what performs the first bind.
  assert.match(fn, /\.update\(\{ session_id: sessionId \}\)[\s\S]{0,160}\.is\('session_id', null\)/)
  // A -> X again: no row matches, so the same pair is confirmed and accepted.
  assert.match(fn, /existing\.session_id === sessionId[\s\S]{0,80}alreadyBound: true/)
  // A -> Y: same lookup, different session, refused.
  assert.match(fn, /return denied/)
  // B -> X: the UPDATE succeeds the null check but Postgres refuses it.
  assert.match(fn, /error\.code === UNIQUE_VIOLATION/)
})

test('a unique conflict is refused without confirming another grant holds the session', () => {
  const src = strip(SESSION_SRC)
  const fn = src.slice(src.indexOf('export async function bindGrantToSession'))
  const conflict = fn.slice(fn.indexOf('UNIQUE_VIOLATION'), fn.indexOf('UNIQUE_VIOLATION') + 260)
  assert.match(conflict, /return denied/, 'the caller gets the standard refusal')
  // `denied` is the same object every other refusal returns, so a conflict is
  // indistinguishable from "not yours" or "no such session".
  assert.match(fn, /const denied = \{[\s\S]{0,200}status: 403/)
})

test('binding can only ever target the caller\'s own rows', () => {
  const src = strip(SESSION_SRC)
  const fn = src.slice(src.indexOf('export async function bindGrantToSession'), src.indexOf('export async function findGrantBySession'))
  assert.match(fn, /\.eq\('user_id', userId\)/, 'the grant must be yours')
  assert.match(fn, /!session \|\| session\.user_id !== userId/, 'and so must the session')
})

// ==========================================================================
// 10. Correction 2 — Q1 is not interactive until the binding succeeds
// ==========================================================================

test('the opening question is buffered, not rendered, until bound', () => {
  const page = strip(PAGE)
  const start = page.slice(page.indexOf('const startInterview'), page.indexOf('const sendMessage'))
  assert.match(start, /pendingStartRef\.current = \{ convo, data \}/, 'Q1 goes to a buffer')
  assert.doesNotMatch(start, /setMessages\(convo\)/, 'and never straight to the screen')
  assert.match(start, /setInitializing\(true\)/)

  const finish = page.slice(page.indexOf('const finishStart'), page.indexOf('const exitFailedStart'))
  assert.ok(
    finish.indexOf('if (!bound) return') < finish.indexOf('boundRef.current = true'),
    'the bind is confirmed before anything is marked bound'
  )
  assert.ok(
    finish.indexOf('boundRef.current = true') < finish.indexOf('activateBufferedStart()'),
    'and activation happens only after that'
  )
  const activator = page.slice(page.indexOf('const activateBufferedStart'), page.indexOf('const finishStart'))
  assert.ok(
    activator.indexOf('if (!boundRef.current) return') < activator.indexOf('setMessages(buffered.convo)'),
    'the transcript is populated only behind the gate'
  )
})

test('the initializing state is what the applicant sees while binding', () => {
  assert.match(PAGE, /started && initializing \?/, 'it takes priority over the chat view')
  assert.match(PAGE, /Setting up your interview/)
  assert.match(PAGE, /Saving your session so you can resume it later/)
})

test('retrying initialization replays only the save and the bind', () => {
  const page = strip(PAGE)
  const finish = page.slice(page.indexOf('const finishStart'), page.indexOf('const exitFailedStart'))
  // No second model call, no second grant, no second charge: finishStart
  // touches none of them. It reads the buffer it was given.
  assert.doesNotMatch(finish, /requestTurn|\/api\/interview'/, 'no model call on retry')
  assert.doesNotMatch(finish, /createGrant|grantId:/, 'no new grant on retry')
  assert.doesNotMatch(finish, /setInterviewCount|interview_count/, 'no second charge on retry')
  assert.match(finish, /const buffered = pendingStartRef\.current/, 'it replays the buffered turn')
  assert.match(PAGE, /onClick=\{finishStart\}/, 'and the applicant can trigger it')
})

test('retrying reuses the same session row rather than inserting another', () => {
  const page = strip(PAGE)
  const finish = page.slice(page.indexOf('const finishStart'), page.indexOf('const exitFailedStart'))
  assert.match(finish, /await saveSession\(buffered\.convo, buffered\.data\.state\)/)
  // The saver owns the row id after the first successful write, so the second
  // call is an UPDATE. That is the Phase 0 guarantee this leans on.
  assert.match(strip(SAVER_SRC), /let rowId: RowId \| null = opts\.existingRowId \?\? null/)
  assert.match(strip(SAVER_SRC), /if \(rowId === null\) \{/, 'insert only while there is no row yet')
})

test('the charge happens once, before initialization, and never inside the retry', () => {
  const page = strip(PAGE)
  const start = page.slice(page.indexOf('const startInterview'), page.indexOf('const sendMessage'))
  const charge = start.indexOf('setInterviewCount(')
  const buffer = start.indexOf('pendingStartRef.current = { convo, data }')
  assert.ok(charge > -1 && buffer > -1)
  assert.ok(charge > buffer, 'the count is read from the server response, once')
  // And the retry path contains no charge at all.
  const finish = page.slice(page.indexOf('const finishStart'), page.indexOf('const exitFailedStart'))
  assert.doesNotMatch(finish, /setInterviewCount/)
})

test('there is no Continue-anyway path', () => {
  assert.doesNotMatch(PAGE, /Continue anyway/, 'the copy is gone')
  assert.doesNotMatch(PAGE, /continueWithoutBinding/, 'and so is the handler')
})

test('a failed binding offers only Try again and a safe exit', () => {
  assert.match(PAGE, /We couldn&apos;t finish setting up/)
  assert.match(PAGE, /onClick=\{finishStart\}/, 'Try again replays save + bind')
  assert.match(PAGE, /onClick=\{exitFailedStart\}/, 'and the applicant can leave')
  assert.match(PAGE, /Back to setup/)
})

test('the failure copy never implies the attempt was free', () => {
  // The model call really happened, so the entitlement really may be spent.
  // Telling the applicant otherwise is a lie they discover at their next
  // interview, and this phase adds no refund.
  assert.doesNotMatch(PAGE, /Nothing was lost/i)
  // Scoped to the failure panel and the exit message: the page elsewhere
  // legitimately advertises free interviews at signup.
  const panel = PAGE.slice(PAGE.indexOf('We couldn&apos;t finish setting up'), PAGE.indexOf('Setting up your interview'))
  assert.doesNotMatch(panel, /no charge|for free|at no cost|won&apos;t count|will not count/i)
  assert.match(panel, /may already count toward your\s+interview usage/)
  const exit = PAGE.slice(PAGE.indexOf('const exitFailedStart'), PAGE.indexOf('const retrySave'))
  assert.doesNotMatch(exit, /Nothing was lost|no charge|for free/i)
  assert.match(exit, /may already count toward your interview usage/, 'the exit message says so too')
  assert.match(exit, /follows the usual limits/)
})

test('Try again is the recommended action, and says why it is cheap', () => {
  const page = PAGE
  const panel = page.slice(page.indexOf('We couldn&apos;t finish setting up'), page.indexOf('Setting up your interview'))
  // Primary: the filled button. Secondary: the outlined one.
  assert.match(panel, /onClick=\{finishStart\}[\s\S]{0,200}bg-violet-600/, 'Try again is primary')
  assert.match(panel, /onClick=\{exitFailedStart\}[\s\S]{0,200}border border-slate-300/, 'exit is secondary')
  assert.ok(panel.indexOf('Try again') < panel.indexOf('Back to setup'), 'and it comes first')
  assert.match(panel, /Trying again reuses this same interview and won&apos;t use another/)
  assert.match(panel, /Starting a new\s+one from setup follows the usual limits/)
})

test('an unbound session is never presented as a completed interview', () => {
  // Documented rather than changed: the history table has no completed/status
  // column at all. It shows mode, type, score and date, and a session with no
  // final report renders a dash -- identical to any other unfinished interview.
  const page = strip(PAGE)
  assert.doesNotMatch(page, />\s*Completed\s*</, 'no Completed label exists to be shown')
  assert.match(page, /const sessionScore = \(session: any\): number \| null =>/)
  assert.match(page, /session\?\.engine_state\?\.finalReport\?\.overall_score/)
  // The dash is what an unscored session renders.
  assert.match(PAGE, /score !== null \? \(Number\.isInteger\(score\) \? score : score\.toFixed\(1\)\) : '—'/)
})

test('exiting a failed start never activates the buffered question', () => {
  const page = strip(PAGE)
  const fn = page.slice(page.indexOf('const exitFailedStart'), page.indexOf('const retrySave'))
  assert.doesNotMatch(fn, /setMessages\(/, 'the transcript is never populated')
  assert.doesNotMatch(fn, /setEngineState\(buffered/, 'nor the engine state')
  assert.match(fn, /pendingStartRef\.current = null/, 'the buffer is discarded')
  assert.match(fn, /boundRef\.current = false/)
  assert.match(fn, /setStarted\(false\)/, 'and the applicant lands back on setup')
  // No refund logic in this phase.
  assert.doesNotMatch(fn, /interview_count|setInterviewCount/)
})

// --------------------------------------------------------------------------
// THE HARD INVARIANT: interactive interview => confirmed binding
// --------------------------------------------------------------------------

test('exactly one function can activate a buffered start, and it is gated', () => {
  const page = strip(PAGE)
  const fn = page.slice(page.indexOf('const activateBufferedStart'), page.indexOf('const finishStart'))
  assert.match(fn, /if \(!boundRef\.current\) return/, 'the gate is the first thing it does')
  assert.ok(
    fn.indexOf('if (!boundRef.current) return') < fn.indexOf('setMessages(buffered.convo)'),
    'and it comes before any activation'
  )
})

test('no other code path activates the buffered question', () => {
  const page = strip(PAGE)
  // Every occurrence of the buffer being adopted must live inside the one
  // guarded activator. Searching the WHOLE file, not just the visible button.
  const adoptions = [...page.matchAll(/setMessages\(buffered\.convo\)/g)]
  assert.equal(adoptions.length, 1, 'exactly one adoption site')
  const activator = page.slice(page.indexOf('const activateBufferedStart'), page.indexOf('const finishStart'))
  assert.ok(activator.includes('setMessages(buffered.convo)'), 'and it is inside the guarded activator')

  // pendingStartRef may only be read by the activator and by finishStart.
  const readers = [...page.matchAll(/pendingStartRef\.current/g)].length
  assert.ok(readers > 0)
  const outside = page
    .replace(page.slice(page.indexOf('const activateBufferedStart'), page.indexOf('const exitFailedStart')), '')
  assert.doesNotMatch(outside, /const buffered = pendingStartRef\.current[\s\S]{0,400}setMessages\(/,
    'nothing outside the activator turns the buffer into a transcript')
})

test('boundRef is only ever set true by a confirmed server binding', () => {
  const page = strip(PAGE)
  const sets = [...page.matchAll(/boundRef\.current = true/g)]
  assert.equal(sets.length, 2, 'the bind path and the resume path, and nothing else')

  // 1. finishStart: only after bindSession returned true.
  const finish = page.slice(page.indexOf('const finishStart'), page.indexOf('const exitFailedStart'))
  assert.ok(finish.indexOf('if (!bound) return') < finish.indexOf('boundRef.current = true'))

  // 2. resumeInterview: the server only returns a resume for a BOUND grant,
  //    because it resolves the grant through the binding itself.
  const resume = page.slice(page.indexOf('const resumeInterview'), page.indexOf('const discardResumable'))
  assert.match(resume, /boundRef\.current = true/)
  assert.match(strip(RESUME_ROUTE), /findGrantBySession/)
})

test('a failed bind leaves the interview inert, however many times it fails', () => {
  const page = strip(PAGE)
  const finish = page.slice(page.indexOf('const finishStart'), page.indexOf('const exitFailedStart'))
  // Every failure exit returns BEFORE boundRef is set, so a repeated failure
  // can never accumulate into an activation.
  assert.ok(finish.indexOf('setBindFailed(true)') < finish.indexOf('boundRef.current = true'))
  assert.ok(finish.indexOf('if (!bound) return') < finish.indexOf('boundRef.current = true'))
  assert.match(finish, /if \(!saved\?\.ok \|\| !saved\.rowId\) \{/, 'a failed save also stops short')
  // And the initializing view stays up, so Q1 is not on screen either.
  assert.match(PAGE, /started && initializing \?/)
})

test('Try again reuses the grant, the session row and the same question', () => {
  const page = strip(PAGE)
  const finish = page.slice(page.indexOf('const finishStart'), page.indexOf('const exitFailedStart'))
  assert.match(finish, /const buffered = pendingStartRef\.current/, 'the same generated Q1')
  assert.match(finish, /await saveSession\(buffered\.convo, buffered\.data\.state\)/, 'the same state')
  assert.match(finish, /await bindSession\(String\(saved\.rowId\), grantIdRef\.current\)/, 'the same grant')
  // The saver owns the row id, so the retry updates rather than inserts.
  assert.match(strip(SAVER_SRC), /let rowId: RowId \| null = opts\.existingRowId \?\? null/)
  // And none of the expensive things happen again.
  assert.doesNotMatch(finish, /requestTurn|createGrant|setInterviewCount/)
})

// ==========================================================================
// 11. Correction 3 — resume is a pure read
// ==========================================================================

test('resuming mutates nothing, so repeating it is safe', () => {
  const route = strip(RESUME_ROUTE)
  const post = route.slice(route.indexOf('export async function POST'), route.indexOf('export async function DELETE'))
  assert.doesNotMatch(post, /\.update\(|\.insert\(|\.rpc\(/, 'POST /resume writes nothing at all')
  assert.doesNotMatch(post, /resume_count|recordResume/, 'the counter is gone')
  assert.doesNotMatch(post, /chargeInterview|reserveTurn|createGrant/)
  assert.doesNotMatch(route, /recordResume/, 'and nothing else in the file records one')
})

test('no resume counter survives anywhere', () => {
  assert.doesNotMatch(MIGRATION, /resume_count/)
  assert.doesNotMatch(SESSION_SRC, /resume_count|recordResume/)
  assert.doesNotMatch(RESUME_ROUTE, /resume_count/)
})

test('the migration is exactly the four changes the feature needs', () => {
  const statements = MIGRATION.split('\n').filter((l) => /^(alter table|create )/i.test(l.trim()))
  assert.equal(statements.length, 4, statements.join(' | '))
  assert.match(MIGRATION, /add column if not exists session_id uuid/)
  assert.match(MIGRATION, /create unique index/)
  assert.match(MIGRATION, /add column if not exists abandoned_at timestamptz/)
  assert.match(MIGRATION, /add column if not exists pending_turn jsonb/)
})
