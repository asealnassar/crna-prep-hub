import type { PublicSchool } from '@/lib/schools'

/**
 * Jurisdiction normalisation for state landing pages.
 *
 * `location_state` is not consistent in the database: most rows hold a
 * two-letter abbreviation, but seven hold a full name (Maine, Maryland,
 * Massachusetts, Michigan, Minnesota, Mississippi, Missouri). Every value
 * present in the 135-school directory is mapped here explicitly rather than
 * guessed at, so a URL or heading can never be derived from an unrecognised
 * value. Database values are not modified.
 */
type Jurisdiction = {
  /** Display name used in the H1, title and breadcrumb. */
  name: string
  /** Stable URL slug. */
  slug: string
  /** True for U.S. states. Territories are valid directory data but get no
   *  landing page — "CRNA schools by state" should not list Puerto Rico. */
  isState: boolean
}

const JURISDICTIONS: Record<string, Jurisdiction> = {
  AL: { name: 'Alabama', slug: 'alabama', isState: true },
  AR: { name: 'Arkansas', slug: 'arkansas', isState: true },
  AZ: { name: 'Arizona', slug: 'arizona', isState: true },
  CA: { name: 'California', slug: 'california', isState: true },
  CO: { name: 'Colorado', slug: 'colorado', isState: true },
  CT: { name: 'Connecticut', slug: 'connecticut', isState: true },
  DC: { name: 'Washington, D.C.', slug: 'washington-dc', isState: true },
  FL: { name: 'Florida', slug: 'florida', isState: true },
  GA: { name: 'Georgia', slug: 'georgia', isState: true },
  IA: { name: 'Iowa', slug: 'iowa', isState: true },
  ID: { name: 'Idaho', slug: 'idaho', isState: true },
  IL: { name: 'Illinois', slug: 'illinois', isState: true },
  IN: { name: 'Indiana', slug: 'indiana', isState: true },
  KS: { name: 'Kansas', slug: 'kansas', isState: true },
  KY: { name: 'Kentucky', slug: 'kentucky', isState: true },
  LA: { name: 'Louisiana', slug: 'louisiana', isState: true },
  MAINE: { name: 'Maine', slug: 'maine', isState: true },
  MARYLAND: { name: 'Maryland', slug: 'maryland', isState: true },
  MASSACHUSETTS: { name: 'Massachusetts', slug: 'massachusetts', isState: true },
  MICHIGAN: { name: 'Michigan', slug: 'michigan', isState: true },
  MINNESOTA: { name: 'Minnesota', slug: 'minnesota', isState: true },
  MISSISSIPPI: { name: 'Mississippi', slug: 'mississippi', isState: true },
  MISSOURI: { name: 'Missouri', slug: 'missouri', isState: true },
  NC: { name: 'North Carolina', slug: 'north-carolina', isState: true },
  ND: { name: 'North Dakota', slug: 'north-dakota', isState: true },
  NE: { name: 'Nebraska', slug: 'nebraska', isState: true },
  NJ: { name: 'New Jersey', slug: 'new-jersey', isState: true },
  NM: { name: 'New Mexico', slug: 'new-mexico', isState: true },
  NV: { name: 'Nevada', slug: 'nevada', isState: true },
  NY: { name: 'New York', slug: 'new-york', isState: true },
  OH: { name: 'Ohio', slug: 'ohio', isState: true },
  OK: { name: 'Oklahoma', slug: 'oklahoma', isState: true },
  OR: { name: 'Oregon', slug: 'oregon', isState: true },
  PA: { name: 'Pennsylvania', slug: 'pennsylvania', isState: true },
  // Puerto Rico is a U.S. territory: kept as valid directory data, excluded
  // from the by-state landing pages.
  PR: { name: 'Puerto Rico', slug: 'puerto-rico', isState: false },
  RI: { name: 'Rhode Island', slug: 'rhode-island', isState: true },
  SC: { name: 'South Carolina', slug: 'south-carolina', isState: true },
  SD: { name: 'South Dakota', slug: 'south-dakota', isState: true },
  TN: { name: 'Tennessee', slug: 'tennessee', isState: true },
  TX: { name: 'Texas', slug: 'texas', isState: true },
  UT: { name: 'Utah', slug: 'utah', isState: true },
  VA: { name: 'Virginia', slug: 'virginia', isState: true },
  WA: { name: 'Washington', slug: 'washington', isState: true },
  WI: { name: 'Wisconsin', slug: 'wisconsin', isState: true },
  WV: { name: 'West Virginia', slug: 'west-virginia', isState: true },
}

/** Minimum programs before a state earns an indexable landing page. Below
 *  this a page is a one- or two-row table the school pages already cover. */
export const MIN_PROGRAMS_FOR_STATE_PAGE = 3

export function normalizeJurisdiction(value: unknown): Jurisdiction | null {
  const key = String(value ?? '').trim().toUpperCase()
  return JURISDICTIONS[key] ?? null
}

export type StateGroup = { jurisdiction: Jurisdiction; schools: PublicSchool[] }

/** Every jurisdiction present in the directory, with its schools. */
export function groupBySate(schools: PublicSchool[]): Map<string, StateGroup> {
  const groups = new Map<string, StateGroup>()
  for (const school of schools) {
    const jurisdiction = normalizeJurisdiction(school.location_state)
    if (!jurisdiction) continue
    const existing = groups.get(jurisdiction.slug)
    if (existing) existing.schools.push(school)
    else groups.set(jurisdiction.slug, { jurisdiction, schools: [school] })
  }
  for (const group of groups.values()) {
    group.schools.sort((a, b) => a.name.localeCompare(b.name))
  }
  return groups
}

/** Only U.S. states meeting the threshold, alphabetical by display name. */
export function eligibleStates(schools: PublicSchool[]): StateGroup[] {
  return Array.from(groupBySate(schools).values())
    .filter((g) => g.jurisdiction.isState && g.schools.length >= MIN_PROGRAMS_FOR_STATE_PAGE)
    .sort((a, b) => a.jurisdiction.name.localeCompare(b.jurisdiction.name))
}
