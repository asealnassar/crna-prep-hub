import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'

/**
 * Admin-only access to school error reports.
 *
 * /admin/reports used to read, update and delete school_reports straight from
 * the browser, which required the anon/authenticated roles to hold those
 * privileges on a table containing reporter email addresses. Every operation
 * now runs here behind a verified session and the shared admin allowlist, so
 * the database can revoke browser access entirely.
 *
 * Only three narrow operations are exposed. There is no general-purpose row
 * update: PATCH writes `status` and nothing else, from a fixed set of values.
 */

/** The only statuses the admin UI produces. Anything else is rejected. */
const ALLOWED_STATUSES = ['pending', 'resolved'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Guard =
  | { ok: true; admin: SupabaseClient }
  | { ok: false; response: NextResponse }

/**
 * Authentication, then authorization, then — and only then — the service-role
 * client. Nothing privileged is constructed for an unauthorized caller.
 */
async function requireAdmin(): Promise<Guard> {
  const auth = await authenticateRequest()
  if (!auth) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!isAdminEmail(auth.email)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    console.error('Admin reports: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return {
      ok: false,
      response: NextResponse.json({ error: 'Server configuration error' }, { status: 500 }),
    }
  }

  return {
    ok: true,
    admin: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  }
}

/** Reports for the admin queue. reporter_email is included deliberately: the
 *  admin needs to know who to follow up with, and this route is admin-only. */
export async function GET() {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const { data, error } = await guard.admin
    .from('school_reports')
    .select('id, school_id, school_name, field_with_error, description, reporter_email, status, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Admin reports fetch failed:', error.message)
    return NextResponse.json({ error: 'Could not load reports' }, { status: 500 })
  }

  return NextResponse.json({ reports: data ?? [] })
}

/** Status only. The body cannot name a column, so no other field is writable. */
export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let body: any = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const id = typeof body?.id === 'string' ? body.id : ''
  const status = typeof body?.status === 'string' ? body.status : ''

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid report id' }, { status: 400 })
  }
  if (!ALLOWED_STATUSES.includes(status as (typeof ALLOWED_STATUSES)[number])) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const { error } = await guard.admin
    .from('school_reports')
    .update({ status })
    .eq('id', id)

  if (error) {
    console.error('Admin report update failed:', error.message)
    return NextResponse.json({ error: 'Could not update report' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

/** Deletes one report, addressed by id in the query string. */
export async function DELETE(request: NextRequest) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const id = request.nextUrl.searchParams.get('id') ?? ''
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid report id' }, { status: 400 })
  }

  const { error } = await guard.admin.from('school_reports').delete().eq('id', id)

  if (error) {
    console.error('Admin report delete failed:', error.message)
    return NextResponse.json({ error: 'Could not delete report' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
