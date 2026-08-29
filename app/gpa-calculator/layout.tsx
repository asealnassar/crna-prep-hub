import type { Metadata } from 'next'

/**
 * Metadata lives in this layout because page.tsx is a client component and
 * cannot export it. The layout wraps the page without altering its rendering,
 * so the calculator's fields, formulas and Ultimate gating are unaffected.
 */
const SITE = 'https://www.crnaprephub.com'

const TITLE = 'CRNA GPA Calculator: Science, Nursing & Last 60 GPA | CRNA Prep Hub'
const DESCRIPTION =
  'Calculate your CRNA application GPA, including science, nursing, overall and ' +
  'last 60 credits GPA, with the free GPA calculator from CRNA Prep Hub.'
const URL = `${SITE}/gpa-calculator`

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  robots: { index: true, follow: true },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: URL,
    siteName: 'CRNA Prep Hub',
    type: 'website',
  },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
}

export default function GpaCalculatorLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
