/**
 * Who may open Personal Statement Studio.
 *
 * WHY THIS IS NOT THE RESUME GATE. lib/resume/gate.ts decides the same shape of
 * question and this file follows its architecture deliberately, but it reads
 * RESUME_BUILDER_MODE -- the flag that exists to carry Resume Builder from V1 to
 * V2. Borrowing it would mean the day resumes are cut over, Personal Statement
 * Studio silently launches too: one product decision releasing a second,
 * unrelated, unreviewed product. Two features that are gated for the same reason
 * are not two features on the same switch. So Statement Studio gets its own
 * flag, its own default, and its own decision function.
 *
 * ONE FILE, TWO PROPERTIES KEPT. The resume version splits the flag reader from
 * the decision so that the decision touches neither process.env nor lib/apiAuth
 * (which imports next/headers and cannot be resolved by `node --test`). Both
 * properties hold here without a second file, because statementStudioAccess()
 * takes the mode as an argument and the identity as booleans. It is pure, and it
 * is unit-testable under bare Node. Splitting six exports across two modules
 * would be ceremony, not safety.
 *
 * NOT A FEATURE-FLAG FRAMEWORK. One environment variable, read in one place,
 * with two values. Anything more general can be built the day a second flag
 * actually exists.
 */

/**
 * 'internal' is the development state: signed-in admins only. 'general' is the
 * released state: every signed-in user.
 *
 * There is no 'beta' value. A cohort rollout needs an allowlist to point at, and
 * there is no allowlist; adding the name now would be an empty promise that the
 * gate could not keep.
 */
export type StatementStudioMode = 'internal' | 'general'

export const STATEMENT_STUDIO_MODE_ENV = 'STATEMENT_STUDIO_MODE'

/**
 * Unset means hidden. The Studio is unreleased, so the absence of a decision has
 * to read as "not yet" -- a missing variable, a typo, a new environment nobody
 * configured, and a deploy that forgot the flag all resolve the safe way.
 */
export const DEFAULT_MODE: StatementStudioMode = 'internal'

/**
 * Exact match after trimming and lowercasing, and nothing else opens the gate.
 * 'generally', 'general,beta', '1', 'true' and '' are all 'internal'. Failure is
 * safe by construction rather than by care.
 */
export function parseStatementStudioMode(
  raw: string | null | undefined
): StatementStudioMode {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'general'
    ? 'general'
    : DEFAULT_MODE
}

/**
 * THE single read of the flag. Server-side only, and there is no NEXT_PUBLIC_
 * mirror: a value the browser can read is a value the browser can be told, and
 * the gate that matters runs on the server.
 */
export function statementStudioMode(): StatementStudioMode {
  return parseStatementStudioMode(process.env[STATEMENT_STUDIO_MODE_ENV])
}

/**
 * THE ONE ANSWER A HIDDEN CALLER GETS, from every Statement Studio endpoint.
 *
 * Neutral on purpose. It names no draft, no statement, no upload, no
 * administrator, no mode and no Studio, so a blocked caller receives the same
 * two words whichever endpoint they probed and learns nothing about what lives
 * behind any of them.
 *
 * NOT THE SAME THING AS A MISSING DRAFT. lib/statement/draft/http.ts has its own
 * NOT_FOUND_BODY, and that one is still right for a caller who has ALREADY
 * passed this gate and asked for a draft that is absent or invisible to them.
 * The two say different things:
 *
 *   gate-hidden       this endpoint does not exist for you
 *   draft not found   it exists and you may use it; that row is not there
 *
 * Conflating them costs something either way. This constant replaced the draft
 * body on /api/statement/extract, where "That draft could not be found." was
 * plainly wrong for an endpoint that reads uploaded files. Going the other way
 * -- answering an admitted user's genuine 404 with this -- would take away the
 * one thing they actually need to be told.
 *
 * That the two differ leaks nothing: only an ADMITTED caller can ever see the
 * draft-specific body, so a blocked caller has nothing to compare against.
 *
 * `code` is 'not-found' because that is what the status means here, matching
 * every other 404 this codebase sends.
 */
export const STATEMENT_STUDIO_HIDDEN_BODY = {
  error: 'Not found.',
  code: 'not-found',
} as const

/**
 * 'hidden' is a 404, never a 403.
 *
 * A 403 confirms two things at once: that the route exists, and that somebody
 * else is allowed to use it. For an unreleased feature both are the answer to a
 * question nobody asked. A 404 says nothing.
 */
export type StatementStudioAccess =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 401; readonly reason: 'sign-in' }
  | { readonly allowed: false; readonly status: 404; readonly reason: 'hidden' }

const ALLOWED: StatementStudioAccess = { allowed: true }
const SIGN_IN: StatementStudioAccess = { allowed: false, status: 401, reason: 'sign-in' }
const HIDDEN: StatementStudioAccess = { allowed: false, status: 404, reason: 'hidden' }

/**
 * Pure: identity and rollout state in, a decision out. No cookies, no database,
 * no environment. The caller establishes who the visitor is; this decides only
 * what that means.
 *
 * Every comparison is `=== true`. The inputs arrive from an `auth` object that
 * may be null and from a helper that returns a boolean today, and a truthy check
 * would admit a non-empty string or an object. Two of the tests exist only to
 * hold that line.
 *
 * TIER IS NOT CONSULTED. Whether a paid plan includes the Studio is a separate
 * question, asked by whatever performs the work; it is not what "may I open this
 * page" means.
 */
export function statementStudioAccess(input: {
  isAdmin: boolean
  isAuthenticated: boolean
  mode: StatementStudioMode
}): StatementStudioAccess {
  // An anonymous visitor in 'internal' mode is told nothing -- not even that
  // signing in would help, because for them there is nothing to sign in to. Once
  // the Studio is general, a deep link deserves a login prompt like any other
  // authenticated page.
  if (input.isAuthenticated !== true) {
    return input.mode === 'general' ? SIGN_IN : HIDDEN
  }
  if (input.mode === 'general') return ALLOWED
  return input.isAdmin === true ? ALLOWED : HIDDEN
}
