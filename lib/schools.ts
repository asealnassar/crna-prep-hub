import { createClient } from '@supabase/supabase-js'

/**
 * Columns that are free/public on the directory. The four excluded fields —
 * application_deadline, gre_requirement, application_method, website_url — are
 * paid and are only blurred client-side, so they must never be server-rendered.
 */
export const PUBLIC_SCHOOL_COLUMNS = [
  'id',
  'name',
  'location_city',
  'location_state',
  'program_type',
  'program_length_months',
  'tuition_total',
  'tuition_yearly',
  'gpa_requirement',
  'icu_experience_months',
  'accepts_new_grad_icu',
  'format',
  'front_loaded',
  'application_opens_month',
  'prerequisites_required',
  'prerequisites_not_required',
].join(', ')

export interface PublicSchool {
  id: string
  name: string
  location_city: string | null
  location_state: string | null
  program_type: string | null
  program_length_months: number | null
  tuition_total: number | null
  tuition_yearly: number | null
  gpa_requirement: number | null
  icu_experience_months: number | null
  accepts_new_grad_icu: boolean | null
  format: string | null
  front_loaded: boolean | null
  application_opens_month: string | null
  prerequisites_required: string | null
  prerequisites_not_required: string | null
}

/** Deterministic, ID-free slug. "St. Mary's & Co." -> "st-marys-and-co" */
export function slugifySchoolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Assigns each school a unique slug. Names are unique in the current data, but
 * if two ever collide the later one (by name, then id — both stable) gets its
 * state appended, so a duplicate can never make a page unreachable.
 */
export function buildSlugMap(schools: PublicSchool[]): Map<string, PublicSchool> {
  const byBase = new Map<string, PublicSchool[]>()
  for (const school of schools) {
    const base = slugifySchoolName(school.name)
    if (!base) continue
    const bucket = byBase.get(base)
    if (bucket) bucket.push(school)
    else byBase.set(base, [school])
  }

  const map = new Map<string, PublicSchool>()
  for (const [base, bucket] of byBase) {
    if (bucket.length === 1) {
      map.set(base, bucket[0])
      continue
    }
    const ordered = [...bucket].sort((a, b) =>
      a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    )
    ordered.forEach((school, index) => {
      if (index === 0) {
        map.set(base, school)
        return
      }
      const state = (school.location_state || '').toLowerCase()
      let candidate = state ? `${base}-${state}` : `${base}-${index + 1}`
      let n = 2
      while (map.has(candidate)) candidate = `${base}-${state || 'x'}-${n++}`
      map.set(candidate, school)
    })
  }
  return map
}

/**
 * Slugs a school used to be reachable at, and still must be.
 *
 * ---------------------------------------------------------------------------
 * A NAME CORRECTION RETIRES A PUBLIC URL
 * ---------------------------------------------------------------------------
 * The slug is derived from `schools.name`, and `/schools/{slug}` is published
 * in the sitemap. Correcting "Ceder Crest" to its real name therefore moves an
 * indexed URL: `ceder-crest` becomes `cedar-crest-college`, and without this
 * map the old address would 404 for every search result and every link anyone
 * has saved.
 *
 * SAFE BEFORE, DURING AND AFTER THE RENAME, which is the property that matters
 * -- the correction is applied in the Supabase editor, not in a deploy, so
 * there is no moment when the two can be swapped together:
 *
 *   before  `ceder-crest` is the school's real slug, so the live map wins and
 *           this alias is never consulted;
 *   after   the live map no longer holds it, the alias resolves to the new
 *           slug, and the page redirects permanently.
 *
 * NOT A RENAME TABLE. It maps an old slug to a CURRENT one and nothing else:
 * no names, no ids, no display text. The school's name has exactly one source,
 * which is the database.
 *
 * ONE ENTRY. Saint Mary's is deliberately absent -- slugifySchoolName strips
 * apostrophes, so `saint-marys-university-of-minnesota` is unchanged by that
 * correction and nothing retires.
 */
export const RETIRED_SCHOOL_SLUGS: Readonly<Record<string, string>> = {
  'ceder-crest': 'cedar-crest-college',
}

/**
 * Where a retired slug should send a reader, or null.
 *
 * NULL WHILE THE OLD SLUG IS STILL LIVE. `live` is the slug map built from the
 * database as it is right now; if it still contains the requested slug then
 * the rename has not happened and the page must be served, not redirected.
 * Only once the live map has lost it, and gained the destination, is a
 * redirect the truth.
 */
export function retiredSlugDestination(
  slug: string,
  live: ReadonlyMap<string, unknown>,
): string | null {
  if (live.has(slug)) return null
  const destination = RETIRED_SCHOOL_SLUGS[slug]
  if (destination === undefined) return null
  return live.has(destination) ? destination : null
}

/** Reverse lookup: the slug a given school should be linked at. */
export function slugForSchool(school: PublicSchool, map: Map<string, PublicSchool>): string {
  for (const [slug, candidate] of map) {
    if (candidate.id === school.id) return slug
  }
  return slugifySchoolName(school.name)
}

function serverClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}

export async function getPublicSchools(): Promise<PublicSchool[]> {
  try {
    const { data, error } = await serverClient()
      .from('schools')
      .select(PUBLIC_SCHOOL_COLUMNS)
      .order('name')
    if (error) {
      console.error('getPublicSchools failed:', error.message)
      return []
    }
    return (data ?? []) as unknown as PublicSchool[]
  } catch (error) {
    console.error('getPublicSchools threw:', error)
    return []
  }
}

export async function getSchoolBySlug(slug: string): Promise<PublicSchool | null> {
  const schools = await getPublicSchools()
  return buildSlugMap(schools).get(slug) ?? null
}
