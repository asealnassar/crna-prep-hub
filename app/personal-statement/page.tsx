import { redirect } from 'next/navigation'
import PersonalStatementAnalyzer from './PersonalStatementAnalyzer'

/**
 * /personal-statement — the live analyser, and in development the door to the
 * Statement Studio review.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The analyser is a client component and cannot redirect on the server. So the
 * route is now a SERVER component that does one thing before rendering it:
 * decides whether this is a development machine. The analyser itself moved to
 * ./PersonalStatementAnalyzer with its body untouched, and is rendered here
 * unchanged in every other environment.
 *
 * IN PRODUCTION THIS COSTS NOTHING AND CHANGES NOTHING. `simulatedLiveEnabled()`
 * reads NODE_ENV, which Next fixes at build time, so a deployed build takes the
 * second branch and serves exactly the analyser it served before. No route is
 * added, no rewrite is configured, and there is no middleware.
 *
 * ---------------------------------------------------------------------------
 * WHY A REDIRECT RATHER THAN RENDERING THE STUDIO HERE
 * ---------------------------------------------------------------------------
 * Rendering Statement Studio at this address would make the development URL and
 * the future production URL disagree about what lives where, and the review is
 * meant to rehearse the launch rather than a variant of it. A redirect sends
 * you to the real route, so what you review -- the address, the gate, the
 * layout, the banner -- is what will actually exist.
 *
 * IT CANNOT LOOP. /statement-studio has no redirect of its own; it answers with
 * the Studio or with the gate's 404. The hop is one-way and one-deep.
 *
 * THE QUERY STRING SURVIVES, because ?preview=requirements and ?preview=fixtures
 * are the two addresses a reviewer actually types, and losing them would make
 * this redirect something to work around rather than use.
 */
export default async function PersonalStatementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { simulatedLiveEnabled } = await import('@/lib/statement/devMode/gate')
  if (simulatedLiveEnabled()) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(await searchParams)) {
      if (typeof value === 'string') params.append(key, value)
      // A REPEATED PARAMETER IS CARRIED THROUGH AS REPEATED, not collapsed: the
      // preview gate refuses `?preview=a&preview=b` on purpose, and a redirect
      // that quietly picked one would hide that refusal.
      else if (Array.isArray(value)) for (const item of value) params.append(key, item)
    }
    const query = params.toString()
    redirect(query === '' ? '/statement-studio' : `/statement-studio?${query}`)
  }
  return <PersonalStatementAnalyzer />
}
