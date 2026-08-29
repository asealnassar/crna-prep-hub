import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { FREE_INTERVIEW_ALLOWANCE } from '@/lib/plans'

/**
 * Server-side interview entitlement and usage.
 *
 * The allowance used to be enforced only in the browser (app/interview/page.tsx
 * computed `canInterview` and then wrote the new count itself with
 * `update({ interview_count: interviewCount + 1 })`). That put both the limit
 * and the counter under the user's control: DevTools could reset the count, or
 * skip the page entirely and POST /api/interview directly. Everything here runs
 * from a verified session instead, and the counter is never accepted as input.
 */

/** Built only after the caller has been authenticated. */
export function serviceClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    console.error('Interview usage: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return null
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Authoritative usage count, read from the database rather than the request. */
export async function readInterviewCount(
  admin: SupabaseClient,
  userId: string
): Promise<number> {
  const { data, error } = await admin
    .from('user_profiles')
    .select('interview_count')
    .eq('id', userId)
    .single()

  // Fail closed: an unreadable profile is treated as fully used, never as zero.
  if (error || !data) {
    console.error('Interview usage: count lookup failed', error?.message)
    return Number.MAX_SAFE_INTEGER
  }
  return Number(data.interview_count ?? 0)
}

/**
 * Charges one interview.
 *
 * Prefers the atomic increment_interview_count() RPC so two concurrent starts
 * cannot both read the same value and write the same +1. Falls back to a
 * read-then-write if that function is not present yet, which is still strictly
 * better than the browser doing it, and logs so the gap is visible.
 */
export async function chargeInterview(
  admin: SupabaseClient,
  userId: string
): Promise<number | null> {
  const { data, error } = await admin.rpc('increment_interview_count', {
    p_user_id: userId,
  })
  if (!error && typeof data === 'number') return data

  console.warn(
    'Interview usage: atomic increment unavailable, falling back —',
    error?.message ?? 'unexpected return'
  )

  const current = await readInterviewCount(admin, userId)
  if (current === Number.MAX_SAFE_INTEGER) return null
  const next = current + 1
  const { error: updateError } = await admin
    .from('user_profiles')
    .update({ interview_count: next })
    .eq('id', userId)
  if (updateError) {
    console.error('Interview usage: increment failed', updateError.message)
    return null
  }
  return next
}

export { FREE_INTERVIEW_ALLOWANCE }
