import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { BLOCKED_BODY, UNAUTHORIZED_BODY, resumeV2Access } from '@/lib/resume/gate'
import { resumeBuilderMode } from '@/lib/resume/rollout'
import { decideExport } from '@/lib/resume/entitlement'
import { readResume } from '@/lib/resume/repo/resumeRepo'
import { ChromiumUnavailableError, exportResumePdf, pdfFilename } from '@/lib/resume/export/pdf'

/**
 * Server-rendered PDF for one resume.
 *
 * Gated like every other V2 surface, and scoped by the caller's own JWT, so the
 * resume it prints is one RLS already agreed they may read. A resume belonging
 * to someone else does not 403 here; it does not exist.
 *
 * Chromium is the expensive part. `maxDuration` allows for a cold start, which
 * on this path is seconds rather than milliseconds -- the acknowledged price of
 * an export that can be tested. See lib/resume/export/pdf.ts.
 */
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // `auth` is non-null here -- the 401 above returns first -- so the gate's
  // sign-in branch is unreachable from a route handler. It is still handled
  // rather than asserted away, because an assertion here would be a 404 for a
  // signed-out caller in v2 mode, and that is the one refusal that should say
  // plainly that signing in would help.
  const access = resumeV2Access({
    isAdmin: isAdminEmail(auth.email),
    isAuthenticated: true,
    mode: resumeBuilderMode(),
  })
  if (!access.allowed) {
    return NextResponse.json(
      access.reason === 'sign-in' ? UNAUTHORIZED_BODY : BLOCKED_BODY,
      { status: access.status }
    )
  }

  // The monetisation gate. Free and Premium build and preview freely; taking
  // the finished file away is Ultimate's. A 403 and not a 404 on purpose --
  // unlike the V2 dev gate, this is a refusal the applicant is meant to see
  // and act on. The tier comes from the verified session, never the request.
  const entitled = decideExport(auth.tier)
  if (!entitled.allowed) {
    return NextResponse.json({ error: entitled.code, message: entitled.message }, { status: 403 })
  }

  const token = await readAccessToken()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Malformed JSON.' }, { status: 400 })
  }
  const id = (body as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'A valid id is required.' }, { status: 400 })
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  const read = await readResume(db, id)
  if (!read.ok) {
    console.error('resume-v2 pdf export: read failed', read.reason, read.detail)
    return NextResponse.json({ error: 'read-failed' }, { status: 500 })
  }
  const resume = read.value.resume
  if (!resume) return NextResponse.json({ error: 'not-found' }, { status: 404 })

  try {
    const pdf = await exportResumePdf(resume)
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdfFilename(resume)}"`,
        'Content-Length': String(pdf.length),
        // A resume is personal and regenerated cheaply enough. Never cached by
        // an intermediary.
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    // Never the error object: a Puppeteer failure can carry the page's content,
    // and this page is somebody's resume. The message alone is safe to log --
    // launch/render failures are infra text (paths, flags, protocol errors),
    // not resume content -- and is needed to tell a Chromium launch failure
    // apart from a rendering bug from the logs alone.
    const unavailable = error instanceof ChromiumUnavailableError
    const err = error as Error
    console.error('resume-v2 pdf export failed:', unavailable ? err.message : `${err?.name}: ${err?.message}`)
    return NextResponse.json(
      { error: unavailable ? 'export-unavailable' : 'export-failed' },
      { status: unavailable ? 503 : 500 }
    )
  }
}
