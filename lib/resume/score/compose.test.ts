import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allFeedback, compose, composeSubScore, describeScore, isStale } from './compose.ts'
import { CATEGORIES, SUB_SCORE_MAX, categoriesOf, category } from './types.ts'
import type { CategoryId, CategoryResult } from './types.ts'
import { containsAdmissionsClaim } from './language.ts'

/**
 * The arithmetic that decides someone's number, and the rescaling that makes
 * "we never deduct for what you do not have" a property rather than a promise.
 */

const NOW = '2026-09-11T09:00:00.000Z'
const full = (id: CategoryId) => category(id, CATEGORIES.find((c) => c.id === id)!.maxPoints)
const none = (id: CategoryId, reason = 'Nothing to assess.') => category(id, null, { notAssessed: reason })
const allFull = () => CATEGORIES.map((c) => full(c.id))

// ------------------------------------------------------- the weights

test('the locked breakdown is what is in force', () => {
  assert.equal(SUB_SCORE_MAX['data-quality'], 40)
  assert.equal(SUB_SCORE_MAX['writing-quality'], 60)

  assert.deepEqual(
    categoriesOf('data-quality').map((c) => [c.id, c.maxPoints]),
    [
      ['section-completeness', 10], ['contact-completeness', 8], ['date-integrity', 8],
      ['content-hygiene', 8], ['length-and-fit', 6],
    ]
  )
  assert.deepEqual(
    categoriesOf('writing-quality').map((c) => [c.id, c.maxPoints]),
    [
      ['clinical-specificity', 14], ['accomplishment-focus', 12], ['critical-care-presentation', 12],
      ['leadership-framing', 8], ['clarity-and-tone', 8], ['organisation-readability', 6],
    ]
  )
})

test('each half’s categories sum to its weight, and both sum to 100', () => {
  for (const id of ['data-quality', 'writing-quality'] as const) {
    const sum = categoriesOf(id).reduce((n, c) => n + c.maxPoints, 0)
    assert.equal(sum, SUB_SCORE_MAX[id], id)
  }
  assert.equal(SUB_SCORE_MAX['data-quality'] + SUB_SCORE_MAX['writing-quality'], 100)
})

// ------------------------------------------------------ the arithmetic

test('a perfect resume scores 100', () => {
  assert.equal(compose({ categories: allFull(), revision: 3, now: NOW }).score, 100)
})

test('an all-zero resume scores 0', () => {
  const zeros = CATEGORIES.map((c) => category(c.id, 0))
  assert.equal(compose({ categories: zeros, revision: 1, now: NOW }).score, 0)
})

test('half marks everywhere is half the score', () => {
  const halves = CATEGORIES.map((c) => category(c.id, c.maxPoints / 2))
  const result = compose({ categories: halves, revision: 1, now: NOW })
  assert.equal(result.dataQuality.points, 20)
  assert.equal(result.writingQuality.points, 30)
  assert.equal(result.score, 50)
})

test('the two sub-scores are reported separately and always sum to the total', () => {
  const mixed = CATEGORIES.map((c, i) => category(c.id, i % 2 === 0 ? c.maxPoints : c.maxPoints * 0.4))
  const result = compose({ categories: mixed, revision: 1, now: NOW })
  assert.equal(result.dataQuality.points + result.writingQuality.points, result.score)
  assert.equal(result.dataQuality.max, 40)
  assert.equal(result.writingQuality.max, 60)
})

// ------------------------------------------- exclusion and rescaling

test('a not-assessed category leaves the denominator instead of scoring zero', () => {
  // Full marks everywhere that CAN be assessed, with leadership excluded.
  const results = CATEGORIES.map((c) => (c.id === 'leadership-framing' ? none(c.id) : full(c.id)))
  const writing = composeSubScore('writing-quality', results)
  assert.equal(writing.points, 60, 'the excluded category was treated as a loss')
})

test('a resume with none of the optional experiences can still reach 100', () => {
  // No leadership, no research, no publications, no shadowing — nothing to
  // assess in those categories, and nothing taken away for it.
  const results = CATEGORIES.map((c) =>
    c.id === 'leadership-framing' || c.id === 'critical-care-presentation' ? none(c.id) : full(c.id)
  )
  assert.equal(compose({ categories: results, revision: 1, now: NOW }).score, 100)
})

test('excluding a category does not change the ratio of what remains', () => {
  // Two-thirds of the assessable points, with and without an exclusion.
  const withAll = CATEGORIES.map((c) =>
    c.subScore === 'writing-quality' ? category(c.id, c.maxPoints * (2 / 3)) : full(c.id)
  )
  const withExclusion = CATEGORIES.map((c) => {
    if (c.id === 'leadership-framing') return none(c.id)
    return c.subScore === 'writing-quality' ? category(c.id, c.maxPoints * (2 / 3)) : full(c.id)
  })
  assert.equal(
    composeSubScore('writing-quality', withAll).points,
    composeSubScore('writing-quality', withExclusion).points
  )
})

test('exclusion applies within a sub-score, never across', () => {
  const results = CATEGORIES.map((c) =>
    c.subScore === 'data-quality' ? category(c.id, 0) : full(c.id)
  )
  const result = compose({ categories: results, revision: 1, now: NOW })
  assert.equal(result.dataQuality.points, 0)
  assert.equal(result.writingQuality.points, 60, 'a bad data half dragged the writing half down')
  assert.equal(result.score, 60)
})

test('a sub-score with nothing assessable reports that, and scores zero', () => {
  // An empty resume has no writing to judge. That is not a penalty for lacking
  // an experience -- it is the absence of the thing being measured -- so it is
  // reported in words rather than as an unexplained zero.
  const results = CATEGORIES.map((c) =>
    c.subScore === 'writing-quality' ? none(c.id, 'Nothing written yet.') : full(c.id)
  )
  const result = compose({ categories: results, revision: 1, now: NOW })
  assert.equal(result.writingQuality.points, 0)
  assert.ok(result.writingQuality.notAssessed, 'a zero with no explanation')
  assert.match(result.writingQuality.notAssessed!, /nothing written/i)
  assert.equal(result.score, 40)
})

test('every category keeps its own max so the UI can show the fraction', () => {
  const result = compose({ categories: allFull(), revision: 1, now: NOW })
  for (const c of [...result.dataQuality.categories, ...result.writingQuality.categories]) {
    assert.equal(c.max, CATEGORIES.find((d) => d.id === c.id)!.maxPoints, c.id)
  }
})

test('a score is never outside 0 to 100, however odd the inputs', () => {
  const wild: CategoryResult[] = CATEGORIES.map((c) => category(c.id, c.maxPoints * 5))
  assert.equal(compose({ categories: wild, revision: 1, now: NOW }).score, 100)
  const negative = CATEGORIES.map((c) => category(c.id, -50))
  assert.equal(compose({ categories: negative, revision: 1, now: NOW }).score, 0)
})

// ------------------------------------------------------------ staleness

test('a score is stale the moment the resume moves on', () => {
  assert.equal(isStale(7, 7), false)
  assert.equal(isStale(7, 8), true)
  assert.equal(isStale(8, 7), true, 'a score from a later revision is also not about this one')
})

test('the result records which revision it describes', () => {
  const result = compose({ categories: allFull(), revision: 12, now: NOW })
  assert.equal(result.computedAtRevision, 12)
  assert.equal(result.computedAt, NOW)
})

// ------------------------------------------------------- the language

test('nothing composed says anything about admission', () => {
  const result = compose({ categories: allFull(), revision: 1, now: NOW })
  for (const line of [...allFeedback(result), describeScore(result)]) {
    assert.equal(containsAdmissionsClaim(line), false, `admissions claim: "${line}"`)
  }
})

test('the headline sentence reports both halves and predicts nothing', () => {
  const sentence = describeScore(compose({ categories: allFull(), revision: 1, now: NOW }))
  assert.match(sentence, /100 out of 100/)
  assert.match(sentence, /Data Quality 40\/40/)
  assert.match(sentence, /Writing Quality 60\/60/)
  assert.equal(containsAdmissionsClaim(sentence), false)
})

test('composing is pure and repeatable', () => {
  const categories = allFull()
  const before = JSON.stringify(categories)
  const a = compose({ categories, revision: 1, now: NOW })
  const b = compose({ categories, revision: 1, now: NOW })
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(categories), before)
})
