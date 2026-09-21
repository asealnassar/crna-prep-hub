import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createInitialState, MAX_PRIMARY_QUESTIONS } from './state.ts'
import { buildSystemPrompt } from './prompt.ts'
import { buildTurnSchema } from './schema.ts'
import type { InterviewState, InterviewType, InterviewMode } from './types.ts'
import { CLINICAL_FORMATS, EMOTIONAL_FORMATS } from './types.ts'

/**
 * Prompt anchoring.
 *
 * The production baseline showed the model was not inventing questions so much
 * as reusing the ones the prompt had demonstrated. The example ABG, peak vs
 * plateau, propofol's effect on blood pressure, the MAP-52 hypotension
 * scenario and "tell me about a time you disagreed with a physician" all
 * appeared in real interviews at rates no honest question-writer would produce
 * — the prompt was teaching WHAT to ask, not only HOW to ask.
 *
 * Phase 1 removed the worked examples and kept the structural teaching. These
 * tests are the tripwire in both directions:
 *   - no known anchor comes back, in any interview type or turn shape;
 *   - the guidance those examples used to carry is still stated somewhere.
 *
 * They deliberately do NOT assert anything about follow-up frequency, depth,
 * budgets or interview length. Phase 1 changed none of those, and the last
 * section here pins that.
 */

const PROMPT_SRC = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8')
const SCHEMA_SRC = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8')

const state = (over: Partial<InterviewState> = {}): InterviewState => ({
  ...createInitialState({ mode: 'real', type: 'clinical', followUpsEnabled: true }),
  ...over,
})

const promptFor = (s: InterviewState) =>
  buildSystemPrompt(s, { recentQuestions: [], seed: 'seed-1' })

const TYPES: InterviewType[] = ['clinical', 'emotional', 'mixed', 'custom']
const MODES: InterviewMode[] = ['real', 'practice']

/**
 * Every branch of buildSystemPrompt that can carry prose: each type, each
 * mode, follow-ups on and off, the opening turn, a mid-interview turn, a turn
 * where a follow-up is live, and the closing turn that adds FINAL REPORT RULES.
 */
function allPromptVariants(): { label: string; prompt: string }[] {
  const out: { label: string; prompt: string }[] = []
  for (const type of TYPES) {
    for (const mode of MODES) {
      for (const followUpsEnabled of [true, false]) {
        const seed = state({
          type,
          mode,
          followUpsEnabled,
          customTopic: type === 'custom' ? 'arterial blood gas interpretation' : '',
        })
        const shapes: [string, Partial<InterviewState>][] = [
          ['opening', {}],
          [
            'mid',
            {
              primaryQuestionNumber: 4,
              turnKind: 'primary',
              currentCategory: 'clinical',
              currentScenario: 'scenario 4',
            },
          ],
          [
            'on-follow-up',
            {
              primaryQuestionNumber: 4,
              turnKind: 'follow_up',
              followUpCount: 1,
              currentCategory: 'clinical',
              currentScenario: 'scenario 4',
            },
          ],
          [
            'last-question',
            {
              primaryQuestionNumber: MAX_PRIMARY_QUESTIONS,
              turnKind: 'primary',
              currentCategory: 'emotional',
              currentScenario: 'final scenario',
            },
          ],
        ]
        for (const [shape, over] of shapes) {
          out.push({
            label: `${type}/${mode}/follow-ups ${followUpsEnabled ? 'on' : 'off'}/${shape}`,
            prompt: promptFor({ ...seed, ...over }),
          })
        }
      }
    }
  }
  return out
}

const VARIANTS = allPromptVariants()

// ==========================================================================
// 1. The anchors production caught, and the ones beside them
// ==========================================================================

/**
 * Each entry is a phrase that must not appear in any prompt the system builds.
 * `why` is printed on failure so a future edit is told what it reintroduced
 * rather than just which regex tripped.
 */
const BANNED: { pattern: RegExp; why: string }[] = [
  {
    pattern: /\bpropofol\b/i,
    why: 'the propofol/blood-pressure example was copied into a large share of pharmacology questions',
  },
  {
    pattern: /\bnorepinephrine\b/i,
    why: 'the norepinephrine good/bad pair anchored pharmacology and reprompts onto one drug',
  },
  {
    pattern: /septic (shock|patient)/i,
    why: 'septic shock dominated Clinical; the format list may name sepsis as territory, a worked septic scenario may not',
  },
  {
    pattern: /pH 7\.\d/,
    why: 'the example ABG appeared verbatim in a large share of real ABG questions',
  },
  {
    pattern: /\bbicarb\b/i,
    why: 'part of the example ABG',
  },
  {
    pattern: /\bplateau\b/i,
    why: 'peak vs plateau pressure was one of the most repeated ventilator questions in production',
  },
  {
    pattern: /peak pressures?\b/i,
    why: 'the other half of the peak-vs-plateau anchor',
  },
  {
    pattern: /\bETCO2\b/i,
    why: 'came from the worked vent scenario, which was reproduced closely in real interviews',
  },
  {
    pattern: /CVP \d|SVR \d|cardiac index \d/i,
    why: 'the worked shock-states numbers were copied as a set',
  },
  {
    pattern: /MAP (is|drops|of) \d|determinants of MAP/i,
    why: 'MAP-with-a-number is the hypotension anchor that made Clinical feel identical run to run',
  },
  {
    pattern: /disagreed with a (physician|provider)/i,
    why: 'this was the example opener and became the actual Behavioral opener far too often',
  },
  {
    pattern: /sickest patient/i,
    why: 'the worked patient_deep_dive opener',
  },
  {
    pattern: /biggest weakness/i,
    why: 'the worked self_awareness question',
  },
  {
    pattern: /first-line pressor|which vasopressor would you start/i,
    why: 'the worked anti-repetition pair, which taught the pressor question it was meant to prevent',
  },
]

test('no banned content anchor appears in any prompt the system can build', () => {
  assert.ok(VARIANTS.length >= 64, 'the matrix covers every prose branch')
  for (const { pattern, why } of BANNED) {
    for (const { label, prompt } of VARIANTS) {
      assert.doesNotMatch(prompt, pattern, `${label}: reintroduced ${pattern} — ${why}`)
    }
  }
})

test('no banned anchor hides in the response schema either', () => {
  // The schema's field descriptions reach the model on every single turn, so a
  // "septic shock pressor choice" example there anchored as hard as the prompt.
  for (const s of [state(), state({ type: 'emotional' }), state({ type: 'mixed' })]) {
    const json = JSON.stringify(buildTurnSchema(s))
    for (const { pattern, why } of BANNED) {
      assert.doesNotMatch(json, pattern, `schema reintroduced ${pattern} — ${why}`)
    }
  }
})

test('the format guides contain no askable sample question', () => {
  // A generic tripwire: a quoted sentence ending in a question mark inside a
  // format guide is a question the model can lift verbatim, whatever it is
  // about. This catches a NEW anchor that the banned list has never seen.
  for (const header of ['=== CLINICAL QUESTION FORMATS ===', '=== EMOTIONAL INTELLIGENCE QUESTION FORMATS ===']) {
    const p = promptFor(state({ type: 'mixed' }))
    const start = p.indexOf(header)
    assert.ok(start >= 0, `${header} is present in a Mixed prompt`)
    const rest = p.slice(start + header.length)
    const end = rest.indexOf('\n=== ')
    const section = end === -1 ? rest : rest.slice(0, end)
    assert.doesNotMatch(
      section,
      /"[^"\n]{12,}\?"/,
      `${header} grew a quoted sample question — describe the territory instead`
    )
  }
})

test('replacing one anchor with another is still a regression', () => {
  // The failure mode this guards: swapping the septic example for a pulmonary
  // embolism example changes which topic dominates, not whether one does.
  const clinical = promptFor(state({ type: 'clinical' }))
  const start = clinical.indexOf('=== CLINICAL QUESTION FORMATS ===')
  const rest = clinical.slice(start)
  const section = rest.slice(0, rest.indexOf('\n=== ') === -1 ? undefined : rest.indexOf('\n=== '))
  // Vitals and lab values are the raw material of a worked scenario. A format
  // guide describes territory, so it has no reason to carry any.
  assert.doesNotMatch(
    section,
    /\b\d{2,3}\/\d{2,3}\b|\b\d+ mcg|\b\d+ mg\b/,
    'the clinical format guide grew concrete vitals or doses — that is a worked scenario'
  )
  assert.match(
    clinical,
    /These are territories to write a question FROM, never questions to ask/,
    'and the guide still says so outright'
  )
})

// ==========================================================================
// 2. Clinical: the structural guidance the examples used to carry
// ==========================================================================

test('Clinical still defines its territory and its level', () => {
  const p = promptFor(state({ type: 'clinical' }))
  assert.match(p, /=== INTERVIEW TYPE: CLINICAL ===/)
  assert.match(p, /ICU and critical care questions of the kind these nurses would genuinely have faced/)
  assert.match(p, /=== CLINICAL QUESTION FORMATS ===/)
  for (const f of CLINICAL_FORMATS) {
    assert.ok(p.includes(f), `the ${f} format is still offered`)
  }
  assert.match(p, /is the TERRITORY that format covers, not a set of things to ask in one breath/)
})

test('Clinical still states length, density and what to withhold', () => {
  const p = promptFor(state({ type: 'clinical' }))
  assert.match(p, /LENGTH AND DENSITY/)
  assert.match(p, /A scenario's context runs one to three sentences/)
  assert.match(p, /Supply enough for the applicant to reason their way to an answer and no more/)
  assert.match(p, /Do not name the diagnosis you are testing for/)
  assert.match(p, /A direct-knowledge question is often a single sentence with no scenario at all/)
})

test('Clinical keeps every capability the examples used to demonstrate', () => {
  const p = promptFor(state({ type: 'clinical' }))
  // physiology, pharmacology, hemodynamics, prioritisation, scenario,
  // conceptual and experience-based questions all still have a home.
  assert.match(p, /pathophysiology — why the problem is happening/)
  assert.match(p, /pharmacology — indication, dose, receptor, mechanism/)
  assert.match(p, /hemodynamics — MAP, CO, SV, SVR, preload, afterload/)
  assert.match(p, /scenario — a patient is deteriorating; how do you assess, prioritize, intervene, reassess/)
  assert.match(p, /patient_deep_dive — ask them to present a complex ICU patient of their own/)
  assert.match(p, /Safety and prioritization/)
  assert.match(p, /Vasoactive dosing/, 'the dosing-convention fairness rule survives')
})

test('the difficulty ladder is untouched by Phase 1, word for word', () => {
  const p = promptFor(state({ type: 'clinical', primaryQuestionNumber: 3, turnKind: 'primary' }))
  assert.match(p, /=== DIFFICULTY LADDER ===/)
  // Pinned verbatim on purpose. Level 3 names SVR, MAP and CO, which does
  // anchor toward hemodynamics — but the ladder is out of scope for Phase 1,
  // which is isolated to concrete question and scenario anchors. Whether the
  // ladder itself should change is a later decision, taken deliberately.
  assert.ok(
    p.includes(
      'Level 1 - Foundational ICU knowledge (what a drug or intervention is for).\n' +
        'Level 2 - Clinical application (why you would choose it in this patient).\n' +
        'Level 3 - Physiology and pathophysiology (what happens to preload, afterload, SVR, MAP, CO, oxygen delivery).\n' +
        'Level 4 - Pharmacology and mechanism (receptor subtypes, signaling, half-life, metabolism, interactions).\n' +
        'Level 5 - Integration and reasoning under tension (competing effects, exceptions, when the usual answer is wrong).'
    ),
    'all five ladder levels are exactly as they were before Phase 1'
  )
  assert.match(p, /Calibrate the next primary question around level \d/)
  assert.match(p, /When the applicant is struggling, step back down/)
})

// ==========================================================================
// 3. Behavioral / EI
// ==========================================================================

test('EI still offers every format, so every competency is reachable', () => {
  const p = promptFor(state({ type: 'emotional' }))
  assert.match(p, /=== INTERVIEW TYPE: EMOTIONAL INTELLIGENCE ===/)
  assert.match(p, /=== EMOTIONAL INTELLIGENCE QUESTION FORMATS ===/)
  for (const f of EMOTIONAL_FORMATS) {
    assert.ok(p.includes(f), `the ${f} format is still offered`)
  }
  // The competencies named in the EI rubric are what these formats assess.
  for (const c of [
    'Self-awareness',
    'Accountability',
    'Communication',
    'Conflict resolution',
    'Emotional regulation',
    'Professionalism',
    'Teamwork',
    'Reflection and growth',
  ]) {
    assert.ok(p.includes(c), `${c} is still scored`)
  }
  assert.match(p, /leadership — taking charge, advocating for a patient/, 'advocacy still has a home')
})

test('EI has no anchored opener and no default wording', () => {
  const p = promptFor(state({ type: 'emotional' }))
  assert.match(p, /There is no default opening question and no default opening format/)
  assert.match(p, /Vary how a question enters, not only which format it belongs to/)
  assert.match(p, /Do not let one opening become the template for the whole interview/)
})

test('"tell me about a time" is discouraged as a default but not forbidden', () => {
  // The user asked for natural variation, not a ban: a past-example question is
  // a legitimate behavioral question and the prompt must not outlaw it.
  const p = promptFor(state({ type: 'emotional' }))
  assert.match(p, /Asking for a past example is one legitimate opening/)
  assert.doesNotMatch(p, /never ask for a past example|do not ask for a specific example/i)
})

test('EI still requires specificity and real reflection', () => {
  const p = promptFor(state({ type: 'emotional' }))
  assert.match(p, /Weigh specificity and maturity heavily/)
  assert.match(p, /Press generic or rehearsed answers for a concrete instance/)
  assert.match(p, /forcing them into STAR is wrong/)
})

// ==========================================================================
// 4. Mixed
// ==========================================================================

test('Mixed inherits both de-anchored guides and adds no anchors of its own', () => {
  const p = promptFor(state({ type: 'mixed' }))
  assert.match(p, /=== INTERVIEW TYPE: MIXED ===/)
  assert.match(p, /=== CLINICAL QUESTION FORMATS ===/)
  assert.match(p, /=== EMOTIONAL INTELLIGENCE QUESTION FORMATS ===/)
  for (const f of [...CLINICAL_FORMATS, ...EMOTIONAL_FORMATS]) {
    assert.ok(p.includes(f), `Mixed can still reach ${f}`)
  }
})

test('Mixed sequencing and balance language is untouched by Phase 1', () => {
  const p = promptFor(state({ type: 'mixed' }))
  assert.match(p, /Blend clinical and emotional\/behavioral questions the way a real panel does — organically, not by strict alternation/)
  assert.match(p, /Aim for a roughly balanced split across the \d+ primary questions/)
  assert.match(p, /correct toward balance as you approach the end/)
  assert.match(p, /Never announce or hint at the category of what is coming next/)
  assert.match(p, /Score each scenario with the rubric matching ITS category/)
})

// ==========================================================================
// 5. Phase 1 touched anchors only — follow-ups, length and counters stand
// ==========================================================================

test('follow-up doctrine is unchanged for a legacy V1 session', () => {
  // Phase 2 introduced a second doctrine. V1 interviews -- everything already
  // in flight when it shipped -- must still receive the original text, so this
  // test now pins it against an explicitly V1 state.
  const p = promptFor(state({ primaryQuestionNumber: 3, turnKind: 'primary', followUpPolicyVersion: 1 }))
  assert.match(p, /Moving to the next question is the DEFAULT after any answer, in every category/)
  assert.match(p, /A follow-up is something you spend, not something you owe/)
  assert.match(p, /Clinical and technical scenarios allow up to three/)
  assert.match(p, /Emotional and behavioral scenarios allow at most two/)
  assert.match(p, /Before asking a behavioral follow-up, check the answer against these four gates/)
  assert.match(p, /zero follow-ups is correct for an answer that is already complete and deep/)
  // Phase 1 left the doctrine's own illustration in place precisely because
  // rewording it would be a follow-up change, which belongs to Phase 2.
  assert.match(p, /"What would you expect that to do to preload\?"/)
})

test('the EI follow-up gates and probes are unchanged for a legacy V1 session', () => {
  const p = promptFor(state({ type: 'emotional', followUpPolicyVersion: 1 }))
  assert.match(p, /Follow-ups here are optional and capped at two, and the default is to move on/)
  assert.match(p, /Only follow up when one of the four gates in the follow-up doctrine is actually failed/)
  assert.match(
    p,
    /"What did you actually say to them\?", "How did they react\?", "What would you do differently\?", "What was your part in it\?"/
  )
})

test('interview length and the counters are unchanged', () => {
  assert.equal(MAX_PRIMARY_QUESTIONS, 10)
  const p = promptFor(state({ primaryQuestionNumber: 3, turnKind: 'primary' }))
  assert.match(p, /Primary questions asked: 3 of 10/)
  const opening = promptFor(state())
  assert.match(opening, /this is primary question 1 of 10/, 'and the opening turn still says ten')
})

test('Phase 1 changed prose only — no engine surface moved', () => {
  // prompt.ts builds text; it must not have grown logic in the process.
  assert.doesNotMatch(PROMPT_SRC, /maxPrimaryQuestions\s*=/, 'prompt.ts never assigns interview length')
  assert.doesNotMatch(PROMPT_SRC, /followUpBudget\s*=/, 'nor a follow-up budget')
  // The schema still narrows the action enum, which is what enforces the caps.
  assert.match(SCHEMA_SRC, /action: \{ type: 'string', enum: actions \}/)
})
