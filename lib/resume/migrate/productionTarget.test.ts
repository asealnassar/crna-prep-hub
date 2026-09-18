import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  CONFIRM_ENV, PRODUCTION_PROJECT_REF, PRODUCTION_TARGET,
  checkProductionTarget, requireProductionTarget,
} from './productionTarget.ts'
import type { TargetEnv } from './productionTarget.ts'
import { ALLOWED_TARGET, PRODUCTION_PROJECT_REFS, checkTarget } from './target.ts'

/**
 * The guard for the one-off production migration run, and its relationship to
 * the staging guard it must not weaken.
 *
 * Two properties matter more than any individual rule:
 *
 *   1. NOTHING reaches `ok: true` by omission, and `apply` is false unless it
 *      was earned three separate times -- the target name, the flag and the
 *      confirmation.
 *   2. The two guards are mutually exclusive. One environment can satisfy at
 *      most one of them, so "I thought I was on staging" and "I thought this
 *      was a rehearsal" are not states this tooling can be in.
 *
 * No connection is opened anywhere in this file. checkProductionTarget is pure
 * and takes the environment as an argument.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const code = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const STAGING = 'stagingproj1234abcd'

/** A fully valid production environment. Each test spoils exactly one thing. */
const good = (over: Record<string, string | undefined> = {}): TargetEnv => ({
  RESUME_MIGRATION_TARGET: 'production',
  NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
  ...over,
})

// --- the one way through ----------------------------------------------------

test('a correctly configured production target passes, as a rehearsal', () => {
  const decision = checkProductionTarget(good(), [])
  assert.equal(decision.ok, true, decision.ok ? '' : decision.message)
  if (decision.ok) {
    assert.equal(decision.projectRef, PRODUCTION_PROJECT_REF)
    assert.equal(decision.host, `${PRODUCTION_PROJECT_REF}.supabase.co`)
    assert.equal(decision.apply, false, 'a bare run must never be a write')
  }
})

test('SUPABASE_URL is accepted in place of the app URL, and preferred', () => {
  const only = checkProductionTarget(
    { RESUME_MIGRATION_TARGET: 'production', SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` },
    []
  )
  assert.equal(only.ok, true, only.ok ? '' : only.message)
})

test('the target name is matched case-insensitively and trimmed', () => {
  for (const target of ['production', 'PRODUCTION', ' Production ']) {
    assert.equal(checkProductionTarget(good({ RESUME_MIGRATION_TARGET: target }), []).ok, true, target)
  }
})

// --- rule A: the target must be named --------------------------------------

test('an unnamed, empty or wrong target is refused', () => {
  for (const target of [undefined, '', 'staging', 'prod', 'productionn']) {
    const decision = checkProductionTarget(good({ RESUME_MIGRATION_TARGET: target }), [])
    assert.equal(decision.ok, false, String(target))
    if (!decision.ok) assert.equal(decision.rule, 'target')
  }
})

// --- rule B: a staging shell is a mixed shell -------------------------------

test('a shell carrying staging configuration is refused outright', () => {
  const decision = checkProductionTarget(good({ RESUME_STAGING_PROJECT_REF: STAGING }), [])
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'staging-shell')
})

// --- rules C and D: the URL -------------------------------------------------

test('a missing URL is refused', () => {
  const decision = checkProductionTarget(
    { RESUME_MIGRATION_TARGET: 'production' }, []
  )
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'url')
})

test('an unparseable URL is refused, and is not echoed as a credential might be', () => {
  for (const url of ['not-a-url', 'https://example.com', 'https://supabase.co']) {
    const decision = checkProductionTarget(good({ NEXT_PUBLIC_SUPABASE_URL: url }), [])
    assert.equal(decision.ok, false, url)
    if (!decision.ok) {
      assert.equal(decision.rule, 'url')
      assert.equal(decision.message.includes('?'), false, 'a query string could carry a token')
    }
  }
})

test('two URLs naming different projects are refused rather than guessed at', () => {
  const decision = checkProductionTarget(good({
    SUPABASE_URL: `https://${STAGING}.supabase.co`,
  }), [])
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'url-disagreement')
})

// --- rule E: production, and nothing else -----------------------------------

test('every project except production is refused, staging included', () => {
  for (const ref of [STAGING, 'ecdkhdnmjeerkluvcejg', 'anotherprojectref123']) {
    const decision = checkProductionTarget(
      good({ NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co` }), []
    )
    assert.equal(decision.ok, false, ref)
    if (!decision.ok) assert.equal(decision.rule, 'not-production')
  }
})

test('the production ref is the exact one the audit named', () => {
  assert.equal(PRODUCTION_PROJECT_REF, 'kkarzgxriuxltieycvfg')
  assert.match(PRODUCTION_PROJECT_REF, /^[a-z0-9]{16,32}$/)
  assert.equal(PRODUCTION_TARGET, 'production')
})

// --- rule F: writing needs three independent things -------------------------

test('--apply alone is NOT enough', () => {
  const decision = checkProductionTarget(good(), ['node', 'script', '--apply'])
  assert.equal(decision.ok, false, 'a stray --apply was accepted')
  if (!decision.ok) assert.equal(decision.rule, 'confirm')
})

test('a wrong or empty confirmation is refused', () => {
  for (const confirm of [undefined, '', 'yes', 'production', STAGING, 'KKARZGXRIUXLTIEYCVFG']) {
    const decision = checkProductionTarget(
      good({ [CONFIRM_ENV]: confirm }), ['--apply']
    )
    assert.equal(decision.ok, false, String(confirm))
    if (!decision.ok) assert.equal(decision.rule, 'confirm')
  }
})

test('the confirmation without --apply is still only a rehearsal', () => {
  const decision = checkProductionTarget(good({ [CONFIRM_ENV]: PRODUCTION_PROJECT_REF }), [])
  assert.equal(decision.ok, true)
  if (decision.ok) assert.equal(decision.apply, false)
})

test('all three together, and only then, permit a write', () => {
  const decision = checkProductionTarget(
    good({ [CONFIRM_ENV]: PRODUCTION_PROJECT_REF }), ['node', 'script', '--apply']
  )
  assert.equal(decision.ok, true, decision.ok ? '' : decision.message)
  if (decision.ok) assert.equal(decision.apply, true)
})

// --- the two guards cannot both be satisfied --------------------------------

test('no single environment satisfies both the staging and production guards', () => {
  const environments: TargetEnv[] = [
    good(),
    good({ [CONFIRM_ENV]: PRODUCTION_PROJECT_REF }),
    { RESUME_MIGRATION_TARGET: 'staging', RESUME_STAGING_PROJECT_REF: STAGING, SUPABASE_URL: `https://${STAGING}.supabase.co` },
    { RESUME_MIGRATION_TARGET: 'production', SUPABASE_URL: `https://${STAGING}.supabase.co` },
    {},
  ]
  for (const env of environments) {
    const both = checkTarget(env).ok && checkProductionTarget(env, []).ok
    assert.equal(both, false, `an environment satisfied both guards: ${JSON.stringify(env)}`)
  }
})

test('the staging guard still refuses production, unchanged', () => {
  // The staging guard is the thing this work must not weaken. Asserted here as
  // well as in target.test.ts, so weakening it fails from two directions.
  const decision = checkTarget({
    RESUME_MIGRATION_TARGET: 'staging',
    RESUME_STAGING_PROJECT_REF: STAGING,
    SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
  })
  assert.equal(decision.ok, false)
  if (!decision.ok) assert.equal(decision.rule, 'production-project')
  assert.equal(ALLOWED_TARGET, 'staging')
  assert.ok(PRODUCTION_PROJECT_REFS.includes(PRODUCTION_PROJECT_REF))
})

// --- the wrapper ------------------------------------------------------------

test('requireProductionTarget fails closed and returns only safe identifiers', () => {
  const failures: string[] = []
  const fail = ((message: string) => { failures.push(message); throw new Error('stopped') }) as (m: string) => never

  assert.throws(() => requireProductionTarget({}, [], fail))
  assert.equal(failures.length, 1)

  const ok = requireProductionTarget(good({ [CONFIRM_ENV]: PRODUCTION_PROJECT_REF }), ['--apply'], fail)
  assert.deepEqual(ok, {
    projectRef: PRODUCTION_PROJECT_REF,
    host: `${PRODUCTION_PROJECT_REF}.supabase.co`,
    apply: true,
  })
})

// --- what the modules may contain -------------------------------------------

test('the guard opens no connection and holds no credential', () => {
  const source = code('lib/resume/migrate/productionTarget.ts')
  for (const forbidden of ['createClient', '@supabase', 'fetch(', 'http.request', 'net.', 'SERVICE_ROLE']) {
    assert.equal(source.includes(forbidden), false, `productionTarget.ts references ${forbidden}`)
  }
})

test('neither guard is reachable from the application', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', '.git'].includes(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      if (/from ['"].*migrate\/(production)?[Tt]arget(\.ts)?['"]/.test(readFileSync(full, 'utf8'))) {
        offenders.push(full.slice(ROOT.length))
      }
    }
  }
  for (const dir of ['app', 'components']) walk(join(ROOT, dir))
  assert.deepEqual(offenders, [], 'a migration guard is reachable from the app')
})

test('the staging runner was not repurposed for production', () => {
  const staging = code('scripts/migrate-v1-resumes.ts')
  assert.match(staging, /requireStagingTarget\(\)/, 'the staging runner lost its guard')
  for (const forbidden of ['productionTarget', 'RESUME_PRODUCTION_MIGRATION_CONFIRM', PRODUCTION_PROJECT_REF]) {
    assert.equal(staging.includes(forbidden), false, `the staging runner now mentions ${forbidden}`)
  }
})

test('the production runner writes nothing a migration must not write', () => {
  const runner = code('scripts/migrate-v1-resumes-production.ts')
  assert.match(runner, /requireProductionTarget\(\)/, 'the production runner has no guard')
  // The single permitted update is the ledger's completed_at, and it is scoped.
  const updates = runner.match(/\.update\(/g) ?? []
  assert.equal(updates.length, 1, `expected exactly one update, found ${updates.length}`)
  assert.match(runner, /from\('resume_v1_migration_links'\)\s*\.update\(\{ completed_at/)
  for (const forbidden of ['.delete(', '.upsert(', ".from('resumes').update(", ".from('resume_sections').update("]) {
    assert.equal(runner.includes(forbidden), false, `the production runner contains ${forbidden}`)
  }
  // It reuses the tested logic rather than carrying its own copy.
  for (const reused of ['planMigration', 'executeMigration', 'deterministicId', 'formatPlan', 'formatExecution']) {
    assert.ok(runner.includes(reused), `the production runner does not reuse ${reused}`)
  }
  // And it reads only legacy rows as sources.
  assert.match(runner, /schema_version\.is\.null,schema_version\.eq\.1/)
})

test('a rehearsal is the default: --apply appears only as a guarded read', () => {
  const runner = code('scripts/migrate-v1-resumes-production.ts')
  // The runner never parses --apply itself; the guard decides, once.
  assert.equal(runner.includes("argv.includes('--apply')"), false,
    'the runner decides apply for itself, bypassing the confirmation')
  assert.match(runner, /const \{ host, apply \} = requireProductionTarget\(\)/)
})
