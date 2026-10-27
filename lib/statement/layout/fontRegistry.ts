/**
 * Which fonts the Studio can honour, and what it does with the ones it cannot.
 *
 * ---------------------------------------------------------------------------
 * A FONT IS NOT A STYLE PREFERENCE, IT IS A REQUIREMENT
 * ---------------------------------------------------------------------------
 * A school that requires Times New Roman has stated something an admissions
 * reader may well check. Rendering a different face and ticking the box would
 * be a false pass; rendering a different face and saying nothing would be
 * worse. So every stated family resolves here, to one of three outcomes, and
 * the outcome is visible to the applicant.
 *
 *   exact        We embed that family. It is applied and locked.
 *
 *   substituted  We embed a face whose metrics match the requested one closely
 *                enough that the page breaks in the same places, but it is NOT
 *                that font. The layout is trustworthy; the font is not what was
 *                asked for, and the applicant is told so.
 *
 *   unsupported  We have nothing comparable. The page is drawn in the Studio
 *                default and the requirement is handed back to the applicant.
 *
 * ---------------------------------------------------------------------------
 * WHY SUBSTITUTION IS NOT COMPLIANCE
 * ---------------------------------------------------------------------------
 * Tinos was chosen because its vertical metrics match our Times New Roman
 * reference and our browser fixtures wrapped identically -- which is what makes
 * a page count in Tinos a usable prediction of a page count in Times New Roman.
 * It does not make the two the same font. Metric compatibility is a statement
 * about line breaking, not about glyph shapes, licensing, or what a reader sees.
 *
 * So a substitution is reported as its own state rather than folded into either
 * neighbour: calling it 'applied' would claim we met a requirement we did not,
 * and calling it 'manual' would throw away the fact that the pagination really
 * is exact for that requirement.
 */
import { TINOS, type FontMetrics } from './fontMetrics.ts'
import { STUDIO_STACK } from './fonts.ts'

/** What the Studio can do with a stated family. */
export type FontSupport = 'exact' | 'substituted' | 'unsupported'

/** A face the Studio ships and can lay out deterministically. */
export interface BundledFont {
  /** The family as the Studio renders and names it. */
  readonly family: string
  /** The self-hosted asset, relative to the repository root. */
  readonly assets: readonly string[]
  /** What the stylesheet sets font-family to. */
  readonly cssFamily: string
  /** The metrics pagination is computed from. */
  readonly metrics: FontMetrics
  /**
   * Whether PDF export can embed this face deterministically.
   *
   * RECORDED NOW, USED LATER. Export is not built yet, and the answer belongs
   * with the font rather than in whatever module eventually asks -- a face
   * added without an embeddable file would otherwise look fine until the day
   * someone tried to export it.
   */
  readonly pdfEmbeddable: boolean
}

/** The one face this product currently ships. */
export const TINOS_FONT: BundledFont = {
  family: 'Tinos',
  assets: ['public/fonts/tinos-latin.woff2', 'public/fonts/tinos-latin-ext.woff2'],
  cssFamily: STUDIO_STACK,
  metrics: TINOS,
  // SIL OFL 1.1, shipped in the repository, so an exporter can embed the bytes.
  pdfEmbeddable: true,
}

/** The Studio's own choice when a school states no family. */
export const STUDIO_DEFAULT_FONT = TINOS_FONT

interface RegistryEntry {
  /** The family as a school would write it. */
  readonly canonical: string
  /** Every spelling that resolves here, lowercased. */
  readonly aliases: readonly string[]
  /** The face actually rendered. */
  readonly rendered: BundledFont
  readonly support: Extract<FontSupport, 'exact' | 'substituted'>
  /** Said to the applicant when the rendered face is not the requested one. */
  readonly disclosure: string | null
}

/**
 * Every family the Studio recognises.
 *
 * ALIASES ARE SPELLINGS, NOT GUESSES. Each one is a way a school has written
 * or could plausibly write the same family name; none of them is an inference
 * about what a school "probably meant". An unrecognised name stays
 * unrecognised rather than being matched to the nearest thing.
 */
const REGISTRY: readonly RegistryEntry[] = [
  {
    canonical: 'Tinos',
    aliases: ['tinos'],
    rendered: TINOS_FONT,
    support: 'exact',
    disclosure: null,
  },
  {
    canonical: 'Times New Roman',
    aliases: ['times new roman', 'times roman', 'times', 'timesnewroman'],
    rendered: TINOS_FONT,
    support: 'substituted',
    disclosure:
      'Using Tinos as a metric-compatible substitute for Times New Roman so '
      + 'pagination is deterministic. Tinos does not satisfy the font-family '
      + 'requirement; set Times New Roman in the final submitted document.',
  },
  {
    // SAME METRICS AS TINOS, from the same metric-compatible family, so the
    // substitution is the same one and is disclosed the same way.
    canonical: 'Liberation Serif',
    aliases: ['liberation serif'],
    rendered: TINOS_FONT,
    support: 'substituted',
    disclosure:
      'Using Tinos as a metric-compatible substitute for Liberation Serif so '
      + 'pagination is deterministic. Tinos does not satisfy the font-family '
      + 'requirement; set Liberation Serif in the final submitted document.',
  },
]

/** What a school stated, and what the Studio will do about it. */
export interface FontResolution {
  readonly support: FontSupport
  /** The school's own words, trimmed. null when it stated no family. */
  readonly requested: string | null
  /** The family the school asked for, in its canonical spelling, when known. */
  readonly canonical: string | null
  /** The face that will actually be rendered. Always present. */
  readonly rendered: BundledFont
  /** Why the rendered face is not the requested one. null unless substituted. */
  readonly disclosure: string | null
}

/**
 * Resolve a school-stated font family.
 *
 * TAKES THE CANONICAL FIELD AND NOTHING ELSE -- no school, no catalog row. A
 * family behaves the way it does because of its name, so two schools stating
 * the same font always get the same answer.
 *
 * NO FAMILY STATED IS NOT A FAILURE. It resolves to the Studio default, marked
 * 'exact' because nothing was requested that we failed to honour.
 */
export function resolveSupportedFontFamily(requested: string | null): FontResolution {
  const trimmed = typeof requested === 'string' ? requested.trim() : ''
  if (trimmed === '') {
    return {
      support: 'exact',
      requested: null,
      canonical: STUDIO_DEFAULT_FONT.family,
      rendered: STUDIO_DEFAULT_FONT,
      disclosure: null,
    }
  }
  const key = normalise(trimmed)
  const entry = REGISTRY.find((candidate) => candidate.aliases.includes(key))
  if (entry === undefined) {
    // NOT MATCHED TO THE NEAREST THING. The page is still drawn in the default
    // face -- there is nothing else to draw it in -- but no claim is made that
    // the requirement was met, and the layout is not presented as predictive of
    // the requested font.
    return {
      support: 'unsupported',
      requested: trimmed,
      canonical: null,
      rendered: STUDIO_DEFAULT_FONT,
      disclosure: null,
    }
  }
  return {
    support: entry.support,
    requested: trimmed,
    canonical: entry.canonical,
    rendered: entry.rendered,
    disclosure: entry.disclosure,
  }
}

/**
 * The comparison key for a family name.
 *
 * PUNCTUATION AND SPACING ONLY. "Times  New Roman" and "times new roman" are
 * the same name written carelessly; "Times" and "Times New Roman" are handled
 * by being listed as aliases of each other, deliberately, rather than by any
 * rule that strips words until something matches.
 */
function normalise(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Whether a stated family is one the Studio renders exactly. */
export function isExactFont(resolution: FontResolution): boolean {
  return resolution.support === 'exact'
}

/** A school's permitted families, and which one the Studio can best honour. */
export interface FontChoiceResolution extends FontResolution {
  /** Every family the school permits, in its own wording. */
  readonly permitted: readonly string[]
  /** The permitted family the Studio resolved against, when it found one. */
  readonly chosen: string | null
}

const RANK: Readonly<Record<FontSupport, number>> = {
  exact: 0, substituted: 1, unsupported: 2,
}

/**
 * Resolve a set of permitted families.
 *
 * ---------------------------------------------------------------------------
 * A CHOICE IS AN OPPORTUNITY, NOT A COMPLICATION
 * ---------------------------------------------------------------------------
 * When a school permits several families the Studio may pick the one it honours
 * best, so a set containing anything we embed is met EXACTLY -- which is a
 * better outcome than the same school stating that family alone would have been
 * forced into. The options are tried in the school's own order after ranking,
 * so the result does not depend on how the catalog happened to list them.
 *
 * AND THE CHOICE IS NOT A LICENCE. If the best we can do is a substitution, the
 * result stays `substituted`: being allowed to pick between two fonts we do not
 * ship is not permission to use a third.
 */
export function resolveFontChoice(
  permitted: readonly string[],
): FontChoiceResolution {
  const cleaned = permitted.map((name) => name.trim()).filter((name) => name !== '')
  if (cleaned.length === 0) {
    const none = resolveSupportedFontFamily(null)
    return { ...none, permitted: [], chosen: null }
  }
  // BEST OUTCOME WINS, TIES GO TO THE SCHOOL'S ORDER. Sorting by rank alone
  // would make the answer depend on array order among equals.
  const ranked = cleaned
    .map((name, index) => ({ name, index, resolved: resolveSupportedFontFamily(name) }))
    .sort((a, b) => RANK[a.resolved.support] - RANK[b.resolved.support] || a.index - b.index)
  const best = ranked[0]!
  const chosenName = best.resolved.support === 'unsupported' ? null : best.name
  return {
    ...best.resolved,
    // THE SCHOOL'S WORDING, NOT THE REGISTRY'S. `canonical` already carries the
    // registry's spelling for code that needs it; this is what to show a reader.
    requested: cleaned.join(' or '),
    // NAMES THE PERMITTED OPTION WE RESOLVED AGAINST, so the sentence cannot be
    // read as "Tinos is one of the fonts this school allows".
    disclosure: best.resolved.support !== 'substituted' || chosenName === null
      ? best.resolved.disclosure
      : `Using Tinos as a metric-compatible substitute for the permitted `
        + `${chosenName} option. Use an explicitly permitted font in the final `
        + `submitted document.`,
    permitted: cleaned,
    chosen: chosenName,
  }
}
