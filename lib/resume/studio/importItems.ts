/**
 * Placing what an import could not: "Imported items to review".
 *
 * An import keeps every line it could not place in a flagged, never-printed
 * section (lib/resume/model/importReview.ts). This is how a line leaves it:
 * the applicant PLACES it -- as a bullet under a job they choose, into their
 * Professional Summary, or as a new entry in another section -- or DISMISSES
 * it. Nothing else removes an item, and nothing here guesses: a suggestion
 * pre-selects a destination, and the applicant confirms it.
 *
 * THE TEXT MOVES AS IT WAS IMPORTED. A bullet, a narrative field or an empty
 * summary receives the item's own words marked as imported, so it still says it
 * came from their document. The one thing removed is a list glyph the extractor
 * left at the start of the line -- the resume draws its own bullet, and two
 * would print. Only appending to a summary they already have is an edit, and
 * is recorded as one.
 *
 * Pure. One revision per placement: the destination and the removal from the
 * list happen together or not at all.
 */

import { findSection } from '../model/resume.ts'
import { createAuthoredText, editSource, isBlankAuthoredText } from '../model/authoredText.ts'
import { createSection, headingFor } from '../model/sections.ts'
import { importReviewSectionOf, isImportReviewSection } from '../model/importReview.ts'
import { SECTION_TYPES } from '../model/types.ts'
import type {
  CustomEntry, CustomSection, ResumeSectionType, ResumeSectionV2, ResumeV2,
} from '../model/types.ts'
import { blankEntry, descriptorFor, fieldFor, listKeyFor } from './fields.ts'
import { stripGlyphs } from '../import/structure.ts'

export type ImportPlacement =
  /** Appended to the bullets of one clinical position. */
  | { readonly kind: 'bullet'; readonly sectionId: string; readonly positionId: string }
  /** Into the Professional Summary; `sectionId` creates one when the resume has none. */
  | { readonly kind: 'summary'; readonly sectionId: string }
  /** A new entry; `sectionId` creates the section when the resume has none of that type. */
  | {
      readonly kind: 'entry'
      readonly sectionType: ResumeSectionType
      readonly sectionId: string
      readonly entryId: string
    }

/**
 * Which field of a new entry receives an item's text.
 *
 * The field an imported line most often IS: a certification's name, an award's
 * title, a volunteer role's account of what they did. The applicant edits from
 * there; nothing is split or reworded on their behalf.
 */
export const IMPORT_TEXT_FIELD: Readonly<Partial<Record<ResumeSectionType, string>>> = {
  education: 'degree',
  licensure: 'licenseType',
  certifications: 'name',
  organizations: 'organization',
  awards: 'title',
  leadership: 'detail',
  quality_improvement: 'detail',
  research: 'detail',
  volunteer: 'detail',
  publications: 'citation',
  shadowing: 'reflection',
  custom: 'detail',
}

/** Section types an item can become a new entry of. */
export const PLACEABLE_ENTRY_TYPES: readonly ResumeSectionType[] =
  SECTION_TYPES.filter((type) => IMPORT_TEXT_FIELD[type] !== undefined)

type Sections = ResumeSectionV2[]

function withSections(resume: ResumeV2, sections: readonly ResumeSectionV2[], now: string): ResumeV2 {
  return { ...resume, sections, revision: resume.revision + 1, updatedAt: now }
}

/** The review list without one item -- and without the list, once it is empty. */
function withoutItem(sections: Sections, reviewId: string, itemId: string): Sections {
  return sections.flatMap((section) => {
    if (section.id !== reviewId || section.type !== 'custom') return [section]
    const entries = section.entries.filter((entry) => entry.id !== itemId)
    return entries.length === 0 ? [] : [{ ...section, entries } as ResumeSectionV2]
  })
}

/** New sections go where the applicant will see them: a summary first, anything else last. */
function insertSection(sections: Sections, section: ResumeSectionV2): Sections {
  if (section.type === 'summary') return [section, ...sections]
  const review = sections.findIndex(isImportReviewSection)
  if (review < 0) return [...sections, section]
  return [...sections.slice(0, review), section, ...sections.slice(review)]
}

function reviewItem(resume: ResumeV2, reviewId: string, itemId: string): { review: CustomSection; item: CustomEntry } | null {
  const review = findSection(resume, reviewId)
  if (!review || !isImportReviewSection(review)) return null
  const item = review.entries.find((entry) => entry.id === itemId)
  return item ? { review, item } : null
}

/**
 * Moves one item to where the applicant chose.
 *
 * Anything that no longer adds up -- the item already placed, the job deleted
 * a moment ago, an id that belongs to a different kind of section -- leaves the
 * resume exactly as it was, and the item where it was. An edit racing another
 * edit must never lose the text.
 */
export function placeImportItem(
  resume: ResumeV2,
  reviewId: string,
  itemId: string,
  target: ImportPlacement,
  now: string
): ResumeV2 {
  const found = reviewItem(resume, reviewId, itemId)
  if (!found) return resume
  const { item } = found
  // The list shows a line exactly as extracted, list glyph and all. Placed, the
  // glyph goes: the resume draws its own bullets, and a second one would print.
  const text = stripGlyphs(item.detail.accepted).text
  if (text === '') return resume
  const imported = text === item.detail.accepted
    ? item.detail
    : createAuthoredText(text, item.detail.originalOrigin)

  let sections: Sections = [...resume.sections]

  switch (target.kind) {
    case 'bullet': {
      const section = findSection(resume, target.sectionId)
      if (!section || (section.type !== 'critical_care' && section.type !== 'other_clinical')) return resume
      if (!section.positions.some((position) => position.id === target.positionId)) return resume
      const next = {
        ...section,
        positions: section.positions.map((position) =>
          position.id === target.positionId ? { ...position, bullets: [...position.bullets, imported] } : position),
      }
      sections = sections.map((s) => (s.id === section.id ? (next as ResumeSectionV2) : s))
      break
    }

    case 'summary': {
      const named = findSection(resume, target.sectionId)
      if (named && named.type !== 'summary') return resume
      const summary = named ?? resume.sections.find((s) => s.type === 'summary') ?? null
      if (!summary || summary.type !== 'summary') {
        sections = insertSection(sections, { ...createSection('summary', target.sectionId), text: imported })
        break
      }
      const untouched = isBlankAuthoredText(summary.text) && summary.text.history.length === 0
      const nextText = untouched
        ? imported
        : isBlankAuthoredText(summary.text)
          ? editSource(summary.text, text, now)
          : editSource(summary.text, `${summary.text.accepted.trimEnd()} ${text.trim()}`, now)
      sections = sections.map((s) => (s.id === summary.id ? ({ ...summary, text: nextText } as ResumeSectionV2) : s))
      break
    }

    case 'entry': {
      const fieldName = IMPORT_TEXT_FIELD[target.sectionType]
      const descriptor = fieldName ? fieldFor(target.sectionType, fieldName) : null
      const listKey = listKeyFor(target.sectionType)
      if (!fieldName || !descriptor || !listKey) return resume

      const entry = {
        ...blankEntry(target.sectionType, target.entryId),
        [fieldName]: descriptor.kind === 'authored' ? imported : text,
      }

      const named = findSection(resume, target.sectionId)
      if (named && (named.type !== target.sectionType || isImportReviewSection(named))) return resume
      const existing = named ?? (target.sectionType === 'custom'
        ? null
        : resume.sections.find((s) => s.type === target.sectionType) ?? null)

      if (!existing) {
        // A custom section needs a name only the applicant can give it.
        if (target.sectionType === 'custom') return resume
        const created = createSection(target.sectionType, target.sectionId) as ResumeSectionV2 & Record<string, unknown>
        sections = insertSection(sections, { ...created, [listKey]: [entry] } as ResumeSectionV2)
        break
      }

      const list = (existing as ResumeSectionV2 & Record<string, unknown>)[listKey]
      if (!Array.isArray(list) || list.some((e: { id?: string }) => e.id === target.entryId)) return resume
      const next = { ...(existing as ResumeSectionV2 & Record<string, unknown>), [listKey]: [...list, entry] }
      sections = sections.map((s) => (s.id === existing.id ? (next as ResumeSectionV2) : s))
      break
    }

    default: {
      const never: never = target
      throw new Error(`Unhandled placement: ${JSON.stringify(never)}`)
    }
  }

  return withSections(resume, withoutItem(sections, reviewId, itemId), now)
}

/**
 * Removes one item, because the applicant said so.
 *
 * The only way an item leaves the list without being placed: an explicit
 * action, confirmed in the editor. The text goes with it.
 */
export function dismissImportItem(resume: ResumeV2, reviewId: string, itemId: string, now: string): ResumeV2 {
  if (!reviewItem(resume, reviewId, itemId)) return resume
  return withSections(resume, withoutItem([...resume.sections], reviewId, itemId), now)
}

// ---------------------------------------------------------------------------
// Choosing a destination
// ---------------------------------------------------------------------------

export interface PlacementOption {
  /** What the <option> carries. See `placementFor`. */
  readonly value: string
  readonly label: string
}

export interface PlacementGroup {
  readonly label: string
  readonly options: readonly PlacementOption[]
}

function positionLabel(position: { facts: { role: string; employer: string } }, index: number): string {
  const { role, employer } = position.facts
  if (role && employer) return `${role} — ${employer}`
  return role || employer || `Position ${index + 1}`
}

/**
 * Every place an item can go on this resume, grouped as a <select> shows them.
 *
 * Jobs by name, the summary, each existing section, and a new section of any
 * type the resume does not have yet.
 */
export function placementGroups(resume: ResumeV2): PlacementGroup[] {
  const groups: PlacementGroup[] = []

  for (const section of resume.sections) {
    if (section.type !== 'critical_care' && section.type !== 'other_clinical') continue
    if (section.positions.length === 0) continue
    groups.push({
      label: `Bullet in ${headingFor(section)}`,
      options: section.positions.map((position, i) => ({
        value: `bullet:${section.id}:${position.id}`,
        label: positionLabel(position, i),
      })),
    })
  }

  const summary = resume.sections.find((s) => s.type === 'summary')
  const others: PlacementOption[] = [{
    value: 'summary',
    label: summary && !isBlankAuthoredText(summary.text)
      ? `${headingFor(summary)} (add to the end)`
      : summary ? headingFor(summary) : descriptorFor('summary').heading,
  }]

  const present = new Set<ResumeSectionType>()
  for (const section of resume.sections) {
    if (isImportReviewSection(section) || !IMPORT_TEXT_FIELD[section.type]) continue
    present.add(section.type)
    others.push({ value: `section:${section.id}`, label: `New entry in ${headingFor(section) || descriptorFor(section.type).heading}` })
  }
  for (const type of PLACEABLE_ENTRY_TYPES) {
    if (type === 'custom' || present.has(type)) continue
    others.push({ value: `new:${type}`, label: `New entry in ${descriptorFor(type).heading} (adds the section)` })
  }
  groups.push({ label: 'Somewhere else', options: others })

  return groups
}

/**
 * The placement an option stands for, with fresh ids where something is created.
 *
 * Null when the option no longer exists on this resume -- a job deleted since
 * the list was drawn -- so the control can refuse rather than send a patch
 * that would do nothing.
 */
export function placementFor(value: string, resume: ResumeV2, newId: () => string): ImportPlacement | null {
  if (value === 'summary') {
    const summary = resume.sections.find((s) => s.type === 'summary')
    return { kind: 'summary', sectionId: summary?.id ?? newId() }
  }
  const [kind, first, second] = value.split(':')
  if (kind === 'bullet' && first && second) {
    const section = findSection(resume, first)
    if (!section || (section.type !== 'critical_care' && section.type !== 'other_clinical')) return null
    return section.positions.some((p) => p.id === second) ? { kind: 'bullet', sectionId: first, positionId: second } : null
  }
  if (kind === 'section' && first) {
    const section = findSection(resume, first)
    if (!section || isImportReviewSection(section) || !IMPORT_TEXT_FIELD[section.type]) return null
    return { kind: 'entry', sectionType: section.type, sectionId: section.id, entryId: newId() }
  }
  if (kind === 'new' && first) {
    const type = PLACEABLE_ENTRY_TYPES.find((t) => t === first)
    if (!type || type === 'custom') return null
    const existing = resume.sections.find((s) => s.type === type && !isImportReviewSection(s))
    return { kind: 'entry', sectionType: type, sectionId: existing?.id ?? newId(), entryId: newId() }
  }
  return null
}

/**
 * The option an item's suggestion points at on this resume, or '' for none.
 *
 * Where the item sat in the uploaded document -- under a job, under a
 * heading -- translated into a destination that exists now.
 */
export function suggestedPlacement(item: CustomEntry, resume: ResumeV2): string {
  const suggestion = item.importItem?.suggestion
  if (!suggestion) return ''
  switch (suggestion.kind) {
    case 'bullet': {
      if (!suggestion.positionId) return ''
      for (const section of resume.sections) {
        if (section.type !== 'critical_care' && section.type !== 'other_clinical') continue
        if (section.positions.some((p) => p.id === suggestion.positionId)) {
          return `bullet:${section.id}:${suggestion.positionId}`
        }
      }
      return ''
    }
    case 'summary':
      return 'summary'
    case 'section': {
      if (!IMPORT_TEXT_FIELD[suggestion.sectionType] || suggestion.sectionType === 'custom') return ''
      const existing = resume.sections.find((s) => s.type === suggestion.sectionType && !isImportReviewSection(s))
      return existing ? `section:${existing.id}` : `new:${suggestion.sectionType}`
    }
    default:
      return ''
  }
}

/** The review list's items, for the editor. */
export function importItemsOf(resume: ResumeV2): { reviewId: string; items: readonly CustomEntry[] } | null {
  const review = importReviewSectionOf(resume)
  return review && review.entries.length > 0 ? { reviewId: review.id, items: review.entries } : null
}
