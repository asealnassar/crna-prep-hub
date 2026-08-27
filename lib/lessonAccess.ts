import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'

/**
 * Draft lessons are visible only to the author until the module launches.
 *
 * The session is read from the cookie directly rather than through
 * @supabase/auth-helpers-nextjs: that package is pinned at 0.8.7, which calls
 * next/headers `cookies()` synchronously. Next 16 returns a Promise from it, so
 * every server-side helper call throws `nextCookies.get is not a function`.
 */
const AUTHORS = ['asealnassar@gmail.com']

export const DRAFT_LESSONS = [
  {
    slug: 'vasopressors-1',
    number: 1,
    title: 'The Pressure Machine',
    blurb: 'MAP, smooth-muscle contraction, and the three G-protein pathways.',
  },
  {
    slug: 'vasopressors-2',
    number: 2,
    title: 'Tracing Norepinephrine',
    blurb: 'α₁ and β₁ traced separately, then combined into a full profile.',
  },
] as const

export function isDraftSlug(slug: string): boolean {
  return DRAFT_LESSONS.some((l) => l.slug === slug)
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

  try {
    const parsed = JSON.parse(decodeURIComponent(raw))
    if (Array.isArray(parsed)) return typeof parsed[0] === 'string' ? parsed[0] : null
    return parsed?.access_token ?? null
  } catch {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return typeof parsed[0] === 'string' ? parsed[0] : null
      return parsed?.access_token ?? null
    } catch {
      return null
    }
  }
}

export async function canViewDrafts(): Promise<boolean> {
  try {
    const token = await readAccessToken()
    if (!token) return false

    // Verifies the token against Supabase — a forged cookie will not pass.
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user?.email) return false

    return AUTHORS.includes(data.user.email.toLowerCase())
  } catch (error) {
    console.error('Draft access check failed:', error)
    return false
  }
}
