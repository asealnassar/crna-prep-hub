import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PROPOSALS, PROHIBITED_CATEGORIES, buildPrompt, needsCurrentText,
  parseModelResponse, systemPrompt, userPrompt,
} from './prompts.ts'
import { factSheet, makeFact } from '../model/facts.ts'
import { SUPPLIED_FACTS } from './fixtures/adversarial.ts'

const SHEET = factSheet('critical_care/p1/bullets', [[...SUPPLIED_FACTS]])
const EMPTY = factSheet('critical_care/p1/bullets', [[]])

// ---------------------------------------------------- the contract

test('the prompt states every prohibited category from decision 1, verbatim', () => {
  const system = systemPrompt()
  for (const category of PROHIBITED_CATEGORIES) {
    assert.ok(system.includes(category), `the prompt does not forbid "${category}"`)
  }
  assert.equal(PROHIBITED_CATEGORIES.length, 17, 'the list changed — check it against decision 1')
})

test('the prompt gives the impulse somewhere legitimate to go', () => {
  // V1 demanded a measurable outcome in every bullet and supplied none, so the
  // model invented them. A model told only "do not invent" and given no
  // alternative will still find one.
  const system = systemPrompt()
  assert.ok(system.includes('opportunities'), 'there is no alternative to inventing')
  assert.match(system, /do not estimate|typical value/i)
})

test('the prompt says the output is a proposal, not a decision', () => {
  assert.match(systemPrompt(), /PROPOSAL/)
})

test('the prompt demands the agreed JSON shape and nothing else', () => {
  const system = systemPrompt()
  assert.ok(system.includes('"proposals"'))
  assert.ok(system.includes('"opportunities"'))
  assert.match(system, /JSON only|No prose outside/i)
})

test('the rules half says nothing about any particular applicant', () => {
  const system = systemPrompt()
  for (const value of SUPPLIED_FACTS.map((f) => f.value)) {
    assert.equal(system.includes(value), false, `the system prompt leaked "${value}"`)
  }
})

// --------------------------------------------------------- the facts

test('the facts half carries the sheet, with citable ids', () => {
  const user = userPrompt({ operation: 'generate-bullets', sheet: SHEET })
  for (const fact of SHEET.facts) {
    assert.ok(user.includes(fact.value), `missing fact: ${fact.value}`)
    assert.ok(user.includes(fact.id), `missing id: ${fact.id}`)
  }
  assert.ok(user.includes(SHEET.subject), 'the prompt does not say what it is for')
})

test('the prompt contains nothing beyond the sheet', () => {
  const user = userPrompt({ operation: 'generate-bullets', sheet: SHEET })
  for (const absent of ['Jane Doe', 'example.test', 'Another Hospital', 'resume_id', 'user_id']) {
    assert.equal(user.includes(absent), false, `the prompt leaked "${absent}"`)
  }
})

test('an empty sheet tells the model to ask rather than to improvise', () => {
  const user = userPrompt({ operation: 'generate-bullets', sheet: EMPTY })
  assert.match(user, /none supplied/i)
  assert.match(user, /empty[\s\S]*proposals|opportunities/i)
})

test('a rewrite carries the current text; generation does not', () => {
  assert.equal(needsCurrentText('generate-bullets'), false)
  assert.equal(needsCurrentText('improve-bullet'), true)

  const rewrite = userPrompt({
    operation: 'improve-bullet', sheet: SHEET, currentText: 'Titrated drips.',
  })
  assert.ok(rewrite.includes('CURRENT TEXT'))
  assert.ok(rewrite.includes('Titrated drips.'))

  const generate = userPrompt({ operation: 'generate-bullets', sheet: SHEET })
  assert.equal(generate.includes('CURRENT TEXT'), false)
})

test('the same request always builds the same prompt', () => {
  const request = { operation: 'generate-bullets' as const, sheet: SHEET }
  assert.deepEqual(buildPrompt(request), buildPrompt(request))
})

test('a requested limit reaches the model', () => {
  assert.match(userPrompt({ operation: 'generate-bullets', sheet: SHEET, maxItems: 3 }), /at most 3 proposals/)
  assert.match(userPrompt({ operation: 'generate-bullets', sheet: SHEET, maxItems: 1 }), /at most 1 proposal\b/)
})

// ------------------------------------------------- reading the reply

test('the agreed shape is read', () => {
  const result = parseModelResponse({
    proposals: ['One.', 'Two.'],
    opportunities: [{ question: 'How many beds?', why: 'It would sharpen the first line.' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value.proposals, ['One.', 'Two.'])
  assert.equal(result.value.opportunities[0].question, 'How many beds?')
})

test('JSON as a string is read, fence and all', () => {
  const raw = '```json\n{"proposals":["One."],"opportunities":[]}\n```'
  const result = parseModelResponse(raw)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value.proposals, ['One.'])
})

test('there is no fallback chain', () => {
  // V1 accepted `result.bullets || result.bullet_points || Object.values(result)`,
  // which turned malformed output into plausible nonsense on the page.
  for (const body of [
    { bullets: ['One.'] },
    { bullet_points: ['One.'] },
    { items: ['One.'] },
    { data: { proposals: ['One.'] } },
    ['One.'],
    'One.',
    42,
    null,
  ]) {
    assert.equal(parseModelResponse(body).ok, false, JSON.stringify(body))
  }
})

test('a malformed proposal is refused, not coerced', () => {
  for (const proposals of [[1], [null], [{ text: 'One.' }], ['x'.repeat(3000)]]) {
    assert.equal(parseModelResponse({ proposals }).ok, false, JSON.stringify(proposals).slice(0, 40))
  }
})

test('too many proposals is refused', () => {
  assert.equal(parseModelResponse({ proposals: Array(MAX_PROPOSALS).fill('One.') }).ok, true)
  assert.equal(parseModelResponse({ proposals: Array(MAX_PROPOSALS + 1).fill('One.') }).ok, false)
})

test('blank proposals are dropped rather than rendered as empty bullets', () => {
  const result = parseModelResponse({ proposals: ['One.', '', '   ', 'Two.'] })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.value.proposals, ['One.', 'Two.'])
})

test('opportunities may be absent but not malformed', () => {
  assert.equal(parseModelResponse({ proposals: [] }).ok, true)
  for (const opportunities of ['nope', [1], [{ why: 'no question' }], [{ question: 42 }]]) {
    assert.equal(parseModelResponse({ proposals: [], opportunities }).ok, false, JSON.stringify(opportunities))
  }
})

test('an opportunity without a reason is still usable', () => {
  const result = parseModelResponse({ proposals: [], opportunities: [{ question: 'How many beds?' }] })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.opportunities[0].why, '')
})

test('a refusal explains itself without echoing the response', () => {
  const result = parseModelResponse({ proposals: ['x'.repeat(3000)] })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.notEqual(result.reason.trim(), '')
    assert.equal(result.reason.includes('xxxx'), false)
  }
})

test('parsing mutates nothing and needs no network', () => {
  const body = { proposals: ['One.'], opportunities: [{ question: 'Q', why: 'W' }] }
  const before = JSON.stringify(body)
  parseModelResponse(body)
  assert.equal(JSON.stringify(body), before)
})

test('a fact sheet with one fact still builds a usable prompt', () => {
  const tiny = factSheet('s', [[makeFact('f:1', 'employer', 'A Hospital', 'p')]])
  const user = userPrompt({ operation: 'generate-bullets', sheet: tiny })
  assert.ok(user.includes('A Hospital'))
  assert.ok(user.includes('f:1'))
})
