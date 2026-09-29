import type { Metadata } from 'next'

/**
 * /statement-studio is Personal Statement Studio, and it is not released.
 *
 * The page component applies the admin gate on the server and calls notFound()
 * for everyone else, so a crawler receives a 404 and there is nothing to index.
 * The noindex directive is belt and braces for the day the gate opens: when the
 * Studio becomes the real statement editor it will be an authenticated
 * application route, which is private for the same reason /personal-statement
 * is. This mirrors app/resume-studio/layout.tsx, which exists for exactly this.
 *
 * `follow: true` keeps outbound links crawlable, matching the rest of the site.
 *
 * WHAT THIS DOES NOT HIDE. The 404 produced under this layout is not identical
 * to the 404 for a path that matches no route at all: this one renders inside
 * StatementStudioLayout, so the two responses differ in size and in their RSC
 * payload. Someone probing URLs can therefore learn that a route named
 * /statement-studio exists. They learn nothing else -- no markup, no client
 * bundle, no data, no hint of purpose. Making the two indistinguishable would
 * take a middleware rewrite ahead of route matching, which is more machinery
 * than an unreleased feature's dev gate warrants.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: true,
  },
}

export default function StatementStudioLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
