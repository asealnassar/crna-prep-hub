import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { BLOCKED_BODY, resumeV2Access } from '@/lib/resume/gate'
import { decideExport } from '@/lib/resume/entitlement'
import { readResume } from '@/lib/resume/repo/resumeRepo'
import { docxFilename, docxFromResume } from '@/lib/resume/export/docx'

/**
 * DOCX export. The same gate as PDF, because it is the same gate.
 *
 * `decideExport` is reused rather than duplicated: taking the finished file
 * away is one entitlement whatever its extension, and two copies of that rule
 * would be two places for it to drift.
 *
 * No service role, no tier claim from the body, ownership decided by RLS.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const access = resumeV2Access({ isAdmin: isAdminEmail(auth.email) })
  if (!access.allowed) return NextResponse.json(BLOCKED_BODY, { status: access.status })

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
  if (typeof id !== 'string' || !UUID.test(id)) {
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
    console.error('resume-v2 docx export: read failed', read.reason, read.detail)
    return NextResponse.json({ error: 'read-failed' }, { status: 500 })
  }
  const resume = read.value.resume
  if (!resume) return NextResponse.json({ error: 'not-found' }, { status: 404 })

  try {
    const docx = await docxFromResume(resume)
    return new NextResponse(new Uint8Array(docx), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${docxFilename(resume)}"`,
        'Content-Length': String(docx.length),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
    // Never the error object: a generation failure can carry the document.
    console.error('resume-v2 docx export failed:', (error as { name?: string })?.name)
    return NextResponse.json({ error: 'export-failed' }, { status: 500 })
  }
}
