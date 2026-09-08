/**
 * D47 - a deterministic inventory of course-like rows in the document.
 *
 * This layer exists because agreement between two AI generations is not proof
 * of anything: two runs that both silently drop the same eleven transfer rows
 * agree perfectly and are both wrong. An anchor is derived from the
 * reconstructed page geometry alone, so it is the same on every run and can be
 * used to ask a much better question than "did the model agree with itself" --
 * namely "did the model account for the rows the document actually prints".
 *
 * It deliberately knows nothing about GPA inclusion, categories, transfer or
 * retake policy, or grading scales. It only recognises the SHAPE of a course
 * row, and it is conservative: a line it is unsure about produces no anchor,
 * because a false anchor would demand coursework that does not exist.
 */

import type { ExtractionResult } from './extract.ts'

export interface CourseAnchor {
  /** Catalog number as printed, e.g. "BIOL 244", "77 705 229", "TR T77 AP1". */
  code: string
  /** Course title as printed. */
  title: string
  /** Credit value as printed. */
  credits: number
  /** Grade token, only when one is physically on the row. */
  grade?: string
  page: number
  /** Which reading stream the row sits in, when the page has more than one. */
  region: number
  /** Stable, normalized identity used for matching. */
  key: string
}

/** Lines that are structure, metadata or summary -- never coursework. */
const NON_COURSE = [
  /^-{3}\s*COLUMN/i, /^={3}\s*PAGE/i,
  /\bEhrs\b|\bQPts\b|\bGPA-?Hrs\b/i,
  /\bTERM\s+AVG\b|\bCUMULATIVE\s+AVG\b|\bCUM\s+GPA\b/i,
  /\bDEGREE\s+CREDITS\s+EARNED\b|\bTOTAL\s+(TRANSFER\s+)?CREDITS?\b|\bTRANSCRIPT\s+TOTALS\b/i,
  /\bCONTINUED\b|\bcontinues\b/i,
  /\bSUBJ\b.*\bCOURSE\s+TITLE\b|\bCOURSE\s+TITLE\b.*\bCRED\b|\bTITLE\b.*\bSCH\s+DEPT\b/i,
  /^\s*(Grade\s+Points|SUBJ|TITLE|PTS)\s*(\|.*)?$/i,
  /\bEXPLANATION\s+OF\s+GRADING\b|\bGRADING\s+SYSTEM\b/i,
  // A grading-legend row: a symbol described in words, not a course.
  /-\s*(Distinguished|Intermediate grade|Satisfactory|Good|Poor|Failing|Incomplete|Honors)\b/i,
  /\bRECORD\s+OF:|\bSTUDENT\s+(ID|NUMBER)\b|\bD\.O\.B\b|\bRECORD\s+DATE\b|\bPAGE:\s*\d/i,
  /\bMAJOR:|\bCollege\s*:|\bDegree\s+Awarded\b|\bCurrent\s+Program\b|\bPrimary\s+Degree\b/i,
  /\bMaj\/Concentration\b|\bCourse\s+Level:|\bDean'?s\s+List\b|\bGeneral\s+Program\b/i,
  /\bINSTITUTION\s+CREDIT\b|\bTRANSFER\s+COURSES\b|\bInstitution\s+Information\b/i,
  /\bREGULATIONS\s+GOVERNING\b|\bCREDIT\s+HOUR\s+PREFIXES\b|\bGRADE\s+PREFIXES\b/i,
  /\bRequested\s+for\b|\bParchment\b|\bFamily\s+Educational\s+Rights\b/i,
  /^_+$/, /^\.+$/, /^\*+/,
]

/** Credits outside this are a page number, a year, or a total -- not a course. */
const MAX_CREDITS = 24

/** A catalog number: letters and digits together, short, not a bare number. */
function isCode(cell: string): boolean {
  const s = cell.trim()
  if (!s || s.length > 22) return false
  if (!/\d/.test(s)) return false
  const tokens = s.split(/\s+/)
  if (tokens.length > 4) return false
  if (!/[A-Za-z]/.test(s)) {
    // Purely numeric groups still qualify when printed as a catalog number,
    // e.g. "77 705 229", but a lone number never does.
    return tokens.length >= 3 && tokens.every(t => /^\d{2,4}$/.test(t))
  }
  return /^[A-Za-z0-9][A-Za-z0-9\s.\-&/]*$/.test(s)
}

function asCredits(cell: string): number | null {
  const s = cell.trim()
  if (!/^\d{1,2}(\.\d{1,3})?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CREDITS) return null
  // A decimal is the common form ("3.000"), but plenty of transcripts print a
  // bare integer. Integers are accepted only inside the range credits actually
  // occupy, which keeps section numbers, years and page numbers out; a large
  // value such as a 19-credit block still has to carry its decimal.
  if (s.includes('.')) return n
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null
}

function isTitle(cell: string): boolean {
  const s = cell.trim()
  return s.length >= 4 && (s.match(/[A-Za-z]/g)?.length ?? 0) >= 3 && !/^\d/.test(s)
}

/** Grade tokens as printed. Absence is normal and must not disqualify a row. */
const GRADE_RE = /^(A|B|C|D|F|WF|W|WD|P|S|CR|NC|TR|IN|INC|IP|AU|NR|H|PASS|NOCR|TNC)[+-]?$/i

/**
 * A credit value printed in the same cell as its grade: "3.0 A", "4.000 B-".
 *
 * Requiring a real grade token is what makes this unambiguous. "3.0 A" is a
 * credit column; no other column on a transcript is a number followed by a
 * grade.
 */
function fusedCredits(cell: string): { credits: number; grade: string } | null {
  const m = cell.trim().match(/^(\d{1,2}(?:\.\d{1,3})?)\s+([A-Za-z][A-Za-z+-]{0,3})$/)
  if (!m) return null
  const c = asCredits(m[1])
  if (c === null || !GRADE_RE.test(m[2])) return null
  return { credits: c, grade: m[2].toUpperCase() }
}

export function normalizeCode(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}
export function normalizeTitle(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

/** Identity used for matching. Formatting differences are absorbed; values are not. */
export function anchorKey(code: string, title: string, credits: number): string {
  return `${normalizeCode(code)}::${normalizeTitle(title)}::${credits.toFixed(2)}`
}

/**
 * Reads one reconstructed line. Returns an anchor only when the line carries a
 * catalog number, a credit value AND a title -- the shape shared by every
 * transcript row we have seen, and by none of the structural lines above.
 */
export function anchorFromLine(line: string, page: number, region: number): CourseAnchor | null {
  const text = line.trim()
  if (!text) return null
  if (NON_COURSE.some(re => re.test(text))) return recoverAfterMarker(text, page, region)

  const cells = text.split('|').map(c => c.trim()).filter(Boolean)
  if (cells.length < 2) return null

  let code: string | null = null
  let credits: number | null = null
  let title: string | null = null
  let grade: string | undefined

  // Which number on the row is the credit value? Transcripts print several --
  // a section number, credits, quality points -- so the column is identified by
  // what it sits next to, in this order:
  //
  //   1. Fused with its grade ("3.0 A"). Decisive, and necessary: on a
  //      transcript that prints a quality-points column the credits are often
  //      the ONLY number not standing alone, so reading the first bare decimal
  //      instead sized every graded row by its grade points -- a 3-credit
  //      course worth 12.00 points came out as 12 credits.
  //   2. Immediately before a standalone grade cell. Credits and grade are
  //      adjacent on every layout seen; quality points come after the grade.
  //   3. The first decimal in printed order, for rows with no grade at all.
  //   4. A bare integer, last, because a section number can imitate one but
  //      never carries a decimal point.
  for (const cell of cells) {
    const fused = fusedCredits(cell)
    if (fused) { credits = fused.credits; grade = fused.grade; break }
  }
  if (credits === null) {
    for (let i = 1; i < cells.length; i++) {
      if (!GRADE_RE.test(cells[i])) continue
      const c = asCredits(cells[i - 1])
      if (c === null) continue
      credits = c
      grade = cells[i].toUpperCase()
      break
    }
  }
  if (credits === null) {
    for (const cell of cells) {
      if (!cell.includes('.')) continue
      const c = asCredits(cell)
      if (c !== null) { credits = c; break }
    }
  }

  for (const cell of cells) {
    if (credits === null) { const c = asCredits(cell); if (c !== null) { credits = c; continue } }
    if (code === null && isCode(cell)) { code = cell; continue }
    if (title === null && isTitle(cell) && !isCode(cell)) { title = cell; continue }
    if (!grade && GRADE_RE.test(cell)) grade = cell.toUpperCase()
  }

  if (code === null || credits === null || title === null) return null
  return { code, title, credits, grade, page, region, key: anchorKey(code, title, credits) }
}

/**
 * A course row that shares its line with a structural marker.
 *
 * A page whose two columns were not separated can flatten a marker and a real
 * row together -- "******** CONTINUED ON NEXT COLUMN ******** | MAT 210 |
 * Applied Statistics | 3.0 A | 12.00" -- and rejecting the whole line silently
 * drops that course from the inventory, which is exactly the row an integrity
 * check would want to notice going missing.
 *
 * Nothing is invented: the leading segment must itself be structural, and what
 * remains has to clear the same bar as any other anchor -- a catalog number, a
 * title and a credit value, with no structural text of its own.
 */
function recoverAfterMarker(text: string, page: number, region: number): CourseAnchor | null {
  const parts = text.split('|')
  for (let i = 1; i <= parts.length - 3; i++) {
    const head = parts.slice(0, i).join('|')
    if (!NON_COURSE.some(re => re.test(head))) continue
    const rest = parts.slice(i).join('|').trim()
    if (!rest || NON_COURSE.some(re => re.test(rest))) continue
    return anchorFromLine(rest, page, region)
  }
  return null
}

/** The whole document's inventory, in reading order. */
export function courseAnchors(result: ExtractionResult): CourseAnchor[] {
  const out: CourseAnchor[] = []
  for (const page of result.pages) {
    let region = 0
    for (const line of page.lines) {
      if (/^-{3}\s*COLUMN\s+(\d+)/i.test(line)) {
        region = Number(line.match(/(\d+)/)?.[1] ?? 0)
        continue
      }
      const a = anchorFromLine(line, page.page, region)
      if (a) out.push(a)
    }
  }
  return out
}

/**
 * Same inventory, built from the structured payload string the analyzer is
 * given. The client holds that text, not the page objects, and both paths must
 * see exactly the same rows.
 */
export function courseAnchorsFromText(text: string): CourseAnchor[] {
  const out: CourseAnchor[] = []
  let page = 1, region = 0
  for (const line of String(text ?? '').split('\n')) {
    const pm = line.match(/^={3}\s*PAGE\s+(\d+)/i)
    if (pm) { page = Number(pm[1]); region = 0; continue }
    const cm = line.match(/^-{3}\s*COLUMN\s+(\d+)/i)
    if (cm) { region = Number(cm[1]); continue }
    const a = anchorFromLine(line, page, region)
    if (a) out.push(a)
  }
  return out
}

export interface AnchorMatch {
  anchors: CourseAnchor[]
  matched: CourseAnchor[]
  unmatched: CourseAnchor[]
  /** Extracted rows that matched no anchor. Not an error on its own. */
  unanchoredRows: number
}

export interface MatchableRow {
  courseCode?: string | null
  name?: string | null
  credits?: unknown
}

/**
 * Matches extracted rows back to the inventory.
 *
 * Matching is deterministic and conservative. Full identity (code + title +
 * credits) is tried first; a code+credits match is accepted next, because a
 * model may tidy a title; a title+credits match covers a row whose catalog
 * number was not transcribed. Title alone is never enough -- that would let one
 * row satisfy several anchors and hide a real omission.
 *
 * Each anchor can be satisfied only once, so a duplicated or invented row
 * cannot stand in for a missing one.
 */
export function matchAnchors(
  anchors: readonly CourseAnchor[],
  rows: readonly MatchableRow[],
): AnchorMatch {
  const remaining = new Set(anchors.map((_, i) => i))
  const used = new Set<number>()

  const tryPass = (test: (a: CourseAnchor, r: MatchableRow) => boolean) => {
    for (const i of [...remaining]) {
      const a = anchors[i]
      for (let j = 0; j < rows.length; j++) {
        if (used.has(j)) continue
        if (!test(a, rows[j])) continue
        used.add(j); remaining.delete(i); break
      }
    }
  }

  const cred = (r: MatchableRow) => {
    const n = typeof r.credits === 'number' ? r.credits : parseFloat(String(r.credits ?? ''))
    return Number.isFinite(n) ? Number(n.toFixed(2)) : null
  }
  const sameCredits = (a: CourseAnchor, r: MatchableRow) => cred(r) === Number(a.credits.toFixed(2))
  const sameCode = (a: CourseAnchor, r: MatchableRow) =>
    !!r.courseCode && normalizeCode(r.courseCode) === normalizeCode(a.code)
  const sameTitle = (a: CourseAnchor, r: MatchableRow) =>
    !!r.name && normalizeTitle(r.name) === normalizeTitle(a.title)

  tryPass((a, r) => sameCode(a, r) && sameTitle(a, r) && sameCredits(a, r))
  tryPass((a, r) => sameCode(a, r) && sameCredits(a, r))
  tryPass((a, r) => sameTitle(a, r) && sameCredits(a, r))

  const unmatched = [...remaining].map(i => anchors[i])
  return {
    anchors: [...anchors],
    matched: anchors.filter((_, i) => !remaining.has(i)),
    unmatched,
    unanchoredRows: rows.length - used.size,
  }
}
