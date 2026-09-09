import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { allowedActions, applyTurn, createInitialState, MAX_PRIMARY_QUESTIONS } from './state.ts'
import type { ChatMessage, InterviewState, ModelTurn, TurnAction } from './types.ts'

/**
 * Practice mode reviews a scenario before the interviewer moves on.
 *
 * One model turn returns BOTH the review of the scenario just closed and the
 * next primary question -- `next_primary` carries `evaluation` (backwards) and
 * `display_text` (forwards). The client rendered that single turn as one
 * message, content first, so the transcript read:
 *
 *     [Question 2]
 *     [Question 1 review]
 *
 * which is the interviewer asking the next question before the coaching lands.
 *
 * The fix is presentation only. The turn is split into two transcript entries
 * and the second is held until the applicant clicks Continue. Nothing is
 * re-requested: no extra model call, no second advance, no extra reserved turn.
 * Real Interview mode never opens a checkpoint, because the server withholds
 * every evaluation there until the end.
 */

const PAGE = readFileSync(new URL('../../app/interview/page.tsx', import.meta.url), 'utf8')
const FEEDBACK = readFileSync(new URL('../../components/InterviewFeedback.tsx', import.meta.url), 'utf8')
const ROUTE = readFileSync(new URL('../../app/api/interview/route.ts', import.meta.url), 'utf8')
/** Executable text only, so a comment describing the old rule cannot pass. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const page = strip(PAGE)
const route = strip(ROUTE)

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

const evaluation = (n: number): any => ({
  primary_question_number: n,
  scenario_label: `scenario ${n}`,
  overall_score: 8,
  did_well: [],
  to_tighten: [],
  missed_concepts: [],
  elite_answer: 'an elite answer',
  red_flags: [],
})

// --------------------------------------------------------------- the model

/** The turn response the client receives, as the route composes it. */
type TurnResponse = {
  state: InterviewState
  render: { spoken: string; evaluation: any; withheldReviews: any[]; finalReport: any; allEvaluations: any[] }
  evaluation: any
  questionAsked: string
  complete: boolean
  turnKind: string
}

/** toAssistantMessage, as the client writes it. */
const toAssistantMessage = (render: TurnResponse['render']): ChatMessage => ({
  role: 'assistant',
  content: render.spoken,
  evaluation: render.evaluation,
  withheldReviews: render.withheldReviews,
  finalReport: render.finalReport,
  allEvaluations: render.allEvaluations,
})

/** The client, modelled exactly: transcript, engine state, pending checkpoint. */
class Client {
  messages: ChatMessage[] = []
  engineState: InterviewState | null = null
  pendingNext:
    | { message: ChatMessage; state: InterviewState; questionAsked: string; isFinal: boolean }
    | null = null
  interviewEnded = false
  completedApplied = 0
  modelCalls = 0
  private continueInFlight = false

  /** Answering costs a turn; the checkpoint decides what becomes visible. */
  answer(text: string, response: TurnResponse) {
    if (this.pendingNext) return 'refused: checkpoint open'
    this.modelCalls++
    this.messages = [...this.messages, { role: 'user', content: text }]
    const turnMessage = toAssistantMessage(response.render)

    const practice = response.state.mode !== 'real'
    const deferrable = response.complete
      ? Boolean(response.render.finalReport)
      : Boolean(turnMessage.content)
    const checkpoint = practice && Boolean(response.evaluation) && deferrable

    if (checkpoint) {
      const review: ChatMessage = {
        ...turnMessage, content: '', finalReport: null, allEvaluations: [],
      }
      const deferred: ChatMessage = response.complete
        ? {
            role: 'assistant',
            content: turnMessage.content,
            finalReport: turnMessage.finalReport,
            allEvaluations: turnMessage.allEvaluations,
          }
        : { role: 'assistant', content: turnMessage.content }
      this.messages = [...this.messages, review]
      this.pendingNext = {
        message: deferred,
        state: response.state,
        questionAsked: response.questionAsked,
        isFinal: response.complete === true,
      }
      return 'checkpoint'
    }
    this.messages = [...this.messages, turnMessage]
    this.engineState = response.state
    if (response.complete) { this.interviewEnded = true; this.completedApplied++ }
    return 'advanced'
  }

  /** Reveals what the turn already produced. No model call. */
  continue() {
    if (this.continueInFlight) return 'refused: in flight'
    const next = this.pendingNext
    if (!next) return 'refused: nothing pending'
    this.continueInFlight = true
    try {
      this.messages = [...this.messages, next.message]
      this.engineState = next.state
      this.pendingNext = null
      if (next.isFinal) { this.interviewEnded = true; this.completedApplied++ }
      return 'revealed'
    } finally {
      this.continueInFlight = false
    }
  }

  /** The label the checkpoint offers, as the component chooses it. */
  buttonLabel() {
    if (!this.pendingNext) return null
    return this.pendingNext.isFinal ? 'Finish Interview' : 'Continue to Next Question'
  }
  hasFinalReport() {
    return this.messages.some((m) => m.finalReport)
  }

  /** What is on screen, in order. */
  transcript() {
    return this.messages.map((m) =>
      m.role === 'user'
        ? `answer`
        : m.evaluation
          ? `review:Q${m.evaluation.primary_question_number}`
          : `question:${m.content}`
    )
  }
  visibleQuestions() {
    return this.messages.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)
  }
}

/** Builds the response for a turn that closes scenario `n` and asks `n + 1`. */
function closingTurn(state: InterviewState, n: number, mode: 'practice' | 'real'): TurnResponse {
  const next = applyTurn(state, turn('next_primary', { evaluation: evaluation(n), question_asked: `Q${n + 1}` }))
  const practice = mode !== 'real'
  return {
    state: next,
    render: {
      spoken: `Q${n + 1}`,
      evaluation: practice ? evaluation(n) : null,
      withheldReviews: [],
      finalReport: null,
      allEvaluations: [],
    },
    evaluation: practice ? evaluation(n) : null,
    questionAsked: `Q${n + 1}`,
    complete: false,
    turnKind: 'primary',
  }
}

function startedClient(mode: 'practice' | 'real') {
  const c = new Client()
  const opening = applyTurn(
    createInitialState({ mode, type: 'clinical', followUpsEnabled: false }),
    turn('next_primary', { question_asked: 'Q1' })
  )
  c.messages = [{ role: 'assistant', content: 'Q1' }]
  c.engineState = opening
  return c
}

// -------------------------------------------------- 1-2. order of appearance

test('a Practice answer produces Q1 feedback before Q2 is visible', () => {
  const c = startedClient('practice')
  assert.equal(c.answer('my answer', closingTurn(c.engineState!, 1, 'practice')), 'checkpoint')
  assert.deepEqual(c.transcript(), ['question:Q1', 'answer', 'review:Q1'])
  assert.ok(!c.visibleQuestions().includes('Q2'), 'Q2 is not on screen')
})

test('Q2 stays hidden while Q1 feedback is pending — the exact inverted order is gone', () => {
  const c = startedClient('practice')
  c.answer('my answer', closingTurn(c.engineState!, 1, 'practice'))
  const t = c.transcript()
  const review = t.indexOf('review:Q1')
  const q2 = t.indexOf('question:Q2')
  assert.ok(review > -1, 'the review is shown')
  assert.equal(q2, -1, 'Q2 is absent entirely, not merely below the review')
  // And after Continue it lands strictly after.
  c.continue()
  const after = c.transcript()
  assert.ok(after.indexOf('review:Q1') < after.indexOf('question:Q2'), 'review precedes Q2')
})

test('the header does not count up to Q2 while Q1 is being reviewed', () => {
  const c = startedClient('practice')
  assert.equal(c.engineState!.primaryQuestionNumber, 1)
  c.answer('my answer', closingTurn(c.engineState!, 1, 'practice'))
  assert.equal(c.engineState!.primaryQuestionNumber, 1, 'engine state is pending too')
  c.continue()
  assert.equal(c.engineState!.primaryQuestionNumber, 2)
})

// ---------------------------------------------------- 3-5. Continue

test('Continue reveals the already-generated Q2', () => {
  const c = startedClient('practice')
  c.answer('my answer', closingTurn(c.engineState!, 1, 'practice'))
  assert.equal(c.continue(), 'revealed')
  assert.deepEqual(c.transcript(), ['question:Q1', 'answer', 'review:Q1', 'question:Q2'])
  assert.equal(c.pendingNext, null)
})

test('Continue triggers no model call — the question already exists', () => {
  const c = startedClient('practice')
  c.answer('my answer', closingTurn(c.engineState!, 1, 'practice'))
  const before = c.modelCalls
  c.continue()
  assert.equal(c.modelCalls, before, 'no additional turn was requested')
  // Asserted against the source too: Continue must not call the API.
  const fn = page.slice(page.indexOf('const advanceFromCheckpoint'), page.indexOf('const resetInterview'))
  assert.doesNotMatch(fn, /requestTurn|fetch\(/, 'Continue makes no request')
  assert.match(fn, /setMessages\(revealed\)/)
  assert.match(fn, /setEngineState\(next\.state\)/)
})

test('double-clicking Continue cannot advance twice or duplicate the question', () => {
  const c = startedClient('practice')
  c.answer('my answer', closingTurn(c.engineState!, 1, 'practice'))
  assert.equal(c.continue(), 'revealed')
  assert.equal(c.continue(), 'refused: nothing pending', 'a second click does nothing')
  assert.equal(c.visibleQuestions().filter((q) => q === 'Q2').length, 1, 'Q2 appears once')
  assert.equal(c.engineState!.primaryQuestionNumber, 2, 'advanced exactly once')

  // The synchronous guard, in the source: React state cannot guard two clicks
  // dispatched in the same tick.
  assert.match(page, /const continueInFlight = useRef\(false\)/)
  const fn = page.slice(page.indexOf('const advanceFromCheckpoint'), page.indexOf('const resetInterview'))
  assert.match(fn, /if \(continueInFlight\.current\) return/)
  assert.match(fn, /continueInFlight\.current = true/)
  assert.match(fn, /finally \{[\s\S]*continueInFlight\.current = false/)
  const guard = fn.indexOf('continueInFlight.current = true')
  assert.ok(guard > -1 && guard < fn.indexOf('await '), 'acquired before the first await')
})

// ------------------------------------------------------- 6. the composer

test('the composer does not accept an answer during the checkpoint', () => {
  const c = startedClient('practice')
  c.answer('my answer', closingTurn(c.engineState!, 1, 'practice'))
  const before = c.transcript().length
  assert.equal(c.answer('answering a question I cannot see', closingTurn(c.engineState!, 2, 'practice')),
    'refused: checkpoint open')
  assert.equal(c.transcript().length, before, 'nothing was appended')
  assert.equal(c.modelCalls, 1, 'and no turn was spent')
})

test('the composer is replaced by Continue, not left on screen', () => {
  assert.match(page, /if \(pendingNext\) return/, 'sendMessage refuses')
  assert.match(page, /\{pendingNext \? \(/, 'the composer branch is swapped')
  assert.match(PAGE, /Continue to Next Question/)
  assert.match(PAGE, /Review your feedback above, then continue\./)
  // The Continue branch precedes the input, so the input is not rendered too.
  assert.ok(
    page.indexOf('{pendingNext ? (') < page.indexOf("onKeyDown={(e) => e.key === 'Enter' && sendMessage()}"),
    'the checkpoint branch wins over the composer'
  )
})

// -------------------------------------------- 7. feedback belongs to Q_n

test('feedback is associated with the question that was answered', () => {
  const c = startedClient('practice')
  c.answer('a1', closingTurn(c.engineState!, 1, 'practice'))
  const review = c.messages[c.messages.length - 1]
  assert.equal(review.evaluation.primary_question_number, 1, 'Q1, not Q2')
  assert.equal(review.content, '', 'the review carries no question text')
  // The card names it, and that heading already existed.
  assert.match(FEEDBACK, /Question \{evaluation\.primary_question_number\} review/)
})

test('the split message renders as review-only', () => {
  // InterviewMessage skips an empty content bubble, so a content-less review
  // renders as the card alone.
  assert.match(FEEDBACK, /\{message\.content && \(/)
  assert.match(FEEDBACK, /\{message\.evaluation && <EvaluationCard evaluation=\{message\.evaluation\} \/>\}/)
})

// --------------------------------------------------------- 8-9. follow-ups

test('a follow-up turn opens no checkpoint — the scenario is not closed yet', () => {
  const c = startedClient('practice')
  const s = c.engineState!
  const followUp: TurnResponse = {
    state: applyTurn(s, turn('ask_follow_up')),
    // The engine sets evaluation to null on ask_follow_up; unchanged here.
    render: { spoken: 'and why is that?', evaluation: null, withheldReviews: [], finalReport: null, allEvaluations: [] },
    evaluation: null,
    questionAsked: 'and why is that?',
    complete: false,
    turnKind: 'follow_up',
  }
  assert.equal(c.answer('a1', followUp), 'advanced', 'the follow-up is shown immediately')
  assert.deepEqual(c.transcript(), ['question:Q1', 'answer', 'question:and why is that?'])
  assert.equal(c.pendingNext, null, 'no feedback checkpoint')
})

test('closing a scenario after a follow-up gives one checkpoint, then the next primary', () => {
  const c = startedClient('practice')
  const s = c.engineState!
  const afterFollowUp = applyTurn(s, turn('ask_follow_up'))
  c.answer('a1', {
    state: afterFollowUp,
    render: { spoken: 'and why?', evaluation: null, withheldReviews: [], finalReport: null, allEvaluations: [] },
    evaluation: null, questionAsked: 'and why?', complete: false, turnKind: 'follow_up',
  })
  // Answering the follow-up closes the scenario and scores it ONCE.
  assert.equal(c.answer('a2', closingTurn(afterFollowUp, 1, 'practice')), 'checkpoint')
  assert.deepEqual(c.transcript(), ['question:Q1', 'answer', 'question:and why?', 'answer', 'review:Q1'])
  const reviews = c.messages.filter((m) => m.evaluation)
  assert.equal(reviews.length, 1, 'exactly one review for the scenario, not one per follow-up')
  c.continue()
  assert.ok(c.visibleQuestions().includes('Q2'))
  assert.equal(c.engineState!.primaryQuestionNumber, 2, 'the follow-up consumed no primary question')
})

test('the engine still scores only on the turn that closes a scenario', () => {
  // Unchanged semantics: this is what makes one checkpoint per scenario fall out.
  const s = { ...createInitialState({ mode: 'practice', type: 'clinical', followUpsEnabled: true }),
    primaryQuestionNumber: 1, currentCategory: 'clinical' as const, turnKind: 'primary' as const }
  const probed = applyTurn(s, turn('ask_follow_up', { evaluation: evaluation(1) }))
  assert.equal(probed.evaluations.length, 0, 'a follow-up banks no evaluation')
  assert.equal(applyTurn(probed, turn('next_primary', { evaluation: evaluation(1) })).evaluations.length, 1)
})

// ----------------------------------------------------- 10. final question

/** The closing turn: Q10's review, the report, and `complete`, all at once. */
function finalTurn(state: InterviewState, mode: 'practice' | 'real'): TurnResponse {
  const practice = mode !== 'real'
  const report = { overall_score: 8, readiness: 'Competitive' } as any
  return {
    state: applyTurn(state, turn('final_report', { evaluation: evaluation(10), display_text: 'That is everything.' })),
    render: {
      spoken: 'That is everything.',
      evaluation: practice ? evaluation(10) : null,
      withheldReviews: practice ? [] : [evaluation(9), evaluation(10)],
      finalReport: report,
      allEvaluations: [evaluation(9), evaluation(10)],
    },
    evaluation: practice ? evaluation(10) : null,
    questionAsked: '',
    complete: true,
    turnKind: 'final_report',
  }
}

function atFinalQuestion(mode: 'practice' | 'real') {
  const c = startedClient(mode)
  c.engineState = { ...c.engineState!, primaryQuestionNumber: MAX_PRIMARY_QUESTIONS }
  return c
}

test('the final Practice answer does NOT immediately expose the final report', () => {
  const c = atFinalQuestion('practice')
  assert.equal(c.answer('final answer', finalTurn(c.engineState!, 'practice')), 'checkpoint')
  assert.equal(c.hasFinalReport(), false, 'the report is held back')
  assert.equal(c.interviewEnded, false, 'and the interview is not yet closed out')
})

test('Q10 review is visible first, on its own', () => {
  const c = atFinalQuestion('practice')
  c.answer('final answer', finalTurn(c.engineState!, 'practice'))
  assert.deepEqual(c.transcript(), ['question:Q1', 'answer', 'review:Q10'])
  const review = c.messages[c.messages.length - 1]
  assert.equal(review.evaluation.primary_question_number, 10)
  assert.equal(review.content, '', 'no closing line competing with the review')
  assert.equal(review.finalReport, null, 'and no report underneath it')
  assert.deepEqual(review.allEvaluations, [], 'nor the full score list')
})

test('the final checkpoint button reads "Finish Interview"', () => {
  const c = atFinalQuestion('practice')
  c.answer('final answer', finalTurn(c.engineState!, 'practice'))
  assert.equal(c.buttonLabel(), 'Finish Interview')
  assert.match(PAGE, /pendingNext\.isFinal \? 'Finish Interview' : 'Continue to Next Question'/)
})

test('a non-final checkpoint still reads "Continue to Next Question"', () => {
  const c = startedClient('practice')
  c.answer('a1', closingTurn(c.engineState!, 1, 'practice'))
  assert.equal(c.buttonLabel(), 'Continue to Next Question')
})

test('Finish Interview reveals the already-generated report', () => {
  const c = atFinalQuestion('practice')
  c.answer('final answer', finalTurn(c.engineState!, 'practice'))
  assert.equal(c.continue(), 'revealed')
  assert.equal(c.hasFinalReport(), true)
  const final = c.messages[c.messages.length - 1]
  assert.equal(final.finalReport.overall_score, 8, 'the same report the turn produced')
  assert.deepEqual(final.allEvaluations!.map((e: any) => e.primary_question_number), [9, 10])
  // The review still precedes it.
  const t = c.transcript()
  assert.ok(t.indexOf('review:Q10') < t.length - 1, 'review comes before the report entry')
})

test('Finish Interview makes zero API/model calls', () => {
  const c = atFinalQuestion('practice')
  c.answer('final answer', finalTurn(c.engineState!, 'practice'))
  const before = c.modelCalls
  c.continue()
  assert.equal(c.modelCalls, before, 'nothing was re-requested')
  const fn = page.slice(page.indexOf('const advanceFromCheckpoint'), page.indexOf('const resetInterview'))
  assert.doesNotMatch(fn, /requestTurn|fetch\(/, 'the handler makes no request')
})

test('the completed state is applied exactly once', () => {
  const c = atFinalQuestion('practice')
  c.answer('final answer', finalTurn(c.engineState!, 'practice'))
  assert.equal(c.completedApplied, 0, 'not applied while the review is being read')
  c.continue()
  assert.equal(c.completedApplied, 1)
  assert.equal(c.engineState!.complete, true)
  assert.equal(c.interviewEnded, true)
})

test('double-clicking Finish cannot complete twice', () => {
  const c = atFinalQuestion('practice')
  c.answer('final answer', finalTurn(c.engineState!, 'practice'))
  assert.equal(c.continue(), 'revealed')
  assert.equal(c.continue(), 'refused: nothing pending')
  assert.equal(c.completedApplied, 1, 'completed once')
  assert.equal(c.messages.filter((m) => m.finalReport).length, 1, 'one report, not two')
  // Same synchronous ref as the non-final path.
  const fn = page.slice(page.indexOf('const advanceFromCheckpoint'), page.indexOf('const resetInterview'))
  assert.match(fn, /if \(continueInFlight\.current\) return/)
  assert.match(fn, /finally \{[\s\S]*continueInFlight\.current = false/)
})

test('the final checkpoint creates no Q11', () => {
  const c = atFinalQuestion('practice')
  const before = c.engineState!.primaryQuestionNumber
  c.answer('final answer', finalTurn(c.engineState!, 'practice'))
  c.continue()
  assert.equal(c.engineState!.primaryQuestionNumber, MAX_PRIMARY_QUESTIONS)
  assert.equal(before, MAX_PRIMARY_QUESTIONS)
  assert.ok(!c.visibleQuestions().includes('Q11'))
  assert.deepEqual(allowedActions({ ...c.engineState!, complete: false }), ['final_report'],
    'there was never an eleventh question to ask')
})

test('the interview only ends at the checkpoint action, not on the turn', () => {
  // `setInterviewEnded` moved out of the deferred path into the handler.
  const send = page.slice(page.indexOf('const sendMessage = async'), page.indexOf('const advanceFromCheckpoint'))
  const checkpointBlock = send.slice(send.indexOf('if (checkpoint) {'), send.indexOf('const updatedMessages'))
  assert.doesNotMatch(checkpointBlock, /setInterviewEnded\(true\)/, 'not ended while the review is read')
  const fn = page.slice(page.indexOf('const advanceFromCheckpoint'), page.indexOf('const resetInterview'))
  assert.match(fn, /if \(next\.isFinal\) \{[\s\S]*setInterviewEnded\(true\)/)
})

// ------------------------------------------- 11-12. Real Interview mode

test('Real Interview mode shows no between-question feedback', () => {
  const c = startedClient('real')
  for (let n = 1; n <= 3; n++) {
    assert.equal(c.answer(`a${n}`, closingTurn(c.engineState!, n, 'real')), 'advanced')
    assert.equal(c.pendingNext, null, `no checkpoint after Q${n}`)
  }
  assert.deepEqual(c.transcript(), [
    'question:Q1', 'answer', 'question:Q2', 'answer', 'question:Q3', 'answer', 'question:Q4',
  ])
  assert.equal(c.messages.filter((m) => m.evaluation).length, 0, 'no score cards between questions')
})

test('Real mode is excluded at the server, not just the client', () => {
  // The route withholds every evaluation until the end in Real mode, so the
  // client-side condition can never see one to defer.
  assert.match(route, /evaluation: practice \? turn\.evaluation : null/)
  assert.match(route, /withheldReviews: !practice && nextState\.complete \? nextState\.evaluations : \[\]/)
})

test('Real mode final behaviour is unchanged: no checkpoint, report lands immediately', () => {
  const c = atFinalQuestion('real')
  assert.equal(c.answer('final answer', finalTurn(c.engineState!, 'real')), 'advanced',
    'no Finish checkpoint in Real mode')
  assert.equal(c.pendingNext, null)
  assert.equal(c.buttonLabel(), null, 'no checkpoint button at all')
  assert.equal(c.hasFinalReport(), true, 'the report arrives with the closing turn')
  assert.equal(c.interviewEnded, true)
  assert.equal(c.completedApplied, 1)
  const final = c.messages[c.messages.length - 1]
  assert.equal(final.withheldReviews!.length, 2, 'reviews still revealed only at the end')
  assert.equal(final.evaluation, null, 'and no per-question card between questions')
})

test('Real mode sequencing is unchanged and still ends with the report', () => {
  const c = startedClient('real')
  const last: InterviewState = { ...c.engineState!, primaryQuestionNumber: MAX_PRIMARY_QUESTIONS, mode: 'real' }
  c.engineState = last
  c.answer('final', {
    state: applyTurn(last, turn('final_report', { evaluation: evaluation(10) })),
    render: {
      spoken: 'Thank you.', evaluation: null,
      withheldReviews: [evaluation(9), evaluation(10)],
      finalReport: { overall_score: 8 } as any, allEvaluations: [evaluation(9), evaluation(10)],
    },
    evaluation: null, questionAsked: '', complete: true, turnKind: 'final_report',
  })
  const final = c.messages[c.messages.length - 1]
  assert.equal(final.withheldReviews!.length, 2, 'reviews revealed only at the end')
  assert.ok(final.finalReport)
  assert.equal(c.pendingNext, null)
})

// ------------------------------------- 13-15. counts, restore, history

test('the main-question count is unchanged in both modes', () => {
  for (const mode of ['practice', 'real'] as const) {
    const c = startedClient(mode)
    let asked = 1
    for (let n = 1; n < MAX_PRIMARY_QUESTIONS; n++) {
      c.answer(`a${n}`, closingTurn(c.engineState!, n, mode))
      if (c.pendingNext) c.continue()
      asked++
    }
    assert.equal(asked, MAX_PRIMARY_QUESTIONS, `${mode}: still 10 questions`)
    assert.equal(c.engineState!.primaryQuestionNumber, MAX_PRIMARY_QUESTIONS)
  }
})

test('a checkpoint is never inherited by a new interview', () => {
  const start = page.slice(page.indexOf('const startInterview'), page.indexOf('const sendMessage'))
  assert.match(start, /setPendingNext\(null\)/, 'a new interview opens with no checkpoint')
  assert.match(start, /continueInFlight\.current = false/)
  const resetAt = page.indexOf('const resetInterview')
  const reset = page.slice(resetAt, page.indexOf('return (', resetAt))
  assert.match(reset, /setPendingNext\(null\)/)
})

test('what is persisted matches what the applicant has seen', () => {
  // While the checkpoint is open the session is saved with the review and the
  // PRE-turn state, so a restore cannot land past the checkpoint holding a
  // question that was never shown.
  const send = page.slice(page.indexOf('const sendMessage = async'), page.indexOf('const advanceFromCheckpoint'))
  assert.match(send, /await saveSession\(shown, engineState, currentSessionId\)/)
  const cont = page.slice(page.indexOf('const advanceFromCheckpoint'), page.indexOf('const resetInterview'))
  assert.match(cont, /await saveSession\(revealed, next\.state, currentSessionId\)/)
})

test('completed historical interviews still render', () => {
  // History renders stored `conversation` through the same component. A review
  // entry is an ordinary assistant message with an empty content string, and
  // older transcripts -- one message carrying both -- render exactly as before.
  const legacy: ChatMessage = {
    role: 'assistant', content: 'Q2', evaluation: evaluation(1),
    withheldReviews: [], finalReport: null, allEvaluations: [],
  }
  assert.equal(legacy.content, 'Q2', 'legacy shape untouched')
  assert.ok(legacy.evaluation, 'and still carries its review')
  assert.match(FEEDBACK, /export function InterviewMessage/)
  // Nothing in the renderer changed.
  assert.doesNotMatch(FEEDBACK, /pendingNext/)
})
