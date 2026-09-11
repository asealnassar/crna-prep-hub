/**
 * Canonical resume in, presentation-ready plan out. Pure, and the only place
 * that decides what a resume actually says.
 *
 * TWO PRIMITIVES, NOT FIFTEEN LAYOUTS. Every one of the fifteen section types
 * reduces to either `prose` (a run of paragraphs) or `entries` (titled items
 * with dates and detail lines). A resume genuinely is that shape, and the
 * reduction is what makes "all three templates render every section type"
 * provable rather than a matter of inspection: a template that handles both
 * primitives handles everything, forever, including section types added later.
 * Per-type knowledge lives in the mappers below, which is where it belongs --
 * they know that a licence has a state and a publication has a venue, and the
 * presenters never need to.
 *
 * WHAT MUST NOT RENDER. ClinicalFacts is AI grounding, not resume content. V1
 * printed the checkbox arrays as "Skills & Equipment: ventilators, CRRT, ..."
 * whenever a position had no bullets -- which in production was every position.
 * The mapper here takes only the identity of a job (employer, role, unit,
 * location, dates) and its written bullets. The populations, devices,
 * therapies, acuity grading, committee flags and responsibility lists are
 * deliberately unreachable from this module's output. See `positionEntry`.
 */

import { headingFor, isSectionRenderable } from '../model/sections.ts'
import { isBlankAuthoredText } from '../model/authoredText.ts'
import type { AuthoredText } from '../model/authoredText.ts'
import type {
  AwardEntry, CertificationEntry, ClinicalPosition, CustomEntry, EducationEntry,
  LeadershipEntry, LicenseEntry, MembershipEntry, ProjectEntry,
  PublicationEntry, ResumeSectionType, ResumeSectionV2, ResumeV2,
  ShadowingEntry, VolunteerEntry,
} from '../model/types.ts'
import {
  atsText, contactPieces, formatDateRange, formatGpa, formatName,
  formatResumeDate, join, paragraphsOf,
} from './format.ts'

/** One titled item: a job, a degree, a certification, an award. */
export interface DocumentEntry {
  readonly id: string
  /** The thing itself: an employer, a credential, a paper's title. */
  readonly title: string
  /** Who or where: a role, an institution, an issuer. */
  readonly subtitle: string
  /** Secondary and usually right-aligned. Dates, almost always. */
  readonly meta: string
  readonly location: string
  /** Short facts that sit under the header: a GPA, a licence number. */
  readonly notes: readonly string[]
  /** Bullets or paragraphs. The written part. */
  readonly detail: readonly string[]
}

interface BlockBase {
  readonly sectionId: string
  readonly sectionType: ResumeSectionType
  readonly heading: string
}

export type DocumentBlock =
  | (BlockBase & { readonly kind: 'prose'; readonly paragraphs: readonly string[] })
  | (BlockBase & { readonly kind: 'entries'; readonly entries: readonly DocumentEntry[] })

export interface DocumentPlan {
  /** "Jane Doe, BSN, RN, CCRN". Empty when the applicant has not filled it in. */
  readonly name: string
  /** Email, phone, location, links — blanks already removed. */
  readonly contact: readonly string[]
  readonly blocks: readonly DocumentBlock[]
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const EMPTY_ENTRY: Omit<DocumentEntry, 'id'> = {
  title: '', subtitle: '', meta: '', location: '', notes: [], detail: [],
}

function entry(id: string, over: Partial<Omit<DocumentEntry, 'id'>>): DocumentEntry {
  const built = { id, ...EMPTY_ENTRY, ...over }
  // Normalised here, once, so every one of the fifteen mappers gets it and no
  // future mapper can forget. See `atsText`.
  return {
    ...built,
    title: atsText(built.title),
    subtitle: atsText(built.subtitle),
    meta: atsText(built.meta),
    location: atsText(built.location),
    notes: built.notes.map(atsText).filter((n) => n.trim() !== ''),
    detail: built.detail.map(atsText).filter((d) => d.trim() !== ''),
  }
}

/** An entry with nothing in any field prints as a blank line. Drop it. */
function isEntryEmpty(e: DocumentEntry): boolean {
  return (
    e.title.trim() === '' && e.subtitle.trim() === '' && e.meta.trim() === '' &&
    e.location.trim() === '' && e.notes.length === 0 && e.detail.length === 0
  )
}

/** The rendered form of authored text: what was accepted, never the proposal. */
function accepted(text: AuthoredText): string[] {
  return isBlankAuthoredText(text) ? [] : paragraphsOf(text.accepted).map(atsText)
}

// ---------------------------------------------------------------------------
// One mapper per section type
// ---------------------------------------------------------------------------

function educationEntry(e: EducationEntry): DocumentEntry {
  return entry(e.id, {
    title: join([e.degree, e.field], ', '),
    subtitle: e.institution,
    meta: formatResumeDate(e.graduationDate),
    location: e.location,
    notes: [formatGpa(e.overallGpa), formatGpa(e.scienceGpa, 'Science GPA'), e.honors],
  })
}

/**
 * A clinical position: who employed them, in what role, when — and the bullets
 * they wrote. Nothing else from ClinicalFacts reaches the page.
 *
 * `employer`, `role`, `unit`, `location` and `dates` are the identity of a job
 * and belong on a resume. `patientPopulations`, `devices`, `therapies`,
 * `unitType`, `acuity`, `chargeExperience`, `preceptorExperience`, `committees`
 * and `specialResponsibilities` are the grounding an AI proposal is checked
 * against; they reach the page only once a person has written them into a
 * bullet and accepted it.
 */
function positionEntry(p: ClinicalPosition): DocumentEntry {
  return entry(p.id, {
    title: p.facts.employer,
    subtitle: join([p.facts.role, p.facts.unit], ' · '),
    meta: formatDateRange(p.facts.dates),
    location: p.facts.location,
    detail: p.bullets.flatMap(accepted),
  })
}

function licenseEntry(l: LicenseEntry): DocumentEntry {
  const expires = formatResumeDate(l.expires)
  return entry(l.id, {
    title: join([l.licenseType, l.state], ' — '),
    meta: expires === '' ? '' : `Expires ${expires}`,
    notes: [l.identifier, l.isCompact ? 'Multistate compact' : ''],
  })
}

function certificationEntry(c: CertificationEntry): DocumentEntry {
  const earned = formatResumeDate(c.earned)
  const expires = formatResumeDate(c.expires)
  return entry(c.id, {
    title: c.name,
    subtitle: c.issuer,
    meta: expires === '' ? earned : join([earned, `exp. ${expires}`], ' · '),
    notes: [c.identifier],
  })
}

function shadowingEntry(s: ShadowingEntry): DocumentEntry {
  return entry(s.id, {
    title: join([s.providerName, s.credential], ', '),
    subtitle: join([s.setting, s.facility], ' · '),
    meta: join([formatDateRange(s.dates), s.hours === '' ? '' : `${s.hours} hours`], ' · '),
    detail: accepted(s.reflection),
  })
}

function leadershipEntry(l: LeadershipEntry): DocumentEntry {
  return entry(l.id, {
    title: l.role,
    subtitle: l.organization,
    meta: formatDateRange(l.dates),
    detail: accepted(l.detail),
  })
}

function projectEntry(p: ProjectEntry): DocumentEntry {
  return entry(p.id, {
    title: p.title,
    subtitle: join([p.role, p.organization], ' · '),
    meta: formatDateRange(p.dates),
    detail: accepted(p.detail),
  })
}

function membershipEntry(m: MembershipEntry): DocumentEntry {
  return entry(m.id, {
    title: m.organization,
    subtitle: m.role,
    meta: formatDateRange(m.dates),
  })
}

function awardEntry(a: AwardEntry): DocumentEntry {
  return entry(a.id, {
    title: a.title,
    subtitle: a.issuer,
    meta: formatResumeDate(a.awarded),
    detail: accepted(a.detail),
  })
}

function volunteerEntry(v: VolunteerEntry): DocumentEntry {
  return entry(v.id, {
    title: v.role,
    subtitle: v.organization,
    meta: formatDateRange(v.dates),
    detail: accepted(v.detail),
  })
}

function publicationEntry(p: PublicationEntry): DocumentEntry {
  return entry(p.id, {
    title: p.title,
    subtitle: join([p.kind, p.venue], ' · '),
    meta: formatResumeDate(p.date),
    detail: accepted(p.citation),
  })
}

function customEntry(c: CustomEntry): DocumentEntry {
  return entry(c.id, { title: c.title, detail: accepted(c.detail) })
}

// ---------------------------------------------------------------------------
// Section -> block
// ---------------------------------------------------------------------------

function prose(section: ResumeSectionV2, paragraphs: readonly string[]): DocumentBlock | null {
  if (paragraphs.length === 0) return null
  return {
    kind: 'prose', sectionId: section.id, sectionType: section.type,
    heading: headingFor(section), paragraphs,
  }
}

function entries(section: ResumeSectionV2, list: readonly DocumentEntry[]): DocumentBlock | null {
  const kept = list.filter((e) => !isEntryEmpty(e))
  if (kept.length === 0) return null
  return {
    kind: 'entries', sectionId: section.id, sectionType: section.type,
    heading: headingFor(section), entries: kept,
  }
}

/**
 * One section as a block, or null when it would print nothing.
 *
 * Returning null for a section the model calls non-empty is deliberate and not
 * redundant: a section can hold entries whose every field is blank, and the
 * model's emptiness check counts entries rather than inspecting them.
 */
export function blockFor(section: ResumeSectionV2): DocumentBlock | null {
  switch (section.type) {
    case 'summary':
      return prose(section, accepted(section.text))
    case 'education':
      return entries(section, section.entries.map(educationEntry))
    case 'critical_care':
    case 'other_clinical':
      return entries(section, section.positions.map(positionEntry))
    case 'licensure':
      return entries(section, section.licenses.map(licenseEntry))
    case 'certifications':
      return entries(section, section.certifications.map(certificationEntry))
    case 'shadowing':
      return entries(section, section.experiences.map(shadowingEntry))
    case 'leadership':
      return entries(section, section.entries.map(leadershipEntry))
    case 'quality_improvement':
    case 'research':
      return entries(section, section.entries.map(projectEntry))
    case 'organizations':
      return entries(section, section.memberships.map(membershipEntry))
    case 'awards':
      return entries(section, section.awards.map(awardEntry))
    case 'volunteer':
      return entries(section, section.entries.map(volunteerEntry))
    case 'publications':
      return entries(section, section.entries.map(publicationEntry))
    case 'custom':
      return entries(section, section.entries.map(customEntry))
    default: {
      // A new section type must be given a mapper here, not silently dropped.
      const never: never = section
      throw new Error(`Unhandled section: ${JSON.stringify(never)}`)
    }
  }
}

/**
 * The whole document.
 *
 * Array order IS display order -- `renderableSections` preserves it, so a
 * reorder in the Studio needs nothing here. Hidden and empty sections are gone
 * before any mapper runs.
 */
export function planDocument(resume: ResumeV2): DocumentPlan {
  const blocks: DocumentBlock[] = []
  for (const section of resume.sections) {
    if (!isSectionRenderable(section)) continue
    const block = blockFor(section)
    if (block) blocks.push(block)
  }

  return {
    name: atsText(formatName(resume.contact)),
    contact: contactPieces(resume.contact).map(atsText),
    blocks,
  }
}

/** Every string the plan would print. The basis of "this never reaches paper". */
export function textOf(plan: DocumentPlan): string[] {
  const out: string[] = [plan.name, ...plan.contact]
  for (const block of plan.blocks) {
    out.push(block.heading)
    if (block.kind === 'prose') {
      out.push(...block.paragraphs)
    } else {
      for (const e of block.entries) {
        out.push(e.title, e.subtitle, e.meta, e.location, ...e.notes, ...e.detail)
      }
    }
  }
  return out.filter((s) => s.trim() !== '')
}
