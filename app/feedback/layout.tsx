import type { Metadata } from 'next'

/**
 * /feedback is a submission form for signed-in members.
 *
 * Logged out it renders only the navigation shell, so there is nothing for a
 * crawler to index and no reason for it to compete in search results. Marked
 * noindex rather than disallowed in robots.txt: a crawler has to fetch the
 * page to see this directive, and a Disallow would prevent that.
 *
 * `follow: true` keeps its outbound links crawlable. The route is not in
 * sitemap.xml and is not being added.
 */
export const metadata: Metadata = {
  title: 'Send Feedback | CRNA Prep Hub',
  robots: {
    index: false,
    follow: true,
  },
}

export default function FeedbackLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
