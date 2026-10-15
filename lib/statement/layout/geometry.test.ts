/**
 * Phase A: the page the Studio writes on.
 *
 * ---------------------------------------------------------------------------
 * THE TWO THINGS THAT MUST NOT DRIFT
 * ---------------------------------------------------------------------------
 *   1. THE FONT METRICS. The page count is the product; a line box a few per
 *      cent out moves Boston's 1.5-page boundary by most of a line. So the
 *      numbers in fontMetrics.ts are re-derived here FROM THE SHIPPED FILE --
 *      a font upgrade that changes them fails this test instead of silently
 *      repaginating every draft in the Studio.
 *
 *   2. PROVENANCE. Boston specifies a page maximum and a spacing and nothing
 *      else. Every assertion about what it "requires" is therefore also an
 *      assertion about what it does NOT.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'
import { ARIMO,
  PX_PER_PT, TINOS, derivedLineHeightPt, lineHeightPt, lineHeightPx, snapToPixelPt,
} from './fontMetrics.ts'
import {
  STUDIO_DEFAULTS, STUDIO_PARAGRAPH, allowanceHeightPt, contentBox, linesPerPage,
  pagesUsed, resolveGeometry, roundPages, unsupportedTypography,
} from './geometry.ts'
import { NO_CONSTRAINTS, pageLimit, statedLength, wordLimit } from '../requirements/constraints.ts'
import type { Constraints } from '../requirements/constraints.ts'

// ===========================================================================
// THE METRICS ARE REAL
// ===========================================================================

/**
 * Read `head` and `OS/2` straight out of the shipped WOFF2.
 *
 * WOFF2 stores its tables as one Brotli stream after a directory of lengths, so
 * a table's offset is the sum of the lengths before it. Node has Brotli built
 * in, which is why this needs no dependency.
 */
function metricsFromFile(file: string): {
  unitsPerEm: number; ascender: number; descender: number; lineGap: number
  useTypoMetrics: boolean
} {
  const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
    'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH',
    'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
    'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln',
    'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx',
    'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill']
  const buf = readFileSync(file)
  assert.equal(buf.toString('ascii', 0, 4), 'wOF2', 'not a WOFF2 file')
  const numTables = buf.readUInt16BE(12)
  const totalCompressed = buf.readUInt32BE(20)
  let p = 48
  const base128 = (): number => {
    let v = 0
    for (let i = 0; i < 5; i += 1) {
      const b = buf[p]!; p += 1
      v = ((v << 7) | (b & 0x7f)) >>> 0
      if ((b & 0x80) === 0) return v
    }
    throw new Error('bad UIntBase128')
  }
  const dir: { tag: string; length: number }[] = []
  for (let i = 0; i < numTables; i += 1) {
    const flags = buf[p]!; p += 1
    const index = flags & 0x3f
    let tag: string
    if (index === 63) { tag = buf.toString('ascii', p, p + 4); p += 4 } else { tag = KNOWN[index]! }
    const origLength = base128()
    const transform = (flags >> 6) & 0x03
    const transformed = (tag === 'glyf' || tag === 'loca') ? transform === 0 : transform !== 0
    dir.push({ tag, length: transformed ? base128() : origLength })
  }
  const data = brotliDecompressSync(buf.subarray(p, p + totalCompressed))
  const at = new Map<string, Buffer>()
  let off = 0
  for (const t of dir) { at.set(t.tag, data.subarray(off, off + t.length)); off += t.length }
  const head = at.get('head')!
  const hhea = at.get('hhea')!
  const os2 = at.get('OS/2')!
  return {
    unitsPerEm: head.readUInt16BE(18),
    ascender: hhea.readInt16BE(4),
    descender: hhea.readInt16BE(6),
    lineGap: hhea.readInt16BE(8),
    useTypoMetrics: (os2.readUInt16BE(62) & 0x80) !== 0,
  }
}

test('THE COMMITTED METRICS MATCH THE SHIPPED FONT FILE', () => {
  const actual = metricsFromFile(TINOS.sourceFile)
  assert.equal(actual.unitsPerEm, TINOS.unitsPerEm)
  assert.equal(actual.ascender, TINOS.ascender)
  assert.equal(actual.descender, TINOS.descender)
  assert.equal(actual.lineGap, TINOS.lineGap)
  assert.equal(actual.useTypoMetrics, TINOS.useTypoMetrics)
})

test('THE COMMITTED ARIMO METRICS MATCH ITS SHIPPED FILE TOO', () => {
  const actual = metricsFromFile(ARIMO.sourceFile)
  assert.equal(actual.unitsPerEm, ARIMO.unitsPerEm)
  assert.equal(actual.ascender, ARIMO.ascender)
  assert.equal(actual.descender, ARIMO.descender)
  assert.equal(actual.lineGap, ARIMO.lineGap)
  assert.equal(actual.useTypoMetrics, ARIMO.useTypoMetrics)
  // Both subsets, for the reason the Tinos pair gives: a mismatch would
  // repaginate a draft the moment it used an accented character.
  const ext = metricsFromFile('public/fonts/arimo-latin-ext.woff2')
  assert.equal(ext.ascender, ARIMO.ascender)
  assert.equal(ext.descender, ARIMO.descender)
  assert.equal(ext.lineGap, ARIMO.lineGap)
})

test('THE TWO FACES SHARE A LINE BOX, which is why switching never reflows one', () => {
  /*
   * Both are Croscore faces, whose whole purpose is matching the vertical
   * metrics of the fonts they stand in for -- 1825+443+87 and 1854+434+67 are
   * both 2355. So a font change moves no line box, and what it DOES move is
   * where the text wraps, which is why the page count is re-measured from the
   * browser's own layout rather than scaled from these numbers.
   */
  const sum = (m: typeof TINOS) => m.ascender - m.descender + m.lineGap
  assert.equal(sum(TINOS), 2355)
  assert.equal(sum(ARIMO), 2355)
  assert.equal(TINOS.unitsPerEm, ARIMO.unitsPerEm)
})

test('and the latin-ext file carries the same ones', () => {
  // Two files, one family: a mismatch would repaginate a draft the moment it
  // used an accented character.
  const ext = metricsFromFile('public/fonts/tinos-latin-ext.woff2')
  assert.equal(ext.unitsPerEm, TINOS.unitsPerEm)
  assert.equal(ext.ascender, TINOS.ascender)
  assert.equal(ext.descender, TINOS.descender)
  assert.equal(ext.lineGap, TINOS.lineGap)
})

test('the line box is derived, then snapped to a whole CSS pixel', () => {
  // 1825 - (-443) + 87 = 2355 units per line, over 2048 per em, at 12 pt.
  assert.equal(derivedLineHeightPt(TINOS, 12), 13.799)
  // Derived double is 27.598 pt = 36.797 px, which WebKit floors and Chromium
  // keeps. Snapped to 37 px, both engines agree -- measured in each.
  assert.equal(lineHeightPt(TINOS, 12, 'double'), 27.75)
  assert.equal(lineHeightPx(TINOS, 12, 'double'), 37)
  assert.equal(lineHeightPt(TINOS, 12, 'single'), 13.5)
  assert.equal(lineHeightPx(TINOS, 12, 'single'), 18)
})

test('SNAPPING ROUNDS UP HERE, which is the conservative direction', () => {
  // 36.797 px -> 37, not 36: the Studio reports slightly MORE of the page used,
  // so an applicant who fits inside its allowance is not later found to have
  // overflowed. 0.55% taller than the derived value.
  const derived = derivedLineHeightPt(TINOS, 12) * 2
  assert.ok(lineHeightPt(TINOS, 12, 'double') > derived)
  assert.ok((lineHeightPt(TINOS, 12, 'double') / derived) - 1 < 0.01)
  // And the snapped value really is a whole pixel, which is the point.
  assert.equal(Number.isInteger(lineHeightPt(TINOS, 12, 'double') * PX_PER_PT), true)
  assert.equal(snapToPixelPt(27.598), 27.75)
})

test('DOUBLE IS NOT CSS line-height: 2', () => {
  // The distinction the whole measurement rests on: twice the LINE, not twice
  // the font size. 24 pt would be 13% tighter -- three extra lines a page.
  const cssLineHeightTwo = 12 * 2
  assert.notEqual(lineHeightPt(TINOS, 12, 'double'), cssLineHeightTwo)
  assert.ok(lineHeightPt(TINOS, 12, 'double') > cssLineHeightTwo)
})

// ===========================================================================
// BOSTON COLLEGE -- THE ACCEPTANCE CASE
// ===========================================================================

/** Boston's imported requirement: a page maximum and a spacing, and nothing else. */
const BOSTON: Constraints = {
  ...NO_CONSTRAINTS,
  pages: pageLimit({
    min: null, max: 1.5, spacing: 'double', enforcement: 'enforced',
    statedAs: 'explicit bound: "maximum"',
  }),
}

test('Boston: the school supplies the page limit and the spacing', () => {
  const geometry = resolveGeometry(BOSTON)
  assert.equal(geometry.spacing.value, 'double')
  assert.equal(geometry.spacing.source, 'school')
})

test('Boston: EVERYTHING ELSE IS A STUDIO DEFAULT, and says so', () => {
  const geometry = resolveGeometry(BOSTON)
  // The claim the owner was most concerned about: we must never present these
  // as something Boston required.
  assert.equal(geometry.paperWidthIn.source, 'studio-default')
  assert.equal(geometry.paperHeightIn.source, 'studio-default')
  assert.equal(geometry.fontFamily.source, 'studio-default')
  assert.equal(geometry.fontSizePt.source, 'studio-default')
  assert.equal(geometry.marginsIn.source, 'studio-default')
  assert.equal(geometry.fontFamily.value, 'Tinos')
  assert.equal(geometry.fontSizePt.value, 12)
  assert.equal(geometry.marginsIn.value, 1)
  assert.equal(geometry.paperWidthIn.value, 8.5)
  assert.equal(geometry.paperHeightIn.value, 11)
})

test('Boston: the resolved line box is the double-spaced one', () => {
  assert.equal(resolveGeometry(BOSTON).lineHeightPt, 27.75)
})

test('Boston: the content box is 6.5 x 9 inches', () => {
  const box = contentBox(resolveGeometry(BOSTON))
  assert.equal(box.widthPt, 468)   // 6.5in
  assert.equal(box.heightPt, 648)  // 9in
})

test('Boston: 1.5 pages ends exactly halfway down page two', () => {
  const geometry = resolveGeometry(BOSTON)
  const page = contentBox(geometry).heightPt
  const allowance = allowanceHeightPt(1.5, geometry)
  assert.equal(allowance, page * 1.5)
  // One full page, plus half of the next.
  assert.equal(allowance - page, page / 2)
  assert.equal(allowance, 972)
})

test('Boston: a draft measuring 1.21 pages reports 1.21', () => {
  const geometry = resolveGeometry(BOSTON)
  const height = contentBox(geometry).heightPt * 1.21
  assert.equal(roundPages(pagesUsed(height, geometry)), 1.21)
})

test('Boston: over the limit is reported, never clamped', () => {
  const geometry = resolveGeometry(BOSTON)
  const height = contentBox(geometry).heightPt * 1.67
  const used = pagesUsed(height, geometry)
  assert.equal(roundPages(used), 1.67)
  assert.ok(used > 1.5)
  // The number keeps rising past the maximum; nothing truncates.
  assert.ok(pagesUsed(contentBox(geometry).heightPt * 9, geometry) > 8)
})

// ===========================================================================
// FRACTIONS, AND SCHOOLS THAT STATE MORE
// ===========================================================================

test('every fractional limit lands where it should', () => {
  const geometry = resolveGeometry(BOSTON)
  const page = contentBox(geometry).heightPt
  for (const [limit, expected] of [[0.5, 0.5], [1, 1], [1.5, 1.5], [2, 2], [2.5, 2.5]] as const) {
    assert.equal(allowanceHeightPt(limit, geometry), page * expected, `${limit} pages`)
  }
})

test('a school that states a font size and margins REPLACES the defaults', () => {
  const geometry = resolveGeometry({
    ...NO_CONSTRAINTS,
    pages: pageLimit({
      min: null, max: 2, spacing: 'single', enforcement: 'enforced', statedAs: null,
    }),
    typography: { fontSizePt: 11, fontFamily: null, marginsInches: 0.75 },
  })
  assert.equal(geometry.fontSizePt.value, 11)
  assert.equal(geometry.fontSizePt.source, 'school')
  assert.equal(geometry.marginsIn.value, 0.75)
  assert.equal(geometry.marginsIn.source, 'school')
  // The line box follows the school's size, not ours.
  assert.equal(geometry.lineHeightPt, lineHeightPt(TINOS, 11, 'single'))
  // And the margins change the box.
  assert.equal(contentBox(geometry).heightPt, (11 - 1.5) * 72)
})

test('a school-stated FONT FAMILY is surfaced, not silently applied', () => {
  // We embed one face. A school requiring Times has stated a requirement the
  // applicant must satisfy in their final document, so it is reported rather
  // than dropped -- and never rendered as a passed check.
  const constraints: Constraints = {
    ...NO_CONSTRAINTS,
    typography: { fontSizePt: null, fontFamily: 'Times New Roman', marginsInches: null },
  }
  assert.deepEqual(unsupportedTypography(constraints), ['Times New Roman'])
  assert.equal(resolveGeometry(constraints).fontFamily.value, 'Tinos')
  assert.equal(resolveGeometry(constraints).fontFamily.source, 'studio-default')
})

test('no requirement at all resolves to Studio defaults throughout', () => {
  const geometry = resolveGeometry(null)
  for (const field of [geometry.paperWidthIn, geometry.paperHeightIn, geometry.marginsIn,
    geometry.fontFamily, geometry.fontSizePt, geometry.spacing]) {
    assert.equal(field.source, 'studio-default')
  }
  assert.equal(geometry.spacing.value, 'single')
  assert.equal(geometry.lineHeightPt, 13.5)
})

test('lines per page is floored: a line that does not fit is on the next page', () => {
  const geometry = resolveGeometry(BOSTON)
  // 648 / 27.75 = 23.35. Word's own derived value gives 23.48 -- the same 23
  // whole lines, which is the closest thing to equivalence we can demonstrate.
  assert.equal(linesPerPage(geometry), 23)
  const single = resolveGeometry(null)
  assert.equal(linesPerPage(single), Math.floor(648 / 13.5))
})

// ===========================================================================
// THE PARAGRAPH SPEC -- each item silently moves a page boundary
// ===========================================================================

test('paragraph spacing is zero before and after', () => {
  // A browser's default <p> margin is about one blank line. Six paragraphs
  // would gain six lines nobody typed -- a third of a double-spaced page.
  assert.equal(STUDIO_PARAGRAPH.spaceBeforePt, 0)
  assert.equal(STUDIO_PARAGRAPH.spaceAfterPt, 0)
})

test('alignment, tracking and hyphenation are pinned', () => {
  // Each varies where lines break, and none is identical across engines.
  assert.equal(STUDIO_PARAGRAPH.textAlign, 'left')
  assert.equal(STUDIO_PARAGRAPH.letterSpacing, 'normal')
  assert.equal(STUDIO_PARAGRAPH.hyphens, 'none')
})

test('THE EDITOR STYLESHEET APPLIES THE SPEC', () => {
  // The spec is only worth stating if the surface obeys it, and the stylesheet
  // lives in the component rather than here -- so it is read.
  const editor = readFileSync('app/statement-studio/components/PaginatedEditor.tsx', 'utf8')
  for (const rule of [
    'margin: 0', 'padding: 0', 'min-height: var(--page-line-height)',
    'text-align: left', 'letter-spacing: normal', 'hyphens: none',
    '-webkit-hyphens: none',
    // POSITIVE INTEGERS. Zero is invalid CSS: the declaration is dropped at
    // parse time and each engine falls back to its own initial value --
    // measured as 2 in Chromium and auto in WebKit. 1 is honoured by both.
    'widows: 1', 'orphans: 1',
  ]) {
    assert.ok(editor.includes(rule), `the stylesheet does not set ${rule}`)
  }
  // And nothing justifies, which would make the wrap engine-dependent.
  assert.equal(editor.includes('text-align: justify'), false)
})

test('WIDOWS AND ORPHANS ARE POSITIVE INTEGERS, NEVER ZERO', () => {
  /*
   * ZERO IS INVALID CSS AND WAS SILENTLY WORSE THAN WRONG.
   *
   * CSS Fragmentation allows only a positive integer, so `widows: 0` is dropped
   * at parse time and the engine falls back to its own initial value. Measured
   * directly in both: Chromium computed 2, WebKit computed auto. A paragraph
   * could then not split with fewer than two lines on either side of a break,
   * pushing lines across boundaries this module's arithmetic does not model --
   * and doing it differently in each browser.
   *
   * 1 is honoured identically by both, on screen and in print media, and is
   * what lets a page boundary fall anywhere inside a paragraph.
   */
  const editor = readFileSync('app/statement-studio/components/PaginatedEditor.tsx', 'utf8')
  for (const invalid of ['widows: 0', 'orphans: 0', 'widows: -', 'orphans: -',
    'widows: auto', 'orphans: auto']) {
    assert.equal(editor.includes(invalid), false, `${invalid} is not a valid declaration`)
  }
  assert.match(editor, /widows: 1;/)
  assert.match(editor, /orphans: 1;/)
})

test('an empty paragraph still occupies one line box', () => {
  // Pressing Enter twice costs exactly one line of the allowance: what the
  // applicant sees as one blank line is one line. min-height is what does it.
  const editor = readFileSync('app/statement-studio/components/PaginatedEditor.tsx', 'utf8')
  assert.match(editor, /min-height: var\(--page-line-height\)/)
})

// ===========================================================================
// WHAT THIS MODULE MUST NEVER DO
// ===========================================================================

test('NO WORDS-PER-PAGE ESTIMATE EXISTS ANYWHERE IN THE LAYOUT ENGINE', () => {
  // The claim this product refuses to make. Asserted on the source so a helpful
  // future addition fails here rather than shipping.
  for (const file of ['./geometry.ts', './fontMetrics.ts', './compliance.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    for (const forbidden of ['wordsPerPage', 'WORDS_PER_PAGE', 'perPage', 'estimate']) {
      assert.equal(source.includes(forbidden), false, `${file} contains ${forbidden}`)
    }
  }
})

test('pagesUsed takes a measured height and nothing else', () => {
  const geometry = resolveGeometry(BOSTON)
  // Not a word count, not a character count: a height.
  assert.equal(pagesUsed(0, geometry), 0)
  assert.equal(pagesUsed(-50, geometry), 0, 'a negative height is not a negative page')
  assert.equal(pagesUsed(648, geometry), 1)
})

test('the Studio defaults are the approved ones', () => {
  assert.equal(STUDIO_DEFAULTS.paperWidthIn, 8.5)
  assert.equal(STUDIO_DEFAULTS.paperHeightIn, 11)
  assert.equal(STUDIO_DEFAULTS.marginsIn, 1)
  assert.equal(STUDIO_DEFAULTS.fontSizePt, 12)
  assert.equal(STUDIO_DEFAULTS.metrics.family, 'Tinos')
})

test('a word limit and a page limit are resolved independently', () => {
  // Neither is derived from the other, which is the rule the owner set.
  const both: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({
      min: null, max: 500, enforcement: 'enforced', statedAs: null,
    }),
    pages: pageLimit({
      min: null, max: 2, spacing: 'double', enforcement: 'enforced', statedAs: null,
    }),
  }
  const geometry = resolveGeometry(both)
  // The geometry knows nothing about the word limit.
  assert.equal(geometry.lineHeightPt, 27.75)
  assert.equal(allowanceHeightPt(2, geometry), contentBox(geometry).heightPt * 2)
  void statedLength
})

// ===========================================================================
// PHASE D / E: WHAT THE RENDERED PAGE MUST KEEP DOING
// ===========================================================================

/** One CSS rule's declarations, cut at its own closing brace. */
function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `${selector} is not in the stylesheet`)
  const end = source.indexOf('}', start)
  assert.notEqual(end, -1, `${selector} is unterminated`)
  return source.slice(start, end)
}

/**
 * The editor source, with comments removed so prose cannot satisfy a rule.
 *
 * TEMPLATE INTERPOLATIONS ARE NEUTRALISED TOO. The stylesheet is a template
 * literal, so `${geometry.marginsIn.value}` carries a closing brace that is not
 * the end of the CSS rule it sits in -- which is enough to make `cssRule` cut a
 * rule short and pass a test that was reading nothing.
 */
function editorSource(): string {
  let source = readFileSync('app/statement-studio/components/PaginatedEditor.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  for (;;) {
    const next = source.replace(/\$\{[^{}]*\}/g, '0')
    if (next === source) return source
    source = next
  }
}

test('THE PAGE GAP IS IN THE TEXT FLOW, NOT BEHIND IT', () => {
  /*
   * The architecture the owner required, asserted on the source.
   *
   * A backdrop of page sheets behind a continuous editor is two layouts that
   * nothing forces to agree, and the first thing that disagrees is where the
   * caret sits. The gap is a widget decoration: real DOM inside the flow, so
   * the text, the caret and the selection are laid out around it once.
   */
  const source = editorSource()
  assert.match(source, /Decoration\.widget/, 'the break must be a widget decoration')
  assert.match(source, /statement-page-break/)
  // Taken out of the flow is exactly what it must not be.
  for (const forbidden of ['position: absolute;\n          top: 0;\n          bottom: 0',
    'page-backdrop', 'page-underlay', 'sheet-layer']) {
    assert.equal(source.includes(forbidden), false, `found ${forbidden}`)
  }
})

test('the gap spans the paper, not just the text column', () => {
  // Negative margins cancel the sheet's padding. A gap inset by the margin
  // would read as a rule drawn across one long page.
  const source = editorSource()
  assert.match(source, /margin-left: calc\(-1 \* var\(--page-margin\)\)/)
  assert.match(source, /margin-right: calc\(-1 \* var\(--page-margin\)\)/)
  // And it carries both margins, so the next line starts one page down.
  assert.match(source, /padding-top: var\(--page-margin\)/)
  assert.match(source, /padding-bottom: var\(--page-margin\)/)
})

test('THE ALLOWANCE LINE COSTS NO VERTICAL SPACE', () => {
  // A rule that occupied any height would push the text down and move the
  // boundary it was drawn at: a self-defeating marker. Out of the flow is what
  // guarantees it cannot, and the frame it is positioned against is the text.
  const source = editorSource()
  const rule = cssRule(source, '.statement-limit-rule')
  assert.match(rule, /position: absolute/)
  assert.equal(/height:/.test(rule), false, 'it is a border, not a box')
  assert.match(cssRule(source, '.statement-page-flow'), /position: relative/)
})

test('TEXT PAST THE LIMIT IS MARKED, NOT DISABLED', () => {
  /*
   * The owner's constraint: "Do not make the over-limit treatment so aggressive
   * that the user can't comfortably edit the text."
   *
   * So the decoration is inline and cosmetic. It must not shrink the text, dim
   * it, hide it, or stop it being edited -- cutting an essay to length means
   * reading and rewriting precisely this part.
   */
  const source = editorSource()
  assert.match(source, /Decoration\.inline/)
  assert.match(source, /statement-over-limit/)
  const block = cssRule(source, '.statement-over-limit')
  assert.match(block, /background-color/)
  for (const forbidden of ['display: none', 'visibility: hidden', 'opacity:',
    'font-size:', 'pointer-events: none', 'user-select: none']) {
    assert.equal(block.includes(forbidden), false,
      `the over-limit treatment must not set ${forbidden}`)
  }
  // Nothing that occupies space, which would re-wrap the text it is measuring.
  for (const forbidden of ['border:', 'border-top:', 'padding:', 'margin:']) {
    assert.equal(block.includes(forbidden), false, `${forbidden} would re-wrap`)
  }
})

test('THE EDITOR REPORTS TEXT HEIGHT WITH THE GAPS TAKEN BACK OUT', () => {
  /*
   * scrollHeight includes every gap that is currently rendered, so reporting it
   * raw would make a 1.21-page essay read as 1.47 the moment the first break
   * appeared -- the panel disagreeing with the page it describes.
   */
  const source = editorSource()
  assert.match(source, /rawTextHeightPx/)
  assert.equal(/onMeasure[^\n]*scrollHeight/.test(source), false)
  // And one authority: no second observer measuring the same element.
  assert.equal((source.match(/scrollHeight/g) ?? []).length, 1,
    'scrollHeight should be read in exactly one place')
})

test('a break is only ever placed at a visual line start', () => {
  /*
   * THE PREMISE THE WHOLE SINGLE-PASS DESIGN RESTS ON. A block widget ends the
   * line it sits in. Placed at a line start, the line was already ending there
   * and no line breaking changes -- which is what makes the gapless raw layout
   * stable and one measuring pass enough. Placed mid-line it would split a word
   * across a page and the next pass would measure a different document.
   *
   * posAtCoords is therefore asked about the LEFT EDGE of the content box.
   */
  const source = editorSource()
  assert.match(source, /box\.left \+ 1/)
  assert.match(source, /posAtCoords/)
  // The vertical probe comes from the arithmetic, never from a magic number.
  assert.match(source, /breakProbePx/)
})

test('the loop that places breaks cannot run away', () => {
  // A single line taller than the page would otherwise stack gaps for ever and
  // hang the editor. Two independent stops: no progress, and a hard bound.
  const source = editorSource()
  assert.match(source, /rawTop <= rawStart/)
  assert.match(source, /page < 1000/)
})

test('THE PAGE COUNT CANNOT DEPEND ON THE SIZE OF THE WINDOW', () => {
  /*
   * A sheet with `max-width: 100%` shrinks to fit a narrow window, and a
   * narrower text column wraps the same essay into more lines -- so the same
   * draft would report a different number of pages on a laptop and on a phone,
   * and neither would be the number the school sees.
   *
   * The column is 6.5in wide, always, and the surface scrolls instead.
   */
  const source = editorSource()
  const sheet = cssRule(source, '.statement-page-sheet')
  assert.match(sheet, /width: var\(--page-width\)/)
  assert.equal(sheet.includes('max-width'), false,
    'the sheet must not shrink to fit the viewport')
  assert.match(cssRule(source, '.statement-page-surface'), /overflow-x: auto/)
})

test('NO BACKTICK SURVIVES INSIDE THE STYLESHEET', () => {
  /*
   * The stylesheet is a template literal, so a backtick anywhere inside it --
   * including in a comment quoting a CSS property name -- ends the literal and
   * the file stops parsing. It has happened twice. This is the guard.
   */
  const source = readFileSync(
    'app/statement-studio/components/PaginatedEditor.tsx', 'utf8')
  const start = source.indexOf('<style>{`')
  assert.notEqual(start, -1, 'the stylesheet literal moved')
  const end = source.indexOf('`}</style>', start)
  assert.notEqual(end, -1, 'the stylesheet literal is unterminated')
  assert.equal(source.slice(start + 9, end).includes('`'), false)
})
