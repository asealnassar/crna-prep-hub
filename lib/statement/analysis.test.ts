import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FIELD_CHARS, MAX_LIST_ITEMS, MAX_SENTENCE_ITEMS,
  overallFrom, parseAnalysis, redactForTier, reviewNotesFrom,
} from './analysis.ts'
import type { StatementAnalysis } from './analysis.ts'

const ULTIMATE = { includeSuggestions: true, includeSentenceAnalysis: true }
const FREE = { includeSuggestions: false, includeSentenceAnalysis: false }

const wellFormed = {
  categories: [
    { name: 'Hook Strength', score: 6, feedback: 'The opening is generic.', suggestion: 'Open on the shift you described.' },
    { name: 'Motivation for CRNA', score: 8, feedback: 'Clear and specific.', suggestion: 'Name the moment it crystallised.' },
  ],
  admissionsImpression: 'Competent but not memorable.',
  biggestWeaknesses: ['Generic opening', 'Little reflection', 'Flat ending'],
  topChanges: ['Rewrite the hook', 'Add reflection', 'Cut the summary paragraph'],
  sentenceAnalysis: [
    { original: 'I have always wanted to help people.', label: 'Weak', improved: 'The night I described changed what I wanted.' },
  ],
}

const json = (value: unknown) => JSON.stringify(value)

// ===================================================================
// Malformed responses
// ===================================================================

test('a response that is not JSON is rejected, not rendered', () => {
  for (const raw of ['', 'not json', '<html>502</html>', '{', 'undefined', 'null']) {
    const result = parseAnalysis(raw, ULTIMATE)
    assert.equal(result.ok, false, JSON.stringify(raw))
  }
})

test('JSON that is not an object is rejected', () => {
  for (const raw of ['[]', '"a string"', '42', 'true', '[{"categories":[]}]']) {
    assert.equal(parseAnalysis(raw, ULTIMATE).ok, false, raw)
  }
})

test('an empty or missing categories array is rejected', () => {
  assert.equal(parseAnalysis(json({ categories: [] }), ULTIMATE).ok, false)
  assert.equal(parseAnalysis(json({ admissionsImpression: 'x' }), ULTIMATE).ok, false)
  assert.equal(parseAnalysis(json({ categories: 'six of them' }), ULTIMATE).ok, false)
})

test('categories that are all unreadable are rejected', () => {
  const result = parseAnalysis(json({
    categories: [{ name: null, score: 'high', feedback: 7 }, 'nope', null],
    admissionsImpression: 'x',
  }), ULTIMATE)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'bad-category')
})

test('one bad row among good ones is dropped, not fatal', () => {
  const result = parseAnalysis(json({
    ...wellFormed,
    categories: [...wellFormed.categories, { name: 'Broken', score: null, feedback: null }],
  }), ULTIMATE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.categories.length, 2)
})

test('a missing admissions impression is rejected', () => {
  const { admissionsImpression: _gone, ...rest } = wellFormed
  const result = parseAnalysis(json(rest), ULTIMATE)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'missing-impression')
})

// ===================================================================
// Bounds
// ===================================================================

test('scores are clamped into range and rounded', () => {
  const cases: [unknown, number][] = [
    [400, 10], [-5, 1], [0, 1], [11, 10], [7.4, 7], [7.6, 8], [10, 10], [1, 1],
  ]
  for (const [input, expected] of cases) {
    const result = parseAnalysis(json({
      ...wellFormed,
      categories: [{ name: 'Hook Strength', score: input, feedback: 'x' }],
    }), FREE)
    assert.equal(result.ok, true, String(input))
    if (!result.ok) continue
    assert.equal(result.value.categories[0].score, expected, String(input))
  }
})

test('a non-numeric or infinite score makes the row unreadable', () => {
  for (const score of ['8', null, undefined, NaN, Infinity, -Infinity, {}, []]) {
    const result = parseAnalysis(json({
      categories: [{ name: 'Hook Strength', score, feedback: 'x' }],
      admissionsImpression: 'y',
    }), FREE)
    assert.equal(result.ok, false, String(score))
  }
})

test('runaway strings are truncated, not rendered whole', () => {
  const result = parseAnalysis(json({
    ...wellFormed,
    admissionsImpression: 'z'.repeat(500_000),
    categories: [{ name: 'n'.repeat(5_000), score: 5, feedback: 'f'.repeat(500_000) }],
  }), FREE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.admissionsImpression.length, MAX_FIELD_CHARS)
  assert.equal(result.value.categories[0].feedback.length, MAX_FIELD_CHARS)
  assert.ok(result.value.categories[0].name.length <= 120)
})

test('runaway arrays are capped', () => {
  const result = parseAnalysis(json({
    ...wellFormed,
    biggestWeaknesses: Array.from({ length: 5_000 }, (_, i) => `w${i}`),
    topChanges: Array.from({ length: 5_000 }, (_, i) => `c${i}`),
    sentenceAnalysis: Array.from({ length: 5_000 }, () => ({
      original: 'a', label: 'Weak', improved: 'b',
    })),
  }), ULTIMATE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.biggestWeaknesses.length, MAX_LIST_ITEMS)
  assert.equal(result.value.topChanges.length, MAX_LIST_ITEMS)
  assert.equal(result.value.sentenceAnalysis?.length, MAX_SENTENCE_ITEMS)
})

test('never more categories than were asked for', () => {
  const result = parseAnalysis(json({
    ...wellFormed,
    categories: Array.from({ length: 200 }, (_, i) => ({ name: `C${i}`, score: 5, feedback: 'x' })),
  }), FREE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.ok(result.value.categories.length <= 6)
})

test('control characters are stripped from rendered fields', () => {
  const result = parseAnalysis(json({
    ...wellFormed,
    admissionsImpression: 'before\u0000\u0007\u001bafter',
  }), FREE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.doesNotMatch(result.value.admissionsImpression, /[\u0000-\u001f]/)
})

test('a sentence label outside the three is dropped, not rendered as a fourth', () => {
  const result = parseAnalysis(json({
    ...wellFormed,
    sentenceAnalysis: [
      { original: 'a', label: 'Catastrophic', improved: 'b' },
      { original: 'c', label: 'strong', improved: 'd' },
    ],
  }), ULTIMATE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.sentenceAnalysis?.length, 1)
  assert.equal(result.value.sentenceAnalysis?.[0].label, 'Strong')
})

// ===================================================================
// The overall score is ours, not the model's
// ===================================================================

test('overallScore is computed, never read from the model', () => {
  const result = parseAnalysis(json({ ...wellFormed, overallScore: 99 }), ULTIMATE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  // Categories are 6 and 8; the mean is 7, so the headline is 70 — not 99.
  assert.equal(result.value.overallScore, 70)
})

test('a hostile overallScore cannot reach the CSS width it is interpolated into', () => {
  for (const hostile of ['100; background:url(x)', -9_999, 1e308, '<script>', null]) {
    const result = parseAnalysis(json({ ...wellFormed, overallScore: hostile }), FREE)
    assert.equal(result.ok, true)
    if (!result.ok) continue
    assert.equal(typeof result.value.overallScore, 'number')
    assert.ok(result.value.overallScore >= 0 && result.value.overallScore <= 100)
  }
})

test('the composite is always in range', () => {
  assert.equal(overallFrom([]), 0)
  assert.equal(overallFrom([{ name: 'a', score: 10, feedback: 'x' }]), 100)
  assert.equal(overallFrom([{ name: 'a', score: 1, feedback: 'x' }]), 10)
})

// ===================================================================
// Redaction — the entitlement leak
// ===================================================================

test('a Free response carries no suggestion, even when the model volunteers one', () => {
  // The prompt does not ask. This is the layer that holds when it answers anyway.
  const result = parseAnalysis(json(wellFormed), ULTIMATE)
  assert.equal(result.ok, true)
  if (!result.ok) return

  for (const tier of ['free', 'premium', '', null, undefined, 'admin']) {
    const redacted = redactForTier(result.value, tier as string)
    const serialised = JSON.stringify(redacted)
    assert.doesNotMatch(serialised, /suggestion/, `${tier} received a suggestion`)
    assert.doesNotMatch(serialised, /sentenceAnalysis/, `${tier} received sentence analysis`)
    // And the leak is not merely undefined-but-present on the wire.
    for (const category of redacted.categories) {
      assert.equal('suggestion' in category, false)
    }
  }
})

test('redaction does not damage what the tier may keep', () => {
  const result = parseAnalysis(json(wellFormed), ULTIMATE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const redacted = redactForTier(result.value, 'free')
  assert.equal(redacted.categories.length, 2)
  assert.equal(redacted.overallScore, 70)
  assert.equal(redacted.admissionsImpression, 'Competent but not memorable.')
  assert.equal(redacted.biggestWeaknesses.length, 3)
  assert.equal(redacted.topChanges.length, 3)
  assert.equal(redacted.categories[0].feedback, 'The opening is generic.')
})

test('Ultimate keeps everything', () => {
  const result = parseAnalysis(json(wellFormed), ULTIMATE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const kept = redactForTier(result.value, 'ultimate')
  assert.equal(kept.categories[0].suggestion, 'Open on the shift you described.')
  assert.equal(kept.sentenceAnalysis?.length, 1)
})

test('a Free parse never reads a suggestion in the first place', () => {
  const result = parseAnalysis(json(wellFormed), FREE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.doesNotMatch(JSON.stringify(result.value), /suggestion|sentenceAnalysis/)
})

// ===================================================================
// Review notes
// ===================================================================

test('review notes are built only from validated, bounded fields', () => {
  const analysis: StatementAnalysis = {
    overallScore: 70,
    categories: [{ name: 'Hook Strength', score: 6, feedback: 'f', suggestion: 's' }],
    admissionsImpression: 'i',
    biggestWeaknesses: ['w'],
    topChanges: ['c'],
    sentenceAnalysis: [
      { original: 'o', label: 'Weak', improved: 'p' },
      { original: 'q', label: 'Strong', improved: 'r' },
    ],
  }
  const notes = reviewNotesFrom(analysis)
  // Strong sentences are not "improvements" and are left out.
  assert.equal(notes.some((n) => n.label.startsWith('Strong')), false)
  assert.ok(notes.some((n) => n.label.includes('Hook Strength')))
  assert.ok(notes.every((n) => typeof n.label === 'string' && typeof n.detail === 'string'))
})

test('a category with no suggestion falls back to its feedback', () => {
  const notes = reviewNotesFrom({
    overallScore: 50,
    categories: [{ name: 'Hook Strength', score: 5, feedback: 'the feedback' }],
    admissionsImpression: 'i',
    biggestWeaknesses: [],
    topChanges: [],
  })
  assert.equal(notes[0].detail, 'the feedback')
})
