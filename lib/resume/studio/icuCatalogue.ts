/**
 * The ICU experience an applicant can tick, and where each tick is stored.
 *
 * WHY A CATALOGUE AT ALL. "Write bullets from these facts" was only ever as good
 * as the facts, and a position usually carried four: an employer, a role, a unit
 * and a date range. From that a model can write nothing true and specific, so it
 * either wrote something vague or reached for something invented. The fix is not
 * a better prompt -- it is asking the applicant what they have actually done, in
 * the vocabulary of their own speciality, and treating each answer as a fact they
 * supplied.
 *
 * A TICK IS A CLAIM THE APPLICANT MAKES. Nothing here is selected by default,
 * nothing is inferred from a unit type or a job title, and an unticked item is
 * not a fact -- it is the absence of one, exactly as a false flag has always
 * been. That is what makes a ticked item legitimate grounding: a person said so.
 *
 * NO DOSES, NO NUMBERS. The catalogue names therapies, not regimens. "How much
 * norepinephrine" is a clinical detail no resume states and no model may supply,
 * and leaving it out of the vocabulary is how it stays out of the grounding.
 *
 * WHERE IT GOES. Every selection lands in a list ClinicalFacts already has, so
 * this adds no column, no migration and no new patch operation -- and the facts
 * reach a proposal through `positionFacts`, the path they have always taken.
 * ClinicalFacts is grounding and never renders, so ticking twelve devices does
 * not print twelve devices on the resume.
 */

/** The ClinicalFacts lists a selection can be stored in. */
export type IcuFactField =
  | 'devices'
  | 'therapies'
  | 'patientPopulations'
  | 'specialResponsibilities'

export interface IcuCategory {
  readonly id: string
  readonly title: string
  /** One line under the heading, in the applicant's terms. */
  readonly help: string
  readonly field: IcuFactField
  readonly options: readonly string[]
}

/** One thing the applicant has ticked, and the list it belongs in. */
export interface IcuSelection {
  readonly field: IcuFactField
  readonly value: string
}

export const ICU_CATEGORIES: readonly IcuCategory[] = [
  {
    id: 'devices',
    title: 'Devices & monitoring',
    help: 'Lines, pumps and monitoring you have managed at the bedside.',
    field: 'devices',
    options: [
      'Arterial line',
      'Central venous catheter',
      'Swan-Ganz (pulmonary artery) catheter',
      'Intra-aortic balloon pump (IABP)',
      'Impella',
      'VA ECMO',
      'VV ECMO',
      'CRRT',
      'Chest tubes',
      'Temporary pacing',
      'ICP monitoring / EVD',
      'Continuous EEG',
    ],
  },
  {
    id: 'respiratory',
    title: 'Respiratory & advanced therapies',
    help: 'Support and therapies you have set up, titrated or managed.',
    field: 'therapies',
    options: [
      'Invasive mechanical ventilation',
      'BiPAP',
      'CPAP',
      'High-flow nasal cannula',
      'Proning',
      'Inhaled pulmonary vasodilators',
      'Massive transfusion',
      'Targeted temperature management',
    ],
  },
  {
    id: 'medications',
    title: 'Medications & infusions',
    help: 'Infusions you have titrated or managed. Names only -- never doses.',
    field: 'therapies',
    options: [
      'Norepinephrine',
      'Epinephrine',
      'Vasopressin',
      'Phenylephrine',
      'Dopamine',
      'Dobutamine',
      'Milrinone',
      'Propofol',
      'Dexmedetomidine',
      'Midazolam',
      'Fentanyl',
      'Ketamine',
      'Cisatracurium',
      'Rocuronium',
      'Amiodarone',
      'Diltiazem',
      'Esmolol',
      'Nicardipine',
      'Nitroglycerin',
      'Sodium nitroprusside',
      'Insulin infusion',
      'Heparin infusion',
      'Argatroban',
    ],
  },
  {
    id: 'conditions',
    title: 'Conditions & patient populations',
    help: 'The patients you have actually cared for.',
    field: 'patientPopulations',
    options: [
      'Septic shock',
      'Cardiogenic shock',
      'Hemorrhagic / hypovolemic shock',
      'Obstructive shock',
      'ARDS',
      'Acute respiratory failure',
      'COPD / asthma exacerbation',
      'DKA / HHS',
      'Acute kidney injury / renal failure',
      'GI bleed',
      'Liver failure',
      'Pulmonary embolism',
      'Acute coronary syndrome',
      'Post-cardiac surgery',
      'Neurocritical care',
      'Trauma',
    ],
  },
  {
    id: 'responsibilities',
    title: 'Responsibilities & skills',
    help: 'What you are trusted to do beyond your own assignment.',
    field: 'specialResponsibilities',
    options: [
      'Code Blue response',
      'Rapid Response',
      'Charge nurse',
      'Precepting',
      'Admissions and transfers',
      'Multidisciplinary rounds',
      'Vasoactive titration',
      'Sedation management',
      'Advanced hemodynamic interpretation',
      'Ventilator management',
      'ACLS / resuscitation',
    ],
  },
]

/**
 * Two facts compared, for duplicates only.
 *
 * Case and punctuation vary between "VA ECMO", "va-ecmo" and "VA-ECMO"; all
 * three are the same claim. What is STORED is always what was ticked or typed.
 */
export function sameFact(a: string, b: string): boolean {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return key(a) !== '' && key(a) === key(b)
}

/** Whether this position already carries the fact. */
export function alreadyHasFact(existing: readonly string[], value: string): boolean {
  return existing.some((fact) => sameFact(fact, value))
}

/**
 * The catalogue narrowed to a search.
 *
 * Matches the option and the category title, so "ecmo" finds the two ECMO
 * options and "respiratory" keeps that whole group. An empty query is the whole
 * catalogue; a query nothing matches is an empty list, not everything.
 */
export function filterCategories(query: string): IcuCategory[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...ICU_CATEGORIES]

  return ICU_CATEGORIES
    .map((category) => {
      if (category.title.toLowerCase().includes(needle)) return category
      const options = category.options.filter((option) => option.toLowerCase().includes(needle))
      return { ...category, options }
    })
    .filter((category) => category.options.length > 0)
}

/**
 * Selections grouped into the lists they are stored in.
 *
 * Two categories share `therapies` -- an infusion and a mode of ventilation are
 * both things done to a patient, and ClinicalFacts has one list for that -- so
 * grouping happens here rather than in the editor.
 */
export function groupSelections(
  selections: readonly IcuSelection[]
): Partial<Record<IcuFactField, string[]>> {
  const grouped: Partial<Record<IcuFactField, string[]>> = {}

  for (const { field, value } of selections) {
    const trimmed = value.trim()
    if (trimmed === '') continue
    const list = grouped[field] ?? []
    if (list.some((existing) => sameFact(existing, trimmed))) continue
    grouped[field] = [...list, trimmed]
  }
  return grouped
}

/**
 * What a list should hold once the new selections are added.
 *
 * Additive: what the applicant has already told us stays, because a picker that
 * silently dropped facts on its way past would lose work nobody meant to undo.
 */
export function mergeFacts(existing: readonly string[], additions: readonly string[]): string[] {
  const merged = [...existing]
  for (const addition of additions) {
    const trimmed = addition.trim()
    if (trimmed === '' || merged.some((fact) => sameFact(fact, trimmed))) continue
    merged.push(trimmed)
  }
  return merged
}
