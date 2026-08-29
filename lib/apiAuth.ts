import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'

/**
 * Server-side authentication and tier resolution for API route handlers.
 *
 * Route handlers previously trusted whatever the browser said about the user's
 * subscription, which meant Ultimate-only work could be requested by anyone.
 * Everything here is derived from a verified session and the database.
 *
 * The session is read from the cookie directly rather than through
 * @supabase/auth-helpers-nextjs: that package is pinned at 0.8.7, which calls
 * next/headers `cookies()` synchronously. Next 16 returns a Promise from it, so
 * every server-side helper call throws `nextCookies.get is not a function`.
 * (lib/lessonAccess.ts reads the cookie the same way for the same reason.)
 */
export type AuthedUser = {
  userId: string
  email: string | null
  /** Lower-cased value straight from user_profiles.subscription_tier. */
  tier: string
  isUltimate: boolean
}

/** Reassembles the Supabase auth cookie, which is split across .0/.1 when large. */
async function readAccessToken(): Promise<string | null> {
  const jar = await cookies()
  const parts = jar
    .getAll()
    .filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (parts.length === 0) return null

  let raw = parts.map((c) => c.value).join('')
  if (raw.startsWith('base64-')) {
    try {
      raw = Buffer.from(raw.slice(7), 'base64').toString('utf-8')
    } catch {
      return null
    }
  }

  const extract = (text: string): string | null => {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return typeof parsed[0] === 'string' ? parsed[0] : null
    return parsed?.access_token ?? null
  }

  try {
    return extract(decodeURIComponent(raw))
  } catch {
    try {
      return extract(raw)
    } catch {
      return null
    }
  }
}

/**
 * Returns the authenticated caller, or null when there is no valid session.
 *
 * Fails closed at every step: a missing cookie, a token Supabase rejects, an
 * unreadable profile row or any thrown error all resolve to "not Ultimate" —
 * never to elevated access. The anon key plus the caller's own JWT is used
 * deliberately, so this helper can never read more than the user can.
 */
export async function authenticateRequest(): Promise<AuthedUser | null> {
  try {
    const token = await readAccessToken()
    if (!token) return null

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }
    )

    // Verifies the token against Supabase — a forged cookie will not pass.
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) return null
    const user = data.user

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', user.id)
      .single()

    // A failed or empty profile lookup degrades to the lowest tier rather than
    // granting anything. An error must never be a path to Ultimate.
    const tier =
      !profileError && profile?.subscription_tier
        ? String(profile.subscription_tier).toLowerCase()
        : 'free'

    return {
      userId: user.id,
      email: user.email ?? null,
      tier,
      isUltimate: tier === 'ultimate',
    }
  } catch (error) {
    console.error('API authentication failed:', error)
    return null
  }
}
