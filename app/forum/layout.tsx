import type { Metadata } from 'next'

/**
 * /forum is the members community. This layout also covers /forum/[id], so individual threads are excluded from search on the same basis.
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
  title: 'Community Forum | CRNA Prep Hub',
  robots: {
    index: false,
    follow: true,
  },
}

export default function ForumLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
