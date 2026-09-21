import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateResume } from './resume.ts'
import type { GrantRow } from './resume.ts'
import {
  FOLLOW_UP_BUDGET,
  MAX_FOLLOW_UPS,
  allowedActions,
  applyTurn,
  createInitialState,
  followUpCapFor,
  followUpsSpent,
  followUpsUnlocked,
  normalizeState,
} from './state.ts'
import { buildSessionRow } from './sessionSaver.ts'
import type {
  ChatMessage,
  InterviewMode,
  InterviewState,
  InterviewType,
  ModelTurn,
  QuestionCategory,
  TurnAction,
} from './types.ts'

/**
 * Resume meets the Phase 2 follow-up policy.
 *
 * The two were built independently on top of Phase 0. Resume persists an
 * interview's engine state and restores it after a refresh; Phase 2 moved the
 * follow-up policy INTO that state -- its version, the purpose history, the
 * single deep dive, and a budget that unlocks as the interview progresses.
 * None of it is recomputed from the transcript, so anything a refresh drops
 * the interview has lost for good, and a V1 interview read back as V2 would
 * silently change rules mid-session.
 *
 * Every state here comes from the real engine, and every action is checked
 * against allowedActions before it is applied, so each fixture is a state the
 * route could genuinely have handed the browser. Each refresh then takes the
 * whole trip a real one takes: saved the way the page saves it, stored as
 * jsonb, judged by evaluateResume, and sent back to the page over HTTP.
 */

const PAGE = readFileSync(new URL('../../app/interview/page.tsx', import.meta.url), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

const USER = 'user-1'
const SESSION_ID = 'session-1'
const NOW = Date.parse('2026-09-21T12:00:00Z')

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

/** What both jsonb and an HTTP response hand back. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value))

type Checkpoint = { message: ChatMessage; state: InterviewState; questionAsked: string; isFinal: boolean }

/**
 * One interview as the browser holds it: the transcript, the engine state, and
 * an open checkpoint's deferred half, maintained the way page.tsx maintains
 * them. Each model turn follows the route's own sequence -- normalizeState on
 * the echoed state, only an action allowedActions offers, applyTurn, and the
 * result delivered as JSON.
 */
class Interview {
  state: InterviewState
  messages: ChatMessage[]
  pending: Checkpoint | null
  /** Turns the grant has spent, which does survive a refresh. */
  turnsUsed: number
  /** Calls made by THIS page load. A refresh starts a new page at zero. */
  modelCalls = 0

  constructor(state: InterviewState, messages: ChatMessage[] = [], pending: Checkpoint | null = null, turnsUsed = 0) {
    this.state = state
    this.messages = messages
    this.pending = pending
    this.turnsUsed = turnsUsed
  }

  static start(opts: { mode: InterviewMode; type: InterviewType; category?: QuestionCategory }) {
    const i = new Interview(createInitialState({ mode: opts.mode, type: opts.type, followUpsEnabled: true }))
    return i.turn('next_primary', { category: opts.category ?? 'clinical' })
  }

  turn(action: TurnAction, over: Partial<ModelTurn> = {}): this {
    assert.equal(this.pending, null, 'no answer is taken while a checkpoint is open')
    const current = normalizeState(this.state, this.state)
    assert.ok(allowedActions(current).includes(action), `${action} is not on offer at Q${current.primaryQuestionNumber}`)

    const opening = current.primaryQuestionNumber === 0
    const closing = !opening && (action === 'next_primary' || action === 'final_report')
    if (!opening) this.messages = [...this.messages, { role: 'user', content: 'an answer' }]

    const next = wire(
      applyTurn(
        current,
        turn(action, { question_asked: `question after ${this.turnsUsed}`, ...(closing ? { evaluation: evaluation(current.primaryQuestionNumber) } : {}), ...over })
      )
    )
    this.modelCalls += 1
    this.turnsUsed += 1
    const spoken = next.complete ? 'closing line' : `turn ${this.turnsUsed}`

    // page.tsx: a Practice turn that closes a scenario shows the review now
    // and holds back what came with it -- the next question, or the report.
    if (next.mode === 'practice' && closing) {
      this.messages = [
        ...this.messages,
        { role: 'assistant', content: '', evaluation: evaluation(current.primaryQuestionNumber) },
      ]
      this.pending = {
        message: next.complete
          ? { role: 'assistant', content: spoken, finalReport: next.finalReport }
          : { role: 'assistant', content: spoken },
        state: next,
        questionAsked: next.complete ? '' : spoken,
        isFinal: next.complete === true,
      }
      return this
    }
    this.messages = [...this.messages, { role: 'assistant', content: spoken }]
    this.state = next
    return this
  }

  /** advanceFromCheckpoint: reveal what the turn already produced. No request. */
  continue(): this {
    const next = this.pending
    assert.ok(next, 'a checkpoint is open')
    this.messages = [...this.messages, next.message]
    this.state = next.state
    this.pending = null
    return this
  }

  /** The row saveSession writes right now: the PRE-turn state while a checkpoint is open. */
  row() {
    return buildSessionRow(
      { userId: USER, interviewType: this.state.type, customTopic: '', mode: this.state.mode },
      { conversation: this.messages, state: this.state, pendingTurn: this.pending },
      true
    )
  }

  /** Refresh, then Resume: what resumeInterview puts back on a new page. */
  refresh(grantOver: Partial<GrantRow> = {}): Interview {
    const stored = wire(this.row())
    const verdict = evaluateResume(
      {
        id: SESSION_ID,
        user_id: USER,
        conversation: stored.conversation,
        engine_state: stored.engine_state,
        pending_turn: stored.pending_turn,
      },
      {
        id: 'grant-1',
        user_id: USER,
        session_id: SESSION_ID,
        turns_used: this.turnsUsed,
        completed: false,
        abandoned_at: null,
        created_at: new Date(NOW - 10 * 60_000).toISOString(),
        follow_ups_enabled: true,
        ...grantOver,
      },
      USER,
      NOW
    )
    assert.equal(verdict.resumable, true, `resume refused: ${!verdict.resumable && verdict.reason}`)
    if (!verdict.resumable) throw new Error('unreachable')
    const body = wire({ messages: verdict.messages, state: verdict.state, pendingTurn: verdict.pendingTurn })
    return new Interview(body.state, body.messages, body.pendingTurn ?? null, this.turnsUsed)
  }
}

/** Everything the follow-up policy decides with, raw and derived. */
const policy = (s: InterviewState) => ({
  version: s.followUpPolicyVersion,
  purposes: s.followUpPurposes,
  deepDiveUsed: s.deepDiveUsed,
  followUpCount: s.followUpCount,
  budgetLeft: s.followUpBudget,
  budget: s.maxFollowUpBudget,
  scenarioCap: followUpCapFor(s),
  spent: followUpsSpent(s),
  unlocked: followUpsUnlocked(s),
  actions: allowedActions(s),
})

/**
 * A state exactly as production writes it TODAY -- Phase 0 plus Resume, with
 * no Phase 2 -- so exactly what will be in flight the moment Phase 2 deploys:
 * none of the three V2 fields, and the V1 caps and budget.
 */
const V2_ONLY = ['followUpPolicyVersion', 'followUpPurposes', 'deepDiveUsed'] as const
function asWrittenBeforePhase2(state: InterviewState): InterviewState {
  const legacy: any = { ...state }
  for (const key of V2_ONLY) delete legacy[key]
  return legacy
}
function v1Interview(mode: InterviewMode): Interview {
  const initial = asWrittenBeforePhase2({
    ...createInitialState({ mode, type: 'clinical', followUpsEnabled: true }),
    maxFollowUps: MAX_FOLLOW_UPS,
    followUpBudget: FOLLOW_UP_BUDGET,
    maxFollowUpBudget: FOLLOW_UP_BUDGET,
  })
  return new Interview(initial).turn('next_primary')
}

// ==========================================================================
// Phase 2 Resume
// ==========================================================================

/** Q5 of a clinical V2 interview: one deep dive spent at Q3, one probe on Q5. */
function midInterviewV2(mode: InterviewMode = 'real') {
  return Interview.start({ mode, type: 'clinical' }) // Q1
    .turn('next_primary') // Q2
    .turn('next_primary') // Q3
    .turn('ask_follow_up', { follow_up_purpose: 'clarify' })
    .turn('ask_follow_up', { follow_up_purpose: 'mechanism' }) // the deep dive
    .turn('next_primary') // Q4
    .turn('next_primary') // Q5
    .turn('ask_follow_up', { follow_up_purpose: 'rationale' })
}

test('a V2 interview survives save → refresh → Resume with every field intact', () => {
  const live = midInterviewV2()
  const before = policy(live.state)
  assert.equal(before.version, 2)
  assert.deepEqual(before.purposes, ['clarify', 'mechanism', 'rationale'])
  assert.equal(before.deepDiveUsed, true)
  assert.equal(before.followUpCount, 1)
  assert.equal(before.budgetLeft, 2)
  assert.equal(before.spent, 3)
  assert.equal(before.unlocked, 3)

  const resumed = live.refresh()

  assert.deepEqual(resumed.state, live.state, 'the whole engine state, not only the policy fields')
  assert.deepEqual(policy(resumed.state), before)
  assert.deepEqual(resumed.messages, live.messages)
  assert.equal(resumed.pending, null)
})

test('the resumed V2 interview carries on under V2 rules, turn for turn', () => {
  const live = midInterviewV2()
  const resumed = live.refresh()
  // The same next turn on both: what the route allows next must not depend on
  // whether a refresh happened in between.
  for (const i of [live, resumed]) i.turn('next_primary').turn('next_primary') // Q7: four unlocked
  assert.deepEqual(policy(resumed.state), policy(live.state))
  assert.equal(resumed.state.followUpPolicyVersion, 2)
  assert.equal(followUpsUnlocked(resumed.state), 4)
})

// ==========================================================================
// Phase 2 Practice checkpoint
// ==========================================================================

test('a V2 Practice checkpoint survives refresh, and Continue adopts it with no model call', () => {
  const live = Interview.start({ mode: 'practice', type: 'clinical' }) // Q1
  live.turn('next_primary').continue() // Q1 reviewed, Q2 revealed
  live.turn('ask_follow_up', { follow_up_purpose: 'rationale' })
  live.turn('next_primary') // closes Q2: review shown, Q3 held back

  assert.ok(live.pending)
  const reviewed = live.state // what the row holds while the review is up
  const deferred = live.pending
  assert.equal(deferred.state.primaryQuestionNumber, reviewed.primaryQuestionNumber + 1, 'one ahead, by construction')
  assert.deepEqual(policy(deferred.state).purposes, ['rationale'])
  assert.equal(deferred.state.followUpBudget, 4)

  const resumed = live.refresh()
  assert.deepEqual(resumed.state, reviewed, 'the state the review belongs to')
  assert.deepEqual(resumed.pending, deferred, 'the paid-for question and its V2 state, whole')
  assert.deepEqual(resumed.messages, live.messages)

  resumed.continue()
  assert.equal(resumed.modelCalls, 0, 'neither Resume nor Continue generated anything')
  assert.deepEqual(resumed.state, deferred.state)
  assert.equal(resumed.messages.at(-1)?.content, deferred.message.content)

  // A second refresh lands on the adopted question with the checkpoint gone.
  const again = resumed.refresh()
  assert.equal(again.pending, null)
  assert.deepEqual(again.state, deferred.state)

  // The Continue modelled above is the page's: it reveals, it never requests.
  const page = strip(PAGE)
  const fn = page.slice(page.indexOf('const advanceFromCheckpoint'), page.indexOf('const resetInterview'))
  assert.doesNotMatch(fn, /requestTurn|fetch\(/)
  assert.match(fn, /setEngineState\(next\.state\)/)
})

test('the final V2 checkpoint keeps its policy state, and Finish adopts the report with no model call', () => {
  const live = Interview.start({ mode: 'practice', type: 'clinical' })
  for (let q = 2; q <= 10; q++) live.turn('next_primary').continue()
  live.turn('ask_follow_up', { follow_up_purpose: 'clarify' })
  live.turn('final_report', { final_report: { overall_score: 8, readiness: 'strong' } as any })

  assert.equal(live.pending?.isFinal, true)
  const resumed = live.refresh()
  assert.deepEqual(resumed.pending, live.pending)
  assert.equal(resumed.pending?.state.followUpPolicyVersion, 2)
  assert.deepEqual(resumed.pending?.state.followUpPurposes, ['clarify'])

  resumed.continue()
  assert.equal(resumed.modelCalls, 0)
  assert.equal(resumed.state.complete, true)
})

// ==========================================================================
// Follow-up budget across Resume
// ==========================================================================

test('spent, unlocked and remaining follow-ups do not reset across Resume', () => {
  const live = Interview.start({ mode: 'real', type: 'clinical' }) // Q1
    .turn('ask_follow_up', { follow_up_purpose: 'clarify' }) // 1 of 1 unlocked
    .turn('next_primary') // Q2
    .turn('next_primary') // Q3
    .turn('ask_follow_up', { follow_up_purpose: 'challenge' }) // 2 of 2 unlocked
    .turn('next_primary') // Q4: still 2 unlocked, 2 spent

  const before = policy(live.state)
  assert.equal(before.spent, 2)
  assert.equal(before.unlocked, 2)
  assert.equal(before.budgetLeft, 3)
  assert.equal(before.actions.includes('ask_follow_up'), false, 'nothing new is unlocked at Q4')

  const resumed = live.refresh()
  // A budget reset by Resume would offer a follow-up at Q4 again.
  assert.deepEqual(policy(resumed.state), before)

  // And the schedule picks up exactly where it stopped: Q5 releases the third.
  resumed.turn('next_primary')
  assert.equal(followUpsUnlocked(resumed.state), 3)
  assert.equal(followUpsSpent(resumed.state), 2)
  assert.ok(allowedActions(resumed.state).includes('ask_follow_up'))
})

test('a Mixed interview keeps one shared budget and its per-category caps across Resume', () => {
  const live = Interview.start({ mode: 'real', type: 'mixed', category: 'clinical' }) // Q1 clinical
    .turn('ask_follow_up', { follow_up_purpose: 'clarify' })
    .turn('next_primary', { category: 'behavioral' }) // Q2
    .turn('next_primary', { category: 'emotional' }) // Q3
    .turn('ask_follow_up', { follow_up_purpose: 'reflection' })

  const before = policy(live.state)
  assert.equal(before.budgetLeft, 3, 'one budget, drawn on by both categories')
  assert.deepEqual(before.purposes, ['clarify', 'reflection'])
  assert.equal(before.scenarioCap, 1, 'an emotional scenario caps at one')
  assert.equal(before.actions.includes('ask_follow_up'), false)

  const resumed = live.refresh()
  assert.deepEqual(policy(resumed.state), before)
  assert.equal(resumed.state.currentCategory, 'emotional')
  assert.deepEqual(resumed.state.categoryCounts, live.state.categoryCounts)
})

test('Resume cannot reopen spent caps: a V2 interview at its last question stays closed', () => {
  // All five follow-ups, spent at the unlock schedule's own pace.
  const live = Interview.start({ mode: 'real', type: 'clinical' })
  for (let q = 1; q <= 10; q++) {
    if (q > 1) live.turn('next_primary')
    if (q % 2 === 1) live.turn('ask_follow_up', { follow_up_purpose: 'clarify' })
  }
  assert.equal(live.state.primaryQuestionNumber, 10)
  assert.equal(live.state.followUpBudget, 0)

  const resumed = live.refresh()
  const actions = allowedActions(resumed.state)
  assert.equal(resumed.state.followUpBudget, 0)
  assert.equal(actions.includes('ask_follow_up'), false)
  assert.equal(actions.includes('next_primary'), false, 'no eleventh question')
  assert.ok(actions.includes('final_report'))
  assert.deepEqual(actions, allowedActions(live.state))
})

// ==========================================================================
// Deep-dive state across Resume
// ==========================================================================

test('a deep dive already spent is still spent after Resume', () => {
  // Two interviews, identical at Q7 -- one clarifying probe on the scenario,
  // spend well under the unlock -- except that one took its deep dive at Q3.
  const build = (deepDiveAtQ3: boolean) => {
    const i = Interview.start({ mode: 'real', type: 'clinical' })
      .turn('next_primary')
      .turn('next_primary') // Q3
      .turn('ask_follow_up', { follow_up_purpose: 'clarify' })
    if (deepDiveAtQ3) i.turn('ask_follow_up', { follow_up_purpose: 'rationale' })
    return i
      .turn('next_primary')
      .turn('next_primary')
      .turn('next_primary')
      .turn('next_primary') // Q7: four unlocked
      .turn('ask_follow_up', { follow_up_purpose: 'clarify' })
  }
  const spent = build(true)
  const available = build(false)

  // Nothing but the deep-dive flag stands between the two.
  for (const i of [spent, available]) {
    assert.ok(followUpsSpent(i.state) < followUpsUnlocked(i.state), 'budget is not the blocker')
    assert.ok(i.state.followUpCount < followUpCapFor(i.state), 'the scenario cap is not the blocker')
  }
  assert.equal(spent.state.deepDiveUsed, true)
  assert.equal(allowedActions(spent.state).includes('ask_follow_up'), false)
  assert.equal(available.state.deepDiveUsed, false)
  assert.ok(allowedActions(available.state).includes('ask_follow_up'))

  const spentResumed = spent.refresh()
  const availableResumed = available.refresh()
  assert.equal(spentResumed.state.deepDiveUsed, true, 'Resume did not hand the deep dive back')
  assert.equal(allowedActions(spentResumed.state).includes('ask_follow_up'), false)
  assert.equal(availableResumed.state.deepDiveUsed, false)
  assert.ok(allowedActions(availableResumed.state).includes('ask_follow_up'), 'nor did it take one away')
})

// ==========================================================================
// Legacy V1 Resume compatibility
// ==========================================================================

test('a V1 interview in flight at deploy resumes under V1 rules, never promoted to V2', () => {
  // V1 has no unlock schedule: three probes on Q1 is legal there, and
  // impossible under V2 (one unlocked at Q1, and a cap of two).
  const live = v1Interview('real')
    .turn('ask_follow_up')
    .turn('ask_follow_up')
    .turn('ask_follow_up')
    .turn('next_primary') // Q2
  live.state = asWrittenBeforePhase2(live.state)
  assert.equal('followUpPolicyVersion' in live.state, false, 'fixture matches what production stores today')

  const resumed = live.refresh()
  assert.deepEqual(
    resumed.state,
    { ...live.state, followUpPolicyVersion: 1, followUpPurposes: [], deepDiveUsed: false },
    'read as V1; every other field exactly as stored'
  )
  const v1 = policy(resumed.state)
  assert.equal(v1.budget, FOLLOW_UP_BUDGET)
  assert.equal(v1.budgetLeft, FOLLOW_UP_BUDGET - 3)
  assert.equal(resumed.state.maxFollowUps, MAX_FOLLOW_UPS)
  // The discriminating fact: V1 still offers a follow-up at Q2; the same
  // numbers under V2 would refuse it on the unlock schedule.
  assert.ok(v1.actions.includes('ask_follow_up'))
  assert.equal(allowedActions({ ...resumed.state, followUpPolicyVersion: 2 }).includes('ask_follow_up'), false)

  // It stays V1 through the next turn, and once the field is written explicitly.
  resumed.turn('ask_follow_up')
  assert.equal(resumed.state.followUpPolicyVersion, 1)
  assert.deepEqual(resumed.state.followUpPurposes, [])
  assert.equal(resumed.refresh().state.followUpPolicyVersion, 1)
})

test('V2-looking data inside a V1 state is ignored, not used to promote it', () => {
  const live = v1Interview('real').turn('next_primary')
  live.state = { ...asWrittenBeforePhase2(live.state), deepDiveUsed: true, followUpPurposes: ['clarify'] } as any

  const resumed = live.refresh()
  assert.equal(resumed.state.followUpPolicyVersion, 1)
  assert.equal(resumed.state.deepDiveUsed, false)
  assert.deepEqual(resumed.state.followUpPurposes, [])
})

test('a V1 Practice checkpoint resumes as V1, and Continue keeps it V1', () => {
  const live = v1Interview('practice').turn('ask_follow_up').turn('next_primary') // closes Q1
  assert.ok(live.pending)
  live.state = asWrittenBeforePhase2(live.state)
  live.pending = { ...live.pending, state: asWrittenBeforePhase2(live.pending.state) }

  const resumed = live.refresh()
  assert.equal(resumed.state.followUpPolicyVersion, 1)
  assert.equal(resumed.pending?.state.followUpPolicyVersion, 1)
  assert.equal(resumed.pending?.state.maxFollowUpBudget, FOLLOW_UP_BUDGET)
  assert.equal(resumed.pending?.state.followUpBudget, FOLLOW_UP_BUDGET - 1)

  resumed.continue()
  assert.equal(resumed.modelCalls, 0)
  assert.equal(resumed.state.followUpPolicyVersion, 1)
})

// ==========================================================================
// Grant authority over a V2 state
// ==========================================================================

test('the grant still owns the follow-up setting, without disturbing any V2 policy state', () => {
  const live = midInterviewV2()

  const off = live.refresh({ follow_ups_enabled: false })
  assert.deepEqual(off.state, { ...live.state, followUpsEnabled: false }, 'only the field the grant owns moved')
  assert.equal(followUpCapFor(off.state), 0)
  assert.equal(allowedActions(off.state).includes('ask_follow_up'), false)

  assert.deepEqual(live.refresh({ follow_ups_enabled: true }).state, live.state)
})
