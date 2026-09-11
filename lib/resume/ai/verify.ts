/**
 * The deterministic verifier.
 *
 * Of the five truthfulness layers, this is the only one testable without
 * calling a model, which is why it carries the weight. A prompt instruction is
 * the weakest layer -- V1's prompt said "every bullet needs a measurable
 * outcome" and supplied worked examples with patient ratios the product never
 * collected, so the model obliged and invented them. A prompt change can
 * silently undo a prompt instruction. It cannot undo this.
 *
 * WHAT IT DOES. Scans a proposal for the things decision 1 forbids inventing --
 * quantities, named clinical entities, credentials, dates, spans of experience,
 * claimed responsibilities -- and requires each to trace to a fact the
 * applicant supplied. Anything unaccounted for is a violation.
 *
 * WHAT HAPPENS THEN, per the locked decision: the proposal is REJECTED and the
 * violation is NAMED. The applicant is told what the assistant tried to add and
 * can supply it; they are never shown fabricated text with an Accept button
 * beside it. That is the whole point of the subsystem, and highlighting a span
 * for them to judge would have handed the judgment back at the worst moment.
 *
 * THE COST OF THAT CHOICE is that a false positive blocks legitimate output
 * with no override. So the rules here are deliberately narrow and literal, and
 * a false-positive suite sits beside the adversarial one. When the two pull
 * against each other, the tie-break is: never invent, and say why.
 *
 * Pure, deterministic, no network, no model.
 */

import type { FactSheet } from '../model/facts.ts'

/** The categories decision 1 names. `other` carries its catch-all clause. */
export type ProhibitedCategory =
  | 'quantity'
  | 'device'
  | 'therapy'
  | 'certification'
  | 'unit_type'
  | 'population'
  | 'date'
  | 'experience_span'
  | 'responsibility'
  | 'other'

export interface Violation {
  readonly category: ProhibitedCategory
  /** Exactly what the proposal said, so the message can quote it. */
  readonly token: string
  /** Shown to the applicant. Plain English, no jargon, no blame. */
  readonly message: string
}

export type VerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly Violation[] }

export interface VerifyOptions {
  /**
   * The text being improved, when the operation is an improvement.
   *
   * Anything already in it is not a new invention: the applicant has that
   * sentence on their resume already, and flagging it would make an accepted
   * bullet impossible to edit ever again. New content still has to trace to a
   * fact.
   */
  readonly existingText?: string
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Clinical nouns a proposal may not introduce.
 *
 * Not a complete list of equipment -- an exhaustive one is impossible and a
 * missing entry only means a miss, never a false positive. These are the ones
 * a model reaches for when it is padding: the plausible-but-absent device is
 * the single most common fabrication in this domain.
 */
const DEVICES = [
  'ventilator', 'ventilators', 'ventilated', 'vent', 'ecmo', 'crrt', 'cvvh', 'cvvhd', 'iabp',
  'impella', 'balloon pump', 'arterial line', 'art line', 'central line',
  'swan-ganz', 'swan ganz', 'pulmonary artery catheter', 'tracheostomy',
  'bipap', 'cpap', 'hfov', 'high-flow nasal cannula', 'ekg', 'ecg',
  'telemetry', 'feeding tube', 'chest tube', 'lvad', 'rvad', 'defibrillator',
  'pacemaker', 'dialysis machine', 'infusion pump', 'ventriculostomy', 'evd',
]

const THERAPIES = [
  'vasopressors', 'vasoactive', 'pressors', 'inotropes', 'sedation',
  'paralytics', 'therapeutic hypothermia', 'targeted temperature management',
  'proning', 'prone positioning', 'thrombolytics', 'tpa', 'transfusion',
  'massive transfusion', 'insulin drip', 'continuous dialysis', 'plasmapheresis',
  'moderate sedation', 'procedural sedation', 'rapid sequence intubation', 'rsi',
]

const CERTIFICATIONS = [
  'ccrn', 'cmc', 'csc', 'tncc', 'acls', 'bls', 'pals', 'nrp', 'cen', 'cfrn',
  'nihss', 'crrn', 'sccm', 'fccs', 'abls', 'trauma nursing core course',
]

/**
 * Named patient cohorts.
 *
 * Specific diagnoses only. Generic clinical descriptors -- "respiratory
 * failure", "critically ill", "haemodynamically unstable" -- are deliberately
 * absent: they describe the work rather than assert a cohort the applicant
 * never mentioned, and listing them would reject ordinary honest writing. A
 * missing entry here is a miss; a wrong one is a false positive, and under a
 * reject-outright policy those are not equally cheap.
 */
const POPULATIONS = [
  'septic shock', 'sepsis', 'ards', 'dka', 'gi bleed', 'variceal bleed',
  'traumatic brain injury', 'tbi', 'post-arrest', 'cardiac arrest',
  'stroke', 'ischaemic stroke', 'ischemic stroke', 'subarachnoid haemorrhage',
  'subarachnoid hemorrhage', 'cabg', 'post-cabg', 'transplant', 'overdose',
  'burns', 'covid', 'status epilepticus', 'liver failure', 'pancreatitis',
]

const UNIT_TYPES = [
  'micu', 'sicu', 'cvicu', 'cticu', 'nicu', 'picu', 'neuro icu', 'neuro-icu',
  'trauma icu', 'burn icu', 'cardiac icu', 'medical icu', 'surgical icu',
  'level i trauma', 'level 1 trauma', 'step-down', 'stepdown', 'pacu',
  'emergency department', 'operating room',
]

/**
 * Claims about authority over people or a unit.
 *
 * Deliberately narrow: "managed" alone is not here, because "managed
 * vasoactive infusions" is ordinary clinical language and flagging it would
 * make the verifier useless. What is here asserts a ROLE.
 */
const RESPONSIBILITY_CLAIMS = [
  'charge nurse', 'charge role', 'as charge', 'precepted', 'preceptor',
  'precepting', 'chaired', 'chairperson', 'committee', 'unit council',
  'supervised', 'led a team', 'team lead', 'shift lead', 'management role',
  'trained staff', 'mentored',
]

/** Written numbers a model reaches for when it has no figure to cite. */
const WRITTEN_NUMBERS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'fifty',
  'hundred', 'hundreds', 'dozen', 'dozens', 'several', 'numerous', 'countless',
  'many', 'multiple',
]

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function buildSupport(sheet: FactSheet, options: VerifyOptions): Support {
  const text = normalise([...sheet.facts.map((f) => f.value), options.existingText ?? ''].join(' • '))
  return { text, numbers: supportedNumbers(text) }
}

/**
 * Everything the proposal may draw on, prepared once per call.
 *
 * `numbers` holds whole numeric TOKENS, not a run of digits. The distinction
 * decides whether the verifier works at all: concatenating every digit in the
 * sheet turns "24-bed medical ICU" and "Mar 2021" into "242021", inside which
 * an invented "2:1" ratio appears to be supported. Tokens cannot do that.
 */
interface Support {
  readonly text: string
  readonly numbers: ReadonlySet<string>
}

/** A number as claimed: "2:1", "24", "3.5". Separators kept, spacing dropped. */
const NUMERIC_FORM = /\d+(?:\s*[:./]\s*\d+)*/

function numericForm(token: string): string {
  const match = NUMERIC_FORM.exec(token)
  return match ? match[0].replace(/\s+/g, '') : ''
}

/**
 * The numeric tokens a body of supplied text licenses.
 *
 * A compound token also licenses its parts: a fact of "2:1" means the applicant
 * really did supply a 2 and a 1. The reverse is deliberately not true -- facts
 * containing 2 and 1 separately do not license a claimed "2:1" ratio, which is
 * exactly the fabrication this catches.
 */
function supportedNumbers(text: string): Set<string> {
  const out = new Set<string>()
  for (const match of text.matchAll(new RegExp(NUMERIC_FORM.source, 'g'))) {
    const whole = match[0].replace(/\s+/g, '')
    if (whole === '') continue
    out.add(whole)
    for (const part of whole.split(/[:./]/)) if (part !== '') out.add(part)
  }
  return out
}

function supportsNumber(support: Support, token: string): boolean {
  const form = numericForm(token)
  return form !== '' && support.numbers.has(form)
}

/**
 * English suffixes, crudely. A resume says "precepted" where the field that
 * records it says "Preceptor experience", and "ventilated patients" where the
 * device list says "Ventilator". Requiring an exact match would reject both --
 * the most damaging kind of false positive, because it flags the applicant's
 * own recorded facts as inventions.
 */
function stemOf(word: string): string {
  return word.replace(/(?:ed|ing|es|or|er|s)$/i, '')
}

function supportsPhrase(support: Support, phrase: string): boolean {
  const wanted = normalise(phrase)
  if (support.text.includes(wanted)) return true
  const stem = stemOf(wanted)
  // Four characters keeps a stem meaningful; "led" must not match "ledger".
  return stem.length >= 4 && support.text.includes(stem)
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

const RATIO = /\b\d+\s*:\s*\d+\b/g
const PERCENT = /\b\d+(?:\.\d+)?\s*%/g
const YEARS_EXPERIENCE = /\b\d+\+?\s*(?:\+\s*)?years?\b(?:\s+of\s+\w+)?/gi
const YEAR = /\b(?:19|20)\d{2}\b/g
const NUMBER_WITH_UNIT =
  /\b\d+(?:\.\d+)?\s*-?\s*(?:hours?|hrs?|beds?|patients?|mmhg|mg|mcg|ml|l|days?|weeks?|months?|shifts?|cases?|procedures?|admissions?|codes?|units?)\b/gi
const BARE_NUMBER = /\b\d+(?:\.\d+)?\b/g

interface Detector {
  readonly category: ProhibitedCategory
  readonly find: (text: string) => string[]
  readonly supported: (support: Support, token: string) => boolean
  readonly message: (token: string) => string
}

const byRegex = (pattern: RegExp) => (text: string): string[] =>
  Array.from(text.matchAll(new RegExp(pattern.source, pattern.flags)), (m) => m[0].trim())

const byVocabulary = (words: readonly string[]) => (text: string): string[] => {
  const lower = text.toLowerCase()
  const found: string[] = []
  for (const word of words) {
    const at = lower.indexOf(word)
    if (at < 0) continue
    // Whole word: "vent" must not match inside "ventral".
    const before = at === 0 ? ' ' : lower[at - 1]
    const after = lower[at + word.length] ?? ' '
    if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue
    // Sliced from the original so a message quotes "ECMO" as the applicant
    // wrote it, not the lower-case entry that matched it.
    found.push(text.slice(at, at + word.length))
  }
  return found
}

const DETECTORS: readonly Detector[] = [
  {
    category: 'certification',
    find: byVocabulary(CERTIFICATIONS),
    supported: supportsPhrase,
    message: (t) => `names a certification you have not listed: “${t.toUpperCase()}”.`,
  },
  {
    category: 'device',
    find: byVocabulary(DEVICES),
    supported: supportsPhrase,
    message: (t) => `names equipment you have not listed: “${t}”.`,
  },
  {
    category: 'therapy',
    find: byVocabulary(THERAPIES),
    supported: supportsPhrase,
    message: (t) => `names a therapy you have not listed: “${t}”.`,
  },
  {
    category: 'unit_type',
    find: byVocabulary(UNIT_TYPES),
    supported: supportsPhrase,
    message: (t) => `names a unit you have not listed: “${t}”.`,
  },
  {
    category: 'population',
    find: byVocabulary(POPULATIONS),
    supported: supportsPhrase,
    message: (t) => `names a patient group you have not listed: “${t}”.`,
  },
  {
    category: 'responsibility',
    find: byVocabulary(RESPONSIBILITY_CLAIMS),
    supported: supportsPhrase,
    message: (t) => `claims a responsibility you have not recorded: “${t}”.`,
  },
  {
    category: 'experience_span',
    find: byRegex(YEARS_EXPERIENCE),
    supported: supportsNumber,
    message: (t) => `states a span of experience you have not given: “${t}”.`,
  },
  {
    category: 'date',
    find: byRegex(YEAR),
    supported: supportsNumber,
    message: (t) => `states a date you have not given: “${t}”.`,
  },
  {
    category: 'quantity',
    find: (text) => [
      ...byRegex(RATIO)(text),
      ...byRegex(PERCENT)(text),
      ...byRegex(NUMBER_WITH_UNIT)(text),
    ],
    supported: supportsNumber,
    message: (t) => `states a figure you have not given: “${t}”.`,
  },
  {
    category: 'quantity',
    find: byVocabulary(WRITTEN_NUMBERS),
    supported: supportsPhrase,
    message: (t) => `states a quantity you have not given: “${t}”.`,
  },
  {
    category: 'quantity',
    find: byRegex(BARE_NUMBER),
    supported: supportsNumber,
    message: (t) => `states a number you have not given: “${t}”.`,
  },
]

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Checks one proposal against one fact sheet.
 *
 * Violations are de-duplicated by token so a bullet repeating an invented
 * figure is reported once. The first detector to claim a token wins, and the
 * order above runs from most specific to least, so "CCRN" is reported as an
 * invented certification rather than as an unaccounted word.
 */
export function verifyGrounding(
  proposal: string,
  sheet: FactSheet,
  options: VerifyOptions = {}
): VerificationResult {
  const text = proposal ?? ''
  if (normalise(text) === '') return { ok: true }

  const support = buildSupport(sheet, options)
  const violations: Violation[] = []
  const claimed = new Set<string>()

  for (const detector of DETECTORS) {
    for (const token of detector.find(text)) {
      const key = normalise(token)
      if (key === '' || claimed.has(key)) continue
      claimed.add(key)
      // "2:1" is one claim, not three. Without this the bare-number sweep
      // reports the 2 and the 1 again, and a single fabrication reads as a
      // pile of them.
      for (const part of numericForm(token).split(/[:./]/)) {
        if (part !== '') claimed.add(part)
      }
      if (detector.supported(support, token)) continue
      violations.push({
        category: detector.category,
        token,
        message: detector.message(token),
      })
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

/** Verifies a whole set of proposed bullets, reporting per bullet. */
export function verifyAll(
  proposals: readonly string[],
  sheet: FactSheet,
  options: VerifyOptions = {}
): VerificationResult {
  const violations = proposals.flatMap((proposal) => {
    const result = verifyGrounding(proposal, sheet, options)
    return result.ok ? [] : result.violations
  })
  const seen = new Set<string>()
  const unique = violations.filter((v) => {
    const key = `${v.category}:${normalise(v.token)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.length === 0 ? { ok: true } : { ok: false, violations: unique }
}

/**
 * What the applicant is shown. One line per violation, in their language.
 *
 * The locked decision is "reject, and name what was unsupported" -- this is the
 * naming half, and the reason a Violation carries a message at all rather than
 * only a category the UI would have to translate.
 */
export function describeViolations(violations: readonly Violation[]): string[] {
  return violations.map((v) => `The assistant ${v.message}`)
}

/** A single sentence for a toast or an inline notice. */
export function summariseRejection(violations: readonly Violation[]): string {
  if (violations.length === 0) return ''
  if (violations.length === 1) return `That suggestion ${violations[0].message}`
  return `That suggestion added ${violations.length} things you have not told us, starting with: ${violations[0].token}.`
}
