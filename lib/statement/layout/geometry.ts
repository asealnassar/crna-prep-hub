/**
 * The page the Studio writes on, and where each of its properties came from.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE IS THE POINT OF THIS MODULE
 * ---------------------------------------------------------------------------
 * Boston College requires a maximum of 1.5 pages, double-spaced. It says
 * nothing about paper size, font, font size or margins -- and a page count
 * depends on all four. So the Studio must supply them, and must never let the
 * resulting number read as something Boston specified.
 *
 * Every field below therefore carries its own source alongside its value. The
 * requirements panel is generated from that, which is what stops the two
 * drifting: there is no second list of "things Boston said" to keep in step.
 *
 * ---------------------------------------------------------------------------
 * PURE
 * ---------------------------------------------------------------------------
 * No DOM, no React, no measurement. This decides what the page IS; the editor
 * measures how much of it is used. Keeping them apart is what lets the same
 * specification drive the writing surface, the live page count and -- later --
 * the PDF, from one definition rather than three.
 */
import type { Constraints, Spacing } from '../requirements/constraints.ts'
import { formatProfileFor, type FormatProfile } from './formatProfile.ts'
import { TINOS, lineHeightPt, type FontMetrics } from './fontMetrics.ts'
import { STUDIO_STACK } from './fonts.ts'

/** Where a layout property came from. Never inferred, always carried. */
/**
 * Where a laid-out value came from.
 *
 * 'school-choice' IS NOT 'school'. A school that REQUIRES 12 pt and one that
 * PERMITS 11 or 12 have said different things, and a panel that reported both
 * as "required by the school" would be putting words in one of their mouths.
 * It is also not a default: the Studio did not pick it freely, it picked from
 * a list the school published.
 */
export type LayoutSource =
  | 'school'
  | 'school-choice'
  /**
   * From a named standard the school applied to the document.
   *
   * ITS OWN SOURCE, BETWEEN THE OTHER TWO. A school that says "APA format"
   * did choose this -- so it is not a Studio default -- but it did not name
   * the inch or the point, so reporting it as an explicit school field would
   * put a number in their mouth. The panel names the standard instead.
   */
  | 'format-profile'
  /**
   * The applicant chose it, from the options their record allows.
   *
   * ITS OWN SOURCE, BECAUSE IT IS ITS OWN KIND OF FACT. A font the applicant
   * picked is not a Studio default -- somebody decided it -- and it is not a
   * school field either; reporting it as 'school' would claim the school asked
   * for a face it never named. The options they picked from were derived from
   * the school's record, which is where the constraint lives.
   */
  | 'applicant'
  | 'studio-default'

export interface Sourced<T> {
  readonly value: T
  readonly source: LayoutSource
}

const school = <T>(value: T): Sourced<T> => ({ value, source: 'school' })
const chosen = <T>(value: T): Sourced<T> => ({ value, source: 'school-choice' })
const profiled = <T>(value: T): Sourced<T> => ({ value, source: 'format-profile' })
const studio = <T>(value: T): Sourced<T> => ({ value, source: 'studio-default' })
/** The applicant's own pick, distinct from the SCHOOL's list of permitted ones. */
const picked = <T>(value: T): Sourced<T> => ({ value, source: 'applicant' })

/**
 * The Studio's own defaults.
 *
 * CONVENTIONAL ON PURPOSE. US Letter with one-inch margins at 12 pt is what a
 * graduate programme expects and what every word processor opens with; the
 * value of a default here is that it surprises nobody and reproduces exactly,
 * not that it looks distinctive.
 *
 * NOT CONFIGURABLE IN THIS BUILD. Predictable pagination is worth more right
 * now than letting an applicant restyle an essay whose school gave no styling
 * instruction -- and every control added here is another way for two people to
 * measure the same essay differently.
 */
export const STUDIO_DEFAULTS = {
  paperWidthIn: 8.5,
  paperHeightIn: 11,
  marginsIn: 1,
  fontSizePt: 12,
  /**
   * Tinos: Times New Roman-compatible metrics, SIL OFL 1.1, self-hosted.
   *
   * NOT A SYSTEM FONT, deliberately. Pagination must not depend on what happens
   * to be installed on the reader's machine, so the face is bundled and
   * embedded -- the same files the PDF path inlines.
   */
  metrics: TINOS,
  /** What an unspecified spacing renders as. A school that states one wins. */
  spacing: 'single' as Spacing,
} as const

/**
 * Everything about a paragraph that can move a page boundary.
 *
 * ---------------------------------------------------------------------------
 * PINNED, BECAUSE EACH OF THESE SILENTLY CHANGES THE PAGE COUNT
 * ---------------------------------------------------------------------------
 * A default margin between paragraphs is the clearest example: browsers apply
 * roughly one blank line between <p> elements, so a six-paragraph essay would
 * gain six lines nobody typed -- about a third of a double-spaced page. The
 * others are subtler and just as real: justification changes where words break,
 * hyphenation changes how many fit, letter-spacing changes line length.
 *
 * So every one is stated rather than inherited. They are Studio defaults, and a
 * school that states one overrides it like any other -- no school in the
 * imported catalog states any of them.
 *
 * ---------------------------------------------------------------------------
 * WHAT ENTER DOES
 * ---------------------------------------------------------------------------
 * The schema is doc > paragraph > text, so Enter ends one paragraph and starts
 * the next. With zero spacing before and after, a new paragraph begins on the
 * very next line box -- exactly as a single Enter does in a word processor set
 * to no paragraph spacing.
 *
 * A BLANK LINE COSTS EXACTLY ONE LINE BOX. Pressing Enter twice leaves an empty
 * paragraph between two full ones; `min-height` gives it the same line box a
 * line of text would have, so it consumes one line of the page and no more.
 * That is the predictable behaviour: what the applicant sees as one blank line
 * costs one line of their allowance.
 */
export const STUDIO_PARAGRAPH = {
  /** Points of space above a paragraph. Zero: Enter starts the next line. */
  spaceBeforePt: 0,
  /** Points of space below a paragraph. Zero, for the same reason. */
  spaceAfterPt: 0,
  /**
   * Left aligned, never justified.
   *
   * JUSTIFICATION WOULD MAKE THE PAGE COUNT HARDER TO REPRODUCE. It changes
   * inter-word spacing per line, and the algorithm is not identical across
   * engines -- so the same essay could wrap differently in Safari and Chrome.
   */
  textAlign: 'left',
  /** Normal: any tracking changes line length and therefore the wrap. */
  letterSpacing: 'normal',
  /**
   * Hyphenation off.
   *
   * ON, IT WOULD BE DICTIONARY-DEPENDENT: the hyphenation pattern set ships
   * with the browser and differs by engine and by language build, so the same
   * essay would break into different numbers of lines on different machines.
   * Word's default for a new document is also off.
   */
  hyphens: 'none',
} as const

/** The resolved page, with every property's origin attached. */
export interface PageGeometry {
  readonly paperWidthIn: Sourced<number>
  readonly paperHeightIn: Sourced<number>
  readonly marginsIn: Sourced<number>
  /** The family's NAME, as a panel would print it. Never a CSS value. */
  readonly fontFamily: Sourced<string>
  /**
   * The CSS font-family stack the page is drawn with.
   *
   * A SEPARATE FIELD FROM THE NAME, because they are different things and
   * conflating them is how a panel ends up printing `'Tinos', 'Times New
   * Roman', Times, serif` at an applicant. The fallbacks in here exist only
   * for the instant before the bundled face loads; measurement waits for
   * document.fonts.ready, so they never reach a reported page count.
   */
  readonly fontStack: string
  readonly fontSizePt: Sourced<number>
  readonly spacing: Sourced<Spacing>
  /** The absolute line box, in points. Derived from the three above. */
  readonly lineHeightPt: number
  /**
   * The first line of each paragraph, in inches.
   *
   * ZERO UNLESS A PROFILE ASKS FOR ONE. The Studio's own default is no
   * indent; APA requires 0.5in, and it is a layout rule the editor can apply
   * exactly -- unlike a title page, which is content.
   */
  readonly firstLineIndentIn: Sourced<number>
  /** The profile in force, for disclosure. Null when none applies. */
  readonly formatProfile: FormatProfile | null
  /** The font the measurement assumes. Not currently school-selectable. */
  readonly metrics: FontMetrics
}

/**
 * Resolve the page for a school's requirement.
 *
 * A SCHOOL VALUE REPLACES THE DEFAULT AND IS MARKED 'school'; an absent one
 * keeps the default and is marked 'studio-default'. There is no third state and
 * nothing is merged part-way: a school that states a font size gets its font
 * size, and still gets our margins unless it stated those too.
 *
 * `null` CONSTRAINTS ARE A SCHOOL WITH NO REQUIREMENT, which is every general
 * draft and every school whose catalog entry carries no formatting. It resolves
 * to the Studio defaults throughout, all marked as such.
 *
 * THE FONT FAMILY IS NOT TAKEN FROM THE SCHOOL YET, even though the catalog can
 * carry one. Rendering an arbitrary family would need that family's metrics and
 * its file, and we ship one embedded face; a school-stated family is surfaced
 * to the applicant as an instruction rather than silently ignored. See
 * unsupportedTypography().
 */
export function resolveGeometry(
  constraints: Constraints | null,
  /**
   * The face the document is laid out in, when one has been settled on.
   *
   * ---------------------------------------------------------------------------
   * WHY THE FONT IS A PARAMETER AND NOT A CONSTRAINT
   * ---------------------------------------------------------------------------
   * Every other value here is read from the school's record. The font is not:
   * it is settled by documentFontChoice(), which reads the record AND the
   * applicant's stored preference, and which can only ever return a face this
   * product bundles. Passing the answer in keeps this function what it is -- a
   * pure resolver over a requirement -- and keeps the registry of bundled faces
   * out of it entirely.
   *
   * OMITTED MEANS THE STUDIO DEFAULT, which is what every caller did before
   * fonts were selectable and is what the measurement has always assumed.
   *
   * `sizePt` IS NON-NULL ONLY WHERE THE SOURCE PAIRS THEM. APA permits
   * 11-point Arial, not Arial -- so choosing that face carries its size, and
   * the pair beats the profile's own default size without touching anything
   * the school stated itself.
   */
  chosenFont?: {
    readonly metrics: FontMetrics
    readonly cssFamily: string
    readonly sizePt: number | null
  } | null,
): PageGeometry {
  const typography = constraints?.typography ?? null
  const pages = constraints?.pages ?? null

  /*
    PRECEDENCE, IN ONE PLACE: an explicit school field, then the format
    profile, then the Studio default.

    A school that states 1.25-inch margins AND says "APA format" gets 1.25:
    they named a number, and a standard they invoked does not overrule a
    requirement they wrote down. The profile only fills what was left unsaid.
  */
  const profile = formatProfileFor(constraints?.formatProfile)

  const fontSizePt = typeof typography?.fontSizePt === 'number' && typography.fontSizePt > 0
    ? school(typography.fontSizePt)
    : typography?.fontSizePtOptions != null
      ? permittedSize(typography.fontSizePtOptions)
      // A SIZE THAT CAME WITH THE CHOSEN FACE beats the profile's own default,
      // because the standard permits the PAIR and the applicant picked one
      // half of it. It never beats a size the school wrote down.
      : chosenFont != null && chosenFont.sizePt !== null
        ? picked(chosenFont.sizePt)
        : profile !== null
          ? profiled(profile.fontSizePt)
          : studio(STUDIO_DEFAULTS.fontSizePt)

  const marginsIn = typeof typography?.marginsInches === 'number' && typography.marginsInches >= 0
    ? school(typography.marginsInches)
    : profile !== null
      ? profiled(profile.marginsIn)
      : studio(STUDIO_DEFAULTS.marginsIn)

  const metrics = chosenFont?.metrics ?? STUDIO_DEFAULTS.metrics

  const spacing = pages?.spacing != null
    ? school(pages.spacing)
    : profile !== null
      ? profiled(profile.spacing)
      : studio(STUDIO_DEFAULTS.spacing)

  return {
    // NO SCHOOL IN THE CATALOG STATES A PAPER SIZE, and the schema has no column
    // for one, so this is always ours. Marked honestly rather than assumed.
    paperWidthIn: studio(STUDIO_DEFAULTS.paperWidthIn),
    paperHeightIn: studio(STUDIO_DEFAULTS.paperHeightIn),
    marginsIn,
    fontFamily: chosenFont == null
      ? studio(STUDIO_DEFAULTS.metrics.family)
      : picked(chosenFont.metrics.family),
    fontStack: chosenFont?.cssFamily ?? STUDIO_STACK,
    fontSizePt,
    spacing,
    // THE LINE BOX IS THE CHOSEN FACE'S. Two faces with the same vertical
    // metrics give the same box and still wrap differently, which is why the
    // page count is re-measured from the browser rather than scaled from here.
    lineHeightPt: lineHeightPt(metrics, fontSizePt.value, spacing.value),
    firstLineIndentIn: profile === null
      ? studio(0)
      : profiled(profile.firstLineIndentIn),
    formatProfile: profile,
    metrics,
  }
}

/**
 * The size to lay out in, when the school permitted several.
 *
 * ---------------------------------------------------------------------------
 * THE STUDIO DEFAULT WINS WHEN THE SCHOOL PERMITS IT
 * ---------------------------------------------------------------------------
 * 12 pt is the size this product calibrated its line box and page counts
 * against, so choosing it where a school allows it keeps every measurement on
 * ground that has been tested -- and it is, by the school's own statement, a
 * compliant choice.
 *
 * NOT "THE LARGEST BECAUSE IT IS STRICTER". That reasoning is false: larger
 * type fills more pages, which is stricter against a maximum and LOOSER against
 * a minimum, and a school may state either. There is no size that is
 * conservative for both, so the tie-break is deterministic rather than
 * pretending to be safe: the permitted size nearest our default, and the
 * smaller one when two are equally near.
 *
 * WHICHEVER IS PICKED IS DISCLOSED, as 'school-choice' -- never as a
 * requirement the school made.
 */
function permittedSize(options: readonly number[] | null): Sourced<number> {
  if (options === null || options.length === 0) return studio(STUDIO_DEFAULTS.fontSizePt)
  const target = STUDIO_DEFAULTS.fontSizePt
  if (options.includes(target)) return chosen(target)
  const best = [...options].sort((a, b) =>
    Math.abs(a - target) - Math.abs(b - target) || a - b)[0]!
  return chosen(best)
}

/**
 * A typography instruction the Studio cannot apply.
 *
 * SAID RATHER THAN DROPPED. A school that requires Times New Roman has stated a
 * requirement; we render in the one face we embed, so the applicant has to know
 * that their final document needs the change. Returning it here keeps that out
 * of the compliance ticks -- it is an instruction, not something we verified.
 */
export function unsupportedTypography(constraints: Constraints | null): readonly string[] {
  const family = constraints?.typography?.fontFamily
  if (typeof family !== 'string' || family.trim().length === 0) return []
  return [family.trim()]
}

/** The content box, in points: the paper minus its margins. */
export interface ContentBox {
  readonly widthPt: number
  readonly heightPt: number
}

const PT_PER_IN = 72

export function contentBox(geometry: PageGeometry): ContentBox {
  return {
    widthPt: (geometry.paperWidthIn.value - geometry.marginsIn.value * 2) * PT_PER_IN,
    heightPt: (geometry.paperHeightIn.value - geometry.marginsIn.value * 2) * PT_PER_IN,
  }
}

/**
 * How many lines fit on one page.
 *
 * FLOORED, because a line that does not fit entirely is on the next page. The
 * fractional remainder is not usable space; reporting it as such would let a
 * draft read as 1.49 pages while printing on two.
 */
export function linesPerPage(geometry: PageGeometry): number {
  return Math.floor(contentBox(geometry).heightPt / geometry.lineHeightPt)
}

/**
 * Pages used, from a rendered content height.
 *
 * THE ONLY INPUT IS A MEASURED HEIGHT. There is no words-per-page constant in
 * this module or anywhere else in the Studio, and a test asserts that: a page
 * estimated from a word count is exactly the claim this product refuses to
 * make.
 *
 * NOT ROUNDED UP. "1.21 of 1.50 pages" is a position within the allowance, not
 * a sheet count -- an applicant needs to see how much room is left, and ceil()
 * would read 1.01 and 1.99 as the same thing.
 */
export function pagesUsed(contentHeightPt: number, geometry: PageGeometry): number {
  const page = contentBox(geometry).heightPt
  if (page <= 0) return 0
  return Math.max(0, contentHeightPt) / page
}

/**
 * Where the allowance ends, as a height in points from the top of the text.
 *
 * FRACTIONS ARE REAL. 1.5 pages is one full page plus half of the next, so the
 * boundary is 1.5 x the content height -- which is what puts Boston's limit
 * halfway down page two rather than at the foot of it.
 */
export function allowanceHeightPt(maxPages: number, geometry: PageGeometry): number {
  return maxPages * contentBox(geometry).heightPt
}

/** Two decimals, the precision the page counter displays. */
export function roundPages(pages: number): number {
  return Math.round(pages * 100) / 100
}
