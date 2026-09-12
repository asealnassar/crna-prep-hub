/**
 * V1 resume -> V2 resume. Pure, and the only place the mapping lives.
 *
 * THE RULE THIS FILE IS BUILT AROUND: every string in the output came from the
 * input. Nothing is invented, nothing is tidied, nothing is corrected. A date
 * nobody can parse is carried across exactly as the applicant typed it; a
 * summary of 4,214 characters arrives at 4,214 characters; a blank bullet
 * becomes no bullet rather than a placeholder.
 *
 * WHAT IT REFUSES TO DECIDE. Where a legacy shape is genuinely ambiguous --
 * two rows of the same section type, a value with no V2 home -- it reports and
 * stops rather than guessing. `needs-review` is a successful outcome of this
 * function, not a failure of it: the alternative is silently choosing which of
 * someone's two education sections to keep.
 *
 * NOTHING HERE TOUCHES A DATABASE. It reads rows it is handed and returns a
 * resume. The V1 records are not read back, not written, and not deleted -- at
 * cutover they stay exactly as they are and are the rollback.
 */

import { createResume } from '../model/resume.ts'
import { createAuthoredText } from '../model/authoredText.ts'
import { createClinicalPosition, createSection, parseGpa } from '../model/sections.ts'
import { parseResumeDate } from '../model/dates.ts'
import type { ResumeDate } from '../model/dates.ts'
import type { ImportReference, ResumeSectionV2, ResumeTemplate, ResumeV2 } from '../model/types.ts'
import {
  V1_SECTION_TYPES, isV1SectionType, readV1Section, v1SectionIssues,
} from '../model/v1Shapes.ts'
import type { V1SectionData, V1SectionType } from '../model/v1Shapes.ts'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface V1ResumeRow {
  readonly id: string
  readonly user_id: string
  readonly title: string | null
  readonly template_id: string | null
  readonly created_at: string | null
  readonly updated_at: string | null
  readonly is_published?: boolean | null
  readonly overall_score?: number | null
}

export interface V1SectionRow {
  readonly id: string
  readonly resume_id: string
  readonly section_type: string
  readonly section_data: unknown
  readonly order_index: number | null
}

/** Ids and clock, injected so a mapping is deterministic and testable. */
export interface MapContext {
  readonly newResumeId: string
  /** One id per section and entry, consumed in order. */
  readonly idPool: readonly string[]
  readonly now: string
  /**
   * V1 resume ids already migrated, mapped to the V2 resume they produced.
   * Re-running is then a no-op rather than a second copy.
   */
  readonly alreadyMigrated?: ReadonlyMap<string, string>
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type NoteKind =
  | 'unmapped-key'
  | 'unmapped-value'
  | 'unparsed-date'
  | 'missing-date'
  | 'blank-bullets-dropped'
  | 'unknown-section-type'
  | 'unknown-template'
  | 'empty-section-omitted'
  | 'legacy-field-not-migrated'

/** Something a human may want to know. Reported, never acted on. */
export interface MigrationNote {
  readonly kind: NoteKind
  readonly path: string
  readonly detail: string
}

export type ReviewReason =
  | { readonly kind: 'duplicate-section'; readonly sectionType: string; readonly rowIds: readonly string[]; readonly detail: string }
  | { readonly kind: 'no-sections'; readonly detail: string }

export type MapOutcome =
  | { readonly kind: 'mapped'; readonly resume: ResumeV2; readonly notes: readonly MigrationNote[] }
  | { readonly kind: 'needs-review'; readonly v1ResumeId: string; readonly reasons: readonly ReviewReason[]; readonly notes: readonly MigrationNote[] }
  | { readonly kind: 'already-migrated'; readonly v1ResumeId: string; readonly v2ResumeId: string }

// ---------------------------------------------------------------------------
// Locked rules
// ---------------------------------------------------------------------------

/**
 * The template table, exactly as locked.
 *
 * V1's five ids were one layout in five colour values, so the question was
 * never "which V2 template is this" but "which one is closest to what they
 * were actually looking at".
 */
export const TEMPLATE_MAP: Readonly<Record<string, ResumeTemplate>> = {
  compact: 'compact',
  modern: 'modern',
  ats: 'classic',
  professional: 'classic',
  creative: 'modern',
}

/** Anything unrecognised falls to Classic AND is reported, never silently. */
export function mapTemplate(v1: string | null | undefined): {
  template: ResumeTemplate
  note: MigrationNote | null
} {
  const id = (v1 ?? '').trim().toLowerCase()
  const mapped = TEMPLATE_MAP[id]
  if (mapped) return { template: mapped, note: null }
  return {
    template: 'classic',
    note: {
      kind: 'unknown-template',
      path: 'resumes/template_id',
      detail: `"${id || '(empty)'}" is not one of V1's five templates; defaulted to classic`,
    },
  }
}

/**
 * Marks a V2 resume as having come from a particular V1 record.
 *
 * `importId` is the V1 resume's own id, which is what makes re-running the
 * migration detectable rather than duplicating. `documentFingerprint` is a
 * stable marker over that id -- not a hash of the content, because the content
 * is not what identifies the source record.
 */
export function migrationMarker(v1ResumeId: string): string {
  return `v1:${v1ResumeId}`
}

export function migrationReference(v1ResumeId: string, now: string): ImportReference {
  return {
    importId: v1ResumeId,
    sourceFormat: 'v1',
    documentFingerprint: migrationMarker(v1ResumeId),
    importedAt: now,
    originalRetained: true, // The V1 rows are never deleted; they ARE retained.
  }
}

/** Builds the already-migrated map from V2 resumes that carry the marker. */
export function migratedIndex(existing: readonly ResumeV2[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const resume of existing) {
    const from = resume.importedFrom
    if (from?.sourceFormat === 'v1' && from.importId) index.set(from.importId, resume.id)
  }
  return index
}

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

export function mapV1Resume(
  row: V1ResumeRow,
  sections: readonly V1SectionRow[],
  ctx: MapContext
): MapOutcome {
  const already = ctx.alreadyMigrated?.get(row.id)
  if (already) {
    return { kind: 'already-migrated', v1ResumeId: row.id, v2ResumeId: already }
  }

  const notes: MigrationNote[] = []
  const reasons: ReviewReason[] = []

  // --- group the legacy rows, and refuse to choose between duplicates ------
  const mine = sections.filter((s) => s.resume_id === row.id)
  const byType = new Map<string, V1SectionRow[]>()
  for (const section of mine) {
    if (!isV1SectionType(section.section_type)) {
      notes.push({
        kind: 'unknown-section-type',
        path: `resume_sections/${section.id}`,
        detail: `section_type "${section.section_type}" was never written by V1`,
      })
      continue
    }
    const list = byType.get(section.section_type) ?? []
    list.push(section)
    byType.set(section.section_type, list)
  }

  for (const [type, rows] of byType) {
    if (rows.length <= 1) continue
    // Merging is guessing, and choosing the lowest order_index is guessing
    // quietly. Every row is reported and the resume waits for a person.
    reasons.push({
      kind: 'duplicate-section',
      sectionType: type,
      rowIds: rows.map((r) => r.id),
      detail: `${rows.length} "${type}" rows on one resume; the mapping is ambiguous`,
    })
  }

  if (mine.length === 0) {
    reasons.push({ kind: 'no-sections', detail: 'the resume has no section rows at all' })
  }

  if (reasons.length > 0) {
    return { kind: 'needs-review', v1ResumeId: row.id, reasons, notes }
  }

  // --- read each legacy section -------------------------------------------
  const read = new Map<V1SectionType, { data: V1SectionData; order: number }>()
  for (const [type, rows] of byType) {
    const parsed = readV1Section(type, rows[0].section_data)
    if (!parsed) continue
    read.set(type as V1SectionType, { data: parsed, order: rows[0].order_index ?? 0 })
    for (const issue of v1SectionIssues(parsed, row.id)) {
      notes.push({
        kind: issue.kind === 'blank-bullets' ? 'blank-bullets-dropped'
          : issue.kind === 'unparsed-date' ? 'unparsed-date'
            : issue.kind === 'missing-date' ? 'missing-date' : 'unmapped-key',
        path: issue.path,
        detail: issue.detail,
      })
    }
  }

  let cursor = 0
  const nextId = () => ctx.idPool[cursor++] ?? `${ctx.newResumeId}-${cursor}`

  // --- header --------------------------------------------------------------
  const personal = read.get('personal')?.data
  const contact = personal?.type === 'personal' ? personal.data : null
  if (contact) recordExtras(notes, `${row.id}/personal`, contact.extras)

  // --- sections, in V1's own order -----------------------------------------
  const built: { order: number; section: ResumeSectionV2 }[] = []
  const push = (type: V1SectionType, section: ResumeSectionV2 | null) => {
    if (!section) {
      notes.push({
        kind: 'empty-section-omitted',
        path: `${row.id}/${type}`,
        detail: 'no content survived, so no empty section was created',
      })
      return
    }
    built.push({ order: read.get(type)?.order ?? 99, section })
  }

  if (contact && contact.professionalSummary.trim() !== '') {
    built.push({
      order: read.get('personal')?.order ?? 0,
      section: {
        ...createSection('summary', nextId()),
        // Not truncated. One live value is 4,214 characters.
        text: createAuthoredText(contact.professionalSummary, 'import'),
      } as ResumeSectionV2,
    })
  } else if (contact) {
    push('personal', null)
  }

  const education = read.get('education')?.data
  if (education?.type === 'education') {
    push('education', buildEducation(education.data, row.id, nextId, notes))
  }

  const icu = read.get('icu_experience')?.data
  if (icu?.type === 'icu_experience') {
    push('icu_experience', buildIcu(icu.data, row.id, nextId, notes))
  }

  const certifications = read.get('certifications')?.data
  if (certifications?.type === 'certifications') {
    push('certifications', buildCertifications(certifications.data, row.id, nextId, notes))
  }

  const shadowing = read.get('shadowing')?.data
  if (shadowing?.type === 'shadowing') {
    push('shadowing', buildShadowing(shadowing.data, row.id, nextId, notes))
  }

  const leadership = read.get('leadership')?.data
  if (leadership?.type === 'leadership') {
    push('leadership', buildLeadership(leadership.data, row.id, nextId, notes))
  }

  const research = read.get('research')?.data
  if (research?.type === 'research') {
    push('research', buildResearch(research.data, row.id, nextId, notes))
  }

  built.sort((a, b) => a.order - b.order)

  const { template, note: templateNote } = mapTemplate(row.template_id)
  if (templateNote) notes.push(templateNote)

  // V1's own score used a different formula and is not carried across; V2's
  // Strength recomputes on demand.
  if (typeof row.overall_score === 'number' && row.overall_score > 0) {
    notes.push({
      kind: 'legacy-field-not-migrated',
      path: `${row.id}/overall_score`,
      detail: `${row.overall_score} — V1's score is a different measure and is not carried over`,
    })
  }

  const base = createResume({
    id: ctx.newResumeId,
    userId: row.user_id,
    title: (row.title ?? '').trim() || 'My CRNA Resume',
    sectionIds: Array.from({ length: 20 }, (_, i) => `${ctx.newResumeId}-seed-${i}`),
    now: ctx.now,
  })

  return {
    kind: 'mapped',
    notes,
    resume: {
      ...base,
      template,
      // LOCKED: every migrated resume enters as a draft. Nothing infers
      // 'complete' from is_published or any other legacy signal.
      status: 'draft',
      contact: {
        fullName: contact?.fullName ?? '',
        credentials: '',
        email: contact?.email ?? '',
        phone: contact?.phone ?? '',
        city: contact?.city ?? '',
        state: contact?.state ?? '',
        linkedin: contact?.linkedin ?? '',
        website: '',
      },
      sections: built.map((b) => b.section),
      createdAt: row.created_at ?? ctx.now,
      updatedAt: row.updated_at ?? ctx.now,
      importedFrom: migrationReference(row.id, ctx.now),
    },
  }
}

// ---------------------------------------------------------------------------
// Section builders. Each returns null when nothing survived.
// ---------------------------------------------------------------------------

function recordExtras(
  notes: MigrationNote[],
  path: string,
  extras: Record<string, unknown>
): void {
  for (const key of Object.keys(extras)) {
    notes.push({ kind: 'unmapped-key', path: `${path}/${key}`, detail: 'legacy key with no V2 destination' })
  }
}

type Extract1<T extends V1SectionData['type']> = Extract<V1SectionData, { type: T }>['data']

function buildEducation(
  data: Extract1<'education'>,
  resumeId: string,
  nextId: () => string,
  notes: MigrationNote[]
): ResumeSectionV2 | null {
  recordExtras(notes, `${resumeId}/education`, data.extras)
  const degrees = [data.nursingDegree, ...data.otherDegrees]
  const entries = degrees
    .map((degree, i) => {
      recordExtras(notes, `${resumeId}/education/degree#${i}`, degree.extras)
      // LOCKED: other_degrees[].gpa has no legitimate V2 destination. It is
      // reported, never guessed into overallGpa -- which slot it belongs to is
      // exactly the thing nobody can know.
      if (degree.gpaRaw.trim() !== '') {
        notes.push({
          kind: 'unmapped-value',
          path: `${resumeId}/education/degree#${i}/gpa`,
          detail: `"${degree.gpaRaw}" — V1 stored it, rendered it nowhere, and V2 has no field for it`,
        })
      }
      return {
        id: nextId(),
        degree: degree.degree,
        field: degree.field,
        institution: degree.university,
        location: '',
        // Preserved exactly, unparseable or absent.
        graduationDate: degree.graduationDate,
        // LOCKED: migrated GPA values keep the visibility V1 gave them, which
        // was always visible. New V2 entries still default to hidden.
        overallGpa: parseGpa(degree.overallGpaRaw, degree.overallGpaRaw.trim() !== ''),
        scienceGpa: parseGpa(degree.scienceGpaRaw, degree.scienceGpaRaw.trim() !== ''),
        honors: '',
      }
    })
    .filter((e) =>
      e.degree || e.field || e.institution ||
      e.graduationDate.kind !== 'absent' || e.overallGpa.raw || e.scienceGpa.raw
    )

  if (entries.length === 0) return null
  return { ...createSection('education', nextId()), entries } as ResumeSectionV2
}

function buildIcu(
  data: Extract1<'icu_experience'>,
  resumeId: string,
  nextId: () => string,
  notes: MigrationNote[]
): ResumeSectionV2 | null {
  recordExtras(notes, `${resumeId}/icu_experience`, data.extras)

  const positions = data.positions.map((p, i) => {
    recordExtras(notes, `${resumeId}/icu_experience/positions#${i}`, p.extras)
    const position = createClinicalPosition(nextId(), {
      employer: p.hospital,
      role: p.position,
      // LOCKED: unit_type lands in BOTH -- `unit` so the text V1 printed is
      // still printed, `unitType` so it still grounds an AI proposal. The
      // wording is not altered in either.
      unit: p.unitType,
      unitType: p.unitType,
      location: p.location,
      acuity: p.acuity,
      dates: p.dates,
      // Structured grounding only. The renderer cannot emit these, which is
      // the V1 defect being fixed rather than carried across.
      devices: p.devices,
      patientPopulations: p.patientPopulation,
    })
    // Every live bullet array is [''], so `bullets` is empty and stays empty.
    // A position with no bullets still renders its header.
    return { ...position, bullets: p.bullets.map((b) => createAuthoredText(b, 'import')) }
  })

  if (positions.length === 0) return null
  return { ...createSection('critical_care', nextId()), positions } as ResumeSectionV2
}

function buildCertifications(
  data: Extract1<'certifications'>,
  resumeId: string,
  nextId: () => string,
  notes: MigrationNote[]
): ResumeSectionV2 | null {
  recordExtras(notes, `${resumeId}/certifications`, data.extras)
  const names = [...data.certifications, ...data.customCertifications]
  if (names.length === 0) return null
  return {
    ...createSection('certifications', nextId()),
    certifications: names.map((name) => ({
      id: nextId(),
      name,
      // Never inferred. V1 stored none of these.
      issuer: '', identifier: '',
      earned: { kind: 'absent' as const }, expires: { kind: 'absent' as const },
    })),
  } as ResumeSectionV2
}

function buildShadowing(
  data: Extract1<'shadowing'>,
  resumeId: string,
  nextId: () => string,
  notes: MigrationNote[]
): ResumeSectionV2 | null {
  recordExtras(notes, `${resumeId}/shadowing`, data.extras)
  const experiences = data.experiences
    .filter((e) => e.crnaName || e.hours || e.setting || e.description)
    .map((e, i) => {
      recordExtras(notes, `${resumeId}/shadowing/experiences#${i}`, e.extras)
      return {
        id: nextId(),
        providerName: e.crnaName,
        credential: '',
        setting: e.setting,
        facility: '',
        // Kept as text. "40+" is a real answer and is not tidied into 40.
        hours: e.hours,
        dates: { start: absent(), end: absent(), isCurrent: false },
        reflection: createAuthoredText(e.description, 'import'),
      }
    })
  if (experiences.length === 0) return null
  return { ...createSection('shadowing', nextId()), experiences } as ResumeSectionV2
}

function buildLeadership(
  data: Extract1<'leadership'>,
  resumeId: string,
  nextId: () => string,
  notes: MigrationNote[]
): ResumeSectionV2 | null {
  recordExtras(notes, `${resumeId}/leadership`, data.extras)
  if (data.roles.length === 0) return null
  return {
    ...createSection('leadership', nextId()),
    // A V1 role is one free-text line. Splitting it into role, organisation and
    // dates would be three guesses, so it stays whole.
    entries: data.roles.map((role) => ({
      id: nextId(),
      role,
      organization: '',
      dates: { start: absent(), end: absent(), isCurrent: false },
      detail: createAuthoredText('', 'import'),
    })),
  } as ResumeSectionV2
}

function buildResearch(
  data: Extract1<'research'>,
  resumeId: string,
  nextId: () => string,
  notes: MigrationNote[]
): ResumeSectionV2 | null {
  recordExtras(notes, `${resumeId}/research`, data.extras)
  if (data.projects.length === 0) return null
  return {
    ...createSection('research', nextId()),
    entries: data.projects.map((title) => ({
      id: nextId(),
      title,
      role: '',
      organization: '',
      dates: { start: absent(), end: absent(), isCurrent: false },
      detail: createAuthoredText('', 'import'),
    })),
  } as ResumeSectionV2
}

function absent(): ResumeDate {
  return parseResumeDate('')
}
