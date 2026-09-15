/**
 * The Data Quality half: 40 points, decided without a model.
 *
 * Pure, free, instant and exhaustively testable. Everything here is a defect
 * the applicant can see and fix, which is why it is worth 40 points and why it
 * recomputes for nothing.
 *
 * NOTHING HERE READS A CREDENTIAL. Search this file for GPA, certification or
 * hours and you will find them only in this sentence. There is no rule that
 * consults them, so no drift in wording or weighting can turn one into a
 * deduction. Absence is measured only where the applicant chose to include
 * something and then left it empty.
 */

import { planDocument } from '../document/plan.ts'
import { hasFixedHeading, isSectionEmpty } from '../model/sections.ts'
import { isBlankAuthoredText } from '../model/authoredText.ts'
import type { AuthoredText } from '../model/authoredText.ts'
import { isUsableDate, rangeOrder } from '../model/dates.ts'
import type { ResumeDate, ResumeDateRange } from '../model/dates.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'
import { category } from './types.ts'
import type { CategoryResult } from './types.ts'
import { measureEvidence } from './evidence.ts'

/** Everything the deterministic half produces. */
export function scoreDeterministic(resume: ResumeV2): CategoryResult[] {
  return [
    sectionCompleteness(resume),
    contactCompleteness(resume),
    dateIntegrity(resume),
    contentHygiene(resume),
    lengthAndFit(resume),
  ]
}

// ---------------------------------------------------------------------------
// Section completeness -- 10
// ---------------------------------------------------------------------------

/**
 * Whether the core of the resume is written out: a professional summary, worth
 * up to 3, and developed clinical experience, worth up to 7 -- less a point for
 * each section left visible but empty.
 *
 * What it never asks for is any optional section. Only the summary and the
 * clinical bullets earn points here, and the only thing that costs a point is a
 * section the applicant chose to show and left empty.
 */
function sectionCompleteness(resume: ResumeV2): CategoryResult {
  const visible = resume.sections.filter((s) => s.visible)
  if (visible.length === 0) {
    return category('section-completeness', 0, {
      weaknesses: ['No sections are visible yet, so the resume would print empty.'],
      improvements: ['Add a section and fill it in — the professional summary is a good place to start.'],
    })
  }

  const evidence = measureEvidence(resume)
  const words = evidence.summaryWords
  const summaryPoints = words >= 25 ? 3 : words >= 12 ? 2 : words > 0 ? 1 : 0
  const bullets = evidence.substantiveRoleBullets
  const clinicalPoints = 7 * Math.min(1, bullets / 3)
  const empty = visible.filter((s) => isSectionEmpty(s))

  const strengths: string[] = []
  const weaknesses: string[] = []
  const improvements: string[] = []

  if (summaryPoints === 3) {
    strengths.push('Your professional summary is written out.')
  } else if (summaryPoints === 0) {
    weaknesses.push('There is no professional summary yet.')
    improvements.push('Write two or three sentences for your professional summary about who you are as a critical-care nurse.')
  } else {
    weaknesses.push('Your professional summary is very short.')
    improvements.push('Expand your professional summary to two or three sentences.')
  }

  if (bullets >= 3) {
    strengths.push(`Your clinical experience has ${bullets} developed bullets.`)
  } else if (bullets === 0) {
    weaknesses.push(evidence.clinicalPositions > 0
      ? 'Your clinical experience lists a role but no developed bullets, so there is little for a reader to go on.'
      : 'There is no clinical experience written out yet.')
    improvements.push('Add three or more bullets under your most recent clinical role describing what you handled and were trusted with.')
  } else {
    weaknesses.push(`Your clinical experience has ${bullets} developed ${bullets === 1 ? 'bullet' : 'bullets'}; three or more give a reader a clear picture.`)
    improvements.push('Add bullets under your clinical roles describing what you handled and were trusted with.')
  }

  if (empty.length > 0) {
    weaknesses.push(...empty.map((s) => `The ${headingOf(s)} section is visible but empty, so it prints as a heading over nothing.`))
    improvements.push('Fill in the empty sections, or hide them — a hidden section keeps its data and does not print.')
  }

  return category('section-completeness', Math.max(0, summaryPoints + clinicalPoints - empty.length), {
    strengths, weaknesses, improvements,
  })
}

function headingOf(section: ResumeSectionV2): string {
  // A fixed heading ignores a stored label here too: naming a section by a
  // label that prints nowhere would send the applicant looking for it.
  const label = hasFixedHeading(section.type) ? null : section.label
  return label ?? (section.type === 'custom' ? section.heading || 'custom' : section.type.replace(/_/g, ' '))
}

// ---------------------------------------------------------------------------
// Contact completeness -- 8
// ---------------------------------------------------------------------------

/**
 * Identification and reachability, and nothing else.
 *
 * Four things, two points each: name, email, phone, location. CREDENTIALS ARE
 * DELIBERATELY NOT SCORED -- a nurse without CCRN after their name is not a
 * worse resume, and scoring it would be exactly the credential penalty the
 * design forbids. LinkedIn and a website are optional and unscored for the
 * same reason.
 */
function contactCompleteness(resume: ResumeV2): CategoryResult {
  const c = resume.contact
  const items: [string, boolean, string][] = [
    ['name', c.fullName.trim() !== '', 'Add your full name — two live V1 resumes still print the word "Name".'],
    ['email', c.email.trim() !== '', 'Add the email address a programme should reply to.'],
    ['phone', c.phone.trim() !== '', 'Add a phone number.'],
    ['location', c.city.trim() !== '' || c.state.trim() !== '', 'Add your city and state.'],
  ]

  const present = items.filter(([, ok]) => ok)
  const missing = items.filter(([, ok]) => !ok)

  return category('contact-completeness', present.length * 2, {
    strengths: missing.length === 0 ? ['A programme can identify and reach you.'] : [],
    weaknesses: missing.map(([name]) => `No ${name} on the resume.`),
    improvements: missing.map(([, , advice]) => advice),
  })
}

// ---------------------------------------------------------------------------
// Date integrity -- 8
// ---------------------------------------------------------------------------

interface DatedThing {
  readonly where: string
  readonly date?: ResumeDate
  readonly range?: ResumeDateRange
}

/**
 * Whether the dates that ARE there read clearly and run forwards.
 *
 * Presence is not scored. Leaving an optional date out is a choice, and
 * counting it here would penalise someone for not having, say, a certification
 * expiry — which is the credential penalty wearing a different hat. What is
 * scored: a date nobody can parse, and a range that ends before it starts.
 */
function dateIntegrity(resume: ResumeV2): CategoryResult {
  const things = collectDates(resume)
  const present = things.filter((t) =>
    (t.date && t.date.kind !== 'absent') ||
    (t.range && (t.range.start.kind !== 'absent' || t.range.end.kind !== 'absent'))
  )

  if (present.length === 0) {
    return category('date-integrity', null, {
      notAssessed: 'You have not entered any dates yet, so there is nothing to check.',
    })
  }

  const backwards: string[] = []
  const unclear: string[] = []
  let credit = 0

  for (const thing of present) {
    if (thing.range) {
      if (rangeOrder(thing.range) === 'end-before-start') {
        backwards.push(`The dates on ${thing.where} end before they start.`)
        continue
      }
      const parts = [thing.range.start, thing.range.end].filter((d) => d.kind !== 'absent')
      const clear = parts.every((d) => isUsableDate(d))
      if (!clear) unclear.push(`The dates on ${thing.where} are written in a way a reader has to interpret.`)
      credit += clear ? 1 : 0.5
      continue
    }
    if (thing.date) {
      const clear = isUsableDate(thing.date)
      if (!clear) unclear.push(`The date on ${thing.where} is written in a way a reader has to interpret.`)
      credit += clear ? 1 : 0.5
    }
  }

  const earned = (credit / present.length) * 8
  const clean = backwards.length === 0 && unclear.length === 0

  return category('date-integrity', earned, {
    strengths: clean ? [`All ${present.length} of your dates read clearly.`] : [],
    weaknesses: [...backwards, ...unclear],
    improvements: clean
      ? []
      : [
          ...(backwards.length > 0 ? ['Check the start and end dates on the entries listed above.'] : []),
          ...(unclear.length > 0
            ? ['A month and year — "2021-03" or "Mar 2021" — reads unambiguously. Free text like "Spring 2021" is kept exactly as you typed it, but a reader has to work it out.']
            : []),
        ],
  })
}

function collectDates(resume: ResumeV2): DatedThing[] {
  const out: DatedThing[] = []
  for (const section of resume.sections) {
    if (!section.visible) continue
    switch (section.type) {
      case 'education':
        section.entries.forEach((e, i) =>
          out.push({ where: `education entry ${i + 1}`, date: e.graduationDate }))
        break
      case 'critical_care':
      case 'other_clinical':
        section.positions.forEach((p, i) =>
          out.push({ where: `${p.facts.employer || `position ${i + 1}`}`, range: p.facts.dates }))
        break
      case 'licensure':
        section.licenses.forEach((l, i) => out.push({ where: `licence ${i + 1}`, date: l.expires }))
        break
      case 'certifications':
        section.certifications.forEach((c, i) => {
          out.push({ where: `${c.name || `certification ${i + 1}`} (earned)`, date: c.earned })
          out.push({ where: `${c.name || `certification ${i + 1}`} (expiry)`, date: c.expires })
        })
        break
      case 'shadowing':
        section.experiences.forEach((e, i) =>
          out.push({ where: `shadowing entry ${i + 1}`, range: e.dates }))
        break
      case 'leadership':
      case 'quality_improvement':
      case 'research':
      case 'volunteer':
        section.entries.forEach((e, i) =>
          out.push({ where: `${section.type.replace(/_/g, ' ')} entry ${i + 1}`, range: e.dates }))
        break
      case 'organizations':
        section.memberships.forEach((m, i) =>
          out.push({ where: `membership ${i + 1}`, range: m.dates }))
        break
      case 'awards':
        section.awards.forEach((a, i) => out.push({ where: `award ${i + 1}`, date: a.awarded }))
        break
      case 'publications':
        section.entries.forEach((e, i) => out.push({ where: `publication ${i + 1}`, date: e.date }))
        break
      default:
        break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Content hygiene -- 8
// ---------------------------------------------------------------------------

/** Hygiene is judged across this many written lines; a resume with fewer earns it in proportion. */
const HYGIENE_FULL_LINES = 4

/**
 * The small defects that make a resume look careless.
 *
 * Blank bullets are the V1 defect: every one of its forty-one production bullet
 * arrays holds `['']`, so every exported PDF printed a lone dot under every
 * job. V2's model refuses to create one, but a person can still empty one out.
 */
function contentHygiene(resume: ResumeV2): CategoryResult {
  const lines = collectProse(resume)
  if (lines.length === 0) {
    return category('content-hygiene', 0, {
      weaknesses: ['Nothing is written yet, so there is nothing to check.'],
      improvements: ['Write your summary and role bullets; hygiene is checked across everything you write.'],
    })
  }

  const blanks = lines.filter((l) => l.text.trim() === '')
  // Matched case-insensitively, but reported back in the applicant's own
  // casing -- quoting their sentence to them in lower case would read as a
  // second correction nobody asked for.
  const seen = new Map<string, { count: number; asWritten: string }>()
  for (const line of lines) {
    const trimmed = line.text.trim()
    if (trimmed === '') continue
    const key = trimmed.toLowerCase()
    const entry = seen.get(key)
    if (entry) entry.count += 1
    else seen.set(key, { count: 1, asWritten: trimmed })
  }
  const duplicates = [...seen.values()].filter((entry) => entry.count > 1)

  const faults = blanks.length + duplicates.reduce((n, d) => n + d.count - 1, 0)
  const earned = Math.max(0, (1 - faults / lines.length)) * 8 * Math.min(1, lines.length / HYGIENE_FULL_LINES)

  const clean = faults === 0
  return category('content-hygiene', earned, {
    strengths: clean ? [`All ${lines.length} of your written lines have content and none repeat.`] : [],
    weaknesses: [
      ...(lines.length < HYGIENE_FULL_LINES
        ? [`Only ${lines.length} ${lines.length === 1 ? 'line is' : 'lines are'} written so far, so there is little to check yet.`]
        : []),
      ...(blanks.length > 0
        ? [`${blanks.length} empty ${blanks.length === 1 ? 'line prints' : 'lines print'} as a bullet with nothing after it.`]
        : []),
      ...duplicates.map((d) => `The same line appears ${d.count} times: "${truncate(d.asWritten)}".`),
    ],
    improvements: clean
      ? []
      : [
          ...(blanks.length > 0 ? ['Remove the empty lines, or write something in them.'] : []),
          ...(duplicates.length > 0
            ? ['Repeated lines read as filler. Rewrite each one to say what was different about that role.']
            : []),
        ],
  })
}

function truncate(text: string): string {
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`
}

interface ProseLine {
  readonly text: string
}

function collectProse(resume: ResumeV2): ProseLine[] {
  const out: ProseLine[] = []
  const push = (text: AuthoredText | undefined) => {
    if (!text) return
    out.push({ text: text.accepted })
  }

  for (const section of resume.sections) {
    if (!section.visible) continue
    switch (section.type) {
      case 'summary':
        if (!isBlankAuthoredText(section.text)) push(section.text)
        break
      case 'critical_care':
      case 'other_clinical':
        for (const position of section.positions) for (const bullet of position.bullets) push(bullet)
        break
      case 'shadowing':
        for (const entry of section.experiences) if (!isBlankAuthoredText(entry.reflection)) push(entry.reflection)
        break
      case 'leadership':
      case 'quality_improvement':
      case 'research':
      case 'volunteer':
        for (const entry of section.entries) if (!isBlankAuthoredText(entry.detail)) push(entry.detail)
        break
      case 'awards':
        for (const entry of section.awards) if (!isBlankAuthoredText(entry.detail)) push(entry.detail)
        break
      case 'publications':
        for (const entry of section.entries) if (!isBlankAuthoredText(entry.citation)) push(entry.citation)
        break
      case 'custom':
        for (const entry of section.entries) if (!isBlankAuthoredText(entry.detail)) push(entry.detail)
        break
      default:
        break
    }
  }

  // Bullets are collected unconditionally above so a blank one is visible here;
  // everything else is skipped when blank because an untouched optional field
  // is not a defect.
  return out
}

// ---------------------------------------------------------------------------
// Length and fit -- 6
// ---------------------------------------------------------------------------

/** Roughly how many lines a US Letter page holds at these type sizes. */
const LINES_PER_PAGE = 46
const CHARS_PER_LINE = 95

/**
 * Whether the resume sits at a workable length for what it holds.
 *
 * HAVING MORE EXPERIENCE IS NEVER THE PROBLEM. A nurse with ten years has more
 * to say than one with two, and the fix for a long resume is always to write
 * more tightly, never to remove a job. Every improvement line here says so.
 * The estimate comes from the same document plan the renderer uses, so it
 * counts what would actually print.
 */
function lengthAndFit(resume: ResumeV2): CategoryResult {
  const plan = planDocument(resume)
  if (plan.blocks.length === 0) {
    return category('length-and-fit', 0, {
      weaknesses: ['There is nothing on the resume yet to measure.'],
      improvements: ['Add your summary and clinical experience; length is judged once there is something to print.'],
    })
  }

  let lines = plan.name ? 1 : 0
  lines += plan.contact.length > 0 ? 1 : 0
  for (const block of plan.blocks) {
    lines += 2 // heading plus its breathing room
    if (block.kind === 'prose') {
      for (const paragraph of block.paragraphs) lines += wrapped(paragraph)
    } else {
      for (const entry of block.entries) {
        lines += 1 + (entry.subtitle || entry.meta ? 1 : 0) + (entry.notes.length > 0 ? 1 : 0)
        for (const detail of entry.detail) lines += wrapped(detail)
      }
    }
  }

  const pages = lines / LINES_PER_PAGE

  if (pages < 0.25) {
    return category('length-and-fit', 1, {
      weaknesses: ['The resume fills well under a quarter of a page, so it reads as an outline rather than a resume.'],
      improvements: ['Add detail to the work you have already listed — what you handled, and what you were trusted with.'],
    })
  }
  if (pages < 0.45) {
    return category('length-and-fit', 3, {
      weaknesses: ['The resume fills well under half a page, so it reads as thin next to a full one.'],
      improvements: ['Add detail to the work you have already listed — what you handled, and what you were trusted with.'],
    })
  }
  if (pages <= 2.1) {
    return category('length-and-fit', 6, {
      strengths: [`At roughly ${describePages(pages)}, the resume is a comfortable length.`],
    })
  }
  if (pages <= 3.1) {
    return category('length-and-fit', 4, {
      weaknesses: [`At roughly ${describePages(pages)}, the resume runs past the two pages most readers expect.`],
      improvements: [
        'Tighten the writing rather than cutting experience — shorter lines on your earliest roles usually recover a page.',
      ],
    })
  }
  return category('length-and-fit', 2, {
    weaknesses: [`At roughly ${describePages(pages)}, the resume is long enough that a reader will skim it.`],
    improvements: [
      'Keep every role. Shorten the lines under the oldest ones, and let your most recent critical-care work carry the detail.',
    ],
  })
}

function wrapped(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_LINE))
}

function describePages(pages: number): string {
  const rounded = Math.round(pages * 2) / 2
  return rounded <= 1 ? 'one page' : `${rounded} pages`
}
