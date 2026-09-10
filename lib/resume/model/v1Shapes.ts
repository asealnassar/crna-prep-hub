/**
 * V1 compatibility readers.
 *
 * SCOPE BOUNDARY. This file reads V1's stored JSON into safe, normalised
 * intermediates. It does NOT map them onto ResumeV2 -- that mapper, its
 * fixtures and its round-trip assertions are a later phase, and it needs
 * decisions (Draft vs Complete, GPA visibility defaults) that have not been
 * made. What Phase 1 needs is proof that V1's real data can be read without
 * throwing and without losing anything, which is what lives here.
 *
 * Everything is defensive because the input is production JSON with no schema
 * behind it. Phase 0 measured what that means in practice:
 *
 *   - every one of 41 bullet arrays is `['']` -- a blank string, not absent
 *   - 22% of position dates and 35% of graduation dates are empty or unparseable
 *   - `other_degrees[]` carries `gpa` and `graduation_date` that V1 never renders
 *   - `volunteer_work` was collected by the UI and never persisted at all
 *   - one professional summary is 4,214 characters
 *
 * No reader here throws, invents a default clinical fact, or corrects a value.
 * Unknown keys are preserved by `extras` so a future mapper can decide about
 * them rather than discovering they were dropped.
 */

import { parseResumeDate, parseResumeDateRange } from './dates.ts'
import type { ResumeDate, ResumeDateRange } from './dates.ts'

/** V1's seven section types. Nothing else was ever written. */
export const V1_SECTION_TYPES = [
  'personal', 'education', 'certifications',
  'icu_experience', 'shadowing', 'leadership', 'research',
] as const
export type V1SectionType = (typeof V1_SECTION_TYPES)[number]

export function isV1SectionType(value: unknown): value is V1SectionType {
  return typeof value === 'string' && (V1_SECTION_TYPES as readonly string[]).includes(value)
}

// --- primitive readers -----------------------------------------------------

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function bool(value: unknown): boolean {
  return value === true
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
/** Strings only, blanks removed -- V1 checkbox arrays are string arrays. */
function strArray(value: unknown): string[] {
  return arr(value)
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '')
}
/** Keys we did not read, kept so a future mapper can decide about them. */
function extrasOf(source: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(source)) if (!known.includes(k)) out[k] = v
  return out
}

// --- section shapes --------------------------------------------------------

export interface V1Personal {
  fullName: string; email: string; phone: string
  city: string; state: string; linkedin: string
  professionalSummary: string
  extras: Record<string, unknown>
}

const PERSONAL_KEYS = ['full_name','email','phone','city','state','linkedin','professional_summary']

export function readV1Personal(data: unknown): V1Personal {
  const d = obj(data)
  return {
    fullName: str(d.full_name),
    email: str(d.email),
    phone: str(d.phone),
    city: str(d.city),
    state: str(d.state),
    linkedin: str(d.linkedin),
    // NOT truncated. One live value is 4,214 characters.
    professionalSummary: str(d.professional_summary),
    extras: extrasOf(d, PERSONAL_KEYS),
  }
}

export interface V1Degree {
  degree: string; field: string; university: string
  graduationDate: ResumeDate
  overallGpaRaw: string; scienceGpaRaw: string; gpaRaw: string
  extras: Record<string, unknown>
}

export interface V1Education {
  nursingDegree: V1Degree
  otherDegrees: V1Degree[]
  extras: Record<string, unknown>
}

const DEGREE_KEYS = ['degree','field','university','graduation_date','overall_gpa','science_gpa','gpa']

function readV1Degree(value: unknown): V1Degree {
  const d = obj(value)
  return {
    degree: str(d.degree),
    field: str(d.field),
    university: str(d.university),
    graduationDate: parseResumeDate(d.graduation_date),
    overallGpaRaw: str(d.overall_gpa),
    scienceGpaRaw: str(d.science_gpa),
    // other_degrees[] stores this and V1 renders it nowhere. Read, not dropped.
    gpaRaw: str(d.gpa),
    extras: extrasOf(d, DEGREE_KEYS),
  }
}

export function readV1Education(data: unknown): V1Education {
  const d = obj(data)
  return {
    nursingDegree: readV1Degree(d.nursing_degree),
    otherDegrees: arr(d.other_degrees).map(readV1Degree),
    extras: extrasOf(d, ['nursing_degree', 'other_degrees']),
  }
}

export interface V1Certifications {
  certifications: string[]
  customCertifications: string[]
  extras: Record<string, unknown>
}

export function readV1Certifications(data: unknown): V1Certifications {
  const d = obj(data)
  return {
    certifications: strArray(d.certifications),
    customCertifications: strArray(d.custom_certifications),
    extras: extrasOf(d, ['certifications', 'custom_certifications']),
  }
}

export interface V1Position {
  position: string; unitType: string; hospital: string; location: string
  acuity: string
  dates: ResumeDateRange
  devices: string[]; patientPopulation: string[]
  /** Blanks already removed. In live data this is ALWAYS empty. */
  bullets: string[]
  /** How many raw entries existed before blanks were dropped. */
  rawBulletCount: number
  extras: Record<string, unknown>
}

const POSITION_KEYS = [
  'position','unit_type','hospital','location','acuity','start_date','end_date',
  'is_current','devices','patient_population','bullet_points',
]

export function readV1Position(value: unknown): V1Position {
  const p = obj(value)
  const rawBullets = arr(p.bullet_points)
  return {
    position: str(p.position),
    unitType: str(p.unit_type),
    hospital: str(p.hospital),
    location: str(p.location),
    acuity: str(p.acuity),
    dates: parseResumeDateRange({
      start: p.start_date, end: p.end_date, isCurrent: p.is_current,
    }),
    devices: strArray(p.devices),
    patientPopulation: strArray(p.patient_population),
    bullets: strArray(p.bullet_points),
    rawBulletCount: rawBullets.length,
    extras: extrasOf(p, POSITION_KEYS),
  }
}

export interface V1IcuExperience {
  positions: V1Position[]
  extras: Record<string, unknown>
}

export function readV1IcuExperience(data: unknown): V1IcuExperience {
  const d = obj(data)
  return {
    positions: arr(d.positions).map(readV1Position),
    extras: extrasOf(d, ['positions']),
  }
}

export interface V1Shadowing {
  experiences: Array<{
    crnaName: string; hours: string; setting: string; description: string
    extras: Record<string, unknown>
  }>
  extras: Record<string, unknown>
}

export function readV1Shadowing(data: unknown): V1Shadowing {
  const d = obj(data)
  return {
    experiences: arr(d.experiences).map((value) => {
      const e = obj(value)
      return {
        crnaName: str(e.crna_name),
        // Kept as text: V1 stored hours as a string, and "40+" must survive.
        hours: str(e.hours),
        setting: str(e.setting),
        description: str(e.description),
        extras: extrasOf(e, ['crna_name', 'hours', 'setting', 'description']),
      }
    }),
    extras: extrasOf(d, ['experiences']),
  }
}

export interface V1Leadership { roles: string[]; extras: Record<string, unknown> }

export function readV1Leadership(data: unknown): V1Leadership {
  const d = obj(data)
  return { roles: strArray(d.roles), extras: extrasOf(d, ['roles']) }
}

export interface V1Research { projects: string[]; extras: Record<string, unknown> }

export function readV1Research(data: unknown): V1Research {
  const d = obj(data)
  return { projects: strArray(d.projects), extras: extrasOf(d, ['projects']) }
}

// --- dispatch --------------------------------------------------------------

export type V1SectionData =
  | { type: 'personal'; data: V1Personal }
  | { type: 'education'; data: V1Education }
  | { type: 'certifications'; data: V1Certifications }
  | { type: 'icu_experience'; data: V1IcuExperience }
  | { type: 'shadowing'; data: V1Shadowing }
  | { type: 'leadership'; data: V1Leadership }
  | { type: 'research'; data: V1Research }

/**
 * Reads one V1 section row. Returns null for a section type V1 never wrote,
 * rather than throwing -- an unrecognised row is a thing to report, not a
 * reason to abandon a migration mid-resume.
 */
export function readV1Section(sectionType: unknown, sectionData: unknown): V1SectionData | null {
  if (!isV1SectionType(sectionType)) return null
  switch (sectionType) {
    case 'personal': return { type: 'personal', data: readV1Personal(sectionData) }
    case 'education': return { type: 'education', data: readV1Education(sectionData) }
    case 'certifications': return { type: 'certifications', data: readV1Certifications(sectionData) }
    case 'icu_experience': return { type: 'icu_experience', data: readV1IcuExperience(sectionData) }
    case 'shadowing': return { type: 'shadowing', data: readV1Shadowing(sectionData) }
    case 'leadership': return { type: 'leadership', data: readV1Leadership(sectionData) }
    case 'research': return { type: 'research', data: readV1Research(sectionData) }
  }
}

/** What a migration would need a human to look at. Reported, never fixed. */
export interface V1ReadIssue {
  readonly path: string
  readonly kind: 'unparsed-date' | 'missing-date' | 'blank-bullets' | 'unknown-section' | 'extra-keys'
  readonly detail: string
}

export function v1SectionIssues(section: V1SectionData, resumeId: string): V1ReadIssue[] {
  const issues: V1ReadIssue[] = []
  const at = (rest: string) => `${resumeId}/${section.type}${rest}`

  if (section.type === 'icu_experience') {
    section.data.positions.forEach((p, i) => {
      if (p.dates.start.kind === 'unparsed') {
        issues.push({ path: at(`/positions#${i}/start_date`), kind: 'unparsed-date', detail: p.dates.start.raw })
      } else if (p.dates.start.kind === 'absent') {
        issues.push({ path: at(`/positions#${i}/start_date`), kind: 'missing-date', detail: '' })
      }
      if (!p.dates.isCurrent) {
        if (p.dates.end.kind === 'unparsed') {
          issues.push({ path: at(`/positions#${i}/end_date`), kind: 'unparsed-date', detail: p.dates.end.raw })
        } else if (p.dates.end.kind === 'absent') {
          issues.push({ path: at(`/positions#${i}/end_date`), kind: 'missing-date', detail: '' })
        }
      }
      if (p.rawBulletCount > 0 && p.bullets.length === 0) {
        issues.push({ path: at(`/positions#${i}/bullet_points`), kind: 'blank-bullets', detail: `${p.rawBulletCount} blank` })
      }
    })
  }

  if (section.type === 'education') {
    const d = section.data.nursingDegree.graduationDate
    if (d.kind === 'unparsed') {
      issues.push({ path: at('/nursing_degree/graduation_date'), kind: 'unparsed-date', detail: d.raw })
    } else if (d.kind === 'absent') {
      issues.push({ path: at('/nursing_degree/graduation_date'), kind: 'missing-date', detail: '' })
    }
  }

  return issues
}
