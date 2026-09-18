/**
 * The untrusted boundary for an AI proposal request.
 *
 * A request names a FIELD. It never carries content, a fact sheet, a prompt or
 * a model name -- all of those are built by the server from the stored resume,
 * which is what makes the grounding envelope an envelope rather than a
 * suggestion. If this file ever starts accepting text, layer 1 is gone.
 *
 * Pure, so every shape a browser might send is testable without a route.
 */

import type { ResumeV2 } from '../model/types.ts'
import { OPERATIONS } from './prompts.ts'
import type { AiOperation } from './prompts.ts'
import { descriptorFor } from '../studio/fields.ts'

export type { AiOperation }

/**
 * The ceiling for an ordinary request: alternative wordings of ONE field.
 *
 * The applicant picks one of them, and six is already more than anyone reads.
 */
export const MAX_ITEMS = 6

/**
 * The ceiling for bullet generation, which is a different question.
 *
 * Generation is the one operation whose answer is genuinely plural: an
 * applicant may recognise five of eight bullets as true of their work and take
 * all five. It is a SEPARATE constant so that letting generation offer more
 * cannot quietly let every other operation return more than a person can choose
 * between -- the ceiling is decided per operation, by `maxItemsFor`.
 */
export const MAX_BULLET_ITEMS = 8

/**
 * How many bullet candidates a generation asks for.
 *
 * Eight rather than one. A single suggestion is an ultimatum -- the applicant
 * cannot tell whether a better phrasing existed, and the only choice on offer
 * is take it or leave it. Several distinct candidates put the writing back in
 * their hands, which is the whole point of the human gate.
 *
 * It is an upper bound on what is ASKED for, never a target for what is shown:
 * the verifier removes anything unsupported and near-duplicates are dropped, so
 * a position with four facts still yields the few bullets those facts carry
 * rather than eight paraphrases of the same one.
 */
export const BULLET_CANDIDATES = 8

/** The most this operation may ask for. Generation is the only exception. */
export function maxItemsFor(operation: AiOperation): number {
  return operation === 'generate-bullets' ? MAX_BULLET_ITEMS : MAX_ITEMS
}

export interface ProposeCommand {
  readonly resumeId: string
  readonly sectionId: string
  /** A position or entry within the section, when the operation needs one. */
  readonly targetId: string | null
  /** Which bullet is being rewritten, for bullet-level operations. */
  readonly bulletIndex: number | null
  /**
   * The narrative field on an entry, for list-shaped sections.
   *
   * Checked against the descriptor, so a request naming a certification number
   * or an institution is refused here rather than grounded and answered. AI
   * writes prose; it does not write facts.
   */
  readonly field: string | null
  readonly operation: AiOperation
  readonly maxItems: number
}

export type ParseProposeResult =
  | { readonly ok: true; readonly value: ProposeCommand }
  | { readonly ok: false; readonly error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function id(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null
}

export function parseProposeRequest(body: unknown): ParseProposeResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Expected an object.' }
  }
  const b = body as Record<string, unknown>

  const resumeId = id(b.resumeId)
  if (!resumeId) return { ok: false, error: 'A valid resumeId is required.' }

  const sectionId = id(b.sectionId)
  if (!sectionId) return { ok: false, error: 'A valid sectionId is required.' }

  const operation = OPERATIONS.find((op) => op === b.operation)
  if (!operation) return { ok: false, error: 'Unknown operation.' }

  if (b.targetId !== undefined && b.targetId !== null && !id(b.targetId)) {
    return { ok: false, error: 'A valid targetId is required.' }
  }
  const targetId = b.targetId === undefined || b.targetId === null ? null : id(b.targetId)

  let bulletIndex: number | null = null
  if (b.bulletIndex !== undefined && b.bulletIndex !== null) {
    if (typeof b.bulletIndex !== 'number' || !Number.isInteger(b.bulletIndex) ||
        b.bulletIndex < 0 || b.bulletIndex > 500) {
      return { ok: false, error: 'A valid bulletIndex is required.' }
    }
    bulletIndex = b.bulletIndex
  }

  // Per operation, not one number for all of them: only generation may ask for
  // more than MAX_ITEMS, and it may not ask for more than its own ceiling.
  const ceiling = maxItemsFor(operation)
  let maxItems = 3
  if (b.maxItems !== undefined) {
    if (typeof b.maxItems !== 'number' || !Number.isInteger(b.maxItems) ||
        b.maxItems < 1 || b.maxItems > ceiling) {
      return { ok: false, error: 'A valid maxItems is required.' }
    }
    maxItems = b.maxItems
  }

  let field: string | null = null
  if (b.field !== undefined && b.field !== null) {
    if (typeof b.field !== 'string' || b.field.length > 64) {
      return { ok: false, error: 'A valid field is required.' }
    }
    field = b.field
  }

  // Anything else on the body is ignored rather than carried: a request that
  // could smuggle `text` would be a request that could smuggle grounding.
  return { ok: true, value: { resumeId, sectionId, targetId, bulletIndex, field, operation, maxItems } }
}

/**
 * The text an improvement operation is rewriting, read from the STORED resume.
 *
 * Not from the request. The applicant's editor may hold newer keystrokes, but
 * what the model rewrites -- and what the verifier treats as already-present
 * rather than newly invented -- has to be something the server can see.
 */
export function targetTextFor(
  resume: ResumeV2,
  sectionId: string,
  targetId: string | null,
  bulletIndex: number | null,
  field: string | null = null
): string | undefined {
  const section = resume.sections.find((s) => s.id === sectionId)
  if (!section) return undefined

  if (section.type === 'summary') return section.text.accepted || undefined

  if (section.type === 'critical_care' || section.type === 'other_clinical') {
    const position = section.positions.find((p) => p.id === targetId)
    if (!position) return undefined
    if (bulletIndex === null) return undefined
    return position.bullets[bulletIndex]?.accepted || undefined
  }

  // Every other list-shaped section addresses its narrative field by name.
  return narrativeTextOf(section, targetId, field)
}

/**
 * The accepted text of a named narrative field, or undefined.
 *
 * Returns nothing for a field the descriptor does not call 'authored', which is
 * the same check that refuses to ground one.
 */
export function narrativeTextOf(
  section: ResumeV2['sections'][number],
  entryId: string | null,
  fieldName: string | null
): string | undefined {
  const entry = descriptorFor(section.type).entry
  if (!entry || !entryId) return undefined

  const name = fieldName ?? entry.fields.find((f) => f.kind === 'authored')?.name
  if (!name) return undefined
  const field = entry.fields.find((f) => f.name === name)
  if (!field || field.kind !== 'authored') return undefined

  const list = (section as unknown as Record<string, Record<string, unknown>[]>)[entry.listKey]
  if (!Array.isArray(list)) return undefined
  const item = list.find((e) => e.id === entryId)
  const value = item?.[name] as { accepted?: string } | undefined
  return value?.accepted || undefined
}
