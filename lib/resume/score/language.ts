/**
 * The words Resume Strength may not use.
 *
 * The locked decision is explicit: the score measures resume quality, and must
 * not predict admission, represent acceptance probability, or claim
 * competitiveness. V1's scorer asserted "required by most programs" beside a
 * red flag it had invented.
 *
 * This is a filter, not a prompt instruction, because a prompt instruction is
 * advice and a filter is a guarantee. Every line of feedback -- mine and the
 * model's -- passes through it before an applicant reads it.
 */

/**
 * Phrases that make a claim about admission rather than about the resume.
 *
 * Deliberately narrow. "Competitive" is here because it is the word that turns
 * a writing note into a prediction; "strong" and "clear" are not, because they
 * describe the writing, which is the entire point of the exercise.
 */
const ADMISSIONS_CLAIMS: readonly RegExp[] = [
  /\badmiss\w*/i,
  /\badmitted\b/i,
  /\bacceptance\b/i,
  /\baccepted into\b/i,
  /\bcompetitive\w*/i,
  /\bchances?\b/i,
  /\bodds\b/i,
  /\bget(ting)? in\b/i,
  /\bmost programs? (require|expect|want|look)/i,
  /\bprograms? (require|expect|demand)\b/i,
  /\brequired by\b/i,
  /\byour application will\b/i,
  /\blikely to be (accepted|rejected|selected)\b/i,
  /\b\d+\s*%\s*(chance|likelihood|of being)/i,
  /\brank(ed|ing)? (you|your) (against|versus)/i,
]

export function containsAdmissionsClaim(text: string): boolean {
  return ADMISSIONS_CLAIMS.some((pattern) => pattern.test(text))
}

/**
 * Keeps only the lines that talk about the resume.
 *
 * A dropped line is dropped silently from the applicant's view -- showing
 * "[removed]" would be worse than saying nothing -- and the caller logs how
 * many went, so a prompt that starts drifting is visible in the logs before it
 * is visible to a user.
 */
export function withoutAdmissionsClaims(lines: readonly string[]): string[] {
  return lines.filter((line) => !containsAdmissionsClaim(line))
}

/** The name of the thing. Never "score out of 100 competitiveness". */
export const STRENGTH_NAME = 'CRNA Resume Strength'

/** Shown under the number, so the number is never read as a prediction. */
export const STRENGTH_DISCLAIMER =
  'This measures how well your resume is written and filled in. It is not a prediction about admission.'
