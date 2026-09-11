import { notFound } from 'next/navigation'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'
import { resumeV2Access } from '@/lib/resume/gate'
import OnboardFlow from '../components/studio/OnboardFlow'

/**
 * A guided start. Gated on the server like every other V2 surface.
 */
export const dynamic = 'force-dynamic'

export default async function OnboardPage() {
  const auth = await authenticateRequest()
  const access = resumeV2Access({ isAdmin: isAdminEmail(auth?.email) })
  if (!access.allowed) notFound()
  return <OnboardFlow />
}
