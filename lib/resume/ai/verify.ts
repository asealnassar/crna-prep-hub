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
  'charge nurse', 'charge rn', 'charge role', 'as charge', 'precepted', 'preceptor',
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
// Claims whose support is bound to the claim
// ---------------------------------------------------------------------------

/**
 * Written cardinals with one exact value. Vague quantities ("several",
 * "dozens") have no value and are absent on purpose.
 */
const CARDINALS: Readonly<Record<string, string>> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50',
}

/** Qualifiers written before a span's number: "more than 4 years". */
const QUALIFIERS_BEFORE = [
  'no more than', 'no less than', 'more than', 'less than', 'fewer than',
  'in excess of', 'upwards of', 'at least', 'at most', 'close to', 'up to',
  'over', 'above', 'under', 'below', 'nearly', 'almost', 'about',
  'approximately', 'around', 'roughly',
]

/**
 * How much a qualifier claims. Synonyms share a strength and nothing else
 * does: "over" stands in for "more than", never for "nearly", and no qualifier
 * stands in for its own absence.
 */
const STRENGTH: Readonly<Record<string, string>> = {
  'more than': 'more-than', over: 'more-than', above: 'more-than',
  'in excess of': 'more-than', 'upwards of': 'more-than', '>': 'more-than',
  'at least': 'at-least', 'no less than': 'at-least', '≥': 'at-least', '+': 'at-least',
  'or more': 'at-least', 'or longer': 'at-least', 'and counting': 'at-least',
  nearly: 'nearly', almost: 'nearly', 'close to': 'nearly',
  about: 'about', approximately: 'about', around: 'about', roughly: 'about',
  '~': 'about', 'or so': 'about',
  'less than': 'less-than', 'fewer than': 'less-than', under: 'less-than',
  below: 'less-than', '<': 'less-than',
  'up to': 'up-to', 'at most': 'up-to', 'no more than': 'up-to', '≤': 'up-to',
}

const alternatives = (phrases: readonly string[]): string =>
  phrases.map((phrase) => phrase.replace(/ /g, String.raw`\s+`)).join('|')

/**
 * A span of experience: a count of years, in digits or words, with whatever
 * qualifies it.
 *
 * A span is supported only by a supplied span of the same value AND the same
 * strength, and its number supports nothing else. "Four years" supports
 * "4 years"; it does not support "more than 4 years", "4 patients", "4%" or
 * "4:1", and the 4 of "4 West" does not support "4 years".
 *
 * Deliberately not a span: a compound or range ("twenty-four years", "2-4
 * years" are refused rather than misread as 4), an age ("4 years old"), a time
 * ago ("4 years ago"), or a hyphenated adjective ("a four-year program").
 */
const SPAN = new RegExp(
  String.raw`(?<![a-z0-9])` +
  String.raw`(?:(?<intensity>just|well|slightly|far|a\s+little|a\s+bit)\s+(?=(?:${alternatives(QUALIFIERS_BEFORE)})\s))?` +
  String.raw`(?:(?<before>${alternatives(QUALIFIERS_BEFORE)})\s+|(?<symbol>[~<>≤≥])\s*)?` +
  String.raw`(?<![a-z0-9.])(?<![a-z0-9]\s*[-–/]\s*)` +
  String.raw`(?<value>\d+(?:\.\d+)?|${Object.keys(CARDINALS).join('|')})` +
  String.raw`(?:\s*(?<plus>\+)|\s+(?<inner>or\s+(?:more|longer|so)))?` +
  String.raw`\s*(?:years?|yrs?)\b` +
  String.raw`(?:\s+(?<after>or\s+(?:more|longer|so)|and\s+counting))?` +
  String.raw`(?![-\s]*(?:old|ago)\b)`,
  'gi'
)

/** A span as quoted back: the claim, plus the words that make it recognisable. */
const SPAN_CLAIM = new RegExp(SPAN.source + String.raw`(?:\s+of\s+\w+)?`, 'gi')

/**
 * What a span claims, as "intensity|strength|value": "|more-than|4" for both
 * "more than four years" and "over 4 years". Two spans agree only when all
 * three parts do.
 */
function spanKey(groups: Readonly<Record<string, string | undefined>>): string {
  const plain = (part: string) => part.toLowerCase().replace(/\s+/g, ' ')
  const strength = [groups.before ?? groups.symbol, groups.plus, groups.inner, groups.after]
    .filter((part): part is string => part !== undefined)
    .map((part) => STRENGTH[plain(part)] ?? plain(part))
    .sort()
    .join('+')
  const value = plain(groups.value ?? '')
  const intensity = groups.intensity ? plain(groups.intensity) : ''
  return [intensity, strength, CARDINALS[value] ?? String(Number(value))].join('|')
}

/** Blanks every span, keeping length so indices still quote what was written. */
function blankSpans(text: string): string {
  return text.replace(SPAN, (span) => '§'.repeat(span.length))
}

/** Detected phrasings that claim the charge-nurse role. */
const CHARGE_CLAIMS: ReadonlySet<string> = new Set(['charge nurse', 'charge rn', 'charge role', 'as charge'])

/** A job title that IS the role, as the whole field: "Charge Nurse", "Relief Charge RN". */
const CHARGE_TITLE = /^(?:relief\s+)?charge\s+(?:nurse|rn)$/i

/**
 * Prose that asserts the charge role, as whole phrases: "charge nurse
 * experience", "served as charge (nurse)", "as charge nurse", and their RN
 * forms. "Discharge nurse" never matches, and neither does a mention: "worked
 * alongside the charge nurse", "such as charge nurse rounds".
 */
const CHARGE_ASSERTION = new RegExp(
  String.raw`(?<![a-z0-9])(?:` +
  String.raw`(?<!such\s+as\s+(?:an?\s+)?)charge\s+(?:nurse|rn)\s+experience` +
  String.raw`|served\s+as\s+(?:an?\s+)?charge(?:\s+(?:nurse|rn))?` +
  String.raw`|(?<!such\s+)as\s+(?:an?\s+)?charge\s+(?:nurse|rn)` +
  String.raw`)(?![a-z0-9])`,
  'gi'
)

/** "haven't", "hasn’t", "didnt": a straight, curly or missing apostrophe. */
const CONTRACTED_NEGATION =
  String.raw`(?:is|are|was|were|have|has|had|do|does|did|wo|ca|could|would|should|must|need)n['’]?t`

/**
 * Earlier in the same sentence, these stop a phrase asserting the role:
 * negation, and wanting the role rather than having it. They err towards
 * refusing -- a listed word voids the phrase even where it negated something
 * else in the sentence.
 */
const VOIDS_BEFORE = new RegExp(
  String.raw`(?<![a-z0-9])(?:no|not(?!\s+only\b)|never|without|cannot|lack(?:s|ed|ing)?|${CONTRACTED_NEGATION}` +
  String.raw`|yet\s+to|seek(?:s|ing)?|sought|aspir(?:e|es|ed|ing)|hop(?:e|es|ed|ing)|want(?:s|ed|ing)?` +
  String.raw`|would\s+like|plan(?:s|ned|ning)?\s+to|goal|towards?|pursu(?:e|es|ing)|gain(?:ing)?|looking\s+to)(?![a-z0-9])`,
  'i'
)

/** Later in the same sentence: "Charge nurse experience: none", "(not yet)", "…that I haven't had". */
const VOIDS_AFTER = new RegExp(
  String.raw`[:\-–—(]\s*(?:no|not|never|pending)(?![a-z0-9])` +
  String.raw`|(?<![a-z0-9])(?:none|n\/a|${CONTRACTED_NEGATION})(?![a-z0-9])`,
  'i'
)

/** Where a sentence ends. A full stop counts only before whitespace, so "4.5" does not end one. */
const SENTENCE_END = /[;!?•\n]|\.(?=\s|$)/g

/**
 * Whether the charge-nurse role is clearly asserted: the checkbox, a job title
 * that is exactly the role, or an asserting phrase that no negation reaches.
 */
function assertsChargeRole(sheet: FactSheet, sources: readonly string[]): boolean {
  if (sheet.facts.some((fact) => fact.kind === 'charge_role')) return true
  if (sheet.facts.some((fact) => fact.kind === 'role' && CHARGE_TITLE.test(fact.value.trim()))) return true
  return sources.some((source) => assertedInProse(source))
}

function assertedInProse(source: string): boolean {
  const ends = Array.from(source.matchAll(SENTENCE_END), (end) => end.index ?? 0)
  for (const match of source.matchAll(CHARGE_ASSERTION)) {
    const start = match.index ?? 0
    const finish = start + match[0].length
    const sentenceStart = Math.max(0, ...ends.filter((at) => at < start).map((at) => at + 1))
    const sentenceEnd = Math.min(source.length, ...ends.filter((at) => at >= finish))
    if (VOIDS_BEFORE.test(source.slice(sentenceStart, start))) continue
    if (VOIDS_AFTER.test(source.slice(finish, sentenceEnd))) continue
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function buildSupport(sheet: FactSheet, options: VerifyOptions): Support {
  const sources = [...sheet.facts.map((f) => f.value), options.existingText ?? '']
  const text = normalise(sources.join(' • '))
  const outsideSpans = blankSpans(text)
  return {
    text,
    // A span's digits support that span and nothing else.
    numbers: supportedNumbers(outsideSpans),
    spans: new Set(Array.from(text.matchAll(SPAN), (span) => spanKey(span.groups ?? {}))),
    outsideSpans,
    chargeRole: assertsChargeRole(sheet, sources),
  }
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
  /** Numeric tokens from everything OUTSIDE a span of experience. */
  readonly numbers: ReadonlySet<string>
  /** What each supplied span claims, as keyed by `spanKey`. */
  readonly spans: ReadonlySet<string>
  /** `text` with its spans blanked. */
  readonly outsideSpans: string
  /** Whether the charge-nurse role is clearly asserted. */
  readonly chargeRole: boolean
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

/** A span is supported by a supplied span that claims exactly the same, and by nothing else. */
function supportsSpan(support: Support, token: string): boolean {
  const span = new RegExp(SPAN.source, 'i').exec(token)
  return span !== null && support.spans.has(spanKey(span.groups ?? {}))
}

/**
 * A written number outside a span needs the same whole word, outside a span, in
 * what was supplied. Not a digit, and not part of another word: "ten" is not in
 * "intensive", and the "four" of "four years" counts years, not patients.
 * Vague quantities keep the literal rule they had.
 */
function supportsWrittenNumber(support: Support, token: string): boolean {
  const word = normalise(token)
  if (CARDINALS[word] === undefined) return supportsPhrase(support, token)
  return new RegExp(String.raw`(?<![a-z0-9])${word}(?![a-z0-9])`).test(support.outsideSpans)
}

/** A charge-role claim needs the role clearly asserted. Other responsibilities are unchanged. */
function supportsResponsibility(support: Support, phrase: string): boolean {
  if (CHARGE_CLAIMS.has(normalise(phrase))) return support.chargeRole
  return supportsPhrase(support, phrase)
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

const RATIO = /\b\d+\s*:\s*\d+\b/g
const PERCENT = /\b\d+(?:\.\d+)?\s*%/g
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
    supported: supportsResponsibility,
    message: (t) => `claims a responsibility you have not recorded: “${t}”.`,
  },
  {
    category: 'experience_span',
    find: byRegex(SPAN_CLAIM),
    supported: supportsSpan,
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
    supported: supportsWrittenNumber,
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
  // Spans are read from the proposal as written. Every other detector reads it
  // with the spans blanked, so a span's number is never judged -- or excused --
  // as a claim of its own.
  const outsideSpans = blankSpans(text)

  for (const detector of DETECTORS) {
    const isSpan = detector.category === 'experience_span'
    for (const token of detector.find(isSpan ? text : outsideSpans)) {
      const key = normalise(token)
      if (key === '' || claimed.has(key)) continue
      claimed.add(key)
      // "2:1" is one claim, not three. Without this the bare-number sweep
      // reports the 2 and the 1 again, and a single fabrication reads as a
      // pile of them. A span needs no such cover: its number is blanked.
      if (!isSpan) {
        for (const part of numericForm(token).split(/[:./]/)) {
          if (part !== '') claimed.add(part)
        }
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
