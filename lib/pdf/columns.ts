/**
 * D45 - page-level column detection.
 *
 * Decided per page, never per document: a transcript routinely mixes a
 * two-column coursework page, a single-column grading key, and a partial
 * continuation page. Applying one layout to all of them is how term headings
 * end up attached to the wrong coursework.
 *
 * No single signal is trusted. Geometry alone provably cannot separate these
 * documents -- Montclair's real gutter is about 4pt wide while the single-column
 * fixtures have 32-55pt of clear space between table fields, so any
 * whitespace-width threshold that splits Montclair also splits pages that must
 * not be split. The document's own structural markers break that tie.
 */

/** One text item, already projected into the page's dominant reading frame. */
export interface PlacedItem {
  /** Position along the baseline (increases in reading direction). */
  along: number
  /** Position across the baseline (increases towards the top of the text). */
  across: number
  /** Advance width along the baseline. */
  width: number
  text: string
}

export type ColumnConfidence = 'two-column' | 'single-column' | 'ambiguous'

export interface ColumnLayout {
  confidence: ColumnConfidence
  /** Split position along the baseline. Only set for 'two-column'. */
  gutter?: number
  /** Which signals fired, for the record and for tests. */
  signals: string[]
}

/** Rows closer than this across the baseline are the same physical line. */
const ROW_TOLERANCE = 2.5
/** A gutter must be at least this wide to be considered on geometry alone. */
const MIN_GUTTER = 20
/** Each side must hold at least this share of the page's items. */
const MIN_BALANCE = 0.25
/** ...and at least this many rows, so a sparse page cannot fake a gutter. */
const MIN_ROWS_PER_SIDE = 8
/** Two proposed gutters further apart than this disagree. */
const GUTTER_AGREEMENT = 40

function groupRows(items: readonly PlacedItem[]): PlacedItem[][] {
  const rows: { key: number; items: PlacedItem[] }[] = []
  for (const it of items) {
    let row = rows.find(r => Math.abs(r.key - it.across) <= ROW_TOLERANCE)
    if (!row) { row = { key: it.across, items: [] }; rows.push(row) }
    row.items.push(it)
  }
  for (const r of rows) r.items.sort((a, b) => a.along - b.along)
  return rows.sort((a, b) => b.key - a.key).map(r => r.items)
}

/**
 * Signal 1 - a row whose text repeats itself. A table header is printed once
 * per row; a page with two parallel regions prints it twice.
 *
 * The comparison is on TEXT, not on item boundaries: a PDF encoder may emit
 * "SUP SEC" as one run in one column and "SUP", "SEC" as two in the other, so
 * comparing item arrays misses a header that is plainly repeated.
 */
const MIN_HEADER_LETTERS = 12
/** A repeated column CAPTION is shorter than a whole header row. */
const MIN_CAPTION_LETTERS = 10

function normalizeRun(parts: readonly string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim().toUpperCase()
}

function repeatedHeaderGutter(rows: readonly PlacedItem[][]): number | null {
  // Whole-row repeat: the entire header is printed twice.
  for (const row of rows) {
    if (row.length < 4) continue
    const texts = row.map(i => i.text.trim())
    for (let k = 1; k < row.length; k++) {
      const left = normalizeRun(texts.slice(0, k))
      const right = normalizeRun(texts.slice(k))
      if (left !== right) continue
      // Guard against a row that is merely one short token twice.
      const letters = left.replace(/[^A-Z]/g, '').length
      if (letters < MIN_HEADER_LETTERS) continue
      return row[k].along
    }
  }

  // Partial repeat: the row OPENS with a caption that reappears later, with
  // unrelated content after it. A legend page prints "Grade Points ... Grade
  // Points ... <credit-prefix key>" -- three regions on one physical line, so
  // the header repeats without the whole row being a mirror of itself.
  for (const row of rows) {
    if (row.length < 4) continue
    const texts = row.map(i => i.text.trim())
    const width = row[row.length - 1].along - row[0].along
    if (width <= 0) continue
    for (let k = Math.min(6, row.length - 1); k >= 1; k--) {
      const caption = normalizeRun(texts.slice(0, k))
      if (caption.replace(/[^A-Z]/g, '').length < MIN_CAPTION_LETTERS) continue
      for (let j = k; j + k <= row.length; j++) {
        if (normalizeRun(texts.slice(j, j + k)) !== caption) continue
        // The repeat must start well into the row, not right beside the first.
        if (row[j].along - row[0].along < width * 0.25) continue
        return row[j].along
      }
    }
  }
  return null
}

/**
 * Signal 1b - the same header printed twice on the page at two different
 * horizontal positions, on DIFFERENT rows.
 *
 * Signal 1 only sees a header that repeats within one row, which assumes the
 * two regions start at the same height. Real transcripts stagger them: one
 * document prints its left header 11pt below the right one, so the two
 * "COURSE TITLE CR GR PTS" runs never share a row and the page read as a
 * single stream -- interleaving the two columns line by line and handing every
 * right-column course the left column's term heading.
 *
 * A table header printed once per region is still the document stating its own
 * shape; vertical alignment was never what made that true. The letter minimum
 * keeps short captions ("Grade Points") out, and both sides must carry real
 * rows, so a label that merely appears twice cannot split a page.
 */
function staggeredHeaderGutter(rows: readonly PlacedItem[][]): number | null {
  /** Every contiguous run of items on the page, by text, with its start x. */
  const seen = new Map<string, { along: number; row: number }[]>()
  const MAX_RUN = 8

  rows.forEach((row, rowIndex) => {
    const texts = row.map(i => i.text.trim())
    for (let j = 0; j < row.length; j++) {
      for (let k = 3; k <= MAX_RUN && j + k <= row.length; k++) {
        const run = normalizeRun(texts.slice(j, j + k))
        if (run.replace(/[^A-Z]/g, '').length < MIN_HEADER_LETTERS) continue
        const at = seen.get(run) ?? []
        at.push({ along: row[j].along, row: rowIndex })
        seen.set(run, at)
      }
    }
  })

  let bestGutter: number | null = null
  for (const [, at] of seen) {
    if (at.length < 2) continue
    // Two clearly separated horizontal positions, not the same one twice.
    const left = Math.min(...at.map(a => a.along))
    const right = Math.max(...at.map(a => a.along))
    if (right - left < MIN_GUTTER) continue
    // ...printed on more than one row, which is what signal 1 cannot see.
    if (new Set(at.map(a => a.row)).size < 2) continue

    const rowsLeft = rows.filter(r => r.some(i => i.along < right)).length
    const rowsRight = rows.filter(r => r.some(i => i.along >= right)).length
    if (rowsLeft < MIN_ROWS_PER_SIDE || rowsRight < MIN_ROWS_PER_SIDE) continue

    // The leftmost such boundary: an inner header run repeating further right
    // would cut through the second region rather than between the two.
    if (bestGutter === null || right < bestGutter) bestGutter = right
  }
  return bestGutter
}

/**
 * Signal 2 - a row carrying two continuation notices. A page that says
 * "continued on next column" beside "continued on page 2" is telling you, in
 * words, that it has two independent flows.
 */
function continuationGutter(rows: readonly PlacedItem[][]): number | null {
  const RE = /continued|continues/i
  for (const row of rows) {
    const marks = row.filter(i => RE.test(i.text))
    if (marks.length < 2) continue
    const first = marks[0], last = marks[marks.length - 1]
    if (last.along - (first.along + first.width) < 4) continue
    // The second notice marks where the second column BEGINS. Using the middle
    // of the gap instead put the cut tens of points to the left of the real
    // boundary, which then disagreed with the repeated-header signal on the
    // very same document.
    return last.along
  }
  return null
}

/**
 * Signal 3 - a wide band that no text crosses at all, with real content and
 * enough rows on both sides. Rules and banners are counted here on purpose:
 * a band a horizontal rule crosses is not a reliable gutter by geometry alone.
 */
function whitespaceGutter(
  items: readonly PlacedItem[],
  rows: readonly PlacedItem[][],
  /** When set, only bands ending at or before this are considered. */
  limit?: number,
): number | null {
  if (items.length < 40) return null
  const min = Math.min(...items.map(i => i.along))
  const max = Math.max(...items.map(i => i.along + i.width))
  const span = max - min
  if (span <= 0) return null

  const n = Math.ceil(span) + 1
  const crossed = new Uint8Array(n)
  for (const it of items) {
    const a = Math.max(0, Math.ceil(it.along - min))
    const b = Math.min(n - 1, Math.floor(it.along + it.width - min))
    for (let k = a; k <= b; k++) crossed[k] = 1
  }

  const lo = Math.floor(n * 0.25)
  const hi = limit === undefined
    ? Math.floor(n * 0.75)
    : Math.min(n - 1, Math.ceil(limit - min))
  let best = { start: -1, end: -1, len: 0 }
  let s = -1
  for (let k = lo; k <= hi; k++) {
    if (!crossed[k]) { if (s < 0) s = k }
    else { if (s >= 0 && k - s > best.len) best = { start: s, end: k, len: k - s }; s = -1 }
  }
  if (s >= 0 && hi - s > best.len) best = { start: s, end: hi, len: hi - s }
  if (best.len < MIN_GUTTER) return null

  // The RIGHT edge of the clear band is where the next column begins. The
  // midpoint sits a column-width to the left of the real boundary, which made
  // this signal disagree with the structural ones on the same page.
  const cut = min + best.end
  const left = items.filter(i => i.along + i.width <= cut).length
  const right = items.filter(i => i.along >= cut).length
  const total = left + right
  if (total === 0) return null
  if (Math.min(left, right) / total < MIN_BALANCE) return null

  const rowsLeft = rows.filter(r => r.some(i => i.along + i.width <= cut)).length
  const rowsRight = rows.filter(r => r.some(i => i.along >= cut)).length
  if (rowsLeft < MIN_ROWS_PER_SIDE || rowsRight < MIN_ROWS_PER_SIDE) return null

  return cut
}

/**
 * Decides one page's layout.
 *
 * Structural signals (a repeated header, paired continuation notices) are
 * strong on their own because they are the document stating its own shape.
 * Geometry is only trusted when it is unambiguous. When signals disagree the
 * page is reported ambiguous and is NOT split -- an unresolved state that D44
 * reconciliation can catch beats silently corrupting term attribution.
 */
export function detectColumns(items: readonly PlacedItem[]): ColumnLayout {
  const content = items.filter(i => i.text && i.text.trim())
  if (content.length < 25) return { confidence: 'single-column', signals: [] }

  const rows = groupRows(content)
  const signals: string[] = []
  const proposals: number[] = []

  const header = repeatedHeaderGutter(rows) ?? staggeredHeaderGutter(rows)
  if (header !== null) { signals.push('repeated-header'); proposals.push(header) }

  const cont = continuationGutter(rows)
  if (cont !== null) { signals.push('paired-continuation'); proposals.push(cont) }

  const gap = whitespaceGutter(content, rows)
  if (gap !== null) { signals.push('whitespace-gutter'); proposals.push(gap) }

  if (proposals.length === 0) return { confidence: 'single-column', signals }

  // Structural evidence is the document describing its own shape, so it
  // decides. Geometry corroborates but must never veto: a real gutter is often
  // narrower than the header's own indent, because rows elsewhere on the page
  // reach into the space between the columns.
  const structural: number[] = []
  if (signals.includes('repeated-header') && header !== null) structural.push(header)
  if (signals.includes('paired-continuation') && cont !== null) structural.push(cont)

  if (structural.length === 0) {
    // Geometry alone is exactly the case that misfires on wide-field
    // single-column tables, so it never splits a page by itself.
    return { confidence: 'ambiguous', signals }
  }
  if (Math.max(...structural) - Math.min(...structural) > GUTTER_AGREEMENT) {
    // Two structural signals pointing at different places is not one gutter.
    return { confidence: 'ambiguous', signals }
  }

  const claimed = structural.reduce((a, b) => a + b, 0) / structural.length

  // Structure proves the page has two regions; geometry places the boundary.
  // A header label is not always flush with the text beneath it -- on one real
  // transcript the second column's "TITLE" sits ~68pt right of where its course
  // titles actually begin, so cutting at the label sliced every row in half.
  // The widest clear band at or left of the claimed position is the real edge.
  const refined = whitespaceGutter(content, rows, claimed)
  const gutter = refined !== null && refined <= claimed ? refined : claimed
  return { confidence: 'two-column', gutter, signals }
}
