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
 *
 * A NUMBER IS NOT A RULE UNTIL THE SCHOOL SAYS SO. This was the gap the
 * 83-programme verification exposed, and it is the reason `enforcement` exists
 * below. Four schools write "500" and mean four different things:
 *
 *   Maryland        "no more than 350 words"                      a hard cap
 *   Southern Miss.  "only the first two pages will be read"        a cap, enforced
 *   South Dakota    "A written 500 word statement"                 a length, uncapped
 *   UC Davis        "Suggested Length: Maximum of 250 words"       a suggestion
 *
 * Storing all four in one `max` field and warning identically on all four tells
 * a South Dakota applicant they have broken a limit that school never set. So
 * every limit carries the REGISTER it was published in, and the school's own
 * sentence beside it.
 */

/**
 * How binding a stated length is, in the school's own terms.
 *
 * FIVE VALUES, EACH FROM A VERIFIED EXAMPLE, ordered loosely from strictest to
 * least:
 *
 *   'truncated'  the school states that text past the limit is NOT READ. The
 *                strongest form there is, because exceeding it destroys part of
 *                the submission rather than merely annoying a reader.
 *                Southern Mississippi: "Only the first two pages will be read
 *                if your essay goes over the limit."
 *   'enforced'   an explicit maximum or minimum: "no more than", "or fewer",
 *                "maximum", "MINIMUM 5000 characters". Breaking it is breaking
 *                a rule.
 *   'target'     a length stated without being called a limit. "A written 500
 *                word statement" is an instruction about length that never says
 *                "maximum", and treating it as one invents a rule.
 *   'suggested'  explicitly advisory: "Suggested Length", "Recommend 2-4
 *                pages". Exceeding it breaks nothing.
 *   'unknown'    a number is published but its standing genuinely cannot be
 *                determined from the source. Recorded, not guessed.
 *
 * ONE REGISTER PER LIMIT, NOT PER BOUND, and that is a deliberate
 * simplification: across all 83 verified programmes not one states a minimum
 * and a maximum in different registers. Splitting it would double these fields
 * and the digest for a case that does not exist. If one ever appears, the
 * school's sentence in `statedAs` is where it will be visible.
 */
export type Enforcement = 'truncated' | 'enforced' | 'target' | 'suggested' | 'unknown'

/** Every register, for iteration and for validating stored values. */
export const ENFORCEMENTS: readonly Enforcement[] =
  ['truncated', 'enforced', 'target', 'suggested', 'unknown']

/**
 * What a limit with no recorded register means.
 *
 * 'enforced', BECAUSE THAT IS WHAT THIS PRODUCT HAS ALWAYS DONE WITH THOSE
 * NUMBERS. Every draft saved before this field existed has a word maximum in
 * statement_drafts.stated_max_words, and overLimit(), the editor's banner and
 * the analyser have all treated it as a hard cap since the feature shipped.
 * Defaulting an absent register to anything softer would silently withdraw a
 * warning from every existing draft, which is a regression dressed up as a
 * correction.
 *
 * IT IS ALSO THE SAFE DIRECTION TO BE WRONG IN. Reading a real maximum as a
 * suggestion could let an applicant submit an over-length essay believing it
 * was fine; reading a suggestion as a maximum only makes the product stricter
 * than the school. Only one of those costs somebody an application.
 */
export const DEFAULT_ENFORCEMENT: Enforcement = 'enforced'

/**
 * One stored register, validated.
 *
 * SHARED BY BOTH READERS ON PURPOSE. A snapshot is parsed by snapshot.ts and a
 * catalog row by repo.ts, and provenance compares the two as digests. If those
 * two parsers degraded an unrecognised value differently, every requirement
 * would fail authentication the moment a newer build wrote a register this one
 * does not know. One function, so they cannot diverge; a test asserts it.
 *
 * AN UNRECOGNISED VALUE BECOMES THE DEFAULT, which is the strict reading. A
 * future build inventing 'advisory-ish' must not have it read as weaker than a
 * maximum here.
 */
export function parseEnforcement(value: unknown): Enforcement {
  return (ENFORCEMENTS as readonly string[]).includes(value as string)
    ? (value as Enforcement)
    : DEFAULT_ENFORCEMENT
}

/**
 * Whether a limit in this register may be reported as broken.
 *
 * THE ONE PREDICATE THAT SEPARATES A VIOLATION FROM A NOTE. 'truncated' and
 * 'enforced' are rules; 'target', 'suggested' and 'unknown' are not, and a
 * draft past one of those has not broken anything. Everything that renders an
 * over-limit message, and the legacy word-maximum projection, asks here.
 */
export function isStrict(enforcement: Enforcement): boolean {
  return enforcement === 'enforced' || enforcement === 'truncated'
}

/** A limit expressed in words. Either bound may be unstated. */
export interface WordLimit {
  readonly min: number | null
  readonly max: number | null
  /** How binding these bounds are. See Enforcement. */
  readonly enforcement: Enforcement
  /**
   * The school's own sentence about this limit, verbatim, or null.
   *
   * CARRIED SO THE REGISTER IS NEVER THE ONLY EVIDENCE. "Suggested Length:
   * Maximum of 250 words" is a judgement call to classify and no judgement at
   * all to quote, so the quotation travels with the classification and is what
   * an applicant is shown when the two could be read differently.
   */
  readonly statedAs: string | null
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
  readonly enforcement: Enforcement
  readonly statedAs: string | null
}

/**
 * A limit expressed in pages.
 *
 * NOTHING DOWNSTREAM MAY TURN THIS INTO WORDS. It is carried so it can be shown
 * to the applicant in the school's own unit, and so the analyser can be told
 * plainly that this system has not measured it.
 *
 * ITS REGISTER STILL MATTERS EVEN THOUGH NOTHING MEASURES IT. "Recommend 2-4
 * pages" and "only the first two pages will be read" are both unmeasurable
 * here, and an applicant needs to know which one they are reading.
 */
export interface PageLimit {
  readonly min: number | null
  readonly max: number | null
  readonly spacing: Spacing | null
  readonly enforcement: Enforcement
  readonly statedAs: string | null
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
  /**
   * The families and sizes a school PERMITS, where it offered a choice.
   *
   * A REQUIREMENT AND A PERMISSION ARE DIFFERENT FACTS. "Times New Roman" is
   * one value the document must use; "Times Roman or Arial" is a set it may
   * choose from, and flattening the second into the first asserts something no
   * school said. Null whenever a single value was required or nothing was
   * stated -- the scalar above and the set here are never both populated.
   *
   * STORED IN THE SCHOOL'S OWN WORDING. The font registry resolves aliases when
   * it comes to render; what is recorded here is what was verified.
   */
  readonly fontFamilyOptions: readonly string[] | null
  readonly fontSizePtOptions: readonly number[] | null
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

/**
 * A length instruction in words, with whether those words are the school's.
 *
 * THE FLAG IS NOT A DETAIL. This field exists to be SHOWN to an applicant in
 * place of a bound, so how it is introduced is the whole of its meaning:
 *
 *   verbatim true    The school states: "Submit a 1-2 page essay using APA
 *                    formatting." -- a quotation, and a claim about what the
 *                    school wrote.
 *   verbatim false   Recorded requirement, not the school's exact wording:
 *                    one personal essay, 1-2 pages, APA formatting. -- a
 *                    faithful summary, and no claim to be a quotation.
 *
 * PUTTING A SUMMARY IN QUOTATION MARKS IS THE FAILURE THIS PREVENTS. A
 * paraphrase presented as the school's sentence is a misattribution the
 * applicant cannot detect and cannot check, and it is the specific mistake the
 * research record was built to make visible -- `verbatim` has been a separate
 * field from `status` on every verification since the feature shipped, because
 * "accurate" and "quoted" are different facts.
 *
 * ABSENT MEANS NOT VERBATIM, never the reverse. Both readers default a missing
 * flag to false, so a record written without one is shown as a summary. The
 * safe direction is to under-claim: a quotation shown as a summary loses a
 * little authority, and a summary shown as a quotation invents a sentence.
 */
export interface StatedLength {
  readonly text: string
  /** True only when `text` is the school's own words, unaltered. */
  readonly verbatim: boolean
}

export interface Constraints {
  /**
   * A named standard whose BODY LAYOUT applies to the whole document.
   *
   * SET OFFLINE, FROM VERIFIED WORDING, and null for almost every school. A
   * citation style that governs only references is NOT this -- it lives in
   * `citation`, and conflating the two would reformat an essay because a
   * school asked for AMA references.
   */
  readonly formatProfile: string | null
  readonly words: WordLimit | null
  readonly characters: CharacterLimit | null
  readonly pages: PageLimit | null
  readonly typography: Typography | null
  readonly citation: Citation | null
  /**
   * A length the school published that this product does NOT model as a bound.
   *
   * THE APPROVED ANSWER FOR AN UNCONFIRMED LIMIT. Nine verified programmes
   * publish a figure -- "Submit a 1-2 page essay using APA formatting",
   * "Autobiographical Essay of 500 to 1000 words", "A 2-3 page essay" -- with
   * no wording anywhere that says whether it is a maximum, a minimum or a
   * suggestion. The owner's decision is to show the applicant what the school
   * wrote and enforce nothing, so the SENTENCE is stored here and the typed
   * bounds beside it stay NULL.
   *
   * NULL BOUNDS ARE THE POINT, NOT A GAP. A number in `words.max` is a number
   * some future code path will compare a draft against; this field cannot be
   * compared with anything, because it is prose. measurableInEditor() is false
   * for it, overages() can never produce one, and legacyProjection() has
   * nothing to project.
   *
   * WHY NOT otherInstructions. That array is the holding pen for instructions
   * with no structured home -- "business letter format", "excluding cover and
   * references" -- and nothing downstream knows what any element of it means.
   * The interface has to say "this is a LENGTH and we are not enforcing it",
   * and the analyser has to be told not to penalise exceeding it; neither is
   * possible for an anonymous string in a list.
   */
  readonly unenforcedLength: StatedLength | null
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

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
/**
 * The three limit builders, which exist so a register can never be forgotten.
 *
 * WRITING `{ min: null, max: 500 }` NO LONGER COMPILES, and that is the point:
 * TypeScript now demands an answer to "in what register did the school publish
 * this?" at every call site. The builders make the common answer short without
 * making the question optional, and `statedAs` defaults to null rather than to
 * an invented sentence.
 */
export function wordLimit(input: {
  readonly min?: number | null
  readonly max?: number | null
  readonly enforcement: Enforcement
  readonly statedAs?: string | null
}): WordLimit {
  return {
    min: input.min ?? null,
    max: input.max ?? null,
    enforcement: input.enforcement,
    statedAs: input.statedAs ?? null,
  }
}

export function characterLimit(input: {
  readonly min?: number | null
  readonly max?: number | null
  readonly spacesCount: boolean | null
  readonly enforcement: Enforcement
  readonly statedAs?: string | null
}): CharacterLimit {
  return {
    min: input.min ?? null,
    max: input.max ?? null,
    spacesCount: input.spacesCount,
    enforcement: input.enforcement,
    statedAs: input.statedAs ?? null,
  }
}

export function pageLimit(input: {
  readonly min?: number | null
  readonly max?: number | null
  readonly spacing: Spacing | null
  readonly enforcement: Enforcement
  readonly statedAs?: string | null
}): PageLimit {
  return {
    min: input.min ?? null,
    max: input.max ?? null,
    spacing: input.spacing,
    enforcement: input.enforcement,
    statedAs: input.statedAs ?? null,
  }
}

/**
 * A length to show and not enforce.
 *
 * `verbatim` HAS NO DEFAULT HERE EITHER. Every call site states whether it is
 * quoting the school, because that is the one thing about this field that
 * cannot be inferred later.
 */
export function statedLength(input: {
  readonly text: string
  readonly verbatim: boolean
}): StatedLength {
  return { text: input.text, verbatim: input.verbatim }
}

/** A document whose shape the school said nothing about. */
export const NO_CONSTRAINTS: Constraints = {
  formatProfile: null,
  words: null,
  characters: null,
  pages: null,
  typography: null,
  citation: null,
  unenforcedLength: null,
  otherInstructions: [],
}

// ---------------------------------------------------------------------------
// What the editor can and cannot measure
// ---------------------------------------------------------------------------

/** The kinds of requirement a constraint set can carry. */
export type ConstraintKind =
  | 'words' | 'characters' | 'pages' | 'spacing' | 'font' | 'margins' | 'citation'
  /** A length the school stated that this product deliberately does not bound. */
  | 'unenforced-length'
  | 'other'

/*
 * measurableInEditor AND UNMEASURED_NOTICE WERE HERE, AND ARE GONE.
 *
 * Both encoded the same assumption: that this product could see words and
 * characters and nothing else, so every school was told its page count,
 * spacing, font and margins could not be checked. That was true of a textarea.
 * It is not true of a page the Studio lays out and measures, and a product that
 * understates what it knows sends applicants to do work it already did.
 *
 * What a field is worth now is resolved per field, from the canonical record,
 * in lib/statement/layout/capabilities.ts -- measured, applied, or left to a
 * human and named individually.
 */

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
  // AFTER THE STRUCTURED UNITS AND BEFORE THE FREE TEXT. It is a length, so it
  // belongs with the lengths; it is prose, so it cannot lead them.
  if (constraints.unenforcedLength !== null) kinds.push('unenforced-length')
  if (constraints.otherInstructions.length > 0) kinds.push('other')
  return kinds
}

/**
 * The kinds the ANALYSER is told not to judge.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY FROZEN, AND DELIBERATELY NOT THE CAPABILITY MODEL
 * ---------------------------------------------------------------------------
 * This still reads "words and characters, and nothing else", which is no longer
 * what the editor can see. It is kept that way on purpose: it feeds the review
 * prompt, so widening it would change what the analyser is asked to score and
 * would need a RUBRIC_VERSION decision that is not this change's to make.
 *
 * NAMED FOR ITS CALLER so nobody mistakes it for the capability model. When the
 * rubric is revisited, this should become a read of the resolver and the prompt
 * should stop telling the model that page count cannot be observed.
 */
export function analyzerUnmeasuredKinds(constraints: Constraints): readonly ConstraintKind[] {
  const scored = (kind: ConstraintKind) => kind === 'words' || kind === 'characters'
  return constraintKinds(constraints).filter((kind) => !scored(kind))
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
  /**
   * The register the passed bound was published in.
   *
   * CARRIED RATHER THAN FILTERED ON. An applicant 40 words past a suggested
   * length wants to know that; what must differ is what they are TOLD, not
   * whether they are told. So every exceedance is reported and the register
   * decides the wording -- see constraintText.ts's overageMessage().
   */
  readonly enforcement: Enforcement
  /** The school's own sentence, when the register was published with one. */
  readonly statedAs: string | null
}

/**
 * Which stated maxima this draft has passed, in any register.
 *
 * ONLY THE MEASURABLE ONES APPEAR. A draft cannot be "over" a page limit here,
 * because this system does not know how many pages it is; saying so would be
 * the invented conversion this module exists to prevent. That is true of a
 * truncation policy too: "only the first two pages will be read" is reported to
 * the applicant as the school's own warning and is never evaluated.
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
  const words = input.constraints.words
  if (words !== null && words.max !== null && input.words > words.max) {
    found.push({
      kind: 'words',
      count: input.words,
      max: words.max,
      over: input.words - words.max,
      enforcement: words.enforcement,
      statedAs: words.statedAs,
    })
  }
  const chars = input.constraints.characters
  if (chars !== null && chars.max !== null) {
    const count = characterCount(input.text, chars.spacesCount)
    if (count > chars.max) {
      found.push({
        kind: 'characters',
        count,
        max: chars.max,
        over: count - chars.max,
        enforcement: chars.enforcement,
        statedAs: chars.statedAs,
      })
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
  const words = input.constraints.words
  if (words !== null && words.min !== null && input.words < words.min) {
    found.push({
      kind: 'words',
      count: input.words,
      max: words.min,
      over: words.min - input.words,
      enforcement: words.enforcement,
      statedAs: words.statedAs,
    })
  }
  const chars = input.constraints.characters
  if (chars !== null && chars.min !== null) {
    const count = characterCount(input.text, chars.spacesCount)
    if (count < chars.min) {
      found.push({
        kind: 'characters',
        count,
        max: chars.min,
        over: chars.min - count,
        enforcement: chars.enforcement,
        statedAs: chars.statedAs,
      })
    }
  }
  return found
}

/** Exceedances of a bound the school actually made a rule. */
export function strictOverages(input: {
  readonly constraints: Constraints
  readonly words: number
  readonly text: string
}): readonly Overage[] {
  return overages(input).filter((item) => isStrict(item.enforcement))
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Which units the school said it would stop reading at, if any.
 *
 * A SEPARATE QUESTION FROM "IS THIS DRAFT TOO LONG", and it has to be, because
 * the truncated limit is usually a PAGE limit -- Southern Mississippi's two
 * pages -- which this system cannot measure at all. So the warning is about the
 * school's POLICY, shown whenever such a limit exists, rather than about a
 * measurement nobody here can take.
 */
export function truncatedKinds(constraints: Constraints): readonly ConstraintKind[] {
  const kinds: ConstraintKind[] = []
  if (constraints.words?.enforcement === 'truncated') kinds.push('words')
  if (constraints.characters?.enforcement === 'truncated') kinds.push('characters')
  if (constraints.pages?.enforcement === 'truncated') kinds.push('pages')
  return kinds
}

/**
 * Whether any length bound was normalised out of this school's wording.
 *
 * ---------------------------------------------------------------------------
 * THE TEST FOR "IS THIS REQUIREMENT ENFORCED AT ALL"
 * ---------------------------------------------------------------------------
 * A document can carry both a bound and the prose the bound came from. Once a
 * figure has been normalised into `words`, `characters` or `pages`, the editor
 * counts against it -- so nothing anywhere may describe that same requirement
 * as unenforced. Several surfaces need that answer, which is why the test
 * lives beside the data rather than next to any one of them.
 *
 * MIN OR MAX IS ENOUGH. A minimum alone is still a bound the editor checks.
 */
export function hasStructuredLengthBound(constraints: Constraints): boolean {
  const bounded = (b: { min: number | null; max: number | null } | null): boolean =>
    b !== null && (b.min !== null || b.max !== null)
  return bounded(constraints.words)
    || bounded(constraints.characters)
    || bounded(constraints.pages)
}

/** Whether this school stated that it stops reading at the limit. */
export function hasTruncationPolicy(constraints: Constraints): boolean {
  return truncatedKinds(constraints).length > 0
}

/**
 * Whether any stated length is something softer than a rule.
 *
 * DRIVES THE SENTENCE THAT STOPS A SUGGESTION READING AS A CAP, both on screen
 * and in the analyser's prompt.
 */
export function hasAdvisoryLength(constraints: Constraints): boolean {
  // AN UNENFORCED LENGTH IS THE PUREST CASE OF THIS: a figure the school
  // published that this product refuses to treat as a bound at all.
  if (constraints.unenforcedLength !== null) return true
  const registers = [
    constraints.words?.enforcement,
    constraints.characters?.enforcement,
    constraints.pages?.enforcement,
  ]
  return registers.some((register) => register !== undefined && !isStrict(register))
}
