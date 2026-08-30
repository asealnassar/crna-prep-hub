import type { Metadata } from 'next'

/**
 * Post-checkout confirmation, reachable only after a payment.
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
  title: 'Payment Successful | CRNA Prep Hub',
  robots: {
    index: false,
    follow: true,
  },
}

export default function SuccessLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
