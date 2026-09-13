import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { legacyBuilderDisposition, resumeBuilderMode } from '@/lib/resume/rollout'

/**
 * /resume-builder is an authenticated application route, not a marketing page.
 * The page component redirects logged-out visitors to /login before rendering
 * anything, so a crawler only ever receives the "Loading..." shell — there is
 * no public landing state to index. Its child routes (/create, /edit/[id],
 * /preview/[id]) inherit this layout and are private for the same reason: they
 * render a specific user's saved resume.
 *
 * `follow: true` keeps the outbound links (e.g. /pricing) crawlable.
 *
 * Deliberately NOT disallowed in robots.txt — a crawler has to fetch the page
 * to see this directive, and a Disallow would prevent that.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: true,
  },
}

/**
 * THE ONE PLACE V1 IS SWITCHED OFF.
 *
 * This layout wraps all four V1 pages, and it is the only server component
 * among them — the pages themselves are all `'use client'` and cannot read a
 * server-side flag. Putting the decision here means every V1 entry point is
 * covered at once: the sidebar link, the dashboard card, the feedback page's
 * back link, and every bookmark anyone ever saved. None of them needs to know
 * the mode, which is why there is no browser-visible copy of the flag.
 *
 * Redirect rather than 404: in v2 mode these URLs have a correct destination,
 * and sending someone to the working builder is better than telling them their
 * bookmark is broken. The V1 code stays in the repository, one environment
 * variable away from serving again, for the agreed emergency rollback window.
 *
 * `force-dynamic` is required, not decorative. Without it Next renders this
 * layout at BUILD time, which would freeze whichever mode was set when the
 * bundle was produced and make the flag unchangeable without a code change.
 */
export const dynamic = 'force-dynamic'

export default function ResumeBuilderLayout({ children }: { children: React.ReactNode }) {
  const disposition = legacyBuilderDisposition(resumeBuilderMode())
  if (!disposition.visible) redirect(disposition.redirectTo)

  return <>{children}</>
}
