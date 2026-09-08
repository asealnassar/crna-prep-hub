import { NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'

/**
 * Aggregate counts for the admin analytics dashboard.
 *
 * The cards were previously computed in the browser from `select('*')` reads.
 * PostgREST caps an unbounded select at 1000 rows, so "Questions Asked"
 * displayed exactly 1000 against a true 3,842, and "Used Interview" counted
 * only the 69 distinct users inside that truncated page rather than 250.
 *
 * Everything is counted here instead. Nothing but four integers is returned —
 * no user rows, no profiles, no question rows, no emails.
 */

/** Rows per page for the one metric that cannot be answered by a head count. */
const PAGE = 900

function serviceClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    console.error('Analytics: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return null
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Exact row count with no rows transferred. */
async function exactCount(admin: SupabaseClient, table: string, column = 'id', filter?: [string, string]) {
  let query = admin.from(table).select(column, { count: 'exact', head: true })
  if (filter) query = query.eq(filter[0], filter[1])
  const { count, error } = await query
  if (error) throw new Error(`${table} count failed: ${error.message}`)
  return count ?? 0
}

export async function GET() {
  try {
    // Authentication, then admin authorization. The service-role client is not
    // constructed until both have passed.
    const auth = await authenticateRequest()
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isAdminEmail(auth.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const admin = serviceClient()
    if (!admin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })

    // ---- Total users: auth.users, paginated. Deliberately not user_profiles,
    //      which currently holds 7 fewer rows than there are accounts.
    let totalUsers = 0
    for (let page = 1; ; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw new Error(`auth listUsers failed: ${error.message}`)
      const batch = data?.users ?? []
      totalUsers += batch.length
      if (batch.length < 1000) break
    }

    // ---- Exact head counts: no rows cross the wire at all.
    const questionsAsked = await exactCount(admin, 'user_asked_questions')
    const ultimateMembers = await exactCount(admin, 'user_profiles', 'id', [
      'subscription_tier',
      'ultimate',
    ])

    // ---- Distinct interview users. Supabase's count API cannot express
    //      COUNT(DISTINCT user_id), so the ids are paged server-side and
    //      deduplicated here. Only the user_id column is read, and no row
    //      leaves this function.
    const seen = new Set<string>()
    let pages = 0
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('user_asked_questions')
        .select('user_id')
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`interview users page failed: ${error.message}`)
      const rows = data ?? []
      pages++
      for (const row of rows) if (row.user_id) seen.add(row.user_id)
      if (rows.length < PAGE) break
    }

    return NextResponse.json({
      totalUsers,
      usedInterview: seen.size,
      ultimateMembers,
      questionsAsked,
      // Diagnostic only, so a future truncation is visible rather than silent.
      meta: { distinctUserPages: pages, pageSize: PAGE },
    })
  } catch (error) {
    console.error('Analytics error:', error)
    return NextResponse.json({ error: 'Could not load analytics' }, { status: 500 })
  }
}
