import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  FOLLOW_UP_BUDGET,
  INTERVIEW_LENGTHS,
  MAX_FOLLOW_UPS,
  MAX_PRIMARY_QUESTIONS,
  QUICK_FOLLOW_UP_BUDGET,
  QUICK_MAX_FOLLOW_UPS,
  QUICK_PRIMARY_QUESTIONS,
  V2_FOLLOW_UP_BUDGET,
  V2_MAX_FOLLOW_UPS,
  allowedActions,
  applyTurn,
  createInitialState,
  followUpCapFor,
  followUpsSpent,
  followUpsUnlocked,
  normalizeState,
  withInterviewLength,
} from './state.ts'
import {
  applyGrantAuthority,
  applyLengthAuthority,
  lengthAuthority,
  parseRequestedLength,
} from './authority.ts'
import { evaluateResume } from './resume.ts'
import type { GrantRow } from './resume.ts'
import { buildSessionRow } from './sessionSaver.ts'
import { buildSystemPrompt } from './prompt.ts'
import { buildTurnSchema } from './schema.ts'
import { readTurnResponse } from './turnProtocol.ts'
import {
  MAX_TURNS_PER_INTERVIEW,
  abandonGrant,
  checkGrant,
  createGrant,
  findGrantBySession,
  issueInterview,
} from '../interviewSession.ts'
import type { ChatMessage, InterviewMode, InterviewState, InterviewType, ModelTurn, QuestionCategory, TurnAction } from './types.ts'

/**
 * Phase 3: Quick Mock (5 primary questions) and Full Mock (10).
 *
 * Full is the Phase 2 interview, unchanged -- its prompt, schema and state
 * machine were compared byte for byte against the Phase 2 baseline across
 * thousands of states. Quick is the SAME engine at half the length: the same
 * V2 formulas, fed a budget of two and a per-scenario ceiling of one, which is
 * what produces its 1/1/2/2/2 unlock and leaves it no deep dive.
 *
 * The length is the server's decision. The start request may only ask for
 * Quick or Full; the grant records the answer; and every later turn and every
 * resume applies the grant's value over whatever the browser's state claims.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const ROUTE = strip(read('../../app/api/interview/route.ts'))
const PAGE = read('../../app/interview/page.tsx')
const FEEDBACK = read('../../components/InterviewFeedback.tsx')
const SESSION = read('../interviewSession.ts')

const turn = (action: TurnAction, over: Partial<ModelTurn> = {}): ModelTurn => ({
  action,
  display_text: 'text',
  question_asked: 'q',
  scenario_label: 'label',
  category: 'clinical',
  question_format: 'scenario',
  concepts_tested: [],
  difficulty_level: 3,
  follow_up_purpose: null,
  evaluation: null,
  final_report: null,
  internal_note: '',
  ...over,
})
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v))

type Length = 'quick' | 'full'
const LENGTH = { quick: QUICK_PRIMARY_QUESTIONS, full: MAX_PRIMARY_QUESTIONS } as const

function start(length: Length, over: { mode?: InterviewMode; type?: InterviewType; followUpsEnabled?: boolean } = {}) {
  return createInitialState({
    mode: over.mode ?? 'real',
    type: over.type ?? 'clinical',
    followUpsEnabled: over.followUpsEnabled ?? true,
    length: LENGTH[length],
  })
}

/** One turn through the route's own order, refusing anything allowedActions does not offer. */
function step(s: InterviewState, action: TurnAction, over: Partial<ModelTurn> = {}): InterviewState {
  assert.ok(allowedActions(s).includes(action), `${action} is not on offer at Q${s.primaryQuestionNumber}: ${allowedActions(s)}`)
  return wire(applyTurn(s, turn(action, over)))
}

/** Asks every primary question the interview allows, then closes it. */
function runToEnd(s: InterviewState, category: QuestionCategory = 'clinical') {
  let primaries = 0
  while (!s.complete) {
    const actions = allowedActions(s)
    if (actions.includes('next_primary')) {
      s = step(s, 'next_primary', { category })
      primaries++
    } else {
      assert.deepEqual(actions.includes('final_report'), true, 'the only way out is the report')
      s = step(s, 'final_report', { final_report: { overall_score: 7 } as any })
    }
  }
  return { state: s, primaries }
}

// ==========================================================================
// 1. Length and completion
// ==========================================================================

test('the only lengths are 5 and 10', () => {
  assert.deepEqual([...INTERVIEW_LENGTHS], [5, 10])
  assert.equal(QUICK_PRIMARY_QUESTIONS, 5)
  assert.equal(MAX_PRIMARY_QUESTIONS, 10, 'Full is still ten')
})

test('Quick asks exactly 5 primary questions and Full exactly 10', () => {
  for (const [length, expected] of [['quick', 5], ['full', 10]] as const) {
    for (const mode of ['practice', 'real'] as const) {
      const { state, primaries } = runToEnd(start(length, { mode }))
      assert.equal(primaries, expected, `${length}/${mode}`)
      assert.equal(state.primaryQuestionNumber, expected)
      assert.equal(state.complete, true)
    }
  }
})

test('Quick never offers a sixth primary question, and Full finishes after its tenth', () => {
  let q = start('quick')
  for (let i = 0; i < QUICK_PRIMARY_QUESTIONS; i++) q = step(q, 'next_primary')
  assert.equal(q.primaryQuestionNumber, 5)
  assert.equal(allowedActions(q).includes('next_primary'), false, 'no Q6')
  assert.ok(allowedActions(q).includes('final_report'))
  // A model that answered next_primary anyway still cannot move past the end.
  assert.equal(applyTurn(q, turn('next_primary')).primaryQuestionNumber, 5)

  let f = start('full')
  for (let i = 0; i < 9; i++) f = step(f, 'next_primary')
  assert.ok(allowedActions(f).includes('next_primary'), 'Full still has its tenth')
  f = step(f, 'next_primary')
  assert.equal(allowedActions(f).includes('next_primary'), false, 'no Q11')
})

test('Quick completes through the same report flow as Full', () => {
  for (const length of ['quick', 'full'] as const) {
    let s = start(length, { mode: 'practice' })
    while (s.primaryQuestionNumber < LENGTH[length]) s = step(s, 'next_primary')
    const schema = buildTurnSchema(s) as any
    const actions = schema.schema.properties.action.enum
    assert.ok(actions.includes('final_report'), `${length}: the schema offers the report`)
    assert.ok(!actions.includes('next_primary'), `${length}: and nothing beyond it`)
    s = step(s, 'final_report', { final_report: { overall_score: 7 } as any })
    assert.equal(s.complete, true)
    assert.equal(s.turnKind, 'final_report')
  }
})

test('follow-ups never advance primary-question progress', () => {
  let s = step(start('quick'), 'next_primary')
  const before = s.primaryQuestionNumber
  s = step(s, 'ask_follow_up', { follow_up_purpose: 'clarify' })
  assert.equal(s.primaryQuestionNumber, before)
  assert.equal(s.turnKind, 'follow_up')
})

// ==========================================================================
// 2. Follow-up policy per length
// ==========================================================================

test('Quick: budget 2, clinical cap 1, behavioral cap 1', () => {
  const s = start('quick')
  assert.equal(s.maxFollowUpBudget, QUICK_FOLLOW_UP_BUDGET)
  assert.equal(s.followUpBudget, 2)
  assert.equal(s.maxFollowUps, QUICK_MAX_FOLLOW_UPS)
  assert.equal(followUpCapFor({ ...s, currentCategory: 'clinical' }), 1)
  assert.equal(followUpCapFor({ ...s, currentCategory: 'behavioral' }), 1)
  assert.equal(followUpCapFor({ ...s, currentCategory: 'emotional' }), 1)
  assert.equal(s.followUpPolicyVersion, 2, 'Quick is V2: the same policy, at a smaller scale')
})

test('Full keeps the Phase 2 policy: budget 5, clinical cap 2, behavioral cap 1', () => {
  const s = start('full')
  assert.equal(s.maxFollowUpBudget, V2_FOLLOW_UP_BUDGET)
  assert.equal(s.maxFollowUps, V2_MAX_FOLLOW_UPS)
  assert.equal(followUpCapFor({ ...s, currentCategory: 'clinical' }), 2)
  assert.equal(followUpCapFor({ ...s, currentCategory: 'behavioral' }), 1)
  // Omitting the length is Full, exactly as every caller built it before.
  assert.deepEqual(createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true }), s)
})

test('Quick unlocks its budget 1, 1, 2, 2, 2; Full still unlocks 1,1,2,2,3,3,4,4,5,5', () => {
  const unlocks = (length: Length) => {
    let s = start(length)
    const out: number[] = []
    for (let q = 1; q <= LENGTH[length]; q++) {
      s = step(s, 'next_primary')
      out.push(followUpsUnlocked(s))
    }
    return out
  }
  assert.deepEqual(unlocks('quick'), [1, 1, 2, 2, 2])
  assert.deepEqual(unlocks('full'), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5])
})

test('Quick has no deep dive: a clarifying first probe still earns no second one', () => {
  let s = step(step(step(start('quick'), 'next_primary'), 'next_primary'), 'next_primary') // Q3: 2 unlocked
  s = step(s, 'ask_follow_up', { follow_up_purpose: 'clarify' })
  assert.ok(followUpsSpent(s) < followUpsUnlocked(s), 'budget would allow another')
  assert.equal(s.deepDiveUsed, false)
  assert.equal(allowedActions(s).includes('ask_follow_up'), false, 'the ceiling of one refuses it')
})

test('Full retains exactly one deep dive', () => {
  let s = step(step(step(start('full'), 'next_primary'), 'next_primary'), 'next_primary') // Q3
  s = step(s, 'ask_follow_up', { follow_up_purpose: 'clarify' })
  assert.ok(allowedActions(s).includes('ask_follow_up'), 'the deep dive is on offer')
  s = step(s, 'ask_follow_up', { follow_up_purpose: 'rationale' })
  assert.equal(s.deepDiveUsed, true)
  // Later, with budget unlocked, a second probe on another scenario is refused.
  for (let q = 4; q <= 7; q++) s = step(s, 'next_primary')
  s = step(s, 'ask_follow_up', { follow_up_purpose: 'clarify' })
  assert.ok(followUpsSpent(s) < followUpsUnlocked(s))
  assert.equal(allowedActions(s).includes('ask_follow_up'), false)
})

test('a Quick interview can never spend more than 2 follow-ups, whatever the model tries', () => {
  let s = start('quick', { type: 'mixed' })
  let followUps = 0
  for (let q = 1; q <= QUICK_PRIMARY_QUESTIONS; q++) {
    s = step(s, 'next_primary', { category: q % 2 ? 'clinical' : 'behavioral' })
    while (allowedActions(s).includes('ask_follow_up')) {
      s = step(s, 'ask_follow_up', { follow_up_purpose: 'clarify' })
      followUps++
    }
  }
  assert.equal(followUps, 2)
  assert.equal(s.followUpBudget, 0)
})

test('a Mixed Quick interview shares one budget of 2 across both categories', () => {
  let s = step(start('quick', { type: 'mixed' }), 'next_primary', { category: 'clinical' })
  s = step(s, 'ask_follow_up', { follow_up_purpose: 'clarify' })
  s = step(s, 'next_primary', { category: 'behavioral' })
  s = step(s, 'next_primary', { category: 'emotional' })
  s = step(s, 'ask_follow_up', { follow_up_purpose: 'reflection' })
  assert.equal(s.followUpBudget, 0, 'one clinical and one behavioral follow-up spent the shared two')
  assert.deepEqual(s.followUpPurposes, ['clarify', 'reflection'])
})

// ==========================================================================
// 3. Server authority over length
// ==========================================================================

test('the start request may only ask for Quick or Full', () => {
  assert.deepEqual(parseRequestedLength('quick'), { ok: true, length: 5 })
  assert.deepEqual(parseRequestedLength('full'), { ok: true, length: 10 })
  assert.deepEqual(parseRequestedLength(undefined), { ok: true, length: 10 }, 'a pre-Phase-3 page sends nothing')
  assert.deepEqual(parseRequestedLength(null), { ok: true, length: 10 })
  for (const bad of [5, 10, '5', 'QUICK', 'long', 25, 1, 0, true, {}, []]) {
    assert.deepEqual(parseRequestedLength(bad), { ok: false }, JSON.stringify(bad))
  }
})

test('normalizeState no longer admits a 1- or 25-question interview', () => {
  const fallback = start('full')
  for (const claim of [1, 2, 7, 11, 15, 25, 99, -3, '5', null]) {
    const s = normalizeState({ ...start('full'), maxPrimaryQuestions: claim }, fallback)
    assert.equal(s.maxPrimaryQuestions, 10, `claim ${JSON.stringify(claim)} reads as Full`)
  }
  assert.equal(normalizeState(start('quick'), fallback).maxPrimaryQuestions, 5, 'a real Quick state survives')
})

test('normalizeState pins Quick policy rather than clamping it', () => {
  const inflated = { ...start('quick'), maxFollowUps: 5, maxFollowUpBudget: 60, followUpBudget: 60 }
  const s = normalizeState(inflated, start('full'))
  assert.equal(s.maxFollowUps, 1)
  assert.equal(s.maxFollowUpBudget, 2)
  assert.equal(s.followUpBudget, 2)
})

test('V1 predates Quick: a V1 state claiming 5 questions is ten', () => {
  const v1: any = { ...start('quick'), maxFollowUps: MAX_FOLLOW_UPS, maxFollowUpBudget: FOLLOW_UP_BUDGET, followUpBudget: FOLLOW_UP_BUDGET }
  delete v1.followUpPolicyVersion
  const s = normalizeState(v1, start('full'))
  assert.equal(s.followUpPolicyVersion, 1)
  assert.equal(s.maxPrimaryQuestions, 10)
  assert.equal(s.maxFollowUpBudget, FOLLOW_UP_BUDGET, 'V1 numbers untouched')
})

test('the grant answers in four ways, and only one of them is refused', () => {
  assert.deepEqual(lengthAuthority({ max_primary_questions: 5 }), { source: 'grant', length: 5 })
  assert.deepEqual(lengthAuthority({ max_primary_questions: 10 }), { source: 'grant', length: 10 })
  assert.deepEqual(lengthAuthority({ max_primary_questions: null }), { source: 'historical' })
  assert.deepEqual(lengthAuthority({}), { source: 'unavailable' }, 'no column yet')
  assert.deepEqual(lengthAuthority(null), { source: 'unavailable' }, 'no grant row')
  for (const bad of [0, 1, 7, 15, 25]) assert.deepEqual(lengthAuthority({ max_primary_questions: bad }), { source: 'invalid' })
})

test('the grant wins over every length the client state claims', () => {
  const quickGrant = { max_primary_questions: 5, follow_ups_enabled: true }
  const fullGrant = { max_primary_questions: 10, follow_ups_enabled: true }
  for (const claim of [1, 5, 10, 25]) {
    const tampered = { ...start('full'), maxPrimaryQuestions: claim }
    assert.equal(applyGrantAuthority(tampered, quickGrant).maxPrimaryQuestions, 5, `Quick grant vs claim ${claim}`)
    assert.equal(applyGrantAuthority({ ...start('quick'), maxPrimaryQuestions: claim }, fullGrant).maxPrimaryQuestions, 10)
  }
})

test('starting Quick and editing the state into Full buys nothing', () => {
  // A Quick interview at its last question, whose browser now claims Full's
  // length and budget and a V1-sized ceiling.
  let s = start('quick')
  for (let q = 1; q <= 5; q++) s = step(s, 'next_primary')
  const tampered = { ...s, maxPrimaryQuestions: 10, maxFollowUps: 5, maxFollowUpBudget: 60, followUpBudget: 60 }
  // The route's order: normalizeState, then the grant.
  const governed = applyLengthAuthority(normalizeState(tampered, start('full')), lengthAuthority({ max_primary_questions: 5 }))
  assert.equal(governed.maxPrimaryQuestions, 5)
  assert.equal(governed.maxFollowUpBudget, 2)
  assert.ok(governed.followUpBudget <= 2)
  assert.equal(followUpCapFor(governed), 1)
  assert.equal(allowedActions(governed).includes('next_primary'), false, 'still no sixth question')
  // And the per-grant turn ceiling is the same database limit for both lengths.
  assert.equal(MAX_TURNS_PER_INTERVIEW, 24)
})

test('dropping the version field cannot buy V1 rules on a Phase 3 grant', () => {
  const demoted: any = { ...start('quick'), maxFollowUpBudget: 8, followUpBudget: 8, maxFollowUps: 3 }
  delete demoted.followUpPolicyVersion
  const governed = applyGrantAuthority(normalizeState(demoted, start('full')), { max_primary_questions: 5 })
  assert.equal(governed.followUpPolicyVersion, 2)
  assert.equal(governed.maxPrimaryQuestions, 5)
  assert.equal(governed.maxFollowUpBudget, 2)
})

test('historical grants mean Full and leave V1 interviews under V1 rules', () => {
  const v1: any = { ...start('full'), maxFollowUps: MAX_FOLLOW_UPS, maxFollowUpBudget: FOLLOW_UP_BUDGET, followUpBudget: 6 }
  delete v1.followUpPolicyVersion
  delete v1.followUpPurposes
  delete v1.deepDiveUsed
  const normalized = normalizeState(v1, start('full'))
  const governed = applyGrantAuthority(normalized, { max_primary_questions: null, follow_ups_enabled: true })
  assert.deepEqual(governed, normalized, 'nothing about a historical V1 interview changes')
  assert.equal(governed.followUpPolicyVersion, 1)
  assert.equal(governed.maxFollowUpBudget, FOLLOW_UP_BUDGET)
  // withInterviewLength itself never shortens a V1 interview either.
  assert.equal(withInterviewLength(normalized, 5).maxPrimaryQuestions, 10)
})

test('the route builds a start from validated choices and discards any client state', () => {
  const post = ROUTE.slice(ROUTE.indexOf('export async function POST'))
  assert.match(post, /const lengthChoice = parseRequestedLength\(body\?\.interviewLength\)/)
  assert.match(post, /if \(startingInterview && !lengthChoice\.ok\) \{[\s\S]*?status: 400/)
  assert.match(post, /if \(startingInterview\) \{\s*state = fallbackState/)
  assert.match(post, /length: startLength/)
  // The refusal comes before any model call or charge.
  const refusal = post.indexOf('!lengthChoice.ok')
  assert.ok(refusal < post.indexOf('await runTurn('))
  assert.ok(refusal < post.indexOf('chargeInterview('))
})

test('the route applies the grant length before the prompt, the schema and the model', () => {
  const post = ROUTE.slice(ROUTE.indexOf('export async function POST'))
  const invalid = post.indexOf("lengthAuthority(check.grant).source === 'invalid'")
  const apply = post.indexOf('state = applyLengthAuthority(state, lengthAuthority(check.grant))')
  assert.ok(invalid > -1 && apply > -1)
  assert.ok(invalid < post.indexOf('reserveTurn('), 'an invalid length is refused before a turn is reserved')
  for (const later of ['buildSystemPrompt(state', 'buildTurnSchema(state', 'await runTurn(']) {
    assert.ok(apply < post.indexOf(later), `before ${later}`)
  }
})

test('the grant records the server-validated length, and every read path asks for it', () => {
  assert.match(ROUTE, /createGrant\([\s\S]*?nextState\.followUpsEnabled,[\s\S]*?startLength\s*\)/)
  const create = SESSION.slice(SESSION.indexOf('export async function createGrant'), SESSION.indexOf('export type IssueSteps'))
  assert.match(create, /\.insert\(\{[\s\S]*?max_primary_questions: maxPrimaryQuestions,[\s\S]*?\}\)/, 'in the one insert')
  assert.equal(create.match(/\.insert\(/g)?.length, 1, 'and there is no second, length-less insert')
  assert.match(SESSION, /completed, follow_ups_enabled, abandoned_at, session_id, created_at, max_primary_questions'/)
  assert.match(SESSION, /session_id, abandoned_at, created_at, max_primary_questions'/)
})

test('every grant READ survives a database without the column', () => {
  // A grant that cannot answer on length reads as Full (see the tests under
  // "a new interview's length is on its grant, or it does not start") rather
  // than breaking the turn or making every resume look like "not found".
  const check = SESSION.slice(SESSION.indexOf('export async function checkGrant'))
  assert.match(check, /if \(error && isMissingColumn\(error\)\) \{[\s\S]*?session_id, created_at'\s*\)\)/)
  const lookup = SESSION.slice(SESSION.indexOf('export async function findGrantBySession'))
  assert.match(lookup, /if \(error && isMissingColumn\(error\)\) \{\s*;\(\{ data, error \} = await lookup\(/)
})

// ==========================================================================
// 4. Resume keeps the length
// ==========================================================================

const USER = 'user-1'
const NOW = Date.parse('2026-09-21T12:00:00Z')
const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
  id: 'grant-1',
  user_id: USER,
  session_id: 'session-1',
  turns_used: 4,
  completed: false,
  abandoned_at: null,
  created_at: new Date(NOW - 60_000).toISOString(),
  follow_ups_enabled: true,
  ...over,
})
const transcript = (questions: number): ChatMessage[] =>
  Array.from({ length: questions * 2 - 1 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: i % 2 ? 'an answer' : `question ${i / 2 + 1}` }))

function refresh(state: InterviewState, messages: ChatMessage[], g: GrantRow, pendingTurn: any = null) {
  const row = wire(
    buildSessionRow({ userId: USER, interviewType: state.type, customTopic: '', mode: state.mode }, { conversation: messages, state, pendingTurn }, true)
  )
  const verdict = evaluateResume(
    { id: 'session-1', user_id: USER, conversation: row.conversation, engine_state: row.engine_state, pending_turn: row.pending_turn },
    g,
    USER,
    NOW
  )
  assert.equal(verdict.resumable, true, !verdict.resumable ? verdict.reason : '')
  if (!verdict.resumable) throw new Error('unreachable')
  return wire(verdict)
}

test('Quick save → refresh → Resume comes back Quick, field for field', () => {
  let s = step(step(start('quick'), 'next_primary'), 'ask_follow_up', { follow_up_purpose: 'clarify' })
  s = step(s, 'next_primary')
  const v = refresh(s, transcript(3), grant({ max_primary_questions: 5 }))
  assert.deepEqual(v.state, s)
  assert.equal(v.state.maxPrimaryQuestions, 5)
  assert.equal(v.state.maxFollowUpBudget, 2)
})

test('Full save → refresh → Resume comes back Full, field for field', () => {
  let s = start('full')
  for (let q = 1; q <= 6; q++) s = step(s, 'next_primary')
  const v = refresh(s, transcript(6), grant({ max_primary_questions: 10 }))
  assert.deepEqual(v.state, s)
  assert.equal(v.state.maxPrimaryQuestions, 10)
})

test('a refresh cannot turn Quick into Full or Full into Quick', () => {
  let quick = start('quick')
  for (let q = 1; q <= 3; q++) quick = step(quick, 'next_primary')
  const claimsFull = { ...quick, maxPrimaryQuestions: 10, maxFollowUpBudget: 5, followUpBudget: 5, maxFollowUps: 2 }
  const q = refresh(claimsFull as InterviewState, transcript(3), grant({ max_primary_questions: 5 }))
  assert.equal(q.state.maxPrimaryQuestions, 5, 'the Quick grant wins')
  assert.equal(q.state.maxFollowUpBudget, 2)

  let full = start('full')
  for (let i = 1; i <= 3; i++) full = step(full, 'next_primary')
  const claimsQuick = { ...full, maxPrimaryQuestions: 5 }
  const f = refresh(claimsQuick as InterviewState, transcript(3), grant({ max_primary_questions: 10 }))
  assert.equal(f.state.maxPrimaryQuestions, 10, 'the Full grant wins')
  assert.equal(f.state.maxFollowUpBudget, 5)
})

test('a Quick Practice checkpoint keeps its length through refresh and Continue', () => {
  let s = step(start('quick', { mode: 'practice' }), 'next_primary')
  const next = wire(applyTurn(s, turn('next_primary', { evaluation: { primary_question_number: 1, overall_score: 7 } as any })))
  const shown: ChatMessage[] = [{ role: 'assistant', content: 'question 1' }, { role: 'user', content: 'an answer' }, { role: 'assistant', content: '' }]
  const pending = { message: { role: 'assistant', content: 'question 2' }, state: next, questionAsked: 'question 2', isFinal: false }
  const v = refresh(s, shown, grant({ max_primary_questions: 5 }), pending)
  assert.equal(v.state.maxPrimaryQuestions, 5)
  assert.equal(v.pendingTurn?.state.maxPrimaryQuestions, 5, 'the held-back question is still a Quick question')
  assert.deepEqual(v.pendingTurn?.state, next)
  // Continue adopts the stored state as it is -- no request, no new length.
  s = v.pendingTurn!.state
  assert.equal(s.maxPrimaryQuestions, 5)
  assert.equal(followUpsUnlocked(s), 1)
})

test('a grant holding an impossible length makes the interview non-resumable', () => {
  const s = step(start('quick'), 'next_primary')
  const verdict = evaluateResume(
    { id: 'session-1', user_id: USER, conversation: transcript(1), engine_state: s, pending_turn: null },
    grant({ max_primary_questions: 7 }),
    USER,
    NOW
  )
  assert.deepEqual(verdict, { resumable: false, reason: 'invalid_state' })
})

// ==========================================================================
// 5. Prompt: Quick is told the truth about itself; Full is untouched
// ==========================================================================

const promptAt = (length: Length, over: Partial<InterviewState> = {}, type: InterviewType = 'clinical') => {
  let s = start(length, { type })
  s = step(s, 'next_primary')
  return buildSystemPrompt({ ...s, ...over }, { recentQuestions: [], seed: 'seed' })
}

test('the Quick prompt states its own length, its ceiling and that it has no deep dive', () => {
  const quick = promptAt('quick')
  assert.match(quick, /Primary questions asked: 1 of 5/)
  assert.match(quick, /This is a Quick Mock: there is no deep dive/)
  assert.doesNotMatch(quick, /deep dive for this interview is still available/)
  const mixed = promptAt('quick', {}, 'mixed')
  assert.match(mixed, /In this Quick Mock the follow-up ceiling is one per scenario/)
  assert.match(mixed, /balanced split across the 5 primary questions/)
})

test('the Full prompt carries none of the Quick wording', () => {
  const full = promptAt('full', {}, 'mixed')
  assert.match(full, /Primary questions asked: 1 of 10/)
  assert.match(full, /The one deep dive for this interview is still available/)
  assert.match(full, /at most two on a clinical scenario/)
  assert.doesNotMatch(full, /Quick Mock/)
})

test('the Quick report is scored exactly like Full, and says it rests on five questions', () => {
  let q = start('quick')
  for (let i = 0; i < 5; i++) q = step(q, 'next_primary')
  const quick = buildSystemPrompt(q, { recentQuestions: [], seed: 'seed' })
  assert.match(quick, /not a reason to score higher or lower/)
  assert.match(quick, /the assessment rests on five questions/)
  let f = start('full')
  for (let i = 0; i < 10; i++) f = step(f, 'next_primary')
  assert.doesNotMatch(buildSystemPrompt(f, { recentQuestions: [], seed: 'seed' }), /Quick Mock/)
})

// ==========================================================================
// 6. UI
// ==========================================================================

test('setup offers Quick and Full, preselects Full, and sends the choice only as a request', () => {
  assert.match(PAGE, /useState<LengthChoice>\('full'\)/)
  assert.match(PAGE, /\{ id: 'quick', name: 'Quick Mock', questions: QUICK_PRIMARY_QUESTIONS/)
  assert.match(PAGE, /\{ id: 'full', name: 'Full Mock', questions: MAX_PRIMARY_QUESTIONS/)
  assert.match(PAGE, /role="radiogroup" aria-label="Interview length"/)
  assert.match(PAGE, /interviewLength,\n\s*\/\/ Proves this turn belongs/)
})

test('progress shows the interview\'s own denominator, from the server\'s state', () => {
  assert.doesNotMatch(PAGE, /const MAX_PRIMARY_QUESTIONS = 10/, 'no hard-coded ten')
  // The whole derivation, so nothing can be slipped in front of it: the
  // server's state once running, the applicant's pick before that.
  assert.match(
    PAGE,
    /const maxQuestions =\s*engineState\?\.maxPrimaryQuestions \?\?\s*\(interviewLength === 'quick' \? QUICK_PRIMARY_QUESTIONS : MAX_PRIMARY_QUESTIONS\)/
  )
  assert.match(PAGE, /Question \{questionNumber\} of \{maxQuestions\}/)
  assert.match(PAGE, /you still get all \{maxQuestions\} main questions/)
  assert.match(PAGE, /\{quickMock \? 'Quick Mock' : 'Full Mock'\}/)
})

test('Resume restores the length the server applied, and the Resume card shows it', () => {
  assert.match(PAGE, /setInterviewLength\(body\.state\.maxPrimaryQuestions === QUICK_PRIMARY_QUESTIONS \? 'quick' : 'full'\)/)
  assert.match(PAGE, /resumable\.maxPrimaryQuestions === QUICK_PRIMARY_QUESTIONS \? ' · Quick Mock' : ' · Full Mock'/)
})

test('the report is labelled, and a Quick report carries the short-sample note without touching scores', () => {
  assert.match(PAGE, /if \(turnMessage\.finalReport\) turnMessage\.interviewLength = data\.state\.maxPrimaryQuestions/)
  assert.match(PAGE, /interviewLength: turnMessage\.interviewLength/, 'the held-back report keeps it too')
  assert.match(FEEDBACK, /length=\{message\.interviewLength\}/)
  assert.match(FEEDBACK, /Based on a \{QUICK_PRIMARY_QUESTIONS\}-question Quick Mock/)
  assert.match(FEEDBACK, /<Tile label="Overall" score=\{report\.overall_score\} hero \/>/, 'the score is shown as scored')
})

// ==========================================================================
// 7. One interview, one entitlement
// ==========================================================================

test('Quick and Full each cost exactly one entitlement, charged once at the start', () => {
  const post = ROUTE.slice(ROUTE.indexOf('export async function POST'))
  assert.equal(post.match(/chargeInterview\(/g)?.length, 1, 'one charge site')
  // Charged inside the start block, through issueInterview, for either length alike.
  const charge = post.match(/charge: auth\.isUltimate \? undefined : \(\) => chargeInterview\(admin, auth\.userId\)/)
  assert.ok(charge, 'metered accounts are charged exactly once per start')
  assert.doesNotMatch(charge![0], /quick|maxPrimary|startLength|length/i, 'nothing about the charge depends on the length')
  assert.ok(post.indexOf('if (startingInterview) {') < post.indexOf('chargeInterview('), 'only when starting')
})

test('Resume, bind and follow-ups never charge an entitlement', () => {
  for (const rel of ['../../app/api/interview/resume/route.ts', '../../app/api/interview/bind/route.ts']) {
    const src = strip(read(rel))
    assert.doesNotMatch(src, /chargeInterview|createGrant|interview_count/, rel)
  }
  // A follow-up is a continuation: it reserves a turn on the grant and is never a start.
  assert.match(ROUTE, /const startingInterview = isOpeningTurn\(state\) && messages\.length === 0/)
})

// (The migration itself is checked in interviewLengthMigration.test.ts, which
// depends on nothing but the SQL, so it can ship with the schema on its own.)

// ==========================================================================
// 9. A new interview's grant: its length is persisted, its entitlement is paid
//
// Two invariants, each for the failure that would break it:
//   * a NEW Phase 3 grant always carries 5 or 10 explicitly -- NULL is reserved
//     for grants issued before Phase 3, so a start that cannot persist its
//     length does not start, whether it is Quick or Full;
//   * a usable grant means a consumed entitlement -- a charge that fails leaves
//     no grant anyone can use, and a retry never inherits a free one.
// ==========================================================================

/** The service-role client, reduced to what createGrant uses, answering from a script. */
function fakeAdmin(answers: Array<{ data?: unknown; error?: unknown }>) {
  const inserts: Record<string, unknown>[] = []
  const admin = {
    from(table: string) {
      assert.equal(table, 'interview_grants')
      return {
        insert(payload: Record<string, unknown>) {
          inserts.push(payload)
          const answer = answers[inserts.length - 1] ?? { error: { code: 'XX000', message: 'unscripted insert' } }
          return {
            select: () => ({ single: async () => ({ data: answer.data ?? null, error: answer.error ?? null }) }),
          }
        },
      }
    },
  }
  return { admin: admin as any, inserts }
}

/**
 * interview_grants in memory, behind the same query shapes the real code uses:
 * insert(..).select().single(), update(..).eq(..).is(..).select(), and
 * select(..).eq(..).maybeSingle(). Enough to run createGrant, abandonGrant,
 * checkGrant and findGrantBySession against one shared table.
 */
function memoryGrants() {
  const rows: Record<string, any>[] = []
  let issued = 0
  const admin = {
    from(table: string) {
      assert.equal(table, 'interview_grants')
      const filters: Array<(r: Record<string, any>) => boolean> = []
      let patch: Record<string, unknown> | null = null
      let insertResult: unknown = null
      const matched = () => rows.filter((r) => filters.every((f) => f(r)))
      const q: any = {
        insert(payload: Record<string, unknown>) {
          const row = { id: `grant-${++issued}`, turns_used: 0, completed: false, abandoned_at: null, session_id: null, created_at: new Date(NOW).toISOString(), ...payload }
          rows.push(row)
          insertResult = { data: { id: row.id }, error: null }
          return q
        },
        update(p: Record<string, unknown>) { patch = p; return q },
        select() { return q },
        eq(col: string, value: unknown) { filters.push((r) => r[col] === value); return q },
        is(col: string, value: unknown) { filters.push((r) => r[col] === value); return q },
        single: async () => insertResult,
        maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
        then(resolve: any, reject: any) {
          const hit = matched()
          if (patch) for (const r of hit) Object.assign(r, patch)
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(resolve, reject)
        },
      }
      return q
    },
  }
  return { admin: admin as any, rows }
}

const MISSING_LENGTH = { code: 'PGRST204', message: "Could not find the 'max_primary_questions' column of 'interview_grants' in the schema cache" }
const MISSING_FOLLOW_UPS = { code: 'PGRST204', message: "Could not find the 'follow_ups_enabled' column of 'interview_grants' in the schema cache" }
const CHECK_VIOLATION = { code: '23514', message: 'new row for relation "interview_grants" violates check constraint "interview_grants_max_primary_questions_check"' }
const TABLE_MISSING = { code: '42P01', message: 'relation "public.interview_grants" does not exist' }
const NETWORK = { code: '', message: 'TypeError: fetch failed' }

/** The code under test logs loudly on every refusal; keep the test output readable. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { error, warn } = console
  console.error = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.error = error
    console.warn = warn
  }
}
const grantFor = (admin: any, length: 5 | 10) => quietly(() => createGrant(admin, USER, 'practice', 'clinical', true, length))

// ---- explicit 5 / 10, or no start ----------------------------------------

test('every new grant records its length explicitly: 5 for Quick, 10 for Full, never NULL', async () => {
  for (const length of [5, 10] as const) {
    const { admin, inserts } = fakeAdmin([{ data: { id: `grant-${length}` } }])
    assert.deepEqual(await grantFor(admin, length), { ok: true, id: `grant-${length}` })
    assert.equal(inserts.length, 1)
    assert.equal(inserts[0].max_primary_questions, length, 'explicit, for both lengths')
    assert.equal(inserts[0].follow_ups_enabled, true)
  }
})

test('Quick start with the length column unavailable: refused, one attempt, no NULL grant', async () => {
  const { admin, inserts } = fakeAdmin([{ error: MISSING_LENGTH }, { data: { id: 'must-not-happen' } }])
  assert.deepEqual(await grantFor(admin, 5), { ok: false, reason: 'schema_unavailable' })
  assert.equal(inserts.length, 1, 'no second insert without the length')
})

test('Full start with the length column unavailable: ALSO refused, one attempt, no NULL grant', async () => {
  const { admin, inserts } = fakeAdmin([{ error: MISSING_LENGTH }, { data: { id: 'must-not-happen' } }])
  assert.deepEqual(await grantFor(admin, 10), { ok: false, reason: 'schema_unavailable' })
  assert.equal(inserts.length, 1, 'the legacy length-less insert is gone for Full too')
})

test('any grant failure refuses the start, for either length -- nothing retries without a column', async () => {
  for (const length of [5, 10] as const) {
    for (const [error, reason] of [
      [MISSING_FOLLOW_UPS, 'schema_unavailable'],
      [TABLE_MISSING, 'schema_unavailable'],
      [CHECK_VIOLATION, 'failed'],
      [NETWORK, 'failed'],
    ] as const) {
      const { admin, inserts } = fakeAdmin([{ error }, { data: { id: 'must-not-happen' } }])
      assert.deepEqual(await grantFor(admin, length), { ok: false, reason }, `${length}: ${error.message}`)
      assert.equal(inserts.length, 1)
    }
  }
  // A "success" with no id is not a grant either.
  const { admin } = fakeAdmin([{ data: {} }])
  assert.deepEqual(await grantFor(admin, 10), { ok: false, reason: 'failed' })
})

// ---- a usable grant means a consumed entitlement --------------------------

function issueWith(store: ReturnType<typeof memoryGrants>, length: 5 | 10, charge?: () => Promise<number | null>) {
  return quietly(() =>
    issueInterview({
      createGrant: () => createGrant(store.admin, USER, 'practice', 'clinical', true, length),
      charge,
      voidGrant: (id) => abandonGrant(store.admin, id, USER),
    })
  )
}

test('a grant that cannot be written charges nothing', async () => {
  let charged = 0
  for (const error of [MISSING_LENGTH, NETWORK]) {
    const { admin } = fakeAdmin([{ error }])
    const out = await quietly(() =>
      issueInterview({
        createGrant: () => createGrant(admin, USER, 'practice', 'clinical', true, 5),
        charge: async () => ++charged,
        voidGrant: async () => assert.fail('nothing to void'),
      })
    )
    assert.equal(out.ok, false)
  }
  assert.equal(charged, 0, 'the charge is never attempted without a grant')
})

test('a failed charge voids the new grant and never returns its id', async () => {
  for (const failure of [async () => null, async () => { throw new Error('rpc down') }]) {
    const store = memoryGrants()
    const out = await issueWith(store, 10, failure)
    assert.deepEqual(out, { ok: false, reason: 'charge_failed' }, 'no grantId in the result')
    assert.equal(store.rows.length, 1, 'the row exists: service_role cannot DELETE by design')
    assert.ok(store.rows[0].abandoned_at, 'but it is voided')
    assert.equal(store.rows[0].session_id, null, 'and bound to nothing')
    assert.equal(store.rows[0].max_primary_questions, 10)
  }
})

test('a voided grant cannot be continued, resumed or found -- it authorizes nothing', async () => {
  const store = memoryGrants()
  await issueWith(store, 5, async () => null)
  const voided = store.rows[0]
  // checkGrant: even presenting the id (which the browser never received) is refused.
  const check = await quietly(() => checkGrant(store.admin, voided.id, USER))
  assert.equal(check.ok, false)
  assert.equal(!check.ok && check.status, 403)
  // Resume finds grants only through a bound session; this one has none.
  assert.equal(await findGrantBySession(store.admin, 'any-session', USER), null)
  // And were it ever bound, both resume and the turn route refuse an abandoned grant.
  const verdict = evaluateResume(
    { id: 'session-1', user_id: USER, conversation: transcript(1), engine_state: step(start('quick'), 'next_primary'), pending_turn: null },
    { ...(voided as GrantRow), session_id: 'session-1' },
    USER,
    NOW
  )
  assert.deepEqual(verdict, { resumable: false, reason: 'abandoned' })
})

test('retrying after a failed charge issues a NEW grant, charged -- never a free reuse', async () => {
  const store = memoryGrants()
  let attempt = 0
  let consumed = 0
  const charge = async () => (++attempt === 1 ? null : ++consumed)

  const first = await issueWith(store, 5, charge)
  const second = await issueWith(store, 5, charge)

  assert.deepEqual(first, { ok: false, reason: 'charge_failed' })
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.notEqual(second.grantId, store.rows[0].id, 'the voided grant is not reused')
  assert.equal(second.usageCount, 1)

  // Usable = what checkGrant accepts. Exactly one, and it was paid for.
  const usable: string[] = []
  for (const row of store.rows) if ((await quietly(() => checkGrant(store.admin, row.id, USER))).ok) usable.push(row.id)
  assert.deepEqual(usable, [second.grantId])
  assert.equal(consumed, usable.length, 'usable grants == consumed entitlements')
})

test('usable grant => consumed entitlement, across every outcome', async () => {
  for (const length of [5, 10] as const) {
    for (const metered of [true, false]) {
      for (const outcome of ['ok', 'null', 'throws'] as const) {
        const store = memoryGrants()
        let consumed = 0
        const charge = metered
          ? async () => {
              if (outcome === 'null') return null
              if (outcome === 'throws') throw new Error('charge failed')
              return ++consumed
            }
          : undefined
        const out = await issueWith(store, length, charge)
        const usable = []
        for (const row of store.rows) if ((await quietly(() => checkGrant(store.admin, row.id, USER))).ok) usable.push(row.id)
        const label = `${length}/${metered ? 'metered' : 'unmetered'}/${outcome}`
        if (out.ok) {
          assert.deepEqual(usable, [out.grantId], label)
          assert.ok(!metered || consumed === 1, `${label}: returned only after paying`)
          assert.equal(store.rows[0].max_primary_questions, length, `${label}: explicit length`)
        } else {
          assert.deepEqual(usable, [], `${label}: nothing usable`)
          assert.equal(consumed, 0)
        }
      }
    }
  }
})

test('the route issues through issueInterview and exposes the id only on success', () => {
  const post = ROUTE.slice(ROUTE.indexOf('export async function POST'))
  const issue = post.indexOf('const issued = await issueInterview({')
  const refuse = post.indexOf('if (!issued.ok) {')
  const expose = post.indexOf('grantId = issued.grantId')
  assert.ok(issue > -1 && refuse > issue && expose > refuse, 'issue, refuse, then expose')
  const wiring = post.slice(issue, refuse)
  assert.match(wiring, /createGrant: \(\) =>\s*createGrant\(/)
  assert.match(wiring, /charge: auth\.isUltimate \? undefined : \(\) => chargeInterview\(admin, auth\.userId\)/)
  assert.match(wiring, /voidGrant: \(id\) => abandonGrant\(admin, id, auth\.userId\)/)
  const refusal = post.slice(refuse, expose)
  assert.match(refusal, /return NextResponse\.json\([\s\S]*?status: 503/)
  assert.doesNotMatch(refusal, /grantId|usageCount/, 'a refusal returns neither')
  // No other assignment can put a grant id into the response on a start.
  assert.equal(post.match(/grantId = /g)?.length, 2, 'the continuation lookup and the issued grant, nothing else')
  assert.match(post, /grantId = check\.grant\?\.id \?\? null/)
})

test('a refused start lands back on setup, showing the server\'s reason', () => {
  for (const message of [
    'We could not start the interview. Nothing was charged — please try again.',
    'We could not start the interview. Please try again.',
  ]) {
    assert.ok(ROUTE.includes(message))
    const outcome = readTurnResponse(false, { error: message })
    assert.equal(outcome.ok, false)
    assert.equal(!outcome.ok && outcome.notice, message)
  }
  const begin = PAGE.slice(PAGE.indexOf('const startInterview = async'), PAGE.indexOf('const sendMessage = async'))
  assert.match(begin, /if \(!outcome\.ok\) \{[\s\S]*?setStarted\(false\)[\s\S]*?: outcome\.notice/)
})

// ---- reading: historical NULL and grants that cannot answer ---------------

test('a historical NULL grant continues and resumes as Full, whatever the state claims', () => {
  let quick = start('quick')
  for (let q = 1; q <= 3; q++) quick = step(quick, 'next_primary')
  // The turn route's rule...
  const continued = applyLengthAuthority(normalizeState(quick, start('full')), lengthAuthority({ max_primary_questions: null }))
  assert.equal(continued.maxPrimaryQuestions, 10)
  assert.equal(continued.maxFollowUpBudget, 5)
  assert.ok(allowedActions({ ...continued, primaryQuestionNumber: 5 }).includes('next_primary'), 'there is a sixth question')
  // ...and resume's, through the real evaluateResume.
  const resumed = refresh(quick, transcript(3), grant({ max_primary_questions: null }))
  assert.equal(resumed.state.maxPrimaryQuestions, 10)
  // A real Full state on a historical grant is left exactly as it was.
  let full = start('full')
  for (let q = 1; q <= 3; q++) full = step(full, 'next_primary')
  assert.deepEqual(refresh(full, transcript(3), grant({ max_primary_questions: null })).state, full)
})

test('a grant that cannot answer on length (no column, no row) also reads as Full', () => {
  let quick = start('quick')
  for (let q = 1; q <= 3; q++) quick = step(quick, 'next_primary')
  for (const grantless of [{}, null, { follow_ups_enabled: true }]) {
    const governed = applyGrantAuthority(quick, grantless as any)
    assert.equal(governed.maxPrimaryQuestions, 10, JSON.stringify(grantless))
    assert.equal(governed.maxFollowUpBudget, 5)
  }
  const full = step(start('full'), 'next_primary')
  assert.deepEqual(applyGrantAuthority(full, {}), full, 'a Full state meets exactly the Phase 2 reading')
  const legacyGrant = grant()
  delete (legacyGrant as any).max_primary_questions
  assert.equal(refresh(quick, transcript(3), legacyGrant).state.maxPrimaryQuestions, 10)
})

// ==========================================================================
// 10. No grant, no interview
//
// The length helpers only ever TRANSFORM a state: when a grant cannot answer
// on length they read it as Full. They must never stand in for the grant
// itself. Existence, ownership and binding are checked first, by checkGrant
// and evaluateResume, and a missing grant row refuses the interview whatever
// the length fallback would have said.
//
//   existing grant, length NULL                  -> historical Full/10
//   existing grant, length column unreadable     -> Full/10 (legacy read)
//   no grant row -- or no grants table at all    -> refused
// ==========================================================================

const AUTHORITY = read('./authority.ts')

/** checkGrant's query shape over a table whose length column does not exist yet. */
function preLengthColumnAdmin(row: Record<string, unknown>) {
  return {
    from: () => {
      let columns = ''
      const q: any = {
        select(c: string) { columns = c; return q },
        eq() { return q },
        maybeSingle: async () =>
          columns.includes('max_primary_questions')
            ? { data: null, error: { code: '42703', message: 'column interview_grants.max_primary_questions does not exist' } }
            : { data: row, error: null },
      }
      return q
    },
  } as any
}
/** Every query fails the way Postgres does when interview_grants is absent. */
const noTableAdmin = {
  from: () => {
    const q: any = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: null, error: TABLE_MISSING }) }
    return q
  },
} as any

test('a continuation presenting a nonexistent grant id is refused', async () => {
  const store = memoryGrants()
  const issued = await issueWith(store, 5, async () => 1)
  assert.equal(issued.ok, true)
  for (const id of ['no-such-grant', '00000000-0000-0000-0000-000000000000']) {
    const check = await quietly(() => checkGrant(store.admin, id, USER))
    assert.deepEqual(check.ok, false, id)
    assert.equal(!check.ok && check.status, 403)
  }
  for (const id of [undefined, null, '', 42, {}]) {
    const check = await checkGrant(store.admin, id, USER)
    assert.equal(check.ok, false, JSON.stringify(id))
  }
  // Someone else's real grant is refused the same way as a missing one.
  if (issued.ok) assert.equal((await checkGrant(store.admin, issued.grantId, 'user-2')).ok, false)
})

test('with no grants table at all, a continuation is refused -- checks no longer go inactive', async () => {
  const check = await quietly(() => checkGrant(noTableAdmin, 'any-id-at-all', USER))
  assert.deepEqual(check, { ok: false, status: 503, error: 'Interview service temporarily unavailable. Please try again.' })
})

test('an EXISTING grant reads as Full when its length is NULL or unreadable -- and only then', async () => {
  let quick = start('quick')
  for (let q = 1; q <= 3; q++) quick = step(quick, 'next_primary')

  // Existing grant, length NULL: historical.
  const store = memoryGrants()
  store.rows.push({ id: 'historical', user_id: USER, turns_used: 3, completed: false, abandoned_at: null, session_id: null, created_at: new Date(NOW).toISOString(), follow_ups_enabled: true, max_primary_questions: null })
  const historical = await checkGrant(store.admin, 'historical', USER)
  assert.equal(historical.ok, true)
  if (historical.ok) {
    assert.deepEqual(lengthAuthority(historical.grant), { source: 'historical' })
    assert.equal(applyGrantAuthority(quick, historical.grant).maxPrimaryQuestions, 10)
  }

  // Existing grant, read before the length column exists: the legacy read.
  const legacy = await quietly(() =>
    checkGrant(preLengthColumnAdmin({ id: 'legacy', user_id: USER, turns_used: 3, completed: false, follow_ups_enabled: true, abandoned_at: null, session_id: null, created_at: new Date(NOW).toISOString() }), 'legacy', USER)
  )
  assert.equal(legacy.ok, true)
  if (legacy.ok) {
    assert.deepEqual(lengthAuthority(legacy.grant), { source: 'unavailable' })
    assert.equal(applyGrantAuthority(quick, legacy.grant).maxPrimaryQuestions, 10)
  }

  // The same legacy read of a grant that does NOT exist is still refused.
  const missing = await quietly(() =>
    checkGrant({ from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }; return q } } as any, 'legacy', USER)
  )
  assert.equal(missing.ok, false)
})

test('the route refuses a failed grant check before any length logic, reservation or model call', () => {
  const post = ROUTE.slice(ROUTE.indexOf('export async function POST'))
  const check = post.indexOf('const check = await checkGrant(admin, body?.grantId, auth.userId)')
  const refuse = post.indexOf('if (!check.ok) {', check)
  assert.ok(check > -1 && refuse > check)
  assert.match(post.slice(refuse, refuse + 120), /return NextResponse\.json\(\{ error: check\.error \}, \{ status: check\.status \}\)/)
  for (const later of ['lengthAuthority(check.grant)', 'applyLengthAuthority(', 'reserveTurn(', 'buildSystemPrompt(state', 'await runTurn(']) {
    assert.ok(refuse < post.indexOf(later), `the refusal comes before ${later}`)
  }
  // Every non-start turn goes through that check: the only other branch is a
  // genuine start, which issues its own grant and charges for it.
  assert.match(post, /if \(startingInterview\) \{[\s\S]*?\} else \{\s*const check = await checkGrant\(/)
})

test('Resume with no grant, someone else\'s, an unbound one, or one bound elsewhere is refused', async () => {
  let quick = start('quick')
  for (let q = 1; q <= 3; q++) quick = step(quick, 'next_primary')
  const session = { id: 'session-1', user_id: USER, conversation: transcript(3), engine_state: quick, pending_turn: null }
  // The length fallback WOULD read a missing grant as Full...
  assert.deepEqual(lengthAuthority(null), { source: 'unavailable' })
  // ...but existence, ownership and binding are decided first.
  for (const g of [null, grant({ user_id: 'user-2' }), grant({ session_id: null }), grant({ session_id: 'another-session' })]) {
    assert.deepEqual(evaluateResume(session, g, USER, NOW), { resumable: false, reason: 'not_found' }, JSON.stringify(g))
  }
  // And the lookup behind Resume finds nothing for a session no grant is bound to.
  const store = memoryGrants()
  await issueWith(store, 5, async () => 1) // a real, charged, but unbound grant
  assert.equal(await findGrantBySession(store.admin, 'session-1', USER), null)
  assert.equal(await findGrantBySession(noTableAdmin, 'session-1', USER), null)
  // The route hands exactly that lookup to evaluateResume and stops on a refusal.
  const RESUME = read('../../app/api/interview/resume/route.ts')
  assert.match(RESUME, /const grant = session \? await findGrantBySession\(admin, sessionId, userId\) : null\s*const verdict = evaluateResume\(/)
})

test('the length helpers are pure: they transform a state and can authorize nothing', () => {
  const code = strip(AUTHORITY)
  assert.doesNotMatch(code, /interviewSession|supabase|admin|from\(|fetch\(/, 'no database, no grant lookups')
  assert.doesNotMatch(code, /resumable|status:|checkGrant|evaluateResume/, 'no authorization verdicts, only states')
})
