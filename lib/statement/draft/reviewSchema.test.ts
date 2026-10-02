import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_IDS, RUBRIC_VERSION, type CategoryId } from './rubric.ts'
import {
  MAX_REVIEW_FIELD_CHARS,
  MAX_REVIEW_LIST_ITEMS,
  REVIEW_SCHEMA_VERSION,
  parseReview,
  reviewIsStale,
} from './reviewSchema.ts'

/** Prompt alignment owes one entry per requirement the prompt states. */
const components = (statuses: readonly string[] = ['addressed']) =>
  statuses.map((status, i) => ({
    component: `requirement ${i + 1}`,
    status,
    evidence: 'the passage that covers it',
  }))

const category = (id: CategoryId, over: Record<string, unknown> = {}) => ({
  id,
  score: 8,
  evidence: 'I spent three years in a cardiothoracic ICU.',
  evidenceFound: true,
  explanation: 'The example is concrete and tied to the specialty.',
  recommendation: 'Name one case and what you changed because of it.',
  ...(id === 'prompt-alignment' ? { components: components() } : {}),
  ...over,
})

const body = (ids: readonly CategoryId[], over: Record<string, unknown> = {}) => ({
  categories: ids.map((id) => category(id)),
  overallAssessment: 'A solid draft with a clear motivation.',
  strengths: ['Clear motivation'],
  priorities: ['Add a specific clinical example'],
  nextSteps: ['Rewrite the second paragraph'],
  ...over,
})

const SIX = CATEGORY_IDS.filter((id) => id !== 'prompt-alignment')

// ===========================================================================
// THE HAPPY SHAPES
// ===========================================================================

test('a school-specific result parses with all seven categories', () => {
  const parsed = parseReview({ raw: body(CATEGORY_IDS), promptAttached: true })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.review.categories.length, 7)
  assert.equal(parsed.ok && parsed.review.overall, 80)
  assert.equal(parsed.ok && parsed.review.promptAttached, true)
  assert.equal(parsed.ok && parsed.review.schemaVersion, REVIEW_SCHEMA_VERSION)
  assert.equal(parsed.ok && parsed.review.rubricVersion, RUBRIC_VERSION)
})

test('a general result parses with six, and scores the same', () => {
  const parsed = parseReview({ raw: body(SIX), promptAttached: false })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.review.categories.length, 6)
  assert.equal(parsed.ok && parsed.review.overall, 80, 'redistribution, not a penalty')
  assert.equal(
    parsed.ok && parsed.review.categories.some((c) => c.id === 'prompt-alignment'), false,
  )
})

test('the band is DERIVED, and categories come back in rubric order', () => {
  const shuffled = body(CATEGORY_IDS)
  shuffled.categories.reverse()
  const parsed = parseReview({ raw: shuffled, promptAttached: true })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok && parsed.review.categories.map((c) => c.id), CATEGORY_IDS)
  assert.equal(parsed.ok && parsed.review.categories[0].band, 'strong')
})

// ===========================================================================
// THE NUMBERS ARE NOT THE MODEL'S
// ===========================================================================

test('A MODEL-SUPPLIED TOTAL IS IGNORED, never reported', () => {
  // The easiest mistake a model makes, and the hardest for a reader to catch.
  const lying = body(CATEGORY_IDS, { overall: 99, overallScore: 99, total: 99, score: 99 })
  const parsed = parseReview({ raw: lying, promptAttached: true })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.review.overall, 80, 'computed from the categories')
})

test('a model-supplied band is ignored too', () => {
  const lying = body(CATEGORY_IDS)
  lying.categories[0] = { ...lying.categories[0], band: 'strong', score: 1 } as never
  const parsed = parseReview({ raw: lying, promptAttached: true })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.review.categories[0].band, 'needs-improvement')
})

// ===========================================================================
// WHAT IS REFUSED
// ===========================================================================

test('A SCORE OF 4 REFUSES THE RESULT, and is never remapped', () => {
  const four = body(CATEGORY_IDS)
  four.categories[0] = category('motivation', { score: 4 })
  const parsed = parseReview({ raw: four, promptAttached: true })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.ok === false && parsed.reason, 'invalid-score')
})

test('every other impossible score refuses too', () => {
  for (const score of [0, -1, 11, 2.5, '8', null, undefined, NaN]) {
    const bad = body(CATEGORY_IDS)
    bad.categories[0] = category('motivation', { score })
    const parsed = parseReview({ raw: bad, promptAttached: true })
    assert.equal(parsed.ok, false, `score ${String(score)}`)
    assert.equal(parsed.ok === false && parsed.reason, 'invalid-score')
  }
})

test('a general draft scored on prompt alignment is REFUSED, not trimmed', () => {
  // The model was told six and produced seven. Dropping the extra entry would
  // carry on as though the instruction had been followed.
  const parsed = parseReview({ raw: body(CATEGORY_IDS), promptAttached: false })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.ok === false && parsed.reason, 'wrong-category-set')
})

test('a missing category refuses rather than scoring what arrived', () => {
  const parsed = parseReview({ raw: body(SIX.slice(0, 5)), promptAttached: false })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.ok === false && parsed.reason, 'wrong-category-set')
})

test('a duplicated category is refused', () => {
  const dup = body(CATEGORY_IDS)
  dup.categories.push(category('motivation'))
  const parsed = parseReview({ raw: dup, promptAttached: true })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.ok === false && parsed.reason, 'duplicate-category')
})

test('an unknown category id is refused', () => {
  const alien = body(CATEGORY_IDS)
  alien.categories[0] = category('hook-strength' as CategoryId)
  const parsed = parseReview({ raw: alien, promptAttached: true })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.ok === false && parsed.reason, 'unknown-category')
})

test('evidence, explanation and recommendation are all required', () => {
  for (const missing of ['evidence', 'explanation', 'recommendation']) {
    for (const value of ['', '   ', null, 42, undefined]) {
      const bad = body(CATEGORY_IDS)
      bad.categories[0] = category('motivation', { [missing]: value })
      const parsed = parseReview({ raw: bad, promptAttached: true })
      assert.equal(parsed.ok, false, `${missing}=${String(value)}`)
      assert.equal(parsed.ok === false && parsed.reason, 'missing-text')
    }
  }
})

test('a summary with no strengths, priorities or next steps is refused', () => {
  for (const key of ['overallAssessment', 'strengths', 'priorities', 'nextSteps']) {
    const bad = body(CATEGORY_IDS, { [key]: key === 'overallAssessment' ? '' : [] })
    const parsed = parseReview({ raw: bad, promptAttached: true })
    assert.equal(parsed.ok, false, key)
    assert.equal(parsed.ok === false && parsed.reason, 'missing-summary')
  }
})

test('nonsense at the top level is refused, not coerced', () => {
  for (const raw of [null, undefined, 'a result', 42, []]) {
    const parsed = parseReview({ raw, promptAttached: true })
    assert.equal(parsed.ok, false, String(raw))
  }
  assert.equal(
    parseReview({ raw: { categories: 'seven of them' }, promptAttached: true }).ok === false
      && parseReview({ raw: { categories: 'x' }, promptAttached: true }).reason,
    'categories-not-a-list',
  )
})

// ===========================================================================
// MISSING IS NOT WEAK
// ===========================================================================

test('evidence is "not found" unless the model says otherwise', () => {
  // Defaulting to found would let a missing quotation read as present-but-weak.
  // Scored 3 here, because the consistency rule below refuses an absence in the
  // Strong band -- the two rules interact and this isolates the first.
  const silent = body(CATEGORY_IDS)
  silent.categories[0] = category('motivation', { evidenceFound: undefined, score: 3 })
  const parsed = parseReview({ raw: silent, promptAttached: true })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.review.categories[0].evidenceFound, false)

  for (const truthy of ['true', 1, {}, 'yes']) {
    const loose = body(CATEGORY_IDS)
    loose.categories[0] = category('motivation', { evidenceFound: truthy, score: 3 })
    const read = parseReview({ raw: loose, promptAttached: true })
    assert.equal(read.ok && read.review.categories[0].evidenceFound, false, String(truthy))
  }
})

test('STRONG CANNOT MEAN "the material is absent"', () => {
  // The contradiction that produced "9/10, but you never describe a patient
  // encounter". A low score with absent material is coherent; a high one is not.
  for (const score of [8, 9, 10]) {
    const bad = body(CATEGORY_IDS)
    bad.categories[1] = category('clinical-experience', { score, evidenceFound: false })
    const parsed = parseReview({ raw: bad, promptAttached: true })
    assert.equal(parsed.ok, false, `score ${score}`)
    assert.equal(parsed.ok === false && parsed.reason, 'inconsistent-score')
  }
  // Below the Strong band it is perfectly coherent.
  for (const score of [1, 3, 5, 7]) {
    const fine = body(CATEGORY_IDS)
    fine.categories[1] = category('clinical-experience', { score, evidenceFound: false })
    assert.equal(parseReview({ raw: fine, promptAttached: true }).ok, true, `score ${score}`)
  }
})

test('A 10 CANNOT CONTRADICT ITS OWN COMPONENT BREAKDOWN', () => {
  // The Arkansas State failure: one quoted sentence, a 10/10, and a
  // requirement about expected contribution that the essay never addressed.
  for (const status of ['missing', 'weak']) {
    const bad = body(CATEGORY_IDS)
    bad.categories[6] = category('prompt-alignment', {
      score: 10,
      components: components(['addressed', status]),
    })
    const parsed = parseReview({ raw: bad, promptAttached: true })
    assert.equal(parsed.ok, false, status)
    assert.equal(parsed.ok === false && parsed.reason, 'inconsistent-score')
  }
  // A 10 with everything addressed is accepted: the score is not capped.
  const good = body(CATEGORY_IDS)
  good.categories[6] = category('prompt-alignment', {
    score: 10, components: components(['addressed', 'addressed', 'addressed']),
  })
  assert.equal(parseReview({ raw: good, promptAttached: true }).ok, true)
  // And a lower score with a gap is exactly what should happen.
  const honest = body(CATEGORY_IDS)
  honest.categories[6] = category('prompt-alignment', {
    score: 6, components: components(['addressed', 'missing']),
  })
  assert.equal(parseReview({ raw: honest, promptAttached: true }).ok, true)
})

test('prompt alignment must break the prompt into its requirements', () => {
  for (const broken of [undefined, [], 'three of them', [{}],
                        [{ component: 'x', status: 'nope', evidence: 'y' }],
                        [{ component: '', status: 'addressed', evidence: 'y' }]]) {
    const bad = body(CATEGORY_IDS)
    bad.categories[6] = category('prompt-alignment', { score: 7, components: broken })
    const parsed = parseReview({ raw: bad, promptAttached: true })
    assert.equal(parsed.ok, false, JSON.stringify(broken))
    assert.equal(parsed.ok === false && parsed.reason, 'missing-components')
  }
})

test('no other category carries components', () => {
  const stray = body(CATEGORY_IDS)
  stray.categories[0] = category('motivation', { components: components(['missing']) })
  const parsed = parseReview({ raw: stray, promptAttached: true })
  assert.equal(parsed.ok, true, 'ignored, not refused')
  assert.deepEqual(parsed.ok && parsed.review.categories[0].components, [])
})

test('A FABRICATED QUOTATION REFUSES THE RESULT', () => {
  // Telling an applicant "you wrote X" about something they did not write.
  const essay = 'I spent three years in a cardiothoracic ICU, mostly post-op CABG patients.'
  const lying = body(CATEGORY_IDS)
  lying.categories[0] = category('motivation', {
    evidence: '"I led a rapid response team through twelve cardiac arrests last year."',
  })
  const parsed = parseReview({ raw: lying, promptAttached: true, essay })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.ok === false && parsed.reason, 'fabricated-quote')

  // A genuine one passes, re-wrapped and re-punctuated.
  const honest = body(CATEGORY_IDS)
  honest.categories[0] = category('motivation', {
    evidence: 'You write: "I spent three years in a cardiothoracic   ICU".',
  })
  assert.equal(parseReview({ raw: honest, promptAttached: true, essay }).ok, true)
})

test('quotations are only checked when the model claims to have quoted', () => {
  const essay = 'Nothing in here matches.'
  const absent = body(CATEGORY_IDS)
  absent.categories[0] = category('motivation', {
    score: 3,
    evidenceFound: false,
    evidence: 'The draft never states why anesthesia rather than another speciality.',
  })
  assert.equal(parseReview({ raw: absent, promptAttached: true, essay }).ok, true)
  // And omitting the essay skips the check entirely, for the sample builder.
  const lying = body(CATEGORY_IDS)
  lying.categories[0] = category('motivation', { evidence: '"a sentence that is not there at all"' })
  assert.equal(parseReview({ raw: lying, promptAttached: true }).ok, true)
})

// ===========================================================================
// BOUNDS ON MODEL PROSE
// ===========================================================================

test('overlong prose is capped rather than refused', () => {
  const long = body(CATEGORY_IDS)
  long.categories[0] = category('motivation', { evidence: 'x'.repeat(MAX_REVIEW_FIELD_CHARS + 500) })
  const parsed = parseReview({ raw: long, promptAttached: true })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.review.categories[0].evidence.length, MAX_REVIEW_FIELD_CHARS)
})

test('lists are capped and non-strings dropped', () => {
  const many = body(CATEGORY_IDS, {
    strengths: [...Array(20)].map((_, i) => `point ${i}`),
    priorities: ['real', null, 42, '', '  ', 'also real'],
  })
  const parsed = parseReview({ raw: many, promptAttached: true })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.review.strengths.length, MAX_REVIEW_LIST_ITEMS)
  assert.deepEqual(parsed.ok && parsed.review.priorities, ['real', 'also real'])
})

test('control characters are stripped, not treated as a failure', () => {
  const noisy = body(CATEGORY_IDS)
  noisy.categories[0] = category('motivation', { evidence: 'a quote\u0000with\u0007noise' })
  const parsed = parseReview({ raw: noisy, promptAttached: true })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.review.categories[0].evidence, 'a quotewithnoise')
})

// ===========================================================================
// STALENESS
// ===========================================================================

test('a result about the current draft is not stale', () => {
  assert.equal(reviewIsStale({
    analyzedRevision: 4, analyzedEssay: 'the essay',
    currentRevision: 4, currentEssay: 'the essay',
  }), false)
})

test('typing during the request makes the result stale', () => {
  // The revision has not moved yet -- autosave has not flushed -- but the
  // result is already about something the applicant has edited past.
  assert.equal(reviewIsStale({
    analyzedRevision: 4, analyzedEssay: 'the essay',
    currentRevision: 4, currentEssay: 'the essay, now longer',
  }), true)
})

test('a save landing elsewhere makes the result stale', () => {
  assert.equal(reviewIsStale({
    analyzedRevision: 4, analyzedEssay: 'the essay',
    currentRevision: 5, currentEssay: 'the essay',
  }), true)
})

test('staleness is about identity, not about length or whitespace', () => {
  assert.equal(reviewIsStale({
    analyzedRevision: 1, analyzedEssay: 'word',
    currentRevision: 1, currentEssay: 'word ',
  }), true, 'a trailing space is a change')
})
