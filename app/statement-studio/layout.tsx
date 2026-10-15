import type { Metadata } from 'next'
import {
  SIMULATED_LIVE_BANNER, simulatedLiveEnabled,
} from '@/lib/statement/devMode/gate'

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
  // THE BANNER EXISTS SO THIS CANNOT BE MISTAKEN FOR PRODUCTION.
  //
  // In simulated-live mode localhost deliberately looks like the released
  // product: the catalog is populated, drafts save, the checklist renders. That
  // is the whole point, and it is also exactly why a reviewer could forget
  // which machine they are on. The strip is thin and fixed to the bottom so it
  // changes no layout above it, and it states the two facts that matter: this
  // is local, and production is still dark.
  //
  // RENDERED ON THE SERVER, FROM NODE_ENV. A deployed build never evaluates
  // this to true, so the markup does not exist in production at all -- it is
  // not hidden with CSS, which could be inspected away.
  return (
    <>
      {children}
      {simulatedLiveEnabled() ? (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center
                     px-3 pb-2"
        >
          <p className="pointer-events-auto rounded-full border border-amber-500 bg-amber-100/95
                        px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-950
                        shadow-lg backdrop-blur">
            {SIMULATED_LIVE_BANNER}
          </p>
        </div>
      ) : null}
    </>
  )
}
