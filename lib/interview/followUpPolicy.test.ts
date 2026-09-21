import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  allowedActions,
  applyTurn,
  createInitialState,
  followUpCapFor,
  followUpsSpent,
  followUpsUnlocked,
  normalizeState,
  purposesFor,
  FOLLOW_UP_BUDGET,
  MAX_FOLLOW_UPS,
  MAX_PRIMARY_QUESTIONS,
  MAX_REPROMPTS_PER_INTERVIEW,
  V2_FOLLOW_UP_BUDGET,
  V2_MAX_FOLLOW_UPS,
  V2_MAX_FOLLOW_UPS_EMOTIONAL,
} from './state.ts'
import { buildTurnSchema } from './schema.ts'
import { buildSystemPrompt } from './prompt.ts'
import type { InterviewState, ModelTurn, QuestionCategory, TurnAction } from './types.ts'

/**
 * Phase 2 follow-up policy.
 *
 * Production ran the V1 budget to exhaustion: a nominal ten-question interview
 * became roughly seventeen interviewer questions, the probing was front-loaded
 * because the whole budget was available at question 1, and a STRONG answer
 * was an explicit licence to ask something harder -- which punished the
 * applicants who did well.
 *
 * V2 answers each of those structurally rather than by asking the model
 * nicely, because Phase 1 demonstrated that prompt guidance alone does not
 * reliably change behaviour:
 *   - budget 8 -> 5, per-scenario caps 3/2 -> 2/1
 *   - the budget unlocks across the interview instead of being available at Q1
 *   - exactly one scenario per interview may take a second follow-up
 *   - every follow-up declares a purpose, narrowed by category in the schema
 *
 * And it is VERSIONED: an interview that started under V1 finishes under V1.
 */

const PROMPT_SRC = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8')
const STATE_SRC = readFileSync(new URL('./state.ts', import.meta.url), 'utf8')

const v2 = (over: Partial<InterviewState> = {}): InterviewState => ({
  ...createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true }),
  primaryQuestionNumber: 1,
  currentCategory: 'clinical',
  currentScenario: 'scenario 1',
  turnKind: 'primary',
  ...over,
})

/** A pre-Phase-2 session, exactly as one would deserialize from storage. */
const v1 = (over: Partial<InterviewState> = {}): InterviewState => ({
  ...v2(),
  followUpPolicyVersion: 1,
  maxFollowUps: MAX_FOLLOW_UPS,
  followUpBudget: FOLLOW_UP_BUDGET,
  maxFollowUpBudget: FOLLOW_UP_BUDGET,
  followUpPurposes: [],
  deepDiveUsed: false,
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
  follow_up_purpose: null,
  evaluation: null,
  final_report: null,
  internal_note: '',
  ...over,
})

const canFollowUp = (s: InterviewState) => allowedActions(s).includes('ask_follow_up')
const actionEnum = (s: InterviewState) => (buildTurnSchema(s).schema as any).properties.action.enum as string[]
const purposeField = (s: InterviewState) =>
  (buildTurnSchema(s).schema as any).properties.follow_up_purpose
const promptFor = (s: InterviewState) => buildSystemPrompt(s, { recentQuestions: [], seed: 'seed' })

// ==========================================================================
// 1. Versioning
// ==========================================================================

test('a state with no policy version normalizes to V1', () => {
  const legacy: any = { ...v1(), followUpBudget: 6 }
  delete legacy.followUpPolicyVersion
  delete legacy.followUpPurposes
  delete legacy.deepDiveUsed
  const restored = normalizeState(legacy, createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true }))
  assert.equal(restored.followUpPolicyVersion, 1, 'absence is the signal')
  assert.deepEqual(restored.followUpPurposes, [])
  assert.equal(restored.deepDiveUsed, false)
})

test('an existing V1 session stays V1 through a round trip', () => {
  const live = applyTurn(v1({ primaryQuestionNumber: 3 }), turn('ask_follow_up'))
  const restored = normalizeState(JSON.parse(JSON.stringify(live)), v2())
  assert.equal(restored.followUpPolicyVersion, 1)
  assert.equal(restored.maxFollowUpBudget, FOLLOW_UP_BUDGET, 'keeps the budget it started with')
})

test('a new interview starts under V2', () => {
  const fresh = createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true })
  assert.equal(fresh.followUpPolicyVersion, 2)
  assert.equal(fresh.maxFollowUpBudget, V2_FOLLOW_UP_BUDGET)
  assert.equal(fresh.maxFollowUps, V2_MAX_FOLLOW_UPS)
  assert.deepEqual(fresh.followUpPurposes, [])
  assert.equal(fresh.deepDiveUsed, false)
})

test('normalization never promotes V1 to V2', () => {
  // The only way to be V2 is to have been created as V2.
  for (const claimed of [undefined, null, 0, 1, '2', 'two', 3, {}]) {
    const raw: any = { ...v1(), followUpPolicyVersion: claimed }
    assert.equal(normalizeState(raw, v2()).followUpPolicyVersion, 1, `${String(claimed)} is not V2`)
  }
  assert.equal(normalizeState({ ...v2() } as any, v1()).followUpPolicyVersion, 2, 'an explicit 2 is honoured')
})

test('a V1 session keeps legacy caps and eligibility', () => {
  assert.equal(followUpCapFor(v1()), MAX_FOLLOW_UPS, 'clinical cap of 3')
  assert.equal(followUpCapFor(v1({ currentCategory: 'emotional' })), 2, 'behavioral cap of 2')
  // No unlock schedule: the whole budget is live at question 1, as it was.
  assert.ok(canFollowUp(v1({ primaryQuestionNumber: 1, followUpCount: 2 })), 'a third probe on Q1 is legal under V1')
})

test('a V2 session gets the new caps and eligibility', () => {
  assert.equal(followUpCapFor(v2()), V2_MAX_FOLLOW_UPS, 'clinical cap of 2')
  assert.equal(followUpCapFor(v2({ currentCategory: 'emotional' })), V2_MAX_FOLLOW_UPS_EMOTIONAL, 'behavioral cap of 1')
  assert.ok(!canFollowUp(v2({ primaryQuestionNumber: 1, followUpCount: 2 })), 'never a third probe')
})

test('V1 sessions never carry purpose state, even if the client sends some', () => {
  const raw: any = { ...v1(), followUpPurposes: ['mechanism', 'clarify'], deepDiveUsed: true }
  const restored = normalizeState(raw, v2())
  assert.equal(restored.followUpPolicyVersion, 1)
  assert.deepEqual(restored.followUpPurposes, [], 'V1 records nothing')
  assert.equal(restored.deepDiveUsed, false)
})

// ==========================================================================
// 2. Progressive unlock — every position from 1 to 10
// ==========================================================================

test('the unlock schedule releases the budget across the interview', () => {
  const expected = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
  for (let q = 1; q <= MAX_PRIMARY_QUESTIONS; q++) {
    assert.equal(followUpsUnlocked(v2({ primaryQuestionNumber: q })), expected[q - 1], `question ${q}`)
  }
})

test('at every position, spending beyond the unlock is refused', () => {
  const expected = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
  for (let q = 1; q <= MAX_PRIMARY_QUESTIONS; q++) {
    const unlocked = expected[q - 1]
    // Exactly at the unlock: refused. One below: allowed.
    const atLimit = v2({
      primaryQuestionNumber: q,
      followUpBudget: V2_FOLLOW_UP_BUDGET - unlocked,
      followUpCount: 0,
    })
    assert.ok(!canFollowUp(atLimit), `question ${q}: ${unlocked} already spent is the ceiling`)
    if (unlocked >= 1) {
      const below = v2({
        primaryQuestionNumber: q,
        followUpBudget: V2_FOLLOW_UP_BUDGET - (unlocked - 1),
        followUpCount: 0,
      })
      assert.ok(canFollowUp(below), `question ${q}: one under the ceiling is allowed`)
    }
  }
})

test('question 1 can never take two follow-ups', () => {
  // Unlock is 1 at Q1, so even with the per-scenario cap of 2 and a full
  // budget, the second probe is not on the table.
  const afterOne = applyTurn(v2({ primaryQuestionNumber: 1 }), turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
  assert.equal(afterOne.followUpCount, 1)
  assert.ok(!canFollowUp(afterOne), 'the unlock, not the cap, is what stops it')
  assert.ok(!actionEnum(afterOne).includes('ask_follow_up'), 'and the schema does not offer it')
})

test('the budget cannot be exhausted before question 9', () => {
  let s = v2()
  let spent = 0
  for (let q = 1; q <= 8; q++) {
    s = { ...s, primaryQuestionNumber: q, followUpCount: 0, currentCategory: 'clinical' }
    while (canFollowUp(s)) {
      s = applyTurn(s, turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
      spent++
    }
  }
  assert.ok(spent <= 4, `at most 4 follow-ups through question 8, got ${spent}`)
  assert.ok(s.followUpBudget >= 1, 'something is always left for the closing questions')
})

// ==========================================================================
// 3. Budget and per-question caps
// ==========================================================================

test('a V2 interview can never spend more than five follow-ups', () => {
  let s = createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true })
  s = applyTurn(s, turn('next_primary'))
  let followUps = 0
  for (let i = 0; i < 200 && !s.complete; i++) {
    const actions = allowedActions(s)
    if (actions.includes('ask_follow_up')) {
      s = applyTurn(s, turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
      followUps++
      continue
    }
    if (actions.includes('final_report')) { s = applyTurn(s, turn('final_report')); break }
    s = applyTurn(s, turn('next_primary'))
  }
  assert.equal(s.complete, true)
  assert.ok(followUps <= V2_FOLLOW_UP_BUDGET, `spent ${followUps}`)
  assert.equal(s.primaryQuestionNumber, MAX_PRIMARY_QUESTIONS, 'still ten primary questions')
})

test('a clinical scenario caps at two and a behavioral one at one', () => {
  const clinical = applyTurn(
    v2({ primaryQuestionNumber: 9, currentCategory: 'clinical' }),
    turn('ask_follow_up', { follow_up_purpose: 'clarify' })
  )
  assert.ok(canFollowUp(clinical), 'a second clinical probe is possible late in the interview')
  const twice = applyTurn(clinical, turn('ask_follow_up', { follow_up_purpose: 'mechanism' }))
  assert.equal(twice.followUpCount, 2)
  assert.ok(!canFollowUp(twice), 'never a third')

  const behavioral = applyTurn(
    v2({ primaryQuestionNumber: 9, currentCategory: 'emotional' }),
    turn('ask_follow_up', { category: 'emotional', follow_up_purpose: 'reflection' })
  )
  assert.equal(behavioral.followUpCount, 1)
  assert.ok(!canFollowUp(behavioral), 'one probe is the behavioral ceiling')
})

test('the per-scenario count resets with the next primary but the budget does not', () => {
  let s = applyTurn(v2({ primaryQuestionNumber: 3 }), turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
  assert.equal(s.followUpCount, 1)
  assert.equal(followUpsSpent(s), 1)
  s = applyTurn(s, turn('next_primary'))
  assert.equal(s.followUpCount, 0, 'allowance returns with the question')
  assert.equal(followUpsSpent(s), 1, 'the interview budget does not')
})

// ==========================================================================
// 4. The single deep dive
// ==========================================================================

test('a second follow-up requires a CLARIFY or RATIONALE first probe', () => {
  for (const purpose of ['clarify', 'rationale'] as const) {
    const s = applyTurn(v2({ primaryQuestionNumber: 9 }), turn('ask_follow_up', { follow_up_purpose: purpose }))
    assert.ok(canFollowUp(s), `${purpose} earns a deep dive`)
  }
  for (const purpose of ['mechanism', 'challenge'] as const) {
    const s = applyTurn(v2({ primaryQuestionNumber: 9 }), turn('ask_follow_up', { follow_up_purpose: purpose }))
    assert.ok(!canFollowUp(s), `${purpose} has already gone a layer down, so no second probe`)
  }
})

test('only one scenario in an interview may take two follow-ups', () => {
  // Deep dive on the first scenario.
  let s = applyTurn(v2({ primaryQuestionNumber: 9 }), turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
  s = applyTurn(s, turn('ask_follow_up', { follow_up_purpose: 'mechanism' }))
  assert.equal(s.deepDiveUsed, true)

  // Next scenario: one probe is fine, a second is not.
  s = applyTurn(s, turn('next_primary'))
  s = { ...s, primaryQuestionNumber: 10, followUpBudget: 3 }
  const once = applyTurn(s, turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
  assert.equal(once.followUpCount, 1)
  assert.ok(!canFollowUp(once), 'the interview has already spent its deep dive')
})

test('deepDiveUsed is set from the pre-turn count, not the post-turn count', () => {
  const first = applyTurn(v2({ primaryQuestionNumber: 9 }), turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
  assert.equal(first.deepDiveUsed, false, 'a FIRST follow-up is not a deep dive')
  const second = applyTurn(first, turn('ask_follow_up', { follow_up_purpose: 'mechanism' }))
  assert.equal(second.deepDiveUsed, true)
})

test('a V1 session has no deep-dive concept at all', () => {
  let s = applyTurn(v1({ primaryQuestionNumber: 2 }), turn('ask_follow_up'))
  s = applyTurn(s, turn('ask_follow_up'))
  assert.equal(s.deepDiveUsed, false, 'never set under V1')
  assert.ok(canFollowUp(s), 'and a third probe is still legal under the old cap of 3')
})

// ==========================================================================
// 5. Purposes
// ==========================================================================

test('the schema offers only the purposes valid for the scenario category', () => {
  const clinical = purposeField(v2({ currentCategory: 'clinical' }))
  assert.deepEqual(clinical.anyOf[0].enum, ['clarify', 'rationale', 'mechanism', 'challenge'])
  assert.ok(!clinical.anyOf[0].enum.includes('reflection'), 'clinical cannot use REFLECTION')

  const behavioral = purposeField(v2({ currentCategory: 'emotional' }))
  assert.deepEqual(behavioral.anyOf[0].enum, ['clarify', 'rationale', 'challenge', 'reflection'])
  assert.ok(!behavioral.anyOf[0].enum.includes('mechanism'), 'behavioral cannot use MECHANISM')
})

test('the purpose field types as null when no follow-up is on the table', () => {
  // Opening turn: only next_primary is permitted.
  const opening = purposeField(createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true }))
  assert.equal(opening.type, 'null', 'nothing meaningful to declare')
  assert.equal(opening.anyOf, undefined, 'no purpose can be returned at all')

  // Follow-ups declined at setup.
  const declined = purposeField(v2({ followUpsEnabled: false }))
  assert.equal(declined.type, 'null')
  assert.equal(declined.anyOf, undefined)
})

test('the purpose field is required under V2 and absent under V1', () => {
  const s2 = buildTurnSchema(v2()).schema as any
  assert.ok(s2.required.includes('follow_up_purpose'), 'strict mode requires every property')
  assert.ok(s2.properties.follow_up_purpose, 'and it exists')

  const s1 = buildTurnSchema(v1()).schema as any
  assert.ok(!s1.required.includes('follow_up_purpose'), 'V1 schema is untouched')
  assert.equal(s1.properties.follow_up_purpose, undefined)
})

test('structured output stays strict', () => {
  for (const s of [v2(), v1(), v2({ currentCategory: 'emotional' })]) {
    const schema = buildTurnSchema(s)
    assert.equal(schema.strict, true)
    assert.equal((schema.schema as any).additionalProperties, false)
    const props = Object.keys((schema.schema as any).properties)
    for (const key of (schema.schema as any).required) {
      assert.ok(props.includes(key), `${key} is required and defined`)
    }
  }
})

test('a valid purpose is recorded in history', () => {
  const s = applyTurn(v2({ primaryQuestionNumber: 5 }), turn('ask_follow_up', { follow_up_purpose: 'rationale' }))
  assert.deepEqual(s.followUpPurposes, ['rationale'])
})

test('a malformed or category-invalid purpose cannot corrupt state', () => {
  const cases: any[] = [undefined, null, '', 'MECHANISM', 'nonsense', 42, {}, ['clarify']]
  for (const bad of cases) {
    const s = applyTurn(v2({ primaryQuestionNumber: 9 }), turn('ask_follow_up', { follow_up_purpose: bad }))
    assert.deepEqual(s.followUpPurposes, ['unspecified'], `${JSON.stringify(bad)} records a placeholder`)
    assert.equal(s.followUpCount, 1, 'the follow-up still counted')
    // Fails closed: an unspecified purpose does not earn a deep dive.
    assert.ok(!canFollowUp(s), 'no second probe on an undeclared purpose')
  }
  // REFLECTION on a clinical scenario is invalid for that category.
  const wrongCategory = applyTurn(
    v2({ primaryQuestionNumber: 9, currentCategory: 'clinical' }),
    turn('ask_follow_up', { follow_up_purpose: 'reflection' })
  )
  assert.deepEqual(wrongCategory.followUpPurposes, ['unspecified'])
  // And MECHANISM on a behavioral one.
  const wrongOther = applyTurn(
    v2({ primaryQuestionNumber: 9, currentCategory: 'emotional' }),
    turn('ask_follow_up', { category: 'emotional', follow_up_purpose: 'mechanism' })
  )
  assert.deepEqual(wrongOther.followUpPurposes, ['unspecified'])
})

test('purpose history survives a round trip and drops junk', () => {
  const live = applyTurn(v2({ primaryQuestionNumber: 5 }), turn('ask_follow_up', { follow_up_purpose: 'challenge' }))
  const restored = normalizeState(JSON.parse(JSON.stringify(live)), v2())
  assert.deepEqual(restored.followUpPurposes, ['challenge'])

  const tampered = normalizeState({ ...live, followUpPurposes: ['clarify', 'bogus', 7, 'mechanism'] } as any, v2())
  assert.deepEqual(tampered.followUpPurposes, ['clarify', 'mechanism'], 'only real purposes survive')
})

test('only follow-up turns record a purpose', () => {
  for (const action of ['next_primary', 'reprompt_current'] as const) {
    const s = applyTurn(v2({ mode: 'real', primaryQuestionNumber: 4 }), turn(action, { follow_up_purpose: 'mechanism' as any }))
    assert.deepEqual(s.followUpPurposes, [], `${action} records nothing`)
  }
})

test('purposes used so far reach the prompt', () => {
  let s = applyTurn(v2({ primaryQuestionNumber: 5 }), turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
  s = applyTurn(s, turn('next_primary'))
  s = { ...s, primaryQuestionNumber: 7, currentCategory: 'clinical', turnKind: 'primary' }
  s = applyTurn(s, turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
  const p = promptFor(s)
  assert.match(p, /Follow-up purposes used so far: clarify x2/)
  assert.match(p, /do not reach for it a third time unless this specific answer plainly demands it/)
})

test('the prompt reports the deep dive and the unlock position', () => {
  const fresh = promptFor(v2({ primaryQuestionNumber: 3 }))
  assert.match(fresh, /Follow-ups released by this point in the interview: 0 of 2/)
  assert.match(fresh, /deep dive for this interview is still available/)

  let s = applyTurn(v2({ primaryQuestionNumber: 9 }), turn('ask_follow_up', { follow_up_purpose: 'clarify' }))
  s = applyTurn(s, turn('ask_follow_up', { follow_up_purpose: 'mechanism' }))
  assert.match(promptFor(s), /deep dive for this interview is spent/)
})

test('every V2-only prompt edit is version-gated', () => {
  // Caught in validation pre-flight: two Phase 2 edits were applied
  // unconditionally, so V1 sessions saw changed clinical wording and a stray
  // blank line in Practice mode. Regex pins did not catch it because they only
  // asserted what was present, never that V1 was byte-identical.
  const clinicalV1 = promptFor(v1({ type: 'clinical', primaryQuestionNumber: 3 }))
  assert.match(clinicalV1, /use follow-ups sparingly to climb the ladder toward mechanism and integration/)
  assert.match(clinicalV1, /you can pitch the NEXT primary question a level higher/)
  const clinicalV2 = promptFor(v2({ type: 'clinical', primaryQuestionNumber: 3 }))
  assert.doesNotMatch(clinicalV2, /use follow-ups sparingly to climb the ladder/)

  // Practice mode: the V2-only line must not leave an empty line behind on V1.
  const practiceV1 = promptFor(v1({ mode: 'practice', primaryQuestionNumber: 3 }))
  assert.match(practiceV1, /never after an individual follow-up\.\n- The opening welcome may mention/)
  assert.doesNotMatch(practiceV1, /never after an individual follow-up\.\n\n/)
  assert.match(
    promptFor(v2({ mode: 'practice', primaryQuestionNumber: 3 })),
    /never after an individual follow-up\.\n- Follow-up policy is identical/
  )
})

test('a V1 prompt carries none of the V2 pacing furniture', () => {
  const p = promptFor(v1({ primaryQuestionNumber: 3 }))
  assert.doesNotMatch(p, /Follow-ups released by this point/)
  assert.doesNotMatch(p, /Follow-up purposes used so far/)
  assert.doesNotMatch(p, /deep dive for this interview/)
})

// ==========================================================================
// 6. Strong answers, and the doctrine that governs them
// ==========================================================================

test('a strong answer is not itself a reason to probe', () => {
  const p = promptFor(v2({ primaryQuestionNumber: 4 }))
  assert.match(p, /A strong, complete answer means MOVE ON\. That is the rule, and it wins by default\./)
  assert.match(p, /A strong answer is NEVER by itself a reason to ask something harder/)
  assert.match(p, /the interview gets harder at the NEXT PRIMARY QUESTION/)
  assert.match(p, /punishes the applicant for being good/)
})

test('the strong-answer exception is stated as five simultaneous tests', () => {
  const p = promptFor(v2({ primaryQuestionNumber: 4 }))
  assert.match(p, /only when ALL FIVE of these are true/)
  assert.match(p, /the applicant introduced the claim themselves/)
  assert.match(p, /clinically or behaviorally meaningful/)
  assert.match(p, /genuinely add assessment signal/)
  assert.match(p, /they have not already demonstrated this/)
  assert.match(p, /not merely a way to make the interview harder/)
  assert.match(p, /If you cannot say all five hold, move on/)
  assert.match(p, /"It would be interesting to hear more" is not one of the five/)
})

test('the difficulty ladder no longer routes climbing through follow-ups', () => {
  const p = promptFor(v2({ primaryQuestionNumber: 4 }))
  assert.match(p, /Climbing is NOT a reason to follow up on the answer you just heard/)
  assert.doesNotMatch(p, /Follow-ups are the main way you climb/)
  // V1 keeps its original wording.
  assert.match(promptFor(v1({ primaryQuestionNumber: 4 })), /Follow-ups are the main way you climb/)
})

test('the difficulty mechanism itself is untouched', () => {
  // Phase 2 changes WHEN a follow-up happens, never how difficulty is computed.
  assert.match(STATE_SRC, /if \(avg >= 8\) nextLevel = current \+ 1/)
  assert.match(STATE_SRC, /else if \(avg >= 6\.5\) nextLevel = current/)
  assert.match(STATE_SRC, /else if \(avg >= 4\.5\) nextLevel = current - 1/)
  const strong = v2({ evaluations: [{ overall_score: 9 } as any, { overall_score: 9 } as any], difficultyLevel: 2 })
  const next = applyTurn(strong, turn('next_primary', { evaluation: { overall_score: 9 } as any }))
  assert.ok(next.suggestedDifficulty > 2, 'a strong run still raises the NEXT primary')
})

// ==========================================================================
// 7. Answer-class, depth and one-ask doctrine
// ==========================================================================

test('the doctrine names what to do for each answer class', () => {
  const p = promptFor(v2({ primaryQuestionNumber: 4 }))
  assert.match(p, /Partial: they have part of it and something important is missing -> at most one follow-up aimed at the missing piece ONLY/)
  assert.match(p, /Do not widen the question into new territory/)
  assert.match(p, /Vague or unclear -> at most one CLARIFY/)
  assert.match(p, /the inability to get specific is itself assessment information/)
  assert.match(p, /Clearly incorrect -> at most one CHALLENGE/)
  assert.match(p, /do not keep probing until they arrive at it/)
})

test('each purpose states when it applies and when it does not', () => {
  const p = promptFor(v2({ primaryQuestionNumber: 4 }))
  assert.match(p, /clarify — the answer is genuinely ambiguous.*NOT because the answer could have contained more/s)
  assert.match(p, /rationale — they chose an action.*NOT when they already gave their reasoning/s)
  assert.match(p, /mechanism — CLINICAL ONLY.*NEVER to raise difficulty/s)
  assert.match(p, /challenge — the answer is incorrect/)
  assert.match(p, /reflection — BEHAVIORAL ONLY.*Do not force reflection onto a story that already has it/s)
  assert.match(p, /Do not rotate purposes for variety either/)
})

test('the one-central-ask rule is stated for follow-ups with no exception', () => {
  const p = promptFor(v2({ primaryQuestionNumber: 4 }))
  assert.match(p, /A follow-up asks ONE thing\. One sentence, one question mark, normally under about 25 words/)
  assert.match(p, /three questions wearing one coat/)
  assert.match(p, /Unlike a primary question, there is no exception here/)
})

test('clinical depth is bounded to one layer beneath what the applicant raised', () => {
  const p = promptFor(v2({ type: 'clinical', primaryQuestionNumber: 4 }))
  assert.match(p, /One layer beneath what the applicant actually introduced/)
  assert.match(p, /Levels 1-3 are the normal ceiling for a follow-up/)
  assert.match(p, /Level 5 is not a follow-up destination/)
  assert.match(p, /Intracellular signaling is not a routine admissions question/)
  assert.match(p, /Exact medication dosing is not a follow-up destination/)
  assert.match(p, /Never go to the receptor level just because you want another layer/)
  // The territories themselves stay available.
  assert.match(p, /Pathophysiology, hemodynamics, ventilator mechanics, pharmacology and complications all remain fully available/)
})

test('behavioral completion and the retired probes are pinned', () => {
  const p = promptFor(v2({ type: 'emotional', primaryQuestionNumber: 4, currentCategory: 'emotional' }))
  assert.match(p, /At most ONE follow-up on a behavioral or emotional-intelligence answer/)
  assert.match(p, /a specific situation, the applicant's own action, and an outcome is COMPLETE/)
  assert.match(p, /A complete story does not owe you a lesson/)
  assert.match(p, /ask what they would do differently OR what they took from it\. Never both/)
  assert.match(p, /Do NOT ask what the other person said/)
  // The old four-probe list is gone from a V2 behavioral prompt.
  assert.doesNotMatch(p, /"What did you actually say to them\?", "How did they react\?"/)
  // ...and still present for V1.
  assert.match(
    promptFor(v1({ type: 'emotional', primaryQuestionNumber: 4, currentCategory: 'emotional' })),
    /"What did you actually say to them\?", "How did they react\?"/
  )
})

test('Mixed carries the soft clinical allowance and both depth sections', () => {
  const p = promptFor(v2({ type: 'mixed', primaryQuestionNumber: 4 }))
  assert.match(p, /no more than about three of your follow-ups should land on clinical scenarios/)
  assert.match(p, /HOW DEEP A CLINICAL FOLLOW-UP GOES/)
  assert.match(p, /HOW DEEP A BEHAVIORAL FOLLOW-UP GOES/)
  assert.match(p, /at most two on a clinical scenario and at most one on a behavioral one/)
})

test('Practice mode gets the same policy and a no-tutoring line', () => {
  const practice = promptFor(v2({ mode: 'practice', primaryQuestionNumber: 4 }))
  const real = promptFor(v2({ mode: 'real', primaryQuestionNumber: 4 }))
  assert.match(practice, /Follow-up policy is identical to a Real Interview/)
  assert.match(practice, /Do NOT use a follow-up to walk the applicant toward the point the review is about to make/)
  for (const p of [practice, real]) {
    assert.match(p, /A strong, complete answer means MOVE ON/, 'same doctrine in both modes')
  }
  assert.equal(followUpCapFor(v2({ mode: 'practice' })), followUpCapFor(v2({ mode: 'real' })))
})

// ==========================================================================
// 8. Nothing outside the follow-up policy moved
// ==========================================================================

test('the worst-case V2 interview stays under the 24-turn ceiling', () => {
  // One opening call, then one call per applicant reply.
  let s = createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true })
  let calls = 1
  s = applyTurn(s, turn('next_primary'))
  for (let i = 0; i < 200 && !s.complete; i++) {
    const actions = allowedActions(s)
    calls++
    if (actions.includes('reprompt_current')) { s = applyTurn(s, turn('reprompt_current')); continue }
    if (actions.includes('ask_follow_up')) { s = applyTurn(s, turn('ask_follow_up', { follow_up_purpose: 'clarify' })); continue }
    if (actions.includes('final_report')) { s = applyTurn(s, turn('final_report')); break }
    s = applyTurn(s, turn('next_primary'))
  }
  assert.equal(s.complete, true)
  assert.ok(calls <= 24, `worst case used ${calls} model turns`)
  assert.ok(calls < 23, 'and it is strictly better than the V1 worst case of 23')
  assert.equal(s.repromptBudget < MAX_REPROMPTS_PER_INTERVIEW, true, 'reprompts were genuinely exercised')
})

test('primary-question count, formats and scoring are untouched', () => {
  assert.equal(MAX_PRIMARY_QUESTIONS, 10)
  let s = createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true })
  s = applyTurn(s, turn('next_primary', { question_format: 'pharmacology', question_asked: 'q1' }))
  assert.deepEqual(s.askedFormats, ['pharmacology'], 'format rotation still records')
  assert.deepEqual(s.askedPrimaryQuestions, ['q1'])
  const evaluation: any = { primary_question_number: 1, overall_score: 8 }
  const probed = applyTurn(s, turn('ask_follow_up', { follow_up_purpose: 'clarify', evaluation }))
  assert.equal(probed.evaluations.length, 0, 'a follow-up still banks no evaluation')
  assert.equal(applyTurn(probed, turn('next_primary', { evaluation })).evaluations.length, 1)
})

test('purposesFor maps categories to the right purpose sets', () => {
  const clinicalish: QuestionCategory[] = ['clinical', 'custom']
  for (const c of clinicalish) {
    assert.ok(purposesFor(v2({ currentCategory: c })).includes('mechanism'))
    assert.ok(!purposesFor(v2({ currentCategory: c })).includes('reflection'))
  }
  for (const c of ['emotional', 'behavioral'] as QuestionCategory[]) {
    assert.ok(purposesFor(v2({ currentCategory: c })).includes('reflection'))
    assert.ok(!purposesFor(v2({ currentCategory: c })).includes('mechanism'))
  }
})

test('the unlock gate lives in the state machine, not only in the prompt', () => {
  assert.match(STATE_SRC, /function v2FollowUpAllowed/)
  assert.match(STATE_SRC, /followUpsSpent\(state\) >= followUpsUnlocked\(state\)/)
  assert.match(STATE_SRC, /if \(state\.deepDiveUsed\) return false/)
  assert.match(PROMPT_SRC, /FOLLOW_UP_DOCTRINE_V2/)
})
