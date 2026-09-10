/**
 * What the dashboard may ask the server to do, and what those requests mean.
 *
 * Everything a route handler decides is here as a pure function, so the route
 * itself is authenticate -> parse -> act. Two things this is responsible for:
 *
 * 1. NOTHING UNTRUSTED REACHES THE DOMAIN MODEL UNPARSED. A request body is
 *    `unknown` until this module has agreed what it is. Ids must look like ids,
 *    revisions must be positive integers, statuses must be one of the two the
 *    check constraint allows, and titles are trimmed and capped.
 *
 * 2. PAYLOAD CAPS. The blueprint bounds autosave with "debounce plus server
 *    payload caps"; the debounce is in autosave.ts and the caps are here.
 */

import type { ResumeSectionV2, ResumeStatus, ResumeV2 } from '../model/types.ts'

/** Long enough for "Duke CRNA application - critical care emphasis". */
export const MAX_TITLE = 120

/** What an untitled resume is called before the applicant names it. */
export const DEFAULT_TITLE = 'Untitled resume'

/**
 * Largest request body a draft route will read, in bytes. A resume is a few
 * kilobytes of text; anything approaching this is not a resume. Enforced by the
 * route on the raw body BEFORE parsing, so a large payload costs no CPU.
 */
export const MAX_BODY_BYTES = 256 * 1024

const STATUSES: readonly ResumeStatus[] = ['draft', 'complete']

export type DraftCommand =
  | { readonly kind: 'create'; readonly title: string }
  | { readonly kind: 'duplicate'; readonly sourceId: string }
  | { readonly kind: 'rename'; readonly id: string; readonly title: string; readonly expectedRevision: number }
  | { readonly kind: 'set-status'; readonly id: string; readonly status: ResumeStatus; readonly expectedRevision: number }
  | { readonly kind: 'delete'; readonly id: string }

export type ParseResult =
  | { readonly ok: true; readonly command: DraftCommand }
  | { readonly ok: false; readonly error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function asId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null
}

function asRevision(value: unknown): number | null {
  // A revision arriving as a JSON string is a bug in the caller, not something
  // to coerce: silently accepting "3" hides the day it starts arriving as "3a".
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null
  return value
}

/** Trims, collapses runs of whitespace, and caps. Never returns whitespace. */
export function normaliseTitle(value: unknown, fallback = DEFAULT_TITLE): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
  return cleaned === '' ? fallback : cleaned
}

export function parseCommand(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Expected an object.' }
  }
  const b = body as Record<string, unknown>

  switch (b.action) {
    case 'create':
      return { ok: true, command: { kind: 'create', title: normaliseTitle(b.title) } }

    case 'duplicate': {
      const sourceId = asId(b.sourceId)
      if (!sourceId) return { ok: false, error: 'A valid sourceId is required.' }
      return { ok: true, command: { kind: 'duplicate', sourceId } }
    }

    case 'rename': {
      const id = asId(b.id)
      if (!id) return { ok: false, error: 'A valid id is required.' }
      const expectedRevision = asRevision(b.expectedRevision)
      if (expectedRevision === null) return { ok: false, error: 'A valid expectedRevision is required.' }
      return { ok: true, command: { kind: 'rename', id, title: normaliseTitle(b.title), expectedRevision } }
    }

    case 'set-status': {
      const id = asId(b.id)
      if (!id) return { ok: false, error: 'A valid id is required.' }
      const expectedRevision = asRevision(b.expectedRevision)
      if (expectedRevision === null) return { ok: false, error: 'A valid expectedRevision is required.' }
      const status = STATUSES.find((s) => s === b.status)
      if (!status) return { ok: false, error: 'Unknown status.' }
      return { ok: true, command: { kind: 'set-status', id, status, expectedRevision } }
    }

    case 'delete': {
      const id = asId(b.id)
      if (!id) return { ok: false, error: 'A valid id is required.' }
      return { ok: true, command: { kind: 'delete', id } }
    }

    default:
      return { ok: false, error: 'Unknown action.' }
  }
}

// ------------------------------------------------------------- duplicate

export type DuplicatePlan =
  | { readonly ok: true; readonly resume: ResumeV2 }
  | { readonly ok: false; readonly reason: 'not-owner' | 'missing-ids' }

/** " (copy)", kept inside the cap even for a title already at the limit. */
export function duplicateTitle(sourceTitle: string): string {
  const suffix = ' (copy)'
  const base = sourceTitle.trim() === '' ? DEFAULT_TITLE : sourceTitle.trim()
  if (base.length + suffix.length <= MAX_TITLE) return base + suffix
  return base.slice(0, MAX_TITLE - suffix.length) + suffix
}

/**
 * The copy a duplicate produces.
 *
 * Ownership is re-checked here even though RLS already scopes the read that
 * produced `source`. Defence in depth is cheap, and this is the one place a
 * resume changes hands -- a bug here would hand one applicant another's work.
 *
 * The copy is deliberately a NEW DOCUMENT, not a snapshot: revision restarts at
 * 1, status returns to draft, and any strength score is dropped, because that
 * score was computed for a different row at a revision that means nothing here.
 * `importedFrom` IS carried over -- the text really did come from that import,
 * and losing the provenance would make the copy look hand-written.
 */
export function planDuplicate(input: {
  readonly source: ResumeV2
  readonly actingUserId: string
  readonly newId: string
  readonly sectionIds: readonly string[]
  readonly now: string
}): DuplicatePlan {
  if (input.source.userId !== input.actingUserId) return { ok: false, reason: 'not-owner' }
  if (input.sectionIds.length < input.source.sections.length) return { ok: false, reason: 'missing-ids' }

  const sections: ResumeSectionV2[] = input.source.sections.map(
    (section, i) => ({ ...section, id: input.sectionIds[i] }) as ResumeSectionV2
  )

  return {
    ok: true,
    resume: {
      ...input.source,
      id: input.newId,
      userId: input.actingUserId,
      title: duplicateTitle(input.source.title),
      status: 'draft',
      sections,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
      strength: null,
    },
  }
}
