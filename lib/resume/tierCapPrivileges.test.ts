import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * Migration 010, and the property whose absence made it necessary.
 *
 * WHAT WENT WRONG. 007 revoked resume_v2_tier_cap from `public` and from
 * `anon` and stopped. A Supabase project grants EXECUTE on new functions in
 * `public` to anon, authenticated and service_role through ALTER DEFAULT
 * PRIVILEGES, and those are explicit grants to named roles -- so
 * `revoke ... from public`, which touches only the PUBLIC pseudo-role, left
 * `authenticated` holding EXECUTE on a helper documented as callable by
 * nobody. Production confirmed it. 009 could not have closed it either, since
 * CREATE OR REPLACE preserves a function's ACL.
 *
 * WHY THE EXISTING TEST MISSED IT. writeBoundary.test.ts asserts that the
 * helper is never GRANTed and that it is revoked from anon. Both were true.
 * Neither says anything about the role the browser actually carries.
 *
 * So the test below is deliberately not written about resume_v2_tier_cap. It
 * derives the private helpers from the migrations themselves -- a function
 * created by this series and granted to nobody is private by construction --
 * and requires every one of them to name `authenticated` in a revoke. A future
 * helper that repeats the omission fails here without anyone remembering to
 * add a case for it.
 */

const DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url))

/** 000-010 of the resume series, by their own date prefixes. */
const SERIES = /^2026(0910|0911|0912|0917)_(00\d|010)_/

const FILES = readdirSync(DIR).filter((name) => SERIES.test(name) && name.endsWith('.sql')).sort()

/** `--` comments are prose, and this file reasons about statements. */
function codeOf(name: string): string {
  return readFileSync(join(DIR, name), 'utf8').replace(/^\s*--.*$/gm, '')
}

const SERIES_CODE = FILES.map(codeOf).join('\n')

const TEN = '20260917_010_resume_v2_tier_cap_privileges.sql'
const CODE = codeOf(TEN)

// --- the series-wide property ----------------------------------------------

test('the migration series is discovered, 000 through 010', () => {
  assert.ok(FILES.includes(TEN), `010 is missing; found ${FILES.join(', ')}`)
  assert.equal(FILES.length, 11, `expected 000-010, found ${FILES.join(', ')}`)
})

test('every private helper is revoked from authenticated, not only from anon', () => {
  const created = [...SERIES_CODE.matchAll(/create or replace function public\.(\w+)\s*\(/g)]
  const names = [...new Set(created.map((m) => m[1]))]
  assert.ok(names.length >= 11, `expected the V2 function set, found ${names.join(', ')}`)

  const privates: string[] = []
  for (const name of names) {
    const granted = new RegExp(`grant execute on function public\\.${name}\\(`).test(SERIES_CODE)
    if (!granted) privates.push(name)
  }

  // The four documented helpers, derived rather than listed.
  assert.deepEqual(privates.sort(), [
    'enforce_resume_section_v2_boundary',
    'enforce_resume_v2_write_boundary',
    'guard_resume_entitlement_fields',
    'resume_v2_tier_cap',
  ])

  for (const name of privates) {
    for (const role of ['public', 'anon', 'authenticated']) {
      assert.ok(
        new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from ${role};`).test(SERIES_CODE),
        `${name} is never revoked from ${role} anywhere in 000-010`
      )
    }
  }
})

test('the public RPCs stay granted to authenticated', () => {
  for (const name of [
    'create_resume_v2', 'save_resume_v2', 'save_resume_strength_v2',
    'record_ai_usage', 'settle_ai_usage', 'record_resume_import', 'settle_resume_import',
  ]) {
    assert.ok(
      new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated;`).test(SERIES_CODE),
      `${name} lost its grant to authenticated`
    )
  }
})

// --- 010 itself -------------------------------------------------------------

test('010 is transactional', () => {
  assert.ok(/^begin;/m.test(CODE))
  assert.ok(/^commit;/m.test(CODE))
})

test('010 closes the gap on the cap helper for all three roles', () => {
  for (const role of ['authenticated', 'public', 'anon']) {
    assert.ok(
      new RegExp(`revoke all on function public\\.resume_v2_tier_cap\\(text\\) from ${role};`).test(CODE),
      `010 does not revoke the cap helper from ${role}`
    )
  }
})

test('010 leaves service_role alone', () => {
  assert.doesNotMatch(CODE, /revoke[^;]*from service_role/i, 'service_role access is required by design')
  assert.doesNotMatch(CODE, /grant[^;]*to service_role/i, '010 grants nothing')
})

test('010 changes privileges and nothing else', () => {
  // It must not replace the function: 009 owns the body, and CREATE OR REPLACE
  // here would silently re-open the question of what the cap returns.
  assert.doesNotMatch(CODE, /create or replace function/i)
  for (const forbidden of [
    'alter table', 'create table', 'drop table', 'drop column', 'create policy',
    'drop policy', 'create trigger', 'drop trigger', 'create index', 'truncate',
  ]) {
    assert.equal(CODE.toLowerCase().includes(forbidden), false, `010 contains "${forbidden}"`)
  }
  const body = CODE.slice(CODE.indexOf('begin;'), CODE.indexOf('commit;'))
  assert.doesNotMatch(body, /^\s*(insert|update|delete)\b/im, '010 writes no rows')
})

test('010 grants nothing to anyone', () => {
  assert.doesNotMatch(CODE, /^\s*grant\b/im)
})

test('010 verifies itself, read-only, after the commit', () => {
  const after = CODE.slice(CODE.lastIndexOf('commit;'))
  assert.match(after, /has_function_privilege/i, 'confirms who may execute it against the catalog')
  assert.match(after, /enforce_resume_v2_write_boundary/, 'checks the other private helpers too')
  assert.doesNotMatch(after, /^\s*(insert|update|delete|alter|drop|revoke|grant)\b/im,
    'verification must be read-only')
})
