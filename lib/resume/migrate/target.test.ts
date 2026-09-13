import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  ALLOWED_TARGET, PRODUCTION_ONLY_SECRETS, PRODUCTION_PROJECT_REFS,
  checkTarget, projectRefOf, requireStagingTarget,
} from './target.ts'
import type { TargetEnv } from './target.ts'

/**
 * The guard that stands between this repository and a production database.
 *
 * Everything behind it writes rows -- 33 deletes, 13 updates and 22 inserts in
 * the integration suite, and a migration ledger whose rows can never be
 * deleted. So the interesting half of this suite is the refusals, and the bar
 * is that NOTHING reaches `ok: true` by omission.
 *
 * No connection is opened anywhere in this file. checkTarget is pure and takes
 * the environment as an argument.
 */

const STAGING = 'stagingproj1234abcd'
const PRODUCTION = PRODUCTION_PROJECT_REFS[0]

/** A fully valid staging environment. Each test spoils exactly one thing. */
const good = (over: Record<string, string | undefined> = {}): TargetEnv => ({
  RESUME_MIGRATION_TARGET: 'staging',
  RESUME_STAGING_PROJECT_REF: STAGING,
  SUPABASE_URL: `https://${STAGING}.supabase.co`,
  ...over,
})

// --- the one way through ----------------------------------------------------

test('a correctly configured staging target passes', () => {
  const decision = checkTarget(good())
  assert.equal(decision.ok, true, decision.ok ? '' : decision.message)
  if (decision.ok) {
    assert.equal(decision.projectRef, STAGING)
    assert.equal(decision.host, `${STAGING}.supabase.co`)
  }
})

test('the target name is matched case-insensitively and trimmed', () => {
  for (const target of ['staging', 'STAGING', ' Staging ']) {
    assert.equal(checkTarget(good({ RESUME_MIGRATION_TARGET: target })).ok, true, target)
  }
})

test('a staging URL with a port or path still has to be that project', () => {
  // The host is what identifies the database; a trailing path is harmless.
  assert.equal(checkTarget(good({ SUPABASE_URL: `https://${STAGING}.supabase.co/` })).ok, true)
})

// --- A. the target label ----------------------------------------------------

test('an unset target is refused', () => {
  const decision = checkTarget(good({ RESUME_MIGRATION_TARGET: undefined }))
  assert.equal(decision.ok, false)
  if (!decision.ok) {
    assert.equal(decision.rule, 'target')
    assert.match(decision.message, /<unset>/)
  }
})

test('target=production is refused, loudly', () => {
  const decision = checkTarget(good({ RESUME_MIGRATION_TARGET: 'production' }))
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'target')
})

test('no value other than staging opens the guard', () => {
  for (const target of ['', ' ', 'prod', 'stage', 'staging2', 'true', '1', 'development']) {
    assert.equal(
      checkTarget(good({ RESUME_MIGRATION_TARGET: target })).ok, false,
      `"${target}" opened the guard`
    )
  }
})

// --- B. the staging project must be named ----------------------------------

test('a missing staging ref is refused', () => {
  const decision = checkTarget(good({ RESUME_STAGING_PROJECT_REF: undefined }))
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'staging-ref')
})

test('a malformed staging ref is refused', () => {
  for (const ref of ['', '  ', 'short', 'UPPERCASE1234567', 'has-dashes-1234567', 'has_underscore123', '../etc/passwd']) {
    const decision = checkTarget(good({ RESUME_STAGING_PROJECT_REF: ref }))
    assert.equal(decision.ok, false, `"${ref}" was accepted as a project ref`)
  }
})

test('naming production as the staging project is refused', () => {
  const decision = checkTarget(good({
    RESUME_STAGING_PROJECT_REF: PRODUCTION,
    SUPABASE_URL: `https://${PRODUCTION}.supabase.co`,
  }))
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'production-project')
})

// --- C. the URL must be that project ---------------------------------------

test('a missing URL is refused', () => {
  const decision = checkTarget(good({ SUPABASE_URL: undefined }))
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'url')
})

test('a malformed URL is refused', () => {
  for (const url of ['', 'not a url', 'http://', 'supabase.co', `${STAGING}.supabase.co`, 'https://example.com']) {
    const decision = checkTarget(good({ SUPABASE_URL: url }))
    assert.equal(decision.ok, false, `"${url}" was accepted`)
  }
})

test('THE CASE THAT MOTIVATED THIS: staging label, production URL', () => {
  const decision = checkTarget(good({ SUPABASE_URL: `https://${PRODUCTION}.supabase.co` }))
  assert.equal(decision.ok, false)
  if (!decision.ok) {
    assert.equal(decision.rule, 'production-project')
    assert.match(decision.message, /PRODUCTION/)
  }
})

test('staging ref A with a URL for project B is refused', () => {
  const decision = checkTarget(good({ SUPABASE_URL: 'https://someotherproject99.supabase.co' }))
  assert.equal(decision.ok, false)
  if (!decision.ok) {
    assert.equal(decision.rule, 'host-mismatch')
    assert.match(decision.message, /someotherproject99/)
    assert.match(decision.message, new RegExp(STAGING))
  }
})

test('a host that merely contains the staging ref is not a match', () => {
  // Substring matching here would accept an attacker-shaped host.
  for (const host of [
    `${STAGING}.supabase.co.evil.test`,
    `evil-${STAGING}.supabase.co`,
    `${STAGING}x.supabase.co`,
    `sub.${STAGING}.supabase.co`,
  ]) {
    assert.equal(checkTarget(good({ SUPABASE_URL: `https://${host}` })).ok, false, host)
  }
})

test('projectRefOf reads only a real Supabase host', () => {
  assert.equal(projectRefOf('https://abc123.supabase.co'), 'abc123')
  assert.equal(projectRefOf('https://abc123.supabase.co/rest/v1'), 'abc123')
  assert.equal(projectRefOf('https://abc123.example.com'), null)
  assert.equal(projectRefOf('garbage'), null)
})

// --- E. the app's own URL ---------------------------------------------------

test('a production NEXT_PUBLIC_SUPABASE_URL in the shell is refused', () => {
  const decision = checkTarget(good({
    NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION}.supabase.co`,
  }))
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'production-app-url')
})

test('a staging NEXT_PUBLIC_SUPABASE_URL is fine', () => {
  assert.equal(
    checkTarget(good({ NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING}.supabase.co` })).ok,
    true
  )
})

// --- F. production-only secrets --------------------------------------------

test('any production-only secret in the environment refuses the run', () => {
  for (const name of PRODUCTION_ONLY_SECRETS) {
    const decision = checkTarget(good({ [name]: 'some-value' }))
    assert.equal(decision.ok, false, `${name} did not refuse`)
    if (!decision.ok) {
      assert.equal(decision.rule, 'production-secret')
      assert.match(decision.message, new RegExp(name))
    }
  }
})

test('the refusal names the secrets it found and never their values', () => {
  const decision = checkTarget(good({
    STRIPE_SECRET_KEY: 'sk_live_SUPERSECRET',
    RESEND_API_KEY: 're_SUPERSECRET',
  }))
  assert.equal(decision.ok, false)
  if (!decision.ok) {
    assert.match(decision.message, /STRIPE_SECRET_KEY/)
    assert.match(decision.message, /RESEND_API_KEY/)
    assert.equal(decision.message.includes('SUPERSECRET'), false, 'a secret value was printed')
  }
})

test('an empty production secret is not treated as present', () => {
  assert.equal(checkTarget(good({ STRIPE_SECRET_KEY: '', RESEND_API_KEY: '   ' })).ok, true)
})

// --- fail closed ------------------------------------------------------------

test('an empty environment is refused', () => {
  assert.equal(checkTarget({}).ok, false)
})

test('no single-variable environment reaches ok', () => {
  for (const name of ['RESUME_MIGRATION_TARGET', 'RESUME_STAGING_PROJECT_REF', 'SUPABASE_URL']) {
    assert.equal(checkTarget({ [name]: 'staging' }).ok, false, `${name} alone passed`)
  }
})

test('removing any one required value from a good environment refuses it', () => {
  for (const name of ['RESUME_MIGRATION_TARGET', 'RESUME_STAGING_PROJECT_REF', 'SUPABASE_URL']) {
    const decision = checkTarget(good({ [name]: undefined }))
    assert.equal(decision.ok, false, `the guard passed without ${name}`)
  }
})

test('every refusal carries a rule and a message', () => {
  const spoiled: TargetEnv[] = [
    {},
    good({ RESUME_MIGRATION_TARGET: 'production' }),
    good({ RESUME_STAGING_PROJECT_REF: undefined }),
    good({ SUPABASE_URL: 'nonsense' }),
    good({ SUPABASE_URL: `https://${PRODUCTION}.supabase.co` }),
    good({ SUPABASE_URL: 'https://otherproject1234.supabase.co' }),
    good({ NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION}.supabase.co` }),
    good({ STRIPE_SECRET_KEY: 'x' }),
  ]
  for (const env of spoiled) {
    const decision = checkTarget(env)
    assert.equal(decision.ok, false)
    if (!decision.ok) {
      assert.ok(decision.rule.length > 0)
      assert.ok(decision.message.length > 20, 'a refusal must explain itself')
    }
  }
})

// --- requireStagingTarget ---------------------------------------------------

test('requireStagingTarget returns only safe identifiers', () => {
  const result = requireStagingTarget(good(), () => { throw new Error('should not fail') })
  assert.deepEqual(Object.keys(result).sort(), ['host', 'projectRef'])
  assert.equal(result.projectRef, STAGING)
})

test('requireStagingTarget stops the caller on refusal', () => {
  let refused = ''
  assert.throws(
    () => requireStagingTarget(
      good({ SUPABASE_URL: `https://${PRODUCTION}.supabase.co` }),
      (message) => { refused = message; throw new Error('stopped') }
    ),
    /stopped/,
    'the guard returned instead of stopping the caller'
  )
  assert.match(refused, /PRODUCTION/, 'the refusal reason did not reach the caller')
})

test('requireStagingTarget never hands back a credential', () => {
  const result = requireStagingTarget(
    good({ SUPABASE_SERVICE_ROLE_KEY: 'SUPERSECRET', SUPABASE_ANON_KEY: 'ALSOSECRET' }),
    () => { throw new Error('should not fail') }
  )
  const serialized = JSON.stringify(result)
  for (const secret of ['SUPERSECRET', 'ALSOSECRET']) {
    assert.equal(serialized.includes(secret), false, 'the guard returned a credential')
  }
})

// --- one guard, no drift ----------------------------------------------------

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function code(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('both callers import the same guard module', () => {
  const script = code('scripts/migrate-v1-resumes.ts')
  const suite = code('lib/resume/migrate/integration.test.ts')
  assert.ok(script.includes("from '../lib/resume/migrate/target.ts'"), 'the script has its own guard')
  assert.ok(suite.includes("from './target.ts'"), 'the integration suite has its own guard')
  assert.ok(script.includes('requireStagingTarget()'))
  assert.ok(suite.includes('checkTarget(process.env)'))
})

test('neither caller keeps a second, weaker staging check', () => {
  for (const file of ['scripts/migrate-v1-resumes.ts', 'lib/resume/migrate/integration.test.ts']) {
    const source = code(file)
    for (const local of ['RESUME_MIGRATION_TARGET', 'supabase.co', 'ALLOWED_TARGET', 'PRODUCTION_PROJECT_REFS']) {
      assert.equal(
        source.includes(local), false,
        `${file} re-implements "${local}" instead of deferring to the shared guard`
      )
    }
  }
})

test('the integration suite cannot run unless the guard passed', () => {
  const suite = code('lib/resume/migrate/integration.test.ts')
  assert.ok(
    /const configured = TARGET\.ok && Boolean\(url\) && Boolean\(serviceKey\)/.test(suite),
    'the skip condition does not begin with the guard verdict'
  )
  assert.ok(
    /const skip = configured/.test(suite) && /const skipRls = configured/.test(suite),
    'both skip flags must derive from the guard verdict'
  )

  // EVERY test must carry one of those flags. Counting matches separately was
  // too loose to notice a single unguarded test, so each declaration is
  // inspected on its own: without this, one test could open a connection the
  // guard had already refused.
  const declarations = suite.split(/\ntest\(/).slice(1)
  assert.ok(declarations.length > 40, `only found ${declarations.length} tests`)

  const unguarded = declarations
    .map((chunk) => chunk.slice(0, chunk.indexOf('async ()') + 1 || 400))
    .filter((head) => !/\{\s*skip(Rls|Ultimate)?\s*[,:}]/.test(head))
    .map((head) => head.slice(0, head.indexOf("',") + 1).trim())

  assert.deepEqual(unguarded, [], 'these tests would run without the guard passing')
})

test('the guard is not reachable from the application', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', '.git'].includes(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (/migrate\/target\.(test\.)?ts$/.test(full)) continue
      if (/from ['"].*migrate\/target(\.ts)?['"]/.test(readFileSync(full, 'utf8'))) {
        offenders.push(full.slice(ROOT.length))
      }
    }
  }
  for (const dir of ['app', 'components']) walk(join(ROOT, dir))
  assert.deepEqual(offenders, [], 'the staging guard must not be reachable from the app')
})

test('the production ref is recorded, and is the one the app ships', () => {
  assert.equal(PRODUCTION_PROJECT_REFS.length >= 1, true)
  for (const ref of PRODUCTION_PROJECT_REFS) {
    assert.match(ref, /^[a-z0-9]{16,32}$/, `"${ref}" is not a project ref`)
  }
  assert.equal(ALLOWED_TARGET, 'staging')
})

test('the guard opens no connection of its own', () => {
  const source = code('lib/resume/migrate/target.ts')
  for (const forbidden of ['createClient', '@supabase', 'fetch(', 'http.request', 'net.']) {
    assert.equal(source.includes(forbidden), false, `target.ts references ${forbidden}`)
  }
})
