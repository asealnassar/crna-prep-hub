import { createClient } from '@supabase/supabase-js'
import SchoolsClient from './SchoolsClient'

// Regenerated hourly. The directory changes rarely, so serving a cached page
// keeps it fast while staying current.
export const revalidate = 3600

/**
 * Server-fetches the school directory so the list, the names, and the real
 * counts are present in the initial HTML. Previously this page was entirely
 * client-rendered, which meant crawlers received "Browse and filter  CRNA
 * programs" with no schools at all.
 *
 * Uses the anon key: the schools table is public reference data and is already
 * read with this key from the browser, so this grants no additional access.
 */
async function getSchools() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )

    // Public columns only. application_deadline, gre_requirement,
    // application_method and website_url are paid fields — the card blurs them
    // for free users, so server-rendering them would put premium content into
    // crawlable HTML. The client fetches the full row after mount, exactly as
    // it did before, which preserves the existing blurred-with-lock treatment.
    const { data, error } = await supabase
      .from('schools')
      .select(
        'id, name, location_city, location_state, program_type, program_length_months, ' +
          'tuition_total, gpa_requirement, icu_experience_months, format, ' +
          'application_opens_month, prerequisites_required, prerequisites_not_required'
      )
      .order('name')
    if (error) {
      console.error('Schools SSR fetch failed:', error.message)
      return []
    }
    return data ?? []
  } catch (error) {
    // Falling through to an empty array lets the client fetch as a fallback
    // rather than failing the whole page.
    console.error('Schools SSR fetch threw:', error)
    return []
  }
}

export default async function SchoolsPage() {
  const schools = await getSchools()
  return <SchoolsClient initialSchools={schools} />
}
