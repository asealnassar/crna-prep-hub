import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * Migration 007, the V2 write boundary, checked against the file rather than
 * remembered. These run with no database: they are the part of the acceptance
 * matrix that can be proved statically, and they exist because the behavioural
 * half (integration.test.ts) can only run against a staging project.
 *
 * The property under test throughout is the one the earlier design got wrong:
 * TIER RULES must not be gated on the RPC marker, because the RPCs are granted
 * to `authenticated` and can be called directly.
 */

const SQL = readFileSync(
  fileURLToPath(new URL('../../supabase/migrations/20260912_007_resume_v2_write_boundary.sql', import.meta.url)),
  'utf8'
)
/** `--` comments and COMMENT ON literals removed: both are prose. */
const CODE = SQL.replace(/^\s*--.*$/gm, '').replace(/comment on [\s\S]*?;/g, '')

function fn(name: string): string {
  const start = CODE.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} is missing from 007`)
  const after = CODE.slice(start)
  const end = after.indexOf('$fn$;')
  assert.notEqual(end, -1, `${name} has no terminator`)
  return after.slice(0, end)
}

// --- shape ------------------------------------------------------------------

test('007 is transactional and destroys nothing', () => {
  assert.ok(/^begin;/m.test(CODE))
  assert.ok(/^commit;/m.test(CODE))
  for (const destructive of ['drop table', 'drop column', 'truncate', 'delete from public.resumes']) {
    assert.equal(CODE.toLowerCase().includes(destructive), false, `007 contains "${destructive}"`)
  }
  // `drop trigger if exists` immediately before each create is what makes the
  // migration rerunnable; it is the only drop that should appear.
  const drops = [...CODE.matchAll(/^drop .*/gm)].map((m) => m[0])
  assert.equal(drops.length, 2, `unexpected drops: ${drops.join(' | ')}`)
  for (const drop of drops) assert.match(drop, /^drop trigger if exists/)
})

test('both boundaries are BEFORE row triggers covering every write verb', () => {
  for (const table of ['public.resumes', 'public.resume_sections']) {
    const pattern = new RegExp(
      `create trigger \\w+\\s+before insert or update or delete on ${table.replace('.', '\\.')}\\s+for each row`
    )
    assert.ok(pattern.test(CODE), `${table} has no BEFORE-row trigger over all three verbs`)
  }
})

test('the trigger functions are DEFINER with a pinned empty search_path', () => {
  for (const name of ['enforce_resume_v2_write_boundary', 'enforce_resume_section_v2_boundary']) {
    const body = fn(name)
    assert.ok(body.includes('security definer'), `${name} is not SECURITY DEFINER`)
    assert.ok(body.includes("set search_path = ''"), `${name} has no pinned search_path`)
    // Every table reference must be schema-qualified, since search_path is empty.
    for (const bare of [' from resumes', ' from user_profiles', ' from resume_sections']) {
      assert.equal(body.includes(bare), false, `${name} has an unqualified reference:${bare}`)
    }
  }
})

test('the trigger functions and the cap helper are executable by nobody', () => {
  for (const name of [
    'enforce_resume_v2_write_boundary', 'enforce_resume_section_v2_boundary', 'resume_v2_tier_cap',
  ]) {
    assert.equal(
      new RegExp(`grant execute on function public\\.${name}`).test(CODE), false,
      `${name} is granted to someone`
    )
    assert.ok(
      new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from anon;`).test(CODE),
      `${name} is not revoked from anon`
    )
  }
})

test('the three RPCs stay SECURITY INVOKER, so RLS is still underneath them', () => {
  for (const name of ['create_resume_v2', 'save_resume_v2', 'save_resume_strength_v2']) {
    const body = fn(name)
    assert.ok(body.includes('security invoker'), `${name} was turned into a DEFINER`)
    assert.equal(body.includes('security definer'), false)
    assert.ok(body.includes("set search_path = ''"))
  }
})

// --- the caps ---------------------------------------------------------------

test('the tier caps are exactly the locked numbers, and default to Free', () => {
  const cap = fn('resume_v2_tier_cap')
  assert.match(cap, /when 'ultimate' then null/)
  assert.match(cap, /when 'premium'\s+then 3/)
  assert.match(cap, /else 1/)
  assert.ok(cap.includes('lower(coalesce(p_tier'), 'an unknown or null tier must fall through to Free')
})

// --- what the marker may and may not do -------------------------------------

const BOUNDARY = fn('enforce_resume_v2_write_boundary')

/**
 * The two branches, split on a CODE landmark rather than a comment banner.
 * Slicing on the `---- UPDATE` banner silently produced a whole-function slice,
 * because this file strips `--` comments before it looks at anything.
 */
const UPDATE_BRANCH_STARTS_AT = BOUNDARY.indexOf("if new.status = 'complete' and coalesce(old.status")
assert.notEqual(UPDATE_BRANCH_STARTS_AT, -1, 'the UPDATE branch landmark moved')
const INSERT_BRANCH = BOUNDARY.slice(
  BOUNDARY.indexOf("if tg_op = 'INSERT' then"), UPDATE_BRANCH_STARTS_AT
)
const UPDATE_BRANCH = BOUNDARY.slice(UPDATE_BRANCH_STARTS_AT)

test('the creation cap is NOT gated on the RPC marker', () => {
  // The whole point. create_resume_v2 is granted to `authenticated`, so a user
  // can call it directly; a cap that only applied to unmarked writes would be
  // no cap at all.
  const capCheck = INSERT_BRANCH.slice(INSERT_BRANCH.indexOf('v_cap is not null'))
  assert.ok(capCheck.includes('count(*)'), 'the cap check is missing')
  assert.ok(capCheck.includes('raise exception'), 'the cap check does not refuse')
  assert.equal(
    capCheck.includes('v_marked'), false,
    'the creation cap must not consult the RPC marker'
  )
})

test('the finalization rule is NOT gated on the RPC marker, on insert or update', () => {
  const finalizeChecks = [...BOUNDARY.matchAll(/if new\.status = 'complete'[\s\S]*?end if;/g)]
  assert.equal(finalizeChecks.length, 2, 'expected a finalize check on both INSERT and UPDATE')
  for (const [check] of finalizeChecks) {
    assert.ok(check.includes('raise exception'), 'a finalize check does not refuse')
    assert.equal(
      check.includes('v_marked'), false,
      'the finalization rule must not consult the RPC marker'
    )
  }
})

test('complete -> draft stays available to every tier', () => {
  assert.ok(
    UPDATE_BRANCH.includes("coalesce(old.status, 'draft') <> 'complete'"),
    'only the transition INTO complete may be gated'
  )
})

test('the marker gates system fields and nothing more', () => {
  // Every use of the marker must be a refusal of a direct write, never a
  // relaxation of a tier rule.
  const uses = [...BOUNDARY.matchAll(/if not v_marked then[\s\S]*?end if;/g)]
  assert.ok(uses.length >= 2, 'expected the marker to guard both insert and update')
  for (const [use] of uses) {
    assert.ok(use.includes('raise exception'), 'a marker branch must refuse, not permit')
    for (const rule of ['count(*)', 'v_cap', 'v_tier']) {
      assert.equal(use.includes(rule), false, `a marker branch consults "${rule}"`)
    }
  }
})

test('a session-less caller is exempt, and that is the only exemption', () => {
  assert.ok(
    BOUNDARY.includes('if v_user is null then'),
    'the offline migration writer needs the service-role exemption'
  )
  // There must be no other way to skip the checks -- no GUC, no role name, no
  // header, no allowlist.
  for (const escape of ['current_user', 'session_user', "'service_role'", 'pg_has_role']) {
    assert.equal(BOUNDARY.includes(escape), false, `an alternate exemption via ${escape}`)
  }
})

test('identity and generation cannot be rewritten by any path', () => {
  for (const guard of [
    'new.id <> old.id or new.user_id <> old.user_id',
    'new.schema_version <> old.schema_version',
  ]) {
    assert.ok(BOUNDARY.includes(guard), `missing guard: ${guard}`)
  }
})

test('V1 rows pass through the boundary untouched', () => {
  assert.ok(
    BOUNDARY.includes('coalesce(new.schema_version, 1) <> 2'),
    'V1 rows must be returned before any V2 rule runs'
  )
  const sections = fn('enforce_resume_section_v2_boundary')
  assert.ok(sections.includes('v_version = 2'), 'only V2 sections are constrained')
})

test('deleting a V2 resume still cascades to its sections', () => {
  const sections = fn('enforce_resume_section_v2_boundary')
  assert.ok(
    sections.includes('if v_version is null then'),
    'without the parent-missing branch the cascade is refused and V2 resumes become undeletable'
  )
})

// --- what each RPC is allowed to mutate -------------------------------------

test('create_resume_v2 forces status to draft rather than taking it from the payload', () => {
  const create = fn('create_resume_v2')
  const insert = create.slice(create.indexOf('insert into public.resumes'), create.indexOf('insert into public.resume_sections'))
  assert.ok(insert.includes("'draft'"), 'status is not forced')
  assert.equal(
    insert.includes("p_resume->>'status'"), false,
    'an already-complete resume could be created on a Free plan'
  )
})

test('save_resume_v2 cannot write the strength columns', () => {
  const save = fn('save_resume_v2')
  const update = save.slice(save.indexOf('update public.resumes'), save.indexOf('if not found'))
  for (const column of ['strength_score', 'strength_computed_at', 'strength_revision']) {
    assert.equal(update.includes(column), false, `an ordinary save still carries ${column}`)
  }
  assert.ok(update.includes('revision    = p_expected_revision + 1'), 'CAS still moves the revision')
})

test('save_resume_v2 names the owner explicitly, not only through RLS', () => {
  const save = fn('save_resume_v2')
  assert.match(save, /v_user\s+uuid\s*:=\s*auth\.uid\(\)/, 'the caller is not identified')
  assert.ok(save.includes("reason', 'not-authenticated'"), 'a session-less call is not refused')
  assert.equal(
    [...save.matchAll(/r\.user_id = v_user/g)].length, 2,
    'both the compare-and-swap and the diagnostic lookup must be owner-scoped'
  )
})

test('every RPC that sets the marker authenticates first', () => {
  for (const name of ['create_resume_v2', 'save_resume_v2', 'save_resume_strength_v2']) {
    const body = fn(name)
    const auth = body.indexOf('if v_user is null then')
    const marker = body.indexOf("set_config('app.resume_v2_rpc'")
    assert.notEqual(marker, -1, `${name} does not set the marker`)
    assert.notEqual(auth, -1, `${name} has no session guard`)
    assert.ok(auth < marker, `${name} sets the marker before checking for a session`)
  }
})

test('the marker is transaction-local everywhere it is set', () => {
  const sets = [...CODE.matchAll(/set_config\('app\.resume_v2_rpc',\s*'1',\s*(\w+)\)/g)]
  assert.equal(sets.length, 3, 'expected exactly three functions to set the marker')
  for (const [, isLocal] of sets) {
    assert.equal(isLocal, 'true', 'a session-wide marker would outlive its transaction')
  }
})

test('save_resume_strength_v2 is owner-scoped, V2-only and range-checked', () => {
  const body = fn('save_resume_strength_v2')
  assert.ok(body.includes('r.user_id = v_user'))
  assert.ok(body.includes('r.schema_version = 2'))
  assert.ok(body.includes('p_score < 0 or p_score > 100'))
})

test('the RPCs turn a boundary refusal into a result the route can map', () => {
  for (const name of ['create_resume_v2', 'save_resume_v2']) {
    const body = fn(name)
    assert.ok(
      body.includes('when insufficient_privilege then'),
      `${name} lets the trigger's refusal surface as a 500`
    )
    assert.ok(body.includes("'not-permitted'"))
  }
})

test('only the three RPCs are executable by authenticated', () => {
  const grants = [...CODE.matchAll(/grant execute on function public\.(\w+)/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(grants)].sort(),
    ['create_resume_v2', 'save_resume_strength_v2', 'save_resume_v2']
  )
  for (const grant of [...CODE.matchAll(/^grant execute on function [^;]*;/gm)].map((m) => m[0])) {
    assert.ok(grant.includes('to authenticated'), `unexpected grantee: ${grant}`)
    assert.equal(grant.includes('anon'), false)
  }
})

// --- 002 and 003 are untouched ---------------------------------------------

test('the approved migrations 002 and 003 are not modified by this work', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url)
  for (const file of ['20260910_002_resume_v2_save_rpc.sql', '20260910_003_resume_v2_create_rpc.sql']) {
    const text = readFileSync(fileURLToPath(new URL(file, dir)), 'utf8')
    assert.equal(
      text.includes('app.resume_v2_rpc'), false,
      `${file} was edited; the security delta belongs in 007 so the approved files stay stable`
    )
  }
  // 007 replaces both, so applying the set in order still lands on the hardened
  // definitions.
  assert.ok(CODE.includes('create or replace function public.save_resume_v2'))
  assert.ok(CODE.includes('create or replace function public.create_resume_v2'))
})

test('the repository reaches strength through the RPC, not a direct update', () => {
  const repo = readFileSync(fileURLToPath(new URL('./repo/resumeRepo.ts', import.meta.url)), 'utf8')
  const strength = repo.slice(
    repo.indexOf('export async function saveStrength'),
    repo.indexOf('export async function deleteResume')
  )
  assert.ok(strength.includes("db.rpc('save_resume_strength_v2'"))
  assert.equal(strength.includes('.update('), false, 'the write boundary refuses this')
})

// ---------------------------------------------------------------------------
// The creation cap is strict, not merely checked
// ---------------------------------------------------------------------------

test('the cap serializes per owner before it counts', () => {
  const insert = INSERT_BRANCH
  const lock = BOUNDARY.indexOf('for update')
  const count = BOUNDARY.indexOf('count(*)')
  assert.notEqual(lock, -1, 'the owner row is never locked, so two creates can race')
  assert.ok(lock < count, 'the lock must be taken before the count is read')
  assert.ok(insert.includes('count(*)'), 'the cap check moved out of the INSERT branch')
})

test('the lock is on the owner row, and is not global', () => {
  const locked = BOUNDARY.slice(BOUNDARY.indexOf("if tg_op = 'INSERT' then"))
  assert.ok(
    /from public\.user_profiles p\s*\n\s*where p\.id = new\.user_id\s*\n\s*for update/.test(locked),
    'the lock must name the owner of the row being inserted'
  )
  for (const global of ['lock table', 'pg_advisory_lock(', 'access exclusive']) {
    assert.equal(BOUNDARY.includes(global), false, `a global lock via ${global}`)
  }
})

test('an owner with no profile row is still serialized', () => {
  assert.ok(
    BOUNDARY.includes('pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0))'),
    'a profile-less account would be an unguarded path through the cap'
  )
  // Transaction-scoped, so it cannot leak into a later request on the same
  // pooled connection.
  assert.equal(BOUNDARY.includes('pg_advisory_lock('), false, 'a session lock would outlive the write')
})

test('the UPDATE path takes no lock, because it counts nothing', () => {
  assert.equal(
    UPDATE_BRANCH.includes('for update'), false,
    'locking on every save would serialize ordinary edits for no benefit'
  )
})

// ---------------------------------------------------------------------------
// Migration 008 -- the entitlement source
// ---------------------------------------------------------------------------

const GUARD_SQL = readFileSync(
  fileURLToPath(new URL('../../supabase/migrations/20260912_008_user_profiles_entitlement_guard.sql', import.meta.url)),
  'utf8'
)
const GUARD = GUARD_SQL.replace(/^\s*--.*$/gm, '').replace(/comment on [\s\S]*?;/g, '')

test('008 leaves the browser with SELECT on user_profiles and nothing else', () => {
  assert.ok(GUARD.includes('revoke all privileges on table public.user_profiles from anon;'))
  assert.ok(GUARD.includes('revoke all privileges on table public.user_profiles from authenticated;'))

  const grants = [...GUARD.matchAll(/^grant ([\s\S]*?) on table public\.user_profiles to (\w+);/gm)]
  assert.equal(grants.length, 1, 'exactly one grant should remain')
  assert.equal(grants[0][1].trim(), 'select')
  assert.equal(grants[0][2], 'authenticated')
})

test('008 removes every write policy and keeps the read policies', () => {
  const drops = [...GUARD.matchAll(/drop policy if exists "([^"]+)" +on public\.user_profiles;/g)]
    .map((m) => m[1])
  for (const name of ['user_profiles_insert_own', 'user_profiles_update_own', 'Users can update own profile']) {
    assert.ok(drops.includes(name), `the ${name} policy is left behind`)
  }
  for (const keep of ['Users can view own profile', 'admins can view all profiles', 'user_profiles_select_own']) {
    assert.equal(drops.includes(keep), false, `008 drops the read policy "${keep}"`)
  }
})

test('the guard forces the tier back for any end-user write', () => {
  const fnBody = GUARD.slice(
    GUARD.indexOf('create or replace function public.guard_resume_entitlement_fields'),
    GUARD.indexOf('revoke all on function public.guard_resume_entitlement_fields')
  )
  assert.ok(fnBody.includes('security definer'))
  assert.ok(fnBody.includes("set search_path = ''"))
  assert.ok(fnBody.includes('if auth.uid() is null then'), 'the service-role exemption is missing')
  assert.ok(fnBody.includes("new.subscription_tier := 'free'"), 'an insert can claim a tier')
  assert.ok(
    fnBody.includes('new.subscription_tier := old.subscription_tier'),
    'an update can change the tier'
  )
  assert.ok(fnBody.includes('new.stripe_customer_id := old.stripe_customer_id'))
})

test('the guard fires before insert and update on user_profiles', () => {
  assert.ok(
    /create trigger user_profiles_entitlement_guard\s+before insert or update on public\.user_profiles\s+for each row/.test(GUARD),
    'the guard is not wired as a BEFORE row trigger'
  )
  assert.ok(GUARD.includes('drop trigger if exists user_profiles_entitlement_guard'), 'not rerunnable')
})

test('008 does not clobber the production guard it cannot see', () => {
  // guard_user_profile_privileges() exists only as a comment in this repo. A
  // CREATE OR REPLACE of that name would silently redefine a function nobody
  // here has read, dropping whatever else it protects.
  assert.equal(
    GUARD.includes('create or replace function public.guard_user_profile_privileges'), false,
    '008 redefines a function this repository has never seen'
  )
})

test('008 is executable by nobody and touches no data', () => {
  assert.equal(
    /grant execute on function public\.guard_resume_entitlement_fields/.test(GUARD), false,
    'the guard is granted to someone'
  )
  for (const destructive of ['drop table', 'drop column', 'truncate', 'delete from', 'update public.user_profiles']) {
    assert.equal(GUARD.toLowerCase().includes(destructive), false, `008 contains "${destructive}"`)
  }
  assert.ok(/^begin;/m.test(GUARD) && /^commit;/m.test(GUARD))
})

test('008 does not disturb service_role, the legitimate billing path', () => {
  assert.equal(
    /revoke[^;]*from[^;]*service_role/.test(GUARD), false,
    'revoking from service_role would break the Stripe webhook'
  )
})

test('the only application writer of subscription_tier is the Stripe webhook', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', '.git'].includes(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
      const text = readFileSync(full, 'utf8')
      // A write is `subscription_tier:` inside an update/insert/upsert object.
      if (/\.(update|insert|upsert)\(\s*\{[^}]*subscription_tier\s*:/s.test(text)) {
        offenders.push(full.slice(root.length))
      }
    }
  }
  for (const dir of ['app', 'components', 'lib']) walk(join(root, dir))

  assert.deepEqual(
    offenders, ['app/api/webhook/route.ts'],
    'subscription_tier is written somewhere other than the Stripe webhook'
  )
  const webhook = readFileSync(join(root, 'app/api/webhook/route.ts'), 'utf8')
  assert.ok(
    webhook.includes('SUPABASE_SERVICE_ROLE_KEY'),
    'the billing path must be server-side, or the guard would block it'
  )
})
