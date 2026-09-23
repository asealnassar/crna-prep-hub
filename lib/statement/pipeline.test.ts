import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisSystemPrompt, buildRewriteUserMessage } from './prompts.ts'
import { parseAnalysis, redactForTier, reviewNotesFrom } from './analysis.ts'
import { canRewrite, canSeeSentenceAnalysis, canSeeSuggestions } from './entitlement.ts'
import { signAnalysis, verifyAnalysisToken } from './signing.ts'
import { checkStatement } from './limits.ts'

/**
 * Per-tier composition, exercised as a pipeline.
 *
 * WHAT THIS IS, PRECISELY. It runs the same functions the route runs, in the
 * same order, with the same arguments, and asserts what each tier ends up
 * holding. It is NOT a live authenticated request: there is no session, no
 * database and no model. route.test.ts is what proves the route composes these
 * in this order; this is what proves the composition produces the right answer.
 *
 * Live authenticated verification is scripts/verify-statement-e2e.mjs, which
 * has to be run by someone who can sign in.
 */

const TIERS = ['free', 'premium', 'ultimate'] as const

const STATEMENT =
  'The night I watched a charge nurse talk a family through a withdrawal of care, ' +
  'I understood that anaesthesia was where I wanted to be. '.repeat(3)

/** What the model would return when asked for everything. */
const FULL_COMPLETION = JSON.stringify({
  categories: [
    { name: 'Hook Strength', score: 6, feedback: 'Opens on a cliche.', suggestion: 'Open on the withdrawal of care.' },
    { name: 'Motivation for CRNA', score: 8, feedback: 'Specific and earned.', suggestion: 'Name the moment.' },
    { name: 'Clinical Depth', score: 7, feedback: 'Real but thin.', suggestion: 'Say what you did.' },
    { name: 'Personal Uniqueness', score: 5, feedback: 'Interchangeable.', suggestion: 'Keep the family scene.' },
    { name: 'Structure & Flow', score: 7, feedback: 'Reads cleanly.', suggestion: 'Cut paragraph four.' },
    { name: 'Red Flags', score: 9, feedback: 'Nothing concerning.', suggestion: 'None needed.' },
  ],
  admissionsImpression: 'Competent, not yet memorable.',
  biggestWeaknesses: ['Generic opening', 'Thin clinical detail', 'Flat close'],
  topChanges: ['Rewrite the hook', 'Expand the ICU work', 'Cut the summary'],
  sentenceAnalysis: [
    { original: 'I have always wanted to help people.', label: 'Weak', improved: 'That night set the direction.' },
    { original: 'I thrive under pressure.', label: 'Generic', improved: 'I took the airway while the room filled.' },
    { original: 'The family thanked me.', label: 'Strong', improved: 'The family thanked me by name.' },
  ],
})

const KEY = Buffer.from('pipeline-test-signing-key-long-enough', 'utf8')
const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** Exactly what POST does, in order. */
function analyse(tier: string) {
  const checked = checkStatement(STATEMENT)
  assert.equal(checked.ok, true)
  if (!checked.ok) throw new Error('unreachable')

  const includeSuggestions = canSeeSuggestions(tier)
  const includeSentenceAnalysis = canSeeSentenceAnalysis(tier)

  // The prompt this tier would be sent.
  const prompt = analysisSystemPrompt({ includeSuggestions, includeSentenceAnalysis })

  // The model answers with everything, whatever it was asked. That is the
  // point: the entitlement must not depend on the model's cooperation.
  const parsed = parseAnalysis(FULL_COMPLETION, { includeSuggestions, includeSentenceAnalysis })
  assert.equal(parsed.ok, true, tier)
  if (!parsed.ok) throw new Error('unreachable')

  const analysis = redactForTier(parsed.value, tier)
  const token = signAnalysis({ userId: USER, statement: checked.statement, analysis, key: KEY })
  return { prompt, analysis, token, statement: checked.statement }
}

// =====================================================================
// Free
// =====================================================================

test('Free receives the score, the categories and the feedback — and nothing more', () => {
  const { analysis } = analyse('free')
  assert.equal(analysis.overallScore, 70)
  assert.equal(analysis.categories.length, 6)
  assert.equal(analysis.admissionsImpression, 'Competent, not yet memorable.')
  assert.equal(analysis.biggestWeaknesses.length, 3)
  assert.equal(analysis.topChanges.length, 3)

  const wire = JSON.stringify(analysis)
  assert.doesNotMatch(wire, /suggestion/)
  assert.doesNotMatch(wire, /sentenceAnalysis/)
  // The words of a paid suggestion must not appear anywhere on the wire.
  assert.doesNotMatch(wire, /Open on the withdrawal of care/)
  assert.doesNotMatch(wire, /That night set the direction/)
})

test('Free is never even asked for the paid fields, so they are never billed', () => {
  const { prompt } = analyse('free')
  assert.doesNotMatch(prompt, /"suggestion"/)
  assert.doesNotMatch(prompt, /sentenceAnalysis/)
})

test('Free cannot rewrite', () => {
  assert.equal(canRewrite('free'), false)
})

// =====================================================================
// Premium — identical to Free, as advertised
// =====================================================================

test('Premium receives exactly what Free receives', () => {
  const free = analyse('free')
  const premium = analyse('premium')
  assert.deepEqual(premium.analysis, free.analysis)
  assert.equal(premium.prompt, free.prompt)
  assert.equal(canRewrite('premium'), false)
})

// =====================================================================
// Ultimate
// =====================================================================

test('Ultimate receives the suggestions and the sentence feedback', () => {
  const { analysis } = analyse('ultimate')
  assert.equal(analysis.categories[0].suggestion, 'Open on the withdrawal of care.')
  assert.equal(analysis.sentenceAnalysis?.length, 3)
  assert.equal(canRewrite('ultimate'), true)
})

test('Ultimate’s rewrite is built only from the validated analysis', () => {
  const { analysis, statement, token } = analyse('ultimate')

  // The route re-validates the returned analysis before using it.
  const revalidated = parseAnalysis(JSON.stringify(analysis), {
    includeSuggestions: true, includeSentenceAnalysis: true,
  })
  assert.equal(revalidated.ok, true)
  if (!revalidated.ok) return

  assert.equal(
    verifyAnalysisToken({ token, userId: USER, statement, analysis, key: KEY }).ok,
    true,
    'a legitimate Ultimate rewrite must verify'
  )

  const message = buildRewriteUserMessage(statement, reviewNotesFrom(revalidated.value))
  assert.match(message, /Open on the withdrawal of care/)
  // A Strong sentence is not an improvement and is left out.
  assert.doesNotMatch(message, /The family thanked me by name/)
})

// =====================================================================
// Cross-tier
// =====================================================================

test('no tier can reach another tier’s output by replaying a token', () => {
  const free = analyse('free')
  const ultimate = analyse('ultimate')

  // A Free user holding a Free token cannot present the richer Ultimate
  // analysis with it: the signature covers the content.
  assert.equal(
    verifyAnalysisToken({
      token: free.token, userId: USER, statement: free.statement,
      analysis: ultimate.analysis, key: KEY,
    }).ok,
    false
  )
})

test('every tier gets a real score, and the score does not depend on the tier', () => {
  const scores = TIERS.map((tier) => analyse(tier).analysis.overallScore)
  assert.deepEqual(scores, [70, 70, 70], 'the score must not be a paid feature')
})

test('Red Flags scores in the same direction as everything else', () => {
  // 9/10 for "nothing concerning" must lift the composite, not sink it.
  const { analysis } = analyse('free')
  const redFlags = analysis.categories.find((c) => c.name === 'Red Flags')
  assert.equal(redFlags?.score, 9)
  assert.ok(analysis.overallScore > 60)
})
