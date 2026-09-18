/**
 * The finished resume, and who may take it away.
 *
 * THE GATE IS THE DOWNLOAD, NOT THE BUILDER. Free and Premium get the whole
 * Resume Builder -- every template, import, AI, Resume Strength, a clean
 * multi-page preview with no mark on it. Nothing here restricts building or
 * editing, ever.
 *
 * THE LOCK IS A CHOICE THE APPLICANT MADE. It is set in exactly one place: the
 * applicant pressed Download, was shown what Ultimate adds, and answered "Not
 * now". Opening the Studio does not set it. Editing does not. Opening the
 * download menu does not. Dismissing that modal with Escape, the close button
 * or a press outside does not -- those are "I did not answer", and an unanswered
 * question is not a decision.
 *
 * WHAT THE LOCK DOES. The finished document stops being readable: blurred,
 * unselectable, with an overlay saying how to unlock it. The editor keeps
 * working exactly as before, so the resume is never held hostage -- only its
 * finished form is.
 *
 * ULTIMATE IGNORES IT. A stored lock is history, not state: the moment the
 * account is Ultimate every question below answers no, whatever is stored.
 *
 * Pure.
 */

import { outputGated } from '../entitlement.ts'
import type { ResumeV2 } from '../model/types.ts'

/**
 * Whether a download attempt should open the upgrade modal instead of
 * producing a file. The export routes refuse this tier regardless -- this is
 * what makes the refusal legible rather than an error.
 */
export function downloadNeedsUpgrade(tier: string | null | undefined): boolean {
  return outputGated(tier)
}

/**
 * Whether the composed preview should resist being copied out.
 *
 * True for every tier that cannot download, before and after any lock: the
 * preview is a complete resume, and select-all-copy is the same bypass as the
 * download. Editor fields are untouched -- what someone typed is theirs to
 * copy, and this is only about the composed document.
 */
export function protectComposedOutput(tier: string | null | undefined): boolean {
  return outputGated(tier)
}

/** Whether this resume's finished form is locked for this account, right now. */
export function isOutputLocked(
  resume: Pick<ResumeV2, 'outputLockedAt'>,
  tier: string | null | undefined
): boolean {
  return outputGated(tier) && Boolean(resume.outputLockedAt)
}

/** What the overlay says, in one place so the Studio and the dashboard agree. */
export const OUTPUT_LOCK_COPY = {
  title: 'Your resume is ready to download',
  body: 'Upgrade to Ultimate to unlock your finished resume.',
  action: 'Upgrade to Ultimate',
} as const
