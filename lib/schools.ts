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
