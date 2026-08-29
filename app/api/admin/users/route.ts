import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'

/**
 * Admin-only user listing.
 *
 * This route previously ran auth.admin.listUsers() with the service-role key
 * for any caller, with no authentication whatsoever — an unauthenticated GET
 * returned every user's email address. Both checks below now run before the
 * service-role client is constructed, so no RLS-bypassing query is ever issued
 * on behalf of an unauthorized caller.
 *
 * The response is reduced to the three fields app/admin/analytics/page.tsx
 * actually reads. Identities, app/user metadata and auth internals are no
 * longer sent to the browser at all.
 */
export async function GET() {
  // 1. Authentication, from the verified session cookie only.
  const auth = await authenticateRequest()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Authorization, against the verified session's email. Nothing the caller
  //    sends — query string, body, headers — participates in this decision.
  if (!isAdminEmail(auth.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 3. Only now is the service-role key touched. Missing configuration denies
  //    the request rather than falling through to a partial response.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Admin user listing: Supabase service configuration missing')
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })

  // Get ALL users with pagination
  let allUsers: any[] = []
  let page = 1
  const perPage = 1000

  while (true) {
    const { data: { users }, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!users || users.length === 0) break

    allUsers = [...allUsers, ...users]

    if (users.length < perPage) break
    page++
  }

  // Field allowlist, not a blocklist: anything new Supabase adds to the user
  // object stays out of the response unless it is added here deliberately.
  const minimal = allUsers.map((user) => ({
    id: user.id,
    email: user.email,
    created_at: user.created_at,
  }))

  return NextResponse.json(minimal)
}
