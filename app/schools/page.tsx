import { cache } from 'react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'
import SchoolsClient from './SchoolsClient'
import { eligibleStates } from '@/lib/states'

const SITE = 'https://www.crnaprephub.com'

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
const getSchools = cache(async () => {
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
          'application_opens_month'
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
})

export async function generateMetadata(): Promise<Metadata> {
  // Shares the page's cached fetch. Falls back to the known count rather than
  // rendering "0" if the fetch ever fails.
  const count = (await getSchools()).length || 135

  const title = `CRNA Schools: Compare ${count} Nurse Anesthesia Programs | CRNA Prep Hub`
  const description =
    `Compare ${count} CRNA schools by GPA requirement, tuition, program length, ` +
    'format, ICU experience and application opening dates. Find the programs that fit.'
  // Self-referencing and parameter-free, so client-side filter states all
  // consolidate onto this one canonical directory URL.
  const url = `${SITE}/schools`

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: 'CRNA Prep Hub', type: 'website' },
    twitter: { card: 'summary', title, description },
  }
}

export default async function SchoolsPage() {
  const schools = await getSchools()
  // Server-rendered so the state pages are crawlable from the directory hub.
  // Only states that actually have a landing page are listed — a link to a
  // state with one or two programs would 404.
  const states = eligibleStates(schools as any)

  return (
    <>
      <SchoolsClient initialSchools={schools} />
      {states.length > 0 && (
        <section className="border-t border-white/10 bg-[#0B1220] px-4 py-12 sm:px-6">
          <div className="mx-auto w-full max-w-5xl">
            <h2 className="mb-2 text-xl font-bold tracking-tight text-white sm:text-2xl">
              Browse CRNA schools by state
            </h2>
            <p className="mb-6 text-[14px] text-slate-400">
              States with three or more nurse anesthesia programs in the directory.
            </p>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {states.map(({ jurisdiction, schools: stateSchools }) => (
                <li key={jurisdiction.slug}>
                  <Link
                    href={`/schools/state/${jurisdiction.slug}`}
                    className="block rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-[14px] font-semibold text-white transition hover:border-violet-400"
                  >
                    CRNA schools in {jurisdiction.name}
                    <span className="ml-1 font-normal text-slate-400">({stateSchools.length})</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  )
}
