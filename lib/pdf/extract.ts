/**
 * Structure-preserving PDF text extraction (D28 + D29).
 *
 * Replaces pdfreader/pdf2json, which failed outright on ReportLab-generated
 * PDFs with "bad XRef entry" while pdfjs-dist read the same files cleanly.
 *
 * Coordinates are used INTERNALLY to rebuild lines and reading order; the
 * caller receives clean text with page and line boundaries, never raw x/y.
 */

import { detectColumns, type ColumnLayout, type PlacedItem } from './columns.ts'

export interface ExtractedPage {
  page: number
  lines: string[]
  /** D45: how this page's layout was resolved. Diagnostic, not content. */
  layout?: ColumnLayout
  /**
   * The same page WITHOUT column splitting.
   *
   * D48: a grading legend is itself often a two-up table, so the page split
   * that correctly separates coursework regions also separates a grade from
   * the value printed beside it ("A | - Distinguished | 4.00 | F | - Failing"
   * loses F's 0.00 to the other region). Deterministic pair extraction reads
   * this view; the analyzer still receives `lines`.
   */
  flatLines: string[]
}
export interface ExtractionResult {
  numPages: number
  pages: ExtractedPage[]
  text: string
  totalLines: number
  /** True when the document has pages but no extractable text layer. */
  imageOnly: boolean
}

/** Same-line tolerance in PDF units. Tight enough not to merge adjacent rows. */
const Y_TOLERANCE = 2.5
/** A gap wider than this between items on one line becomes a column separator. */
const COLUMN_GAP = 12
/**
 * Below this gap two items are the same word. PDF producers routinely split a
 * word across text items ("Schoo" + "l"); joining those with a space produced
 * "Schoo l of Law", which no legend parser should have to cope with.
 */
const WORD_GAP = 0.6
/** Glyph angles within this many degrees of each other are the same run of text. */
const ANGLE_TOLERANCE = 1.5

/** Signed smallest difference between two angles in degrees, in [-180, 180]. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

/**
 * Reading-order coordinates for one text item, in the text's OWN frame.
 *
 * A PDF text matrix is [a, b, c, d, e, f]: (a, b) is the direction the text
 * advances in (the baseline), (c, d) is the direction "up" off that baseline,
 * and (e, f) is where the item sits. Projecting the position onto those two
 * vectors gives the two numbers reading order actually needs:
 *
 *   along  - increases the way the reader's eye travels along a line
 *   across - increases towards the TOP of the text, so descending sort = down
 *
 * This is why the earlier "swap x and y on rotated pages" approach was wrong:
 * it guessed at signs per-orientation, and the guess was inverted for 90deg,
 * which reversed both the order of the lines and the words inside them. The
 * projection needs no per-orientation special case and holds for any angle.
 */
function readingCoords(t: number[]): { along: number; across: number } | null {
  const [a, b, c, d, e, f] = t
  const wLen = Math.hypot(a, b)     // baseline direction magnitude
  const uLen = Math.hypot(c, d)     // up direction magnitude
  // Degenerate = the glyph has no size on an axis. NOT "a and d are zero":
  // for a pure 90-degree rotation the matrix is [0, s, -s, 0], so a and d
  // are legitimately zero and that test silently emptied every rotated page.
  if (wLen === 0 || uLen === 0) return null
  return {
    along: (e * a + f * b) / wLen,
    across: (e * c + f * d) / uLen,
  }
}

/** Rebuilds one reading stream's lines, top-to-bottom then left-to-right. */
function linesFrom(items: readonly PlacedItem[]): string[] {
  const rows = new Map<number, PlacedItem[]>()
  for (const it of items) {
    let key: number | null = null
    for (const k of rows.keys()) if (Math.abs(k - it.across) <= Y_TOLERANCE) { key = k; break }
    const rowKey = key ?? it.across
    if (key === null) rows.set(rowKey, [])
    rows.get(rowKey)!.push(it)
  }
  return [...rows.entries()]
    .sort((l, r) => r[0] - l[0])                    // top of page downwards
    .map(([, parts]) => {
      parts.sort((l, r) => l.along - r.along)
      let out = ''
      let prevEnd: number | null = null
      for (const part of parts) {
        const gap = prevEnd === null ? 0 : part.along - prevEnd
        if (prevEnd !== null && gap > COLUMN_GAP) out += ' | '
        else if (out && gap > WORD_GAP) out += ' '
        out += part.text
        prevEnd = part.along + part.width
      }
      return out.replace(/\s+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim()
    })
    .filter(Boolean)
}

export async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  // Dynamic import: pdfjs is heavy and only needed on this path.
  // pdfjs-dist ships CommonJS; under ESM the exports land on `.default`.
  const mod: any = await import('pdfjs-dist/legacy/build/pdf.js')
  const pdfjs: any = mod.getDocument ? mod : mod.default
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,      // do not evaluate embedded JS
    disableAutoFetch: true,
  }).promise

  const pages: ExtractedPage[] = []

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()

    // Watermarks are text drawn at an angle DIFFERENT from the body text --
    // not simply "text at an angle". A landscape page (page.rotate = 90, common
    // for a transcript's grading-legend page) has every item rotated, and an
    // absolute rotated-is-a-watermark rule silently discarded all of it.
    //
    // So: find the dominant text angle on this page and keep that, treating
    // only the outliers as decoration. No orientation is assumed -- a page set
    // at 17 degrees is handled the same way as one at 0 or 90.
    const angleOf = (t: number[]) => Math.atan2(t[1], t[0]) * 180 / Math.PI
    const angleCounts = new Map<number, number>()
    for (const item of content.items as any[]) {
      if (!item.str || !item.str.trim()) continue
      if (!readingCoords(item.transform)) continue
      const ang = Math.round(angleOf(item.transform))
      angleCounts.set(ang, (angleCounts.get(ang) ?? 0) + 1)
    }
    let dominant = 0, best = -1
    for (const [ang, n] of angleCounts) if (n > best) { best = n; dominant = ang }

    const placed: PlacedItem[] = []
    for (const item of content.items as any[]) {
      const s: string = item.str
      if (!s || !s.trim()) continue

      const coords = readingCoords(item.transform)
      if (!coords) continue
      // Rounded-degree buckets alone would split a run whose glyphs sit at
      // 89.98 and 90.01; compare against the dominant angle with tolerance.
      if (Math.abs(angleDelta(angleOf(item.transform), dominant)) > ANGLE_TOLERANCE) continue

      // pdfjs reports the advance width along the baseline in these same
      // units; it beats a per-character guess, which mis-sized every column
      // break on pages whose font differs from the body text.
      const width = Number.isFinite(item.width) && item.width > 0
        ? item.width
        : s.length * 4.5
      placed.push({ along: coords.along, across: coords.across, width, text: s })
    }

    // D45: two independent columns must not be merged just because they share
    // a y-coordinate. That is what attached Spring 2017's heading to the wrong
    // coursework and left five courses with no term at all.
    const layout = detectColumns(placed)
    let lines: string[]
    if (layout.confidence === 'two-column' && layout.gutter !== undefined) {
      const left = placed.filter(i => i.along + i.width / 2 < layout.gutter!)
      const right = placed.filter(i => i.along + i.width / 2 >= layout.gutter!)
      lines = [
        '--- COLUMN 1 ---', ...linesFrom(left),
        '--- COLUMN 2 ---', ...linesFrom(right),
      ]
    } else {
      lines = linesFrom(placed)
    }

    pages.push({ page: p, lines, layout, flatLines: linesFrom(placed) })
  }

  const totalLines = pages.reduce((n, pg) => n + pg.lines.length, 0)
  const text = pages
    .map(pg => `=== PAGE ${pg.page} ===\n\n${pg.lines.join('\n')}`)
    .join('\n\n')

  return {
    numPages: doc.numPages,
    pages,
    text,
    totalLines,
    imageOnly: doc.numPages > 0 && totalLines === 0,
  }
}
