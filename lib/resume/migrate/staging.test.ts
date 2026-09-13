import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  formatStagingChecks, planOwnerRemap, remapOwners, sourceOwners, verifyStagingCopy,
} from './staging.ts'
import type { StagingUser } from './staging.ts'
import { v1Fixtures, RESUME_COUNT } from './fixtures.ts'

/**
 * Staging must be faithful enough to rehearse the migration and useless to
 * anyone who steals it. Both halves are tested; the second one harder.
 */

// The fixture spreads 17 resumes across 16 owners, one of whom holds two.
const TIERS: Record<string, string> = {}
for (let i = 0; i < 16; i++) TIERS[`user-${i}`] = i === 15 ? 'ultimate' : i < 8 ? 'free' : 'premium'
const tierOf = (userId: string) => TIERS[userId] ?? 'free'

const stagingPool = (): StagingUser[] => {
  const users: StagingUser[] = []
  for (let i = 0; i < 8; i++) users.push({ userId: `staging-free-${i}`, tier: 'free' })
  for (let i = 0; i < 7; i++) users.push({ userId: `staging-premium-${i}`, tier: 'premium' })
  users.push({ userId: 'staging-ultimate-0', tier: 'ultimate' })
  return users
}

function copied() {
  const { resumes, sections } = v1Fixtures()
  const owners = sourceOwners(resumes, tierOf)
  const plan = planOwnerRemap(owners, stagingPool())
  const copy = remapOwners(resumes, sections, plan.mapping)
  return { source: { resumes, sections }, copy, plan, owners }
}

// --- fidelity --------------------------------------------------------------

test('the copy carries every resume and every section', () => {
  const { source, copy } = copied()
  assert.equal(copy.resumes.length, RESUME_COUNT)
  assert.equal(copy.sections.length, source.sections.length)
})

test('the owner who holds two resumes still holds two in staging', () => {
  const { source, copy } = copied()
  const group = (rows: typeof copy.resumes) => {
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1)
    return [...counts.values()].sort()
  }
  assert.deepEqual(group(copy.resumes), group(source.resumes))
  assert.ok(group(copy.resumes).includes(2), 'the two-resume owner is the case worth keeping')
})

test('each owner keeps their subscription tier', () => {
  const { plan, owners } = copied()
  const stagingTier = new Map(stagingPool().map((u) => [u.userId, u.tier]))
  for (const owner of owners) {
    const target = plan.mapping.get(owner.userId)
    assert.ok(target, `owner ${owner.userId} was not mapped`)
    assert.equal(
      stagingTier.get(target), owner.tier,
      `owner ${owner.userId} (${owner.tier}) landed on a ${stagingTier.get(target)} account`
    )
  }
})

test('the owner holding two resumes is not mapped onto a Free account', () => {
  // Free is capped at one resume. Mapping a two-resume owner there would
  // manufacture an over-cap user that production does not have.
  const { plan, owners } = copied()
  const multi = owners.filter((o) => o.resumeCount > 1)
  assert.ok(multi.length > 0, 'the fixture should contain a multi-resume owner')
  const stagingTier = new Map(stagingPool().map((u) => [u.userId, u.tier]))
  for (const owner of multi) {
    assert.notEqual(stagingTier.get(plan.mapping.get(owner.userId)!), 'free')
  }
})

test('nothing but the owner column changes', () => {
  const { source, copy } = copied()
  const bySourceId = new Map(source.resumes.map((r) => [r.id, r]))
  for (const row of copy.resumes) {
    const original = bySourceId.get(row.id)!
    const { user_id: _a, ...copyRest } = row
    const { user_id: _b, ...sourceRest } = original
    assert.deepEqual(copyRest, sourceRest, `resume ${row.id} was altered beyond its owner`)
  }
})

test('section_data is passed through, not rebuilt', () => {
  const { source, copy } = copied()
  assert.equal(copy.sections, source.sections, 'sections should be the same array, untouched')
})

test('the malformed values that make the rehearsal worth running survive', () => {
  const { copy } = copied()
  const json = JSON.stringify(copy.sections)
  assert.ok(json.includes('""'), 'the blank bullet strings must survive the copy')
  const long = copy.sections.some(
    (s) => JSON.stringify(s.section_data).length > 4_000
  )
  assert.ok(long, 'the 4,214-character summary must survive the copy')
})

// --- safety ----------------------------------------------------------------

test('no production owner id appears anywhere in the copy', () => {
  const { source, copy, plan } = copied()
  const production = new Set(source.resumes.map((r) => r.user_id))
  assert.ok(production.size > 0)
  for (const row of copy.resumes) {
    assert.equal(production.has(row.user_id), false, `${row.id} still names a production owner`)
  }
  assert.equal(plan.mapping.size, production.size, 'every owner must be remapped, not most')
})

test('the mapping is one-to-one, so two owners never merge', () => {
  const { plan } = copied()
  assert.equal(new Set(plan.mapping.values()).size, plan.mapping.size)
})

test('a copy it cannot fully remap is refused rather than partially made', () => {
  const { resumes, sections } = v1Fixtures()
  const owners = sourceOwners(resumes, tierOf)
  const short = planOwnerRemap(owners, [{ userId: 'staging-free-0', tier: 'free' }])

  assert.equal(short.ok, false)
  assert.ok(short.unmatched.length > 0, 'the shortfall must be reported')
  assert.throws(
    () => remapOwners(resumes, sections, short.mapping),
    /no staging user for owner/,
    'a partial copy must throw, not silently drop resumes'
  )
})

test('the verifier catches a leaked production owner', () => {
  const { source, copy, plan } = copied()
  const tampered = {
    resumes: [{ ...copy.resumes[0], user_id: source.resumes[0].user_id }, ...copy.resumes.slice(1)],
    sections: copy.sections,
  }
  const result = verifyStagingCopy({
    source, copy: tampered, mapping: plan.mapping,
    expectedResumes: RESUME_COUNT, expectedSections: source.sections.length,
  })
  assert.equal(result.passed, false)
  const check = result.checks.find((c) => c.name === 'no-production-owner-ids')
  assert.equal(check?.passed, false)
})

test('the verifier catches altered resume content', () => {
  const { source, copy, plan } = copied()
  const tampered = {
    resumes: [{ ...copy.resumes[0], title: 'rewritten' }, ...copy.resumes.slice(1)],
    sections: copy.sections,
  }
  const result = verifyStagingCopy({
    source, copy: tampered, mapping: plan.mapping,
    expectedResumes: RESUME_COUNT, expectedSections: source.sections.length,
  })
  assert.equal(result.checks.find((c) => c.name === 'only-the-owner-column-changed')?.passed, false)
})

test('the verifier catches a copied auth credential', () => {
  const { source, copy, plan } = copied()
  const tampered = {
    resumes: copy.resumes.map((r) => ({ ...r, encrypted_password: '$2a$10$abc' })),
    sections: copy.sections,
  }
  const result = verifyStagingCopy({
    source, copy: tampered, mapping: plan.mapping,
    expectedResumes: RESUME_COUNT, expectedSections: source.sections.length,
  })
  const check = result.checks.find((c) => c.name === 'no-auth-credentials')
  assert.equal(check?.passed, false)
  assert.match(check!.detail, /encrypted_password/)
})

test('the verifier catches a credential nested inside section data', () => {
  const { source, copy, plan } = copied()
  const tampered = {
    resumes: copy.resumes,
    sections: [
      { ...copy.sections[0], section_data: { personal: { refresh_token: 'abc' } } },
      ...copy.sections.slice(1),
    ],
  }
  const result = verifyStagingCopy({
    source, copy: tampered, mapping: plan.mapping,
    expectedResumes: RESUME_COUNT, expectedSections: source.sections.length,
  })
  assert.equal(result.checks.find((c) => c.name === 'no-auth-credentials')?.passed, false)
})

test('a faithful copy passes every check', () => {
  const { source, copy, plan } = copied()
  const result = verifyStagingCopy({
    source, copy, mapping: plan.mapping,
    expectedResumes: RESUME_COUNT, expectedSections: source.sections.length,
  })
  assert.equal(result.passed, true, formatStagingChecks(result))
  assert.ok(result.checks.length >= 8, 'the check list should not have shrunk')
})

test('the formatted report names every check and its verdict', () => {
  const { source, copy, plan } = copied()
  const text = formatStagingChecks(verifyStagingCopy({
    source, copy, mapping: plan.mapping,
    expectedResumes: RESUME_COUNT, expectedSections: source.sections.length,
  }))
  for (const name of ['no-production-owner-ids', 'owner-grouping-preserved', 'no-auth-credentials']) {
    assert.ok(text.includes(name), `the report omits ${name}`)
  }
  assert.ok(text.includes('All checks passed.'))
})

test('the module never reaches for an auth table or a credential column', () => {
  const source = readFileSync(fileURLToPath(new URL('./staging.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  // CREDENTIAL_KEYS names these deliberately, to detect them. Everything after
  // that list must be free of auth access.
  const afterList = source.slice(source.indexOf('function keysDeep'))
  for (const forbidden of ['auth.users', 'encrypted_password', 'refresh_token', 'createClient']) {
    assert.equal(afterList.includes(forbidden), false, `staging.ts touches "${forbidden}"`)
  }
})
