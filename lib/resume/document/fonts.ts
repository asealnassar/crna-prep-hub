/**
 * The two typefaces a resume is set in, and how their bytes reach the renderer.
 *
 * WHY THIS EXISTS. The templates used to name font STACKS -- Palatino, Georgia,
 * Inter, system sans -- and let each machine resolve them. That is fine on a
 * designer's Mac and wrong everywhere else: Vercel's Linux container has none
 * of those faces, so the PDF fell back to whatever Chromium could find and the
 * download did not look like the preview. Naming fonts you do not ship is the
 * same class of mistake as V1's two renderers, just quieter.
 *
 * ONE SET OF FILES, TWO DELIVERIES. `public/fonts/*.woff2` are the only font
 * files in play. The preview references them by URL, so the browser caches them
 * once and the page stays small. The PDF path reads the same files off disk and
 * inlines them as data URIs, because Chromium is handed an HTML string with no
 * origin to resolve a URL against -- and because an export that fetches nothing
 * cannot be made to fetch something. Same bytes, same rendering, either way.
 *
 * Both faces are variable and OFL-licensed; the licences ship beside them.
 *
 * SUBSETS: latin and latin-ext. Latin covers the Latin-1 range and the
 * punctuation a resume uses -- accented names like Jose\u0301 and Rami\u0301rez, smart
 * quotes, em dashes. Latin-ext covers the rest of Latin Extended-A and -B: the
 * \u0141 of Kowalski\u0301s colleague, the \u0159 of \u0158ezn\u00ed\u010dek, the \u0219 of Ionescu. An
 * applicant whose own name a resume cannot set correctly is not a small defect,
 * so both ship. The unicode-range on each face is what lets a browser fetch
 * only the file it needs.
 *
 * The ranges are copied verbatim from the @fontsource packages that produced
 * these files, so a character can never fall between two faces.
 */

export type FontSubset = 'latin' | 'latin-ext'

export interface FontFace {
  readonly family: string
  readonly subset: FontSubset
  /** Filename under `public/fonts`. */
  readonly file: string
  readonly unicodeRange: string
}

/** The family names the templates refer to. Never a system-font stack. */
export const SANS_FAMILY = "'Inter Var Resume'"
export const SERIF_FAMILY = "'Source Serif Resume'"

/**
 * Fallbacks appended after the embedded face.
 *
 * They should never be reached -- the faces above cover every character a
 * resume is likely to hold -- but a missing file must degrade to readable text
 * rather than to the browser's default serif at the wrong size.
 */
export const SANS_STACK = `${SANS_FAMILY}, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`
export const SERIF_STACK = `${SERIF_FAMILY}, Georgia, 'Times New Roman', serif`

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

/** Every face this project ships. Adding a subset means adding a row here. */
export const FONT_FACES: readonly FontFace[] = [
  { family: SANS_FAMILY, subset: 'latin', file: 'inter-latin.woff2', unicodeRange: LATIN },
  { family: SANS_FAMILY, subset: 'latin-ext', file: 'inter-latin-ext.woff2', unicodeRange: LATIN_EXT },
  { family: SERIF_FAMILY, subset: 'latin', file: 'source-serif-4-latin.woff2', unicodeRange: LATIN },
  { family: SERIF_FAMILY, subset: 'latin-ext', file: 'source-serif-4-latin-ext.woff2', unicodeRange: LATIN_EXT },
]

/** How the preview reaches a face: served by Next out of `public/`. */
export function webFontSrc(face: FontFace): string {
  return `/fonts/${face.file}`
}

/**
 * The @font-face block.
 *
 * `font-weight: 100 900` declares the variable axis, so one file per subset
 * serves both body text and bold headings -- and no synthetic bolding.
 * `font-display: block` rather than `swap`: a resume that renders in a fallback
 * face and then reflows is a resume that might be captured mid-swap by the PDF
 * path.
 *
 * `srcFor` decides where the bytes come from. The default is the preview's URL
 * form; the export passes a resolver that returns data URIs.
 */
export function fontFaceCss(srcFor: (face: FontFace) => string = webFontSrc): string {
  return FONT_FACES.map((face) => `@font-face {
  font-family: ${face.family};
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url('${srcFor(face)}') format('woff2');
  unicode-range: ${face.unicodeRange};
}`).join('\n')
}

/** A woff2 buffer as a CSS-ready data URI. */
export function woff2DataUri(bytes: Uint8Array | Buffer): string {
  const base64 = Buffer.from(bytes).toString('base64')
  return `data:font/woff2;base64,${base64}`
}
