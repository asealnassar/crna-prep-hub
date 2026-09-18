/**
 * Canonical model <-> database rows. Pure, both directions.
 *
 * The only place that knows how a ResumeV2 is spread across the `resumes` and
 * `resume_sections` tables. Nothing here imports Supabase or touches a
 * network, so the mapping is exhaustively testable without a database.
 *
 * Three decisions worth stating, because each avoids a defect V1 has:
 *
 *   ORDER lives in `order_index` and nowhere else. V1 writes that column on
 *   every row and never reads it back, so its stored order is fiction. V2
 *   reads it, sorts by it, and rewrites it from the array position on every
 *   save -- one representation, so the two cannot disagree.
 *
 *   UPDATED_AT is written explicitly. There is no trigger on these tables, so
 *   a row that is not told its updated_at keeps the value from its insert.
 *   Every write path here supplies one.
 *
 *   AN UNREADABLE SECTION IS DROPPED AND REPORTED, never guessed at. A row
 *   whose section_type is not a V2 type, or whose payload is not an object,
 *   would otherwise become an empty section that silently replaces real data
 *   on the next save.
 */

import { SECTION_TYPES } from '../model/types.ts'
import type {
  ResumeSectionType, ResumeSectionV2, ResumeStatus, ResumeTemplate, ResumeV2,
} from '../model/types.ts'
import { emptyContact } from '../model/resume.ts'

/** The V2 generation marker. Rows below this are V1 and are not read here. */
export const V2_SCHEMA_VERSION = 2

export interface ResumeRow {
  id: string
  user_id: string
  title: string | null
  template_id: string | null
  created_at: string | null
  updated_at: string | null
  schema_version: number | null
  status: string | null
  revision: number | string | null
  strength_score: number | null
  strength_computed_at: string | null
  strength_revision: number | string | null
  /** V2 keeps its own contact block inside a section_data payload. */
  [extra: string]: unknown
}

export interface SectionRow {
  id: string
  resume_id: string
  section_type: string
  section_data: unknown
  order_index: number | null
  visible: boolean | null
  label: string | null
  created_at?: string | null
  updated_at?: string | null
}

/** A row that could not be understood, kept so a caller can report it. */
export interface RowIssue {
  readonly rowId: string
  readonly kind: 'unknown-section-type' | 'malformed-payload' | 'wrong-schema-version'
  readonly detail: string
}

export interface ReadResult {
  readonly resume: ResumeV2 | null
  readonly issues: readonly RowIssue[]
}

const TEMPLATES: readonly ResumeTemplate[] = ['classic', 'modern', 'compact']
const STATUSES: readonly ResumeStatus[] = ['draft', 'complete']

function isSectionType(value: unknown): value is ResumeSectionType {
  return typeof value === 'string' && (SECTION_TYPES as readonly string[]).includes(value)
}

function asInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * The header block lives in a reserved section payload rather than in columns.
 *
 * Contact fields are the most volatile part of a resume model -- credentials,
 * a website, a second phone -- and putting them in columns means an ALTER for
 * each. The JSON envelope already carries every other section's shape.
 */
const CONTACT_SECTION_TYPE = '__contact__'

/**
 * Resume-level state the `resumes` columns have no place for.
 *
 * The columns are fixed -- title, template, status, strength -- and adding one
 * is a migration. A reserved row carries the rest in the JSON envelope every
 * section already uses, which is how the contact block has always been stored.
 * Today that is the output lock; a resume without the row simply has none.
 */
const META_SECTION_TYPE = '__meta__'

/** Deterministic, so the contact row is upserted rather than duplicated. */
export function contactRowId(resumeId: string): string {
  return resumeId
}

/**
 * The meta row's id: the resume's own, with a fixed tail so it can never be
 * the contact row or a section the client generated.
 */
export function metaRowId(resumeId: string): string {
  return `${resumeId.slice(0, 24)}5e7a00000001`
}

/**
 * Rebuilds a resume from its rows.
 *
 * Returns `resume: null` for anything that is not a readable V2 record --
 * a V1 row, or one whose generation marker is missing. That is not an error
 * condition: V1 and V2 share these tables for the length of the rebuild, and
 * "this row is not mine" is the expected answer for 17 of them.
 */
export function fromRows(resumeRow: ResumeRow | null, sectionRows: readonly SectionRow[]): ReadResult {
  const issues: RowIssue[] = []
  if (!resumeRow) return { resume: null, issues }

  const version = asInt(resumeRow.schema_version, 1)
  if (version !== V2_SCHEMA_VERSION) {
    issues.push({
      rowId: resumeRow.id,
      kind: 'wrong-schema-version',
      detail: `schema_version=${version}`,
    })
    return { resume: null, issues }
  }

  let contact = emptyContact()
  let outputLockedAt: string | null = null
  const sections: ResumeSectionV2[] = []

  const ordered = [...sectionRows].sort(
    (a, b) => asInt(a.order_index, 0) - asInt(b.order_index, 0)
  )

  for (const row of ordered) {
    const payload = row.section_data
    const isObject = payload !== null && typeof payload === 'object' && !Array.isArray(payload)

    if (row.section_type === CONTACT_SECTION_TYPE) {
      if (isObject) contact = { ...emptyContact(), ...(payload as object) }
      else issues.push({ rowId: row.id, kind: 'malformed-payload', detail: 'contact' })
      continue
    }

    if (row.section_type === META_SECTION_TYPE) {
      const locked = isObject ? (payload as { outputLockedAt?: unknown }).outputLockedAt : null
      outputLockedAt = typeof locked === 'string' && locked !== '' ? locked : null
      continue
    }

    if (!isSectionType(row.section_type)) {
      issues.push({ rowId: row.id, kind: 'unknown-section-type', detail: String(row.section_type) })
      continue
    }
    if (!isObject) {
      issues.push({ rowId: row.id, kind: 'malformed-payload', detail: row.section_type })
      continue
    }

    sections.push({
      ...(payload as object),
      id: row.id,
      type: row.section_type,
      visible: row.visible !== false,
      label: typeof row.label === 'string' ? row.label : null,
    } as ResumeSectionV2)
  }

  const template = TEMPLATES.includes(resumeRow.template_id as ResumeTemplate)
    ? (resumeRow.template_id as ResumeTemplate)
    : 'classic'
  const status = STATUSES.includes(resumeRow.status as ResumeStatus)
    ? (resumeRow.status as ResumeStatus)
    : 'draft'

  const strengthScore = resumeRow.strength_score
  const strength =
    typeof strengthScore === 'number'
      ? {
          score: strengthScore,
          computedAt: resumeRow.strength_computed_at ?? '',
          computedAtRevision: asInt(resumeRow.strength_revision, 0),
        }
      : null

  return {
    resume: {
      schemaVersion: 2,
      id: resumeRow.id,
      userId: resumeRow.user_id,
      title: resumeRow.title ?? '',
      status,
      template,
      contact,
      sections,
      revision: Math.max(1, asInt(resumeRow.revision, 1)),
      createdAt: resumeRow.created_at ?? '',
      updatedAt: resumeRow.updated_at ?? '',
      // Import provenance is a later phase; nothing writes it yet.
      importedFrom: null,
      outputLockedAt,
      strength,
    },
    issues,
  }
}

/**
 * The payload for save_resume_v2.
 *
 * Deliberately omits every server-authoritative field. `revision` is supplied
 * separately as the expected value and set by the function; `updated_at` and
 * `created_at` are stamped with the database clock, so a client cannot
 * backdate a save or drift on a skewed clock; `resume_id` on each section is
 * forced by the function rather than read from here.
 */
export interface SavePayload {
  readonly resume: Record<string, unknown>
  readonly sections: Array<Record<string, unknown>>
}

export function toSavePayload(resume: ResumeV2): SavePayload {
  const sections: Array<Record<string, unknown>> = resume.sections.map((section, index) => {
    const { id, type, visible, label, ...payload } = section as ResumeSectionV2 & Record<string, unknown>
    return {
      id,
      section_type: type,
      section_data: payload,
      order_index: index,
      visible,
      label,
    }
  })

  sections.push({
    id: contactRowId(resume.id),
    section_type: CONTACT_SECTION_TYPE,
    section_data: resume.contact,
    order_index: -1,
    visible: true,
    label: null,
  })

  // Written only once there is something to say, so a resume that was never
  // locked carries no row and reads back exactly as it always did.
  if (resume.outputLockedAt) {
    sections.push({
      id: metaRowId(resume.id),
      section_type: META_SECTION_TYPE,
      section_data: { outputLockedAt: resume.outputLockedAt },
      order_index: -2,
      visible: true,
      label: null,
    })
  }

  return {
    resume: {
      title: resume.title,
      template_id: resume.template,
      status: resume.status,
      strength_score: resume.strength?.score ?? null,
      strength_computed_at: resume.strength?.computedAt ?? null,
      strength_revision: resume.strength?.computedAtRevision ?? null,
    },
    sections,
  }
}

export { CONTACT_SECTION_TYPE, META_SECTION_TYPE }
