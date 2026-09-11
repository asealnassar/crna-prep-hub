/**
 * What an entry of each section type is made of.
 *
 * ONE TABLE, TWO CONSUMERS. The editor renders a form from these descriptors,
 * and the route validates an incoming patch against the same descriptors. A
 * field the form cannot show is a field the server will not accept, and neither
 * can drift from the other because there is only one list.
 *
 * This is also what "fifteen section editors" is. Eleven of the fifteen types
 * are a list of entries with typed fields and differ only in which fields --
 * so they are fifteen descriptors and one form, rather than fifteen forms that
 * would drift apart the first time a field was added to only one of them. The
 * two that are genuinely different (a professional summary is one block of
 * prose; a clinical position carries grounding facts and written bullets) say
 * so through `shape` and get their own editors.
 */

import { ABSENT_DATE, EMPTY_RANGE } from '../model/dates.ts'
import { EMPTY_AUTHORED_TEXT } from '../model/authoredText.ts'
import { emptyGpa } from '../model/sections.ts'
import { SECTION_HEADINGS } from '../model/sections.ts'
import type { ResumeSectionType } from '../model/types.ts'

export type FieldKind =
  /** One line of plain text. */
  | 'text'
  /** A single month/year. */
  | 'date'
  /** Start, end and a "still here" flag. */
  | 'daterange'
  /** The applicant's own GPA text plus the switch that shows it. */
  | 'gpa'
  | 'boolean'
  /** Prose that carries its own provenance and can be AI-proposed later. */
  | 'authored'

export interface FieldDescriptor {
  /** The key on the entry object. */
  readonly name: string
  /** The form label. Every input gets one; none is placeholder-only. */
  readonly label: string
  readonly kind: FieldKind
  readonly placeholder?: string
}

export interface EntryDescriptor {
  /** The key on the section that holds the list. */
  readonly listKey: string
  /** What one item is called: "Add degree", "Remove licence". */
  readonly noun: string
  readonly fields: readonly FieldDescriptor[]
}

export type SectionShape = 'prose' | 'entries' | 'positions'

export interface SectionDescriptor {
  readonly type: ResumeSectionType
  readonly heading: string
  readonly shape: SectionShape
  /** Present for every 'entries' section and no others. */
  readonly entry?: EntryDescriptor
}

const text = (name: string, label: string, placeholder?: string): FieldDescriptor =>
  ({ name, label, kind: 'text', ...(placeholder ? { placeholder } : {}) })

const DESCRIPTORS: Record<ResumeSectionType, SectionDescriptor> = {
  summary: { type: 'summary', heading: SECTION_HEADINGS.summary, shape: 'prose' },

  critical_care: { type: 'critical_care', heading: SECTION_HEADINGS.critical_care, shape: 'positions' },
  other_clinical: { type: 'other_clinical', heading: SECTION_HEADINGS.other_clinical, shape: 'positions' },

  education: {
    type: 'education', heading: SECTION_HEADINGS.education, shape: 'entries',
    entry: {
      listKey: 'entries', noun: 'degree',
      fields: [
        text('degree', 'Degree', 'BSN'),
        text('field', 'Field of study', 'Nursing'),
        text('institution', 'Institution'),
        text('location', 'Location', 'Newark, NJ'),
        { name: 'graduationDate', label: 'Graduated', kind: 'date' },
        { name: 'overallGpa', label: 'Overall GPA', kind: 'gpa' },
        { name: 'scienceGpa', label: 'Science GPA', kind: 'gpa' },
        text('honors', 'Honors', 'Cum laude'),
      ],
    },
  },

  licensure: {
    type: 'licensure', heading: SECTION_HEADINGS.licensure, shape: 'entries',
    entry: {
      listKey: 'licenses', noun: 'license',
      fields: [
        text('licenseType', 'License', 'RN'),
        text('state', 'State', 'NJ'),
        text('identifier', 'License number'),
        { name: 'isCompact', label: 'Multistate compact', kind: 'boolean' },
        { name: 'expires', label: 'Expires', kind: 'date' },
      ],
    },
  },

  certifications: {
    type: 'certifications', heading: SECTION_HEADINGS.certifications, shape: 'entries',
    entry: {
      listKey: 'certifications', noun: 'certification',
      fields: [
        text('name', 'Certification', 'CCRN'),
        text('issuer', 'Issuer', 'AACN'),
        text('identifier', 'Certificate number'),
        { name: 'earned', label: 'Earned', kind: 'date' },
        { name: 'expires', label: 'Expires', kind: 'date' },
      ],
    },
  },

  shadowing: {
    type: 'shadowing', heading: SECTION_HEADINGS.shadowing, shape: 'entries',
    entry: {
      listKey: 'experiences', noun: 'shadowing experience',
      fields: [
        text('providerName', 'Provider'),
        text('credential', 'Credential', 'CRNA'),
        text('setting', 'Setting', 'Operating room'),
        text('facility', 'Facility'),
        text('hours', 'Hours', '40'),
        { name: 'dates', label: 'Dates', kind: 'daterange' },
        { name: 'reflection', label: 'What you took from it', kind: 'authored' },
      ],
    },
  },

  leadership: {
    type: 'leadership', heading: SECTION_HEADINGS.leadership, shape: 'entries',
    entry: {
      listKey: 'entries', noun: 'role',
      fields: [
        text('role', 'Role', 'Charge nurse'),
        text('organization', 'Organization'),
        { name: 'dates', label: 'Dates', kind: 'daterange' },
        { name: 'detail', label: 'What you did', kind: 'authored' },
      ],
    },
  },

  quality_improvement: {
    type: 'quality_improvement', heading: SECTION_HEADINGS.quality_improvement, shape: 'entries',
    entry: {
      listKey: 'entries', noun: 'project',
      fields: [
        text('title', 'Project'),
        text('role', 'Your role'),
        text('organization', 'Organization'),
        { name: 'dates', label: 'Dates', kind: 'daterange' },
        { name: 'detail', label: 'What it achieved', kind: 'authored' },
      ],
    },
  },

  research: {
    type: 'research', heading: SECTION_HEADINGS.research, shape: 'entries',
    entry: {
      listKey: 'entries', noun: 'project',
      fields: [
        text('title', 'Study'),
        text('role', 'Your role'),
        text('organization', 'Institution'),
        { name: 'dates', label: 'Dates', kind: 'daterange' },
        { name: 'detail', label: 'What it involved', kind: 'authored' },
      ],
    },
  },

  organizations: {
    type: 'organizations', heading: SECTION_HEADINGS.organizations, shape: 'entries',
    entry: {
      listKey: 'memberships', noun: 'membership',
      fields: [
        text('organization', 'Organization', 'AACN'),
        text('role', 'Role', 'Member'),
        { name: 'dates', label: 'Dates', kind: 'daterange' },
      ],
    },
  },

  awards: {
    type: 'awards', heading: SECTION_HEADINGS.awards, shape: 'entries',
    entry: {
      listKey: 'awards', noun: 'award',
      fields: [
        text('title', 'Award'),
        text('issuer', 'Awarded by'),
        { name: 'awarded', label: 'Date', kind: 'date' },
        { name: 'detail', label: 'Why it was given', kind: 'authored' },
      ],
    },
  },

  volunteer: {
    type: 'volunteer', heading: SECTION_HEADINGS.volunteer, shape: 'entries',
    entry: {
      listKey: 'entries', noun: 'role',
      fields: [
        text('role', 'Role'),
        text('organization', 'Organization'),
        { name: 'dates', label: 'Dates', kind: 'daterange' },
        { name: 'detail', label: 'What you did', kind: 'authored' },
      ],
    },
  },

  publications: {
    type: 'publications', heading: SECTION_HEADINGS.publications, shape: 'entries',
    entry: {
      listKey: 'entries', noun: 'publication',
      fields: [
        text('title', 'Title'),
        text('kind', 'Type', 'Poster'),
        text('venue', 'Venue', 'AACN NTI'),
        { name: 'date', label: 'Date', kind: 'date' },
        { name: 'citation', label: 'Citation', kind: 'authored' },
      ],
    },
  },

  custom: {
    type: 'custom', heading: SECTION_HEADINGS.custom, shape: 'entries',
    entry: {
      listKey: 'entries', noun: 'item',
      fields: [
        text('title', 'Item'),
        { name: 'detail', label: 'Detail', kind: 'authored' },
      ],
    },
  },
}

export const SECTION_DESCRIPTORS: Readonly<Record<ResumeSectionType, SectionDescriptor>> = DESCRIPTORS

export function descriptorFor(type: ResumeSectionType): SectionDescriptor {
  return DESCRIPTORS[type]
}

/** The descriptor for one field, or null when the section has no such field. */
export function fieldFor(type: ResumeSectionType, name: string): FieldDescriptor | null {
  return descriptorFor(type).entry?.fields.find((f) => f.name === name) ?? null
}

/** The key on a section that holds its list of entries. */
export function listKeyFor(type: ResumeSectionType): string | null {
  return descriptorFor(type).entry?.listKey ?? null
}

/**
 * A blank entry of the given type, built from its descriptor so a field added
 * above cannot be forgotten here.
 *
 * Empty means empty: no seeded bullet, no placeholder date, and a GPA that
 * defaults to NOT being shown. The one V1 initialiser that seeded `['']` is
 * why every production position still carries a blank bullet.
 */
export function blankEntry(type: ResumeSectionType, id: string): Record<string, unknown> {
  const entry = descriptorFor(type).entry
  if (!entry) throw new Error(`${type} has no entries`)

  const built: Record<string, unknown> = { id }
  for (const field of entry.fields) {
    built[field.name] = blankValue(field.kind)
  }
  return built
}

function blankValue(kind: FieldKind): unknown {
  switch (kind) {
    case 'text': return ''
    case 'boolean': return false
    case 'date': return ABSENT_DATE
    case 'daterange': return EMPTY_RANGE
    case 'gpa': return emptyGpa()
    case 'authored': return EMPTY_AUTHORED_TEXT
  }
}
