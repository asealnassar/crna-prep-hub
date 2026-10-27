/**
 * A development-only VISUAL preview of the paste-a-prompt screens.
 *
 * WHY THIS EXISTS. The applicant-submission feature is built but switched off:
 * its tables are not migrated and STATEMENT_PROMPT_SUBMISSIONS is unset, so the
 * paste option is not offered and could not work if it were. The screens still
 * need looking at before any of that is turned on, and the honest way to do
 * that is to render them without wiring anything behind them.
 *
 * THIS IS NOT THE ROLLOUT FLAG, AND CANNOT BECOME IT. rollout.ts decides
 * whether the BACKEND exists; this decides whether some MARKUP is drawn. The
 * two are read separately, by separate functions, and the submission path
 * consults only the first -- see pasteSubmissionAllowed() below, which is
 * deliberately written so that no amount of preview can make it true.
 *
 * THREE CONDITIONS, AND THE BROWSER CONTROLS ONLY ONE:
 *
 *   1. NODE_ENV === 'development'. Read on the server from the process, so a
 *      deployed build cannot enter preview however it is addressed. This is the
 *      condition that makes the other two safe to be lenient about.
 *   2. The Statement Studio admin gate, which the page has already applied --
 *      a non-admin never reaches the code that calls this.
 *   3. An explicit query parameter. The only browser-controlled input, and the
 *      only one that is NOT sufficient on its own.
 *
 * A query parameter alone authorises nothing. That is the point of taking the
 * other two as arguments rather than reading them here: a caller cannot invoke
 * this function without stating, in the call, what the server established.
 */

/** The parameter, named once. */
export const PASTE_PREVIEW_PARAM = 'preview'

/** The one value that means "draw the paste screens". */
export const PASTE_PREVIEW_VALUE = 'prompt-paste'

/**
 * The value that means "draw the analyser's results screens with sample data".
 *
 * A SECOND VALUE, NOT A SECOND GATE. pastePreviewAllowed() below decides both,
 * because the three conditions are the same ones: development, an administrator
 * who has passed the Studio gate, and an explicit parameter. What differs is
 * only which screens get drawn.
 */
export const REVIEW_PREVIEW_VALUE = 'analysis'

/** Whether the address asked for the analyser preview. Exact value, one of it. */
export function reviewPreviewRequested(value: unknown): boolean {
  return value === REVIEW_PREVIEW_VALUE
}

/**
 * The value that means "draw the school writing-requirement checklists with
 * the research fixtures".
 *
 * A THIRD VALUE, STILL NOT A THIRD GATE. pastePreviewAllowed() decides this one
 * too: development, an administrator who has passed the Studio gate, and an
 * explicit parameter. What differs is only which screens get drawn.
 */
export const REQUIREMENTS_PREVIEW_VALUE = 'requirements'

/**
 * The value that means "draw the eight hand-built SHAPE fixtures".
 *
 * SPLIT FROM 'requirements' WHEN THE REAL CATALOG ARRIVED. `?preview=requirements`
 * now shows the 63 imported sets, which is what somebody reviewing the catalog
 * before release is actually asking for. The fixtures answer a different
 * question -- does the interface handle every requirement SHAPE -- and keep
 * their own address rather than being deleted for having been superseded.
 */
export const FIXTURES_PREVIEW_VALUE = 'fixtures'

/** Whether the address asked for the shape fixtures. Exact value, one of it. */
export function fixturesPreviewRequested(value: unknown): boolean {
  return value === FIXTURES_PREVIEW_VALUE
}

/** Whether the address asked for the requirement preview. Exact value, one of it. */
export function requirementsPreviewRequested(value: unknown): boolean {
  return value === REQUIREMENTS_PREVIEW_VALUE
}

/**
 * Whether the address asked for preview.
 *
 * EXACTLY ONE VALUE, EXACTLY ONE OCCURRENCE. Next hands a repeated parameter
 * over as an array, and an array is not a request: `?preview=a&preview=b` is
 * ambiguous, and an ambiguous authorisation request is refused rather than
 * resolved. Nothing is trimmed and nothing is lower-cased, because a parameter
 * that has to be guessed at is a parameter somebody mistyped.
 */
export function pastePreviewRequested(value: unknown): boolean {
  return value === PASTE_PREVIEW_VALUE
}

/**
 * Whether the paste screens may be DRAWN.
 *
 * All three conditions, and `development` is checked first because it is the
 * one that cannot be influenced from outside the process.
 */
export function pastePreviewAllowed(input: {
  readonly nodeEnv: string | undefined
  readonly isAdmin: boolean
  readonly requested: boolean
}): boolean {
  if (input.nodeEnv !== 'development') return false
  if (input.isAdmin !== true) return false
  return input.requested === true
}

/**
 * Whether the paste OPTION appears at all.
 *
 * Either the feature is really on, or somebody is looking at it in development.
 */
export function pasteOptionVisible(input: {
  readonly submissionsEnabled: boolean
  readonly pastePreview: boolean
}): boolean {
  return input.submissionsEnabled === true || input.pastePreview === true
}

/**
 * Whether a pasted prompt may actually be SENT.
 *
 * THE ROLLOUT FLAG AND NOTHING ELSE. This function does not take the preview
 * state as an argument -- not because it would ignore it, but so that there is
 * no parameter through which preview could ever influence the answer. A caller
 * cannot pass one. That is the guarantee, expressed as a signature.
 *
 * So the worst case of every preview bug is a screen somebody can look at.
 */
export function pasteSubmissionAllowed(input: {
  readonly submissionsEnabled: boolean
}): boolean {
  return input.submissionsEnabled === true
}
