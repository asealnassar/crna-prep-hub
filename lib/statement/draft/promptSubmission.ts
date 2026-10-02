import { isPromptId } from './validate.ts'

/**
 * What an applicant may submit when their school's question is not in the
 * catalog yet, with no React and no database in it.
 *
 * SAME ARRANGEMENT AS validate.ts, and the value rules are deliberately the
 * CATALOG'S rules: a submission that could never be approved should be refused
 * when it is typed, not discovered at review. The ceilings here and the CHECK
 * constraints on public.statement_prompts are asserted equal by a test, so the
 * two cannot drift.
 *
 * EVERYTHING HERE IS UNTRUSTED. The wording is somebody's paste from a school
 * website; the source is a link they typed. Nothing in this module renders,
 * fetches, executes or interprets any of it -- it decides only whether a value
 * may be STORED, and storage is the last point at which a limit can be applied
 * cheaply.
 *
 * NOTHING IS INVENTED. A missing word limit stays missing: every optional field
 * normalises a blank to null rather than to a number, because "the school did
 * not say" and "the school said zero" are different facts and only one of them
 * is true.
 */

/** The catalog's own ceiling, in CODE POINTS, matching statement_prompts. */
export const MAX_SUBMITTED_PROMPT_CHARS = 5000

/** The catalog's own word-limit range. */
export const MIN_STATED_MAX_WORDS = 1
export const MAX_STATED_MAX_WORDS = 5000

/**
 * A source link's ceiling. Shorter than the prompt, because a URL this long is
 * not a URL anybody typed -- it is a payload wearing one.
 */
export const MAX_SOURCE_URL_CHARS = 2000

/** 'YYYY' or 'YYYY-YYYY', the same pattern statement_prompts_cycle_format uses. */
const CYCLE = /^[0-9]{4}(-[0-9]{4})?$/

/**
 * Where a draft's question came from.
 *
 * 'catalog'  an approved row in statement_prompts.
 * 'user'     somebody's paste, pending or otherwise.
 *
 * NOT STORED AS A COLUMN. The draft carries prompt_id for a catalog prompt and
 * prompt_submission_id for a pasted one, and a CHECK makes them mutually
 * exclusive -- so the origin is already a fact about which column is populated
 * and a stored copy could only ever disagree with it. originOf() derives it.
 *
 * AND DERIVING IT IS STILL NOT A TRUST DECISION. Both columns live on a row the
 * applicant's own role may UPDATE, so either is a claim. Whether a prompt is
 * really the catalog's is settled by resolving prompt_id against
 * statement_prompts and comparing the wording -- a table no browser role may
 * write at all. See provenanceOf() at the end of this file.
 */
export type PromptOrigin = 'catalog' | 'user'

/**
 * Which of the two prompt columns a draft carries, and therefore where its
 * question came from. Derived, never stored.
 *
 * BOTH SET IS NOT A STATE. statement_drafts_prompt_source_exclusive refuses it
 * at the database, so this returns null for a row that should not exist rather
 * than guessing which claim to believe.
 */
export function originOf(input: {
  readonly promptId: string | null
  readonly promptSubmissionId: string | null
}): PromptOrigin | null {
  const hasCatalog = typeof input.promptId === 'string'
  const hasSubmission = typeof input.promptSubmissionId === 'string'
  if (hasCatalog && hasSubmission) return null
  if (hasCatalog) return 'catalog'
  if (hasSubmission) return 'user'
  return null
}

/** Every state a submission can be in. The database CHECK lists exactly these. */
export const SUBMISSION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'duplicate',
  'withdrawn',
] as const

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number]

export function isSubmissionStatus(value: unknown): value is SubmissionStatus {
  return typeof value === 'string' && (SUBMISSION_STATUSES as readonly string[]).includes(value)
}

/** A status no longer awaiting a decision. Re-deciding one is not an action. */
export function isFinalStatus(status: SubmissionStatus): boolean {
  return status !== 'pending'
}

export type SubmissionRefusal =
  | 'invalid-prompt-text'
  | 'prompt-text-too-long'
  | 'invalid-max-words'
  | 'invalid-cycle'
  | 'invalid-source'
  | 'invalid-school'
  | 'not-confirmed'

/**
 * The wording, exactly as pasted.
 *
 * NOT TRIMMED INTO STORAGE. A school's own indentation and blank lines are part
 * of a multi-paragraph question, so the stored value is what was supplied; only
 * the emptiness test looks at the trimmed form, and only the ceiling looks at
 * the raw one. That is the same pair of clauses statement_prompts_text_length
 * applies, for the same reasons.
 *
 * MEASURED IN CODE POINTS, matching Postgres char_length(). JavaScript's
 * .length counts UTF-16 code units, so a ceiling measured with it would accept
 * wording the database then refuses.
 */
export function checkSubmittedPromptText(
  value: unknown,
): { ok: true; text: string } | { ok: false; code: SubmissionRefusal } {
  if (typeof value !== 'string') return { ok: false, code: 'invalid-prompt-text' }
  if (value.trim().length === 0) return { ok: false, code: 'invalid-prompt-text' }
  if ([...value].length > MAX_SUBMITTED_PROMPT_CHARS) {
    return { ok: false, code: 'prompt-text-too-long' }
  }
  return { ok: true, text: value }
}

/**
 * The school's stated maximum, or the fact that it stated none.
 *
 * A BLANK FIELD IS NULL, NOT ZERO, and this is the specific trap: an empty HTML
 * number input yields '', and Number('') is 0. Coercing that would record "this
 * school allows zero words" -- a claim nobody made -- and the database would
 * then refuse the row for a reason the applicant could not act on.
 *
 * A REAL ZERO IS REFUSED rather than normalised away: somebody who typed 0
 * meant something, and silently turning it into "no limit" would be inventing
 * the opposite of what they said.
 */
export function checkStatedMaxWords(
  value: unknown,
): { ok: true; words: number | null } | { ok: false; code: SubmissionRefusal } {
  if (value === undefined || value === null) return { ok: true, words: null }
  if (typeof value === 'string') {
    if (value.trim().length === 0) return { ok: true, words: null }
    return { ok: false, code: 'invalid-max-words' }
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, code: 'invalid-max-words' }
  }
  if (value < MIN_STATED_MAX_WORDS || value > MAX_STATED_MAX_WORDS) {
    return { ok: false, code: 'invalid-max-words' }
  }
  return { ok: true, words: value }
}

/** 'YYYY' or 'YYYY-YYYY', or the fact that the prompt is not cycle-specific. */
export function checkApplicationCycle(
  value: unknown,
): { ok: true; cycle: string | null } | { ok: false; code: SubmissionRefusal } {
  if (value === undefined || value === null) return { ok: true, cycle: null }
  if (typeof value !== 'string') return { ok: false, code: 'invalid-cycle' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true, cycle: null }
  if (!CYCLE.test(trimmed)) return { ok: false, code: 'invalid-cycle' }
  return { ok: true, cycle: trimmed }
}

/**
 * Where they found it, or nothing.
 *
 * http AND https ONLY, and the scheme is read from a parsed URL rather than
 * matched with a regex, so `javascript:`, `data:`, `vbscript:` and every other
 * scheme are refused by not being on the list rather than by being guessed at.
 * A link that reaches an administrator's screen is a link somebody may click.
 *
 * NOTHING IS FETCHED, here or anywhere. A server that retrieved a submitted URL
 * would be a request-forgery primitive pointed at whatever the submitter chose,
 * including addresses only this server can reach.
 */
export function checkSourceUrl(
  value: unknown,
): { ok: true; url: string | null } | { ok: false; code: SubmissionRefusal } {
  if (value === undefined || value === null) return { ok: true, url: null }
  if (typeof value !== 'string') return { ok: false, code: 'invalid-source' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true, url: null }
  if (trimmed.length > MAX_SOURCE_URL_CHARS) return { ok: false, code: 'invalid-source' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, code: 'invalid-source' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'invalid-source' }
  }
  return { ok: true, url: parsed.toString() }
}

/**
 * The wording reduced to what two submissions have to share to be "the same
 * question": case folded, every whitespace run collapsed, ends trimmed.
 *
 * FOR GROUPING, NOT FOR INTEGRITY. Two applicants pasting the same question
 * from the same page differ in line breaks and trailing spaces, and an
 * administrator should see those as one question. Nothing is published,
 * rejected or merged because two fingerprints match -- a match is a hint on a
 * review screen, and a human decides.
 *
 * THE DATABASE COMPUTES THE STORED ONE, as a generated column over this exact
 * normalisation, so a caller cannot supply a fingerprint that disagrees with
 * their own text. This function exists so the same grouping can be reasoned
 * about and tested without a database.
 */
export function normalizedPromptText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** A complete, storable submission. */
export interface PromptSubmissionInput {
  readonly schoolId: string
  readonly promptText: string
  readonly statedMaxWords: number | null
  readonly applicationCycle: string | null
  readonly sourceUrl: string | null
}

export type PromptSubmissionCheck =
  | { readonly ok: true; readonly input: PromptSubmissionInput }
  | { readonly ok: false; readonly code: SubmissionRefusal }

/**
 * A whole submission, or the FIRST thing wrong with it.
 *
 * THE SCHOOL IS CHECKED FOR SHAPE ONLY HERE. Whether that uuid is a school this
 * product lists is a question only the directory can answer, and the route asks
 * it against the same options the picker offered -- see submissionRepo. A uuid
 * check first means a malformed id never reaches a query, exactly as isDraftId
 * and isPromptId do.
 *
 * CONFIRMATION IS PART OF VALIDATION, not of the user interface. The applicant
 * is told their wording may be published and must agree; a request without that
 * agreement is refused here, where it cannot be skipped by a caller that did
 * not render the checkbox.
 */
export function checkPromptSubmission(input: {
  readonly schoolId?: unknown
  readonly promptText?: unknown
  readonly statedMaxWords?: unknown
  readonly applicationCycle?: unknown
  readonly sourceUrl?: unknown
  readonly confirmed?: unknown
}): PromptSubmissionCheck {
  if (!isPromptId(input.schoolId)) return { ok: false, code: 'invalid-school' }

  const text = checkSubmittedPromptText(input.promptText)
  if (!text.ok) return { ok: false, code: text.code }

  const words = checkStatedMaxWords(input.statedMaxWords)
  if (!words.ok) return { ok: false, code: words.code }

  const cycle = checkApplicationCycle(input.applicationCycle)
  if (!cycle.ok) return { ok: false, code: cycle.code }

  const source = checkSourceUrl(input.sourceUrl)
  if (!source.ok) return { ok: false, code: source.code }

  // An exact boolean. A missing, truthy-but-not-true or string value is not
  // consent, and consent is the one field a caller must not be able to imply.
  if (input.confirmed !== true) return { ok: false, code: 'not-confirmed' }

  return {
    ok: true,
    input: {
      schoolId: input.schoolId,
      promptText: text.text,
      statedMaxWords: words.words,
      applicationCycle: cycle.cycle,
      sourceUrl: source.url,
    },
  }
}

/**
 * What a draft's stored prompt metadata actually proves.
 *
 * THE STORED ORIGIN IS NOT CONSULTED. statement_drafts is a table the
 * applicant's own role may UPDATE, so every column on it -- prompt_origin
 * included -- is a claim rather than a finding. What cannot be forged is the
 * CATALOG: no browser role holds insert or update on statement_prompts, and
 * approval happens inside a definer function restricted to service_role. So a
 * prompt is the catalog's when, and only when, the catalog says the same thing.
 *
 * 'catalog'   prompt_id resolved AND the stored wording still matches it.
 * 'user'      anything else that has wording: a pasted prompt, or a prompt_id
 *             that no longer resolves, or one whose wording has since diverged.
 * null        the draft answers no question at all.
 *
 * WHY A DIVERGED CATALOG PROMPT IS 'user' RATHER THAN AN ERROR. A draft keeps
 * its snapshot for ever, and the catalog may legitimately deactivate a row or
 * publish a new cycle. The snapshot is still the question that essay answers --
 * it is simply no longer one this product vouches for TODAY, which is exactly
 * what 'user' means to the analyser safeguards.
 */
export function provenanceOf(input: {
  readonly promptText: string | null
  readonly catalogText: string | null
}): PromptOrigin | null {
  if (input.promptText === null) return null
  if (input.catalogText === null) return 'user'
  return input.catalogText === input.promptText ? 'catalog' : 'user'
}

/**
 * What an applicant is told about the question their draft answers.
 *
 * FOUR STATES, AND THE WORDING NEVER CLAIMS MORE THAN IS TRUE. A pasted prompt
 * is "not yet verified" while it is pending and stays "user-provided" after it
 * is approved, because approval publishes a catalog row -- it does not
 * retroactively make THIS draft's snapshot a catalog prompt, and saying it did
 * would be the silent substitution this feature exists to avoid.
 *
 * A REJECTED OR WITHDRAWN SUBMISSION CHANGES NOTHING ABOUT THE DRAFT, and the
 * wording says so in the same breath as the outcome. The applicant's own
 * writing was never what was under review.
 *
 * NULL MEANS SHOW NOTHING. A general draft answers no question and needs no
 * badge; a catalog prompt is shown with its own wording and does not need to be
 * announced as trustworthy.
 */
export const PROMPT_STATUS_LABELS = {
  pending: 'User-provided prompt — Not yet verified by CRNAPREPHUB',
  approved: 'User-provided prompt — now in the shared directory. Your wording is unchanged.',
  rejected: 'User-provided prompt — not added to the shared directory. Your draft is unaffected.',
  duplicate: 'User-provided prompt — already in the shared directory. Your draft is unaffected.',
  withdrawn: 'User-provided prompt — you withdrew it from the directory. Your draft is unaffected.',
  unverified: 'User-provided prompt — Not yet verified by CRNAPREPHUB',
} as const

export function promptStatusLabel(input: {
  readonly origin: PromptOrigin | null
  readonly status: SubmissionStatus | null
}): string | null {
  // A catalog prompt carries its own authority; a draft with no question needs
  // no label at all.
  if (input.origin !== 'user') return null
  // A user-provided prompt whose submission cannot be read is still
  // user-provided. Falling back to silence would be the one wrong answer.
  if (input.status === null) return PROMPT_STATUS_LABELS.unverified
  return PROMPT_STATUS_LABELS[input.status]
}

/** Whether the applicant may still withdraw this submission from review. */
export function mayWithdraw(status: SubmissionStatus | null): boolean {
  return status === 'pending'
}
