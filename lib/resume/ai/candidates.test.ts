import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparisonKey, isDuplicate, usableCandidates } from './candidates.ts'

/**
 * Which candidates are worth offering.
 *
 * Generation returns several so the choice is the applicant's. Five ways of
 * saying one thing is not a choice, and a suggestion to write what is already
 * written is not a suggestion.
 */

test('case and punctuation do not make a second bullet', () => {
  assert.equal(
    comparisonKey('Titrated vasopressors nightly.'),
    comparisonKey('titrated vasopressors nightly')
  )
  assert.equal(comparisonKey('  Managed   CRRT circuits!  '), comparisonKey('Managed CRRT circuits'))
})

test('genuinely different bullets are different', () => {
  assert.notEqual(comparisonKey('Managed CRRT circuits.'), comparisonKey('Managed ventilated patients.'))
})

test('the same idea offered twice is offered once', () => {
  const kept = usableCandidates([
    'Titrated vasopressors nightly.',
    'titrated vasopressors nightly',
    'Precepted new graduate nurses.',
  ])
  assert.deepEqual(kept, ['Titrated vasopressors nightly.', 'Precepted new graduate nurses.'])
})

test('the wording that was offered first is the one kept', () => {
  // Never a normalised version: what is shown, and what reaches the resume, is
  // text the model actually wrote.
  assert.deepEqual(usableCandidates(['Managed CRRT circuits.', 'managed crrt circuits']), ['Managed CRRT circuits.'])
})

test('a bullet they already have is not offered back to them', () => {
  const kept = usableCandidates(
    ['Precepted new graduate nurses.', 'Ran the sepsis protocol.'],
    ['precepted new graduate nurses']
  )
  assert.deepEqual(kept, ['Ran the sepsis protocol.'])
})

test('blank and whitespace candidates are dropped', () => {
  assert.deepEqual(usableCandidates(['', '   ', '...', 'Real bullet.']), ['Real bullet.'])
})

test('candidates are trimmed, and nothing else is touched', () => {
  assert.deepEqual(usableCandidates(['  Titrated vasopressors.  ']), ['Titrated vasopressors.'])
})

test('isDuplicate answers the same question on its own', () => {
  assert.equal(isDuplicate('Managed CRRT circuits.', ['managed crrt circuits']), true)
  assert.equal(isDuplicate('Managed CRRT circuits.', ['Managed ventilators.']), false)
  assert.equal(isDuplicate('', ['anything']), false)
})

test('nothing offered stays nothing offered', () => {
  assert.deepEqual(usableCandidates([], ['Existing.']), [])
})

test('filtering mutates neither list', () => {
  const candidates = ['One.', 'one']
  const existing = ['Two.']
  const before = JSON.stringify([candidates, existing])
  usableCandidates(candidates, existing)
  assert.equal(JSON.stringify([candidates, existing]), before)
})
