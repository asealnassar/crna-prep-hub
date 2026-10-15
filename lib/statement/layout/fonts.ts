/**
 * The face the Studio writes and measures in.
 *
 * ---------------------------------------------------------------------------
 * SELF-HOSTED, BECAUSE PAGINATION MUST NOT DEPEND ON THE READER'S MACHINE
 * ---------------------------------------------------------------------------
 * A system font would make the page count a function of what happens to be
 * installed: the same essay would be 1.2 pages on one laptop and 1.4 on
 * another, and neither would match the PDF. The face is therefore bundled, and
 * the stylesheet names it first.
 *
 * THE SAME SHAPE lib/resume/document/fonts.ts USES, deliberately. That module
 * already solved this for the resume export -- a list of faces, a URL resolver
 * for the browser, and a data-URI resolver for Chromium, which receives an HTML
 * string with no origin to resolve against. Phase F will pass the second
 * resolver; the editor passes the first.
 *
 * THE SUBSET RANGES ARE THE PUBLISHER'S. Copied from Google Fonts' own
 * stylesheet for Tinos v26, so a character outside the latin block loads the
 * ext file rather than silently falling back to a face with other metrics.
 */

export type FontSubset = 'latin' | 'latin-ext'

export interface FontFace {
  readonly family: string
  readonly subset: FontSubset
  readonly file: string
  readonly unicodeRange: string
  /**
   * The weight this file CARRIES, as the @font-face descriptor states it.
   *
   * ---------------------------------------------------------------------------
   * A REAL BOLD FACE, NEVER A SYNTHESISED ONE
   * ---------------------------------------------------------------------------
   * Given only a 400 face, a browser asked for bold invents one by smearing
   * the regular outlines. Every engine smears differently, so the same bold
   * sentence takes a different width in Chromium and WebKit -- and a page
   * count computed from it is a number that depends on the reader's browser.
   *
   * TWO SHAPES, BOTH REAL. Tinos ships separate static 400 and 700 files, so
   * each face declares one weight. Arimo ships a VARIABLE file whose weight
   * axis spans 400 to 700, so one file declares the range `'400 700'` -- the
   * bold is an instance the font itself defines, which is as real as a static
   * bold and is likewise not synthesis. What is forbidden either way is a
   * family that declares only 400 and leaves the browser to invent 700; see
   * studioFonts.ts, which refuses to OFFER such a family at all.
   */
  readonly weight: 400 | 700 | '400 700'
}

/** The CSS family name. Quoted once, here. */
export const STUDIO_FAMILY = "'Tinos'"

/**
 * The stack.
 *
 * THE FALLBACKS ARE FOR THE INSTANT BEFORE THE FACE LOADS, not for measurement:
 * the editor waits for document.fonts.ready before it believes a height, so a
 * fallback's metrics never reach a reported page count. Times New Roman is
 * named first among them because it shares Tinos's metrics, so even that
 * instant does not reflow.
 */
export const STUDIO_STACK = `${STUDIO_FAMILY}, 'Times New Roman', Times, serif`

/** Declared once: the two subsets are identical across both weights. */
const LATIN_RANGE = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
const LATIN_EXT_RANGE = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF'

export const STUDIO_FONT_FACES: readonly FontFace[] = [
  {
    family: STUDIO_FAMILY,
    subset: 'latin',
    file: 'tinos-latin.woff2',
    weight: 400,
    unicodeRange: LATIN_RANGE,
  },
  {
    family: STUDIO_FAMILY,
    subset: 'latin',
    file: 'tinos-bold-latin.woff2',
    weight: 700,
    unicodeRange: LATIN_RANGE,
  },
  {
    family: STUDIO_FAMILY,
    subset: 'latin-ext',
    file: 'tinos-latin-ext.woff2',
    weight: 400,
    unicodeRange: LATIN_EXT_RANGE,
  },
  {
    family: STUDIO_FAMILY,
    subset: 'latin-ext',
    file: 'tinos-bold-latin-ext.woff2',
    weight: 700,
    unicodeRange: LATIN_EXT_RANGE,
  },
]

/**
 * Arimo: the Studio's sans, and the metric-compatible stand-in for Arial.
 *
 * ONE FILE PER SUBSET, SPANNING BOTH WEIGHTS. Google no longer publishes
 * static Arimo instances -- both the modern and the legacy stylesheet APIs
 * return the same variable file for 400 and for 700 -- so the descriptor
 * declares the range and the browser instances the font's own weight axis.
 *
 * SIL Open Font License 1.1, bundled in public/fonts with its licence.
 */
export const ARIMO_FAMILY = "'Arimo'"

/**
 * THE FALLBACKS ARE FOR THE INSTANT BEFORE THE FACE LOADS, as with the serif
 * stack: Arial is named first because Arimo shares its metrics, so even that
 * instant does not reflow.
 */
export const ARIMO_STACK = `${ARIMO_FAMILY}, Arial, Helvetica, sans-serif`

export const ARIMO_FONT_FACES: readonly FontFace[] = [
  {
    family: ARIMO_FAMILY,
    subset: 'latin',
    file: 'arimo-latin.woff2',
    weight: '400 700',
    unicodeRange: LATIN_RANGE,
  },
  {
    family: ARIMO_FAMILY,
    subset: 'latin-ext',
    file: 'arimo-latin-ext.woff2',
    weight: '400 700',
    unicodeRange: LATIN_EXT_RANGE,
  },
]

/** Every face this product bundles, in declaration order. */
export const ALL_FONT_FACES: readonly FontFace[] = [
  ...STUDIO_FONT_FACES,
  ...ARIMO_FONT_FACES,
]

/** Where the browser fetches a face from. */
export function webFontSrc(face: FontFace): string {
  return `url(/fonts/${face.file}) format('woff2')`
}

/**
 * The @font-face blocks.
 *
 * `font-display: block` ON PURPOSE. `swap` would paint the fallback first and
 * reflow when the real face arrived -- which is a visible jump in a document
 * whose whole point is where the lines fall. Blocking briefly is the better
 * trade here, and the measurement waits for the face regardless.
 */
export function studioFontFaceCss(
  srcFor: (face: FontFace) => string = webFontSrc,
  /**
   * Which faces to declare. Every bundled one by default.
   *
   * THE WHOLE SET IS DECLARED EVEN THOUGH ONE FAMILY RENDERS. A @font-face
   * rule is a declaration, not a fetch: the browser downloads only the files a
   * rendered glyph actually needs. Declaring them all means switching the font
   * is a change of `font-family` with nothing to re-inject, and the editor
   * never re-measures against a face whose rule arrived late.
   */
  faces: readonly FontFace[] = ALL_FONT_FACES,
): string {
  return faces.map((face) => `@font-face {
  font-family: ${face.family};
  font-style: normal;
  font-weight: ${face.weight};
  font-display: block;
  src: ${srcFor(face)};
  unicode-range: ${face.unicodeRange};
}`).join('\n')
}
