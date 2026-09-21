import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyTurn, createInitialState } from './state.ts'
import {
  readTurnResponse,
  turnFailureBody,
  TurnTimeoutError,
  TURN_TIMEOUT_NOTICE,
  TURN_UNAVAILABLE_NOTICE,
  type TurnFailureCode,
} from './turnProtocol.ts'
import { buildModelInput, isSystemNotice, type ModelInputMessage } from './modelInput.ts'
import type { ChatMessage, InterviewState, ModelTurn, ScenarioEvaluation, TurnAction } from './types.ts'

/**
 * A failed turn is a notice, never a turn.
 *
 * The defect: when the model call timed out, the API returned an error body
 * that still echoed the engine state "so a failed turn never corrupts the
 * interview". The page decided success by the presence of `state`, so it
 * treated the error as a turn: the notice "The interviewer took too long to
 * respond. Send your answer again." was appended to the transcript as an
 * interviewer message, saved to interview_sessions, and replayed to the model
 * on every later turn. Production data showed 8 such messages in 6 sessions.
 * An opening-turn timeout was worse: the notice became "question 1" and the
 * interview could not continue at all, because no grant had been issued.
 *
 * The server is modelled from the route's contract using the SAME helpers the
 * route calls (turnFailureBody, buildModelInput) and the real state machine;
 * the client is modelled exactly as the page handles a turn. Source assertions
 * at the end pin both files to these models, as elsewhere in this repo.
 */

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const PAGE = strip(readFileSync(new URL('../../app/interview/page.tsx', import.meta.url), 'utf8'))
const ROUTE = strip(readFileSync(new URL('../../app/api/interview/route.ts', import.meta.url), 'utf8'))

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

const evaluation = (n: number): ScenarioEvaluation => ({
  primary_question_number: n,
  scenario_label: `scenario ${n}`,
  category: 'clinical',
  overall_score: 7,
  clinical: null,
  emotional: null,
  did_well: [],
  to_tighten: [],
  missed_concepts: [],
  elite_answer: '',
  red_flags: [],
  depth_reached: 2,
  response_to_pressure: 'held',
})

// ------------------------------------------------------------------ server

type Wire = { httpOk: boolean; body: unknown } | { throws: true }
type Script = TurnFailureCode | ModelTurn

/**
 * The route, as a contract: build the model input, call the model, and either
 * return the failure body (the catch path -- applyTurn never runs) or apply
 * the turn and return it.
 */
class Server {
  modelInputs: ModelInputMessage[][] = []
  script: Script[]
  constructor(script: Script[]) {
    this.script = script
  }

  handle(clientState: InterviewState | null, transcript: ChatMessage[], fallback: InterviewState): Wire {
    const state = clientState ?? fallback
    const opening = state.primaryQuestionNumber === 0 && transcript.length === 0
    this.modelInputs.push(buildModelInput('SYSTEM PROMPT', transcript, { opening }))
    const next = this.script.shift()
    if (next === undefined) throw new Error('script exhausted')
    if (typeof next === 'string') {
      return { httpOk: false, body: turnFailureBody(next) }
    }
    const state2 = applyTurn(state, next)
    const practice = state2.mode !== 'real'
    return {
      httpOk: true,
      body: {
        message: next.display_text,
        render: {
          spoken: next.display_text,
          evaluation: practice ? next.evaluation : null,
          withheldReviews: [],
          finalReport: state2.finalReport,
          allEvaluations: [],
        },
        state: state2,
        turnKind: state2.turnKind,
        questionAsked: next.question_asked,
        evaluation: next.evaluation,
        finalReport: state2.finalReport,
        complete: state2.complete,
        grantId: 'grant-1',
      },
    }
  }
}

// ------------------------------------------------------------------ client

/** The page's startInterview and sendMessage, as they handle a response. */
class Client {
  messages: ChatMessage[] = []
  state: InterviewState | null = null
  input = ''
  notice = ''
  started = false
  interviewCount = 0
  grantId: string | null = null
  saved: { conversation: ChatMessage[]; state: InterviewState | null }[] = []
  loggedQuestions: string[] = []

  start(send: (convo: ChatMessage[], state: InterviewState | null) => Wire) {
    this.started = true
    this.messages = []
    this.state = null
    this.notice = ''
    const wire = send([], null)
    if ('throws' in wire) {
      this.started = false
      this.notice = 'Interview service temporarily unavailable. Please try again.'
      return 'failed'
    }
    const outcome = readTurnResponse(wire.httpOk, wire.body)
    if (!outcome.ok) {
      this.started = false
      this.notice = outcome.code === 'timeout' ? 'The interviewer took too long to respond. Please try again.' : outcome.notice
      return 'failed'
    }
    const data = outcome.data
    if (typeof data.grantId === 'string') this.grantId = data.grantId
    const convo: ChatMessage[] = [{ role: 'assistant', content: data.render?.spoken || data.message }]
    this.messages = convo
    this.state = data.state
    this.interviewCount++
    if (data.turnKind === 'primary') this.loggedQuestions.push(data.questionAsked)
    this.saved.push({ conversation: convo, state: data.state })
    return 'started'
  }

  answer(text: string, send: (convo: ChatMessage[], state: InterviewState | null) => Wire) {
    const previousMessages = this.messages
    const newMessages: ChatMessage[] = [...this.messages, { role: 'user', content: text }]
    this.messages = newMessages
    this.input = ''
    this.notice = ''
    const rollback = (notice: string) => {
      this.messages = previousMessages
      this.input = text
      this.notice = notice
    }
    const wire = send(newMessages, this.state)
    if ('throws' in wire) {
      rollback('Connection problem. Send your answer again.')
      return 'rolled back'
    }
    const outcome = readTurnResponse(wire.httpOk, wire.body)
    if (!outcome.ok) {
      rollback(outcome.notice)
      return 'rolled back'
    }
    const data = outcome.data
    const turnMessage: ChatMessage = { role: 'assistant', content: data.render?.spoken || data.message }
    this.messages = [...newMessages, turnMessage]
    this.state = data.state
    if (data.turnKind === 'primary') this.loggedQuestions.push(data.questionAsked)
    this.saved.push({ conversation: this.messages, state: data.state })
    return 'advanced'
  }
}

// ------------------------------------------------------------------ helpers

const initial = (mode: 'practice' | 'real' = 'real') =>
  createInitialState({ mode, type: 'clinical', followUpsEnabled: true })

/** A client and server that have already reached main question `n` normally. */
function atQuestion(n: number, mode: 'practice' | 'real' = 'real') {
  const script: Script[] = [turn('next_primary', { display_text: 'Welcome. Q1', question_asked: 'Q1' })]
  for (let i = 1; i < n; i++) {
    script.push(turn('next_primary', { display_text: `Q${i + 1}`, question_asked: `Q${i + 1}`, evaluation: evaluation(i) }))
  }
  const server = new Server(script)
  const client = new Client()
  const fallback = initial(mode)
  const send = (convo: ChatMessage[], state: InterviewState | null) => server.handle(state, convo, fallback)
  client.start(send)
  for (let i = 1; i < n; i++) client.answer(`a${i}`, send)
  return { client, server, fallback }
}

/** Every counter a timeout must not move. */
const counters = (s: InterviewState) => ({
  primaryQuestionNumber: s.primaryQuestionNumber,
  followUpCount: s.followUpCount,
  followUpBudget: s.followUpBudget,
  repromptCount: s.repromptCount,
  repromptBudget: s.repromptBudget,
  turnKind: s.turnKind,
  complete: s.complete,
  askedPrimaryQuestions: s.askedPrimaryQuestions.length,
  askedFormats: s.askedFormats.length,
  evaluations: s.evaluations.length,
  categoryCounts: { ...s.categoryCounts },
  difficultyLevel: s.difficultyLevel,
  suggestedDifficulty: s.suggestedDifficulty,
})

const mentionsNotice = (messages: { content: unknown }[]) =>
  messages.some((m) => typeof m.content === 'string' && m.content.includes('took too long'))

// ==========================================================================
// 1. Timeout while generating a main question
// ==========================================================================

test('a timeout while generating the next main question leaves the interview exactly where it was', () => {
  const { client, server, fallback } = atQuestion(3)
  const before = { messages: client.messages, state: client.state!, saved: client.saved.length, logged: [...client.loggedQuestions] }
  server.script.push('timeout')

  const result = client.answer('a3', (convo, state) => server.handle(state, convo, fallback))

  assert.equal(result, 'rolled back')
  assert.equal(client.messages, before.messages, 'the exact transcript object is restored')
  assert.equal(client.state, before.state, 'the exact engine state is kept')
  assert.equal(client.state!.primaryQuestionNumber, 3, 'still on question 3')
  assert.equal(client.notice, TURN_TIMEOUT_NOTICE, 'the applicant is told what happened')
  assert.equal(client.input, 'a3', 'their answer is handed back to resend')
  assert.equal(client.saved.length, before.saved, 'nothing was saved')
  assert.deepEqual(client.loggedQuestions, before.logged, 'no question was logged')
  assert.ok(!mentionsNotice(client.messages), 'the notice is not in the transcript')
})

test('a timeout while generating the FIRST question starts nothing', () => {
  const server = new Server(['timeout'])
  const client = new Client()
  const fallback = initial()

  const result = client.start((convo, state) => server.handle(state, convo, fallback))

  assert.equal(result, 'failed')
  assert.equal(client.started, false, 'back to setup')
  assert.deepEqual(client.messages, [], 'the notice did not become question 1')
  assert.equal(client.state, null)
  assert.equal(client.saved.length, 0, 'no session row was created')
  assert.equal(client.interviewCount, 0, 'nothing was counted')
  assert.equal(client.grantId, null, 'no grant was issued')
  assert.match(client.notice, /took too long/)
})

test('in Practice mode a timeout opens no feedback checkpoint and appends no review', () => {
  const { client, server, fallback } = atQuestion(4, 'practice')
  const before = client.messages
  server.script.push('timeout')
  client.answer('a4', (convo, state) => server.handle(state, convo, fallback))
  assert.equal(client.messages, before)
  assert.ok(!client.messages.some((m) => m.evaluation), 'no review entry was added')
})

// ==========================================================================
// 2. Timeout while generating a follow-up
// ==========================================================================

test('a timeout while generating a follow-up leaves the follow-up counters untouched', () => {
  const { client, server, fallback } = atQuestion(2)
  const send = (convo: ChatMessage[], state: InterviewState | null) => server.handle(state, convo, fallback)
  server.script.push(turn('ask_follow_up', { display_text: 'Why that agent?' }))
  client.answer('a2', send)
  assert.equal(client.state!.turnKind, 'follow_up')
  assert.equal(client.state!.followUpCount, 1)
  const before = { messages: client.messages, state: client.state!, snapshot: counters(client.state!) }

  server.script.push('timeout')
  const result = client.answer('because it raises SVR', send)

  assert.equal(result, 'rolled back')
  assert.equal(client.state, before.state)
  assert.deepEqual(counters(client.state!), before.snapshot)
  assert.equal(client.state!.followUpCount, 1, 'no follow-up was spent')
  assert.equal(client.state!.followUpBudget, before.state.followUpBudget, 'no budget was spent')
  assert.equal(client.messages, before.messages)
  assert.ok(!mentionsNotice(client.messages))
})

// ==========================================================================
// 3. Retry after timeout
// ==========================================================================

test('retrying after a timeout produces exactly the turn an uninterrupted interview would have', () => {
  const next = turn('next_primary', { display_text: 'Q4', question_asked: 'Q4', evaluation: evaluation(3) })

  // Control: no timeout.
  const control = atQuestion(3)
  control.server.script.push(next)
  control.client.answer('a3', (convo, state) => control.server.handle(state, convo, control.fallback))

  // Same interview, one timeout, then the applicant resends the same answer.
  const retried = atQuestion(3)
  const send = (convo: ChatMessage[], state: InterviewState | null) => retried.server.handle(state, convo, retried.fallback)
  retried.server.script.push('timeout', next)
  retried.client.answer('a3', send)
  retried.client.answer(retried.client.input, send)

  assert.deepEqual(retried.client.state, control.client.state, 'identical engine state')
  assert.deepEqual(retried.client.messages, control.client.messages, 'identical transcript')
  assert.equal(retried.client.state!.primaryQuestionNumber, 4, 'advanced exactly once')
  assert.equal(retried.client.messages.filter((m) => m.role === 'user' && m.content === 'a3').length, 1, 'the answer appears once')
  assert.equal(retried.client.notice, '', 'the notice clears on success')
})

test('retrying a follow-up after a timeout spends exactly one follow-up', () => {
  const { client, server, fallback } = atQuestion(2)
  const send = (convo: ChatMessage[], state: InterviewState | null) => server.handle(state, convo, fallback)
  const budget = client.state!.followUpBudget
  server.script.push('timeout', 'timeout', turn('ask_follow_up', { display_text: 'Why?' }))
  client.answer('a2', send)
  client.answer('a2', send)
  client.answer('a2', send)
  assert.equal(client.state!.followUpCount, 1)
  assert.equal(client.state!.followUpBudget, budget - 1)
  assert.equal(client.state!.primaryQuestionNumber, 2)
})

// ==========================================================================
// 4. No counter moves on a timeout, anywhere in the interview
// ==========================================================================

test('no counter moves on a timeout: opening, main, follow-up, reprompt and final question', () => {
  const cases: [string, () => ReturnType<typeof atQuestion>][] = [
    ['main question', () => atQuestion(3)],
    ['final question', () => atQuestion(10)],
    ['follow-up', () => {
      const ctx = atQuestion(5)
      ctx.server.script.push(turn('ask_follow_up', { display_text: 'More?' }))
      ctx.client.answer('a5', (c, s) => ctx.server.handle(s, c, ctx.fallback))
      return ctx
    }],
    ['after a reprompt', () => {
      const ctx = atQuestion(6)
      ctx.server.script.push(turn('reprompt_current', { display_text: 'Take your best shot.' }))
      ctx.client.answer("I don't know", (c, s) => ctx.server.handle(s, c, ctx.fallback))
      return ctx
    }],
  ]
  for (const [label, make] of cases) {
    for (const code of ['timeout', 'unavailable'] as const) {
      const ctx = make()
      const before = counters(ctx.client.state!)
      const beforeMessages = ctx.client.messages
      ctx.server.script.push(code)
      ctx.client.answer('answer', (c, s) => ctx.server.handle(s, c, ctx.fallback))
      assert.deepEqual(counters(ctx.client.state!), before, `${label}/${code}: counters unchanged`)
      assert.equal(ctx.client.messages, beforeMessages, `${label}/${code}: transcript unchanged`)
    }
  }
})

test('the failure body carries nothing a client could adopt as state or as a turn', () => {
  for (const code of ['timeout', 'unavailable'] as const) {
    const body = turnFailureBody(code) as unknown as Record<string, unknown>
    for (const field of ['state', 'render', 'turnKind', 'questionAsked', 'evaluation', 'finalReport', 'complete', 'grantId']) {
      assert.ok(!(field in body), `${code}: no ${field}`)
    }
    assert.equal(body.ok, false)
    assert.equal(body.retryable, true)
  }
  assert.equal(turnFailureBody('timeout').message, TURN_TIMEOUT_NOTICE, 'same words the applicant saw before')
  assert.equal(new TurnTimeoutError().message, TURN_TIMEOUT_NOTICE)
})

test('an error body in the OLD shape (state echoed) can never become a turn', () => {
  // Exactly what the route returned before this fix, with status 500.
  const legacy = {
    message: TURN_TIMEOUT_NOTICE,
    render: null,
    state: atQuestion(3).client.state,
    turnKind: 'primary',
    questionAsked: '',
    evaluation: null,
    finalReport: null,
    complete: false,
  }
  const outcome = readTurnResponse(false, legacy)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.notice, TURN_TIMEOUT_NOTICE)
})

test('REGRESSION and deploy safety: the old page adopted the old error body; it rolls back on the new one', () => {
  // The page's previous check, verbatim: success meant "the body has state".
  const oldPageAdoptsAsTurn = (body: any) => Boolean(body?.state)
  const oldBody = { message: TURN_TIMEOUT_NOTICE, render: null, state: initial(), turnKind: 'opening', questionAsked: '', evaluation: null, finalReport: null, complete: false }
  assert.equal(oldPageAdoptsAsTurn(oldBody), true, 'the defect: the notice became an interviewer turn')
  // A browser still running the old page after this deploy is protected by the
  // server change alone: the new failure body has no state to adopt.
  for (const code of ['timeout', 'unavailable'] as const) {
    assert.equal(oldPageAdoptsAsTurn(turnFailureBody(code)), false, `${code}: an old page rolls back`)
  }
})

test('every failure shape is a failure, and refusals keep their own words', () => {
  assert.equal(readTurnResponse(true, null).ok, false, 'empty body')
  assert.equal(readTurnResponse(true, { message: 'hi' }).ok, false, 'no state')
  assert.equal(readTurnResponse(true, { ok: false, error: 'timeout', message: TURN_TIMEOUT_NOTICE, state: {} }).ok, false, 'explicit failure')
  const refusal = readTurnResponse(false, { error: 'This interview has reached its maximum length. Please start a new one.' })
  assert.equal(refusal.ok, false)
  if (!refusal.ok) assert.match(refusal.notice, /maximum length/)
  const unknown = readTurnResponse(false, 'not json')
  if (!unknown.ok) assert.equal(unknown.notice, TURN_UNAVAILABLE_NOTICE)
  assert.equal(readTurnResponse(true, { state: initial(), message: 'Q1' }).ok, true, 'a real turn is still a turn')
})

test('a response that is not JSON (e.g. a platform 504 page) rolls back too', () => {
  const { client } = atQuestion(3)
  const before = client.messages
  client.answer('a3', () => ({ throws: true }))
  assert.equal(client.messages, before)
  assert.match(client.notice, /Connection problem/)
})

// ==========================================================================
// 5. The notice never reaches the model
// ==========================================================================

test('after a timeout and retry, nothing sent to the model contains the notice', () => {
  const { client, server, fallback } = atQuestion(3)
  const send = (convo: ChatMessage[], state: InterviewState | null) => server.handle(state, convo, fallback)
  server.script.push('timeout', turn('next_primary', { display_text: 'Q4', question_asked: 'Q4', evaluation: evaluation(3) }))
  client.answer('a3', send)
  client.answer('a3', send)
  server.script.push(turn('next_primary', { display_text: 'Q5', question_asked: 'Q5', evaluation: evaluation(4) }))
  client.answer('a4', send)

  for (const input of server.modelInputs) assert.ok(!mentionsNotice(input), 'no model input mentions it')
  assert.ok(!mentionsNotice(client.messages), 'nor does the transcript')
  assert.ok(!client.saved.some((s) => mentionsNotice(s.conversation)), 'nor any saved snapshot')
})

test('a transcript saved before the fix is cleaned before it reaches the model', () => {
  // What the old page stored: the notice as an interviewer turn, then the resend.
  const legacyTranscript: ChatMessage[] = [
    { role: 'assistant', content: 'Welcome. Q1' },
    { role: 'user', content: 'a1' },
    { role: 'assistant', content: TURN_TIMEOUT_NOTICE },
    { role: 'user', content: 'a1' },
    { role: 'assistant', content: 'Interview service temporarily unavailable. Please try again.' },
  ]
  const input = buildModelInput('SYSTEM', legacyTranscript, { opening: false })
  assert.ok(!mentionsNotice(input))
  assert.ok(!input.some((m) => m.content === TURN_UNAVAILABLE_NOTICE))
  assert.deepEqual(input.map((m) => m.role), ['developer', 'assistant', 'user', 'user'])
  assert.ok(isSystemNotice(`  ${TURN_TIMEOUT_NOTICE}  `), 'matched after trimming')
  // Only the interviewer side is filtered: an applicant may say anything.
  const said = buildModelInput('SYSTEM', [{ role: 'user', content: TURN_TIMEOUT_NOTICE }], { opening: false })
  assert.equal(said.length, 2)
})

test('for every legitimate transcript the model input is exactly what the route built before', () => {
  // The route's previous inline assembly, verbatim.
  const legacyInput = (systemPrompt: string, messages: any[], opening: boolean) => {
    const input = [
      { role: 'developer', content: systemPrompt },
      ...messages.map((msg: any) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: String(msg.content ?? ''),
      })),
    ]
    if (opening) input.push({ role: 'user', content: 'Begin the interview.' })
    return input
  }
  const transcript: any[] = [
    { role: 'assistant', content: 'Welcome. Q1' },
    { role: 'user', content: 'answer one' },
    { role: 'assistant', content: '', evaluation: evaluation(1) }, // Practice review placeholder
    { role: 'assistant', content: 'Q2' },
    { role: 'user', content: 'answer two' },
    { role: 'assistant', content: 'A follow-up?' },
    { role: 'user', content: 42 }, // coerced exactly as before
    { role: 'system', content: 'odd role maps to user, as before' },
  ]
  assert.deepEqual(buildModelInput('P', transcript, { opening: false }), legacyInput('P', transcript, false))
  assert.deepEqual(buildModelInput('P', [], { opening: true }), legacyInput('P', [], true))
})

// ==========================================================================
// Source pins: the route and the page implement the models above
// ==========================================================================

test('route: a failed turn returns the failure body and never the state', () => {
  const catchBlock = ROUTE.slice(ROUTE.indexOf('} catch (error: any) {'), ROUTE.indexOf('async function runTurn'))
  assert.match(catchBlock, /turnFailureBody\(code\)/)
  assert.match(catchBlock, /error instanceof TurnTimeoutError/)
  assert.doesNotMatch(catchBlock, /\bstate\b/, 'no state in the failure response')
  assert.doesNotMatch(catchBlock, /render:/)
  assert.match(ROUTE, /throw new TurnTimeoutError\(\)/)
})

test('route: the model input goes through buildModelInput, and no turn is applied before the model answers', () => {
  const body = ROUTE.slice(ROUTE.indexOf('export async function POST'))
  assert.match(body, /const input = buildModelInput\(systemPrompt, messages, \{\s*opening: isOpeningTurn\(state\) && messages\.length === 0,?\s*\}\)/)
  assert.doesNotMatch(body, /messages\.map\(\(msg: any\)/, 'the old inline mapping is gone')
  assert.ok(body.indexOf('await runTurn(') < body.indexOf('applyTurn(state, turn)'), 'applyTurn only after a successful model call')
})

test('page: a turn is adopted only after readTurnResponse says it is one', () => {
  assert.match(PAGE, /const outcome = readTurnResponse\(response\.ok, await response\.json\(\)\)/)
  assert.doesNotMatch(PAGE, /data\?\.state/, 'the old "has state = success" checks are gone')

  const send = PAGE.slice(PAGE.indexOf('const sendMessage = async'), PAGE.indexOf('const advanceFromCheckpoint'))
  const guard = send.indexOf('if (!outcome.ok) {')
  assert.ok(guard > -1)
  assert.ok(send.indexOf('rollback(outcome.notice)') > guard)
  assert.ok(guard < send.indexOf('setEngineState(data.state)'), 'state is never touched on failure')
  assert.ok(guard < send.indexOf('await saveSession('), 'nothing is saved on failure')
  assert.ok(guard < send.indexOf('setPendingNext('), 'no checkpoint opens on failure')
  assert.match(send, /setMessages\(previousMessages\)/, 'rollback restores the pre-send transcript')

  const start = PAGE.slice(PAGE.indexOf('const startInterview'), PAGE.indexOf('const sendMessage'))
  const startGuard = start.indexOf('if (!outcome.ok) {')
  assert.ok(startGuard > -1)
  assert.ok(startGuard < start.indexOf('setInterviewCount('))
  // Resume moved adoption one step later still: the opening turn is BUFFERED
  // here and only rendered by finishStart, once the session is saved and its
  // authorization bound. The guarantee this test protects is unchanged and
  // strictly stronger -- a failed turn reaches neither the buffer nor the
  // screen.
  assert.ok(startGuard < start.indexOf('pendingStartRef.current = { convo, data }'))
  assert.doesNotMatch(start, /setMessages\(convo\)/, 'Q1 is not rendered inside startInterview')
  // Activation now lives behind a hard gate: finishStart confirms the binding,
  // and activateBufferedStart refuses to render anything unless it did.
  const finish = PAGE.slice(PAGE.indexOf('const finishStart'), PAGE.indexOf('const exitFailedStart'))
  assert.ok(finish.indexOf('if (!bound) return') < finish.indexOf('boundRef.current = true'))
  const activator = PAGE.slice(PAGE.indexOf('const activateBufferedStart'), PAGE.indexOf('const finishStart'))
  assert.ok(activator.indexOf('if (!boundRef.current) return') < activator.indexOf('setMessages(buffered.convo)'),
    'and it is rendered only after the binding succeeds')
})
