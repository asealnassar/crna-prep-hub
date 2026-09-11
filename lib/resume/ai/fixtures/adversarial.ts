/**
 * Proposals a model might plausibly return, each containing something the
 * applicant never supplied.
 *
 * This is the permanent regression net. A prompt change, a model upgrade or a
 * refactor of the verifier can quietly weaken the truthfulness guarantee in
 * every other layer; it cannot weaken this one without a test going red.
 *
 * Every fixture is written the way a good model writes -- fluent, specific and
 * professional. That is the point: the dangerous fabrication is not the absurd
 * one, it is the one a tired applicant would read at midnight and accept.
 */

import { makeFact } from '../../model/facts.ts'
import type { Fact } from '../../model/facts.ts'
import type { ProhibitedCategory } from '../verify.ts'

/** What one applicant actually told us. Every fixture is judged against this. */
export const SUPPLIED_FACTS: readonly Fact[] = [
  makeFact('f:employer', 'employer', 'University Hospital', 'cc/p1/employer'),
  makeFact('f:role', 'role', 'Registered Nurse', 'cc/p1/role'),
  makeFact('f:unit', 'unit_type', '24-bed medical ICU', 'cc/p1/unit'),
  makeFact('f:location', 'location', 'Newark, NJ', 'cc/p1/location'),
  makeFact('f:dates', 'date_range', 'Mar 2021 – Present', 'cc/p1/dates'),
  makeFact('f:dev1', 'device', 'Ventilator', 'cc/p1/devices#0'),
  makeFact('f:dev2', 'device', 'CRRT', 'cc/p1/devices#1'),
  makeFact('f:th1', 'therapy', 'Vasoactive infusions', 'cc/p1/therapies#0'),
  makeFact('f:pop1', 'patient_population', 'Septic shock', 'cc/p1/patientPopulations#0'),
  makeFact('f:com1', 'committee', 'Sepsis committee', 'cc/p1/committees#0'),
  makeFact('f:precept', 'preceptor_role', 'Preceptor experience', 'cc/p1/preceptor'),
]

export interface AdversarialFixture {
  readonly name: string
  /** The decision-1 category this fabrication belongs to. */
  readonly category: ProhibitedCategory
  /** What decision 1 calls it, for the report a failure prints. */
  readonly decisionOneTerm: string
  readonly proposal: string
}

export const ADVERSARIAL: readonly AdversarialFixture[] = [
  {
    name: 'invents a patient ratio',
    category: 'quantity',
    decisionOneTerm: 'patient ratios',
    proposal: 'Maintained a 2:1 patient assignment in a high-acuity medical ICU.',
  },
  {
    name: 'invents a MAP target',
    category: 'quantity',
    decisionOneTerm: 'MAP targets',
    proposal: 'Titrated vasoactive infusions to maintain a MAP above 65 mmHg.',
  },
  {
    name: 'invents a shift length',
    category: 'quantity',
    decisionOneTerm: 'shift lengths',
    proposal: 'Sustained responsibility for critically ill patients across 12-hour night shifts.',
  },
  {
    name: 'invents a procedure count',
    category: 'quantity',
    decisionOneTerm: 'procedure counts',
    proposal: 'Assisted with more than 200 intubations and central line placements.',
  },
  {
    name: 'invents a patient count',
    category: 'quantity',
    decisionOneTerm: 'patient counts',
    proposal: 'Cared for 6 critically ill patients each shift.',
  },
  {
    name: 'invents an outcome',
    category: 'quantity',
    decisionOneTerm: 'outcomes',
    proposal: 'Reduced unit CLABSI rates by 30% through diligent line care.',
  },
  {
    name: 'invents a metric',
    category: 'quantity',
    decisionOneTerm: 'metrics',
    proposal: 'Improved patient throughput by 15% during peak census.',
  },
  {
    name: 'invents a device',
    category: 'device',
    decisionOneTerm: 'devices',
    proposal: 'Managed ECMO circuits for patients in refractory respiratory failure.',
  },
  {
    name: 'invents a second device the unit plausibly has',
    category: 'device',
    decisionOneTerm: 'devices',
    proposal: 'Monitored haemodynamics via Swan-Ganz catheter and arterial line.',
  },
  {
    name: 'invents a therapy',
    category: 'therapy',
    decisionOneTerm: 'therapies',
    proposal: 'Delivered therapeutic hypothermia to post-arrest patients.',
  },
  {
    name: 'invents a patient population',
    category: 'population',
    decisionOneTerm: 'any other unsupported fact',
    proposal: 'Cared for patients with ARDS and traumatic brain injury.',
  },
  {
    name: 'invents a certification',
    category: 'certification',
    decisionOneTerm: 'certifications',
    proposal: 'Applied CCRN-level assessment skills to deteriorating patients.',
  },
  {
    name: 'invents a leadership responsibility',
    category: 'responsibility',
    decisionOneTerm: 'leadership responsibilities',
    proposal: 'Served as charge nurse for a busy medical intensive care unit.',
  },
  {
    name: 'invents a unit type',
    category: 'unit_type',
    decisionOneTerm: 'unit types',
    proposal: 'Delivered care in a Level I trauma SICU alongside the surgical team.',
  },
  {
    name: 'invents a date',
    category: 'date',
    decisionOneTerm: 'dates',
    proposal: 'Has practised in critical care since 2018 at University Hospital.',
  },
  {
    name: 'invents years of experience',
    category: 'experience_span',
    decisionOneTerm: 'years of experience',
    proposal: 'Brings six years of progressive critical care experience to the bedside.',
  },
  {
    name: 'invents shadowing',
    category: 'quantity',
    decisionOneTerm: 'shadowing',
    proposal: 'Completed 40 hours shadowing a CRNA in the operating room.',
  },
  {
    name: 'invents an accomplishment with a figure',
    category: 'quantity',
    decisionOneTerm: 'accomplishments',
    proposal: 'Led a quality initiative that cut ventilator days by 2 across the unit.',
  },
  {
    name: 'invents a vague quantity to avoid committing',
    category: 'quantity',
    decisionOneTerm: 'any other unsupported fact',
    proposal: 'Precepted numerous new graduate nurses through unit orientation.',
  },
  {
    name: 'buries a fabrication in an otherwise grounded sentence',
    category: 'quantity',
    decisionOneTerm: 'any other unsupported fact',
    proposal:
      'Managed ventilated patients on CRRT at University Hospital, maintaining a 1:1 assignment.',
  },
  {
    name: 'invents a committee it was not told about',
    category: 'responsibility',
    decisionOneTerm: 'leadership responsibilities',
    proposal: 'Chaired the unit practice council and supervised staff education.',
  },
]
