/**
 * AI-QA-002 and AI-QA-004: evidence must be provable, and the shape the model
 * is shown must be the shape the validator accepts.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * AI-QA-002. `evidenceFound: true` was an assertion nothing checked. The only
 * verification scanned `evidence` for double-quoted spans of at least 25
 * characters, so a model that claimed evidence and then described it in plain
 * prose -- "Your essay contains strong material for this category" -- was
 * believed at any score. Driven through the real route against a mock, that
 * produced a validated 200 with overall 90/100 and six Strong bands over an
 * essay nothing had been quoted from.
 *
 * AI-QA-004. The system prompt ended "Reply with JSON only, in exactly this
 * shape:" and a literal object that omitted `components` -- which the
 * validator REQUIRES on prompt-alignment. A model following the example
 * exactly produced a response the server refused, and the refusal still cost
 * the applicant part of their burst allowance.
 *
 * Both are now structural: the claim lives in a field that is verified, and
 * the example is GENERATED from the module that enforces it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPONENT_STATUSES, REVIEW_SCHEMA_VERSION, parseReview, reviewResponseShape,
  reviewResponseSpecimen,
} from './reviewSchema.ts'
import { CATEGORY_IDS, categoriesFor } from './rubric.ts'
import { MIN_VERIFIABLE_QUOTE_CHARS, isEssayExcerpt } from './evidence.ts'
import { reviewSystemPrompt } from './reviewPrompt.ts'

const ESSAY = [
  'I spent three years in a cardiothoracic intensive care unit at a county hospital.',
  'One evening a post-operative valve patient began to decompensate and I called',
  'the intensivist before the numbers justified it. She told me afterwards that the',
  'early call was the reason the night ended the way it did.',
].join(' ')

const EXCERPT = 'I called the intensivist before the numbers justified it'

/** A valid response, with one category overridden. */
function body(promptAttached: boolean, over: Record<string, unknown> = {}) {
  const base = reviewResponseSpecimen({
    promptAttached, excerpt: EXCERPT, components: ['Why anesthesia', 'What you will bring'],
  })
  const categories = (base.categories as Record<string, unknown>[]).map((row, i) =>
    i === 0 ? { ...row, ...over } : row)
  return { ...base, categories }
}

const reason = (raw: unknown, promptAttached = true) => {
  const parsed = parseReview({ raw, promptAttached, essay: ESSAY })
  return parsed.ok ? 'ACCEPTED' : parsed.reason
}

// ===========================================================================
// AI-QA-002 -- the matrix
// ===========================================================================

test('a valid exact excerpt is accepted', () => {
  assert.equal(reason(body(true)), 'ACCEPTED')
  const parsed = parseReview({ raw: body(true), promptAttached: true, essay: ESSAY })
  assert.ok(parsed.ok)
  assert.equal(parsed.review.categories[0]!.excerpt, EXCERPT)
  assert.equal(parsed.review.categories[0]!.evidenceFound, true)
})

test('ORDINARY PUNCTUATION AND WRAPPING DIFFERENCES ARE FORGIVEN, and only those', () => {
  /*
   * THE DOCUMENTED NORMALISATION RULE: whitespace runs collapsed, ends
   * trimmed, case folded, typographic quotes and dashes folded to ASCII.
   * Those are two renderings of one sentence. Nothing else is forgiven.
   */
  for (const variant of [
    EXCERPT,
    EXCERPT.toUpperCase(),
    EXCERPT.replace(/ /g, '  '),
    `  ${EXCERPT}\n`,
    EXCERPT.replace('intensivist', 'intensivist'),
  ]) {
    assert.equal(reason(body(true, { excerpt: variant })), 'ACCEPTED',
      `rejected a legitimate rendering: ${JSON.stringify(variant)}`)
  }
  // A WORD CHANGED IS A DIFFERENT SENTENCE.
  for (const altered of [
    EXCERPT.replace('intensivist', 'attending'),
    EXCERPT.replace('before', 'after'),
    `${EXCERPT} and she agreed`,
    EXCERPT.split(' ').reverse().join(' '),
  ]) {
    assert.equal(reason(body(true, { excerpt: altered })), 'unverifiable-evidence',
      `accepted an altered excerpt: ${JSON.stringify(altered)}`)
  }
  // AND NO ELLIPSIS, so fragments cannot be stitched into a passage.
  assert.equal(
    reason(body(true, { excerpt: 'I spent three years ... the way it did.' })),
    'unverifiable-evidence')
})

test('an INVENTED QUOTED experience is rejected', () => {
  assert.equal(reason(body(true, {
    excerpt: 'I single-handedly resuscitated a patient in the trauma bay',
  })), 'unverifiable-evidence')
})

test('an INVENTED UNQUOTED experience with evidenceFound=true is rejected', () => {
  // THE CASE THAT USED TO PASS AT ANY SCORE, including 9 and 10.
  for (const score of [3, 7, 9, 10]) {
    assert.equal(reason(body(true, {
      score,
      evidenceFound: true,
      excerpt: null,
      evidence: 'You describe leading a rapid response team through a cardiac arrest.',
    })), 'unverifiable-evidence', `score ${score}`)
  }
})

test('a GENERIC claim of evidence is rejected', () => {
  // The exact response that returned 90/100 in the audit.
  assert.equal(reason(body(true, {
    score: 9,
    evidenceFound: true,
    excerpt: null,
    evidence: 'Your essay contains strong material for this category.',
  })), 'unverifiable-evidence')
  // And with the generic sentence placed in the excerpt field instead.
  assert.equal(reason(body(true, {
    score: 9,
    evidenceFound: true,
    excerpt: 'Your essay contains strong material for this category.',
  })), 'unverifiable-evidence')
})

test('evidenceFound=false while supplying evidence is rejected', () => {
  assert.equal(reason(body(true, {
    score: 3, evidenceFound: false, excerpt: EXCERPT,
  })), 'contradictory-evidence')
})

test('an absence is accepted when it IS an absence', () => {
  assert.equal(reason(body(true, {
    score: 3,
    evidenceFound: false,
    excerpt: null,
    evidence: 'The draft never says why anesthesia rather than another speciality.',
  })), 'ACCEPTED')
})

test('a fabricated quotation inside an ABSENCE is still rejected', () => {
  // Prose is checked in both states now: an invented quotation inside a
  // description of what is missing is exactly as misleading.
  assert.equal(reason(body(true, {
    score: 3,
    evidenceFound: false,
    excerpt: null,
    evidence: 'You only say "I led the resuscitation effort in the trauma bay that night".',
  })), 'fabricated-quote')
})

test('a missing RATIONALE is rejected', () => {
  assert.equal(reason(body(true, { explanation: '' })), 'missing-text')
  assert.equal(reason(body(true, { explanation: '   ' })), 'missing-text')
  const stripped = body(true) as Record<string, unknown>
  delete (stripped.categories as Record<string, unknown>[])[0]!.explanation
  assert.equal(reason(stripped), 'missing-text')
})

test('a missing IMPROVEMENT is rejected', () => {
  assert.equal(reason(body(true, { recommendation: '' })), 'missing-text')
  const stripped = body(true) as Record<string, unknown>
  delete (stripped.categories as Record<string, unknown>[])[0]!.recommendation
  assert.equal(reason(stripped), 'missing-text')
})

test('EVIDENCE FROM ANOTHER ESSAY is rejected', () => {
  // A span that is real prose, and real in some other applicant's draft.
  const theirs = 'I worked nights in a neonatal unit for five years before applying'
  assert.ok(!ESSAY.includes(theirs))
  assert.equal(reason(body(true, { excerpt: theirs })), 'unverifiable-evidence')
})

test('an excerpt too short to verify is not a verification', () => {
  const tiny = ESSAY.slice(0, MIN_VERIFIABLE_QUOTE_CHARS - 1)
  assert.ok(ESSAY.includes(tiny), 'the fixture must be genuinely present')
  assert.equal(isEssayExcerpt({ excerpt: tiny, essay: ESSAY }), false)
  assert.equal(reason(body(true, { excerpt: tiny })), 'unverifiable-evidence')
})

test('the schema version moved, so every cached analysis is invalidated', () => {
  // The fingerprint carries it, so a result produced under the old contract
  // cannot be served as one produced under this.
  assert.equal(REVIEW_SCHEMA_VERSION, 'statement-review-v2')
})

// ===========================================================================
// AI-QA-004 -- the example IS the contract
// ===========================================================================

test('AI-QA-004 the documented example satisfies the validator it is shown for', () => {
  /*
   * THE REGRESSION THAT WOULD HAVE CAUGHT IT. The example is generated from
   * reviewSchema, and this test fills its placeholders with real values and
   * parses the result -- so a field the validator requires and the example
   * omits fails here instead of reaching an applicant as a 502.
   */
  for (const promptAttached of [true, false]) {
    const shape = reviewResponseShape(promptAttached)
    const expected = categoriesFor(promptAttached).map((c) => c.id)

    // Every category the rubric expects appears in the example, once.
    for (const id of expected) {
      assert.equal(shape.split(`"id": "${id}"`).length - 1, 1,
        `${id} appears ${shape.split(`"id": "${id}"`).length - 1} times`)
    }
    // And none it does not.
    for (const id of CATEGORY_IDS.filter((c) => !expected.includes(c))) {
      assert.ok(!shape.includes(`"id": "${id}"`), `${id} must not be offered`)
    }
    // THE FIELD THE EXAMPLE USED TO OMIT.
    assert.equal(shape.includes('"components"'), promptAttached,
      promptAttached ? 'components is missing from the example'
        : 'components must not appear without a prompt')
    // Every field the validator reads is named.
    for (const field of ['"score"', '"evidenceFound"', '"excerpt"', '"evidence"',
      '"explanation"', '"recommendation"', '"overallAssessment"', '"strengths"',
      '"priorities"', '"nextSteps"']) {
      assert.ok(shape.includes(field), `${field} missing for promptAttached=${promptAttached}`)
    }
    // And the statuses offered are exactly the ones accepted.
    if (promptAttached) {
      assert.ok(shape.includes(COMPONENT_STATUSES.join(' | ')))
    }

    // THE SPECIMEN IS THE SAME SHAPE WITH REAL VALUES, and it parses.
    const parsed = parseReview({
      raw: reviewResponseSpecimen({ promptAttached, excerpt: EXCERPT }),
      promptAttached,
      essay: ESSAY,
    })
    assert.ok(parsed.ok, parsed.ok ? '' : `the documented shape is refused: ${parsed.reason}`)
    assert.equal(parsed.review.categories.length, expected.length)
    assert.equal(parsed.review.promptAttached, promptAttached)
  }
})

test('AI-QA-004 the system prompt shows the GENERATED shape, not a second copy', () => {
  for (const promptAttached of [true, false]) {
    const prompt = reviewSystemPrompt(promptAttached, null)
    assert.ok(prompt.includes(reviewResponseShape(promptAttached)),
      `the prompt does not render the generated shape for promptAttached=${promptAttached}`)
  }
})

test('school-specific is SEVEN and general is SIX, and only one carries components', () => {
  assert.equal(categoriesFor(true).length, 7)
  assert.equal(categoriesFor(false).length, 6)
  const school = parseReview({
    raw: reviewResponseSpecimen({ promptAttached: true, excerpt: EXCERPT }),
    promptAttached: true, essay: ESSAY,
  })
  assert.ok(school.ok)
  const withComponents = school.review.categories.filter((c) => c.components.length > 0)
  assert.deepEqual(withComponents.map((c) => c.id), ['prompt-alignment'])

  const general = parseReview({
    raw: reviewResponseSpecimen({ promptAttached: false, excerpt: EXCERPT }),
    promptAttached: false, essay: ESSAY,
  })
  assert.ok(general.ok)
  assert.equal(general.review.categories.filter((c) => c.components.length > 0).length, 0)
  assert.ok(!general.review.categories.some((c) => c.id === 'prompt-alignment'))
})
