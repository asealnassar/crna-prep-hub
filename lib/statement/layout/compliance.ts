/**
 * What the school requires, and whether this draft meets it.
 *
 * ---------------------------------------------------------------------------
 * THE BLANKET DISCLAIMER IS GONE, AND THAT IS THE CHANGE
 * ---------------------------------------------------------------------------
 * The editor used to say "this editor counts words and characters only; it
 * cannot check page count, spacing, font, margins or citation format". That was
 * true of a textarea and it is not true of a page. Once the Studio controls the
 * geometry it lays text out in, the page count and the spacing are facts it
 * knows exactly -- better than it knows a word count, which depends on what
 * anybody calls a word.
 *
 * SO THE NOTICE BECOMES PER-REQUIREMENT. Each row is either checked, breached,
 * or named as something we genuinely cannot observe -- a citation style, a
 * school's own font, a free-text instruction. A reviewer reading "we cannot
 * check formatting" when we just measured it would stop believing the parts
 * that are true.
 *
 * ---------------------------------------------------------------------------
 * EVERY UNIT IS EVALUATED FROM ITS OWN MEASUREMENT
 * ---------------------------------------------------------------------------
 * Words from words, characters from characters, pages from rendered geometry.
 * Nothing is derived from anything else: a school that states 500 words and
 * 2 pages gets two independent verdicts, and a school that states only pages
 * never sees a word count presented as its limit.
 *
 * PURE. Takes measurements as data, returns rows. No DOM, no React.
 */
import { contentBox, roundPages } from './geometry.ts'
import type { AppliedLayout, RequirementCapabilities } from './capabilities.ts'

/** What the editor measured. Supplied by the caller; never estimated here. */
export interface Measurements {
  readonly words: number
  readonly characters: number
  /** Rendered text height in points, or null before the first layout pass. */
  readonly contentHeightPt: number | null
  /**
   * Pages occupied, counted from the pages as they actually broke.
   *
   * null ON A SURFACE THAT DOES NOT PAGINATE, where the ratio of the text's
   * height to a page's is the best available answer. The paginated editor
   * supplies the measured figure instead, because a page holds whole lines:
   * 864px of box holds 23 x 37px of text and the remaining 13px holds nothing,
   * so dividing the total height by the page height drifts a little further out
   * of step with the drawn page on every break. The panel has to cross the
   * limit on the same keystroke the text crosses the line.
   */
  readonly pagesUsed: number | null
}

export type ComplianceStatus =
  /** Measured, and within what the school asked for. */
  | 'met'
  /** Measured, and past it. Never blocks typing. */
  | 'breached'
  /** Required, satisfied by construction because the Studio renders it. */
  | 'applied'
  /**
   * Required, and rendered with something close enough that the LAYOUT holds
   * but the requirement itself is not met. Never shown as a pass.
   */
  | 'substituted'
  /** Stated by the school and not something this product can observe. */
  | 'unverifiable'
  /** Measurable, but nothing has been measured yet. */
  | 'pending'

export interface ComplianceRow {
  readonly id: string
  readonly label: string
  /** The live figure, when there is one: "1.21 / 1.50 pages". */
  readonly detail: string | null
  readonly status: ComplianceStatus
}

const n = (value: number) => value.toLocaleString('en-US')
/** Two decimals always, so 1.5 reads as 1.50 beside 1.21. */
const p = (value: number) => roundPages(value).toFixed(2)

/**
 * The rows for one requirement, in the order a reader needs them.
 *
 * PAGES FIRST WHEN A SCHOOL STATES PAGES, because it is the binding limit and
 * the one the applicant is watching. Words and characters lead when they are
 * what was stated.
 */
export function complianceRows(input: {
  readonly capabilities: RequirementCapabilities
  readonly measurements: Measurements
}): readonly ComplianceRow[] {
  const { capabilities, measurements } = input
  const rows: ComplianceRow[] = []
  /*
    NORMALISED ONCE, HERE.

    `??` and not a direct read: an absent field is undefined, not null, and
    `undefined > 1.5` is false -- so an over-limit essay would have read as
    within the maximum. The type says the field is required and the compiler
    does not check the tests, which is exactly the gap that let that through.
  */
  const measuredPages = measurements.pagesUsed ?? null

  // ---- pages -------------------------------------------------------------
  //
  // MEASURED, so the figure can come out either way. The height is still read
  // for the fallback when a surface reported one without counting pages.
  const pages = capabilities.pages
  const height = measurements.contentHeightPt
  const pageHeightPt = contentBox(capabilities.geometry).heightPt
  const usedPages = measuredPages
    ?? (height === null || pageHeightPt <= 0 ? null : height / pageHeightPt)

  if (pages?.max != null) {
    if (usedPages === null) {
      rows.push({
        id: 'pages',
        label: `Within ${p(pages.max)}-page maximum`,
        detail: null,
        status: 'pending',
      })
    } else {
      const over = usedPages > pages.max + 1e-9
      rows.push({
        id: 'pages',
        label: over
          ? `Over the ${p(pages.max)}-page maximum`
          : `Within ${p(pages.max)}-page maximum`,
        detail: `${p(usedPages)} / ${p(pages.max)} pages`,
        status: over ? 'breached' : 'met',
      })
    }
  }
  if (pages?.min != null) {
    if (usedPages === null) {
      rows.push({
        id: 'pages-min',
        label: `At least ${p(pages.min)} pages`,
        detail: null,
        status: 'pending',
      })
    } else {
      rows.push({
        id: 'pages-min',
        label: `At least ${p(pages.min)} pages`,
        detail: `${p(usedPages)} / ${p(pages.min)} pages`,
        status: usedPages + 1e-9 >= pages.min ? 'met' : 'breached',
      })
    }
  }

  // ---- what the school required and the Studio applies -------------------
  //
  // 'applied', NOT 'met'. The Studio renders these and offers no way to turn
  // them off, so they are not measurements that could come out either way --
  // they are statements about how the page is laid out. Calling one a passed
  // check would imply we had tested something.
  //
  // SCHOOL-STATED ONLY. What the Studio chose for itself is disclosed as a
  // default elsewhere; listing it here would read as a requirement the school
  // never made.
  for (const layout of capabilities.applied) {
    // SCHOOL-CHOICE COUNTS: the school published the list, so it belongs beside
    // what it required. What the Studio picked from it is said separately.
    if (layout.source !== 'school' && layout.source !== 'school-choice') continue
    /*
      THE FONT GETS AT MOST ONE ROW, AND NOT THIS ONE UNLESS WE RENDER IT.

      A family we only approximate is emitted below as `substituted`, and one we
      do not recognise becomes a manual line. Without this, both ran: two rows
      shared the id 'font-family', the first said `applied`, and a reader -- or
      a React key -- saw the substitution as a pass.
    */
    if (layout.field === 'font-family' && capabilities.font.support !== 'exact') continue
    rows.push({
      id: layout.field,
      label: layout.label,
      detail: null,
      status: 'applied',
    })
  }

  // ---- the font, when the school named one ------------------------------
  //
  // NOT A TICK AND NOT A WARNING. A substitution means the page breaks where it
  // would break in the requested font, so the page figure above is trustworthy
  // -- and the font itself is still not the one the school asked for. Both
  // halves of that are true, so both are said.
  const font = capabilities.font
  if (font.requested !== null && font.support === 'substituted') {
    rows.push({
      id: 'font-family',
      // THE SCHOOL'S WORDING ALONE. The sentence explaining what the Studio
      // renders instead is carried in `rendering` and shown under its own
      // heading, so this row cannot be read as "Tinos satisfies this".
      label: font.requested,
      detail: null,
      status: 'substituted',
    })
  }

  // ---- words -------------------------------------------------------------
  const words = capabilities.words
  if (words?.max != null) {
    rows.push({
      id: 'words',
      label: measurements.words > words.max
        ? `Over the ${n(words.max)}-word maximum`
        : `Within ${n(words.max)}-word maximum`,
      detail: `${n(measurements.words)} / ${n(words.max)} words`,
      status: measurements.words > words.max ? 'breached' : 'met',
    })
  }
  if (words?.min != null) {
    rows.push({
      id: 'words-min',
      label: `At least ${n(words.min)} words`,
      detail: `${n(measurements.words)} / ${n(words.min)} words`,
      status: measurements.words >= words.min ? 'met' : 'breached',
    })
  }

  // ---- characters --------------------------------------------------------
  const characters = capabilities.characters
  if (characters?.max != null) {
    rows.push({
      id: 'characters',
      label: measurements.characters > characters.max
        ? `Over the ${n(characters.max)}-character maximum`
        : `Within ${n(characters.max)}-character maximum`,
      detail: `${n(measurements.characters)} / ${n(characters.max)} characters`,
      status: measurements.characters > characters.max ? 'breached' : 'met',
    })
  }
  if (characters?.min != null) {
    rows.push({
      id: 'characters-min',
      label: `At least ${n(characters.min)} characters`,
      detail: `${n(measurements.characters)} / ${n(characters.min)} characters`,
      status: measurements.characters >= characters.min ? 'met' : 'breached',
    })
  }

  // ---- what still needs a human -----------------------------------------
  //
  // NAMED INDIVIDUALLY, with the school's own words and what to do about it.
  // This is the whole of what the blanket notice became, and for a school that
  // stated only a page limit and a spacing the list is empty -- which is the
  // case the old sentence got wrong.
  for (const item of capabilities.manualReview) {
    rows.push({
      id: item.id,
      label: `${item.label} — ${item.reason}`,
      detail: null,
      status: 'unverifiable',
    })
  }

  return rows
}


/**
 * The layout lines for one half of the panel.
 *
 * ---------------------------------------------------------------------------
 * ONE LIST, SPLIT BY PROVENANCE
 * ---------------------------------------------------------------------------
 * There used to be two functions here, one walking the geometry for defaults
 * and one walking it again for school values. They were the same walk with the
 * comparison flipped, which meant a property could be described as a default in
 * one and a requirement in the other if either drifted. The resolver already
 * tags every applied value with where it came from, so this is a filter.
 */
export function appliedLines(
  capabilities: RequirementCapabilities,
  source: AppliedLayout['source'],
): readonly string[] {
  return capabilities.applied
    .filter((layout) => layout.source === source)
    .map((layout) => layout.label)
}

/** Said beneath the live figure, so the number is never read as the school's. */
export const MEASUREMENT_BASIS =
  'Page measurement uses the school requirements plus the Studio defaults shown above.'
