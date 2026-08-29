import type { Metadata } from 'next'

/**
 * /interview-prep is an authenticated application page: logged-out visitors get
 * a login wall, and its content is Ultimate-gated school interview data. There
 * is no public landing state for a crawler to index, so the route is marked
 * noindex and removed from the sitemap.
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

export default function InterviewPrepLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
