import type { Metadata } from 'next'

const SITE = 'https://www.crnaprephub.com'

/**
 * /personal-statement had no route metadata of its own, so it inherited the
 * root layout's generic site title and description. page.tsx is a client
 * component and cannot export metadata, so it is set here.
 *
 * Positioned as an Analyzer rather than a Builder, matching the visible H1
 * and the actual product. The description names the AI feedback, scoring and
 * sentence-level suggestions without implying they are all free — the page
 * itself states that the full breakdown, sentence-level edits and AI rewrites
 * are Ultimate features.
 */
const TITLE = 'CRNA Personal Statement Analyzer & AI Feedback | CRNA Prep Hub'
const DESCRIPTION =
  'Analyze your CRNA personal statement with AI feedback, scoring, ' +
  'sentence-level suggestions, and tools to strengthen your nurse anesthesia application.'
const URL = `${SITE}/personal-statement`

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Self-referencing, parameter-free.
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

export default function PersonalStatementLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
