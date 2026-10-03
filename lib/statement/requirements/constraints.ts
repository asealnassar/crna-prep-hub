/**
 * What a school demands about the SHAPE of a document, as structured data.
 *
 * THE WHOLE POINT OF THIS MODULE IS THAT UNITS ARE NOT INTERCHANGEABLE. A
 * school that asks for two double-spaced pages has not asked for 500 words, and
 * a school that asks for 2,500 characters has not asked for 400. Those
 * conversions are where a product starts telling applicants things no admissions
 * office said, so no function here performs one -- not even a hedged one, not
 * even for a progress bar. A page limit yields no word limit, ever.
 *
 * WHAT THIS SYSTEM CAN ACTUALLY MEASURE IS WORDS AND CHARACTERS. It is a
 * plain-text editor: it has no page, no font, no margin and no line spacing, so
 * it cannot know whether a draft is two pages in 12-point Times with one-inch
 * margins. Those requirements are therefore DISPLAYED and never CHECKED, and
 * measurableInEditor() below is the single place that distinction is made.
 *
 * ABSENT IS NOT ZERO AND NOT "NO LIMIT STATED BY US". Every bound is nullable
 * and null means the school did not state one. A null maximum must never be
 * rendered as a limit, defaulted to a house value, or inferred from a sibling
 * unit.
 */

/** A limit expressed in words. Either bound may be unstated. */
export interface WordLimit {
  readonly min: number | null
  readonly max: number | null
}

/**
 * A limit expressed in characters.
 *
 * spacesCount IS THREE-VALUED AND THAT IS NOT AN OVERSIGHT. true is "including
 * spaces", false is "excluding spaces", and null is a school that gave a
 * character count without saying which -- a real and common case that must not
 * be guessed, because the two readings differ by roughly a sixth of the text.
 */
export interface CharacterLimit {
  readonly min: number | null
  readonly max: number | null
  readonly spacesCount: boolean | null
}

/**
 * A limit expressed in pages.
 *
 * NOTHING DOWNSTREAM MAY TURN THIS INTO WORDS. It is carried so it can be shown
 * to the applicant in the school's own unit, and so the analyser can be told
 * plainly that this system has not measured it.
 */
export interface PageLimit {
  readonly min: number | null
  readonly max: number | null
  readonly spacing: Spacing | null
}

export type Spacing = 'single' | 'double'

export const SPACING_LABELS: Readonly<Record<Spacing, string>> = {
  single: 'single-spaced',
  double: 'double-spaced',
}

/** Typography the school specified. None of it is measurable here. */
export interface Typography {
  readonly fontSizePt: number | null
  readonly fontFamily: string | null
  readonly marginsInches: number | null
}

/**
 * A citation style.
 *
 * TWO FIELDS, BECAUSE A FAMILY IS NOT THE SCHOOL'S WORDING. `family` is what
 * code may branch on; `statedAs` is what the school actually wrote -- "APA 7th
 * edition", "AMA format" -- and is what an applicant is shown, because an
 * edition is part of the requirement and collapsing it to "apa" would lose it.
 */
export interface Citation {
  readonly family: 'apa' | 'ama' | 'other'
  readonly statedAs: string
  readonly minReferences: number | null
}

export interface Constraints {
  readonly words: WordLimit | null
  readonly characters: CharacterLimit | null
  readonly pages: PageLimit | null
  readonly typography: Typography | null
  readonly citation: Citation | null
  /**
   * Requirements that have no structured home, in the school's own words.
   *
   * A HOLDING PEN, NOT A DUMPING GROUND. "business letter format" and
   * "excluding cover and references" are real instructions with no field of
   * their own; they are shown verbatim rather than dropped, and nothing parses
   * them.
   */
  readonly otherInstructions: readonly string[]
}

/** A document whose shape the school said nothing about. */
export const NO_CONSTRAINTS: Constraints = {
  words: null,
  characters: null,
  pages: null,
  typography: null,
  citation: null,
  otherInstructions: [],
}

// ---------------------------------------------------------------------------
// What the editor can and cannot measure
// ---------------------------------------------------------------------------

/** The kinds of requirement a constraint set can carry. */
export type ConstraintKind =
  | 'words' | 'characters' | 'pages' | 'spacing' | 'font' | 'margins' | 'citation' | 'other'

/**
 * Whether this product can verify a requirement of this kind.
 *
 * WORDS AND CHARACTERS, AND NOTHING ELSE. This is the function that stops a
 * page or a font turning into a compliance indicator somewhere downstream: any
 * display or scoring path asks here first, and gets false for everything it has
 * no way to observe in a textarea.
 */
export function measurableInEditor(kind: ConstraintKind): boolean {
  return kind === 'words' || kind === 'characters'
}

/** Said once, wherever unmeasurable requirements are shown. */
export const UNMEASURED_NOTICE =
  'This editor counts words and characters only. It cannot check page count, '
  + 'spacing, font, margins or citation format -- confirm those in your final document.'

/** Which kinds this constraint set actually carries, in display order. */
export function constraintKinds(constraints: Constraints): readonly ConstraintKind[] {
  const kinds: ConstraintKind[] = []
  if (constraints.words !== null) kinds.push('words')
  if (constraints.characters !== null) kinds.push('characters')
  if (constraints.pages !== null) kinds.push('pages')
  if (constraints.pages?.spacing != null) kinds.push('spacing')
  if (constraints.typography?.fontSizePt != null || constraints.typography?.fontFamily != null) {
    kinds.push('font')
  }
  if (constraints.typography?.marginsInches != null) kinds.push('margins')
  if (constraints.citation !== null) kinds.push('citation')
  if (constraints.otherInstructions.length > 0) kinds.push('other')
  return kinds
}

/** The kinds present that this system cannot check. Drives the notice. */
export function unmeasurableKinds(constraints: Constraints): readonly ConstraintKind[] {
  return constraintKinds(constraints).filter((kind) => !measurableInEditor(kind))
}

/** Whether anything here is beyond the editor's reach. */
export function hasUnmeasurableConstraint(constraints: Constraints): boolean {
  return unmeasurableKinds(constraints).length > 0
}

// ---------------------------------------------------------------------------
// The live counts
// ---------------------------------------------------------------------------

/** Which live counters the editor should show for this requirement. */
export type LiveCount = 'words' | 'characters'

/**
 * The counters worth showing, in display order.
 *
 * DRIVEN BY WHAT THE SCHOOL ASKED, not by what is easy. A character-limited
 * response gets a character counter, because an applicant watching a word count
 * against a 2,500-character limit is watching the wrong number. A school that
 * stated both gets both. A school that stated neither still gets words, because
 * a writer wants to know how long their draft is and that count is honest about
 * itself -- it is simply not being compared with anything.
 */
export function liveCounts(constraints: Constraints): readonly LiveCount[] {
  const counts: LiveCount[] = []
  if (constraints.words !== null) counts.push('words')
  if (constraints.characters !== null) counts.push('characters')
  if (counts.length === 0) counts.push('words')
  return counts
}

/**
 * Characters in the text, counted the way this requirement counts them.
 *
 * CODE POINTS, NOT UTF-16 UNITS. JavaScript's String.prototype.length counts
 * units, so an emoji or an astral character counts twice there and once in
 * Postgres char_length() and once in a human's idea of a character. Spreading
 * the string counts code points, which matches the database and the applicant.
 *
 * WHEN SPACES DO NOT COUNT, ALL WHITESPACE IS EXCLUDED -- newlines and tabs as
 * well as spaces. A school writing "excluding spaces" is describing the visible
 * characters of their text, and counting the newline between two paragraphs
 * while excluding the space between two words would be a rule nobody intends.
 * This is a stated interpretation, which is why the school's original wording is
 * kept beside it and shown to the applicant.
 *
 * AN UNSTATED spacesCount COUNTS SPACES. It is the larger, stricter count, so
 * an applicant guided by it cannot be caught out by the other reading -- and the
 * ambiguity is surfaced rather than hidden, see characterLimitAmbiguous().
 */
export function characterCount(text: string, spacesCount: boolean | null): number {
  if (typeof text !== 'string') return 0
  const counted = spacesCount === false ? text.replace(/\s+/g, '') : text
  return [...counted].length
}

/**
 * Whether this limit was given without saying whether spaces count.
 *
 * SURFACED, NOT RESOLVED. The applicant is told the school did not say, and is
 * shown the count that assumes spaces do, because that is the conservative one.
 */
export function characterLimitAmbiguous(constraints: Constraints): boolean {
  return constraints.characters !== null && constraints.characters.spacesCount === null
}

// ---------------------------------------------------------------------------
// Overages
// ---------------------------------------------------------------------------

export interface Overage {
  readonly kind: 'words' | 'characters'
  readonly count: number
  readonly max: number
  readonly over: number
}

/**
 * Which stated maxima this draft has passed.
 *
 * ONLY THE MEASURABLE ONES APPEAR. A draft cannot be "over" a page limit here,
 * because this system does not know how many pages it is; saying so would be
 * the invented conversion this module exists to prevent.
 *
 * REPORTED, NEVER ENFORCED, exactly as the single-prompt path already is: going
 * over is the applicant's business and the analysis still runs.
 */
export function overages(input: {
  readonly constraints: Constraints
  readonly words: number
  readonly text: string
}): readonly Overage[] {
  const found: Overage[] = []
  const wordMax = input.constraints.words?.max ?? null
  if (wordMax !== null && input.words > wordMax) {
    found.push({ kind: 'words', count: input.words, max: wordMax, over: input.words - wordMax })
  }
  const chars = input.constraints.characters
  if (chars !== null && chars.max !== null) {
    const count = characterCount(input.text, chars.spacesCount)
    if (count > chars.max) {
      found.push({ kind: 'characters', count, max: chars.max, over: count - chars.max })
    }
  }
  return found
}

/** Stated minima this draft has not yet reached. Informational only. */
export function shortfalls(input: {
  readonly constraints: Constraints
  readonly words: number
  readonly text: string
}): readonly Overage[] {
  const found: Overage[] = []
  const wordMin = input.constraints.words?.min ?? null
  if (wordMin !== null && input.words < wordMin) {
    found.push({ kind: 'words', count: input.words, max: wordMin, over: wordMin - input.words })
  }
  const chars = input.constraints.characters
  if (chars !== null && chars.min !== null) {
    const count = characterCount(input.text, chars.spacesCount)
    if (count < chars.min) {
      found.push({ kind: 'characters', count, max: chars.min, over: chars.min - count })
    }
  }
  return found
}
