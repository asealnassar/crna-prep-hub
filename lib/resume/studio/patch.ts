/**
 * What one edit in the Studio looks like on the wire, and what it does.
 *
 * WHY PATCHES AND NOT A DOCUMENT. The blueprint's autosave design says "send
 * only the changed section", and there is a second reason beyond payload size:
 * a route that accepts a whole ResumeV2 from a browser has to validate a deep,
 * fifteen-variant union of untrusted JSON before it can be stored. A patch
 * carries scalars -- an id, a field name, a string -- so the validation surface
 * is a handful of enum checks, and the SERVER assembles the document from a row
 * it read itself. Nothing the client sends is ever stored verbatim.
 *
 * The storage call underneath is still the whole-document `save_resume_v2` from
 * Phase 2, which is what makes a save atomic. Small patches in, one atomic
 * write out.
 *
 * Every operation is pure and total: an id that does not exist, an index out of
 * range, a field the section does not have -- each returns the resume unchanged
 * rather than throwing. A malformed patch must not be able to take the Studio
 * down, and an edit that lands after the thing it referred to was deleted is an
 * ordinary race, not an error.
 */

import {
  addSection, findSection, lockResumeOutput, moveSection, removeSection, reorderSections,
  replaceSection, setContact, setSectionVisibility, setTemplate, setTitle,
} from '../model/resume.ts'
import {
  acceptProposal, createAuthoredText, editSource, propose, restoreOriginal, restoreUserText,
} from '../model/authoredText.ts'
import type { AuthoredText } from '../model/authoredText.ts'
import { createClinicalPosition, hasFixedHeading } from '../model/sections.ts'
import { parseResumeDate, parseResumeDateRange } from '../model/dates.ts'
import { SECTION_TYPES } from '../model/types.ts'
import type {
  ClinicalPosition, ResumeContact, ResumeSectionType, ResumeSectionV2,
  ResumeTemplate, ResumeV2,
} from '../model/types.ts'
import { blankEntry, fieldFor, listKeyFor } from './fields.ts'
import { dismissImportItem, placeImportItem } from './importItems.ts'
import type { ImportPlacement } from './importItems.ts'

/** The contact fields a patch may touch. Nothing else on the header exists. */
export const CONTACT_FIELDS = [
  'fullName', 'credentials', 'email', 'phone', 'city', 'state', 'linkedin', 'website',
] as const
export type ContactField = (typeof CONTACT_FIELDS)[number]

/** Facts a person types about a position. Grounding, not resume output. */
export const POSITION_TEXT_FACTS = [
  'employer', 'location', 'role', 'unit', 'unitType', 'acuity',
] as const
export const POSITION_FLAGS = ['chargeExperience', 'preceptorExperience'] as const
export const POSITION_LISTS = [
  'patientPopulations', 'devices', 'therapies', 'committees', 'specialResponsibilities',
] as const

export interface DateRangeValue {
  readonly start?: string
  readonly end?: string
  readonly isCurrent?: boolean
}
export interface GpaValueInput {
  readonly raw?: string
  readonly showOnResume?: boolean
}
export type FieldValue = string | boolean | DateRangeValue | GpaValueInput | readonly string[]

export type StudioPatch =
  | { readonly op: 'title'; readonly value: string }
  | { readonly op: 'template'; readonly template: ResumeTemplate }
  | { readonly op: 'contact'; readonly field: ContactField; readonly value: string }
  | { readonly op: 'section-add'; readonly sectionType: ResumeSectionType; readonly sectionId: string }
  | { readonly op: 'section-remove'; readonly sectionId: string }
  | { readonly op: 'section-visible'; readonly sectionId: string; readonly visible: boolean }
  | { readonly op: 'section-label'; readonly sectionId: string; readonly label: string | null }
  | { readonly op: 'section-heading'; readonly sectionId: string; readonly value: string }
  /**
   * Which column a section is drawn in on a two-column template.
   *
   * `null` gives it back to the template's own default. Layout only: it changes
   * where a section is drawn and never what the resume says, nor the order a
   * parser reads it in.
   */
  | {
      readonly op: 'section-column'
      readonly sectionId: string
      readonly column: 'sidebar' | 'main' | null
    }
  | { readonly op: 'section-move'; readonly sectionId: string; readonly toIndex: number }
  | { readonly op: 'section-reorder'; readonly orderedIds: readonly string[] }
  | { readonly op: 'summary'; readonly sectionId: string; readonly value: string }
  | { readonly op: 'entry-add'; readonly sectionId: string; readonly entryId: string }
  | { readonly op: 'entry-remove'; readonly sectionId: string; readonly entryId: string }
  | { readonly op: 'entry-move'; readonly sectionId: string; readonly entryId: string; readonly toIndex: number }
  | {
      readonly op: 'field'
      readonly sectionId: string
      readonly entryId: string
      readonly field: string
      readonly value: FieldValue
    }
  | { readonly op: 'position-add'; readonly sectionId: string; readonly positionId: string }
  | { readonly op: 'position-remove'; readonly sectionId: string; readonly positionId: string }
  | {
      readonly op: 'position-fact'
      readonly sectionId: string
      readonly positionId: string
      readonly field: string
      readonly value: FieldValue
    }
  | { readonly op: 'bullet-add'; readonly sectionId: string; readonly positionId: string }
  | { readonly op: 'bullet-remove'; readonly sectionId: string; readonly positionId: string; readonly index: number }
  /**
   * An AI proposal the applicant accepted.
   *
   * Goes through `propose` then `acceptProposal` rather than `editSource`, so
   * the text is marked 'ai-accepted' and the applicant's own words stay
   * recoverable. `editSource` would claim they wrote it -- which would be a
   * lie, and would also feed it back as grounding on the next call.
   *
   * The route re-verifies the text against a freshly built fact sheet before
   * applying this. A proposal is verified when it is offered and again when it
   * lands, because the two are different requests.
   */
  | {
      readonly op: 'ai-accept-summary'
      readonly sectionId: string
      readonly text: string
      readonly model: string
      readonly groundedIn: readonly string[]
    }
  | {
      readonly op: 'ai-accept-bullet'
      readonly sectionId: string
      readonly positionId: string
      readonly index: number
      readonly text: string
      readonly model: string
      readonly groundedIn: readonly string[]
    }
  /**
   * Undoing an AI acceptance. `scope: 'user'` restores the applicant's own last
   * words -- the control that matters for text written in the Studio.
   * `scope: 'original'` restores the first text ever supplied, which is only
   * meaningful for imported prose; the UI hides it otherwise, because for a
   * field created blank it would erase rather than restore.
   */
  | {
      readonly op: 'ai-accept-field'
      readonly sectionId: string
      readonly entryId: string
      readonly field: string
      readonly text: string
      readonly model: string
      readonly groundedIn: readonly string[]
    }
  | {
      readonly op: 'ai-restore-field'
      readonly sectionId: string
      readonly entryId: string
      readonly field: string
      readonly scope: 'original' | 'user'
    }
  | {
      readonly op: 'ai-restore-summary'
      readonly sectionId: string
      readonly scope: 'original' | 'user'
    }
  | {
      readonly op: 'ai-restore-bullet'
      readonly sectionId: string
      readonly positionId: string
      readonly index: number
      readonly scope: 'original' | 'user'
    }
  | {
      readonly op: 'bullet-text'
      readonly sectionId: string
      readonly positionId: string
      readonly index: number
      readonly value: string
    }
  /**
   * An item from "Imported items to review" moved to where the applicant
   * chose. `sectionId`/`entryId` name the review list and the item; see
   * lib/resume/studio/importItems.ts.
   */
  | {
      readonly op: 'import-item-place'
      readonly sectionId: string
      readonly entryId: string
      readonly target: ImportPlacement
    }
  /** An item removed from "Imported items to review", because the applicant said so. */
  | { readonly op: 'import-item-dismiss'; readonly sectionId: string; readonly entryId: string }
  /**
   * The applicant tried to download, saw the upgrade modal, and chose "Not
   * now". Nothing else sends this: not opening the Studio, not editing, and
   * not closing that modal any other way.
   */
  | { readonly op: 'output-lock' }

export interface PatchContext {
  /** ISO timestamp. Injected so applying a patch is deterministic in tests. */
  readonly now: string
}

// ---------------------------------------------------------------------------
// Value coercion, by the field's declared kind
// ---------------------------------------------------------------------------

function asString(value: FieldValue): string {
  return typeof value === 'string' ? value : ''
}

function asStringList(value: FieldValue): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== '')
}

/**
 * Applies a value to a field according to the descriptor's kind.
 *
 * An 'authored' field goes through `editSource`, never through assignment: that
 * is what preserves the original text, the provenance and the history when a
 * person edits over something an AI proposed. Writing the string directly would
 * quietly erase all three.
 */
function coerce(kind: string, value: FieldValue, current: unknown, now: string): unknown {
  switch (kind) {
    case 'text': return asString(value)
    case 'boolean': return value === true
    case 'date': return parseResumeDate(asString(value))
    case 'daterange': {
      const v = (typeof value === 'object' && value !== null ? value : {}) as DateRangeValue
      return parseResumeDateRange({ start: v.start, end: v.end, isCurrent: v.isCurrent })
    }
    case 'gpa': {
      const v = (typeof value === 'object' && value !== null ? value : {}) as GpaValueInput
      const raw = typeof v.raw === 'string' ? v.raw.trim() : ''
      const parsed = Number.parseFloat(raw)
      return {
        raw,
        value: Number.isFinite(parsed) && /^\d*\.?\d+/.test(raw) ? parsed : null,
        showOnResume: v.showOnResume === true,
      }
    }
    case 'authored': {
      const existing = (current ?? null) as AuthoredText | null
      const next = asString(value)
      return existing ? editSource(existing, next, now) : createAuthoredText(next)
    }
    default: return current
  }
}

// ---------------------------------------------------------------------------
// Section and entry plumbing
// ---------------------------------------------------------------------------

type AnySection = ResumeSectionV2 & Record<string, unknown>

function entriesOf(section: ResumeSectionV2): Record<string, unknown>[] | null {
  const key = listKeyFor(section.type)
  if (!key) return null
  const list = (section as AnySection)[key]
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : null
}

function withEntries(section: ResumeSectionV2, list: readonly unknown[]): ResumeSectionV2 {
  const key = listKeyFor(section.type)
  if (!key) return section
  return { ...(section as AnySection), [key]: list } as ResumeSectionV2
}

function positionsOf(section: ResumeSectionV2): ClinicalPosition[] | null {
  if (section.type !== 'critical_care' && section.type !== 'other_clinical') return null
  return [...section.positions]
}

/** Clamps rather than refusing: a drag that overshoots lands at the end. */
function moveWithin<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Replaces a section only when it actually changed.
 *
 * `replaceSection` bumps the revision unconditionally, which is right for a
 * real edit and wrong for a patch that turned out to change nothing -- a bullet
 * removed at an index that does not exist, a field rewritten with the value it
 * already held. A bump without a change inflates the revision, makes a stored
 * strength score look stale, and costs a save. The structural compare is cheap:
 * a section is small, and both sides are built by spreading the same object, so
 * their key order matches.
 */
function replaceIfChanged(resume: ResumeV2, next: ResumeSectionV2, now: string): ResumeV2 {
  const current = findSection(resume, next.id)
  if (current && JSON.stringify(current) === JSON.stringify(next)) return resume
  return replaceSection(resume, next, now)
}

export function applyPatch(resume: ResumeV2, patch: StudioPatch, ctx: PatchContext): ResumeV2 {
  const { now } = ctx

  switch (patch.op) {
    case 'title':
      return setTitle(resume, patch.value, now)

    case 'template':
      return setTemplate(resume, patch.template, now)

    case 'contact': {
      if (!CONTACT_FIELDS.includes(patch.field)) return resume
      const contact: ResumeContact = { ...resume.contact, [patch.field]: patch.value }
      return setContact(resume, contact, now)
    }

    case 'section-add':
      return addSection(resume, patch.sectionType, patch.sectionId, now)

    case 'section-remove':
      return removeSection(resume, patch.sectionId, now)

    case 'section-visible':
      return setSectionVisibility(resume, patch.sectionId, patch.visible, now)

    case 'section-label': {
      const section = findSection(resume, patch.sectionId)
      // A fixed heading is not relabelled. Nothing rather than a refusal, so an
      // editor that predates the rule still saves the rest of what it sent.
      if (!section || hasFixedHeading(section.type)) return resume
      // STORED AS TYPED. Trimming here ran on every keystroke, so the space
      // between two words was deleted the moment it was typed: "Critical Care
      // Experience" could only ever be saved as "CriticalCareExperience".
      // All-whitespace is still no heading, and `headingFor` trims the ends
      // when a heading is read, so nothing prints with a stray edge space.
      const label = patch.label === null || patch.label.trim() === '' ? null : patch.label
      return replaceIfChanged(resume, { ...section, label } as ResumeSectionV2, now)
    }

    case 'section-heading': {
      const section = findSection(resume, patch.sectionId)
      if (!section || section.type !== 'custom') return resume
      return replaceIfChanged(resume, { ...section, heading: patch.value }, now)
    }

    case 'section-column': {
      const section = findSection(resume, patch.sectionId)
      if (!section) return resume
      // Cleared back to the default by REMOVING the field rather than storing a
      // third value: "the template decides" is exactly what its absence means,
      // and a record that has never been touched must stay indistinguishable
      // from one that was moved and moved back.
      const { modernColumn: _current, ...rest } = section as ResumeSectionV2 & Record<string, unknown>
      const next = patch.column === null ? rest : { ...rest, modernColumn: patch.column }
      // A layout edit is an edit: the revision bumps, and a stored Resume
      // Strength for the previous revision is stale, exactly as it is after a
      // reorder. See replaceIfChanged.
      return replaceIfChanged(resume, next as ResumeSectionV2, now)
    }

    case 'section-move':
      return moveSection(resume, patch.sectionId, patch.toIndex, now)

    case 'section-reorder':
      return reorderSections(resume, patch.orderedIds, now)

    case 'summary': {
      const section = findSection(resume, patch.sectionId)
      if (!section || section.type !== 'summary') return resume
      return replaceIfChanged(resume, { ...section, text: editSource(section.text, patch.value, now) }, now)
    }

    case 'entry-add': {
      const section = findSection(resume, patch.sectionId)
      if (!section) return resume
      const list = entriesOf(section)
      if (!list) return resume
      return replaceIfChanged(resume, withEntries(section, [...list, blankEntry(section.type, patch.entryId)]), now)
    }

    case 'entry-remove': {
      const section = findSection(resume, patch.sectionId)
      if (!section) return resume
      const list = entriesOf(section)
      if (!list) return resume
      const kept = list.filter((e) => e.id !== patch.entryId)
      if (kept.length === list.length) return resume
      return replaceIfChanged(resume, withEntries(section, kept), now)
    }

    case 'entry-move': {
      const section = findSection(resume, patch.sectionId)
      if (!section) return resume
      const list = entriesOf(section)
      if (!list) return resume
      const from = list.findIndex((e) => e.id === patch.entryId)
      if (from < 0) return resume
      return replaceIfChanged(resume, withEntries(section, moveWithin(list, from, patch.toIndex)), now)
    }

    case 'field': {
      const section = findSection(resume, patch.sectionId)
      if (!section) return resume
      // The descriptor is the allowlist: a field it does not declare cannot be
      // written, whatever the request says.
      const descriptor = fieldFor(section.type, patch.field)
      if (!descriptor) return resume
      const list = entriesOf(section)
      if (!list) return resume
      let touched = false
      const next = list.map((e) => {
        if (e.id !== patch.entryId) return e
        touched = true
        return { ...e, [patch.field]: coerce(descriptor.kind, patch.value, e[patch.field], now) }
      })
      if (!touched) return resume
      return replaceIfChanged(resume, withEntries(section, next), now)
    }

    case 'position-add': {
      const section = findSection(resume, patch.sectionId)
      const positions = section ? positionsOf(section) : null
      if (!section || !positions) return resume
      return replaceSection(
        resume,
        { ...section, positions: [...positions, createClinicalPosition(patch.positionId)] } as ResumeSectionV2,
        now
      )
    }

    case 'position-remove': {
      const section = findSection(resume, patch.sectionId)
      const positions = section ? positionsOf(section) : null
      if (!section || !positions) return resume
      const kept = positions.filter((p) => p.id !== patch.positionId)
      if (kept.length === positions.length) return resume
      return replaceIfChanged(resume, { ...section, positions: kept } as ResumeSectionV2, now)
    }

    case 'position-fact': {
      const section = findSection(resume, patch.sectionId)
      const positions = section ? positionsOf(section) : null
      if (!section || !positions) return resume

      const kind = factKind(patch.field)
      if (!kind) return resume

      let touched = false
      const next = positions.map((p) => {
        if (p.id !== patch.positionId) return p
        touched = true
        const value =
          kind === 'list' ? asStringList(patch.value)
            : kind === 'flag' ? patch.value === true
              : kind === 'dates' ? parseResumeDateRange(
                (typeof patch.value === 'object' && patch.value !== null ? patch.value : {}) as DateRangeValue)
                : asString(patch.value)
        return { ...p, facts: { ...p.facts, [patch.field]: value } }
      })
      if (!touched) return resume
      return replaceIfChanged(resume, { ...section, positions: next } as ResumeSectionV2, now)
    }

    case 'ai-accept-summary': {
      const section = findSection(resume, patch.sectionId)
      if (!section || section.type !== 'summary') return resume
      const accepted = acceptProposal(
        propose(section.text, {
          text: patch.text, model: patch.model,
          groundedIn: [...patch.groundedIn], createdAt: now,
        }),
        now
      )
      return replaceIfChanged(resume, { ...section, text: accepted }, now)
    }

    case 'ai-accept-bullet':
      return mapPosition(resume, patch.sectionId, patch.positionId, now, (p) => {
        // Accepting into a bullet that is no longer there is an ordinary race.
        if (patch.index < 0 || patch.index >= p.bullets.length) return p
        const accepted = acceptProposal(
          propose(p.bullets[patch.index], {
            text: patch.text, model: patch.model,
            groundedIn: [...patch.groundedIn], createdAt: now,
          }),
          now
        )
        return { ...p, bullets: p.bullets.map((b, i) => (i === patch.index ? accepted : b)) }
      })

    case 'ai-accept-field':
    case 'ai-restore-field': {
      const section = findSection(resume, patch.sectionId)
      if (!section) return resume
      // The descriptor is the allowlist, exactly as it is for a typed edit: a
      // field it does not call 'authored' cannot be AI-written, whatever the
      // request says. That is what keeps AI off names, dates and licence
      // numbers without a second list of exceptions to maintain.
      const descriptor = fieldFor(section.type, patch.field)
      if (!descriptor || descriptor.kind !== 'authored') return resume

      const list = entriesOf(section)
      if (!list) return resume

      let touched = false
      const next = list.map((entry) => {
        if (entry.id !== patch.entryId) return entry
        touched = true
        const current = (entry[patch.field] ?? createAuthoredText('')) as AuthoredText
        const updated = patch.op === 'ai-accept-field'
          ? acceptProposal(
              propose(current, {
                text: patch.text, model: patch.model,
                groundedIn: [...patch.groundedIn], createdAt: now,
              }),
              now
            )
          : patch.scope === 'original'
            ? restoreOriginal(current, now)
            : restoreUserText(current, now)
        return { ...entry, [patch.field]: updated }
      })
      if (!touched) return resume
      return replaceIfChanged(resume, withEntries(section, next), now)
    }

    case 'ai-restore-summary': {
      const section = findSection(resume, patch.sectionId)
      if (!section || section.type !== 'summary') return resume
      const restored = patch.scope === 'original'
        ? restoreOriginal(section.text, now)
        : restoreUserText(section.text, now)
      return replaceIfChanged(resume, { ...section, text: restored }, now)
    }

    case 'ai-restore-bullet':
      return mapPosition(resume, patch.sectionId, patch.positionId, now, (p) => {
        if (patch.index < 0 || patch.index >= p.bullets.length) return p
        const current = p.bullets[patch.index]
        const restored = patch.scope === 'original'
          ? restoreOriginal(current, now)
          : restoreUserText(current, now)
        return { ...p, bullets: p.bullets.map((b, i) => (i === patch.index ? restored : b)) }
      })

    case 'bullet-add':
      return mapPosition(resume, patch.sectionId, patch.positionId, now, (p) => ({
        ...p, bullets: [...p.bullets, createAuthoredText('')],
      }))

    case 'bullet-remove':
      return mapPosition(resume, patch.sectionId, patch.positionId, now, (p) => {
        if (patch.index < 0 || patch.index >= p.bullets.length) return p
        return { ...p, bullets: p.bullets.filter((_, i) => i !== patch.index) }
      })

    case 'bullet-text':
      return mapPosition(resume, patch.sectionId, patch.positionId, now, (p) => {
        if (patch.index < 0 || patch.index >= p.bullets.length) return p
        return {
          ...p,
          bullets: p.bullets.map((b, i) => (i === patch.index ? editSource(b, patch.value, now) : b)),
        }
      })

    case 'import-item-place':
      return placeImportItem(resume, patch.sectionId, patch.entryId, patch.target, now)

    case 'import-item-dismiss':
      return dismissImportItem(resume, patch.sectionId, patch.entryId, now)

    case 'output-lock':
      return lockResumeOutput(resume, now)

    default: {
      const never: never = patch
      throw new Error(`Unhandled patch: ${JSON.stringify(never)}`)
    }
  }
}

function factKind(field: string): 'text' | 'flag' | 'list' | 'dates' | null {
  if ((POSITION_TEXT_FACTS as readonly string[]).includes(field)) return 'text'
  if ((POSITION_FLAGS as readonly string[]).includes(field)) return 'flag'
  if ((POSITION_LISTS as readonly string[]).includes(field)) return 'list'
  if (field === 'dates') return 'dates'
  return null
}

function mapPosition(
  resume: ResumeV2,
  sectionId: string,
  positionId: string,
  now: string,
  change: (p: ClinicalPosition) => ClinicalPosition
): ResumeV2 {
  const section = findSection(resume, sectionId)
  const positions = section ? positionsOf(section) : null
  if (!section || !positions) return resume
  let touched = false
  const next = positions.map((p) => {
    if (p.id !== positionId) return p
    touched = true
    return change(p)
  })
  if (!touched) return resume
  return replaceIfChanged(resume, { ...section, positions: next } as ResumeSectionV2, now)
}

/** Applies a run of patches in order. One save, however many edits produced it. */
export function applyPatches(
  resume: ResumeV2,
  patches: readonly StudioPatch[],
  ctx: PatchContext
): ResumeV2 {
  return patches.reduce((current, patch) => applyPatch(current, patch, ctx), resume)
}

/**
 * Section types the Add menu offers.
 *
 * A type already on the resume is not offered again -- two Education sections
 * is a mistake, not a feature. Custom is the exception: it is the escape hatch
 * for anything the fourteen named types do not cover, so it is always offered.
 * The model itself forbids none of this; this is a UI courtesy, and a patch
 * that adds a second Education section still works.
 */
export function addableSectionTypes(resume: ResumeV2): ResumeSectionType[] {
  const present = new Set(resume.sections.map((s) => s.type))
  return SECTION_TYPES.filter((type) => type === 'custom' || !present.has(type))
}
