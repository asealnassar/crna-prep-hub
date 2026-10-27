import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BAND_LABELS,
  CATEGORY_IDS,
  MIN_ANALYSIS_WORDS,
  NOT_ASSESSED,
  RUBRIC,
  RUBRIC_VERSION,
  SHORT_PROMPT_CEILING,
  VALID_SCORES,
  bandFor,
  categoriesFor,
  eligibilityFor,
  isCategoryId,
  isValidScore,
  overLimit,
  overallScore,
  weightsFor,
  type CategoryId,
} from './rubric.ts'

const scoresOf = (value: number, ids: readonly CategoryId[] = CATEGORY_IDS) =>
  new Map(ids.map((id) => [id, value]))

// ===========================================================================
// THE RUBRIC ITSELF
// ===========================================================================

test('the approved weights, exactly, and they total 100', () => {
  assert.deepEqual(
    RUBRIC.map((c) => [c.id, c.weight]),
    [
      ['motivation', 20],
      ['clinical-experience', 20],
      ['reflection-growth', 20],
      ['understanding-goals', 15],
      ['organization-flow', 10],
      ['writing-quality', 5],
      ['prompt-alignment', 10],
    ],
  )
  assert.equal(RUBRIC.reduce((sum, c) => sum + c.weight, 0), 100)
})

test('exactly one category needs a prompt', () => {
  const needing = RUBRIC.filter((c) => c.needsPrompt)
  assert.equal(needing.length, 1)
  assert.equal(needing[0].id, 'prompt-alignment')
})

test('identifiers are unique, stable and recognised', () => {
  assert.equal(new Set(CATEGORY_IDS).size, 7)
  for (const id of CATEGORY_IDS) assert.equal(isCategoryId(id), true)
  for (const bad of ['Motivation', 'motivation ', '', 'hook-strength', null, 7, {}]) {
    assert.equal(isCategoryId(bad), false, String(bad))
  }
})

test('the version is carried so an older result cannot be reread under new weights', () => {
  assert.equal(RUBRIC_VERSION, 'statement-rubric-v1')
})

// ===========================================================================
// SCORES AND BANDS
// ===========================================================================

test('FOUR IS NOT A SCORE, and is neither banded nor remapped', () => {
  // The approved bands are 1-3, 5-7 and 8-10. A 4 belongs to none, so it is
  // refused rather than invented a band for or nudged to 3 or 5.
  assert.equal(VALID_SCORES.includes(4), false)
  assert.equal(isValidScore(4), false)
  assert.equal(bandFor(4), null)
})

test('every valid score has exactly one band', () => {
  for (const score of VALID_SCORES) {
    const band = bandFor(score)
    assert.notEqual(band, null, `${score} must band`)
    assert.ok(band !== null && band in BAND_LABELS)
  }
  assert.equal(bandFor(1), 'needs-improvement')
  assert.equal(bandFor(3), 'needs-improvement')
  assert.equal(bandFor(5), 'developing')
  assert.equal(bandFor(7), 'developing')
  assert.equal(bandFor(8), 'strong')
  assert.equal(bandFor(10), 'strong')
})

test('nothing outside 1-10 is a score, and nothing fractional is', () => {
  for (const bad of [0, -1, 11, 4, 2.5, NaN, Infinity, '7', null, undefined, {}]) {
    assert.equal(isValidScore(bad), false, String(bad))
  }
  for (const bad of [0, 11, 2.5, NaN]) assert.equal(bandFor(bad as number), null)
})

test('the three approved band names, and no fourth', () => {
  assert.deepEqual(Object.values(BAND_LABELS), ['Needs Improvement', 'Developing', 'Strong'])
})

// ===========================================================================
// WHICH CATEGORIES APPLY
// ===========================================================================

test('a school-specific draft is scored on seven, a general one on six', () => {
  assert.equal(categoriesFor(true).length, 7)
  assert.equal(categoriesFor(false).length, 6)
  assert.equal(categoriesFor(false).some((c) => c.id === 'prompt-alignment'), false)
})

test('A GENERAL STATEMENT IS NOT PENALISED FOR BEING ONE', () => {
  // Leaving the other six at their original weights would cap a flawless
  // general statement at 90% -- scoring somebody down for a choice the product
  // offered them. The missing ten points are redistributed instead.
  const weights = weightsFor(false)
  assert.equal(weights.size, 6)
  assert.equal(weights.has('prompt-alignment'), false)
  const total = [...weights.values()].reduce((sum, w) => sum + w, 0)
  assert.ok(Math.abs(total - 100) < 1e-9, `weights total ${total}`)
})

test('redistribution is proportional, not equal', () => {
  const weights = weightsFor(false)
  // 20 of 90 becomes 22.22...; 5 of 90 becomes 5.55...
  assert.ok(Math.abs((weights.get('motivation') ?? 0) - (2000 / 90)) < 1e-9)
  assert.ok(Math.abs((weights.get('writing-quality') ?? 0) - (500 / 90)) < 1e-9)
  // The ratios the rubric set are preserved exactly.
  assert.ok(Math.abs((weights.get('motivation') ?? 0) / (weights.get('writing-quality') ?? 1) - 4) < 1e-9)
})

test('with a prompt, the weights are the rubric unchanged', () => {
  const weights = weightsFor(true)
  assert.equal(weights.size, 7)
  for (const category of RUBRIC) {
    assert.ok(Math.abs((weights.get(category.id) ?? 0) - category.weight) < 1e-9, category.id)
  }
})

// ===========================================================================
// THE HEADLINE NUMBER
// ===========================================================================

test('all eights give 80, with or without a prompt', () => {
  // The property that makes a general score comparable with a school-specific
  // one: the redistribution changes the weights, never the achievable range.
  assert.equal(overallScore({ scores: scoresOf(8), promptAttached: true }), 80)
  assert.equal(
    overallScore({
      scores: scoresOf(8, CATEGORY_IDS.filter((id) => id !== 'prompt-alignment')),
      promptAttached: false,
    }),
    80,
  )
})

test('the floor and ceiling are reachable from both shapes', () => {
  const six = CATEGORY_IDS.filter((id) => id !== 'prompt-alignment')
  assert.equal(overallScore({ scores: scoresOf(10), promptAttached: true }), 100)
  assert.equal(overallScore({ scores: scoresOf(10, six), promptAttached: false }), 100)
  assert.equal(overallScore({ scores: scoresOf(1), promptAttached: true }), 10)
  assert.equal(overallScore({ scores: scoresOf(1, six), promptAttached: false }), 10)
})

test('the weighting actually weights', () => {
  // A 10 in the 20-point category must move the total more than a 10 in the
  // 5-point one.
  const base = scoresOf(5)
  const heavy = new Map(base).set('motivation', 10)
  const light = new Map(base).set('writing-quality', 10)
  const heavyScore = overallScore({ scores: heavy, promptAttached: true }) ?? 0
  const lightScore = overallScore({ scores: light, promptAttached: true }) ?? 0
  assert.ok(heavyScore > lightScore, `${heavyScore} should exceed ${lightScore}`)
  assert.equal(heavyScore, 60)
  assert.equal(lightScore, 53)
})

test('A MISSING CATEGORY SCORES NOTHING, rather than scoring what arrived', () => {
  // A percentage over five of six categories is not this applicant's score.
  const partial = scoresOf(8, CATEGORY_IDS.filter((id) => id !== 'organization-flow'))
  assert.equal(overallScore({ scores: partial, promptAttached: true }), null)
  // And a general draft still needs all six.
  assert.equal(overallScore({ scores: new Map(), promptAttached: false }), null)
})

test('an invalid score anywhere refuses the whole total', () => {
  for (const bad of [4, 0, 11, 2.5]) {
    const scores = new Map(scoresOf(8)).set('motivation', bad)
    assert.equal(overallScore({ scores, promptAttached: true }), null, `score ${bad}`)
  }
})

test('a prompt-alignment score is ignored when no prompt is attached', () => {
  const six = CATEGORY_IDS.filter((id) => id !== 'prompt-alignment')
  const withStray = new Map(scoresOf(8, six)).set('prompt-alignment', 1)
  assert.equal(overallScore({ scores: withStray, promptAttached: false }), 80)
})

test('the not-assessed wording says why, without implying a deduction', () => {
  assert.equal(NOT_ASSESSED, 'Not assessed — no school prompt attached.')
  assert.equal(/\b0\b|zero|penal/i.test(NOT_ASSESSED), false)
})

// ===========================================================================
// ELIGIBILITY
// ===========================================================================

test('an ordinary statement needs 100 words', () => {
  assert.equal(MIN_ANALYSIS_WORDS, 100)
  assert.deepEqual(eligibilityFor({ words: 100, statedMaxWords: null }),
    { kind: 'eligible', minimumWords: 100 })
  assert.deepEqual(eligibilityFor({ words: 99, statedMaxWords: null }),
    { kind: 'too-short', minimumWords: 100, words: 99 })
})

test('a school asking for 1,000 words does not lower the floor', () => {
  assert.deepEqual(eligibilityFor({ words: 100, statedMaxWords: 1000 }),
    { kind: 'eligible', minimumWords: 100 })
  assert.equal(eligibilityFor({ words: 60, statedMaxWords: 1000 }).kind, 'too-short')
})

test('a short prompt lowers the floor to 80% of its maximum', () => {
  // A school asking for 60 words would make a 100-word floor impossible.
  assert.deepEqual(eligibilityFor({ words: 48, statedMaxWords: 60 }),
    { kind: 'eligible', minimumWords: 48 })
  assert.deepEqual(eligibilityFor({ words: 47, statedMaxWords: 60 }),
    { kind: 'too-short', minimumWords: 48, words: 47 })
  // Rounded UP, so the floor is never below four fifths of the answer.
  assert.equal(eligibilityFor({ words: 0, statedMaxWords: 99 }).minimumWords, 80)
  assert.equal(eligibilityFor({ words: 0, statedMaxWords: 51 }).minimumWords, 41)
})

test('below 50 words the seven-category rubric does not apply at all', () => {
  assert.equal(SHORT_PROMPT_CEILING, 50)
  const verdict = eligibilityFor({ words: 500, statedMaxWords: 40 })
  assert.deepEqual(verdict, { kind: 'prompt-too-short', statedMaxWords: 40 })
  // Even a long essay does not unlock it: the PROMPT is what is too short.
  assert.equal(eligibilityFor({ words: 5000, statedMaxWords: 49 }).kind, 'prompt-too-short')
  // And 50 exactly is the first that works, at an 80% floor of 40.
  assert.deepEqual(eligibilityFor({ words: 40, statedMaxWords: 50 }),
    { kind: 'eligible', minimumWords: 40 })
})

test('going over the stated maximum is reported, never blocked', () => {
  assert.equal(overLimit({ words: 1001, statedMaxWords: 1000 }), true)
  assert.equal(overLimit({ words: 1000, statedMaxWords: 1000 }), false)
  assert.equal(overLimit({ words: 99999, statedMaxWords: null }), false)
  // Still eligible, which is the point: the warning is prominent, not fatal.
  assert.equal(eligibilityFor({ words: 1500, statedMaxWords: 1000 }).kind, 'eligible')
})
