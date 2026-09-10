import type { Metadata } from 'next'

/**
 * /resume-studio is Resume Builder V2, and it is not released.
 *
 * The page component applies the admin gate on the server and calls notFound()
 * for everyone else, so a crawler receives a 404 and there is nothing to index.
 * The noindex directive is belt and braces for the day the gate opens: when V2
 * becomes the real builder it will be an authenticated application route, which
 * is private for the same reason /resume-builder is.
 *
 * `follow: true` keeps outbound links crawlable, matching /resume-builder.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: true,
  },
}

export default function ResumeStudioLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
