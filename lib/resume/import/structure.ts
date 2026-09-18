/**
 * The shape of an imported document, read from its own lines.
 *
 * WHY THIS EXISTS. The organiser maps values, and a value counts only when it
 * traces verbatim into ONE extracted line. That rule is right about what it
 * checks -- whether a fact is in the document -- and wrong about how documents
 * are laid out. A summary wraps across four lines. A bullet wraps across two. A
 * PDF extractor emits a bullet's glyph as a line of its own, before or after the
 * sentence it belongs to. So a summary sitting under its own "Summary" heading,
 * and the bullets under a job the organiser plainly found, were set aside as
 * uncertain -- and then lost when the resume was created.
 *
 * THIS MODULE READS STRUCTURE; IT DOES NOT WRITE. Every value it produces is
 * source lines joined in order with their glyphs removed. It adds no word,
 * paraphrases nothing, and places text only where the document's own layout
 * puts it: under a heading, under a job the organiser anchored, or under a
 * degree.
 *
 * NOTHING IS LEFT BEHIND. Every line ends up placed, structural (a heading, a
 * glyph, a column marker), or recovered for the applicant to place themselves.
 *
 * Pure.
 */

import type { OrganisedResume } from './organise.ts'
import type { SourceDocument } from './source.ts'
import type { ResumeSectionType } from '../model/types.ts'

export type SectionKind =
  | 'summary' | 'experience' | 'education' | 'licensure' | 'certifications'
  | 'leadership' | 'volunteer' | 'awards' | 'publications' | 'research'
  | 'quality_improvement' | 'shadowing' | 'organizations' | 'skills' | 'other'

/** Whole-line section headings, normalised: lower case, "&" as "and", letters only. */
const HEADINGS: Readonly<Record<SectionKind, readonly string[]>> = {
  summary: [
    'summary', 'professional summary', 'career summary', 'clinical summary',
    'summary of qualifications', 'profile', 'professional profile',
    'objective', 'career objective', 'professional objective',
  ],
  experience: [
    'experience', 'professional experience', 'work experience', 'clinical experience',
    'nursing experience', 'critical care experience', 'icu experience', 'other clinical experience',
    'relevant experience', 'employment', 'employment history', 'work history', 'professional history',
  ],
  education: ['education', 'education and training', 'academic background', 'academic history'],
  licensure: ['licensure', 'license', 'licenses', 'licensure information'],
  certifications: [
    'certifications', 'certification', 'credentials', 'licenses and certifications',
    'licensure and certifications', 'certifications and licenses', 'certifications and licensure',
  ],
  leadership: [
    'leadership', 'leadership experience', 'leadership and precepting',
    'committee', 'committees', 'committee involvement', 'committee membership', 'committee memberships',
  ],
  volunteer: [
    'volunteer', 'volunteering', 'volunteer experience', 'volunteer work', 'community service',
    'volunteer and community service',
  ],
  awards: ['awards', 'honors', 'awards and honors', 'honors and awards'],
  publications: ['publications', 'presentations', 'publications and presentations'],
  research: ['research', 'research experience'],
  quality_improvement: ['quality improvement', 'quality improvement projects', 'projects', 'evidence based practice'],
  shadowing: [
    'shadowing', 'crna shadowing', 'shadowing experience', 'clinical shadowing',
    'shadow experience', 'crna shadow experience',
  ],
  organizations: [
    'professional organizations', 'professional memberships', 'memberships', 'affiliations',
    'professional affiliations',
  ],
  skills: ['skills', 'clinical skills', 'technical skills', 'core competencies'],
  other: ['references', 'interests', 'languages', 'activities', 'additional information'],
}

const HEADING_LOOKUP = new Map<string, SectionKind>(
  (Object.entries(HEADINGS) as [SectionKind, readonly string[]][])
    .flatMap(([kind, phrases]) => phrases.map((phrase) => [phrase, kind] as const))
)

/** Section kinds that correspond to a section an item can be placed into. */
const ENTRY_TYPE: Partial<Record<SectionKind, ResumeSectionType>> = {
  education: 'education', licensure: 'licensure', certifications: 'certifications',
  leadership: 'leadership', volunteer: 'volunteer', awards: 'awards',
  publications: 'publications', research: 'research', quality_improvement: 'quality_improvement',
  shadowing: 'shadowing', organizations: 'organizations',
}

/** How many of the applicant's own characters a line must still hold to be worth keeping. */
const LEFTOVER_MIN = 3
/** A summary is a paragraph. Past this it is a section the heading merely started. */
const MAX_SUMMARY_LINES = 15
/** How far an entry's header may run above or below the line that named it. */
const MAX_HEADER_REACH = 2

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function headingKey(text: string): string {
  return text.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\((?:continued|cont\.?)\)|\bcontinued\b/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The section a line names, when the whole line is a known heading -- or
 * several known headings run together, "Committees/Leadership/Shadow
 * Experience". A combined heading covering different kinds of section is
 * 'other': structure, with no one section to suggest.
 */
export function headingKind(line: string): SectionKind | null {
  const whole = HEADING_LOOKUP.get(headingKey(line))
  if (whole) return whole
  const parts = line.split(/\s*(?:\/|&|\+|\||,|\band\b)\s*/i).map(headingKey).filter((part) => part !== '')
  if (parts.length < 2) return null
  const kinds = parts.map((part) => HEADING_LOOKUP.get(part))
  if (kinds.some((kind) => kind === undefined)) return null
  return kinds.every((kind) => kind === kinds[0]) ? kinds[0]! : 'other'
}

/**
 * A line set like a heading even though it is not one we know: short, upper
 * case, no digits, no sentence punctuation.
 *
 * Used only as a boundary -- it stops a job's bullets from running into
 * whatever the document started next. It is never placed on its own strength.
 */
export function looksLikeHeading(line: string): boolean {
  const text = line.trim()
  if (/[a-z]/.test(text) || /\d/.test(text) || /[.!?]$/.test(text)) return false
  const words = text.split(/\s+/).filter((word) => /[A-Z]/.test(word))
  if (words.length === 0 || words.length > 6) return false
  return words.some((word) => word.replace(/[^A-Z]/g, '').length >= 5)
}

/**
 * What extractors emit for a list bullet: the common glyphs, any other symbol
 * or arrow a template draws one with, and the private-use code points Word's
 * Symbol and Wingdings bullets come out as.
 */
const GLYPH_CLASS = '•●◦▪▫■□‣⁃∙·\\p{So}\\p{Co}\\u2190-\\u21FF'
/**
 * Only unmistakable bullets count at the END of a line. A trailing middle dot
 * is usually a separator, and a trailing symbol is usually the applicant's own
 * text -- "Impella®" keeps its mark.
 */
const TRAILING_GLYPH_CLASS = '•●◦▪▫■□‣⁃∙\\uF0B7\\uF0A7'

const GLYPH_CHAR = new RegExp(`[${GLYPH_CLASS}]`, 'u')
const SEPARATOR_ONLY = new RegExp(`^[\\s|*\\-–—${GLYPH_CLASS}]+$`, 'u')
const LEADING_GLYPH = new RegExp(`^(?:[${GLYPH_CLASS}*]|[\\-–—](?=\\s))\\s*(?:\\|\\s*)?`, 'u')
const TRAILING_GLYPH = new RegExp(`\\s*(?:\\|\\s*)?[${TRAILING_GLYPH_CLASS}]$`, 'u')

/** A line that is nothing but bullet glyphs, dashes or column separators. */
export function isSeparatorOnly(line: string): boolean {
  const text = line.trim()
  // Courier New's "o" is Word's second-level bullet, and alone on a line it is nothing else.
  return text === 'o' || SEPARATOR_ONLY.test(text)
}

function hasGlyph(line: string): boolean {
  return line.trim() === 'o' || GLYPH_CHAR.test(line)
}

/** The markers `extractPdf` writes when it splits a page into columns. */
export function isColumnMarker(line: string): boolean {
  return /^---\s*COLUMN\s+\d+\s*---$/.test(line.trim())
}

/**
 * A line with its bullet glyphs removed, and which side they were on.
 *
 * A glyph at the START belongs to this line's bullet. A glyph at the END is
 * treated like one on its own line after it -- see `segmentBullets`.
 */
export function stripGlyphs(line: string): { text: string; lead: boolean; trail: boolean } {
  let text = line.trim()
  let lead = false
  while (LEADING_GLYPH.test(text)) {
    text = text.replace(LEADING_GLYPH, '').trim()
    lead = true
  }
  let trail = false
  while (TRAILING_GLYPH.test(text)) {
    text = text.replace(TRAILING_GLYPH, '').trim()
    trail = true
  }
  return { text: text.replace(/^\|\s*/, '').replace(/\s*\|$/, '').trim(), lead, trail }
}

/** Words a sentence cannot end on: a line ending in one is continued by the next. */
const CONNECTORS = new Set([
  'and', 'or', 'with', 'to', 'of', 'for', 'the', 'a', 'an', 'in', 'on', 'at', 'by', 'as',
  'including', 'via', 'per', 'from', 'into', 'over', 'under', 'within', 'between', 'during',
  'while', 'through', 'across', 'using', 'such', 'than', 'that', 'which', 'who', 'whose', '&',
])

/** The next line reads as the rest of this one: it starts in lower case, or this one stops mid-phrase. */
function continues(previous: string, next: string): boolean {
  if (/^[a-z]/.test(next)) return true
  if (/[,;:\-–—/&(+]$/.test(previous)) return true
  const last = /([A-Za-z&]+)[^A-Za-z&]*$/.exec(previous)?.[1]?.toLowerCase() ?? ''
  return CONNECTORS.has(last)
}

/** This line finished a sentence and the next begins one. */
function sentenceEnds(previous: string, next: string): boolean {
  return /[.!?]["'’”)\]]?$/.test(previous) && /^[A-Z0-9]/.test(next)
}

/**
 * Two wrapped lines as the one run of text they were.
 *
 * A space between them, except where a hyphenated word was broken at its
 * hyphen ("high-" then "acuity"), which rejoins as the word it is.
 */
export function joinWrapped(previous: string, next: string): string {
  if (/[A-Za-z]-$/.test(previous) && /^[a-z]/.test(next) && !/^(?:and|or|to)\b/.test(next)) {
    return previous + next
  }
  return `${previous} ${next}`
}

// ---------------------------------------------------------------------------
// Bullets
// ---------------------------------------------------------------------------

export interface BlockLine {
  readonly index: number
  readonly text: string
  /**
   * 'break' ends the bullet before it without becoming one (a dates line);
   * 'skip' is passed over entirely (a page header repeating the name).
   */
  readonly role?: 'text' | 'break' | 'skip'
}

export interface SegmentedBullet {
  readonly text: string
  /** Every source line the bullet was built from. */
  readonly lines: readonly number[]
}

/** What each reading of a line break costs. The cheapest reading wins; see `segmentBullets`. */
const COST = {
  /** A glyph that belongs to no bullet. */
  orphanGlyph: 3,
  /** A bullet with no glyph, in a block whose bullets have them. */
  bulletWithoutGlyph: 2,
  /** Joining two lines with nothing either way to say they belong together. */
  joinUnsupported: 1,
  /** Joining across a finished sentence. */
  joinAcrossSentence: 4,
  /** Splitting a line that plainly continues the one before. */
  splitContinuation: 4,
  /** Reading one glyph as before its sentence and the next as after, or the reverse. */
  switchSide: 1,
  /** Any join at all: when two readings tie, the one that merges nothing wins. */
  anyJoin: 0.001,
} as const

const BEFORE = 1
const AFTER = 2

/**
 * Lines under one job, as the bullets they are.
 *
 * WHERE A GLYPH LANDS IS NOT WHERE ITS BULLET STARTS. An extractor rebuilds
 * lines by height, so a glyph drawn a fraction off its sentence's baseline
 * becomes a line of its own -- above the sentence or below it, and below it
 * means BETWEEN the first line of a wrapped bullet and the rest. Reading every
 * glyph as a divider splits wrapped bullets; ignoring glyphs merges bullets.
 *
 * So each line break is read the way that explains the most evidence: every
 * glyph accounted to exactly one bullet, on a consistent side of its sentence,
 * with lines joined only where the text runs on (lower-case start, a line
 * ending mid-phrase) or where the glyph count says two lines are one bullet.
 * A glyph attached at a line's start always begins a bullet, a finished
 * sentence resists being joined to the next, and a tie never merges.
 *
 * Never an empty bullet, never a glyph in the text, and blocks with no glyphs
 * at all -- a Word document's paragraphs -- split on the text alone.
 */
export function segmentBullets(block: readonly BlockLine[]): SegmentedBullet[] {
  const rows: { index: number; text: string; lead: boolean }[] = []
  /** Loose glyphs between rows: gaps[k] sits just before rows[k]. */
  const gaps: number[] = [0]
  /** Rows that must begin a bullet whatever the glyphs say. */
  const breaks: boolean[] = [false]

  for (const line of block) {
    if (line.role === 'skip') continue
    const k = rows.length
    if (line.role === 'break' || isColumnMarker(line.text)) {
      breaks[k] = true
      continue
    }
    if (isSeparatorOnly(line.text)) {
      if (hasGlyph(line.text)) gaps[k] += 1
      else breaks[k] = true
      continue
    }
    const { text, lead, trail } = stripGlyphs(line.text)
    if (text === '') {
      gaps[k] += 1
      continue
    }
    rows.push({ index: line.index, text, lead })
    gaps[k + 1] = trail ? 1 : 0
    breaks[k + 1] = false
  }

  const m = rows.length
  if (m === 0) return []

  const glyphCount = gaps.reduce((sum, count) => sum + count, 0) + rows.filter((row) => row.lead).length
  const withoutGlyph = glyphCount > 0 ? COST.bulletWithoutGlyph : 0

  // State after each row: whether that row began a bullet still owed its glyph
  // ("open"), and the side of its sentence the last loose glyph was read on.
  type Cell = { cost: number; from: number; start: boolean }
  const stateOf = (open: boolean, side: number) => (open ? 3 : 0) + side
  const table: Cell[][] = rows.map(() =>
    Array.from({ length: 6 }, () => ({ cost: Infinity, from: -1, start: false })))
  const relax = (k: number, state: number, cost: number, from: number, start: boolean) => {
    if (cost < table[k][state].cost) table[k][state] = { cost, from, start }
  }
  const switchCost = (side: number, next: number) => (side !== 0 && side !== next ? COST.switchSide : 0)

  // The first row always begins a bullet.
  if (rows[0].lead) {
    relax(0, stateOf(false, 0), COST.orphanGlyph * gaps[0], -1, true)
  } else {
    if (gaps[0] >= 1) relax(0, stateOf(false, BEFORE), COST.orphanGlyph * (gaps[0] - 1), -1, true)
    relax(0, stateOf(true, 0), COST.orphanGlyph * gaps[0], -1, true)
  }

  for (let k = 1; k < m; k++) {
    const loose = gaps[k]
    const row = rows[k]
    const previous = rows[k - 1].text
    const runsOn = continues(previous, row.text)
    const hard = breaks[k] === true

    for (let state = 0; state < 6; state++) {
      const here = table[k - 1][state]
      if (here.cost === Infinity) continue
      const open = state >= 3
      const side = state % 3

      // This row begins a bullet. A loose glyph may go to the row before (read
      // as after its sentence) and another to this row (read as before it).
      const splitCost = runsOn && !row.lead && !hard ? COST.splitContinuation : 0
      for (const toPrevious of open && loose >= 1 ? [1, 0] : [0]) {
        for (const toThis of row.lead ? [0] : loose - toPrevious >= 1 ? [1, 0] : [0]) {
          let nextSide = side
          let cost = here.cost + splitCost
          if (toPrevious) {
            cost += switchCost(nextSide, AFTER)
            nextSide = AFTER
          } else if (open) {
            cost += withoutGlyph
          }
          if (toThis) {
            cost += switchCost(nextSide, BEFORE)
            nextSide = BEFORE
          }
          cost += COST.orphanGlyph * (loose - toPrevious - toThis)
          relax(k, stateOf(!row.lead && toThis === 0, nextSide), cost, state, true)
        }
      }

      // This row continues the bullet before it.
      if (row.lead || hard) continue
      const joinCost = COST.anyJoin + (runsOn
        ? 0
        : sentenceEnds(previous, row.text) ? COST.joinAcrossSentence : COST.joinUnsupported)
      for (const toPrevious of open && loose >= 1 ? [1, 0] : [0]) {
        let nextSide = side
        let cost = here.cost + joinCost
        if (toPrevious) {
          cost += switchCost(nextSide, AFTER)
          nextSide = AFTER
        } else if (open) {
          cost += withoutGlyph
        }
        cost += COST.orphanGlyph * (loose - toPrevious)
        relax(k, stateOf(false, nextSide), cost, state, false)
      }
    }
  }

  // Loose glyphs after the last row.
  let best = -1
  let bestCost = Infinity
  for (let state = 0; state < 6; state++) {
    const here = table[m - 1][state]
    if (here.cost === Infinity) continue
    const open = state >= 3
    const loose = gaps[m] ?? 0
    const toPrevious = open && loose >= 1 ? 1 : 0
    let cost = here.cost + COST.orphanGlyph * (loose - toPrevious)
    if (toPrevious) cost += switchCost(state % 3, AFTER)
    else if (open) cost += withoutGlyph
    if (cost < bestCost) {
      bestCost = cost
      best = state
    }
  }

  const starts: boolean[] = new Array(m).fill(false)
  for (let k = m - 1, state = best; k >= 0 && state >= 0; k--) {
    const cell = table[k][state]
    starts[k] = cell.start
    state = cell.from
  }
  starts[0] = true

  const out: { text: string; lines: number[] }[] = []
  rows.forEach((row, k) => {
    const current = out[out.length - 1]
    if (starts[k] || !current) out.push({ text: row.text, lines: [row.index] })
    else {
      current.text = joinWrapped(current.text, row.text)
      current.lines.push(row.index)
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// Dates and headers
// ---------------------------------------------------------------------------

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const DATE = `(?:${MONTH}\\s+)?(?:\\d{1,2}\\s*\\/\\s*)?(?:19|20)\\d{2}`
const RANGE = new RegExp(`${DATE}\\s*(?:-|–|—|to)\\s*(?:${DATE}|present|current|now)\\b`, 'i')
const RANGE_AT_END = new RegExp(`${RANGE.source}[\\s).\\],]*$`, 'i')
const DATE_TOKEN = new RegExp(`${RANGE.source}|${DATE}|\\b(?:present|current|now)\\b`, 'i')
const DATE_TOKENS = new RegExp(DATE_TOKEN.source, 'gi')

/** What a line holds besides its dates. */
function withoutDates(line: string): string {
  return line.replace(DATE_TOKENS, ' ').replace(/[^A-Za-z0-9]+/g, '')
}

/** A line that is only a date or a date range: part of an entry's header, never a bullet. */
export function isDateOnly(line: string): boolean {
  return DATE_TOKEN.test(line) && withoutDates(line) === ''
}

/** "Riverton, NJ" and nothing else: part of an entry's header, never a bullet. */
function isLocationOnly(line: string): boolean {
  return /^[A-Z][A-Za-z.'’ -]{1,40},\s*[A-Z]{2}(?:\s+\d{5})?$/.test(line.trim())
}

/** "Key accomplishments:" -- a label over bullets, not a bullet or part of one. */
function isLabelLine(line: string): boolean {
  const text = line.trim()
  return /^[A-Z][^.!?:]{0,40}:$/.test(text) && text.split(/\s+/).length <= 5
}

/** "Page 2 of 3": the page, not the resume. */
function isPageMarker(line: string): boolean {
  return /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(line.trim())
}

/**
 * A line that starts an entry of its own, whether or not the organiser
 * recognised it: a title with its dates at the end, a row the extractor split
 * at a wide gap ("Employer | City, ST"), or a name ending in its location.
 *
 * Bullets stop here. A job the organiser missed must not have its lines filed
 * under the job above it. A line of dates alone is not one: that is the rest
 * of a header, and stopping there would strand a job's bullets.
 */
export function looksLikeEntryHeader(line: string): boolean {
  const text = line.trim()
  if (/[.!?]$/.test(text) || withoutDates(text).length < LEFTOVER_MIN) return false
  const words = text.split(/\s+/).length
  if (words > 12) return false
  if (RANGE.test(text) && (RANGE_AT_END.test(text) || text.includes(' | '))) return true
  if (text.includes(' | ')) return true
  return words <= 10 && /,\s*[A-Z]{2}(?:\s+\d{5})?$/.test(text)
}

/**
 * A school's own name on a line -- "Lakeview County Community College" -- as
 * opposed to a part of one ("School of Nursing"). A GPA below it is that
 * school's, not the degree above's.
 */
function looksLikeInstitution(line: string): boolean {
  const text = line.trim()
  if (/[.!?]$/.test(text) || text.split(/\s+/).length > 10) return false
  if (/^(?:school|college|department|faculty|division|institute|center|centre) of\b/i.test(text)) return false
  return /\b(?:university|college|institute|school|academy|polytechnic)\b/i.test(text)
}

// ---------------------------------------------------------------------------
// GPA
// ---------------------------------------------------------------------------

const SCIENCE_WORDS = new Set(['science', 'sciences', 'sci'])
const OVERALL_WORDS = new Set(['overall', 'cumulative', 'cum', 'total', 'undergraduate', 'undergrad', 'final'])
/** Words that can sit before "GPA" without naming a different one. */
const NEUTRAL_WORDS = new Set(['with', 'a', 'an', 'of', 'and', 'the', 'my'])

const GPA_PATTERN =
  /\b([sc])?GPA\b(?:\s*\(\s*([A-Za-z ]{1,20})\s*\))?\s*(?:[:=]|-|–|\bof\b)?\s*(\d(?:\.\d{1,3})?(?:\s*\/\s*\d(?:\.\d{1,2})?)?)(?![\d.]*\d)/gi

export interface GpaMention {
  readonly kind: 'overall' | 'science' | null
  /** The number exactly as written: "3.3", "4.0", "3.5/4.0". */
  readonly raw: string
  /** The words that stated it, for accounting the line as placed. */
  readonly match: string
}

/** 'overall', 'science', null for a different GPA, undefined for a word that names none. */
function kindFromWord(word: string): 'overall' | 'science' | null | undefined {
  const key = word.toLowerCase()
  if (SCIENCE_WORDS.has(key)) return 'science'
  if (OVERALL_WORDS.has(key)) return 'overall'
  if (NEUTRAL_WORDS.has(key)) return undefined
  return null
}

/**
 * Every GPA a line states outright.
 *
 * Only a number written next to "GPA" counts, and only a science or an overall
 * GPA is placed. A nursing, major, prerequisite or any other named GPA is a
 * different figure, so it is left for the applicant rather than filed as the
 * wrong one.
 */
export function gpasIn(line: string): GpaMention[] {
  const out: GpaMention[] = []
  for (const match of line.matchAll(GPA_PATTERN)) {
    const at = match.index ?? 0
    let start = at
    let kind: 'overall' | 'science' | null = 'overall'

    if (match[1]) {
      kind = match[1].toLowerCase() === 's' ? 'science' : 'overall'
    } else if (match[2]) {
      const named = kindFromWord(match[2].trim().split(/\s+/)[0])
      kind = named === undefined ? 'overall' : named
    } else {
      const before = /([A-Za-z][A-Za-z-]*)\s+$/.exec(line.slice(0, at))
      if (before) {
        const named = kindFromWord(before[1])
        if (named !== undefined) {
          kind = named
          if (named !== null) start = at - before[0].length
        }
      }
    }
    out.push({ kind, raw: match[3].replace(/\s+/g, ''), match: line.slice(start, at + match[0].length) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Matching values to lines
// ---------------------------------------------------------------------------

interface Matcher {
  readonly within: (normalisedLine: string) => boolean
  readonly remove: (normalisedLine: string) => string
}

/** A value as a whole word or phrase: "RN" is not in "journal". */
function matcherFor(value: string): Matcher | null {
  const wanted = norm(value)
  if (!/[a-z0-9]/.test(wanted)) return null
  const body = `(?<![a-z0-9])${escapeRegExp(wanted)}(?![a-z0-9])`
  const once = new RegExp(body)
  const every = new RegExp(body, 'g')
  return {
    within: (line) => once.test(line),
    remove: (line) => line.replace(every, ' '),
  }
}

function matchersFor(values: readonly string[]): Matcher[] {
  return [...new Set(values.map(norm))]
    .sort((a, b) => b.length - a.length)
    .map(matcherFor)
    .filter((matcher): matcher is Matcher => matcher !== null)
}

function anyWithin(matchers: readonly Matcher[], line: string): boolean {
  const normalised = norm(line)
  return matchers.some((matcher) => matcher.within(normalised))
}

/** How many of a line's letters and digits no value accounts for. */
function leftover(matchers: readonly Matcher[], line: string): number {
  let rest = norm(line)
  for (const matcher of matchers) rest = matcher.remove(rest)
  return rest.replace(/[^a-z0-9]+/g, '').length
}

/** What is left of a line once every value in `values` is taken out of it. */
export function leftoverAlnum(line: string, values: readonly string[]): number {
  return leftover(matchersFor(values), line)
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

interface AnchorInput {
  /** What says which entry this is: an employer or role, an institution or degree. */
  readonly identity: readonly string[]
  readonly extra: readonly string[]
}

interface Span {
  readonly entry: number
  readonly start: number
  readonly end: number
}

/**
 * Where each organised entry's header sits in the document.
 *
 * Each entry takes the line that names it best -- most of its values, and
 * nothing else -- and no two entries share a line. Then each header grows over
 * the lines around it made only of its own values: the dates line under a
 * title, the employer line above a role.
 */
function anchorEntries(
  entries: readonly AnchorInput[],
  lines: readonly string[],
  taken: Set<number>,
  excluded: (index: number) => boolean
): Span[] {
  const present = (values: readonly string[]) => values.filter((value) => value.trim() !== '')
  const compiled = entries.map((entry) => ({
    identity: matchersFor(present(entry.identity)),
    extra: matchersFor(present(entry.extra)),
    all: matchersFor(present([...entry.identity, ...entry.extra])),
  }))

  const candidates: { entry: number; line: number; score: number }[] = []
  compiled.forEach((entry, e) => {
    if (entry.identity.length === 0) return
    for (let i = 0; i < lines.length; i++) {
      if (excluded(i)) continue
      const normalised = norm(lines[i])
      const hits = entry.identity.filter((matcher) => matcher.within(normalised)).length
      if (hits === 0) continue
      const extras = entry.extra.filter((matcher) => matcher.within(normalised)).length
      const onlyItsOwn = leftover(entry.all, lines[i]) < LEFTOVER_MIN
      candidates.push({ entry: e, line: i, score: hits * 2 + extras + (onlyItsOwn ? 2 : 0) })
    }
  })
  candidates.sort((a, b) => b.score - a.score || a.line - b.line || a.entry - b.entry)

  const primary: { entry: number; line: number }[] = []
  const anchored = new Set<number>()
  for (const candidate of candidates) {
    if (anchored.has(candidate.entry) || taken.has(candidate.line)) continue
    anchored.add(candidate.entry)
    taken.add(candidate.line)
    primary.push(candidate)
  }

  const spans: Span[] = []
  for (const { entry, line } of primary.sort((a, b) => a.line - b.line)) {
    const own = compiled[entry].all
    const belongs = (j: number) =>
      j >= 0 && j < lines.length && !taken.has(j) && !excluded(j) &&
      anyWithin(own, lines[j]) && leftover(own, lines[j]) < LEFTOVER_MIN
    let start = line
    let end = line
    while (line - start < MAX_HEADER_REACH && belongs(start - 1)) taken.add(--start)
    while (end - line < MAX_HEADER_REACH && belongs(end + 1)) taken.add(++end)
    spans.push({ entry, start, end })
  }
  return spans
}

// ---------------------------------------------------------------------------
// The whole document
// ---------------------------------------------------------------------------

/** Where an unplaced line looks like it belongs, by the organised entry's index. */
export type StructuralSuggestion =
  | { readonly kind: 'bullet'; readonly position: number | null }
  | { readonly kind: 'summary' }
  | { readonly kind: 'section'; readonly sectionType: ResumeSectionType }
  | { readonly kind: 'none' }

export interface RecoveredLine {
  /** The line exactly as the document had it. */
  readonly text: string
  readonly sourceLine: number
  readonly suggestion: StructuralSuggestion
}

export interface GpaFound {
  readonly raw: string
  readonly line: number
}

export interface StructureResult {
  /** The prose under a Summary heading, when it is plain prose. */
  readonly summary: { readonly text: string; readonly lines: readonly number[] } | null
  /** Bullets for each anchored position, by organised index. */
  readonly positionBullets: ReadonlyMap<number, readonly SegmentedBullet[]>
  /** Stated GPAs for each anchored education entry, by organised index. */
  readonly gpas: ReadonlyMap<number, { readonly overall?: GpaFound; readonly science?: GpaFound }>
  /** Every line nothing placed, in document order. */
  readonly recovery: readonly RecoveredLine[]
}

/** "Skills: CRRT, ECMO" -- a labelled line, which is not part of a paragraph. */
const LABELLED = /^[A-Z][A-Za-z &/-]{1,30}:\s*\S/

/**
 * The document's structure, given what the organiser traced with confidence.
 *
 * `organised` must be the TRACED plan -- high-confidence values only -- so every
 * anchor is something already verified to be in the document.
 */
export function analyseStructure(organised: OrganisedResume, source: SourceDocument): StructureResult {
  const lines = source.lines
  const n = lines.length
  const known = lines.map(headingKind)
  const marker = lines.map(isColumnMarker)
  const separator = lines.map((line, i) => marker[i] || isSeparatorOnly(line))
  const filled = (values: readonly string[]) => values.filter((value) => value.trim() !== '')

  // --- where each entry is -----------------------------------------------------
  const taken = new Set<number>()
  const notAnAnchor = (i: number) => known[i] !== null || separator[i]
  const positionSpans = anchorEntries(
    organised.positions.map((p) => ({ identity: [p.employer, p.role], extra: [p.unit, p.location, p.dates] })),
    lines, taken, notAnAnchor
  )
  const educationSpans = anchorEntries(
    organised.education.map((e) => ({ identity: [e.institution, e.degree], extra: [e.field, e.location, e.graduated] })),
    lines, taken, notAnAnchor
  )
  const spanAt = new Map<number, { kind: 'position' | 'education'; entry: number }>()
  for (const span of positionSpans) {
    for (let i = span.start; i <= span.end; i++) spanAt.set(i, { kind: 'position', entry: span.entry })
  }
  for (const span of educationSpans) {
    for (let i = span.start; i <= span.end; i++) spanAt.set(i, { kind: 'education', entry: span.entry })
  }

  // --- what each line is ---------------------------------------------------------
  const contactValues = matchersFor(filled(Object.values(organised.contact)))
  const otherIdentity = matchersFor(filled([
    ...organised.education.flatMap((e) => [e.institution, e.degree]),
    ...organised.certifications.map((c) => c.name),
    ...organised.licenses.map((l) => l.licenseType),
    ...organised.entries.flatMap((e) => [e.title, e.organization]),
  ]))
  const otherValues = matchersFor(filled([
    ...organised.education.flatMap((e) => [e.degree, e.field, e.institution, e.location, e.graduated]),
    ...organised.certifications.flatMap((c) => [c.name, c.issuer]),
    ...organised.licenses.flatMap((l) => [l.licenseType, l.state]),
    ...organised.entries.flatMap((e) => [e.title, e.organization, e.dates, e.detail]),
  ]))

  const free = (i: number) => !spanAt.has(i) && known[i] === null && !separator[i]
  const headingLike = lines.map((line, i) => known[i] !== null || (free(i) && looksLikeHeading(line)))
  const contactOnly = lines.map((line, i) =>
    free(i) && anyWithin(contactValues, line) && leftover(contactValues, line) < LEFTOVER_MIN)
  // A repeated name-and-contact line at the top of a page is not a new entry.
  const entryHeader = lines.map((line, i) => free(i) && !contactOnly[i] && looksLikeEntryHeader(line))
  const otherOwned = lines.map((line, i) =>
    free(i) && !contactOnly[i] && anyWithin(otherIdentity, line) && leftover(otherValues, line) < LEFTOVER_MIN)
  const headerDetail = lines.map((line, i) =>
    free(i) && (isDateOnly(line) || isLocationOnly(line) || isLabelLine(line)))
  const pageMarker = lines.map((line, i) => free(i) && isPageMarker(line))

  /**
   * The applicant's own header lines, once the contact fields were read from
   * them. What else sits there -- a street address, a ZIP code -- has no field
   * on the resume, and the line is not offered back for review.
   *
   * Only unmistakable header lines: one holding the email or phone, a name
   * line before the first section, and a short city/state line directly beside
   * one of those. The applicant's city mentioned in a sentence is not a header.
   */
  const strongContact = matchersFor(filled([organised.contact.email ?? '', organised.contact.phone ?? '']))
  const nameContact = matchersFor(filled([organised.contact.fullName ?? '']))
  const firstSection = lines.findIndex((_, i) => known[i] !== null || spanAt.has(i))
  const opening = firstSection < 0 ? n : firstSection
  const yieldsContact = (i: number) => free(i) && anyWithin(contactValues, lines[i])
  const headerLine = lines.map((line, i) =>
    yieldsContact(i) && (anyWithin(strongContact, line) || (i < opening && anyWithin(nameContact, line))))
  const besideHeader = (i: number, step: number) => {
    let j = i + step
    while (j >= 0 && j < n && separator[j] && !marker[j]) j += step
    return j >= 0 && j < n && headerLine[j]
  }
  const contactRead = lines.map((line, i) =>
    headerLine[i] || (yieldsContact(i) && i < opening && line.trim().split(/\s+/).length <= 8 &&
      (besideHeader(i, -1) || besideHeader(i, 1))))

  /** Where a run of text under a heading or a header must stop. */
  const boundary = (i: number) =>
    headingLike[i] || spanAt.has(i) || marker[i] || otherOwned[i] || entryHeader[i]

  const consumed = new Set<number>()

  // --- bullets under each job ------------------------------------------------------
  const positionBullets = new Map<number, SegmentedBullet[]>()
  for (const span of positionSpans) {
    const block: BlockLine[] = []
    for (let i = span.end + 1; i < n && !boundary(i); i++) {
      block.push({
        index: i,
        text: lines[i],
        role: contactOnly[i] || pageMarker[i] ? 'skip' : headerDetail[i] ? 'break' : 'text',
      })
    }
    const bullets = segmentBullets(block)
    if (bullets.length === 0) continue
    positionBullets.set(span.entry, bullets)
    for (const bullet of bullets) for (const i of bullet.lines) consumed.add(i)
  }

  // --- a summary under its own heading ---------------------------------------------
  let summary: { text: string; lines: number[] } | null = null
  for (let h = 0; h < n && !summary; h++) {
    if (known[h] !== 'summary') continue
    const prose: number[] = []
    let plain = true
    for (let i = h + 1; i < n && !boundary(i); i++) {
      if (contactOnly[i] || pageMarker[i]) continue
      const labelled = LABELLED.test(lines[i])
      if (labelled && prose.length > 0) break
      // A labelled line is not a paragraph, and neither is a bulleted list.
      if (labelled || separator[i] || stripGlyphs(lines[i]).lead) {
        plain = false
        break
      }
      prose.push(i)
    }
    if (!plain || prose.length === 0 || prose.length > MAX_SUMMARY_LINES) continue
    summary = {
      text: prose.map((i) => lines[i].trim()).reduce((text, line) => (text === '' ? line : joinWrapped(text, line)), ''),
      lines: prose,
    }
    for (const i of prose) consumed.add(i)
  }

  // --- GPAs stated under a degree ------------------------------------------------------
  /**
   * The degree a line sits under, until another entry or heading intervenes --
   * including a school the organiser did not recognise, whose GPA must not be
   * filed under the school above it.
   */
  const activeEducation = (i: number): number | null => {
    for (let j = i; j >= 0; j--) {
      const span = spanAt.get(j)
      if (span) return span.kind === 'education' ? span.entry : null
      if (j < i && (headingLike[j] || marker[j] || (free(j) && looksLikeInstitution(lines[j])))) return null
    }
    return null
  }
  const gpas = new Map<number, { overall?: GpaFound; science?: GpaFound }>()
  const gpaWords = new Map<number, string[]>()
  /**
   * Lines whose every GPA is now on the resume, used up like a contact line.
   * A line naming a GPA the resume has no field for (nursing, major), or a
   * figure different from the one already read, stays for the applicant.
   */
  const gpaRead = new Array<boolean>(n).fill(false)
  for (let i = 0; i < n; i++) {
    const mentions = gpasIn(lines[i])
    if (mentions.length === 0) continue
    const entry = activeEducation(i)
    if (entry === null) continue
    const record = gpas.get(entry) ?? {}
    let unread = 0
    for (const mention of mentions) {
      if (mention.kind === null) {
        unread++
        continue
      }
      const held = record[mention.kind]
      if (!held) {
        record[mention.kind] = { raw: mention.raw, line: i }
        gpaWords.set(i, [...(gpaWords.get(i) ?? []), mention.match])
      } else if (held.raw !== mention.raw) {
        unread++
      }
    }
    if (record.overall || record.science) gpas.set(entry, record)
    gpaRead[i] = unread === 0
  }

  // --- everything else: placed by a value, or recovered --------------------------------
  const placedValues = matchersFor(filled([
    ...Object.values(organised.contact),
    ...organised.education.flatMap((e) => [e.degree, e.field, e.institution, e.location, e.graduated]),
    ...organised.certifications.flatMap((c) => [c.name, c.issuer]),
    ...organised.licenses.flatMap((l) => [l.licenseType, l.state]),
    ...organised.entries.flatMap((e) => [e.title, e.organization, e.dates, e.detail]),
    ...organised.positions.flatMap((p, i) =>
      [p.employer, p.role, p.unit, p.location, p.dates, ...(positionBullets.has(i) ? [] : p.bullets)]),
    ...(summary ? [] : [organised.summary]),
  ]))

  /** The job directly above an Experience heading -- "EXPERIENCE (continued)" on a new page. */
  const positionAbove = (heading: number): number | null => {
    for (let j = heading - 1; j >= 0; j--) {
      const span = spanAt.get(j)
      if (span) return span.kind === 'position' ? span.entry : null
      if ((headingLike[j] && known[j] !== 'experience') || entryHeader[j]) return null
    }
    return null
  }

  const suggestionFor = (i: number): StructuralSuggestion => {
    if (entryHeader[i] || headerDetail[i] || headingLike[i] || pageMarker[i]) return { kind: 'none' }
    let crossedHeader = false
    for (let j = i - 1; j >= 0; j--) {
      const span = spanAt.get(j)
      if (span?.kind === 'position') return { kind: 'bullet', position: crossedHeader ? null : span.entry }
      if (span?.kind === 'education') return crossedHeader ? { kind: 'none' } : { kind: 'section', sectionType: 'education' }
      if (entryHeader[j]) {
        crossedHeader = true
        continue
      }
      const kind = known[j]
      if (kind === 'summary') return { kind: 'summary' }
      if (kind === 'experience') return { kind: 'bullet', position: crossedHeader ? null : positionAbove(j) }
      if (kind !== null) {
        const type = ENTRY_TYPE[kind]
        return type ? { kind: 'section', sectionType: type } : { kind: 'none' }
      }
      if (headingLike[j]) return { kind: 'none' }
    }
    return { kind: 'none' }
  }

  const recovery: RecoveredLine[] = []
  for (let i = 0; i < n; i++) {
    if (known[i] !== null || separator[i] || consumed.has(i) || contactRead[i] || gpaRead[i]) continue
    const accounted = gpaWords.has(i) ? [...placedValues, ...matchersFor(gpaWords.get(i)!)] : placedValues
    if (leftover(accounted, lines[i]) < LEFTOVER_MIN) continue
    recovery.push({ text: lines[i], sourceLine: i, suggestion: suggestionFor(i) })
  }

  return { summary, positionBullets, gpas, recovery }
}
