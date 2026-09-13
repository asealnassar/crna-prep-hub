/**
 * Building a staging copy of the V1 data WITHOUT copying anyone's identity.
 *
 * The migration has to be rehearsed against the real 17 resumes, because the
 * defects worth finding -- the 41 `['']` bullet arrays, the 22% unparseable
 * dates, the 4,214-character summary, whatever legacy keys nobody remembers
 * writing -- are properties of the real data and of nothing else. A sanitised
 * copy would rehearse a migration of data that does not exist.
 *
 * What must NOT come across is identity. Restoring production `auth.users`
 * into a second project would copy password hashes, refresh tokens and live
 * sessions into an environment with weaker access control and a wider set of
 * people holding its keys, to test a migration that never reads any of them.
 * The writer takes ownership from `resumes.user_id` -- a bare uuid -- so the
 * rehearsal needs owner STRUCTURE, not owner IDENTITY.
 *
 * So: staging gets its own auth users, and this module rewrites the owner
 * column onto them. Everything the migration actually reads is preserved
 * exactly:
 *
 *   - all 17 resume rows and all 119 section rows, section_data byte-identical
 *   - the owner GROUPING, including the one owner who holds two resumes
 *   - each owner's subscription tier, so the entitlement paths are exercised
 *   - every id relationship: sections still point at their own resume
 *
 * and the only thing that changes is which uuid sits in user_id.
 *
 * WHAT THIS DOES NOT CLAIM. Resume CONTENT still contains real applicants'
 * names, emails and phone numbers, because that is the data being migrated and
 * removing it would defeat the rehearsal. Staging therefore holds real personal
 * data and must be access-controlled accordingly; what it does not hold is
 * anything anyone could authenticate with.
 */

import type { V1ResumeRow, V1SectionRow } from './mapV1.ts'

/** A user created in the staging project, not copied from production. */
export interface StagingUser {
  readonly userId: string
  readonly tier: string
}

/** What the production side contributes: an owner and the tier they hold. */
export interface SourceOwner {
  readonly userId: string
  readonly tier: string
  readonly resumeCount: number
}

export interface RemapPlan {
  /** production user_id -> staging user_id. */
  readonly mapping: ReadonlyMap<string, string>
  readonly owners: readonly SourceOwner[]
  readonly unmatched: readonly SourceOwner[]
  readonly ok: boolean
}

/** The owners in a set of V1 rows, with how many resumes each holds. */
export function sourceOwners(
  resumes: readonly V1ResumeRow[],
  tierOf: (userId: string) => string
): SourceOwner[] {
  const counts = new Map<string, number>()
  for (const row of resumes) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1)
  return [...counts.entries()]
    .map(([userId, resumeCount]) => ({ userId, tier: tierOf(userId), resumeCount }))
    // Most resumes first, so the owner holding two is matched before the
    // single-resume owners compete for the same staging accounts.
    .sort((a, b) => b.resumeCount - a.resumeCount || a.userId.localeCompare(b.userId))
}

/**
 * Pairs each production owner with a staging user of the SAME TIER.
 *
 * Tier matching is not cosmetic. Free is capped at 1 resume and Premium at 3;
 * an owner holding two resumes mapped onto a Free staging account would produce
 * a staging user over their own cap, which is a state the app can reach after
 * migration and should be tested deliberately, not created by accident.
 */
export function planOwnerRemap(
  owners: readonly SourceOwner[],
  stagingUsers: readonly StagingUser[]
): RemapPlan {
  const pool = new Map<string, string[]>()
  for (const user of stagingUsers) {
    const list = pool.get(user.tier) ?? []
    list.push(user.userId)
    pool.set(user.tier, list)
  }
  for (const list of pool.values()) list.sort()

  const mapping = new Map<string, string>()
  const unmatched: SourceOwner[] = []

  for (const owner of owners) {
    const available = pool.get(owner.tier)
    const next = available?.shift()
    if (next === undefined) { unmatched.push(owner); continue }
    mapping.set(owner.userId, next)
  }

  return { mapping, owners, unmatched, ok: unmatched.length === 0 }
}

export interface RemappedData {
  readonly resumes: readonly V1ResumeRow[]
  readonly sections: readonly V1SectionRow[]
}

/**
 * Rewrites owner ids and NOTHING else.
 *
 * section_data is passed through by reference: not copied, not normalised, not
 * re-serialised. A migration rehearsal is worthless if the fixture-building
 * step quietly repaired the data first.
 */
export function remapOwners(
  resumes: readonly V1ResumeRow[],
  sections: readonly V1SectionRow[],
  mapping: ReadonlyMap<string, string>
): RemappedData {
  const remapped = resumes.map((row) => {
    const stagingId = mapping.get(row.user_id)
    if (stagingId === undefined) {
      throw new Error(`no staging user for owner ${row.user_id}; refusing a partial copy`)
    }
    return { ...row, user_id: stagingId }
  })
  // Sections carry no owner column -- they belong to a resume, and the resume
  // carries the owner. They are passed through untouched, which is also the
  // proof that no content is rewritten by this step.
  return { resumes: remapped, sections }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface StagingCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

/** Fields that would mean an auth record had been copied. */
const CREDENTIAL_KEYS = [
  'encrypted_password', 'password', 'password_hash', 'refresh_token',
  'access_token', 'confirmation_token', 'recovery_token', 'email_change_token',
  'session_id', 'provider_refresh_token', 'provider_token', 'reauthentication_token',
  'phone_change_token', 'banned_until', 'instance_id',
]

function keysDeep(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) keysDeep(v, out); return }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out) }
  }
}

/**
 * The checks that decide whether a staging copy is both faithful and safe.
 * Every one must pass before the copy is loaded.
 */
export function verifyStagingCopy(input: {
  readonly source: RemappedData
  readonly copy: RemappedData
  readonly mapping: ReadonlyMap<string, string>
  readonly expectedResumes: number
  readonly expectedSections: number
}): { readonly checks: readonly StagingCheck[]; readonly passed: boolean } {
  const { source, copy, mapping } = input
  const checks: StagingCheck[] = []
  const check = (name: string, passed: boolean, detail: string) =>
    checks.push({ name, passed, detail })

  check(
    'resume-count',
    copy.resumes.length === input.expectedResumes,
    `${copy.resumes.length} of ${input.expectedResumes}`
  )
  check(
    'section-count',
    copy.sections.length === input.expectedSections,
    `${copy.sections.length} of ${input.expectedSections}`
  )

  // No production owner id survives anywhere in the copy.
  const productionIds = new Set(mapping.keys())
  const leaked = copy.resumes.filter((r) => productionIds.has(r.user_id)).map((r) => r.id)
  check(
    'no-production-owner-ids',
    leaked.length === 0,
    leaked.length === 0 ? 'none' : `${leaked.length} rows still carry a production owner`
  )

  // Owner GROUPING is preserved: the multiset of group sizes must be identical,
  // so the owner with two resumes still has two.
  const sizes = (rows: readonly V1ResumeRow[]) => {
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1)
    return [...counts.values()].sort((a, b) => a - b).join(',')
  }
  const sourceSizes = sizes(source.resumes)
  const copySizes = sizes(copy.resumes)
  check('owner-grouping-preserved', sourceSizes === copySizes, `${sourceSizes} -> ${copySizes}`)

  // The mapping is one-to-one. Two owners collapsing onto one staging user
  // would change the grouping and could put a user over their resume cap.
  const targets = new Set(mapping.values())
  check(
    'mapping-is-one-to-one',
    targets.size === mapping.size,
    `${mapping.size} owners -> ${targets.size} staging users`
  )

  // Content is untouched. Compared by id so ordering cannot mask a difference.
  const sourceById = new Map(source.resumes.map((r) => [r.id, r]))
  const changed: string[] = []
  for (const row of copy.resumes) {
    const original = sourceById.get(row.id)
    if (!original) { changed.push(`${row.id} (not in source)`); continue }
    const { user_id: _copyOwner, ...copyRest } = row
    const { user_id: _sourceOwner, ...sourceRest } = original
    if (JSON.stringify(copyRest) !== JSON.stringify(sourceRest)) changed.push(row.id)
  }
  check(
    'only-the-owner-column-changed',
    changed.length === 0,
    changed.length === 0 ? 'every other column identical' : changed.join(', ')
  )

  const sourceSections = JSON.stringify(source.sections)
  check(
    'section-data-byte-identical',
    JSON.stringify(copy.sections) === sourceSections,
    'section rows are passed through untouched'
  )

  // Nothing that could be authenticated with came along.
  const keys = new Set<string>()
  keysDeep(copy.resumes, keys)
  keysDeep(copy.sections, keys)
  const credentials = CREDENTIAL_KEYS.filter((k) => keys.has(k))
  check(
    'no-auth-credentials',
    credentials.length === 0,
    credentials.length === 0 ? 'none' : `found ${credentials.join(', ')}`
  )

  return { checks, passed: checks.every((c) => c.passed) }
}

/** Human-readable, for the operator running the copy. */
export function formatStagingChecks(result: {
  readonly checks: readonly StagingCheck[]
  readonly passed: boolean
}): string {
  const lines = result.checks.map(
    (c) => `  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name.padEnd(32)} ${c.detail}`
  )
  return [
    'STAGING COPY VERIFICATION',
    ...lines,
    '',
    result.passed ? 'All checks passed.' : 'FAILED -- do not load this copy.',
  ].join('\n')
}
