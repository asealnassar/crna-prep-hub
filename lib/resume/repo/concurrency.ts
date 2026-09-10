/**
 * Write admission. Pure.
 *
 * Every V2 save names the revision it read. If the stored revision has moved,
 * someone else -- another tab, another device -- saved in between, and this
 * write would silently discard their work. The decision is separated from the
 * database call so it can be tested exhaustively without one.
 *
 * The pattern is lifted from gpa_drafts, whose own comment states the case:
 * "a stale tab cannot silently overwrite a newer save from another device".
 * V1's edit page has no equivalent -- it issues one UPDATE per section and
 * reports success whether or not any of them landed.
 *
 * Ownership is checked HERE as well as by RLS. RLS is the control that
 * actually stops a cross-user write; this check exists so the caller gets a
 * specific answer instead of an empty result set it has to interpret.
 */

import { V2_SCHEMA_VERSION } from './rows.ts'

export interface StoredResumeState {
  readonly userId: string
  readonly revision: number
  readonly schemaVersion: number
}

export type WriteDecision =
  | { readonly ok: true; readonly nextRevision: number }
  | { readonly ok: false; readonly reason: WriteRefusal; readonly detail: string }

export type WriteRefusal =
  | 'not-found'
  | 'not-owner'
  | 'wrong-schema-version'
  | 'stale-revision'


/**
 * Whether a save may proceed, and what revision it should write.
 *
 * `stored` is null when the row does not exist -- which for an update is a
 * refusal, never an insert. A save that silently creates a row it was meant to
 * replace is how duplicates appear.
 */
export function decideWrite(input: {
  stored: StoredResumeState | null
  actingUserId: string
  expectedRevision: number
}): WriteDecision {
  const { stored, actingUserId, expectedRevision } = input

  if (!stored) {
    return { ok: false, reason: 'not-found', detail: 'no such resume' }
  }
  if (stored.userId !== actingUserId) {
    // Deliberately the same shape as not-found to the caller's user-facing
    // copy: distinguishing them would confirm which resume ids exist.
    return { ok: false, reason: 'not-owner', detail: 'owned by another user' }
  }
  if (stored.schemaVersion !== V2_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'wrong-schema-version',
      detail: `schema_version=${stored.schemaVersion}`,
    }
  }
  if (stored.revision !== expectedRevision) {
    return {
      ok: false,
      reason: 'stale-revision',
      detail: `expected ${expectedRevision}, stored ${stored.revision}`,
    }
  }
  return { ok: true, nextRevision: stored.revision + 1 }
}

/**
 * What the applicant should be told. Never leaks whether an id exists, and
 * never blames them for a conflict they did not cause.
 */
export function refusalMessage(reason: WriteRefusal): string {
  switch (reason) {
    case 'stale-revision':
      return 'This resume was changed somewhere else. Reload to see the newer version before saving again.'
    case 'not-found':
    case 'not-owner':
      return 'That resume is no longer available.'
    case 'wrong-schema-version':
      return 'This resume was built in the previous version and cannot be edited here yet.'
    default: {
      const never: never = reason
      throw new Error(`Unhandled refusal: ${String(never)}`)
    }
  }
}

/** A refusal the caller should retry after reloading, versus one it should not. */
export function isRecoverable(reason: WriteRefusal): boolean {
  return reason === 'stale-revision'
}
