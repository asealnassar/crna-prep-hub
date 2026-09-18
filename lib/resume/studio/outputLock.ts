/**
 * The finished resume, and who may take it away.
 *
 * THE GATE IS THE DOWNLOAD, NOT THE BUILDER. Free and Premium get the whole
 * Resume Builder -- every template, import, AI, Resume Strength, a clean
 * multi-page preview with no mark on it. Nothing here restricts building or
 * editing, ever.
 *
 * THE LOCK IS A CHOICE THE APPLICANT MADE. It is set when the applicant pressed
 * Download, was shown what Ultimate adds, and ANSWERED -- either way. "Not now"
 * and "Upgrade to Ultimate" both lock the finished output, because what makes
 * it a decision is having been shown the price and responded, not which way
 * they went. Opening the Studio does not set it. Editing does not. Opening the
 * download menu does not. Dismissing that modal with Escape, the close button
 * or a press outside does not -- those are "I did not answer", and an unanswered
 * question is not a decision.
 *
 * WHY UPGRADE HAS TO LOCK TOO. It leaves the page for /pricing. Until it did
 * this, an applicant could press Upgrade, decide against paying, come back, and
 * find the finished resume still fully readable -- the same bypass "Not now"
 * closes, reachable by answering the other way. See upgradeAfterLock below for
 * the ordering that makes it stick.
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

/**
 * Answering the modal with "Upgrade to Ultimate": lock first, leave second.
 *
 * THE ORDER IS THE WHOLE POINT, which is why it lives here as a pure function
 * rather than inline in a click handler where it cannot be tested. Autosave is
 * fire-and-forget -- an edit is applied locally and the save catches up -- and
 * that is right for editing and wrong for exactly one caller: the one that
 * navigates away. `lock` resolves only once the answer has reached the server,
 * and nothing navigates until it has.
 *
 * A LOCK THAT DID NOT SAVE DOES NOT NAVIGATE. If it could not be persisted the
 * applicant stays here and is told, rather than leaving for /pricing and coming
 * back to a resume that reads clean. They can retry, or reach pricing by any of
 * the other routes to it -- but this control will not be the thing that quietly
 * loses their answer.
 */
export async function upgradeAfterLock(deps: {
  /** Resolves true once the output lock is stored. */
  readonly lock: () => Promise<boolean>
  readonly navigate: () => void
}): Promise<'navigated' | 'not-saved'> {
  const saved = await deps.lock()
  if (!saved) return 'not-saved'
  deps.navigate()
  return 'navigated'
}

/** What the overlay says, in one place so the Studio and the dashboard agree. */
export const OUTPUT_LOCK_COPY = {
  title: 'Your resume is ready to download',
  body: 'Upgrade to Ultimate to unlock your finished resume.',
  action: 'Upgrade to Ultimate',
} as const
