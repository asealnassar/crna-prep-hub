/**
 * Where the admin area can go, and which destination is current.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * No React, no next/link, no next/navigation. The component renders this; it
 * does not decide it. `node --test` cannot resolve Next's bare specifiers, so a
 * rule living inside a component is a rule with no runtime test -- which is the
 * same reason lib/resume/gate.ts and lib/statement/studioGate.ts take their
 * answers as data instead of reading the environment.
 *
 * THE LISTS LIVE HERE TOO, not just the predicate. "Is every admin surface
 * reachable" is a question about the lists, and the failure it guards against
 * is exactly what happened: the Statement catalog manager was reachable only
 * from inside the Statement area, because each page hand-wrote its own row and
 * a new destination had to be remembered in every one of them.
 */

export interface AdminDestination {
  readonly href: string
  readonly label: string
}

/** The general admin surfaces, in the order they have always been listed. */
export const GENERAL_ADMIN: readonly AdminDestination[] = [
  { href: '/admin', label: 'Manage Schools' },
  { href: '/admin/schools', label: 'Edit Schools' },
  { href: '/admin/school-unlocks', label: 'Unlock Requests' },
  { href: '/admin/reports', label: 'Error Reports' },
]

/**
 * The Personal Statement admin area.
 *
 * GROUPED, BECAUSE THEY ARE TWO HALVES OF ONE JOB. The catalog is the reviewed
 * record of what schools ask; submissions are what applicants send toward it.
 * Listing them apart invites the reasonable mistake of editing a submission
 * when you meant the catalog -- the one thing those two screens exist to keep
 * separate.
 *
 * REQUIREMENTS FIRST: it is the master catalog, and the queue feeds it.
 */
export const STATEMENT_ADMIN: readonly AdminDestination[] = [
  { href: '/admin/statement-requirements', label: 'Statement Requirements' },
  { href: '/admin/statement-prompts', label: 'Prompt Submissions' },
]

/**
 * Whether a destination is the one being viewed.
 *
 * SECTION MATCH, NOT EQUALITY, so a child route highlights its parent. Each
 * page used to mark itself current with a hard-coded <span>, which is correct
 * until a route gains a child: /admin/statement-requirements/[id] would have
 * highlighted nothing.
 *
 * ANCHORED WITH A TRAILING SLASH, so /admin/statement-prompts does not light up
 * for /admin/statement-promptsomething -- a prefix is not a path segment.
 *
 * '/admin' IS MATCHED EXACTLY. It is a prefix of every admin route, so treating
 * it as a section would mark the admin home current on all of them.
 */
export function isCurrentAdminPath(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin'
  return pathname === href || pathname.startsWith(`${href}/`)
}
