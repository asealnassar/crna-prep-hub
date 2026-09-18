/**
 * The canonical V2 resume.
 *
 * One record, projected by everything downstream: the Studio, autosave, AI,
 * Resume Strength, the shared document renderer, PDF, DOCX and import. If a
 * fact is not expressible here it cannot appear on a resume.
 *
 * Two deviations from the blueprint, both deliberate:
 *
 *   - Section ORDER is the array order, not a separate `sectionOrder` list.
 *     Two sources of truth desync, and V1 already demonstrates the failure:
 *     it writes `order_index` on every row and never reads it back.
 *
 *   - Sections are a discriminated union on `type` rather than a
 *     `Record<string, any>` blob, so adding a section type is a compile error
 *     everywhere it must be handled instead of a silent gap.
 */

import type { AuthoredText } from './authoredText.ts'
import type { ResumeDate, ResumeDateRange } from './dates.ts'

export type ResumeStatus = 'draft' | 'complete'

/** Creative and ATS-Optimized are retired; ATS safety is a property of all. */
export type ResumeTemplate = 'classic' | 'modern' | 'compact'

export type ResumeSectionType =
  | 'summary'
  | 'education'
  | 'critical_care'
  | 'other_clinical'
  | 'licensure'
  | 'certifications'
  | 'shadowing'
  | 'leadership'
  | 'quality_improvement'
  | 'research'
  | 'organizations'
  | 'awards'
  | 'volunteer'
  | 'publications'
  | 'custom'

/** Every section type, in the order a new resume lays them out. */
export const SECTION_TYPES: readonly ResumeSectionType[] = [
  'summary', 'education', 'critical_care', 'other_clinical', 'licensure',
  'certifications', 'shadowing', 'leadership', 'quality_improvement',
  'research', 'organizations', 'awards', 'volunteer', 'publications', 'custom',
]

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/**
 * A GPA keeps the applicant's own text alongside a parsed number.
 *
 * V1 stored GPA as a free string and printed it verbatim. Keeping `raw` means
 * "3.4/4.0" or "3.85 (major)" survives untouched while `value` stays null,
 * rather than the entry being rejected or silently rewritten.
 */
export interface GpaValue {
  readonly raw: string
  readonly value: number | null
  /**
   * Whether this GPA appears on the rendered resume. V1 printed whatever was
   * entered with no control; this is the switch that was missing.
   */
  readonly showOnResume: boolean
}

/** A bullet is authored text, so every line carries its own provenance. */
export type Bullet = AuthoredText

/**
 * One guided prompt and the applicant's answer to it. Kept separate from
 * `bullets` on purpose: this is raw material a person supplied, not output.
 */
export interface GuidedResponse {
  readonly promptId: string
  readonly answer: AuthoredText
}

// ---------------------------------------------------------------------------
// Section entries
// ---------------------------------------------------------------------------

export interface EducationEntry {
  readonly id: string
  readonly degree: string
  readonly field: string
  readonly institution: string
  readonly location: string
  /**
   * When the degree started.
   *
   * OPTIONAL IN THE TYPE ON PURPOSE. Records written before education had a
   * start date do not carry one, and nothing rewrites a stored row to add it:
   * a reader treats a missing start as absent and prints the graduation date
   * alone, exactly as it always did.
   */
  readonly startDate?: ResumeDate
  /** When it finished. The end of the span, and the date a resume calls graduation. */
  readonly graduationDate: ResumeDate
  readonly overallGpa: GpaValue
  readonly scienceGpa: GpaValue
  readonly honors: string
}

/**
 * Structured clinical facts for one position.
 *
 * These are AI GROUNDING, not output. V1 rendered the checkbox arrays straight
 * onto the resume as "Skills & Equipment: ..." lines whenever bullets were
 * missing -- which, in production, was every single position.
 */
export interface ClinicalFacts {
  readonly employer: string
  readonly location: string
  readonly role: string
  readonly unit: string
  readonly unitType: string
  readonly acuity: string
  readonly dates: ResumeDateRange
  readonly patientPopulations: readonly string[]
  readonly devices: readonly string[]
  readonly therapies: readonly string[]
  readonly chargeExperience: boolean
  readonly preceptorExperience: boolean
  readonly committees: readonly string[]
  readonly specialResponsibilities: readonly string[]
}

export interface ClinicalPosition {
  readonly id: string
  readonly facts: ClinicalFacts
  /** What the applicant told us, in their words, before anything is written. */
  readonly guided: readonly GuidedResponse[]
  /** What renders. Each carries its own source, origin and history. */
  readonly bullets: readonly Bullet[]
}

export interface CertificationEntry {
  readonly id: string
  /** A code like CCRN, or free text for anything not in the picker. */
  readonly name: string
  readonly issuer: string
  readonly identifier: string
  readonly earned: ResumeDate
  readonly expires: ResumeDate
}

export interface LicenseEntry {
  readonly id: string
  readonly licenseType: string
  readonly state: string
  readonly identifier: string
  readonly isCompact: boolean
  readonly expires: ResumeDate
}

export interface ShadowingEntry {
  readonly id: string
  readonly providerName: string
  readonly credential: string
  readonly setting: string
  readonly facility: string
  /** Kept as text: V1 stored hours as a string, and "40+" must survive. */
  readonly hours: string
  readonly dates: ResumeDateRange
  readonly reflection: AuthoredText
}

/** Leadership, precepting and committee work, with real structure. */
export interface LeadershipEntry {
  readonly id: string
  readonly role: string
  readonly organization: string
  readonly dates: ResumeDateRange
  readonly detail: AuthoredText
}

/** Shared by Quality Improvement and Research -- separate sections, one shape. */
export interface ProjectEntry {
  readonly id: string
  readonly title: string
  readonly role: string
  readonly organization: string
  readonly dates: ResumeDateRange
  readonly detail: AuthoredText
}

export interface MembershipEntry {
  readonly id: string
  readonly organization: string
  readonly role: string
  readonly dates: ResumeDateRange
}

export interface AwardEntry {
  readonly id: string
  readonly title: string
  readonly issuer: string
  readonly awarded: ResumeDate
  readonly detail: AuthoredText
}

export interface VolunteerEntry {
  readonly id: string
  readonly role: string
  readonly organization: string
  readonly dates: ResumeDateRange
  readonly detail: AuthoredText
}

export interface PublicationEntry {
  readonly id: string
  readonly title: string
  readonly venue: string
  readonly kind: string
  readonly date: ResumeDate
  readonly citation: AuthoredText
}

export interface CustomEntry {
  readonly id: string
  readonly title: string
  readonly detail: AuthoredText
  /**
   * Set only on an item waiting in "Imported items to review": where the import
   * thought it might belong. A suggestion, never a placement -- see
   * lib/resume/model/importReview.ts.
   */
  readonly importItem?: ImportItemMeta
}

/**
 * Where an imported item looks like it belongs, when the document's layout said.
 *
 * The applicant chooses. A suggestion pre-selects a destination; it never moves
 * anything on its own.
 */
export type ImportSuggestion =
  | { readonly kind: 'bullet'; readonly positionId: string | null }
  | { readonly kind: 'summary' }
  | { readonly kind: 'section'; readonly sectionType: ResumeSectionType }
  | { readonly kind: 'none' }

export interface ImportItemMeta {
  /** The line of the uploaded document it came from. */
  readonly sourceLine: number | null
  readonly suggestion: ImportSuggestion
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface SectionBase<T extends ResumeSectionType> {
  readonly id: string
  readonly type: T
  /** Hidden sections keep their data and do not render. */
  readonly visible: boolean
  /** Overrides the default heading. null means use the default. */
  readonly label: string | null
  /**
   * Which column this section sits in on a two-column template.
   *
   * OPTIONAL, AND ABOUT LAYOUT ONLY. Absent means "whatever the template
   * decides", which is what every existing record says and what a new section
   * says until someone moves it. Single-column templates ignore it entirely, so
   * a resume that visits Modern, goes to Classic and comes back still remembers
   * where its sections were put.
   *
   * It is stored inside the section payload, so it needs no column and no
   * migration -- see toSavePayload in lib/resume/repo/rows.ts.
   */
  readonly modernColumn?: 'sidebar' | 'main'
}

export interface ProfessionalSummarySection extends SectionBase<'summary'> {
  readonly text: AuthoredText
}
export interface EducationSection extends SectionBase<'education'> {
  readonly entries: readonly EducationEntry[]
}
export interface CriticalCareExperienceSection extends SectionBase<'critical_care'> {
  readonly positions: readonly ClinicalPosition[]
}
export interface OtherClinicalExperienceSection extends SectionBase<'other_clinical'> {
  readonly positions: readonly ClinicalPosition[]
}
export interface LicensureSection extends SectionBase<'licensure'> {
  readonly licenses: readonly LicenseEntry[]
}
export interface CertificationSection extends SectionBase<'certifications'> {
  readonly certifications: readonly CertificationEntry[]
}
export interface ShadowingSection extends SectionBase<'shadowing'> {
  readonly experiences: readonly ShadowingEntry[]
}
export interface LeadershipSection extends SectionBase<'leadership'> {
  readonly entries: readonly LeadershipEntry[]
}
export interface QualityImprovementSection extends SectionBase<'quality_improvement'> {
  readonly entries: readonly ProjectEntry[]
}
export interface ResearchSection extends SectionBase<'research'> {
  readonly entries: readonly ProjectEntry[]
}
export interface ProfessionalOrganizationSection extends SectionBase<'organizations'> {
  readonly memberships: readonly MembershipEntry[]
}
export interface AwardsSection extends SectionBase<'awards'> {
  readonly awards: readonly AwardEntry[]
}
export interface VolunteerSection extends SectionBase<'volunteer'> {
  readonly entries: readonly VolunteerEntry[]
}
export interface PublicationPresentationSection extends SectionBase<'publications'> {
  readonly entries: readonly PublicationEntry[]
}
export interface CustomSection extends SectionBase<'custom'> {
  /** Custom sections name themselves; `label` still overrides for display. */
  readonly heading: string
  readonly entries: readonly CustomEntry[]
  /**
   * Marks the section holding imported text still to be placed. It is kept in
   * the section's own JSON, so it needs no column and no migration, and it never
   * prints whatever its visibility says.
   */
  readonly importReview?: boolean
}

export type ResumeSectionV2 =
  | ProfessionalSummarySection
  | EducationSection
  | CriticalCareExperienceSection
  | OtherClinicalExperienceSection
  | LicensureSection
  | CertificationSection
  | ShadowingSection
  | LeadershipSection
  | QualityImprovementSection
  | ResearchSection
  | ProfessionalOrganizationSection
  | AwardsSection
  | VolunteerSection
  | PublicationPresentationSection
  | CustomSection

/** Narrowing helper: `SectionOfType<'education'>` is EducationSection. */
export type SectionOfType<T extends ResumeSectionType> = Extract<ResumeSectionV2, { type: T }>

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/** Header identity. Fixed position on the document; not a reorderable section. */
export interface ResumeContact {
  readonly fullName: string
  readonly credentials: string
  readonly email: string
  readonly phone: string
  readonly city: string
  readonly state: string
  readonly linkedin: string
  readonly website: string
}

/**
 * Where an imported resume came from.
 *
 * Deliberately holds no file and no storage key -- only a fingerprint of the
 * extracted text. That keeps the model valid whether or not original-file
 * retention is later adopted; if it is, a storage reference is an additive
 * field rather than a reshaping.
 */
export interface ImportReference {
  readonly importId: string
  /**
   * 'v1' is the legacy migration: the record came from this product's own V1
   * builder rather than from a file anyone uploaded. Added rather than reusing
   * 'pdf', because seventeen real records asserting they came from a PDF they
   * never came from is the kind of quiet untruth this model exists to prevent.
   */
  readonly sourceFormat: 'pdf' | 'docx' | 'v1'
  readonly documentFingerprint: string
  readonly importedAt: string
  readonly originalRetained: boolean
}

/**
 * A computed Resume Strength result, attached to the revision it was computed
 * against so staleness is visible. Categories and weights are undecided, so
 * nothing about them is encoded here.
 */
export interface ResumeStrengthRef {
  readonly score: number
  readonly computedAtRevision: number
  readonly computedAt: string
}

export interface ResumeV2 {
  readonly schemaVersion: 2
  readonly id: string
  readonly userId: string
  readonly title: string
  readonly status: ResumeStatus
  readonly template: ResumeTemplate
  readonly contact: ResumeContact
  /** Array order IS display order. */
  readonly sections: readonly ResumeSectionV2[]
  /** Optimistic concurrency; a save must name the revision it read. */
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly importedFrom: ImportReference | null
  /**
   * When this resume's finished output was locked, and null while it is not.
   *
   * Set once, by the applicant choosing "Not now" at the upgrade modal after a
   * download attempt -- never by opening the Studio, editing, or closing that
   * modal another way. It blurs the finished document for a tier that cannot
   * download it, and has no effect at all on Ultimate. Persisted in the
   * reserved `__meta__` section row; see lib/resume/repo/rows.ts.
   */
  readonly outputLockedAt?: string | null
  readonly strength: ResumeStrengthRef | null
}
