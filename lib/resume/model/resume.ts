/**
 * Resume-level construction and section manipulation. All pure.
 *
 * Every function returns a new resume rather than mutating, and every one
 * takes ids and timestamps as parameters so results are deterministic.
 *
 * `revision` is bumped by these helpers because it describes the document's
 * content, but nothing here talks to a database -- the persistence layer in a
 * later phase is what compares revisions to reject a stale write.
 */

import { createSection, isSectionRenderable } from './sections.ts'
import type {
  ImportReference, ResumeContact, ResumeSectionType, ResumeSectionV2,
  ResumeStatus, ResumeStrengthRef, ResumeTemplate, ResumeV2, SectionOfType,
} from './types.ts'

export const DEFAULT_TEMPLATE: ResumeTemplate = 'classic'

/**
 * Sections a new resume starts with, in order.
 *
 * The rest are added by the applicant. Everything here starts VISIBLE and
 * EMPTY: an empty section does not render, so an untouched resume shows
 * nothing it should not, and the applicant can see the shape of what they are
 * filling in.
 */
export const DEFAULT_SECTION_TYPES: readonly ResumeSectionType[] = [
  'summary', 'education', 'critical_care', 'licensure',
  'certifications', 'shadowing', 'leadership',
]

export function emptyContact(): ResumeContact {
  return {
    fullName: '', credentials: '', email: '', phone: '',
    city: '', state: '', linkedin: '', website: '',
  }
}

/**
 * A new, empty draft.
 *
 * `sectionIds` supplies one id per default section, in order, so creation is
 * deterministic. Status is 'draft' because a resume with nothing in it is a
 * draft by any definition -- what promotes it to 'complete' is undecided and
 * deliberately not encoded here.
 */
export function createResume(input: {
  id: string
  userId: string
  title: string
  sectionIds: readonly string[]
  now: string
  template?: ResumeTemplate
  sectionTypes?: readonly ResumeSectionType[]
  importedFrom?: ImportReference | null
}): ResumeV2 {
  const types = input.sectionTypes ?? DEFAULT_SECTION_TYPES
  if (input.sectionIds.length < types.length) {
    throw new Error(`createResume needs ${types.length} section ids, got ${input.sectionIds.length}`)
  }
  return {
    schemaVersion: 2,
    id: input.id,
    userId: input.userId,
    title: input.title,
    status: 'draft',
    template: input.template ?? DEFAULT_TEMPLATE,
    contact: emptyContact(),
    sections: types.map((type, i) => createSection(type, input.sectionIds[i])),
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    importedFrom: input.importedFrom ?? null,
    strength: null,
  }
}

function bump(resume: ResumeV2, sections: readonly ResumeSectionV2[], now: string): ResumeV2 {
  return { ...resume, sections, revision: resume.revision + 1, updatedAt: now }
}

export function findSection(resume: ResumeV2, sectionId: string): ResumeSectionV2 | null {
  return resume.sections.find((s) => s.id === sectionId) ?? null
}

export function sectionsOfType<T extends ResumeSectionType>(
  resume: ResumeV2,
  type: T
): SectionOfType<T>[] {
  return resume.sections.filter((s): s is SectionOfType<T> => s.type === type)
}

/** Appends a section. Duplicates of a type are allowed -- two custom sections
 *  are legitimate, and nothing about the model forbids two of anything. */
export function addSection<T extends ResumeSectionType>(
  resume: ResumeV2,
  type: T,
  id: string,
  now: string,
  options: { label?: string | null; heading?: string } = {}
): ResumeV2 {
  return bump(resume, [...resume.sections, createSection(type, id, options)], now)
}

export function removeSection(resume: ResumeV2, sectionId: string, now: string): ResumeV2 {
  const sections = resume.sections.filter((s) => s.id !== sectionId)
  if (sections.length === resume.sections.length) return resume
  return bump(resume, sections, now)
}

export function replaceSection(resume: ResumeV2, section: ResumeSectionV2, now: string): ResumeV2 {
  let found = false
  const sections = resume.sections.map((s) => {
    if (s.id !== section.id) return s
    found = true
    return section
  })
  return found ? bump(resume, sections, now) : resume
}

/** Hides or shows without touching the section's data. */
export function setSectionVisibility(
  resume: ResumeV2, sectionId: string, visible: boolean, now: string
): ResumeV2 {
  const section = findSection(resume, sectionId)
  if (!section || section.visible === visible) return resume
  return replaceSection(resume, { ...section, visible } as ResumeSectionV2, now)
}

/**
 * Moves a section to an absolute index. Out-of-range targets clamp rather than
 * throw, so a drag that overshoots the list lands at the end.
 */
export function moveSection(
  resume: ResumeV2, sectionId: string, toIndex: number, now: string
): ResumeV2 {
  const from = resume.sections.findIndex((s) => s.id === sectionId)
  if (from === -1) return resume
  const target = Math.max(0, Math.min(toIndex, resume.sections.length - 1))
  if (target === from) return resume
  const sections = [...resume.sections]
  const [moved] = sections.splice(from, 1)
  sections.splice(target, 0, moved)
  return bump(resume, sections, now)
}

/**
 * Reorders to an explicit id list.
 *
 * Any section omitted from `orderedIds` keeps its relative position at the
 * end rather than being dropped -- losing a section to a malformed reorder
 * request is not an acceptable failure mode.
 */
export function reorderSections(
  resume: ResumeV2, orderedIds: readonly string[], now: string
): ResumeV2 {
  const byId = new Map(resume.sections.map((s) => [s.id, s]))
  const ordered: ResumeSectionV2[] = []
  for (const id of orderedIds) {
    const section = byId.get(id)
    if (section && !ordered.includes(section)) ordered.push(section)
  }
  for (const section of resume.sections) {
    if (!ordered.includes(section)) ordered.push(section)
  }
  const unchanged = ordered.every((s, i) => s === resume.sections[i])
  return unchanged ? resume : bump(resume, ordered, now)
}

export function setTemplate(resume: ResumeV2, template: ResumeTemplate, now: string): ResumeV2 {
  if (resume.template === template) return resume
  return { ...resume, template, revision: resume.revision + 1, updatedAt: now }
}

export function setTitle(resume: ResumeV2, title: string, now: string): ResumeV2 {
  const value = title.trim()
  if (value === resume.title) return resume
  return { ...resume, title: value, revision: resume.revision + 1, updatedAt: now }
}

export function setContact(resume: ResumeV2, contact: ResumeContact, now: string): ResumeV2 {
  return { ...resume, contact, revision: resume.revision + 1, updatedAt: now }
}

/**
 * Sets status. What EARNS 'complete' is a product rule nobody has decided, so
 * this transports the value and asserts nothing about when it is legitimate.
 */
export function setStatus(resume: ResumeV2, status: ResumeStatus, now: string): ResumeV2 {
  if (resume.status === status) return resume
  return { ...resume, status, revision: resume.revision + 1, updatedAt: now }
}

/** Attaches a computed score. Stale-checking is `computedAtRevision`. */
export function attachStrength(resume: ResumeV2, strength: ResumeStrengthRef): ResumeV2 {
  return { ...resume, strength }
}

export function isStrengthStale(resume: ResumeV2): boolean {
  if (!resume.strength) return true
  return resume.strength.computedAtRevision !== resume.revision
}

/** What a renderer would actually draw, in order. */
export function renderableSections(resume: ResumeV2): ResumeSectionV2[] {
  return resume.sections.filter(isSectionRenderable)
}
