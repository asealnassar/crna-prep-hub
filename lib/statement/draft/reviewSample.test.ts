import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BAND_LABELS, CATEGORY_IDS, isValidScore } from './rubric.ts'
import {
  SAMPLE_GENERAL_WORDS,
  SAMPLE_NOTICE,
  SAMPLE_SCHOOL_MAX_WORDS,
  SAMPLE_SCHOOL_WORDS,
  generalSample,
  schoolSample,
} from './reviewSample.ts'

test('THE SAMPLES ARE BUILT BY THE REAL VALIDATOR, so they cannot show the impossible', () => {
  // A hand-written fixture could display a score of 4, an eighth category, or a
  // 95% that disagreed with its own parts -- and the owner would approve a
  // layout that can never occur.
  const school = schoolSample()
  assert.equal(school.categories.length, 7)
  assert.deepEqual(school.categories.map((c) => c.id), CATEGORY_IDS)
  for (const category of school.categories) {
    assert.equal(isValidScore(category.score), true, category.id)
    assert.ok(category.band in BAND_LABELS)
  }
})

test('the general sample has six categories and no prompt alignment', () => {
  const general = generalSample()
  assert.equal(general.categories.length, 6)
  assert.equal(general.categories.some((c) => c.id === 'prompt-alignment'), false)
  assert.equal(general.promptAttached, false)
})

test('the overall score is COMPUTED, and the two shapes differ because the scores do', () => {
  // Weighted by the real overallScore, not written down. The school sample
  // carries a 5 in prompt alignment that the general one does not have at all.
  const general = generalSample()
  const school = schoolSample()
  assert.ok(general.overall > 0 && general.overall <= 100)
  assert.ok(school.overall > 0 && school.overall <= 100)
  assert.notEqual(general.overall, school.overall)
})

test('every band appears somewhere, so the preview shows all three', () => {
  const bands = new Set(schoolSample().categories.map((c) => c.band))
  assert.equal(bands.size, 3, 'needs-improvement, developing and strong are all visible')
})

test('every category carries evidence, an explanation and a recommendation', () => {
  for (const sample of [generalSample(), schoolSample()]) {
    for (const category of sample.categories) {
      assert.ok(category.evidence.trim().length > 0, category.id)
      assert.ok(category.explanation.trim().length > 0, category.id)
      assert.ok(category.recommendation.trim().length > 0, category.id)
    }
  }
})

test('MISSING AND WEAK ARE BOTH SHOWN, because they look different', () => {
  const school = schoolSample()
  assert.ok(school.categories.some((c) => c.evidenceFound), 'quoted evidence')
  assert.ok(school.categories.some((c) => !c.evidenceFound), 'and an absence')
})

test('the summary carries strengths, priorities and next steps', () => {
  for (const sample of [generalSample(), schoolSample()]) {
    assert.ok(sample.overallAssessment.length > 0)
    assert.ok(sample.strengths.length >= 2)
    assert.ok(sample.priorities.length >= 2)
    assert.ok(sample.nextSteps.length >= 2)
  }
})

test('the school sample is over its stated limit, so that warning is visible too', () => {
  assert.ok(SAMPLE_SCHOOL_WORDS > SAMPLE_SCHOOL_MAX_WORDS)
  // And the general one is comfortably inside no limit at all.
  assert.ok(SAMPLE_GENERAL_WORDS > 100)
})

test('the notice says plainly what this is', () => {
  assert.equal(SAMPLE_NOTICE, 'Sample AI feedback — visual preview only.')
  assert.ok(/sample/i.test(SAMPLE_NOTICE))
  assert.ok(/preview only/i.test(SAMPLE_NOTICE))
})

test('nothing in the sample module reaches a model, a draft or the ledger', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('./reviewSample.ts', import.meta.url)), 'utf8')
  for (const forbidden of [/fetch\(/, /openai/i, /recordStatementAttempt/, /settleStatementUsage/,
                           /supabase/i, /analyzePath/]) {
    assert.doesNotMatch(source, forbidden)
  }
})
