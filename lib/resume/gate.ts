/**
 * Who may reach Resume V2 while it is being built.
 *
 * Decision 12 of the approved blueprint: admin-only, reusing the allowlist that
 * already exists in lib/apiAuth.ts. No env var, no flag table, no new
 * mechanism -- ADMIN_EMAILS is already the repo's answer to "only these people"
 * and is already checked against a verified session by every privileged route.
 *
 * This module is deliberately pure and takes the answer as a boolean. It does
 * NOT import lib/apiAuth: that module imports next/headers, which cannot be
 * resolved by `node --test` and cannot be pulled into a client bundle. The same
 * separation is why lib/messaging/notificationWorker.ts takes `isAdmin` as a
 * parameter rather than computing it. Callers compose the two:
 *
 *     const auth = await authenticateRequest()
 *     const access = resumeV2Access({ isAdmin: isAdminEmail(auth?.email) })
 *
 * WHY 404 AND NOT 403. A 403 confirms the route exists AND that someone else is
 * allowed to use it, which invites a blocked user to ask why. A 404 says
 * nothing and needs no explanation. This is the gate on an unreleased feature,
 * not a permission error anyone is meant to act on.
 *
 * It is a gate, not a secret. A 404 from a route that exists is not byte-identical
 * to a 404 from a path that matches nothing, so the route's EXISTENCE is
 * discoverable by someone comparing responses. What it protects is everything
 * that matters: no V2 markup, bundle, data or contract reaches a blocked caller,
 * and RLS still owns the rows underneath.
 *
 * WHEN THIS IS REMOVED. At cutover (Phase 12), when V2 becomes the real resume
 * builder. Until then, every V2 route and page must call this. A V2 surface
 * that does not is a bug, not a convenience.
 */

export type ResumeV2Access =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 404 }

/**
 * The single gate. Admin-only for now; the shape of the input is an object so
 * a later UAT allowlist can be added without changing any call site's arity.
 */
export function resumeV2Access(input: { isAdmin: boolean }): ResumeV2Access {
  // `=== true`, not a truthiness check. TypeScript already types this as a
  // boolean, but the one value that must never be widened by accident is this
  // one: a caller reaching through `any` -- a parsed JSON body, an untyped
  // helper -- would otherwise open the gate with the string "false".
  return input.isAdmin === true ? { allowed: true } : { allowed: false, status: 404 }
}

/** What a blocked caller is told. Deliberately indistinguishable from a typo. */
export const BLOCKED_BODY = { error: 'Not found' } as const
