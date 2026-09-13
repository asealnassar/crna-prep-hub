/**
 * Who may reach Resume V2.
 *
 * Until Phase 12 this was a permanent admin allowlist -- the dev gate on an
 * unreleased feature. It is now the rollout gate, and it answers a different
 * question: not "is this person an admin" but "is V2 the live builder for this
 * person yet". The two states the old gate could express were not enough for a
 * cutover; see lib/resume/rollout.ts for why the middle state matters.
 *
 * STILL PURE, and still takes its answers as data. It does NOT import
 * lib/apiAuth (which imports next/headers and cannot be resolved by
 * `node --test`) and does NOT read process.env (which would put a second
 * reader of the rollout flag in the codebase). Callers compose the three:
 *
 *     const auth = await authenticateRequest()
 *     const access = resumeV2Access({
 *       isAdmin: isAdminEmail(auth?.email),
 *       isAuthenticated: auth !== null,
 *       mode: resumeBuilderMode(),
 *     })
 *
 * WHY 404 AND NOT 403 for a signed-in user who is not yet on V2. A 403
 * confirms the route exists AND that someone else is allowed to use it, which
 * invites a blocked user to ask why. A 404 says nothing. This is a feature
 * that has not launched for them, not a permission error anyone should act on.
 *
 * It is a gate, not a secret. A 404 from a route that exists is not
 * byte-identical to a 404 from a path that matches nothing, so the route's
 * EXISTENCE is discoverable by someone comparing responses. What it protects is
 * everything that matters: no V2 markup, bundle, data or contract reaches a
 * blocked caller, and RLS still owns the rows underneath.
 *
 * ENTITLEMENTS ARE NOT HERE. Passing this gate means "V2 is your builder", not
 * "you may finalize or export". Those stay in lib/resume/entitlement.ts,
 * resolved from the database tier, and are unchanged by the mode.
 */

import type { ResumeBuilderMode } from './rollout.ts'

export type ResumeV2Access =
  | { readonly allowed: true }
  /** No session. A page should send them to sign in; a route returns 401. */
  | { readonly allowed: false; readonly status: 401; readonly reason: 'sign-in' }
  /** V2 is not this person's builder yet. They are told nothing. */
  | { readonly allowed: false; readonly status: 404; readonly reason: 'hidden' }

const SIGN_IN = { allowed: false, status: 401, reason: 'sign-in' } as const
const HIDDEN = { allowed: false, status: 404, reason: 'hidden' } as const
const ALLOWED = { allowed: true } as const

/**
 * The single gate.
 *
 * Each comparison is `=== true`, not a truthiness check. TypeScript already
 * types these as booleans, but the values that must never be widened by
 * accident are exactly these: a caller reaching through `any` -- a parsed JSON
 * body, an untyped helper -- would otherwise open the gate with the string
 * "false".
 *
 * Order matters. Authentication is checked first in BOTH modes, so v2 mode
 * never opens V2 to an anonymous request: "everyone" means every signed-in
 * user, and RLS underneath still scopes every row to its owner.
 */
export function resumeV2Access(input: {
  isAdmin: boolean
  isAuthenticated: boolean
  mode: ResumeBuilderMode
}): ResumeV2Access {
  if (input.isAuthenticated !== true) {
    // In v1 mode V2 does not exist for the public, so an anonymous probe is
    // told nothing at all -- not even that signing in would help.
    return input.mode === 'v2' ? SIGN_IN : HIDDEN
  }
  if (input.mode === 'v2') return ALLOWED
  return input.isAdmin === true ? ALLOWED : HIDDEN
}

/** What a blocked caller is told. Deliberately indistinguishable from a typo. */
export const BLOCKED_BODY = { error: 'Not found' } as const

/** What an unauthenticated caller is told, matching every other route. */
export const UNAUTHORIZED_BODY = { error: 'Unauthorized' } as const
