/**
 * What the applicant is shown between analysis and creation, and what comes
 * back when they confirm.
 *
 * ANALYSE -> REVIEW -> EXPLICIT CREATE. Nothing is created until a person has
 * looked at what the import found and pressed a button. Cancelling costs them
 * nothing: no resume, no slot, no row beyond the 'attempted' one that makes the
 * document re-importable later.
 *
 * THE PAYLOAD IS SANITISED, NOT RAW. The model's own output never leaves the
 * server. What the client receives is `plan.organised` -- the version
 * `buildImportPlan` has already filtered, from which every value the verifier
 * could not trace to the applicant's document has been removed. A rejected
 * value is a fabrication about a real person; returning it "just for display"
 * would put it one render away from being read as fact.
 *
 * NOTHING IS PERSISTED TO SUPPORT THE REVIEW. The plan lives in the browser
 * between the two calls and comes back on confirmation, where it is traced
 * again. Verification is a pure function of (organised, source), so re-running
 * it reproduces the identical verdict -- which is why the round trip is safe
 * without a server-side draft, a cache, or a temporary row holding resume text.
 */

import type { ImportPlan, OrganisedResume } from './organise.ts'
import type { SourceDocument } from './source.ts'
import type { SourceFormat } from './upload.ts'

/** One thing the import found, and where it is going. */
export interface ReviewMapping {
  readonly path: string
  readonly value: string
  readonly sourceLine: number | null
}

export interface ReviewPayload {
  readonly importId: string
  /** Verified: traced verbatim to the document. These become the resume. */
  readonly mapped: readonly ReviewMapping[]
  /**
   * Source-backed but loosely traced. Shown so the applicant can place them;
   * NOT written into the resume by the import itself.
   */
  readonly uncertain: readonly ReviewMapping[]
  /**
   * Lines from the document nothing was placed from. Each becomes an item in
   * "Imported items to review" when the resume is created.
   */
  readonly unmapped: readonly string[]
  /**
   * How many values the verifier threw out. A COUNT AND NEVER THE VALUES: a
   * discarded value was not in their document, and showing it back is the one
   * place in this feature where a fabrication could reach a person.
   */
  readonly discarded: number
  /** The sanitised plan, returned so confirmation can re-verify it. */
  readonly organised: OrganisedResume
  readonly source: {
    readonly text: string
    readonly format: SourceFormat
    readonly fingerprint: string
  }
}

export function toReviewPayload(
  plan: ImportPlan,
  source: SourceDocument,
  importId: string
): ReviewPayload {
  return {
    importId,
    mapped: plan.mapped.map((m) => ({ path: m.path, value: m.value, sourceLine: m.sourceLine })),
    uncertain: plan.uncertain.map((m) => ({ path: m.path, value: m.value, sourceLine: m.sourceLine })),
    unmapped: [...plan.unmapped],
    discarded: plan.rejected.length,
    // The FILTERED plan, not the model's reply.
    organised: plan.organised,
    source: { text: source.text, format: source.format, fingerprint: source.fingerprint },
  }
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ConfirmRequest {
  readonly importId: string
  readonly sourceText: string
  readonly format: SourceFormat
  readonly organised: unknown
}

export type ParseConfirm =
  | { readonly ok: true; readonly value: ConfirmRequest }
  | { readonly ok: false; readonly error: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FORMATS: readonly SourceFormat[] = ['pdf', 'docx', 'paste']

/** Longest source text a confirmation may carry. Matches the paste ceiling. */
export const MAX_CONFIRM_TEXT = 200_000

/**
 * Shape only. Whether the contents are TRUE is decided by re-tracing them
 * against the source, which happens after this and cannot be skipped.
 */
export function parseConfirmRequest(body: unknown): ParseConfirm {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Expected an object.' }
  }
  const b = body as Record<string, unknown>

  if (typeof b.importId !== 'string' || !UUID.test(b.importId)) {
    return { ok: false, error: 'A valid importId is required.' }
  }
  if (typeof b.sourceText !== 'string' || b.sourceText.trim() === '') {
    return { ok: false, error: 'The source text is required.' }
  }
  if (b.sourceText.length > MAX_CONFIRM_TEXT) {
    return { ok: false, error: 'That source text is too long.' }
  }
  const format = FORMATS.find((f) => f === b.format)
  if (!format) return { ok: false, error: 'A valid format is required.' }
  if (typeof b.organised !== 'object' || b.organised === null || Array.isArray(b.organised)) {
    return { ok: false, error: 'The reviewed import is required.' }
  }

  return {
    ok: true,
    value: { importId: b.importId, sourceText: b.sourceText, format, organised: b.organised },
  }
}

/**
 * Whether a review payload would produce anything worth creating.
 *
 * An import that traced nothing is a failed import, not an empty resume: the
 * applicant should be told rather than handed a blank draft that consumed
 * their slot.
 */
export function hasSomethingToCreate(payload: Pick<ReviewPayload, 'mapped'>): boolean {
  return payload.mapped.length > 0
}
