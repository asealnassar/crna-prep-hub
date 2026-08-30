import type { Metadata } from 'next'

const SITE = 'https://www.crnaprephub.com'

/**
 * /pricing had no metadata of its own, so it inherited the root layout's
 * generic site title and description — which describe school search and mock
 * interviews rather than the plans. page.tsx is a client component and cannot
 * export metadata, so it is set here.
 *
 * Every claim below is taken from the rendered page: the three plan names, the
 * "One-time payment. Lifetime access. No subscriptions." line, Premium's
 * advanced school filters, and Ultimate's unlimited mock interviews. Prices are
 * deliberately absent — Premium currently shows a limited-time figure, and a
 * price in a description goes stale the moment it changes.
 */
const TITLE = 'Pricing: Free, Premium & Ultimate CRNA Prep Plans | CRNA Prep Hub'
const DESCRIPTION =
  'Compare Free, Premium and Ultimate plans for CRNA school prep. One-time ' +
  'payment, lifetime access, with advanced school filters and unlimited mock interviews.'
const URL = `${SITE}/pricing`

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Self-referencing and parameter-free.
  alternates: { canonical: URL },
  robots: { index: true, follow: true },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: URL,
    siteName: 'CRNA Prep Hub',
    type: 'website',
  },
  // `summary` rather than `summary_large_image`: there is still no sitewide
  // social image, and this step does not create one.
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
