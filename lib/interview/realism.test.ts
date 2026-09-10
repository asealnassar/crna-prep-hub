import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  allowedActions,
  applyTurn,
  canReprompt,
  createInitialState,
  normalizeState,
  MAX_PRIMARY_QUESTIONS,
  MAX_REPROMPTS,
  MAX_REPROMPTS_PER_INTERVIEW,
  FOLLOW_UP_BUDGET,
} from './state.ts'
import { buildSystemPrompt } from './prompt.ts'
import { buildTurnSchema } from './schema.ts'
import type { InterviewState, ModelTurn, TurnAction } from './types.ts'

/**
 * Realism pass: focused primary questions, and one neutral nudge when the
 * applicant does not answer.
 *
 * Two separate defects. Questions arrived as checklists -- "what receptors,
 * what it does to BP and HR, a starting dose, and what you're monitoring" --
 * which is four interview questions wearing one coat. And Real mode treated
 * "unsure" as a completed answer and moved straight to a new scenario, which
 * no interviewer does.
 *
 * The reprompt is deliberately its OWN action rather than a follow-up. A
 * follow-up means "you answered, now go deeper" and is budgeted and subject to
 * the applicant's setup choice; a reprompt means "you have not answered yet"
 * and must survive followUpsEnabled = false without touching any budget.
 * Faking it with ask_follow_up would have violated all four of those.
 */

const PROMPT_SRC = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8')

const base = (over: Partial<InterviewState> = {}): InterviewState => ({
  ...createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true }),
  primaryQuestionNumber: 2,
  currentCategory: 'clinical',
  currentScenario: 'scenario 2',
  turnKind: 'primary',
  ...over,
})

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

const promptFor = (state: InterviewState) =>
  buildSystemPrompt(state, { recentQuestions: [], seed: 'seed' })
const actionEnum = (state: InterviewState) =>
  (buildTurnSchema(state).schema as any).properties.action.enum as string[]

// ==========================================================================
// 1-4. Primary questions carry ONE central ask
// ==========================================================================

test('the rule separates detailed context from a focused ask', () => {
  const p = promptFor(base())
  assert.match(p, /ONE CENTRAL ASK/)
  assert.match(p, /The context may be as detailed as the scenario needs/)
  assert.match(p, /The ask that follows it should be one thing/)
})

test('the pharmacology checklist shape is named and forbidden', () => {
  const p = promptFor(base())
  // The exact bad question from the report, given as a counter-example.
  assert.match(p, /Bad:\s+"Tell me about norepinephrine: what receptors it works on/)
  assert.match(p, /Good:\s+"Tell me what you know about norepinephrine\."/)
  assert.match(p, /Never build a primary question as a list of asks/)
  assert.match(p, /define X, explain the mechanism, give the dosing, list the side effects/)
})

test('the MAP checklist shape is named and forbidden', () => {
  assert.match(
    promptFor(base()),
    /Bad:\s+"What are the determinants of MAP, how can you raise it, what drugs would you use, and what are you monitoring\?"/
  )
})

test('a clinical scenario may keep rich context with a single ask', () => {
  const p = promptFor(base())
  assert.match(p, /You are caring for an intubated patient on volume control/)
  assert.match(p, /What are you going to do in the next one to two minutes\?/)
  // And the multi-part version of the same scenario is the counter-example.
  assert.match(p, /list five causes, tell me how you would troubleshoot each one/)
})

test('the format guides are labelled as territory, not question templates', () => {
  // Root cause: "pharmacology — indication, dose, receptor, mechanism, onset
  // and offset, interactions" reads as a list of things to ask in one breath.
  const p = promptFor(base())
  assert.match(p, /is the TERRITORY that format covers, not a set of things to ask in one breath/)
  assert.match(p, /Asking for all six at once is the checklist failure/)
})

test('the rule is not a licence to be vague', () => {
  assert.match(promptFor(base()), /This is not a licence to be vague/)
  assert.match(promptFor(base()), /Keep the context rich and the ask singular/)
})

test('followUpsEnabled=false does not license bloated primary questions', () => {
  const off = promptFor(base({ followUpsEnabled: false }))
  assert.match(off, /Do NOT compensate by widening the primary questions/)
  assert.match(off, /asked exactly as focused as it would be in any other interview/)
  assert.match(off, /ONE CENTRAL ASK/, 'and the general rule still applies')
})

test('followUpsEnabled=true still starts from a focused primary question', () => {
  const on = promptFor(base({ followUpsEnabled: true }))
  assert.match(on, /ONE CENTRAL ASK/)
  assert.match(on, /FOLLOW-UP DOCTRINE/, 'depth comes from follow-ups, not from a wider question')
  assert.doesNotMatch(on, /Do NOT compensate by widening/, 'that line is for the no-follow-up case')
})

test('the rule reaches every interview type', () => {
  // QUESTION_STYLE is unconditional, so Clinical, EI, Mixed and Custom all get it.
  for (const type of ['clinical', 'emotional', 'mixed', 'custom'] as const) {
    for (const followUpsEnabled of [true, false]) {
      const s = { ...base({ followUpsEnabled }), type }
      assert.match(promptFor(s), /ONE CENTRAL ASK/, `${type}/${followUpsEnabled}`)
    }
  }
  assert.match(PROMPT_SRC, /parts\.push\(`=== QUESTION STYLE ===/, 'injected on every turn')
})

test('the behavioural example is a single ask too', () => {
  assert.match(promptFor(base()), /Good:\s+"Tell me about a time you disagreed with a provider\."/)
})

// ==========================================================================
// 5-8, 15. The reprompt exists and is offered
// ==========================================================================

test('Real mode offers a neutral reprompt on the question in play', () => {
  const s = base({ mode: 'real' })
  assert.equal(canReprompt(s), true)
  assert.ok(allowedActions(s).includes('reprompt_current'))
  assert.ok(actionEnum(s).includes('reprompt_current'), 'and the model can actually pick it')
})

test('the doctrine names the clear non-answers', () => {
  const p = promptFor(base({ mode: 'real' }))
  assert.match(p, /IF THEY DID NOT ANSWER/)
  for (const phrase of ['I don\'t know', 'unsure', 'no idea']) {
    assert.ok(p.includes(phrase), `names ${phrase}`)
  }
  assert.match(p, /asking YOU for the answer: "what do you think\?", "what would you do\?", "you tell me"/)
  assert.match(p, /a reply with no relationship to the question asked/)
  assert.match(p, /an obvious refusal to engage/)
})

test('a wrong or incomplete answer is explicitly NOT a non-answer', () => {
  const p = promptFor(base({ mode: 'real' }))
  assert.match(p, /wrong — a confidently incorrect answer is an ANSWER/)
  assert.match(p, /incomplete — they gave you part of it\. That is an answer\./)
  assert.match(p, /brief — two accurate sentences can be a complete answer/)
  assert.match(p, /weak, disorganised, or poorly reasoned — all answers/)
  assert.match(p, /This is not a correctness detector/)
  assert.match(p, /When you are unsure whether it was a non-answer, it was an answer: move on/)
})

test('the reprompt gives no coaching, answer, feedback or score', () => {
  const p = promptFor(base({ mode: 'real' }))
  assert.match(p, /give no part of the answer, no hint toward it, and no teaching/)
  assert.match(p, /no feedback, no verdict, no indication of whether anything they said was right/)
  assert.match(p, /never mention scoring/)
  assert.match(p, /\(that is the answer\)/, 'a leaking example is shown as Bad')
  assert.match(p, /\(that is feedback\)/)
})

test('a reprompt turn can carry no evaluation', () => {
  const route = readFileSync(new URL('../../app/api/interview/route.ts', import.meta.url), 'utf8')
  assert.match(route, /action === 'ask_follow_up' \|\| action === 'reprompt_current'\s*\?\s*null/)
  // And the state machine banks nothing either.
  const after = applyTurn(base({ mode: 'real' }), turn('reprompt_current', { evaluation: { overall_score: 3 } as any }))
  assert.equal(after.evaluations.length, 0)
})

// ==========================================================================
// 12-14. A reprompt moves nothing it should not
// ==========================================================================

test('a reprompt does not increment the primary question number', () => {
  const before = base({ mode: 'real' })
  const after = applyTurn(before, turn('reprompt_current'))
  assert.equal(after.primaryQuestionNumber, before.primaryQuestionNumber)
  assert.equal(after.turnKind, 'reprompt')
})

test('a reprompt does not increment followUpCount', () => {
  const before = base({ mode: 'real', followUpCount: 1 })
  assert.equal(applyTurn(before, turn('reprompt_current')).followUpCount, 1)
})

test('a reprompt does not consume the interview follow-up budget', () => {
  const before = base({ mode: 'real', followUpBudget: FOLLOW_UP_BUDGET })
  const after = applyTurn(before, turn('reprompt_current'))
  assert.equal(after.followUpBudget, FOLLOW_UP_BUDGET)
  assert.equal(after.maxFollowUpBudget, before.maxFollowUpBudget)
})

test('a reprompt changes exactly one counter and nothing else', () => {
  const before = base({ mode: 'real' })
  const after = applyTurn(before, turn('reprompt_current', { difficulty_level: 5, question_format: 'pharmacology' }))
  assert.equal(after.repromptCount, 1)
  assert.equal(after.difficultyLevel, before.difficultyLevel, 'the asked question has not changed')
  assert.deepEqual(after.askedFormats, before.askedFormats, 'no format is consumed')
  assert.deepEqual(after.askedPrimaryQuestions, before.askedPrimaryQuestions)
  assert.deepEqual(after.categoryCounts, before.categoryCounts)
  assert.equal(after.complete, false)
})

test('a reprompt works when the applicant declined follow-ups', () => {
  const s = base({ mode: 'real', followUpsEnabled: false })
  const actions = allowedActions(s)
  assert.ok(actions.includes('reprompt_current'), 'still offered')
  assert.ok(!actions.includes('ask_follow_up'), 'while follow-ups stay impossible')
  assert.deepEqual(actionEnum(s), ['reprompt_current', 'next_primary'])
  const after = applyTurn(s, turn('reprompt_current'))
  assert.equal(after.repromptCount, 1)
  assert.equal(after.followUpBudget, s.followUpBudget)
})

test('a reprompt works when the applicant accepted follow-ups, without spending one', () => {
  const s = base({ mode: 'real', followUpsEnabled: true })
  assert.deepEqual(allowedActions(s), ['reprompt_current', 'ask_follow_up', 'next_primary'])
  const after = applyTurn(s, turn('reprompt_current'))
  assert.equal(after.followUpBudget, s.followUpBudget, 'budget untouched')
  assert.equal(after.maxFollowUpBudget, s.maxFollowUpBudget)
  // The follow-up is not spent -- it is merely unavailable on the one turn that
  // closes out the reprompted scenario, and returns with the next question.
  const nextScenario = applyTurn(after, turn('next_primary'))
  assert.equal(nextScenario.followUpBudget, s.followUpBudget, 'still unspent')
  assert.ok(allowedActions(nextScenario).includes('ask_follow_up'), 'and available again')
})

// ==========================================================================
// 16. One reprompt per scenario, no loops
// ==========================================================================

test('the allowance is one per scenario', () => {
  assert.equal(MAX_REPROMPTS, 1)
  const spent = applyTurn(base({ mode: 'real' }), turn('reprompt_current'))
  assert.equal(canReprompt(spent), false)
  assert.ok(!allowedActions(spent).includes('reprompt_current'))
  assert.ok(!actionEnum(spent).includes('reprompt_current'), 'the model cannot pick it again')
})

test('a second non-answer moves on instead of looping', () => {
  let s = base({ mode: 'real', followUpsEnabled: false })
  s = applyTurn(s, turn('reprompt_current'))          // first non-answer -> nudge
  assert.deepEqual(allowedActions(s), ['next_primary'], 'only moving on is left')
  const closed = applyTurn(s, turn('next_primary', { evaluation: { overall_score: 2 } as any }))
  assert.equal(closed.primaryQuestionNumber, 3)
  assert.equal(closed.evaluations.length, 1, 'the non-answer is scored, not skipped')
})

test('a follow-up cannot be used as a second reprompt', () => {
  // Observed live before this gate existed: with the reprompt spent but a
  // follow-up still available, the model pressed again through ask_follow_up
  // and charged it to the follow-up budget.
  const s = base({ mode: 'real', followUpsEnabled: true, followUpBudget: 8 })
  const afterNudge = applyTurn(s, turn('reprompt_current'))
  assert.equal(afterNudge.turnKind, 'reprompt')
  const actions = allowedActions(afterNudge)
  assert.ok(!actions.includes('ask_follow_up'), 'no follow-up on the closing turn')
  assert.ok(!actions.includes('reprompt_current'), 'and no second reprompt')
  assert.deepEqual(actions, ['next_primary'])
  assert.ok(!actionEnum(afterNudge).includes('ask_follow_up'), 'the model cannot pick one')
})

test('the closing turn restriction lasts exactly one turn', () => {
  // A scenario that was never reprompted keeps its follow-up as normal.
  const clean = base({ mode: 'real', followUpsEnabled: true })
  assert.ok(allowedActions(clean).includes('ask_follow_up'))
  // And the next scenario is unaffected by the previous one's reprompt.
  const afterNudge = applyTurn(clean, turn('reprompt_current'))
  const nextScenario = applyTurn(afterNudge, turn('next_primary'))
  assert.equal(nextScenario.turnKind, 'primary')
  assert.equal(nextScenario.repromptCount, 0)
  assert.ok(allowedActions(nextScenario).includes('ask_follow_up'), 'follow-ups return')
  assert.ok(allowedActions(nextScenario).includes('reprompt_current'), 'so does the nudge')
})

test('the prompt says the next reply is their answer', () => {
  const p = promptFor(base({ mode: 'real' }))
  assert.match(p, /After one reprompt, whatever they say next is their answer for this scenario/)
  assert.match(p, /Two non-answers is itself information/)
  // And the state block says so once it is spent.
  const spent = promptFor(base({ mode: 'real', repromptCount: 1 }))
  assert.match(spent, /1 of 1, with \d+ left for the whole interview \(none available — their next reply is their answer\)/)
  assert.doesNotMatch(spent, /IF THEY DID NOT ANSWER/, 'the doctrine is withdrawn with the action')
})

test('the allowance returns with the next scenario, not the next interview', () => {
  const spent = applyTurn(base({ mode: 'real' }), turn('reprompt_current'))
  const nextQ = applyTurn(spent, turn('next_primary'))
  assert.equal(nextQ.repromptCount, 0)
  assert.equal(canReprompt(nextQ), true)
})

// ==========================================================================
// 17. A reprompt is not a follow-up
// ==========================================================================

test('reprompt and follow-up are distinct actions with distinct effects', () => {
  const s = base({ mode: 'real', followUpsEnabled: true })
  const reprompted = applyTurn(s, turn('reprompt_current'))
  const probed = applyTurn(s, turn('ask_follow_up'))

  assert.equal(reprompted.turnKind, 'reprompt')
  assert.equal(probed.turnKind, 'follow_up')
  assert.equal(reprompted.followUpCount, 0)
  assert.equal(probed.followUpCount, 1)
  assert.equal(reprompted.followUpBudget, s.followUpBudget)
  assert.equal(probed.followUpBudget, s.followUpBudget - 1)
  assert.equal(reprompted.repromptCount, 1)
  assert.equal(probed.repromptCount, 0)
})

test('the follow-up gates never gate the reprompt', () => {
  // Budget exhausted and the per-scenario cap spent: a follow-up is impossible,
  // a reprompt is not.
  const s = base({ mode: 'real', followUpsEnabled: true, followUpBudget: 0, followUpCount: 3 })
  const actions = allowedActions(s)
  assert.ok(!actions.includes('ask_follow_up'))
  assert.ok(actions.includes('reprompt_current'))
})

test('the two doctrines are injected independently', () => {
  const bothOff = promptFor(base({ mode: 'practice', followUpsEnabled: false }))
  assert.doesNotMatch(bothOff, /FOLLOW-UP DOCTRINE/)
  assert.doesNotMatch(bothOff, /IF THEY DID NOT ANSWER/)

  const followUpOnly = promptFor(base({ mode: 'practice', followUpsEnabled: true }))
  assert.match(followUpOnly, /FOLLOW-UP DOCTRINE/)
  assert.doesNotMatch(followUpOnly, /IF THEY DID NOT ANSWER/)

  const repromptOnly = promptFor(base({ mode: 'real', followUpsEnabled: false }))
  assert.doesNotMatch(repromptOnly, /FOLLOW-UP DOCTRINE/)
  assert.match(repromptOnly, /IF THEY DID NOT ANSWER/)

  const both = promptFor(base({ mode: 'real', followUpsEnabled: true }))
  assert.match(both, /FOLLOW-UP DOCTRINE/)
  assert.match(both, /IF THEY DID NOT ANSWER/)
})

// ==========================================================================
// 18-20. Nothing else moved
// ==========================================================================

test('Practice mode is untouched: no reprompt action, no reprompt doctrine', () => {
  for (const followUpsEnabled of [true, false]) {
    const s = base({ mode: 'practice', followUpsEnabled })
    assert.equal(canReprompt(s), false)
    assert.ok(!allowedActions(s).includes('reprompt_current'))
    assert.ok(!actionEnum(s).includes('reprompt_current'))
    assert.doesNotMatch(promptFor(s), /IF THEY DID NOT ANSWER/)
  }
})

test('the Practice reprompt counter line is absent, not shown as spent', () => {
  assert.doesNotMatch(promptFor(base({ mode: 'practice' })), /Neutral reprompts used/)
  assert.match(promptFor(base({ mode: 'real' })), /Neutral reprompts used on the current scenario: 0 of 1/)
})

test('the Practice feedback checkpoint is unaffected', () => {
  // The checkpoint keys on an evaluation arriving; a reprompt carries none and
  // cannot occur in Practice anyway.
  const page = readFileSync(new URL('../../app/interview/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /const checkpoint = practice && Boolean\(data\.evaluation\) && deferrable/)
  assert.match(page, /Continue to Next Question/)
  assert.match(page, /Finish Interview/)
})

test('Real mode still shows no feedback between questions', () => {
  const route = readFileSync(new URL('../../app/api/interview/route.ts', import.meta.url), 'utf8')
  assert.match(route, /evaluation: practice \? turn\.evaluation : null/)
  assert.match(route, /withheldReviews: !practice && nextState\.complete \? nextState\.evaluations : \[\]/)
})

test('the configured primary count is unchanged, reprompts and all', () => {
  let s = createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true })
  s = applyTurn(s, turn('next_primary'))
  let primaries = 1
  let reprompts = 0
  for (let i = 0; i < 120 && !s.complete; i++) {
    const actions = allowedActions(s)
    // Non-answer on every scenario, then a real answer.
    if (actions.includes('reprompt_current')) {
      s = applyTurn(s, turn('reprompt_current'))
      reprompts++
      continue
    }
    if (actions.includes('final_report')) { s = applyTurn(s, turn('final_report')); break }
    s = applyTurn(s, turn('next_primary'))
    primaries++
  }
  assert.equal(primaries, MAX_PRIMARY_QUESTIONS, 'still exactly 10 primary questions')
  // Not one per scenario any more: the interview-wide budget stops at four,
  // which is what keeps the worst case inside the database turn ceiling.
  assert.equal(reprompts, MAX_REPROMPTS_PER_INTERVIEW, 'four nudges across the interview')
  assert.equal(s.repromptBudget, 0)
  assert.equal(s.complete, true)
})

test('the opening turn can only ask Q1 — never a reprompt', () => {
  const opening = createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true })
  assert.equal(canReprompt(opening), false)
  assert.deepEqual(allowedActions(opening), ['next_primary'])
})

test('a completed interview offers no reprompt', () => {
  const done = base({ mode: 'real', complete: true })
  assert.equal(canReprompt(done), false)
  assert.deepEqual(allowedActions(done), ['final_report'])
})

test('a state predating repromptCount reads as unspent and is clamped', () => {
  const legacy: any = { ...base({ mode: 'real' }) }
  delete legacy.repromptCount
  const restored = normalizeState(legacy, base({ mode: 'real' }))
  assert.equal(restored.repromptCount, 0, 'an older session has spent none')
  assert.equal(canReprompt(restored), true, 'worst case is one extra neutral nudge, never a loop')

  // And a client cannot hand itself extra reprompts.
  for (const bogus of [99, -5, 'lots', null, {}]) {
    const raw: any = { ...base({ mode: 'real' }), repromptCount: bogus }
    const r = normalizeState(raw, base({ mode: 'real' }))
    assert.ok(r.repromptCount >= 0 && r.repromptCount <= MAX_REPROMPTS, `clamped for ${String(bogus)}`)
  }
  const tampered = normalizeState({ ...base({ mode: 'real' }), repromptCount: 99 } as any, base({ mode: 'real' }))
  assert.equal(tampered.repromptCount, MAX_REPROMPTS)
  assert.equal(canReprompt(tampered), false, 'and cannot mint itself another')
})

test('a restored reprompt state keeps its spent allowance', () => {
  const restored = normalizeState({ ...base({ mode: 'real' }), repromptCount: 1, turnKind: 'reprompt' } as any,
    base({ mode: 'real' }))
  assert.equal(restored.repromptCount, 1)
  assert.equal(restored.turnKind, 'reprompt', 'the new turn kind survives normalization')
  assert.equal(canReprompt(restored), false)
})

// ==========================================================================
// Interview-wide reprompt budget
//
// The per-scenario allowance alone was not enough: ten scenarios x one nudge
// is ten extra model calls, and consume_interview_turn() refuses the 25th.
// A second, non-resetting budget keeps the worst case inside the ceiling the
// database already enforces, so no migration is needed.
// ==========================================================================

test('the budget is four and does not reset between questions', () => {
  assert.equal(MAX_REPROMPTS_PER_INTERVIEW, 4)
  const s = createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true })
  assert.equal(s.repromptBudget, 4)
  assert.equal(s.maxRepromptBudget, 4)

  const spent = applyTurn(base({ mode: 'real' }), turn('reprompt_current'))
  assert.equal(spent.repromptBudget, 3)
  const nextScenario = applyTurn(spent, turn('next_primary'))
  assert.equal(nextScenario.repromptCount, 0, 'the per-scenario allowance returns')
  assert.equal(nextScenario.repromptBudget, 3, 'the interview-wide budget does NOT')
})

test('the first four eligible non-answers may be reprompted, the fifth may not', () => {
  let s = base({ mode: 'real', followUpsEnabled: false })
  const spentAt: number[] = []
  for (let scenario = 0; scenario < 8; scenario++) {
    if (canReprompt(s)) {
      s = applyTurn(s, turn('reprompt_current'))
      spentAt.push(scenario)
    }
    // Whatever happened, the scenario closes and the next question is asked.
    s = applyTurn(s, turn('next_primary'))
  }
  assert.deepEqual(spentAt, [0, 1, 2, 3], 'four nudges, then none')
  assert.equal(s.repromptBudget, 0)
  assert.equal(canReprompt(s), false, 'the fifth is refused')
})

test('an exhausted budget removes the action from the schema entirely', () => {
  const s = base({ mode: 'real', repromptBudget: 0 })
  assert.equal(canReprompt(s), false)
  assert.ok(!allowedActions(s).includes('reprompt_current'))
  assert.ok(!actionEnum(s).includes('reprompt_current'), 'the model cannot pick it')
})

test('both gates must pass, independently', () => {
  // Scenario allowance spent, budget healthy.
  assert.equal(canReprompt(base({ mode: 'real', repromptCount: 1, repromptBudget: 4 })), false)
  // Budget spent, scenario allowance fresh.
  assert.equal(canReprompt(base({ mode: 'real', repromptCount: 0, repromptBudget: 0 })), false)
  // Both available.
  assert.equal(canReprompt(base({ mode: 'real', repromptCount: 0, repromptBudget: 1 })), true)
})

test('an exhausted budget is told not to substitute a follow-up', () => {
  const p = promptFor(base({ mode: 'real', repromptBudget: 0, followUpsEnabled: true }))
  assert.doesNotMatch(p, /IF THEY DID NOT ANSWER/, 'the doctrine goes with the action')
  assert.match(p, /You have no neutral reprompts left/)
  assert.match(p, /do NOT reach for "ask_follow_up" to press them again/)
  // Not shown when there is no follow-up to misuse, nor while nudges remain.
  assert.doesNotMatch(
    promptFor(base({ mode: 'real', repromptBudget: 0, followUpsEnabled: false })),
    /do NOT reach for "ask_follow_up"/
  )
  assert.doesNotMatch(promptFor(base({ mode: 'real' })), /do NOT reach for "ask_follow_up"/)
  assert.doesNotMatch(promptFor(base({ mode: 'practice' })), /do NOT reach for "ask_follow_up"/)
})

test('reprompts never touch the follow-up budget, however many are spent', () => {
  let s = base({ mode: 'real', followUpsEnabled: true })
  const startFollowUp = s.followUpBudget
  for (let i = 0; i < MAX_REPROMPTS_PER_INTERVIEW; i++) {
    s = applyTurn(s, turn('reprompt_current'))
    s = applyTurn(s, turn('next_primary'))
  }
  assert.equal(s.repromptBudget, 0)
  assert.equal(s.followUpBudget, startFollowUp, 'follow-up budget untouched')
  assert.equal(s.maxFollowUpBudget, FOLLOW_UP_BUDGET)
})

test('followUpsEnabled=false still permits nudges until the budget runs out', () => {
  let s = base({ mode: 'real', followUpsEnabled: false })
  let nudges = 0
  for (let i = 0; i < 8; i++) {
    if (canReprompt(s)) { s = applyTurn(s, turn('reprompt_current')); nudges++ }
    s = applyTurn(s, turn('next_primary'))
    assert.ok(!allowedActions(s).includes('ask_follow_up'), 'follow-ups stay impossible throughout')
  }
  assert.equal(nudges, MAX_REPROMPTS_PER_INTERVIEW)
})

test('the state block reports the interview-wide budget', () => {
  assert.match(promptFor(base({ mode: 'real' })), /0 of 1, with 4 left for the whole interview/)
  assert.match(
    promptFor(base({ mode: 'real', repromptBudget: 0 })),
    /with 0 left for the whole interview \(none available — their next reply is their answer\)/
  )
  assert.match(promptFor(base({ mode: 'real' })), /a small fixed number of reprompts for the entire interview/)
})

test('a client cannot mint itself extra reprompts', () => {
  const tampered = normalizeState(
    { ...base({ mode: 'real' }), repromptBudget: 999, maxRepromptBudget: 999 } as any,
    base({ mode: 'real' })
  )
  assert.equal(tampered.maxRepromptBudget, MAX_REPROMPTS_PER_INTERVIEW)
  assert.equal(tampered.repromptBudget, MAX_REPROMPTS_PER_INTERVIEW)
})

test('a state predating the budget starts with a full one', () => {
  const legacy: any = { ...base({ mode: 'real' }) }
  delete legacy.repromptBudget
  delete legacy.maxRepromptBudget
  const restored = normalizeState(legacy, base({ mode: 'real' }))
  assert.equal(restored.repromptBudget, MAX_REPROMPTS_PER_INTERVIEW)
  assert.equal(canReprompt(restored), true)
})

// ---------------------------------------------- the turn ceiling, proved

test('the worst case fits inside the database turn ceiling, with margin', () => {
  // MAX_TURNS_PER_INTERVIEW lives in lib/interviewSession.ts, which imports via
  // the "@/" alias Node's test runner cannot resolve -- so the ceiling is read
  // from source rather than imported. Both halves are asserted: the TypeScript
  // definition and the SQL literal it mirrors.
  const session = readFileSync(new URL('../interviewSession.ts', import.meta.url), 'utf8')
  assert.match(
    session,
    /export const MAX_TURNS_PER_INTERVIEW = MAX_PRIMARY_QUESTIONS \+ FOLLOW_UP_BUDGET \+ 6/,
    'the formula is unchanged'
  )
  const ceiling = MAX_PRIMARY_QUESTIONS + FOLLOW_UP_BUDGET + 6
  assert.equal(ceiling, 24)

  const OPENING = 1
  const preExisting = OPENING + MAX_PRIMARY_QUESTIONS + FOLLOW_UP_BUDGET
  const worst = preExisting + MAX_REPROMPTS_PER_INTERVIEW
  assert.equal(preExisting, 19, '1 opening + 10 primary answers + 8 follow-ups')
  assert.equal(worst, 23, 'plus 4 neutral reprompts')
  assert.ok(worst <= ceiling, `${worst} must fit inside ${ceiling}`)
  assert.equal(ceiling - worst, 1, 'exactly one turn of margin')
})

test('the SQL literal the ceiling mirrors is untouched', () => {
  // consume_interview_turn() hardcodes 24 and cannot import the constant. If
  // the two ever disagree the database wins and an interview is cut off.
  const sql = readFileSync(
    new URL('../../supabase/migrations/20260830_002_interview_grants.sql', import.meta.url),
    'utf8'
  )
  assert.match(sql, /and coalesce\(turns_used, 0\) < 24/, 'still 24')
})

test('no migration was added or altered for the reprompt budget', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url)
  const names = readdirSync(dir).sort()
  // Nothing in the migration set mentions reprompts at all.
  for (const name of names) {
    const body = readFileSync(new URL(name, dir), 'utf8')
    assert.doesNotMatch(body, /reprompt/i, `${name} must not mention reprompts`)
  }
  assert.ok(names.includes('20260830_002_interview_grants.sql'))
  assert.ok(names.includes('20260909_001_interview_grants_follow_ups.sql'))
})
