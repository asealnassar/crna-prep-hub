/**
 * Named document-format standards, as layout the Studio can actually apply.
 *
 * ---------------------------------------------------------------------------
 * A PROFILE IS NOT A MENTION OF A STANDARD
 * ---------------------------------------------------------------------------
 * "APA" appearing in a requirement does not mean "format this essay as an APA
 * student paper". The verified catalog contains both readings:
 *
 *   Cedar Crest       "An essay ... using APA 7th edition format"   -> document
 *   New Mexico State  "Submit a 1-2 page essay using APA formatting" -> document
 *   Keiser            "excluding cover and references in AMA format" -> citations
 *
 * Only the first two apply the standard to the essay itself. A profile is set
 * offline, per school, from that wording; nothing here inspects prose, and no
 * school name appears in this file.
 *
 * ---------------------------------------------------------------------------
 * EVERY RULE CITES ITS SOURCE
 * ---------------------------------------------------------------------------
 * The rules below were read from APA's own published style guidance, not from
 * a summary of it. Each carries the page it came from, because a layout rule
 * that nobody can check is a layout rule nobody should trust.
 *
 * ---------------------------------------------------------------------------
 * IT ADDS NO CONTENT, EVER
 * ---------------------------------------------------------------------------
 * A profile chooses BODY layout. It never generates a title page, an abstract,
 * a reference list, a running head or headings. Those are content: they
 * consume the page allowance a school set, and an admissions essay that
 * silently grew a title page would be over a 1.5-page limit because of us. A
 * school that wants them has to ask in its own fields.
 */
import type { Spacing } from '../requirements/constraints.ts'

export type FormatProfileId = 'apa-7'

/** One deterministic layout rule, and where it was read from. */
export interface ProfileRule {
  readonly label: string
  readonly source: string
}

export interface FormatProfile {
  readonly id: FormatProfileId
  readonly label: string
  /** Inches, all four sides. */
  readonly marginsIn: number
  readonly spacing: Spacing
  /** Points before and after a paragraph. */
  readonly paragraphSpacingPt: number
  /** Inches. The first line of every body paragraph. */
  readonly firstLineIndentIn: number
  readonly textAlign: 'left'
  readonly hyphens: 'none'
  /**
   * ONE PERMITTED COMBINATION, CHOSEN DETERMINISTICALLY.
   *
   * APA permits several. Choosing is unavoidable -- a document is rendered in
   * exactly one font -- so the choice is fixed here rather than varying, and
   * disclosed to the applicant as one permitted configuration rather than as
   * the school's own instruction.
   */
  readonly fontFamily: string
  readonly fontSizePt: number
  /**
   * EVERY combination the standard permits, as a family AND the size that goes
   * with it.
   *
   * ---------------------------------------------------------------------------
   * A FONT AND ITS SIZE ARE ONE PERMISSION, NOT TWO
   * ---------------------------------------------------------------------------
   * APA does not permit "Arial" and separately permit "12 point"; it permits
   * 11-point Arial. Offering an applicant a font from this list and leaving the
   * size at the default would produce a document that is APA-compliant in
   * neither respect while being presented as compliant in both.
   *
   * So the pair travels together, and choosing a font from this list sets the
   * size the list gives it.
   */
  readonly permittedFonts: readonly { readonly family: string; readonly sizePt: number }[]
  /** Everything above, with citations, for the panel. */
  readonly rules: readonly ProfileRule[]
  /**
   * What the standard requires that the Studio does NOT do, said plainly.
   *
   * The honest half of the disclosure. A profile that applied six rules and
   * said nothing about the seventh would read as full compliance.
   */
  readonly notApplied: readonly ProfileRule[]
}

const APA_FONT = 'https://apastyle.apa.org/style-grammar-guidelines/paper-format/font'
const APA_MARGINS = 'https://apastyle.apa.org/style-grammar-guidelines/paper-format/margins'
const APA_SPACING = 'https://apastyle.apa.org/style-grammar-guidelines/paper-format/line-spacing'
const APA_PARAGRAPH =
  'https://apastyle.apa.org/style-grammar-guidelines/paper-format/paragraph-format'
const APA_HEADER = 'https://apastyle.apa.org/style-grammar-guidelines/paper-format/page-header'

/**
 * APA 7, as body layout.
 *
 * TIMES NEW ROMAN AT 12 PT is one of the combinations APA lists, and it is the
 * one chosen because the Studio's own metrics are calibrated against a
 * Times-compatible face -- so the page count stays on ground that has been
 * tested. The Studio renders Tinos, which is NOT Times New Roman; the font
 * registry reports that as a substitution and the panel says so.
 */
export const APA_7: FormatProfile = {
  id: 'apa-7',
  label: 'APA 7th edition',
  marginsIn: 1,
  spacing: 'double',
  paragraphSpacingPt: 0,
  firstLineIndentIn: 0.5,
  textAlign: 'left',
  hyphens: 'none',
  fontFamily: 'Times New Roman',
  fontSizePt: 12,
  /**
   * The six combinations the APA font page lists, in its own order, read from
   * apastyle.apa.org/style-grammar-guidelines/paper-format/font.
   *
   * LISTED IN FULL EVEN THOUGH THE STUDIO SHIPS TWO OF THEM. The ones that
   * cannot be rendered are shown to the applicant as permitted-but-unavailable
   * rather than omitted, because "APA allows this and we cannot do it" is a
   * fact worth having; see documentFontChoice().
   */
  permittedFonts: [
    { family: 'Calibri', sizePt: 11 },
    { family: 'Arial', sizePt: 11 },
    { family: 'Lucida Sans Unicode', sizePt: 10 },
    { family: 'Times New Roman', sizePt: 12 },
    { family: 'Georgia', sizePt: 11 },
    { family: 'Computer Modern', sizePt: 10 },
  ],
  rules: [
    { label: '1-inch margins on every side', source: APA_MARGINS },
    { label: 'Double-spaced throughout', source: APA_SPACING },
    { label: 'No extra space before or after paragraphs', source: APA_SPACING },
    { label: 'Left-aligned, ragged right — never justified', source: APA_PARAGRAPH },
    { label: 'No manual hyphenation at line ends', source: APA_PARAGRAPH },
    { label: 'First line of each paragraph indented 0.5 inch', source: APA_PARAGRAPH },
    { label: '12-point Times New Roman, one of the permitted fonts', source: APA_FONT },
  ],
  notApplied: [
    {
      label: 'Page number in the top right of every page — not added, because a '
        + 'page number is part of a submitted document and no school here asked '
        + 'for one',
      source: APA_HEADER,
    },
    {
      label: 'Title page, abstract, reference list and headings — not generated, '
        + 'because they are content and would consume the page allowance',
      source: APA_PARAGRAPH,
    },
  ],
}

const PROFILES: Readonly<Record<FormatProfileId, FormatProfile>> = { 'apa-7': APA_7 }

/** The profile a requirement names, or null. Never inferred from prose. */
export function formatProfileFor(id: unknown): FormatProfile | null {
  return typeof id === 'string' && id in PROFILES
    ? PROFILES[id as FormatProfileId]
    : null
}
