import type { Metadata } from 'next'

/**
 * /interview is the public landing page for the AI mock interview feature and
 * should be indexed. Metadata lives in this layout because page.tsx is a
 * client component and cannot export it.
 *
 * Not to be confused with /interview-prep, which is the authenticated,
 * Ultimate-gated School Interview Styles page and is deliberately noindex.
 * Layouts do not cascade between sibling routes, so that directive has never
 * applied here — the explicit index/follow below makes the intent unambiguous.
 */
const SITE = 'https://www.crnaprephub.com'

const TITLE = 'CRNA Mock Interview: Clinical & EI Practice | CRNA Prep Hub'
const DESCRIPTION =
  'Practice realistic CRNA mock interviews with clinical and emotional intelligence ' +
  'questions, adaptive follow-ups, scoring, and detailed AI feedback.'
const URL = `${SITE}/interview`

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

export default function InterviewLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
