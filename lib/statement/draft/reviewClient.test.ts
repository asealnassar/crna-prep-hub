import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVENANCE_LABELS,
  REVIEW_MESSAGES,
  REVIEW_NETWORK_FAILURE,
  analyzePath,
  canAnalyzeNow,
  provenanceLabel,
  reviewOutcomeFrom,
} from './reviewClient.ts'

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const ok = (over: Record<string, unknown> = {}) => ({
  review: { overall: 80, categories: [] },
  revision: 4,
  words: 420,
  overLimit: false,
  statedMaxWords: 1000,
  provenance: 'catalog',
  ...over,
})

test('the endpoint encodes the draft id', () => {
  assert.equal(analyzePath(ID), `/api/statement/drafts/${ID}/analyze`)
  assert.equal(analyzePath('a/b'), '/api/statement/drafts/a%2Fb/analyze')
})

test('a complete response becomes a result', () => {
  const outcome = reviewOutcomeFrom({ status: 200, body: ok() })
  assert.equal(outcome.type, 'ready')
  assert.equal(outcome.type === 'ready' && outcome.result.revision, 4)
  assert.equal(outcome.type === 'ready' && outcome.result.words, 420)
  assert.equal(outcome.type === 'ready' && outcome.result.provenance, 'catalog')
})

test('A 2xx WITHOUT A READABLE REVIEW IS A REFUSAL, not a blank card', () => {
  // Showing an empty analysis would look like a finished one.
  for (const body of [null, {}, 'done', { review: null, revision: 1, words: 1 },
                      { review: {}, revision: '4', words: 1 },
                      { review: {}, revision: 4, words: null }]) {
    const outcome = reviewOutcomeFrom({ status: 200, body })
    assert.equal(outcome.type, 'refused', JSON.stringify(body))
    assert.equal(outcome.type === 'refused' && outcome.message, REVIEW_MESSAGES.malformed)
  }
})

test('each refusal code gets its own wording, never the server’s', () => {
  const cases = [
    ['too-short', REVIEW_MESSAGES.tooShort, false],
    ['prompt-too-short', REVIEW_MESSAGES.promptTooShort, false],
    ['too-many-requests', REVIEW_MESSAGES.rateLimited, true],
    ['malformed', REVIEW_MESSAGES.malformed, true],
    ['unavailable', REVIEW_MESSAGES.unavailable, true],
  ] as const
  for (const [code, message, retryable] of cases) {
    const outcome = reviewOutcomeFrom({
      status: 422,
      body: { error: '23514 violates check constraint "x"', code },
    })
    assert.equal(outcome.type, 'refused', code)
    assert.equal(outcome.type === 'refused' && outcome.message, message, code)
    assert.equal(outcome.type === 'refused' && outcome.retryable, retryable, code)
  }
})

test('nothing the server wrote is ever rendered', () => {
  const outcome = reviewOutcomeFrom({
    status: 502,
    body: { error: 'OpenAI said: the applicant wrote about their grandmother', code: 'unavailable' },
  })
  const message = outcome.type === 'refused' ? outcome.message : ''
  assert.equal(message.includes('grandmother'), false)
  assert.equal(message.includes('OpenAI'), false)
  assert.equal(message, REVIEW_MESSAGES.unavailable)
})

test('what cannot change by asking again is not retryable', () => {
  // Writing more is the only thing that changes a too-short draft, and a
  // too-short prompt never changes at all.
  for (const code of ['too-short', 'prompt-too-short']) {
    const outcome = reviewOutcomeFrom({ status: 422, body: { code } })
    assert.equal(outcome.type === 'refused' && outcome.retryable, false, code)
  }
})

test('an unrecognised failure is still a safe refusal', () => {
  for (const status of [400, 403, 500, 502, 503, 504]) {
    const outcome = reviewOutcomeFrom({ status, body: { error: 'anything' } })
    assert.equal(outcome.type, 'refused')
    assert.equal(outcome.type === 'refused' && outcome.retryable, true)
  }
  assert.equal(
    reviewOutcomeFrom({ status: 404, body: null }).type === 'refused'
      && reviewOutcomeFrom({ status: 404, body: null }).message,
    REVIEW_MESSAGES.unavailableDraft,
  )
})

test('a network failure is retryable, because nothing ran', () => {
  assert.equal(REVIEW_NETWORK_FAILURE.type, 'refused')
  assert.equal(REVIEW_NETWORK_FAILURE.retryable, true)
})

// ===========================================================================
// PROVENANCE
// ===========================================================================

test('UNVERIFIED IS THE DEFAULT WORDING', () => {
  // A prompt whose provenance could not be established is not one this product
  // vouches for, and silence would leave it looking like one that is.
  assert.equal(provenanceLabel('user'), PROVENANCE_LABELS.user)
  assert.ok(PROVENANCE_LABELS.user.includes('not verified'))
  assert.equal(provenanceLabel('catalog'), PROVENANCE_LABELS.catalog)
  // Null means there is no prompt at all, so there is nothing to label.
  assert.equal(provenanceLabel(null), null)
})

test('nothing is called verified except a confirmed catalog match', () => {
  assert.equal(/verif/i.test(PROVENANCE_LABELS.catalog), false,
    'the approved label does not need the word, and must not imply more')
  assert.ok(PROVENANCE_LABELS.catalog.includes('Approved'))
})

// ===========================================================================
// WHEN ANALYZE MAY FIRE
// ===========================================================================

test('Analyze needs enough words and a draft that is not frozen', () => {
  const base = { words: 150, minimumWords: 100, running: false, conflicted: false }
  assert.equal(canAnalyzeNow(base), true)
  assert.equal(canAnalyzeNow({ ...base, words: 99 }), false)
  assert.equal(canAnalyzeNow({ ...base, words: 100 }), true, 'the floor is inclusive')
  assert.equal(canAnalyzeNow({ ...base, running: true }), false)
  // A frozen draft's text on screen is not the stored text, and the server
  // analyses the stored one.
  assert.equal(canAnalyzeNow({ ...base, conflicted: true }), false)
})

test('the floor moves with the prompt', () => {
  assert.equal(canAnalyzeNow({ words: 48, minimumWords: 48, running: false, conflicted: false }), true)
  assert.equal(canAnalyzeNow({ words: 47, minimumWords: 48, running: false, conflicted: false }), false)
})

test('every flag is compared to an exact boolean', () => {
  const base = { words: 150, minimumWords: 100, running: false, conflicted: false }
  for (const notFalse of [undefined, null, 1, 'no', {}]) {
    assert.equal(canAnalyzeNow({ ...base, running: notFalse as never }), false)
    assert.equal(canAnalyzeNow({ ...base, conflicted: notFalse as never }), false)
  }
})

test('every message is distinct, so two states are never one', () => {
  const values = Object.values(REVIEW_MESSAGES)
  assert.equal(new Set(values).size, values.length)
  for (const value of values) assert.ok(value.trim().length > 0)
})
