/**
 * The untrusted boundary: turning a request body into patches, or refusing.
 *
 * Every value that crosses this line is a scalar checked against something the
 * server already knows -- a section type from the model, a template from the
 * three, a field name from the descriptor table, a UUID, a bounded string. No
 * object from the request is ever spread into stored data; `applyPatch` builds
 * the result from a resume the server read itself.
 *
 * A refusal names what was wrong without echoing the value back, so an error
 * response cannot become a way to bounce content off the server.
 */

import { SECTION_TYPES } from '../model/types.ts'
import type { ResumeSectionType, ResumeTemplate } from '../model/types.ts'
import { CONTACT_FIELDS, POSITION_FLAGS, POSITION_LISTS, POSITION_TEXT_FACTS } from './patch.ts'
import type { ContactField, StudioPatch } from './patch.ts'
import { fieldFor } from './fields.ts'
import { PLACEABLE_ENTRY_TYPES } from './importItems.ts'
import type { ImportPlacement } from './importItems.ts'

/** One autosave carries at most this many edits. A run longer than this is a bug. */
export const MAX_PATCHES = 200

/**
 * Longest string any single field accepts.
 *
 * One live V1 professional summary is 4,214 characters. A cap has to clear real
 * data by a wide margin or it becomes the thing that loses someone's work.
 */
export const MAX_FIELD_TEXT = 20_000

/** Longest list of checkbox-style facts (devices, populations, and so on). */
export const MAX_LIST_ITEMS = 60

const TEMPLATES: readonly ResumeTemplate[] = ['classic', 'modern', 'compact']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsePatchResult =
  | { readonly ok: true; readonly patches: StudioPatch[] }
  | { readonly ok: false; readonly error: string }

const fail = (error: string): ParsePatchResult => ({ ok: false, error })

function id(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length > MAX_FIELD_TEXT ? null : value
}

function index(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000
    ? value
    : null
}

/**
 * The fact ids a proposal claims it drew on. Audit metadata, not content: it is
 * stored so "what was the model allowed to know?" has an answer later, and it
 * is bounded and shape-checked like everything else that crosses this line.
 */
function factIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 200) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 300) return null
    out.push(item)
  }
  return out
}

function sectionType(value: unknown): ResumeSectionType | null {
  return SECTION_TYPES.find((t) => t === value) ?? null
}

/**
 * A field value, checked against the kind the descriptor declares.
 *
 * The shapes accepted are exactly the ones `coerce` knows how to apply, so a
 * value that gets through here cannot reach a branch that does not expect it.
 */
function fieldValue(kind: string, value: unknown): { ok: true; value: never } | { ok: false } {
  const accept = (v: unknown) => ({ ok: true as const, value: v as never })
  switch (kind) {
    case 'text':
    case 'authored':
      return str(value) === null ? { ok: false } : accept(value)
    case 'boolean':
      return typeof value === 'boolean' ? accept(value) : { ok: false }
    case 'date':
      return str(value) === null ? { ok: false } : accept(value)
    case 'daterange': {
      if (typeof value !== 'object' || value === null) return { ok: false }
      const v = value as Record<string, unknown>
      if (v.start !== undefined && str(v.start) === null) return { ok: false }
      if (v.end !== undefined && str(v.end) === null) return { ok: false }
      if (v.isCurrent !== undefined && typeof v.isCurrent !== 'boolean') return { ok: false }
      return accept({ start: v.start, end: v.end, isCurrent: v.isCurrent })
    }
    case 'gpa': {
      if (typeof value !== 'object' || value === null) return { ok: false }
      const v = value as Record<string, unknown>
      if (v.raw !== undefined && (typeof v.raw !== 'string' || v.raw.length > 64)) return { ok: false }
      if (v.showOnResume !== undefined && typeof v.showOnResume !== 'boolean') return { ok: false }
      return accept({ raw: v.raw, showOnResume: v.showOnResume })
    }
    default:
      return { ok: false }
  }
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 200) return null
    out.push(item)
  }
  return out
}

/** Parses one patch. `sectionTypeOf` resolves a section id to its type so a
 *  field name can be checked against the right descriptor. */
export function parsePatch(
  raw: unknown,
  sectionTypeOf: (sectionId: string) => ResumeSectionType | null
): StudioPatch | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>

  switch (p.op) {
    case 'title': {
      const value = str(p.value)
      return value === null ? null : { op: 'title', value }
    }
    case 'template': {
      const template = TEMPLATES.find((t) => t === p.template)
      return template ? { op: 'template', template } : null
    }
    case 'contact': {
      const field = CONTACT_FIELDS.find((f) => f === p.field) as ContactField | undefined
      const value = str(p.value)
      return field && value !== null ? { op: 'contact', field, value } : null
    }
    case 'section-add': {
      const type = sectionType(p.sectionType)
      const sectionId = id(p.sectionId)
      return type && sectionId ? { op: 'section-add', sectionType: type, sectionId } : null
    }
    case 'section-remove': {
      const sectionId = id(p.sectionId)
      return sectionId ? { op: 'section-remove', sectionId } : null
    }
    case 'section-visible': {
      const sectionId = id(p.sectionId)
      return sectionId && typeof p.visible === 'boolean'
        ? { op: 'section-visible', sectionId, visible: p.visible }
        : null
    }
    case 'section-label': {
      const sectionId = id(p.sectionId)
      if (!sectionId) return null
      if (p.label === null) return { op: 'section-label', sectionId, label: null }
      const label = str(p.label)
      return label === null ? null : { op: 'section-label', sectionId, label }
    }
    case 'section-heading': {
      const sectionId = id(p.sectionId)
      const value = str(p.value)
      return sectionId && value !== null ? { op: 'section-heading', sectionId, value } : null
    }
    case 'section-column': {
      const sectionId = id(p.sectionId)
      if (!sectionId) return null
      if (p.column === null) return { op: 'section-column', sectionId, column: null }
      const column = p.column === 'sidebar' || p.column === 'main' ? p.column : null
      return column ? { op: 'section-column', sectionId, column } : null
    }
    case 'section-move': {
      const sectionId = id(p.sectionId)
      const toIndex = index(p.toIndex)
      return sectionId && toIndex !== null ? { op: 'section-move', sectionId, toIndex } : null
    }
    case 'section-reorder': {
      if (!Array.isArray(p.orderedIds) || p.orderedIds.length > 100) return null
      const orderedIds: string[] = []
      for (const value of p.orderedIds) {
        const sectionId = id(value)
        if (!sectionId) return null
        orderedIds.push(sectionId)
      }
      return { op: 'section-reorder', orderedIds }
    }
    case 'summary': {
      const sectionId = id(p.sectionId)
      const value = str(p.value)
      return sectionId && value !== null ? { op: 'summary', sectionId, value } : null
    }
    case 'entry-add': {
      const sectionId = id(p.sectionId)
      const entryId = id(p.entryId)
      return sectionId && entryId ? { op: 'entry-add', sectionId, entryId } : null
    }
    case 'entry-remove': {
      const sectionId = id(p.sectionId)
      const entryId = id(p.entryId)
      return sectionId && entryId ? { op: 'entry-remove', sectionId, entryId } : null
    }
    case 'entry-move': {
      const sectionId = id(p.sectionId)
      const entryId = id(p.entryId)
      const toIndex = index(p.toIndex)
      return sectionId && entryId && toIndex !== null
        ? { op: 'entry-move', sectionId, entryId, toIndex }
        : null
    }
    case 'field': {
      const sectionId = id(p.sectionId)
      const entryId = id(p.entryId)
      if (!sectionId || !entryId || typeof p.field !== 'string') return null
      const type = sectionTypeOf(sectionId)
      if (!type) return null
      const descriptor = fieldFor(type, p.field)
      if (!descriptor) return null
      const checked = fieldValue(descriptor.kind, p.value)
      if (!checked.ok) return null
      return { op: 'field', sectionId, entryId, field: p.field, value: checked.value }
    }
    case 'position-add': {
      const sectionId = id(p.sectionId)
      const positionId = id(p.positionId)
      return sectionId && positionId ? { op: 'position-add', sectionId, positionId } : null
    }
    case 'position-remove': {
      const sectionId = id(p.sectionId)
      const positionId = id(p.positionId)
      return sectionId && positionId ? { op: 'position-remove', sectionId, positionId } : null
    }
    case 'position-fact': {
      const sectionId = id(p.sectionId)
      const positionId = id(p.positionId)
      if (!sectionId || !positionId || typeof p.field !== 'string') return null

      if ((POSITION_TEXT_FACTS as readonly string[]).includes(p.field)) {
        const value = str(p.value)
        return value === null ? null : { op: 'position-fact', sectionId, positionId, field: p.field, value }
      }
      if ((POSITION_FLAGS as readonly string[]).includes(p.field)) {
        return typeof p.value === 'boolean'
          ? { op: 'position-fact', sectionId, positionId, field: p.field, value: p.value }
          : null
      }
      if ((POSITION_LISTS as readonly string[]).includes(p.field)) {
        const value = stringList(p.value)
        return value === null ? null : { op: 'position-fact', sectionId, positionId, field: p.field, value }
      }
      if (p.field === 'dates') {
        const checked = fieldValue('daterange', p.value)
        return checked.ok
          ? { op: 'position-fact', sectionId, positionId, field: 'dates', value: checked.value }
          : null
      }
      return null
    }
    case 'bullet-add': {
      const sectionId = id(p.sectionId)
      const positionId = id(p.positionId)
      return sectionId && positionId ? { op: 'bullet-add', sectionId, positionId } : null
    }
    case 'bullet-remove': {
      const sectionId = id(p.sectionId)
      const positionId = id(p.positionId)
      const i = index(p.index)
      return sectionId && positionId && i !== null
        ? { op: 'bullet-remove', sectionId, positionId, index: i }
        : null
    }
    case 'ai-accept-summary': {
      const sectionId = id(p.sectionId)
      const text = str(p.text)
      const model = str(p.model)
      const groundedIn = factIds(p.groundedIn)
      return sectionId && text !== null && model !== null && groundedIn
        ? { op: 'ai-accept-summary', sectionId, text, model, groundedIn }
        : null
    }
    case 'ai-accept-bullet': {
      const sectionId = id(p.sectionId)
      const positionId = id(p.positionId)
      const i = index(p.index)
      const text = str(p.text)
      const model = str(p.model)
      const groundedIn = factIds(p.groundedIn)
      return sectionId && positionId && i !== null && text !== null && model !== null && groundedIn
        ? { op: 'ai-accept-bullet', sectionId, positionId, index: i, text, model, groundedIn }
        : null
    }
    case 'ai-accept-field': {
      const sectionId = id(p.sectionId)
      const entryId = id(p.entryId)
      const text = str(p.text)
      const model = str(p.model)
      const groundedIn = factIds(p.groundedIn)
      if (!sectionId || !entryId || typeof p.field !== 'string' || text === null ||
          model === null || !groundedIn) return null
      // Checked against the addressed section's own descriptor, so a narrative
      // op aimed at a factual field never reaches the domain model.
      const type = sectionTypeOf(sectionId)
      if (!type) return null
      const descriptor = fieldFor(type, p.field)
      if (!descriptor || descriptor.kind !== 'authored') return null
      return { op: 'ai-accept-field', sectionId, entryId, field: p.field, text, model, groundedIn }
    }
    case 'ai-restore-field': {
      const sectionId = id(p.sectionId)
      const entryId = id(p.entryId)
      const scope = p.scope === 'original' || p.scope === 'user' ? p.scope : null
      if (!sectionId || !entryId || typeof p.field !== 'string' || !scope) return null
      const type = sectionTypeOf(sectionId)
      if (!type) return null
      const descriptor = fieldFor(type, p.field)
      if (!descriptor || descriptor.kind !== 'authored') return null
      return { op: 'ai-restore-field', sectionId, entryId, field: p.field, scope }
    }
    case 'ai-restore-summary': {
      const sectionId = id(p.sectionId)
      const scope = p.scope === 'original' || p.scope === 'user' ? p.scope : null
      return sectionId && scope ? { op: 'ai-restore-summary', sectionId, scope } : null
    }
    case 'ai-restore-bullet': {
      const sectionId = id(p.sectionId)
      const positionId = id(p.positionId)
      const i = index(p.index)
      const scope = p.scope === 'original' || p.scope === 'user' ? p.scope : null
      return sectionId && positionId && i !== null && scope
        ? { op: 'ai-restore-bullet', sectionId, positionId, index: i, scope }
        : null
    }
    case 'bullet-text': {
      const sectionId = id(p.sectionId)
      const positionId = id(p.positionId)
      const i = index(p.index)
      const value = str(p.value)
      return sectionId && positionId && i !== null && value !== null
        ? { op: 'bullet-text', sectionId, positionId, index: i, value }
        : null
    }
    case 'import-item-place': {
      const sectionId = id(p.sectionId)
      const entryId = id(p.entryId)
      const target = importPlacement(p.target)
      return sectionId && entryId && target ? { op: 'import-item-place', sectionId, entryId, target } : null
    }
    case 'output-lock':
      // Carries nothing: the timestamp is the server's, and which resume it is
      // comes from the request, not from the patch.
      return { op: 'output-lock' }
    case 'import-item-dismiss': {
      const sectionId = id(p.sectionId)
      const entryId = id(p.entryId)
      return sectionId && entryId ? { op: 'import-item-dismiss', sectionId, entryId } : null
    }
    default:
      return null
  }
}

/**
 * Where an imported item is going: ids and a section type, nothing else. The
 * text itself never crosses this line -- it is read from the stored item.
 */
function importPlacement(value: unknown): ImportPlacement | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const t = value as Record<string, unknown>
  const sectionId = id(t.sectionId)
  if (!sectionId) return null
  switch (t.kind) {
    case 'bullet': {
      const positionId = id(t.positionId)
      return positionId ? { kind: 'bullet', sectionId, positionId } : null
    }
    case 'summary':
      return { kind: 'summary', sectionId }
    case 'entry': {
      const type = sectionType(t.sectionType)
      const entryId = id(t.entryId)
      return type && entryId && PLACEABLE_ENTRY_TYPES.includes(type)
        ? { kind: 'entry', sectionType: type, sectionId, entryId }
        : null
    }
    default:
      return null
  }
}

/**
 * Parses a whole run. All or nothing: one bad patch refuses the batch rather
 * than applying a prefix, because a half-applied run is a document the client
 * does not believe it has and the next save would silently entrench.
 */
export function parsePatches(
  raw: unknown,
  sectionTypeOf: (sectionId: string) => ResumeSectionType | null
): ParsePatchResult {
  if (!Array.isArray(raw)) return fail('Expected a list of edits.')
  if (raw.length === 0) return fail('No edits to apply.')
  if (raw.length > MAX_PATCHES) return fail('Too many edits in one save.')

  const patches: StudioPatch[] = []
  for (let i = 0; i < raw.length; i++) {
    const patch = parsePatch(raw[i], sectionTypeOf)
    if (!patch) return fail(`Edit ${i + 1} was not understood.`)
    patches.push(patch)
  }
  return { ok: true, patches }
}
