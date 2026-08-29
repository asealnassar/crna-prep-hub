import type { Metadata } from 'next'

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

export default function ResumeBuilderLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
