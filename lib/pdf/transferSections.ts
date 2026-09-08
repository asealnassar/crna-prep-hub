/**
 * D51 - transfer-credit sections read from the document's own structure.
 *
 * A transcript states, in a heading, that everything beneath it is credit
 * accepted from another school. That is structure, and it is the same on every
 * run. Leaving the decision entirely to the model made it a coin flip for rows
 * whose only transfer marker was the heading itself: the same Lakeshore PDF
 * imported twice classified "NTR 150 Human Nutrition" and "PSY 230
 * Developmental Psychology" -- the two rows that print no grade at all -- as
 * ordinary coursework on one run and as transfer notation on the next.
 *
 * So the structure decides, and the model fills in the fields. The blank grade
 * is not evidence of anything here and is never treated as such: it is
 * preserved exactly as printed, and a row is converted because of where it
 * sits, not because of what it does or does not say.
 *
 * Nothing here is school-specific. A block starts at a heading that says it is
 * transfer credit, and ends at the first structural boundary the document
 * prints -- a totals line, an institution-credit heading, a term heading,
 * another block, a grading key, or the end of the page or column.
 */

import { anchorFromLine, normalizeCode, normalizeTitle } from './anchors.ts'

/** A heading that opens a transfer-credit region. */
const BLOCK_START = [
  /\bTRANSFER\s+CREDITS?\b(?!\s*:?\s*\d)/i,
  /\bTRANSFER\s+COURSES?\b/i,
  /\bTRANSFER\s+WORK\b/i,
  /\bCREDIT\s+ACCEPTED\s+FROM\b/i,
  /\bADVANCED\s+STANDING\s+CREDIT\b/i,
]

/**
 * The first line that ends it.
 *
 * All of these are the document announcing a different kind of content:
 * transfer totals, the school's own coursework, a term, a grading key, or the
 * transcript's summary. A page or column marker ends a block too, because a
 * reading stream that has ended cannot still be inside a section.
 */
/**
 * The section's own closing line: a transfer total. Reaching one proves the
 * transfer section was still open, which is also how a block is recognised as
 * having continued into a new column or page.
 */
const TRANSFER_END = [
  /\bTOTAL\s+TRANSFER\s+CREDITS?\b/i,
  /\bTOTAL\s+(TRANSFER\s+)?(CREDITS?|HOURS)\s+(ACCEPTED|EARNED|AWARDED)\b/i,
  /\bTRANSFER\s+(CREDITS?|HOURS)\s+(TOTAL|SUMMARY)\b/i,
]

/** A different kind of content beginning: the section has been left behind. */
const SECTION_END = [
  /\bTRANSCRIPT\s+TOTALS\b/i,
  /\bINSTITUTION(AL)?\s+(CREDIT|CREDITS|COURSEWORK|INFORMATION|RECORD)\b/i,
  /\b(ACADEMIC|INSTITUTIONAL)\s+(RECORD|COURSEWORK|HISTORY)\b/i,
  /\bDEGREE\s+CREDITS?\b/i,
  /\bGRADING\s+SYSTEM\b|\bEXPLANATION\s+OF\s+GRADING\b/i,
  /\bCUMULATIVE\b.*\b(GPA|AVG)\b/i,
  /\bEhrs\b|\bQPts\b|\bGPA-?Hrs\b/i,
  // A term heading that also names a school or college is the receiving
  // institution's own coursework beginning.
  /^\s*(FALL|SPRING|SUMMER|WINTER|AUTUMN)\s+(19|20)\d\d\s+\S.*[A-Za-z]{4}/i,
]

const BLOCK_END = [...TRANSFER_END, ...SECTION_END]

/** The document saying, in words, that a region carries on elsewhere. */
const CONTINUATION = /\bCONTINUED\b|\bcontinues\b/i

/**
 * A bare term heading is NOT an end boundary.
 *
 * One real transcript dates every accepted transfer row by the term it was
 * taken, printing "Spring 2017" inside the transfer block before its first
 * row. Treating a term as the end there closed the block before it held
 * anything. Terms organise rows; they do not say the section has changed.
 */

/**
 * The table's own header row, which is structure rather than coursework.
 *
 * Recognised by its column labels rather than by one fixed phrasing, because
 * transcripts word them differently -- "COURSE | TITLE | CR | GR | PTS" and
 * "TITLE | SCH DEPT CRS SUP SEC CRED PR GRADE" are the same thing. A line that
 * parses as a course row is never a header, whatever it says.
 */
const HEADER_LABEL =
  /\b(COURSE|SUBJ|SUBJECT|CATALOG|TITLE|DESCRIPTION|CRED|CREDIT|CREDITS|CR|HOURS|HRS|GRADE|GR|PTS|POINTS|DEPT|SEC|TERM)\b/gi

function isColumnHeader(line: string, page: number, region: number): boolean {
  if (!/\b(TITLE|COURSE|DESCRIPTION|SUBJ|SUBJECT)\b/i.test(line)) return false
  if (anchorFromLine(line, page, region)) return false
  const labels = new Set((line.toUpperCase().match(HEADER_LABEL) ?? []).map(x => x.trim()))
  return labels.size >= 3
}

export interface TransferBlockRow {
  code: string
  title: string
  credits: number
  /** As printed. A blank grade stays blank. */
  grade?: string
}

export interface TransferBlock {
  page: number
  region: number
  /** Heading text, verbatim. */
  heading: string
  /** The school named in the heading, when it names one. */
  originName: string | null
  rows: TransferBlockRow[]
}

/**
 * The school a heading says the credit came from.
 *
 * Only an explicit "from <name>" counts. A heading that merely says "TRANSFER
 * CREDIT" names nobody, and inventing an origin would be worse than leaving it
 * to the model.
 */
export function originFromHeading(heading: string): string | null {
  const m = heading.match(/\bFROM\b[:\s]+(.+)$/i)
  if (!m) return null
  const name = m[1]
    .replace(/\|.*$/, ' ')
    .replace(/\b(TOTAL|CREDITS?|ACCEPTED|EARNED)\b.*$/i, ' ')
    .replace(/[*_.:,\-\s]+$/, '')
    .trim()
  // Two characters is not a school name; neither is a bare number.
  return name.length >= 3 && /[A-Za-z]{3}/.test(name) ? name : null
}

const isTransferEnd = (line: string) => TRANSFER_END.some(re => re.test(line))
const isSectionEnd = (line: string) => SECTION_END.some(re => re.test(line))
const isEnd = (line: string) => BLOCK_END.some(re => re.test(line))
const isStart = (line: string) =>
  BLOCK_START.some(re => re.test(line)) && !isEnd(line)

const normalizeHeader = (line: string) => line.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()

/** One reading stream: a page, or one column of a page. */
interface Segment {
  page: number
  region: number
  lines: string[]
}

function segmentsOf(text: string): Segment[] {
  const out: Segment[] = []
  let current: Segment = { page: 1, region: 0, lines: [] }
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    const pm = line.match(/^={3}\s*PAGE\s+(\d+)/i)
    if (pm) { out.push(current); current = { page: Number(pm[1]), region: 0, lines: [] }; continue }
    const cm = line.match(/^-{3}\s*COLUMN\s+(\d+)/i)
    if (cm) { out.push(current); current = { page: current.page, region: Number(cm[1]), lines: [] }; continue }
    if (line) current.lines.push(line)
  }
  out.push(current)
  return out.filter(seg => seg.lines.length > 0)
}

/**
 * Does an open block carry on into this new reading stream?
 *
 * A column or page break is a break in the TEXT, not necessarily in the
 * section: one real transcript prints its transfer table across both columns
 * of a page, so treating the break as the end left its last transfer row --
 * and only that row -- to the model. But context is not propagated blindly
 * either. The evidence has to be positive, and it has to appear before the new
 * stream's first course row:
 *
 *   - the transfer table's own header, printed again, or
 *   - a continuation notice, or
 *   - the section's own closing total, which could not be here unless the
 *     section was still open when the stream began.
 *
 * A competing section heading, or the start of a different transfer block,
 * answers no. So does silence: a stream that simply opens with coursework
 * inherits nothing.
 */
function resumesBlock(seg: Segment, header: string | null): boolean {
  for (const line of seg.lines) {
    if (isColumnHeader(line, seg.page, seg.region)) {
      if (header && normalizeHeader(line) === header) return true
      continue
    }
    if (isStart(line)) return false
    if (isSectionEnd(line)) return false
    if (CONTINUATION.test(line)) return true
    if (isTransferEnd(line)) return true
    if (anchorFromLine(line, seg.page, seg.region)) return false
  }
  return false
}

/**
 * Every transfer-credit block the document prints, with the rows inside it.
 *
 * Reads the same reconstructed text the analyzer is given, so both see exactly
 * the same document.
 */
export function detectTransferBlocks(text: string): TransferBlock[] {
  const blocks: TransferBlock[] = []
  let open: TransferBlock | null = null
  let openHeader: string | null = null
  /** An open block whose reading stream ended, awaiting evidence it carries on. */
  let suspended: { block: TransferBlock; header: string | null } | null = null

  const finish = (b: TransferBlock | null) => { if (b && b.rows.length > 0) blocks.push(b) }

  for (const seg of segmentsOf(text)) {
    if (suspended) {
      if (resumesBlock(seg, suspended.header)) {
        open = suspended.block
        openHeader = suspended.header
      } else {
        finish(suspended.block)
      }
      suspended = null
    }

    // The table's own header, remembered so a repeat of it in the next stream
    // is recognisable as the same table carrying on.
    let lastHeader: string | null = null

    for (const line of seg.lines) {
      if (isColumnHeader(line, seg.page, seg.region)) { lastHeader = normalizeHeader(line); continue }

      if (isStart(line)) {
        finish(open)
        open = {
          page: seg.page, region: seg.region, heading: line,
          originName: originFromHeading(line), rows: [],
        }
        openHeader = lastHeader
        continue
      }
      if (!open) continue
      if (isEnd(line)) { finish(open); open = null; openHeader = null; continue }

      // A course row is recognised the same way the anchor inventory
      // recognises one, so the two layers can never disagree about what a row
      // is. The grade plays no part: TR, a letter grade and a blank are all
      // preserved values, and none of them decides record type.
      const a = anchorFromLine(line, seg.page, seg.region)
      if (a) open.rows.push({ code: a.code, title: a.title, credits: a.credits, grade: a.grade })
    }

    if (open) { suspended = { block: open, header: openHeader }; open = null; openHeader = null }
  }

  if (suspended) finish(suspended.block)
  finish(open)
  return blocks
}


/** One row's identity for matching extracted output back to the document. */
const rowKey = (code: string, credits: number) =>
  `${normalizeCode(code)}::${Number(credits).toFixed(2)}`

export interface SectionCourse {
  courseCode?: string | null
  name?: string | null
  credits?: unknown
  recordType?: string
  transferredFromName?: string | null
  term?: string | null
  year?: string | null
}

export interface SectionResult<T> {
  courses: T[]
  /** Rows the structure reclassified, for the record. */
  converted: { code: string; title: string; from: string | null }[]
  /** Rows that were already notation and only gained an originating school. */
  originsFilled: number
}

/**
 * Applies transfer-section context to extracted rows.
 *
 * Explicit structure wins over the model's classification, but only where the
 * structure is explicit: a row is converted when the document places a row with
 * its catalog number and credits inside a transfer block. Every other field is
 * left exactly as extracted -- the grade above all, blank or not.
 *
 * Each row in a block can claim at most one extracted row, so a course that
 * legitimately appears both as accepted credit and as the school's own
 * coursework cannot have both copies converted. When more than one extracted
 * row could be the block's, the one that already looks like a notation is
 * preferred, then one carrying no term -- transfer rows sit outside the term
 * structure -- and only then document order.
 */
export function applyTransferSections<T extends SectionCourse>(
  courses: readonly T[], text: string,
): SectionResult<T> {
  const blocks = detectTransferBlocks(text)
  if (blocks.length === 0) {
    return { courses: [...courses], converted: [], originsFilled: 0 }
  }

  const claimed = new Set<number>()
  const decision = new Map<number, { origin: string | null }>()
  const converted: { code: string; title: string; from: string | null }[] = []

  for (const block of blocks) {
    for (const row of block.rows) {
      const key = rowKey(row.code, row.credits)
      const candidates: number[] = []
      courses.forEach((c, i) => {
        if (claimed.has(i)) return
        const credits = Number(c.credits)
        if (!Number.isFinite(credits)) return
        if (rowKey(String(c.courseCode ?? ''), credits) !== key) return
        candidates.push(i)
      })
      if (candidates.length === 0) continue

      const score = (i: number) => {
        const c = courses[i]
        let s = 0
        if (c.recordType === 'transfer_notation') s += 4
        if (!String(c.term ?? '').trim() && !String(c.year ?? '').trim()) s += 2
        if (normalizeTitle(String(c.name ?? '')) === normalizeTitle(row.title)) s += 1
        return s
      }
      const pick = candidates.reduce((a, b) => (score(b) > score(a) ? b : a))
      claimed.add(pick)
      decision.set(pick, { origin: block.originName })
      if (courses[pick].recordType !== 'transfer_notation') {
        converted.push({ code: row.code, title: row.title, from: block.originName })
      }
    }
  }

  let originsFilled = 0
  const out = courses.map((c, i) => {
    const d = decision.get(i)
    if (!d) return c
    const needsOrigin = d.origin !== null && !String(c.transferredFromName ?? '').trim()
    if (c.recordType === 'transfer_notation' && !needsOrigin) return c
    if (c.recordType === 'transfer_notation') originsFilled++
    return {
      ...c,
      recordType: 'transfer_notation',
      transferredFromName: needsOrigin ? d.origin : (c.transferredFromName ?? null),
    }
  })

  return { courses: out as T[], converted, originsFilled }
}
