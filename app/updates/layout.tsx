import type { Metadata } from 'next'

/**
 * /updates lists product changes for existing members.
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
  title: 'Product Updates | CRNA Prep Hub',
  robots: {
    index: false,
    follow: true,
  },
}

export default function UpdatesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
