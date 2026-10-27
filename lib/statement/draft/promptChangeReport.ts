import { checkTitle, isPromptId } from './validate.ts'
import { CREATE_MESSAGES } from './library.ts'

/**
 * "This prompt has changed" -- what an applicant sends when a prompt WE
 * publish no longer matches the one their school gave them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT THE PASTE FLOW WITH A FLAG
 * ---------------------------------------------------------------------------
 * newPastedDraftRequest() answers "here is a prompt you do not have". This
 * answers "the prompt you have is wrong", and the difference is the whole
 * value of the report: it names the catalog row it contradicts. Sending the
 * second through the first loses that id, and an administrator then sees an
 * apparent duplicate of their own row with no explanation attached.
 *
 * So it is a separate builder producing a separate body, for the same reason
 * newDraft.ts keeps three of them: a function that handles one cannot silently
 * accept the other.
 *
 * ---------------------------------------------------------------------------
 * TWO FIELDS THE FORM DOES NOT HAVE, AND CANNOT SEND
 * ---------------------------------------------------------------------------
 * A new prompt may be accompanied by a source URL and an application cycle; a
 * report is not. The applicant is looking at OUR row and telling us it is out
 * of date -- the school, the document and the cycle are already known from the
 * row they are reporting, and asking for them again invites a different answer
 * to a question we have already recorded.
 *
 * THIS IS ENFORCED BY SHAPE, NOT BY LEAVING THE INPUTS OUT OF THE FORM. The
 * returned body has no key for either, and a test asserts their absence, so
 * there is no field for a future screen to start populating.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE CHANGES THE CATALOG
 * ---------------------------------------------------------------------------
 * The report creates the applicant's own draft on their own wording, labelled
 * as theirs and unverified, and a pending submission. The row they reported
 * keeps saying exactly what it said until an administrator decides otherwise
 * -- see 20261008_012 and the admin queue's four choices.
 */

/** The wording an applicant reports, and their agreement to share it. */
export interface PromptChangeReport {
  /** The catalog row this report contradicts. */
  readonly requirementId: string
  /** The school's current wording, as they have it. */
  readonly promptText: string
  /** Their explicit agreement that this wording may be published. */
  readonly confirmed: boolean
}

export function emptyPromptChangeReport(requirementId: string): PromptChangeReport {
  return { requirementId, promptText: '', confirmed: false }
}

/**
 * Every word this screen can show.
 *
 * THE CONTROL SAYS WHAT IS WRONG, NOT WHAT TO DO. "Report: This Prompt Has
 * Changed" is the owner's wording and it is the honest one: the applicant is
 * not editing our row, submitting a correction for approval, or asking for
 * anything -- they are telling us a fact. What follows from it is ours.
 */
export const REPORT_MESSAGES = {
  /** The control on every catalog card. */
  action: 'Report: This Prompt Has Changed',
  heading: 'Report a changed prompt',
  /**
   * WHAT HAPPENS, IN THE ORDER IT HAPPENS TO THEM. The first clause is the one
   * they care about -- they can write now -- and the second is the one that
   * keeps the promise honest: our row does not move because they said so.
   */
  body:
    'Paste the prompt your school gave you. You can start writing against it straight '
    + 'away, and CRNAPREPHUB will review it before the shared directory changes.',
  /** The row being reported, shown so they are reporting what they think. */
  currentHeading: 'Our current prompt',
  pastedHeading: 'The prompt your school gave you',
  confirm: 'I understand my prompt may be added to the shared directory.',
  /** The same sentence the paste flow shows, because the same thing is true. */
  notice:
    'Your reported prompt will be reviewed by CRNAPREPHUB and may replace or join this '
    + 'school’s listed prompts. Your personal statement and essay will remain private.',
  incomplete: 'Paste the prompt wording and confirm before creating the draft.',
  submit: 'Submit and start writing',
  /** What the draft it creates is labelled, until somebody reviews it. */
  badge: 'User-provided prompt — Not yet verified by CRNAPREPHUB',
} as const

/** Whether the report may be sent: wording, and consent. Nothing else. */
export function reportIsComplete(report: PromptChangeReport | null | undefined): boolean {
  if (!report) return false
  if (!isPromptId(report.requirementId)) return false
  if (typeof report.promptText !== 'string') return false
  if (report.promptText.trim().length === 0) return false
  return report.confirmed === true
}

/**
 * The body that creates a draft from a reported prompt.
 *
 * `kind` AND `challengedRequirementId` TRAVEL TOGETHER, exactly as 012's CHECK
 * requires and checkPromptSubmission re-checks: a report with nothing to
 * compare against cannot be reviewed, and this builder has no way to produce
 * one -- the requirement id is read from the report and the kind is a literal.
 *
 * NO promptId, AS IN THE PASTE BUILDER. A reported prompt must not travel the
 * path that means "the catalog vouches for this": it travels the submission
 * path, lands in prompt_submission_id, and is labelled as the applicant's.
 */
export type PromptChangeRequest =
  | {
      readonly ok: true
      readonly body: {
        readonly title: string
        readonly essay: string
        readonly promptSubmission: {
          readonly schoolId: string
          readonly kind: 'prompt-change'
          readonly challengedRequirementId: string
          readonly promptText: string
          readonly confirmed: true
        }
      }
    }
  | { readonly ok: false; readonly message: string }

export function newPromptChangeRequest(
  rawTitle: unknown,
  schoolId: unknown,
  report: PromptChangeReport | null,
): PromptChangeRequest {
  const checked = checkTitle(rawTitle)
  if (!checked.ok) {
    return {
      ok: false,
      message: checked.code === 'title-too-long' ? CREATE_MESSAGES.tooLong : CREATE_MESSAGES.title,
    }
  }
  if (!isPromptId(schoolId)) return { ok: false, message: REPORT_MESSAGES.incomplete }
  if (!reportIsComplete(report) || report === null) {
    return { ok: false, message: REPORT_MESSAGES.incomplete }
  }
  return {
    ok: true,
    body: {
      title: checked.title,
      essay: '',
      promptSubmission: {
        schoolId,
        kind: 'prompt-change',
        challengedRequirementId: report.requirementId,
        promptText: report.promptText,
        confirmed: true,
      },
    },
  }
}

/** Whether Submit may fire. The sibling of canCreatePasteNow, same rules. */
export function canReportNow(input: {
  readonly title: string
  readonly schoolId: string | null
  readonly report: PromptChangeReport | null
  readonly submitting: boolean
  readonly retryable: boolean
}): boolean {
  if (input.submitting !== false) return false
  if (input.retryable !== true) return false
  if (!isPromptId(input.schoolId)) return false
  if (!reportIsComplete(input.report)) return false
  return checkTitle(input.title).ok
}
