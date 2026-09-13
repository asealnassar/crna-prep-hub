import { notFound, redirect } from 'next/navigation'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'
import { resumeV2Access } from '@/lib/resume/gate'
import { resumeBuilderMode } from '@/lib/resume/rollout'
import OnboardFlow from '../components/studio/OnboardFlow'

/**
 * A guided start. Gated on the server like every other V2 surface.
 */
export const dynamic = 'force-dynamic'

export default async function OnboardPage() {
  const auth = await authenticateRequest()
  const access = resumeV2Access({
    isAdmin: isAdminEmail(auth?.email),
    isAuthenticated: auth !== null,
    mode: resumeBuilderMode(),
  })
  // In v2 mode the Studio IS the resume builder, so a signed-out visitor is
  // sent to sign in exactly as V1 sent them. In v1 mode V2 has not launched for
  // them and they get the 404 instead, which says nothing at all.
  if (!access.allowed && access.reason === 'sign-in') redirect('/login')
  if (!access.allowed) notFound()
  return <OnboardFlow />
}
