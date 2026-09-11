/**
 * Proposals that are entirely grounded and must NOT be rejected.
 *
 * This suite exists because of what the locked decision costs. Rejecting a
 * proposal outright is the strongest truthfulness guarantee available, and it
 * means a false positive blocks legitimate work with no way for the applicant
 * to override it. A verifier that cries wolf is a feature people turn off.
 *
 * Every line here uses only what SUPPLIED_FACTS contains, phrased the way a
 * nurse would actually write it -- including the awkward cases: a number that
 * appears inside a fact rather than as one, a device named in passing, a
 * responsibility recorded as a flag rather than as prose.
 */

export interface LegitimateFixture {
  readonly name: string
  readonly proposal: string
  /** Which supplied fact makes it legitimate. Documentation, and a failure hint. */
  readonly grounds: string
}

export const LEGITIMATE: readonly LegitimateFixture[] = [
  {
    name: 'names the employer and unit as supplied',
    proposal: 'Delivered bedside care in the 24-bed medical ICU at University Hospital.',
    grounds: 'f:employer, f:unit',
  },
  {
    name: 'uses a number that appears inside a supplied fact',
    proposal: 'Held a full assignment on a 24-bed unit.',
    grounds: 'f:unit contains "24-bed"',
  },
  {
    name: 'names a supplied device',
    proposal: 'Cared for ventilated patients through prolonged respiratory failure.',
    grounds: 'f:dev1',
  },
  {
    name: 'names both supplied devices',
    proposal: 'Managed ventilator and CRRT therapy concurrently for unstable patients.',
    grounds: 'f:dev1, f:dev2',
  },
  {
    name: 'names a supplied therapy',
    proposal: 'Titrated vasoactive infusions in response to haemodynamic change.',
    grounds: 'f:th1',
  },
  {
    name: 'names a supplied population',
    proposal: 'Recognised and escalated deterioration in patients with septic shock.',
    grounds: 'f:pop1',
  },
  {
    name: 'claims a responsibility recorded as a flag',
    proposal: 'Precepted new graduate nurses through their unit orientation.',
    grounds: 'f:precept',
  },
  {
    name: 'names a supplied committee',
    proposal: 'Contributed to the sepsis committee’s review of unit practice.',
    grounds: 'f:com1',
  },
  {
    name: 'uses the supplied date range',
    proposal: 'Has worked at University Hospital since Mar 2021.',
    grounds: 'f:dates',
  },
  {
    name: 'writes strongly with no figures at all',
    proposal:
      'Anticipated deterioration early and communicated clearly with the intensivist team under pressure.',
    grounds: 'no quantitative or entity claims',
  },
  {
    name: 'qualitative achievement framing without a fabricated metric',
    proposal: 'Became the nurse colleagues turned to for the unit’s most complex patients.',
    grounds: 'no quantitative or entity claims',
  },
  {
    name: 'ordinary clinical verbs are not leadership claims',
    proposal: 'Managed complex infusions and coordinated care across the multidisciplinary team.',
    grounds: '"managed" is clinical language, not a claimed role',
  },
]
