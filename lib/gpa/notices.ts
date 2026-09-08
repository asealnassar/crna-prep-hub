/**
 * D54 - transient notices belong to one analysis.
 *
 * "Created 'Harbor Medical University' with 7 course(s)" is a true statement
 * about one import, and a false one everywhere else. Held in plain component
 * state it outlived its analysis: importing Harbor, then combining two other
 * transcripts, left Harbor's success notice sitting above the new combined
 * analysis, quoting a school and a course count that had nothing to do with
 * what the user was looking at.
 *
 * So a notice carries the analysis it is about. Two rules follow from that, and
 * both are needed:
 *
 *   - it is only ever RENDERED on that analysis, so a notice written while a
 *     different analysis was open cannot flash into view; and
 *   - it is DROPPED when the user moves elsewhere, so switching back later
 *     does not resurrect something the user already read and left behind.
 *
 * Scoping alone would leave a notice lurking; clearing alone would race with
 * the notice a new combined analysis legitimately posts about itself, because
 * that one is written moments after the switch it belongs to.
 */

export interface ScopedNotice<T> {
  /** The analysis this notice is about. */
  analysisId: string
  value: T
}

/** Attaches a notice to the analysis it describes. */
export function scopedTo<T>(analysisId: string | null | undefined, value: T): ScopedNotice<T> | null {
  const id = String(analysisId ?? '').trim()
  return id ? { analysisId: id, value } : null
}

/** What to show right now: the notice's content, or nothing. */
export function noticeFor<T>(
  notice: ScopedNotice<T> | null | undefined, currentId: string | null | undefined,
): T | null {
  if (!notice) return null
  return notice.analysisId === String(currentId ?? '') ? notice.value : null
}

/** True when this notice is about the analysis on screen. */
export function belongsTo(
  notice: ScopedNotice<unknown> | null | undefined, currentId: string | null | undefined,
): boolean {
  return !!notice && notice.analysisId === String(currentId ?? '')
}

/**
 * Keeps a notice only while its analysis is the one open.
 *
 * Used when the active analysis changes: a notice for somewhere else is not
 * hidden, it is gone. Returning the SAME object when it still belongs avoids
 * a pointless state write on every switch.
 */
export function dropIfForeign<T>(
  notice: ScopedNotice<T> | null, currentId: string | null | undefined,
): ScopedNotice<T> | null {
  if (!notice) return null
  return notice.analysisId === String(currentId ?? '') ? notice : null
}
