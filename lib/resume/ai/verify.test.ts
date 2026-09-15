import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeViolations, summariseRejection, verifyAll, verifyGrounding } from './verify.ts'
import { factSheet, makeFact } from '../model/facts.ts'
import type { Fact, FactSheet } from '../model/facts.ts'
import { factSheetForPosition } from './factSheet.ts'
import { createClinicalPosition } from '../model/sections.ts'
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

// ================================================ strict years and charge role
//
// A span of experience is supported only by a supplied span of the same value
// and the same strength, and its number supports nothing else. A charge-role
// claim is supported only where the applicant clearly asserted the role. Every
// row is a test of its own, so a failure names the exact claim that changed.

const FOUR_WORDS = 'Critical care registered nurse with four years of MICU/CCU experience.'
const FOUR_DIGITS = 'Critical care registered nurse with 4 years of MICU experience.'
const UAT_SUMMARY =
  'Critical care registered nurse with four years of MICU/CCU experience. ' +
  'Experienced with CRRT, ECMO, arterial lines, and vasoactive infusions. ' +
  'Charge nurse experience and active participation in code response.'

/** Structured facts, for claims that arrive as fields rather than as prose. */
const factsOf = (...facts: readonly (readonly [Fact['kind'], string])[]): FactSheet =>
  factSheet('t/bullets', [facts.map(([kind, value], i) => makeFact(`f:t${i}`, kind, value, `t/${i}`))])

/** The real checkbox fact, so a change to its wording cannot slip past these rows. */
const CHARGE_FLAG = factSheetForPosition(
  createClinicalPosition('p1', { employer: 'University Hospital', chargeExperience: true }),
  'critical_care'
)

interface Row {
  /** Prose is the text being improved; a sheet is the facts. */
  readonly supplied: string | FactSheet
  readonly proposal: string
  /** For a rejection: the violation that must be among those reported. */
  readonly flags?: RegExp
}

function verdictFor(row: Row) {
  return typeof row.supplied === 'string'
    ? verifyGrounding(row.proposal, EMPTY, { existingText: row.supplied })
    : verifyGrounding(row.proposal, row.supplied)
}

function labelFor(row: Row): string {
  const supplied = typeof row.supplied === 'string'
    ? `"${row.supplied.length > 44 ? `${row.supplied.slice(0, 43)}…` : row.supplied}"`
    : row.supplied.facts.map((f) => `${f.kind}="${f.value}"`).join(', ')
  return `"${row.proposal}" from ${supplied}`
}

function passes(group: string, rows: readonly Row[]): void {
  for (const row of rows) {
    test(`${group} — ${labelFor(row)}`, () => {
      const result = verdictFor(row)
      const got = result.ok ? '' : result.violations.map((v) => `${v.category}:${v.token}`).join(', ')
      assert.equal(result.ok, true, `FALSE POSITIVE — ${labelFor(row)} flagged [${got}]`)
    })
  }
}

function rejects(group: string, rows: readonly Row[]): void {
  for (const row of rows) {
    test(`${group} — ${labelFor(row)}`, () => {
      const result = verdictFor(row)
      assert.equal(result.ok, false, `NOT CAUGHT — ${labelFor(row)}`)
      if (result.ok || !row.flags) return
      const tokens = result.violations.map((v) => v.token)
      assert.ok(
        tokens.some((token) => row.flags!.test(token)),
        `${labelFor(row)} was rejected, but not for ${row.flags} — reported [${tokens.join(', ')}]`
      )
    })
  }
}

// ---------------------------------------------------- years: bound to the claim

passes('years pass', [
  { supplied: FOUR_WORDS, proposal: 'Critical care RN with 4 years of MICU/CCU experience.' },
  { supplied: FOUR_WORDS, proposal: 'Brings 4 years of experience in the MICU.' },
  { supplied: FOUR_WORDS, proposal: 'Critical care RN with four years of MICU/CCU experience.' },
  { supplied: FOUR_DIGITS, proposal: 'Registered nurse with four years of MICU experience.' },
  { supplied: FOUR_DIGITS, proposal: 'Brings 4 yrs of MICU experience.' },
])

passes('UAT summary', [
  {
    supplied: UAT_SUMMARY,
    proposal: 'Critical care RN with 4 years in MICU/CCU, experienced with CRRT, ECMO, arterial lines, and vasoactive infusions; charge nurse and code response team member.',
  },
  {
    supplied: UAT_SUMMARY,
    proposal: 'Critical care registered nurse with 4 years of MICU/CCU experience, skilled in CRRT, ECMO, arterial lines, and vasoactive infusions, with charge nurse experience and active code response participation.',
  },
  {
    supplied: UAT_SUMMARY,
    proposal: 'Registered nurse with 4 years of experience in MICU/CCU settings, managing CRRT, ECMO, arterial lines, and vasoactive infusions; experienced as charge nurse and active in code response.',
  },
])

rejects('a span supports no other claim', [
  { supplied: FOUR_WORDS, proposal: 'Cared for 4 patients per shift.', flags: /4 patients/ },
  { supplied: FOUR_WORDS, proposal: 'Reduced falls by 4%.', flags: /4\s*%/ },
  { supplied: FOUR_WORDS, proposal: 'Maintained a 4:1 patient ratio.', flags: /4\s*:\s*1/ },
  { supplied: FOUR_WORDS, proposal: 'Worked 4 shifts a week.', flags: /4 shifts/ },
  { supplied: FOUR_WORDS, proposal: 'Cared for four patients per shift.', flags: /^four$/i },
  { supplied: FOUR_DIGITS, proposal: 'Cared for 4 patients per shift.', flags: /4 patients/ },
  { supplied: FOUR_DIGITS, proposal: 'Reduced falls by 4%.', flags: /4\s*%/ },
  { supplied: FOUR_DIGITS, proposal: 'Assigned to bed 4 most nights.', flags: /^4$/ },
  { supplied: FOUR_WORDS, proposal: 'Brings 4 years of MICU experience and covered bed 4.', flags: /^4$/ },
])

rejects('a span needs a supplied span of the same value', [
  { supplied: 'Night shift RN on 4 West.', proposal: 'Brings 4 years of nursing experience.', flags: /4 years/ },
  { supplied: FOUR_WORDS, proposal: 'Brings 6 years of MICU experience.', flags: /6 years/ },
  { supplied: FOUR_WORDS, proposal: 'Brings six years of MICU experience.', flags: /six/i },
  { supplied: 'Brings 4.5 years of ICU experience.', proposal: 'Brings 5 years of ICU experience.', flags: /5 years/ },
  { supplied: 'Brings 4.5 years of ICU experience.', proposal: 'Brings 4 years of ICU experience.', flags: /4 years/ },
  { supplied: 'One of the busiest ICUs in the state.', proposal: 'Brings one year of ICU experience.', flags: /one year/i },
  { supplied: 'Intensive care nurse.', proposal: 'Brings ten years of intensive care experience.', flags: /ten years/i },
  { supplied: 'Brings twenty-four years of nursing experience.', proposal: 'Brings 4 years of nursing experience.', flags: /4 years/ },
])

rejects('an age, a time ago or a hyphenated duration is not a span', [
  { supplied: FOUR_WORDS, proposal: 'Cared for a 4-year-old after a near drowning.', flags: /^4$/ },
  { supplied: FOUR_WORDS, proposal: 'Graduated 4 years ago.', flags: /^4$/ },
  { supplied: FOUR_WORDS, proposal: 'Four-year MICU/CCU nurse.', flags: /^four$/i },
])

// ---------------------------------------------------------- years: qualifiers

rejects('a qualifier that was not supplied', [
  { supplied: FOUR_DIGITS, proposal: 'Brings more than 4 years of MICU experience.', flags: /more than 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings over 4 years of MICU experience.', flags: /over 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings 4+ years of MICU experience.', flags: /4\+ years/ },
  { supplied: FOUR_DIGITS, proposal: 'Brings nearly 4 years of MICU experience.', flags: /nearly 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings almost 4 years of MICU experience.', flags: /almost 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings at least 4 years of MICU experience.', flags: /at least 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings about 4 years of MICU experience.', flags: /about 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings approximately 4 years of MICU experience.', flags: /approximately 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings ~4 years of MICU experience.', flags: /~4 years/ },
  { supplied: FOUR_DIGITS, proposal: 'Brings 4 or more years of MICU experience.', flags: /4 or more years/ },
  { supplied: FOUR_DIGITS, proposal: 'Brings 4 years or more of MICU experience.', flags: /4 years or more/ },
  { supplied: FOUR_DIGITS, proposal: 'Brings well over 4 years of MICU experience.', flags: /well over 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings less than 4 years of MICU experience.', flags: /less than 4 years/i },
  { supplied: FOUR_DIGITS, proposal: 'Brings up to 4 years of MICU experience.', flags: /up to 4 years/i },
  { supplied: FOUR_WORDS, proposal: 'Brings more than 4 years of MICU/CCU experience.', flags: /more than 4 years/i },
  { supplied: FOUR_WORDS, proposal: 'Brings over four years of MICU/CCU experience.', flags: /over four years/i },
])

passes('the same qualifier, or its exact synonym', [
  { supplied: 'Brings more than four years of ICU experience.', proposal: 'Brings more than 4 years of ICU experience.' },
  { supplied: 'Brings more than four years of ICU experience.', proposal: 'Brings over 4 years of ICU experience.' },
  { supplied: 'Brings 4+ years of ICU experience.', proposal: 'Brings at least four years of ICU experience.' },
  { supplied: 'Nearly four years in the MICU.', proposal: 'Nearly 4 years of MICU experience.' },
  { supplied: 'Nearly four years in the MICU.', proposal: 'Almost 4 years of MICU experience.' },
])

rejects('a supplied qualifier dropped or swapped', [
  { supplied: 'Brings more than four years of ICU experience.', proposal: 'Brings 4 years of ICU experience.', flags: /4 years/ },
  { supplied: 'Nearly four years in the MICU.', proposal: 'Brings 4 years of MICU experience.', flags: /4 years/ },
  { supplied: 'Brings more than four years of ICU experience.', proposal: 'Brings nearly 4 years of ICU experience.', flags: /nearly 4 years/i },
  { supplied: 'Brings well over four years of ICU experience.', proposal: 'Brings over 4 years of ICU experience.', flags: /over 4 years/i },
])

// ---------------------------------------------------------------- charge role

passes('charge role asserted', [
  { supplied: UAT_SUMMARY, proposal: 'Served as charge nurse in the MICU.' },
  { supplied: 'Served as charge on nights.', proposal: 'Experienced as charge nurse.' },
  { supplied: CHARGE_FLAG, proposal: 'Served as charge nurse on nights.' },
  { supplied: factsOf(['role', 'Charge Nurse']), proposal: 'Served as charge nurse on nights.' },
  { supplied: factsOf(['role', 'Relief Charge Nurse']), proposal: 'Served as charge nurse on nights.' },
  { supplied: factsOf(['role', 'Charge Nurse']), proposal: 'Charge nurse on nights.' },
  { supplied: factsOf(['role', 'Charge RN']), proposal: 'Served as charge RN on nights.' },
  { supplied: 'As charge RN, coordinated nightly assignments.', proposal: 'Served as charge nurse.' },
  { supplied: 'Charge RN experience on nights.', proposal: 'Served as charge RN on nights.' },
  { supplied: 'Served as charge nurse on nights.', proposal: 'Charge RN on nights.' },
])

rejects('charge role only mentioned, or never stated', [
  { supplied: 'Taught discharge nurse education classes.', proposal: 'Worked as a charge nurse on nights.', flags: /charge nurse/i },
  { supplied: 'Worked alongside the charge nurse on nights.', proposal: 'Served as charge nurse on nights.', flags: /charge/i },
  { supplied: 'Worked alongside the charge nurse on nights.', proposal: 'Charge nurse on nights.', flags: /charge nurse/i },
  { supplied: 'Joined unit huddles such as charge nurse rounds.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: FOUR_WORDS, proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: FOUR_WORDS, proposal: 'Charge RN on nights.', flags: /charge rn/i },
  { supplied: factsOf(['role', 'Staff Nurse']), proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: factsOf(['role', 'Assistant to the Charge Nurse']), proposal: 'Served as charge nurse.', flags: /charge/i },
])

rejects('charge role negated or only hoped for', [
  { supplied: "Haven't served as charge nurse yet.", proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'Hasn’t worked as charge nurse.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: "Hasn't worked as charge.", proposal: 'Served as charge.', flags: /as charge/i },
  { supplied: 'Havent served as charge RN.', proposal: 'Served as charge RN.', flags: /charge/i },
  { supplied: "Didn't serve as charge nurse on nights.", proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'I have not served as charge nurse.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'Never served as charge RN.', proposal: 'Served as charge RN.', flags: /charge/i },
  { supplied: 'No charge nurse experience yet.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'Charge nurse experience: none.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'Charge nurse experience: not yet.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'Seeking charge nurse experience.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'Hoping to gain charge nurse experience.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'Would like to serve as charge nurse.', proposal: 'Served as charge nurse.', flags: /charge/i },
  { supplied: 'Yet to serve as charge nurse.', proposal: 'Served as charge nurse.', flags: /charge/i },
])

passes('negation is read within its own sentence', [
  { supplied: 'Not yet CCRN certified. Served as charge nurse on nights.', proposal: 'Served as charge nurse.' },
  { supplied: 'Not only precepted new graduates but also served as charge nurse.', proposal: 'Served as charge nurse.' },
  { supplied: 'Served as charge nurse without incident.', proposal: 'Served as charge nurse.' },
])

// ------------------------------------------------------ numbers outside a span

// Unchanged on purpose. A number outside a span of experience is still
// supported by the same number anywhere it was supplied, so "24-bed" still
// supports "24 hours". Binding these to their unit is a separate, logged audit;
// when that lands, the second and third rows here are expected to flip.
passes('numbers outside a span, unchanged for now', [
  { supplied: factsOf(['unit_type', '24-bed medical ICU']), proposal: 'Held a full assignment on a 24-bed unit.' },
  { supplied: factsOf(['unit_type', '24-bed medical ICU']), proposal: 'Worked 24 hours straight during a surge.' },
  { supplied: 'Cared for up to 3 patients on nights.', proposal: 'Covered 3 shifts a week.' },
  { supplied: factsOf(['date_range', 'Mar 2021 – Present']), proposal: 'At the hospital since Mar 2021.' },
  { supplied: 'Cared for four patients per shift.', proposal: 'Cared for four patients each shift.' },
])
