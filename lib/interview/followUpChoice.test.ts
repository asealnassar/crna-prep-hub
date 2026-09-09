import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  allowedActions,
  applyTurn,
  createInitialState,
  followUpCapFor,
  normalizeState,
  MAX_PRIMARY_QUESTIONS,
} from './state.ts'
import type { InterviewState, ModelTurn, TurnAction } from './types.ts'

/**
 * Follow-ups are a per-session choice, made at setup.
 *
 * Two rejected designs bracket this one. Originally the interviewer decided
 * adaptively and the applicant had no say. Then the applicant decided after
 * every single answer, which turned each question into a prompt. Now they
 * answer once, before the interview starts -- and are asked again for the next
 * interview, because a remembered answer is the same as a default.
 *
 * "No" is enforced by removing `ask_follow_up` from the response schema, not
 * by asking the model to refrain: with the action absent from the enum there
 * is nothing for it to choose.
 *
 * The state machine is exercised directly; the client is pinned by source
 * assertions, as elsewhere in this repo.
 */

const PAGE = readFileSync(new URL('../../app/interview/page.tsx', import.meta.url), 'utf8')
const ROUTE = readFileSync(new URL('../../app/api/interview/route.ts', import.meta.url), 'utf8')
const PROMPT = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8')
/** Executable text only, so a comment describing the old rule cannot pass. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const page = strip(PAGE)
const route = strip(ROUTE)
const prompt = strip(PROMPT)

const newSession = (followUpsEnabled: boolean) =>
  createInitialState({ mode: 'practice', type: 'mixed', followUpsEnabled })

/** A state sitting on primary question `n`, awaiting the applicant's answer. */
function atQuestion(n: number, followUpsEnabled: boolean, over: Partial<InterviewState> = {}): InterviewState {
  return {
    ...newSession(followUpsEnabled),
    primaryQuestionNumber: n,
    currentCategory: 'clinical',
    currentScenario: `scenario ${n}`,
    turnKind: 'primary',
    ...over,
  }
}

const turn = (action: TurnAction, over: Partial<ModelTurn> = {}): ModelTurn => ({
  action,
  display_text: 'text',
  question_asked: 'q',
  scenario_label: 'label',
  category: 'clinical',
  question_format: 'scenario',
  concepts_tested: [],
  difficulty_level: 2,
  evaluation: null,
  final_report: null,
  internal_note: '',
  ...over,
})

/** Runs an interview to completion, the interviewer probing whenever allowed. */
function runInterview(followUpsEnabled: boolean, probe: (i: number) => boolean = () => true) {
  let s = applyTurn(newSession(followUpsEnabled), turn('next_primary'))
  const numbers = [s.primaryQuestionNumber]
  let followUps = 0
  for (let i = 0; i < 80 && !s.complete; i++) {
    const actions = allowedActions(s)
    if (actions.includes('ask_follow_up') && probe(i)) {
      s = applyTurn(s, turn('ask_follow_up'))
      followUps++
      continue
    }
    if (actions.includes('final_report')) { s = applyTurn(s, turn('final_report')); break }
    s = applyTurn(s, turn('next_primary'))
    numbers.push(s.primaryQuestionNumber)
  }
  return { state: s, numbers, followUps, primaries: numbers.length }
}

// ------------------------------------------------ 1-4. the setup choice

test('a new session starts with the choice unselected', () => {
  assert.match(page, /useState<boolean \| null>\(null\)/, 'tri-state, not a boolean')
  assert.match(page, /const \[followUpsChoice, setFollowUpsChoice\]/)
})

test('the choice is never read from storage, a profile, or a previous interview', () => {
  const decl = page.slice(page.indexOf('const [followUpsChoice'), page.indexOf('const [interviewEnded'))
  assert.doesNotMatch(page, /localStorage[\s\S]{0,80}followUp/i)
  assert.doesNotMatch(page, /followUp[\s\S]{0,80}localStorage/i)
  assert.doesNotMatch(decl, /useEffect|fetch|supabase/, 'nothing hydrates it')
})

test('the interview cannot start with the choice unanswered', () => {
  // Disabled button...
  assert.match(page, /followUpsChoice === null \|\| loading/, 'Start Interview is disabled')
  // ...and a validation guard, so the disabled attribute is not the only defence.
  const startAt = page.indexOf('const startInterview')
  const start = page.slice(startAt, page.indexOf('try {', startAt))
  assert.match(start, /if \(followUpsChoice === null\) \{/, 'start is blocked before any request')
  assert.match(start, /setTurnError\(/, 'and says why')
})

test('the requirement is visible, and neither option is preselected', () => {
  assert.match(PAGE, /Include follow-up questions\?/)
  assert.match(PAGE, /Choose Yes or No to start the interview\./)
  assert.match(PAGE, /Required/)
  assert.match(page, /aria-checked=\{selected\}/)
  assert.match(page, /const selected = followUpsChoice === opt\.value/,
    'selection is compared to the applicant\'s answer, never defaulted')
})

test('choosing Yes and choosing No both produce a startable session', () => {
  assert.equal(newSession(true).followUpsEnabled, true)
  assert.equal(newSession(false).followUpsEnabled, false)
  for (const enabled of [true, false]) {
    const s = newSession(enabled)
    assert.deepEqual(allowedActions(s), ['next_primary'], 'the opening turn asks Q1 either way')
    assert.equal(applyTurn(s, turn('next_primary')).primaryQuestionNumber, 1)
  }
})

// ------------------------------------------- 5. every new session re-asks

test('a new session does not remember the previous session\'s choice', () => {
  const first = runInterview(true)
  assert.equal(first.state.followUpsEnabled, true)
  // Nothing carries from one createInitialState to the next: the value is an
  // argument, so a second session is whatever it is told.
  const second = newSession(false)
  assert.equal(second.followUpsEnabled, false)
  assert.equal(second.followUpCount, 0)
  assert.equal(second.primaryQuestionNumber, 0)
})

test('starting a new interview clears the choice in the UI', () => {
  const resetAt = page.indexOf('const resetInterview')
  const reset = page.slice(resetAt, page.indexOf('return (', resetAt))
  assert.match(reset, /setFollowUpsChoice\(null\)/, 'the next interview must ask again')
})

test('createInitialState cannot be called without stating the choice', () => {
  // Required, unoptional parameter -- there is no default to fall back on.
  assert.match(
    readFileSync(new URL('./state.ts', import.meta.url), 'utf8'),
    /followUpsEnabled: boolean\n\}\): InterviewState/,
    'no `?` and no `= true`'
  )
})

// ------------------------------------------- 6-7. server-side enforcement

test('Yes permits ask_follow_up server-side', () => {
  const s = atQuestion(1, true)
  assert.ok(allowedActions(s).includes('ask_follow_up'))
  assert.ok(followUpCapFor(s) > 0)
})

test('No makes ask_follow_up impossible server-side', () => {
  for (const n of [1, 5, MAX_PRIMARY_QUESTIONS]) {
    const s = atQuestion(n, false)
    assert.ok(!allowedActions(s).includes('ask_follow_up'), `question ${n}`)
    assert.equal(followUpCapFor(s), 0, 'the cap itself is zero')
  }
})

test('No holds even with budget and category that would otherwise permit probing', () => {
  const s = atQuestion(2, false, { followUpBudget: 8, followUpCount: 0, currentCategory: 'clinical' })
  assert.deepEqual(allowedActions(s), ['next_primary'])
})

test('a No session cannot be talked into a follow-up: the action is not in the schema', () => {
  // buildTurnSchema publishes allowedActions() as the `action` enum, so an
  // action absent here cannot be returned by the model at all.
  const schemaSrc = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8')
  assert.match(schemaSrc, /const actions: TurnAction\[\] = allowedActions\(state\)/)
  assert.match(schemaSrc, /action: \{ type: 'string', enum: actions \}/)
  assert.ok(!allowedActions(atQuestion(3, false)).includes('ask_follow_up'))
})

test('coercion and the degraded fallback are bounded by the same list', () => {
  assert.match(route, /function coerceTurn\(parsed: any, state: InterviewState\): ModelTurn \{\s*const permitted = allowedActions\(state\)/)
  assert.match(route, /function degradedTurn\(raw: string, state: InterviewState\): ModelTurn \{\s*const permitted = allowedActions\(state\)/)
})

test('the route never coerces a missing choice into an answer', () => {
  // Superseded the earlier `=== true` coercion: a start with no choice is now
  // a 400, because "unanswered" and "no follow-ups" are different things.
  assert.doesNotMatch(route, /followUpsEnabled: body\?\.followUpsEnabled === true/)
  assert.match(route, /const followUpsChoice: unknown = body\?\.followUpsEnabled/)
})

// ------------------------------------- 8. Yes is adaptive, not compulsory

test('Yes does not require a follow-up after every primary', () => {
  // The interviewer declines to probe on odd-numbered turns.
  const mixed = runInterview(true, (i) => i % 2 === 0)
  assert.equal(mixed.primaries, MAX_PRIMARY_QUESTIONS)
  assert.ok(mixed.followUps > 0, 'some probing happened')
  assert.ok(mixed.followUps < MAX_PRIMARY_QUESTIONS, 'but not after every question')

  // And declining entirely is a legal Yes interview.
  const none = runInterview(true, () => false)
  assert.equal(none.followUps, 0)
  assert.equal(none.primaries, MAX_PRIMARY_QUESTIONS)
})

test('both actions are offered on a Yes turn, so the choice is genuinely the interviewer\'s', () => {
  const actions = allowedActions(atQuestion(1, true))
  assert.deepEqual(actions, ['ask_follow_up', 'next_primary'])
})

test('the existing per-scenario cap and interview budget still bound Yes', () => {
  assert.ok(!allowedActions(atQuestion(2, true, { followUpBudget: 0 })).includes('ask_follow_up'))
  const emotional = atQuestion(2, true, { currentCategory: 'emotional' })
  assert.equal(followUpCapFor(emotional), 2, 'behavioral scenarios still cap lower')
  const spent = atQuestion(2, true, { currentCategory: 'emotional', followUpCount: 2 })
  assert.ok(!allowedActions(spent).includes('ask_follow_up'))
  assert.ok(runInterview(true).followUps <= 8, 'never exceeds the interview-wide budget')
})

// -------------------------------- 9-11. primary count and numbering

test('follow-ups do not consume primary questions', () => {
  const s = atQuestion(4, true)
  const probed = applyTurn(s, turn('ask_follow_up'))
  assert.equal(probed.primaryQuestionNumber, 4, 'still on 4')
  assert.equal(applyTurn(probed, turn('next_primary')).primaryQuestionNumber, 5)
  assert.equal(applyTurn(s, turn('next_primary')).primaryQuestionNumber, 5, 'same as skipping')
})

test('a No interview emits exactly the configured primary count', () => {
  const r = runInterview(false)
  assert.equal(r.primaries, MAX_PRIMARY_QUESTIONS)
  assert.equal(r.followUps, 0)
  assert.deepEqual(r.numbers, Array.from({ length: 10 }, (_, i) => i + 1))
  assert.equal(r.state.complete, true)
})

test('a Yes interview emits exactly the configured primary count', () => {
  const r = runInterview(true)
  assert.equal(r.primaries, MAX_PRIMARY_QUESTIONS)
  assert.ok(r.followUps > 0)
  assert.deepEqual(r.numbers, Array.from({ length: 10 }, (_, i) => i + 1))
  assert.equal(r.state.complete, true)
})

test('numbering is identical whichever answer was given at setup', () => {
  assert.deepEqual(runInterview(true).numbers, runInterview(false).numbers)
})

// --------------------------------------- 12-14. the session owns the value

test('a restored Yes session stays Yes', () => {
  const live = applyTurn(atQuestion(3, true), turn('ask_follow_up'))
  const restored = normalizeState(JSON.parse(JSON.stringify(live)), newSession(false))
  assert.equal(restored.followUpsEnabled, true, 'not re-defaulted from the fallback')
  assert.ok(allowedActions(restored).includes('ask_follow_up') || restored.followUpCount >= followUpCapFor(restored))
})

test('a restored No session stays No', () => {
  const live = atQuestion(3, false)
  const restored = normalizeState(JSON.parse(JSON.stringify(live)), newSession(true))
  assert.equal(restored.followUpsEnabled, false, 'the fallback\'s Yes does not leak in')
  assert.ok(!allowedActions(restored).includes('ask_follow_up'))
})

test('the value cannot be switched mid-session by the request body', () => {
  // The route reads body.followUpsEnabled ONLY into the fallback, which
  // normalizeState discards whenever a real state is present.
  assert.match(route, /state = normalizeState\(body\?\.state, fallbackState\)/)
  const live = atQuestion(2, false)
  const continued = normalizeState(JSON.parse(JSON.stringify(live)), newSession(true))
  assert.equal(continued.followUpsEnabled, false)
})

// ------------------------------------------ 15-17. the old UI is gone

test('no per-answer "Ask Me a Follow-Up" button remains', () => {
  assert.doesNotMatch(PAGE, /Ask Me a Follow-Up/)
  assert.doesNotMatch(page, /canAskFollowUp/)
  assert.doesNotMatch(page, /sendMessage\('follow_up'\)/)
})

test('no per-answer "Next Question" decision button remains', () => {
  assert.doesNotMatch(PAGE, /Next Question/)
  assert.doesNotMatch(page, /sendMessage\('next'\)/)
  assert.match(page, /onClick=\{\(\) => sendMessage\(\)\}/, 'a plain Send again')
  assert.match(PAGE, /<span className="hidden sm:inline">Send<\/span>/)
})

test('the TurnIntent mechanism is gone from every layer', () => {
  for (const [name, src] of [['page', page], ['route', route], ['prompt', prompt]] as const) {
    assert.doesNotMatch(src, /TurnIntent/, `${name} still references TurnIntent`)
    assert.doesNotMatch(src, /\bintent\b/, `${name} still references an intent`)
  }
  const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(types, /TurnIntent/)
  const state = readFileSync(new URL('./state.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(state, /TurnIntent|canRequestFollowUp|MAX_OPTIONAL_FOLLOW_UPS/, 'no dead state helpers')
  const schema = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(schema, /TurnIntent/)
})

test('duplicate-click protection on answer submission remains intact', () => {
  assert.match(page, /const turnInFlight = useRef\(false\)/)
  const fn = page.slice(page.indexOf('const sendMessage = async'), page.indexOf('const resetInterview'))
  assert.match(fn, /if \(turnInFlight\.current\) return/)
  assert.match(fn, /finally \{[\s\S]*turnInFlight\.current = false/)
  const guard = fn.indexOf('turnInFlight.current = true')
  assert.ok(guard > -1 && guard < fn.indexOf('await '), 'acquired before the first await')
})

// ------------------------------------------------- 18. final question

test('the final question completes the interview under both settings', () => {
  for (const enabled of [true, false]) {
    const last = atQuestion(MAX_PRIMARY_QUESTIONS, enabled)
    assert.ok(allowedActions(last).includes('final_report'), `enabled=${enabled}`)
    assert.equal(applyTurn(last, turn('final_report')).complete, true)
  }
})

test('a follow-up on the final question does not invent an eleventh', () => {
  const last = atQuestion(MAX_PRIMARY_QUESTIONS, true)
  assert.ok(allowedActions(last).includes('ask_follow_up'))
  const probed = applyTurn(last, turn('ask_follow_up'))
  assert.equal(probed.primaryQuestionNumber, MAX_PRIMARY_QUESTIONS)
  assert.equal(probed.complete, false)
  assert.ok(allowedActions(probed).includes('final_report'))
  assert.equal(applyTurn(probed, turn('final_report')).complete, true)
})

// --------------------------------------- 19. historical compatibility

test('a session predating the field reads as follow-ups enabled', () => {
  // Those interviews ran when follow-ups were automatic; resuming one must not
  // silently change how it behaves.
  const legacy: any = { ...atQuestion(3, true) }
  delete legacy.followUpsEnabled
  const restored = normalizeState(legacy, newSession(false))
  assert.equal(restored.followUpsEnabled, true)
})

test('a completed historical session still renders and cannot be reopened', () => {
  const legacy: any = { ...atQuestion(10, true), complete: true, turnKind: 'final_report' }
  delete legacy.followUpsEnabled
  const restored = normalizeState(legacy, newSession(false))
  assert.equal(restored.complete, true)
  assert.deepEqual(allowedActions(restored), ['final_report'], 'no further model calls')
  assert.deepEqual(restored.evaluations, [], 'evaluations are carried through untouched')
})

test('a malformed followUpsEnabled falls back to the legacy reading', () => {
  for (const bad of ['true', 1, 0, null, [], {}]) {
    const raw: any = { ...atQuestion(2, false), followUpsEnabled: bad }
    assert.equal(normalizeState(raw, newSession(false)).followUpsEnabled, true, String(bad))
  }
})

// ------------------------------------------------- prompt / doctrine

test('the doctrine returns on Yes turns and is absent on No turns', () => {
  assert.match(prompt, /if \(!opening && !followUpsOff\) parts\.push\(FOLLOW_UP_DOCTRINE\)/)
})

test('a No interview is never asked to reason about follow-ups', () => {
  assert.match(prompt, /const followUpsOff = !state\.followUpsEnabled/)
  assert.match(prompt, /if \(!ctx\.followUpsOff\) \{/, 'the ask_follow_up menu entry is conditional')
  assert.match(PROMPT, /This interview has no follow-up questions\./)
  assert.match(prompt, /followUpsOff \? 'Subsequent primary questions are how you climb/,
    'the difficulty ladder stops citing follow-ups when there are none')
})

test('the per-answer prompt block is gone', () => {
  assert.doesNotMatch(prompt, /has ASKED YOU to press them further/)
  assert.doesNotMatch(prompt, /followUpRequested/)
  assert.doesNotMatch(prompt, /Follow-ups are the applicant's to request/)
})

test('scoring, evaluations and the primary-question contract are untouched', () => {
  const evaluation: any = { primary_question_number: 1, overall_score: 8 }
  const probed = applyTurn(atQuestion(1, true), turn('ask_follow_up', { evaluation }))
  assert.equal(probed.evaluations.length, 0, 'a follow-up turn banks no evaluation')
  assert.equal(applyTurn(probed, turn('next_primary', { evaluation })).evaluations.length, 1)
  assert.equal(newSession(true).maxPrimaryQuestions, 10)
  assert.equal(newSession(false).maxPrimaryQuestions, 10)
  for (const type of ['emotional', 'clinical', 'mixed', 'custom'] as const) {
    assert.equal(createInitialState({ mode: 'real', type, followUpsEnabled: false }).type, type)
  }
})

// ===========================================================================
// Server authority: the grant row, not the browser-echoed state.
//
// followUpsEnabled rides inside InterviewState, which the client holds between
// turns and can edit. So the state is convenience, and interview_grants is the
// authority: the route overwrites the state from the grant before anything
// reads it. A tampered client is corrected in BOTH directions.
// ===========================================================================

const SESSION = readFileSync(new URL('../interviewSession.ts', import.meta.url), 'utf8')
const MIGRATION = readFileSync(
  new URL('../../supabase/migrations/20260909_001_interview_grants_follow_ups.sql', import.meta.url),
  'utf8'
)
const session = strip(SESSION)
/** SQL comments are `--`, so the JS stripper does not apply. */
const sql = MIGRATION.replace(/^\s*--.*$/gm, ' ')

/** The route's lock, modelled exactly: grant wins whenever it can answer. */
function applyGrantAuthority(
  state: InterviewState,
  grant: { follow_ups_enabled?: boolean | null } | null
): InterviewState {
  if (typeof grant?.follow_ups_enabled === 'boolean') {
    return { ...state, followUpsEnabled: grant.follow_ups_enabled }
  }
  return state
}

// -------------------------------------------- 1-3. new-session validation

test('a new start without followUpsEnabled is rejected, not read as false', () => {
  assert.match(route, /const followUpsChosen = followUpsChoice === true \|\| followUpsChoice === false/)
  assert.match(route, /if \(startingInterview && !followUpsChosen\)/)
  assert.match(route, /status: 400/)
})

test('the rejection happens before the allowance check and before any model call', () => {
  // Sliced past the imports, or every name below matches its import line first.
  const body = route.slice(route.indexOf('export async function POST'))
  const guard = body.indexOf('if (startingInterview && !followUpsChosen)')
  assert.ok(guard > -1, 'the guard exists')
  assert.ok(guard < body.indexOf('await readInterviewCount('), 'before the allowance read')
  assert.ok(guard < body.indexOf('buildSystemPrompt(state'), 'before the prompt is built')
  assert.ok(guard < body.indexOf('await runTurn('), 'before the model is called')
})

test('missing, null, string and malformed values all fail the strict check', () => {
  // The exact predicate the route uses.
  const chosen = (v: unknown) => v === true || v === false
  for (const bad of [undefined, null, 'true', 'false', '', 0, 1, {}, [], NaN]) {
    assert.equal(chosen(bad), false, `${JSON.stringify(bad)} must not count as a choice`)
  }
  for (const good of [true, false]) assert.equal(chosen(good), true)
})

test('the client sends the choice unchanged, including null', () => {
  const req = page.slice(page.indexOf('const requestTurn'), page.indexOf('const startInterview'))
  assert.match(req, /followUpsEnabled: followUpsChoice,/, 'no `=== true` coercion')
  assert.doesNotMatch(req, /followUpsEnabled: followUpsChoice === true/)
})

// ------------------------------------------------ 4-5. the grant stores it

test('createGrant writes the chosen value onto the grant row', () => {
  assert.match(session, /follow_ups_enabled: followUpsEnabled/)
  assert.match(session, /followUpsEnabled: boolean\n\): Promise<string \| null>/, 'required, not optional')
  assert.match(route, /createGrant\(\s*admin,\s*auth\.userId,\s*nextState\.mode,\s*nextState\.type,\s*nextState\.followUpsEnabled\s*\)/)
})

test('checkGrant reads the column back on every continuation', () => {
  assert.match(session, /select\('id, user_id, turns_used, completed, follow_ups_enabled'\)/)
  assert.match(route, /typeof check\.grant\?\.follow_ups_enabled === 'boolean'/)
  assert.match(route, /state = \{ \.\.\.state, followUpsEnabled: check\.grant\.follow_ups_enabled \}/)
})

test('the overwrite happens before the state governs anything', () => {
  const body = route.slice(route.indexOf('export async function POST'))
  const lock = body.indexOf('followUpsEnabled: check.grant.follow_ups_enabled')
  assert.ok(lock > -1, 'the lock exists')
  assert.ok(lock < body.indexOf('buildSystemPrompt(state'), 'before the prompt')
  assert.ok(lock < body.indexOf('buildTurnSchema(state'), 'before the response schema')
  assert.ok(lock < body.indexOf('await runTurn('), 'before the model is called')
})

// -------------------------------------------------- 6. no database default

test('the migration leaves the column NOT NULL with no default', () => {
  assert.match(sql, /add column if not exists follow_ups_enabled boolean;/)
  assert.doesNotMatch(sql, /follow_ups_enabled boolean\s+(not null\s+)?default/i, 'no DEFAULT on add')
  assert.doesNotMatch(sql, /set default/i, 'nothing sets a default')
  assert.match(sql, /alter column follow_ups_enabled set not null;/)
  assert.match(sql, /alter column follow_ups_enabled drop default;/)
})

test('the migration backfills existing grants to true', () => {
  assert.match(sql, /update public\.interview_grants\s+set follow_ups_enabled = true\s+where follow_ups_enabled is null;/)
  // Nullable first, so the backfill has somewhere to write.
  assert.ok(
    sql.indexOf('add column if not exists follow_ups_enabled') < sql.indexOf('set follow_ups_enabled = true'),
    'column added before backfill'
  )
  assert.ok(
    sql.indexOf('set follow_ups_enabled = true') < sql.indexOf('set not null'),
    'backfilled before NOT NULL'
  )
})

test('the migration touches nothing else', () => {
  assert.doesNotMatch(sql, /drop table|drop column|delete from|truncate/i)
  assert.doesNotMatch(sql, /create policy|alter table \w+ enable row level/i)
  assert.doesNotMatch(sql, /create or replace function/i)
  // One table only.
  const tables = new Set([...sql.matchAll(/public\.(\w+)/g)].map((m) => m[1]))
  assert.deepEqual([...tables], ['interview_grants'])
})

// ------------------------------------------------------- 7-9. tampering

test('a false grant beats a client claiming true', () => {
  const tampered = { ...atQuestion(3, false), followUpsEnabled: true }
  const locked = applyGrantAuthority(tampered, { follow_ups_enabled: false })
  assert.equal(locked.followUpsEnabled, false)
  assert.ok(!allowedActions(locked).includes('ask_follow_up'), 'still impossible')
  assert.equal(followUpCapFor(locked), 0)
})

test('a true grant beats a client claiming false', () => {
  const tampered = { ...atQuestion(3, true), followUpsEnabled: false }
  const locked = applyGrantAuthority(tampered, { follow_ups_enabled: true })
  assert.equal(locked.followUpsEnabled, true)
  assert.ok(allowedActions(locked).includes('ask_follow_up'), 'still available')
})

test('the choice cannot change mid-session, in either direction', () => {
  for (const granted of [true, false]) {
    let s = atQuestion(1, granted)
    for (let i = 0; i < 5; i++) {
      // The client lies on every single turn; the grant corrects every one.
      s = applyGrantAuthority({ ...s, followUpsEnabled: !granted }, { follow_ups_enabled: granted })
      assert.equal(s.followUpsEnabled, granted, `turn ${i}`)
      assert.equal(allowedActions(s).includes('ask_follow_up'), granted && s.followUpCount < followUpCapFor(s))
    }
  }
})

test('a grant that cannot answer leaves the serialized value in place', () => {
  // Table not migrated (no grant row) or column not yet added.
  const s = atQuestion(2, true)
  assert.equal(applyGrantAuthority(s, null).followUpsEnabled, true)
  assert.equal(applyGrantAuthority(s, {}).followUpsEnabled, true)
  assert.equal(applyGrantAuthority(s, { follow_ups_enabled: null }).followUpsEnabled, true)
})

// ----------------------------------------------- 10-11. legacy behaviour

test('a backfilled legacy grant reads true and re-enables a legacy state', () => {
  const legacy: any = { ...atQuestion(4, false) }
  delete legacy.followUpsEnabled
  const restored = normalizeState(legacy, newSession(false))
  assert.equal(restored.followUpsEnabled, true, 'normalizeState legacy reading')
  // ...and the backfilled grant agrees, so the two never disagree.
  assert.equal(applyGrantAuthority(restored, { follow_ups_enabled: true }).followUpsEnabled, true)
})

test('a completed historical session still renders and stays closed', () => {
  const legacy: any = { ...atQuestion(10, true), complete: true, turnKind: 'final_report' }
  delete legacy.followUpsEnabled
  const restored = normalizeState(legacy, newSession(false))
  assert.equal(restored.complete, true)
  assert.deepEqual(allowedActions(restored), ['final_report'])
  // The completed short-circuit runs before the grant check, so a completed
  // session never depends on the grant at all.
  assert.ok(route.indexOf('if (state.complete)') < route.indexOf('await checkGrant('))
})

// --------------------------------- deploy-order tolerance (both directions)

test('the grant layer works before and after the migration', () => {
  assert.match(session, /const MISSING_COLUMN = \['42703', 'PGRST204', 'PGRST116'\]/)
  assert.match(session, /if \(error && isMissingColumn\(error\)\) \{/)
  // INSERT retries without the column...
  assert.match(session, /const \{ follow_ups_enabled, \.\.\.legacy \} = row/)
  // ...and so does SELECT.
  assert.match(session, /select\('id, user_id, turns_used, completed'\)/)
})

test('createGrant remains the only insert path', () => {
  const inserts = [...session.matchAll(/from\('interview_grants'\)\s*\.insert\(/g)]
  assert.equal(inserts.length, 1, 'exactly one INSERT into interview_grants')
  assert.match(route, /createGrant\(/)
})
