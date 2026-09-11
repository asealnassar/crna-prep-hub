import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeViolations, summariseRejection, verifyAll, verifyGrounding } from './verify.ts'
import { factSheet } from '../model/facts.ts'
import { ADVERSARIAL, SUPPLIED_FACTS } from './fixtures/adversarial.ts'
import { LEGITIMATE } from './fixtures/legitimate.ts'
import { PROHIBITED_CATEGORIES } from './prompts.ts'

/**
 * The most valuable suite in V2.
 *
 * Two halves that pull against each other on purpose: the adversarial suite
 * proves nothing unsupported gets through, the false-positive suite proves the
 * verifier is not simply refusing everything. A change that satisfies one and
 * breaks the other has not improved anything.
 */

const SHEET = factSheet('cc/p1/bullets', [[...SUPPLIED_FACTS]])
const EMPTY = factSheet('cc/p1/bullets', [[]])

// ------------------------------------------------------- adversarial

test('every adversarial fixture is rejected', () => {
  for (const fixture of ADVERSARIAL) {
    const result = verifyGrounding(fixture.proposal, SHEET)
    assert.equal(
      result.ok, false,
      `NOT CAUGHT (${fixture.decisionOneTerm}) — ${fixture.name}: ${fixture.proposal}`
    )
  }
})

test('every prohibited category from decision 1 has a fixture that is caught', () => {
  // The list in prompts.ts is decision 1 verbatim; each term must be exercised.
  const covered = new Set(ADVERSARIAL.map((f) => f.decisionOneTerm))
  for (const category of PROHIBITED_CATEGORIES) {
    assert.ok(covered.has(category), `no adversarial fixture for "${category}"`)
    const fixtures = ADVERSARIAL.filter((f) => f.decisionOneTerm === category)
    for (const fixture of fixtures) {
      assert.equal(verifyGrounding(fixture.proposal, SHEET).ok, false, `${category}: ${fixture.name}`)
    }
  }
})

test('a rejection names what was unsupported', () => {
  // The locked decision is "reject, and name what was unsupported". A rejection
  // with nothing to show the applicant is half the decision.
  for (const fixture of ADVERSARIAL) {
    const result = verifyGrounding(fixture.proposal, SHEET)
    assert.equal(result.ok, false, fixture.name)
    if (result.ok) continue
    assert.ok(result.violations.length > 0, `${fixture.name}: rejected with no violations`)
    for (const violation of result.violations) {
      assert.notEqual(violation.token.trim(), '', `${fixture.name}: a violation named nothing`)
      assert.notEqual(violation.message.trim(), '', `${fixture.name}: a violation explained nothing`)
    }
  }
})

test('the violation quotes the text the applicant will recognise', () => {
  const result = verifyGrounding('Maintained a 2:1 patient assignment.', SHEET)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.violations.some((v) => v.token.replace(/\s/g, '') === '2:1'), 'the ratio was not quoted')
  assert.ok(describeViolations(result.violations)[0].includes('2:1'))
})

test('a buried fabrication is caught even when the rest is grounded', () => {
  const result = verifyGrounding(
    'Managed ventilated patients on CRRT at University Hospital, maintaining a 1:1 assignment.',
    SHEET
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.violations.length, 1, 'the grounded half was also flagged')
    assert.match(result.violations[0].token, /1\s*:\s*1/)
  }
})

test('an empty fact sheet supports nothing', () => {
  for (const fixture of LEGITIMATE) {
    // The fixture says what grounds it. One that cites a fact id must fail when
    // there are no facts; one that makes no claim at all still passes.
    if (!fixture.grounds.startsWith('f:')) continue
    assert.equal(
      verifyGrounding(fixture.proposal, EMPTY).ok, false,
      `${fixture.name} passed against an empty sheet`
    )
  }
})

// --------------------------------------------------- false positives

test('every legitimate fixture is accepted', () => {
  for (const fixture of LEGITIMATE) {
    const result = verifyGrounding(fixture.proposal, SHEET)
    const detail = result.ok ? '' : result.violations.map((v) => `${v.category}:${v.token}`).join(', ')
    assert.equal(
      result.ok, true,
      `FALSE POSITIVE — ${fixture.name} (grounds: ${fixture.grounds}) flagged [${detail}]`
    )
  }
})

test('a number that appears inside a fact supports a claim that uses it', () => {
  assert.equal(verifyGrounding('Worked on a 24-bed unit.', SHEET).ok, true)
})

test('ordinary clinical verbs are not treated as leadership claims', () => {
  for (const proposal of [
    'Managed complex infusions overnight.',
    'Coordinated care with respiratory therapy.',
    'Escalated deteriorating patients to the intensivist.',
  ]) {
    assert.equal(verifyGrounding(proposal, SHEET).ok, true, proposal)
  }
})

test('text with no claims at all always passes', () => {
  for (const proposal of [
    'Communicated clearly under pressure.',
    'Known for calm, methodical assessment.',
    '',
    '   ',
  ]) {
    assert.equal(verifyGrounding(proposal, SHEET).ok, true, JSON.stringify(proposal))
  }
})

// ------------------------------------------------- improving existing text

test('a figure already in the applicant’s own bullet is not a new invention', () => {
  // Otherwise a bullet accepted months ago could never be edited again.
  const existing = 'Cared for up to 3 patients on a busy night shift.'
  const rewrite = 'Sustained care for up to 3 patients through a busy night shift.'
  assert.equal(verifyGrounding(rewrite, SHEET).ok, false, 'the figure is not in the facts')
  assert.equal(verifyGrounding(rewrite, SHEET, { existingText: existing }).ok, true)
})

test('an improvement may not smuggle in something new', () => {
  const existing = 'Cared for up to 3 patients on a busy night shift.'
  const rewrite = 'Cared for up to 3 patients per 12-hour night shift.'
  const result = verifyGrounding(rewrite, SHEET, { existingText: existing })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.violations.some((v) => /12/.test(v.token)))
})

// ----------------------------------------------------------- reporting

test('verifying a set reports each distinct problem once', () => {
  const result = verifyAll(
    [
      'Maintained a 2:1 assignment.',
      'Held a 2:1 assignment on nights.',
      'Managed ECMO circuits.',
    ],
    SHEET
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  const ratios = result.violations.filter((v) => /2\s*:\s*2|2\s*:\s*1/.test(v.token))
  assert.equal(ratios.length, 1, 'the repeated ratio was reported twice')
  assert.ok(result.violations.some((v) => v.category === 'device'))
})

test('a set with nothing unsupported passes', () => {
  assert.equal(verifyAll(LEGITIMATE.map((f) => f.proposal), SHEET).ok, true)
})

test('the summary reads as a sentence a person would understand', () => {
  const result = verifyGrounding('Managed ECMO circuits.', SHEET)
  assert.equal(result.ok, false)
  if (result.ok) return
  const summary = summariseRejection(result.violations)
  assert.match(summary, /ECMO/)
  assert.equal(summary.includes('undefined'), false)
  assert.equal(summariseRejection([]), '')
})

// ------------------------------------------------------------- purity

test('the verifier is deterministic', () => {
  for (const fixture of [...ADVERSARIAL.slice(0, 5)]) {
    const a = verifyGrounding(fixture.proposal, SHEET)
    const b = verifyGrounding(fixture.proposal, SHEET)
    assert.deepEqual(a, b, fixture.name)
  }
})

test('the verifier mutates nothing it is given', () => {
  const before = JSON.stringify(SHEET)
  for (const fixture of ADVERSARIAL) verifyGrounding(fixture.proposal, SHEET)
  assert.equal(JSON.stringify(SHEET), before)
})

// ------------------------------------------------------- known limits

test('an unquantified claim is NOT caught, and that is a stated limit', () => {
  // A deterministic scanner finds numbers and named entities. "Improved patient
  // satisfaction" asserts an outcome with neither, and no pure function can
  // tell it from legitimate framing. The layers that cover this are the prompt,
  // the grounding envelope and the human gate -- recorded here so the gap is
  // known rather than discovered.
  const result = verifyGrounding('Improved patient satisfaction on the unit.', SHEET)
  assert.equal(result.ok, true, 'if this now fails, the verifier got stricter — check for false positives')
})
