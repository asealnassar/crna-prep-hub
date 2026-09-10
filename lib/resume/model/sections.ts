/**
 * Canonical section construction and manipulation. All pure.
 *
 * Ids and timestamps are parameters rather than generated inside, so every
 * function here is deterministic and testable -- the same discipline the
 * messaging and interview engines use.
 *
 * One rule this file deliberately does NOT implement: it never deletes an
 * empty section. Emptiness is reported (`isSectionEmpty`) so the renderer can
 * choose not to draw it, but removing a section the applicant added is a
 * product decision nobody has made.
 */

import { EMPTY_AUTHORED_TEXT, createAuthoredText, isBlankAuthoredText } from './authoredText.ts'
import type { AuthoredText } from './authoredText.ts'
import { ABSENT_DATE, EMPTY_RANGE } from './dates.ts'
import type {
  Bullet, ClinicalFacts, ClinicalPosition, GpaValue, ResumeSectionType,
  ResumeSectionV2, SectionOfType,
} from './types.ts'

/** Default headings. `label` overrides these per resume. */
export const SECTION_HEADINGS: Record<ResumeSectionType, string> = {
  summary: 'Professional Summary',
  education: 'Education',
  critical_care: 'Critical Care Experience',
  other_clinical: 'Other Clinical Experience',
  licensure: 'Licensure',
  certifications: 'Certifications',
  shadowing: 'CRNA Shadowing',
  leadership: 'Leadership & Precepting',
  quality_improvement: 'Quality Improvement',
  research: 'Research',
  organizations: 'Professional Organizations',
  awards: 'Awards & Honors',
  volunteer: 'Volunteer & Community Service',
  publications: 'Publications & Presentations',
  custom: 'Additional Information',
}

export function headingFor(section: ResumeSectionV2): string {
  if (section.label && section.label.trim() !== '') return section.label.trim()
  if (section.type === 'custom' && section.heading.trim() !== '') return section.heading.trim()
  return SECTION_HEADINGS[section.type]
}

/**
 * A GPA the applicant has not supplied.
 *
 * `showOnResume` defaults to FALSE: entering a GPA is not the same as
 * deciding to publish it. V1 printed whatever was stored with no control at
 * all, which is why a science GPA someone recorded for their own reference
 * appeared on a document they submitted.
 *
 * The V1 migration may set this to true explicitly for a GPA that already
 * rendered, so existing output is preserved -- but that is a migration
 * decision about existing documents, not the default for new ones.
 */
export function emptyGpa(): GpaValue {
  return { raw: '', value: null, showOnResume: false }
}

/**
 * Reads a GPA without rewriting it. "3.4/4.0" keeps its text and yields a null
 * value rather than being rejected or silently truncated.
 */
export function parseGpa(raw: unknown, showOnResume = false): GpaValue {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { raw: '', value: null, showOnResume }
  const exact = /^(\d)(?:\.(\d{1,3}))?$/.exec(text)
  if (!exact) return { raw: text, value: null, showOnResume }
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    return { raw: text, value: null, showOnResume }
  }
  return { raw: text, value, showOnResume }
}

export function emptyClinicalFacts(): ClinicalFacts {
  return {
    employer: '', location: '', role: '', unit: '', unitType: '', acuity: '',
    dates: EMPTY_RANGE,
    patientPopulations: [], devices: [], therapies: [],
    chargeExperience: false, preceptorExperience: false,
    committees: [], specialResponsibilities: [],
  }
}

export function createClinicalPosition(id: string, facts?: Partial<ClinicalFacts>): ClinicalPosition {
  return {
    id,
    facts: { ...emptyClinicalFacts(), ...facts },
    guided: [],
    bullets: [],
  }
}

/**
 * A new, empty section of the given type.
 *
 * Empty means empty: no seeded blank entry, and above all no `['']` bullet.
 * That single V1 initialiser is why all 41 production positions carry a blank
 * bullet and every exported PDF prints a stray dot.
 */
export function createSection<T extends ResumeSectionType>(
  type: T,
  id: string,
  options: { visible?: boolean; label?: string | null; heading?: string } = {}
): SectionOfType<T> {
  const base = {
    id,
    type,
    visible: options.visible ?? true,
    label: options.label ?? null,
  }
  switch (type) {
    case 'summary':
      return { ...base, text: EMPTY_AUTHORED_TEXT } as SectionOfType<T>
    case 'education':
    case 'leadership':
    case 'quality_improvement':
    case 'research':
    case 'volunteer':
    case 'publications':
      return { ...base, entries: [] } as unknown as SectionOfType<T>
    case 'critical_care':
    case 'other_clinical':
      return { ...base, positions: [] } as unknown as SectionOfType<T>
    case 'licensure':
      return { ...base, licenses: [] } as unknown as SectionOfType<T>
    case 'certifications':
      return { ...base, certifications: [] } as unknown as SectionOfType<T>
    case 'shadowing':
      return { ...base, experiences: [] } as unknown as SectionOfType<T>
    case 'organizations':
      return { ...base, memberships: [] } as unknown as SectionOfType<T>
    case 'awards':
      return { ...base, awards: [] } as unknown as SectionOfType<T>
    case 'custom':
      return { ...base, heading: options.heading ?? '', entries: [] } as unknown as SectionOfType<T>
    default: {
      // Exhaustiveness: adding a section type without handling it fails here.
      const never: never = type
      throw new Error(`Unhandled section type: ${String(never)}`)
    }
  }
}

/** Whether a section would render nothing. Reported, never acted on here. */
export function isSectionEmpty(section: ResumeSectionV2): boolean {
  switch (section.type) {
    case 'summary':
      return isBlankAuthoredText(section.text)
    case 'education':
      return section.entries.length === 0
    case 'critical_care':
    case 'other_clinical':
      return section.positions.length === 0
    case 'licensure':
      return section.licenses.length === 0
    case 'certifications':
      return section.certifications.length === 0
    case 'shadowing':
      return section.experiences.length === 0
    case 'organizations':
      return section.memberships.length === 0
    case 'awards':
      return section.awards.length === 0
    case 'leadership':
    case 'quality_improvement':
    case 'research':
    case 'volunteer':
    case 'publications':
    case 'custom':
      return section.entries.length === 0
    default: {
      const never: never = section
      throw new Error(`Unhandled section: ${JSON.stringify(never)}`)
    }
  }
}

/** What a renderer should draw: visible and not empty. */
export function isSectionRenderable(section: ResumeSectionV2): boolean {
  return section.visible && !isSectionEmpty(section)
}

// ---------------------------------------------------------------------------
// Text and bullets
// ---------------------------------------------------------------------------

/**
 * Collapses runs of whitespace and trims. Length is NOT touched: one live
 * summary is 4,214 characters, and normalisation must never be the thing that
 * makes existing data unrepresentable.
 */
export function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** Preserves paragraph breaks while tidying trailing space on each line. */
export function normalizeMultiline(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Drops bullets that would render as nothing.
 *
 * Applied when reading legacy data, not while editing -- a person mid-sentence
 * must be allowed an empty line. This is the filter V1 never had.
 */
export function dropBlankBullets(bullets: readonly Bullet[]): Bullet[] {
  return bullets.filter((b) => !isBlankAuthoredText(b))
}

export function createBullet(text: string, origin: 'user' | 'import' = 'user'): Bullet {
  return createAuthoredText(text, origin)
}

/** Every piece of authored text in a section, for provenance and scoring. */
export function authoredTextsIn(section: ResumeSectionV2): AuthoredText[] {
  switch (section.type) {
    case 'summary': return [section.text]
    case 'critical_care':
    case 'other_clinical':
      return section.positions.flatMap((p) => [
        ...p.guided.map((g) => g.answer),
        ...p.bullets,
      ])
    case 'shadowing': return section.experiences.map((e) => e.reflection)
    case 'leadership': return section.entries.map((e) => e.detail)
    case 'quality_improvement':
    case 'research':
      return section.entries.map((e) => e.detail)
    case 'awards': return section.awards.map((a) => a.detail)
    case 'volunteer': return section.entries.map((e) => e.detail)
    case 'publications': return section.entries.map((e) => e.citation)
    case 'custom': return section.entries.map((e) => e.detail)
    case 'education':
    case 'licensure':
    case 'certifications':
    case 'organizations':
      return []
    default: {
      const never: never = section
      throw new Error(`Unhandled section: ${JSON.stringify(never)}`)
    }
  }
}
