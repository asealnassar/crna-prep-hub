/**
 * Turning extracted text into a resume, without inventing any of it.
 *
 * A model does the MAPPING -- deciding that a line is an employer and the four
 * beneath it are bullets. It does not get to decide whether the mapping is
 * trustworthy, and it cannot contribute content: every value it returns is
 * traced back to the source text here, and anything that does not appear there
 * is discarded before it can reach a draft.
 *
 * That inversion is the whole design. "The organiser may not add facts absent
 * from the extraction" is not an instruction in a prompt -- prompts are advice.
 * It is `traceValue`, below, and a value that fails it never becomes part of a
 * resume however confidently it was asserted.
 *
 * CONFIDENCE IS DERIVED, NOT CLAIMED. A model asked to rate its own certainty
 * rates it high. Confidence here comes from how cleanly a value traces:
 * verbatim in a line is `high`; recoverable only by matching its words across
 * the text is `low`, and low-confidence material is set aside for the applicant
 * rather than written into their resume.
 */

import type { SourceDocument } from './source.ts'

export type Confidence = 'high' | 'low'

export interface MappedValue {
  /** Where it lands, e.g. 'contact.email' or 'positions[0].employer'. */
  readonly path: string
  readonly value: string
  readonly confidence: Confidence
  /** Which source line it came from. Provenance the applicant can check. */
  readonly sourceLine: number | null
}

export interface RejectedValue {
  readonly path: string
  readonly value: string
  /** Always the same reason; kept explicit so the review screen can say it. */
  readonly reason: 'not-found-in-source'
}

export interface OrganisedPosition {
  readonly employer: string
  readonly role: string
  readonly unit: string
  readonly location: string
  readonly dates: string
  readonly bullets: readonly string[]
}

export interface OrganisedEducation {
  readonly degree: string
  readonly field: string
  readonly institution: string
  readonly location: string
  readonly graduated: string
}

export const ENTRY_SECTIONS = [
  'leadership', 'quality_improvement', 'research', 'volunteer',
  'awards', 'publications', 'shadowing',
] as const
export type EntrySection = (typeof ENTRY_SECTIONS)[number]

export interface OrganisedEntry {
  readonly section: EntrySection
  readonly title: string
  readonly organization: string
  readonly dates: string
  readonly detail: string
}

export interface OrganisedResume {
  readonly contact: Readonly<Record<string, string>>
  readonly summary: string
  readonly positions: readonly OrganisedPosition[]
  readonly education: readonly OrganisedEducation[]
  readonly certifications: readonly { name: string; issuer: string }[]
  readonly licenses: readonly { licenseType: string; state: string }[]
  readonly entries: readonly OrganisedEntry[]
  /** Lines the organiser could not place. Never guessed at. */
  readonly unmapped: readonly string[]
}

export interface ImportPlan {
  readonly organised: OrganisedResume
  /** Traced verbatim. These become the draft. */
  readonly mapped: readonly MappedValue[]
  /** Traced loosely. Set aside for the applicant, never written in. */
  readonly uncertain: readonly MappedValue[]
  /** Asserted by the model, absent from the source. Discarded. */
  readonly rejected: readonly RejectedValue[]
  /** Source lines nothing was made of. */
  readonly unmapped: readonly string[]
}

export const CONTACT_FIELDS = [
  'fullName', 'credentials', 'email', 'phone', 'city', 'state',
] as const

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Strips the punctuation an extractor sprinkles, so a match is about words. */
function loose(value: string): string {
  return normalise(value).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface Trace {
  readonly confidence: Confidence
  readonly sourceLine: number | null
}

/**
 * Where a value came from, or nothing.
 *
 * Three outcomes, in order of how much they can be trusted:
 *
 *   high  the value appears inside a source line, as written
 *   low   its words all appear in the text, but not together in one line --
 *         usually a value an extractor split across a line break
 *   null  it is not in the source at all, and is therefore not a fact about
 *         this applicant however plausible it looks
 */
export function traceValue(value: string, source: SourceDocument): Trace | null {
  const wanted = normalise(value)
  if (wanted === '') return null

  for (let i = 0; i < source.lines.length; i++) {
    if (normalise(source.lines[i]).includes(wanted)) return { confidence: 'high', sourceLine: i }
  }

  const wantedLoose = loose(value)
  if (wantedLoose !== '') {
    for (let i = 0; i < source.lines.length; i++) {
      if (loose(source.lines[i]).includes(wantedLoose)) return { confidence: 'low', sourceLine: i }
    }
    // Split across lines: every word present somewhere, in order, in the text.
    const haystack = loose(source.text)
    if (haystack.includes(wantedLoose)) return { confidence: 'low', sourceLine: null }
  }

  return null
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export function organiserSystemPrompt(): string {
  return [
    'You sort the text of an existing resume into sections. You are a filing',
    'clerk, not a writer.',
    '',
    'Rules, in order of importance:',
    '1. Every value you return must appear in the text you were given. Copy it,',
    '   do not paraphrase it, do not tidy it, do not expand an abbreviation.',
    '2. Never fill in something that is not there. No inferred dates, no assumed',
    '   employer, no guessed credential. An empty string is the correct answer.',
    '3. If you cannot confidently place a line, put it in "unmapped". That is a',
    '   successful outcome, not a failure.',
    '',
    'Anything you return that is not in the source text will be discarded before',
    'the applicant sees it, so inventing costs you the mapping and helps nobody.',
    '',
    'Reply with JSON only, in exactly this shape:',
    '{"contact":{"fullName":"","credentials":"","email":"","phone":"","city":"","state":""},',
    ' "summary":"",',
    ' "positions":[{"employer":"","role":"","unit":"","location":"","dates":"","bullets":[""]}],',
    ' "education":[{"degree":"","field":"","institution":"","location":"","graduated":""}],',
    ' "certifications":[{"name":"","issuer":""}],',
    ' "licenses":[{"licenseType":"","state":""}],',
    ' "entries":[{"section":"leadership","title":"","organization":"","dates":"","detail":""}],',
    ' "unmapped":[""]}',
    '',
    `"section" must be one of: ${ENTRY_SECTIONS.join(', ')}.`,
    'Put critical care and other bedside nursing roles in "positions".',
    'No prose outside the JSON. No markdown fence.',
  ].join('\n')
}

export function organiserUserPrompt(source: SourceDocument): string {
  return [
    'THE RESUME TEXT, one line per line:',
    '',
    ...source.lines.map((line, i) => `${i}: ${line}`),
  ].join('\n')
}

export function buildOrganiserPrompt(source: SourceDocument): { system: string; user: string } {
  return { system: organiserSystemPrompt(), user: organiserUserPrompt(source) }
}

// ---------------------------------------------------------------------------
// Reading the reply
// ---------------------------------------------------------------------------

const MAX_VALUE = 4_000
const MAX_ITEMS = 40

function str(value: unknown): string {
  return typeof value === 'string' && value.length <= MAX_VALUE ? value.trim() : ''
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(str).filter((v) => v !== '').slice(0, MAX_ITEMS)
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && !Array.isArray(row))
    .slice(0, MAX_ITEMS)
}

function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text)
  return fenced ? fenced[1] : text
}

/** Shape only. Nothing here decides whether a value is true. */
export function parseOrganised(raw: unknown): OrganisedResume {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(stripFence(value))
    } catch {
      value = null
    }
  }
  const body = (typeof value === 'object' && value !== null && !Array.isArray(value))
    ? (value as Record<string, unknown>)
    : {}

  const contactRaw = (typeof body.contact === 'object' && body.contact !== null)
    ? (body.contact as Record<string, unknown>)
    : {}
  const contact: Record<string, string> = {}
  for (const field of CONTACT_FIELDS) contact[field] = str(contactRaw[field])

  return {
    contact,
    summary: str(body.summary),
    positions: rows(body.positions).map((p) => ({
      employer: str(p.employer), role: str(p.role), unit: str(p.unit),
      location: str(p.location), dates: str(p.dates), bullets: strList(p.bullets),
    })),
    education: rows(body.education).map((e) => ({
      degree: str(e.degree), field: str(e.field), institution: str(e.institution),
      location: str(e.location), graduated: str(e.graduated),
    })),
    certifications: rows(body.certifications).map((c) => ({ name: str(c.name), issuer: str(c.issuer) })),
    licenses: rows(body.licenses).map((l) => ({ licenseType: str(l.licenseType), state: str(l.state) })),
    entries: rows(body.entries)
      .map((e) => ({
        section: (ENTRY_SECTIONS as readonly string[]).includes(String(e.section))
          ? (e.section as EntrySection) : ('leadership' as EntrySection),
        title: str(e.title), organization: str(e.organization),
        dates: str(e.dates), detail: str(e.detail),
      }))
      .filter((e) => e.title !== '' || e.organization !== '' || e.detail !== ''),
    unmapped: strList(body.unmapped),
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Every value the organiser produced, traced against the source.
 *
 * The returned `organised` is the FILTERED version: high-confidence values
 * only. Everything else is reported beside it -- uncertain for the applicant to
 * place, rejected because it was not in their document at all -- and none of it
 * reaches the draft.
 */
export function buildImportPlan(organised: OrganisedResume, source: SourceDocument): ImportPlan {
  const mapped: MappedValue[] = []
  const uncertain: MappedValue[] = []
  const rejected: RejectedValue[] = []

  /** Returns the value when it is safe to use, and '' when it is not. */
  const keep = (path: string, value: string): string => {
    if (value.trim() === '') return ''
    const trace = traceValue(value, source)
    if (!trace) {
      rejected.push({ path, value, reason: 'not-found-in-source' })
      return ''
    }
    const record: MappedValue = { path, value, confidence: trace.confidence, sourceLine: trace.sourceLine }
    if (trace.confidence === 'high') {
      mapped.push(record)
      return value
    }
    uncertain.push(record)
    return ''
  }

  const contact: Record<string, string> = {}
  for (const field of CONTACT_FIELDS) {
    contact[field] = keep(`contact.${field}`, organised.contact[field] ?? '')
  }

  const positions = organised.positions.map((position, i) => ({
    employer: keep(`positions[${i}].employer`, position.employer),
    role: keep(`positions[${i}].role`, position.role),
    unit: keep(`positions[${i}].unit`, position.unit),
    location: keep(`positions[${i}].location`, position.location),
    dates: keep(`positions[${i}].dates`, position.dates),
    bullets: position.bullets
      .map((bullet, b) => keep(`positions[${i}].bullets[${b}]`, bullet))
      .filter((bullet) => bullet !== ''),
  }))

  const education = organised.education.map((entry, i) => ({
    degree: keep(`education[${i}].degree`, entry.degree),
    field: keep(`education[${i}].field`, entry.field),
    institution: keep(`education[${i}].institution`, entry.institution),
    location: keep(`education[${i}].location`, entry.location),
    graduated: keep(`education[${i}].graduated`, entry.graduated),
  }))

  const certifications = organised.certifications.map((entry, i) => ({
    name: keep(`certifications[${i}].name`, entry.name),
    issuer: keep(`certifications[${i}].issuer`, entry.issuer),
  }))

  const licenses = organised.licenses.map((entry, i) => ({
    licenseType: keep(`licenses[${i}].licenseType`, entry.licenseType),
    state: keep(`licenses[${i}].state`, entry.state),
  }))

  const entries = organised.entries.map((entry, i) => ({
    section: entry.section,
    title: keep(`entries[${i}].title`, entry.title),
    organization: keep(`entries[${i}].organization`, entry.organization),
    dates: keep(`entries[${i}].dates`, entry.dates),
    detail: keep(`entries[${i}].detail`, entry.detail),
  }))

  const summary = keep('summary', organised.summary)

  // Unmapped lines are the applicant's own text, so they are kept whether or
  // not the organiser echoed them back correctly -- but only the ones that are
  // genuinely in the source.
  const unmapped = organised.unmapped.filter((line) => traceValue(line, source) !== null)

  return {
    organised: {
      contact, summary, positions, education, certifications, licenses, entries,
      unmapped,
    },
    mapped,
    uncertain,
    rejected,
    unmapped,
  }
}
