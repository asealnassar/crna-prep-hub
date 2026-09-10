import { notFound } from 'next/navigation'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'
import { resumeV2Access } from '@/lib/resume/gate'
import DashboardClient from './components/dashboard/DashboardClient'

/**
 * The Resume Studio dashboard.
 *
 * A SERVER component on purpose. The gate runs before any V2 markup or client
 * bundle is produced, so a blocked visitor is refused by the server rather than
 * by code they could have read. That closes the weakness the blueprint noted in
 * the route-obscurity option: nothing about V2 ships to someone who cannot use
 * it. The interactive dashboard is a child client component.
 *
 * WHY notFound() AND NOT redirect('/login'). A redirect confirms the route
 * exists and is worth signing in for, and sends the visitor somewhere that
 * implies there is something to come back to. A 404 says nothing. The one
 * consequence to know about: an admin whose session has expired sees a 404
 * here, not a login prompt — sign in from anywhere else and return.
 *
 * WHAT THIS DOES NOT HIDE, measured rather than assumed. The 404 produced here
 * is distinguishable from the 404 for a path that matches no route at all: this
 * one renders inside ResumeStudioLayout, so the two responses differ in size
 * and in their RSC payload. Someone probing URLs can therefore learn that a
 * route named /resume-studio exists. They learn nothing else — no markup, no
 * client bundle, no data, and no hint of what the route is for — and the API
 * below it refuses them independently. Making the two indistinguishable would
 * take a middleware rewrite ahead of route matching, which is more machinery
 * than an unreleased feature's dev gate warrants.
 */
/**
 * Per-request by construction: the gate reads the session cookie, so there is
 * nothing to prerender. Declared rather than inferred, because inferring it
 * means Next attempts a static render first, and that attempt surfaces in every
 * build as an "API authentication failed" line from the gate refusing a request
 * that has no cookies.
 */
export const dynamic = 'force-dynamic'

export default async function ResumeStudioPage() {
  const auth = await authenticateRequest()
  const access = resumeV2Access({ isAdmin: isAdminEmail(auth?.email) })
  if (!access.allowed) notFound()

  return <DashboardClient />
}
