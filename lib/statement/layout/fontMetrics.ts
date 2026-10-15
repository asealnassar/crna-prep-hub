/**
 * The typographic metrics the Studio lays out with.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE NUMBERS ARE READ RATHER THAN GUESSED
 * ---------------------------------------------------------------------------
 * The page count is the product. "Maximum 1.5 pages" is only meaningful if the
 * line box is a fixed, known height -- an approximation of a few per cent moves
 * the boundary by most of a line, and at 1.5 pages that is the difference
 * between compliant and not.
 *
 * So these are READ FROM THE FONT FILE. They were extracted twice, by two
 * independent implementations -- a WOFF2 table reader written here and
 * fontTools 4.60.2 -- which agree exactly, and then confirmed a third time
 * against line boxes the browser actually rendered. A test re-derives them from
 * the shipped file, so a font upgrade that changed them fails rather than
 * silently repaginating every draft.
 *
 * ---------------------------------------------------------------------------
 * WHY TINOS
 * ---------------------------------------------------------------------------
 * Boston College states a 1.5-page maximum and double spacing, and no font. The
 * Studio must supply one, and the page count depends entirely on which: the
 * same essay occupies 0.383 pages in Times-compatible metrics and 0.559 in
 * Source Serif 4 -- 46% more height for identical text. A default chosen for
 * convenience would have cost a Boston applicant roughly a third of their
 * allowance.
 *
 * Tinos uses Times New Roman-compatible metrics. The inspected vertical metrics
 * -- unitsPerEm, hhea ascender/descender/lineGap, OS/2 typo and win sums, and
 * the USE_TYPO_METRICS flag -- match our Times New Roman reference, and our
 * representative browser fixtures produced matching wrapping and identical line
 * counts in Chromium and WebKit. That is what was tested; no claim is made
 * about glyph-by-glyph advances or about bytes beyond those tables.
 *
 * ---------------------------------------------------------------------------
 * THE LINE BOX IS SNAPPED TO A WHOLE CSS PIXEL, AND THAT IS NOT COSMETIC
 * ---------------------------------------------------------------------------
 * The derived double-spaced line is 36.7969 px. Chromium honours that exactly;
 * WebKit FLOORS a sub-pixel line height to a whole pixel, returning 36. The
 * same essay then measured 0.383 pages in Chrome and 0.375 in Safari -- a
 * silent disagreement in the one number this feature exists to report.
 *
 * Both engines honour a whole-pixel value identically, so the derived height is
 * rounded to the nearest pixel: 37 px. Verified in Chromium, in WebKit, and in
 * Chromium's print media, which is the path a PDF would take.
 *
 * 37 px IS 0.55% TALLER than the derived value, and that direction is chosen:
 * rounding up reports slightly MORE of the page used, so an applicant who fits
 * inside the Studio's allowance is not later found to have overflowed.
 *
 * WHAT THIS IS NOT. It is a deterministic Studio interpretation of double
 * spacing using Times-compatible metrics. It is not claimed to be identical to
 * Microsoft Word, and fitting inside the Studio does not guarantee an identical
 * Word page count: Word is a different layout engine. By design it should be
 * very close -- 648 pt of usable height holds 23 whole lines at either value.
 */

export interface FontMetrics {
  /** The CSS family name, as @font-face declares it. */
  readonly family: string
  /** The file these were read from, so the test knows what to re-derive. */
  readonly sourceFile: string
  readonly unitsPerEm: number
  /** hhea.ascender, in font units. Positive. */
  readonly ascender: number
  /** hhea.descender, in font units. NEGATIVE, as the table stores it. */
  readonly descender: number
  readonly lineGap: number
  /** OS/2 fsSelection bit 7. */
  readonly useTypoMetrics: boolean
}

/** Tinos, as shipped in public/fonts. SIL Open Font License 1.1. */
export const TINOS: FontMetrics = {
  family: 'Tinos',
  sourceFile: 'public/fonts/tinos-latin.woff2',
  unitsPerEm: 2048,
  ascender: 1825,
  descender: -443,
  lineGap: 87,
  useTypoMetrics: false,
}

/**
 * Arimo, as shipped in public/fonts. SIL Open Font License 1.1.
 *
 * ---------------------------------------------------------------------------
 * THE LINE BOX IS THE SAME HEIGHT AS TINOS, AND THE PAGE COUNT IS NOT
 * ---------------------------------------------------------------------------
 * 1854 + 434 + 67 = 2355, which is exactly Tinos's 1825 + 443 + 87. Both come
 * from the Croscore family, whose whole purpose is to match the vertical
 * metrics of the fonts they stand in for -- so switching between them does not
 * move a single line box.
 *
 * WHAT DOES CHANGE IS WHERE THE TEXT WRAPS. Arimo's advances are Arial's, which
 * are wider than Times's at the same size, so the same essay takes more lines
 * and therefore more page. That is a real difference an applicant must be able
 * to see, which is why the page count is re-measured from the browser's own
 * layout after a font change rather than scaled from a formula.
 *
 * useTypoMetrics IS TRUE HERE and false for Tinos, which is a fact about the
 * files rather than a choice: this module reads hhea either way, because that
 * is what both engines use for the default line box when a line-height is not
 * set -- and the Studio always sets one.
 */
export const ARIMO: FontMetrics = {
  family: 'Arimo',
  sourceFile: 'public/fonts/arimo-latin.woff2',
  unitsPerEm: 2048,
  ascender: 1854,
  descender: -434,
  lineGap: 67,
  useTypoMetrics: true,
}

/** CSS pixels are 1/96in; points are 1/72in. */
export const PT_PER_PX = 72 / 96
export const PX_PER_PT = 96 / 72

/**
 * Points, to three decimals.
 *
 * NOT COSMETIC. 2355/2048 x 12 is 13.798828125 in IEEE 754, and that value
 * would reach the stylesheet, the measurement and the PDF as slightly different
 * strings depending on how each formatted it. Rounding once, here, means one
 * number travels everywhere. A thousandth of a point is 0.0013 px -- two orders
 * of magnitude under a device pixel -- so it cannot move a line.
 */
export function roundPt(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * The font's own single line, in points, at a given size.
 *
 * ascender - descender + lineGap, scaled by the size and divided by the em. The
 * descender is negative in the table, so subtracting it adds its depth. This is
 * the DERIVED value, before any snapping.
 */
export function derivedLineHeightPt(metrics: FontMetrics, fontSizePt: number): number {
  const em = metrics.ascender - metrics.descender + metrics.lineGap
  return roundPt((em / metrics.unitsPerEm) * fontSizePt)
}

/**
 * The line box the Studio renders and measures with.
 *
 * DOUBLE IS 2x THE FONT'S LINE, which is what a word processor means by
 * "double-spaced" and what a school means by it. It is NOT CSS
 * `line-height: 2`: that would be twice the FONT SIZE (24 pt at 12 pt), 13%
 * tighter here, which is three extra lines on a page.
 *
 * THEN SNAPPED TO A WHOLE CSS PIXEL, for the cross-engine reason in the header.
 * The snapping is applied to the final box, not to the single line, so double
 * spacing is exactly twice the line the font describes before rounding once.
 */
export function lineHeightPt(
  metrics: FontMetrics,
  fontSizePt: number,
  spacing: 'single' | 'double',
): number {
  const derived = derivedLineHeightPt(metrics, fontSizePt) * (spacing === 'double' ? 2 : 1)
  return snapToPixelPt(derived)
}

/** The same box in whole CSS pixels, which is what the stylesheet declares. */
export function lineHeightPx(
  metrics: FontMetrics,
  fontSizePt: number,
  spacing: 'single' | 'double',
): number {
  return Math.round(lineHeightPt(metrics, fontSizePt, spacing) * PX_PER_PT)
}

/**
 * Round a point value to the nearest whole CSS pixel, and return it in points.
 *
 * WHOLE PIXELS ARE THE ONLY VALUES BOTH ENGINES AGREE ON. Chromium keeps a
 * sub-pixel line height; WebKit floors it. Measured: an explicit 36.7969 px
 * came back as 36.7969 in Chromium and 36.0000 in WebKit, while 37 px came back
 * as 37.0000 in both, and in Chromium's print media.
 */
export function snapToPixelPt(valuePt: number): number {
  return roundPt(Math.round(valuePt * PX_PER_PT) * PT_PER_PX)
}
