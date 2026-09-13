import { notFound, redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { resumeV2Access } from '@/lib/resume/gate'
import { resumeBuilderMode } from '@/lib/resume/rollout'
import { readResume } from '@/lib/resume/repo/resumeRepo'
import StudioClient from '../components/studio/StudioClient'

/**
 * The Studio: one resume, editor and live preview.
 *
 * A server component, for the same reason the dashboard is one -- the gate runs
 * before any V2 markup or client bundle exists. It also does the initial read,
 * so the Studio opens with the document already in hand rather than flashing an
 * empty editor while a fetch resolves.
 *
 * The read is made with the caller's own JWT, so RLS decides what they may
 * open. A resume that belongs to someone else is not "forbidden" here; it
 * simply does not exist, which is the same answer as a bad id.
 */
export const dynamic = 'force-dynamic'

export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
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
  if (!access.allowed || !auth) notFound()

  const token = await readAccessToken()
  if (!token) notFound()

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  const { id } = await params
  const read = await readResume(db, id)
  if (!read.ok || !read.value.resume) notFound()

  // The tier comes from the verified session and is passed down for
  // presentation only. Every gate it drives is enforced again server-side.
  return <StudioClient initialResume={read.value.resume} tier={auth.tier} />
}
