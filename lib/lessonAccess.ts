import { cookies } from 'next/headers'
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs'

/**
 * Draft lessons are visible only to the author until the module launches.
 * Checked on the server: the lesson HTML lives outside public/ so it cannot be
 * fetched by URL, and every route that serves it calls this first.
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

export async function canViewDrafts(): Promise<boolean> {
  try {
    const supabase = createServerComponentClient({ cookies })
    const { data: { user } } = await supabase.auth.getUser()
    return !!user?.email && AUTHORS.includes(user.email.toLowerCase())
  } catch {
    return false
  }
}
