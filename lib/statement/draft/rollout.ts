/**
 * Whether applicant-submitted prompts are switched on.
 *
 * WHY THIS EXISTS AT ALL. The feature's four migrations are written but not
 * applied, and the localhost this is developed against talks to the production
 * database. Every code path that names statement_prompt_submissions, or the
 * statement_drafts.prompt_submission_id column, or any of the three functions,
 * fails against a database that has not run them -- PostgREST answers an
 * unknown column or an unknown function with an error, not with a null.
 *
 * So the feature ships DARK. With the variable unset -- which is every
 * environment today, including the owner's localhost -- this returns false and
 * not one new query is issued: general drafts, approved-prompt drafts, the
 * library, the editor and the existing POST all take byte-for-byte the paths
 * they take now. Turning it on is a deliberate act AFTER the migrations run.
 *
 * DELIBERATELY NOT A BUILD-TIME CONSTANT. It is read per call from the live
 * environment, exactly as statementStudioMode() is, so flipping it needs a
 * restart rather than a rebuild and the two gates behave the same way.
 *
 * FAILING CLOSED IS THE WHOLE POINT. Anything other than the exact string 'on'
 * is off, including 'true', '1', 'ON' and a trailing space. A rollout flag that
 * guesses is a rollout flag that turns itself on.
 */
export const PROMPT_SUBMISSIONS_ENV = 'STATEMENT_PROMPT_SUBMISSIONS'

export function promptSubmissionsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[PROMPT_SUBMISSIONS_ENV] === 'on'
}
