/**
 * When a dashboard card fetches the resume behind its thumbnail.
 *
 * The list response carries no section content -- deliberately, so a dashboard
 * never ships an applicant's employment history to render a row. A real
 * miniature needs that content, so each card fetches its own, and the rules for
 * when it may are here rather than inside an effect:
 *
 *   NOT UNTIL IT IS SEEN. A card below the fold fetches nothing. Twenty
 *   resumes must not be twenty reads on load.
 *
 *   ONCE PER REVISION. The summary already carries the revision the server
 *   holds, so an edited resume refetches on the next dashboard visit and an
 *   untouched one never refetches.
 *
 *   A FAILURE IS NOT RETRIED on its own. The card falls back to the schematic
 *   and waits for a revision to change, rather than hammering a route that just
 *   refused it.
 *
 * Pure.
 */

import type { ResumeV2 } from '../model/types.ts'

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface PreviewState {
  readonly status: PreviewStatus
  /** The document to draw, kept while a newer revision loads so it cannot flicker. */
  readonly resume: ResumeV2 | null
  /** The revision `resume` was read at, or the one that failed. */
  readonly revision: number | null
}

export const NO_PREVIEW: PreviewState = { status: 'idle', resume: null, revision: null }

/** Whether this card should start a read now. */
export function shouldLoadPreview(
  state: PreviewState,
  input: { readonly visible: boolean; readonly revision: number }
): boolean {
  if (!input.visible) return false
  if (state.status === 'loading') return false
  if (state.status === 'idle') return true
  // Ready or failed: only a change on the server is worth another read.
  return state.revision !== input.revision
}

export function previewLoading(state: PreviewState): PreviewState {
  return { ...state, status: 'loading' }
}

export function previewLoaded(resume: ResumeV2, revision: number): PreviewState {
  return { status: 'ready', resume, revision }
}

/**
 * A read that failed. Anything already drawn stays drawn: a resume that loaded
 * a moment ago is still what this card looks like.
 */
export function previewFailed(state: PreviewState, revision: number): PreviewState {
  return { status: 'failed', resume: state.resume, revision }
}

/**
 * A read that was cancelled -- the card unmounted, or its revision moved on.
 *
 * Back to idle, keeping whatever was already drawn. A cancelled read that left
 * the state on 'loading' would be a card that never asks again, which is
 * exactly how the thumbnails came to be permanently schematic.
 */
export function previewAborted(state: PreviewState): PreviewState {
  if (state.status !== 'loading') return state
  return { status: state.resume ? 'ready' : 'idle', resume: state.resume, revision: state.resume ? state.revision : null }
}

/** The document a card should draw, or null for the schematic. */
export function previewDocument(state: PreviewState): ResumeV2 | null {
  return state.resume
}
