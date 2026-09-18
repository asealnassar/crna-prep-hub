/**
 * The guard for the one-off PRODUCTION V1 -> V2 migration run.
 *
 * WHY A SECOND GUARD RATHER THAN A FLAG ON THE FIRST. target.ts exists to make
 * production unreachable: rule D there refuses the production project by
 * identity, and the integration suite -- which performs deletes and rewrites
 * subscription_tier -- depends on that refusal being absolute. Adding a
 * "production is allowed when..." branch to it would put the escape hatch
 * inside the control, and every future reader of the staging tooling would
 * have to prove the hatch was shut. So target.ts is untouched and stays
 * staging-only, and this module is its mirror image: it refuses EVERY project
 * except production, including staging.
 *
 * Two guards that each refuse what the other allows cannot both be satisfied
 * by one environment, which is the property worth having.
 *
 * THE PRIMARY CONTROL IS THE POSITIVE PROJECT-REF CHECK. The connection URL's
 * host must be exactly the known production project. A typo, a staging URL or
 * a copy of production restored elsewhere all refuse rather than connect.
 *
 * WRITES NEED THREE INDEPENDENT THINGS, none of which is a default:
 *
 *   RESUME_MIGRATION_TARGET=production          names the environment
 *   --apply                                     names the intent
 *   RESUME_PRODUCTION_MIGRATION_CONFIRM=<ref>   names the database, again
 *
 * The confirmation is the project ref rather than a fixed word on purpose: a
 * word can be copied out of a runbook without reading it, while the ref is the
 * identity of the database about to be written to. Adding `--apply` by reflex
 * is therefore not enough, which is the whole point of requirement 5.
 *
 * NODE ONLY. This module reads nothing but the object it is handed, is
 * imported by one script and one test, and must never be imported from app/ or
 * components/. A test asserts that.
 *
 * NOTHING HERE OPENS A CONNECTION and nothing here holds a credential. It
 * inspects an environment and returns a verdict; the caller decides. That is
 * what makes it testable without a database, and what keeps the service-role
 * key out of it entirely.
 */

import { projectRefOf } from './target.ts'

/** The one target this runner will accept. */
export const PRODUCTION_TARGET = 'production'

/**
 * The production project, named so it can be required by identity.
 *
 * NOT A SECRET. A Supabase project ref ships in every client bundle via
 * NEXT_PUBLIC_SUPABASE_URL. target.ts names the same value for the opposite
 * purpose; both are deliberate.
 */
export const PRODUCTION_PROJECT_REF = 'kkarzgxriuxltieycvfg'

/** The environment variable that must repeat the ref before anything is written. */
export const CONFIRM_ENV = 'RESUME_PRODUCTION_MIGRATION_CONFIRM'

export type ProductionRefusal =
  | 'target'
  | 'staging-shell'
  | 'url'
  | 'url-disagreement'
  | 'not-production'
  | 'confirm'

export type ProductionTargetDecision =
  | {
      readonly ok: true
      /** Safe to log: the production project ref. */
      readonly projectRef: string
      /** Safe to log: the production host. */
      readonly host: string
      /** True only when all three independent controls were satisfied. */
      readonly apply: boolean
    }
  | {
      readonly ok: false
      readonly rule: ProductionRefusal
      /** Safe to print. Never contains a key, token or secret value. */
      readonly message: string
    }

/** The environment, injected so the rules can be tested without mutating the real one. */
export type TargetEnv = Readonly<Record<string, string | undefined>>

function value(env: TargetEnv, name: string): string {
  return (env[name] ?? '').trim()
}

/**
 * The whole decision, as one pure function.
 *
 * Every branch refuses; there is no path that reaches success by omission, and
 * `apply` is false unless it was earned three times over.
 */
export function checkProductionTarget(
  env: TargetEnv,
  argv: readonly string[] = []
): ProductionTargetDecision {
  // --- A. the target must be named, and named exactly ---------------------
  const target = value(env, 'RESUME_MIGRATION_TARGET').toLowerCase()
  if (target !== PRODUCTION_TARGET) {
    return {
      ok: false,
      rule: 'target',
      message:
        `RESUME_MIGRATION_TARGET must be "${PRODUCTION_TARGET}" (got ` +
        `${target === '' ? '<unset>' : `"${target}"`}). This runner exists for ` +
        'one controlled cutover and refuses every other environment; staging ' +
        'runs go through scripts/migrate-v1-resumes.ts.',
    }
  }

  // --- B. a staging shell is a mixed shell --------------------------------
  // RESUME_STAGING_PROJECT_REF only exists where staging tooling was being
  // run. Its presence means this shell was set up for something else, and the
  // credentials beside it may not be the ones the operator thinks.
  const stagingRef = value(env, 'RESUME_STAGING_PROJECT_REF')
  if (stagingRef !== '') {
    return {
      ok: false,
      rule: 'staging-shell',
      message:
        'RESUME_STAGING_PROJECT_REF is set, so this shell was prepared for ' +
        'staging. Refusing to run the production migration from it. Open a ' +
        'clean shell rather than unsetting variables one at a time.',
    }
  }

  // --- C. the URL, from either name a production shell actually carries ---
  const explicit = value(env, 'SUPABASE_URL')
  const appUrl = value(env, 'NEXT_PUBLIC_SUPABASE_URL')
  if (explicit === '' && appUrl === '') {
    return {
      ok: false,
      rule: 'url',
      message: 'Neither SUPABASE_URL nor NEXT_PUBLIC_SUPABASE_URL is set.',
    }
  }

  // --- D. and if both are present they must be the same project -----------
  if (explicit !== '' && appUrl !== '') {
    const a = projectRefOf(explicit)
    const b = projectRefOf(appUrl)
    if (a !== b) {
      return {
        ok: false,
        rule: 'url-disagreement',
        message:
          `SUPABASE_URL is project "${a ?? 'unparseable'}" but ` +
          `NEXT_PUBLIC_SUPABASE_URL is "${b ?? 'unparseable'}". A half-loaded ` +
          'environment is refused rather than guessed at.',
      }
    }
  }

  const rawUrl = explicit !== '' ? explicit : appUrl
  const urlRef = projectRefOf(rawUrl)
  if (urlRef === null) {
    return {
      ok: false,
      rule: 'url',
      // Echoed only when it failed to parse as a Supabase project URL, so it
      // cannot be carrying a token in a query string we would print.
      message: 'The Supabase URL is not a valid project URL (expected https://<ref>.supabase.co).',
    }
  }

  // --- E. it must be production, and nothing else -------------------------
  if (urlRef !== PRODUCTION_PROJECT_REF) {
    return {
      ok: false,
      rule: 'not-production',
      message:
        `The Supabase URL points at project "${urlRef}", which is not the ` +
        `production project (${PRODUCTION_PROJECT_REF}). This runner has no ` +
        'path to any other database, staging included.',
    }
  }

  // --- F. writing needs the third, independent confirmation ---------------
  const wantsApply = argv.includes('--apply')
  if (!wantsApply) {
    return { ok: true, projectRef: urlRef, host: `${urlRef}.supabase.co`, apply: false }
  }

  const confirm = value(env, CONFIRM_ENV)
  if (confirm !== PRODUCTION_PROJECT_REF) {
    return {
      ok: false,
      rule: 'confirm',
      message:
        `--apply was passed but ${CONFIRM_ENV} ` +
        `${confirm === '' ? 'is not set' : 'does not match'}. Set it to the ` +
        'production project ref to confirm which database is about to be ' +
        'written to. Nothing was read and nothing was written.',
    }
  }

  return { ok: true, projectRef: urlRef, host: `${urlRef}.supabase.co`, apply: true }
}

/**
 * The convenience wrapper for the script: check the real environment, print
 * the refusal, and stop.
 *
 * Returns only safe identifiers -- the ref, the host and whether this is a
 * rehearsal. The URL and the keys stay with the caller, so this module never
 * has a credential to leak.
 */
export function requireProductionTarget(
  env: TargetEnv = process.env,
  argv: readonly string[] = process.argv,
  fail: (message: string) => never = (message) => {
    console.error(`FATAL: ${message}`)
    process.exit(1)
  }
): { projectRef: string; host: string; apply: boolean } {
  const decision = checkProductionTarget(env, argv)
  if (!decision.ok) fail(decision.message)
  return { projectRef: decision.projectRef, host: decision.host, apply: decision.apply }
}
