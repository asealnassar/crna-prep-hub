import type { Metadata } from 'next'

/**
 * Administrative area. This layout covers every /admin route -- analytics, reports, schools, school-unlocks and updates -- so none of them can be indexed.
 *
 * noindex is set on the page itself rather than relying on robots.txt: a
 * Disallow blocks crawling but not indexing, so a disallowed URL can still be
 * listed from external links with no snippet. A meta directive is the only
 * thing that reliably keeps it out of the index -- and Google must be able to
 * fetch the page to read it.
 *
 * `follow: true` keeps outbound links crawlable. Not in sitemap.xml.
 */
export const metadata: Metadata = {
  title: 'Admin | CRNA Prep Hub',
  robots: {
    index: false,
    follow: true,
  },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
