/**
 * D48 - deterministic grading-legend parsing.
 *
 * A printed legend row already says exactly what it means:
 *
 *   C+ | - Intermediate grade | 2.50
 *
 * Nothing about turning that into C+ -> 2.50 needs a language model, and asking
 * one to do it made the result depend on whether it transcribed past the third
 * row. This module reads the pairs straight out of the reconstructed text, so
 * the numbers are the same on every run.
 *
 * What it deliberately does NOT do (D38-D40 are unchanged):
 *   - it never infers a value from neighbouring symbols
 *   - it never computes a missing value
 *   - it never merges two printed tables that share symbols
 *   - it never decides WHICH table applies; that judgement stays with the
 *     analyzer, which reads the document's own applicability wording
 */

import type { ExtractionResult } from './extract.ts'
import { anchorFromLine } from './anchors.ts'

export interface LegendPair {
  symbol: string
  points: number
  /** The reconstructed row this pair was read from, verbatim. */
  row: string
}

export interface LegendTable {
  /** Stable within one document: page, region and order of appearance. */
  id: string
  /** Heading printed above the table, when the document prints one. */
  caption: string | null
  page: number
  points: Record<string, number>
  pairs: LegendPair[]
  /** Verbatim rows, for the evidence the scale carries downstream. */
  evidence: string[]
}

/** Grade points live in this range on every scale we accept (D41). */
const MIN_POINTS = 0
const MAX_POINTS = 5

/**
 * A grade symbol. Letters, optionally with a sign or a second letter, so a
 * school printing "S", "H", "EX" or "A1" is supported. No fixed vocabulary and
 * no maximum number of symbols per table.
 */
const SYMBOL = '[A-Z]{1,3}[+-]?'

/**
 * One "symbol ... value" pair on a row. The gap may hold a description
 * ("- Intermediate grade") and separators, but not another symbol or number,
 * so a value can never be captured across a neighbouring pair.
 *
 * Grade points are printed to exactly two decimals ("2.50"). Credit values are
 * not ("4.0", "3.000"), which keeps a coursework row from posing as a legend.
 */
const PAIR_RE = new RegExp(
  `(?:^|[|\\s])(${SYMBOL})\\s*\\|?\\s*(?:[-–—]\\s*)?` +
  `(?:[A-Za-z][A-Za-z ()/&.,'’-]{0,40})?\\s*\\|?\\s*` +
  `([0-5]\\.\\d{2})(?![\\d])`,
  'g',
)

/** Rows that carry numbers but are totals or metadata, never legend pairs. */
const NOT_A_LEGEND_ROW = [
  /\bEhrs\b|\bQPts\b|\bGPA-?Hrs\b|\bGPA:\s*\d/i,
  /\bTERM\s+AVG\b|\bCUMULATIVE\b|\bDEGREE\s+CREDITS\b|\bTOTAL\b/i,
  /^-{3}\s*COLUMN|^={3}\s*PAGE/i,
]

/** Reads every grade/point pair printed on one row. */
export function pairsFromRow(row: string): LegendPair[] {
  const text = String(row ?? '')
  for (const re of NOT_A_LEGEND_ROW) if (re.test(text)) return []
  // A row that reads as a course row IS a course row. Reusing the anchor
  // detector keeps one definition of "this is coursework" in the codebase.
  if (anchorFromLine(text, 0, 0)) return []
  const out: LegendPair[] = []
  const seen = new Set<string>()
  PAIR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PAIR_RE.exec(text))) {
    const symbol = m[1].toUpperCase().trim()
    const points = Number(m[2])
    if (!Number.isFinite(points) || points < MIN_POINTS || points > MAX_POINTS) continue
    // A symbol printed twice on one row is a layout artefact, not two grades.
    if (seen.has(symbol)) continue
    seen.add(symbol)
    out.push({ symbol, points, row: text })
  }
  return out
}

/** A line that introduces a table rather than belonging to one. */
function isCaption(line: string): boolean {
  const s = line.trim()
  if (s.length < 3 || s.length > 200) return false
  return /[A-Za-z]{3}/.test(s)
}

/**
 * "Grade Points" is the table's own column header, not its heading. The
 * heading a reader would use ("A. Standard (Exception: ...)") sits above it,
 * sometimes wrapped over two lines, so a short buffer is kept and the header
 * rows are skipped.
 */
function isColumnHeader(line: string): boolean {
  return /grade\s*\|?\s*points?/i.test(line)
}

/**
 * Splits a document into candidate grading tables.
 *
 * A table is a run of rows carrying pairs. A non-pair line between runs ends
 * the current table and becomes the next one's caption, which is how five
 * tables printed down one legend page stay five tables. Two tables are NEVER
 * merged, even when they share symbols, because sharing a symbol at different
 * values is exactly what distinguishes them.
 */
export function detectLegendTables(result: ExtractionResult): LegendTable[] {
  const tables: LegendTable[] = []

  for (const page of result.pages) {
    // The unsplit view: a legend is frequently a two-up table, and the column
    // split that separates coursework would take a value away from its symbol.
    const lines = page.flatLines?.length ? page.flatLines : page.lines
    let current: LegendTable | null = null
    let recent: string[] = []

    const close = () => {
      if (current && current.pairs.length > 0) tables.push(current)
      current = null
    }

    for (const line of lines) {
      const pairs = pairsFromRow(line)
      if (pairs.length === 0) {
        close()
        if (isColumnHeader(line)) continue     // the table's own column header
        if (isCaption(line)) { recent.push(line.trim()); if (recent.length > 2) recent.shift() }
        continue
      }
      if (!current) {
        current = {
          id: `p${page.page}t${tables.length + 1}`,
          caption: recent.length ? recent.join(' ') : null,
          page: page.page,
          points: {},
          pairs: [],
          evidence: [],
        }
        recent = []
      }
      for (const pair of pairs) {
        // First reading wins inside one table; a repeat is a wrapped row.
        if (!(pair.symbol in current.points)) {
          current.points[pair.symbol] = pair.points
          current.pairs.push(pair)
        }
      }
      current.evidence.push(line.trim())
    }
    close()
  }

  return tables
}

/** Tables too small to be a grading scale are noise, not candidates. */
const MIN_PAIRS = 3

/** Candidates worth offering to the applicability step. */
export function legendCandidates(result: ExtractionResult): LegendTable[] {
  return detectLegendTables(result).filter(t => t.pairs.length >= MIN_PAIRS)
}

/**
 * Renders the candidates for the analyzer.
 *
 * The analyzer is asked which table applies -- never to retype the numbers, so
 * its answer cannot change a value the document printed.
 */
export function describeCandidates(tables: readonly LegendTable[]): string {
  if (tables.length === 0) return ''
  return tables.map(t => {
    const points = Object.entries(t.points)
      .sort((a, b) => b[1] - a[1])
      .map(([g, p]) => `${g}=${p.toFixed(2)}`)
      .join(', ')
    return `- id "${t.id}" (page ${t.page})`
      + `\n  heading: ${t.caption ?? '(none printed)'}`
      + `\n  grades: ${points}`
  }).join('\n')
}

/** Looks a candidate up by the id the analyzer returned. */
export function candidateById(
  tables: readonly LegendTable[],
  id: unknown,
): LegendTable | null {
  const key = String(id ?? '').trim()
  if (!key) return null
  return tables.find(t => t.id === key) ?? null
}
