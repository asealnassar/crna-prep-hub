/**
 * The guard that decides whether anything in this repository may open a
 * connection to a Supabase project.
 *
 * WHY IT EXISTS. The first version of the migration tooling checked
 * `RESUME_MIGRATION_TARGET === 'staging'` and then connected to whatever
 * SUPABASE_URL said. That is a label the operator types, not a fact about the
 * database: paste the production URL next to it and the tooling runs against
 * production, believing it is on staging.
 *
 * That mattered more than it might sound, because of what runs behind it:
 *
 *   * the integration suite performs 33 deletes, 13 updates and 22 inserts
 *     across resumes, resume_sections, resume_ai_usage and user_profiles --
 *     including rewriting subscription_tier and deleting every V2 resume an
 *     account holds; and
 *   * resume_v1_migration_links denies DELETE to every role by design, so rows
 *     written there are PERMANENT. That table is the migration's idempotency
 *     source, so forged links would make the real migration silently skip real
 *     resumes, with no way to undo it short of a privileged intervention.
 *
 * And production's service-role key is one `source .env.local` away on the
 * machine this runs on.
 *
 * THE PRIMARY CONTROL IS THE POSITIVE PROJECT-REF CHECK (rule C). The operator
 * must name the staging project, and the URL's host must match that name
 * exactly. A typo then refuses to connect instead of connecting somewhere else.
 * Everything around it is defence in depth: rule D refuses a specific known
 * database, and rules E and F refuse an environment that smells of production
 * even when the URL looks right.
 *
 * NODE ONLY. This module reads process.env and is imported by a script and a
 * test file. Nothing under app/ or components/ may import it, and a test
 * asserts that.
 *
 * NOTHING HERE OPENS A CONNECTION. It inspects the environment and returns a
 * verdict; the caller decides what to do with it. That is what makes it
 * testable without a database.
 */

/** The one target this build knows how to run against. */
export const ALLOWED_TARGET = 'staging'

/**
 * Production, named so it can be refused by identity rather than by hoping the
 * operator did not paste it.
 *
 * NOT A SECRET. A Supabase project ref is embedded in every client bundle the
 * site serves, via NEXT_PUBLIC_SUPABASE_URL. Writing it down here costs nothing
 * and buys a check that no amount of environment discipline can provide.
 */
export const PRODUCTION_PROJECT_REFS: readonly string[] = ['kkarzgxriuxltieycvfg']

/**
 * Environment variables that only exist where production does. Their presence
 * says the shell was loaded from a production .env, whatever the URL says.
 */
export const PRODUCTION_ONLY_SECRETS: readonly string[] = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'VERCEL_OIDC_TOKEN',
]

/** Supabase project refs are lower-case alphanumeric, twenty characters. */
const PROJECT_REF = /^[a-z0-9]{16,32}$/

export type TargetDecision =
  | {
      readonly ok: true
      /** Safe to log: the staging project ref. */
      readonly projectRef: string
      /** Safe to log: the staging host. */
      readonly host: string
    }
  | {
      readonly ok: false
      /** Which rule refused, for tests and for the operator. */
      readonly rule: 'target' | 'staging-ref' | 'url' | 'host-mismatch'
        | 'production-project' | 'production-app-url' | 'production-secret'
      /** Safe to print. Never contains a key, token or secret value. */
      readonly message: string
    }

/** The environment, injected so the rules can be tested without mutating the real one. */
export type TargetEnv = Readonly<Record<string, string | undefined>>

function value(env: TargetEnv, name: string): string {
  return (env[name] ?? '').trim()
}

/** The project ref of a Supabase URL, or null if it is not one. */
export function projectRefOf(rawUrl: string): string | null {
  let host: string
  try {
    host = new URL(rawUrl).host.toLowerCase()
  } catch {
    return null
  }
  const match = /^([a-z0-9]+)\.supabase\.(co|in)$/.exec(host)
  return match ? match[1] : null
}

/**
 * The whole decision, as one pure function.
 *
 * Order is deliberate: the cheapest and most explicit refusals come first, so
 * the message an operator sees names the thing they most likely got wrong.
 * Every branch refuses; there is no path that falls through to success by
 * omission.
 */
export function checkTarget(env: TargetEnv): TargetDecision {
  // --- A. the target must be named, and named exactly ---------------------
  const target = value(env, 'RESUME_MIGRATION_TARGET').toLowerCase()
  if (target !== ALLOWED_TARGET) {
    return {
      ok: false,
      rule: 'target',
      message:
        `RESUME_MIGRATION_TARGET must be "${ALLOWED_TARGET}" (got ` +
        `${target === '' ? '<unset>' : `"${target}"`}). This build has no ` +
        'production path; running against production is a separate change that ' +
        'requires its own review.',
    }
  }

  // --- B. the staging project must be named -------------------------------
  const stagingRef = value(env, 'RESUME_STAGING_PROJECT_REF').toLowerCase()
  if (stagingRef === '') {
    return {
      ok: false,
      rule: 'staging-ref',
      message:
        'RESUME_STAGING_PROJECT_REF is not set. Name the staging project ' +
        'explicitly -- it is what the connection URL is checked against.',
    }
  }
  if (!PROJECT_REF.test(stagingRef)) {
    return {
      ok: false,
      rule: 'staging-ref',
      message:
        `RESUME_STAGING_PROJECT_REF "${stagingRef}" is not a Supabase project ` +
        'ref (expected 16-32 lower-case letters and digits).',
    }
  }
  // Naming production as the staging project is refused here as well as in D,
  // so the contradiction is caught even before the URL is read.
  if (PRODUCTION_PROJECT_REFS.includes(stagingRef)) {
    return {
      ok: false,
      rule: 'production-project',
      message:
        `RESUME_STAGING_PROJECT_REF names the PRODUCTION project (${stagingRef}). ` +
        'Refusing.',
    }
  }

  // --- C. the URL must be that project, exactly ---------------------------
  const rawUrl = value(env, 'SUPABASE_URL')
  if (rawUrl === '') {
    return { ok: false, rule: 'url', message: 'SUPABASE_URL is not set.' }
  }
  const urlRef = projectRefOf(rawUrl)
  if (urlRef === null) {
    return {
      ok: false,
      rule: 'url',
      // The URL is echoed only when it failed to parse as a Supabase project
      // URL, so it cannot be carrying a token in a query string we would print.
      message: 'SUPABASE_URL is not a valid Supabase project URL (expected https://<ref>.supabase.co).',
    }
  }

  // --- D. and it must not be production -----------------------------------
  // Checked before the host match, so pointing at production always reports
  // "this is production" rather than the vaguer mismatch message.
  if (PRODUCTION_PROJECT_REFS.includes(urlRef)) {
    return {
      ok: false,
      rule: 'production-project',
      message:
        `SUPABASE_URL points at the PRODUCTION project (${urlRef}). Refusing to ` +
        'connect. Nothing in this build may run against production.',
    }
  }

  if (urlRef !== stagingRef) {
    return {
      ok: false,
      rule: 'host-mismatch',
      message:
        `SUPABASE_URL is project "${urlRef}" but RESUME_STAGING_PROJECT_REF is ` +
        `"${stagingRef}". Refusing to connect to a project that was not named.`,
    }
  }

  // --- E. the app's own URL must not be production either -----------------
  // A shell carrying production's NEXT_PUBLIC_SUPABASE_URL was loaded from a
  // production environment file, and the service-role key beside it is very
  // likely production's too.
  const appUrl = value(env, 'NEXT_PUBLIC_SUPABASE_URL')
  if (appUrl !== '') {
    const appRef = projectRefOf(appUrl)
    if (appRef !== null && PRODUCTION_PROJECT_REFS.includes(appRef)) {
      return {
        ok: false,
        rule: 'production-app-url',
        message:
          'NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION project. This shell ' +
          'was loaded from a production environment; unset it before running ' +
          'staging tooling.',
      }
    }
  }

  // --- F. no production-only secrets in the process -----------------------
  const present = PRODUCTION_ONLY_SECRETS.filter((name) => value(env, name) !== '')
  if (present.length > 0) {
    return {
      ok: false,
      rule: 'production-secret',
      // NAMES ONLY. The values are exactly what must never be printed.
      message:
        `Production-only secrets are present in this environment: ${present.join(', ')}. ` +
        'Staging tooling needs none of them. Unset them and run again.',
    }
  }

  return { ok: true, projectRef: stagingRef, host: `${stagingRef}.supabase.co` }
}

/**
 * The convenience wrapper for a script: check the real environment, print the
 * refusal, and stop.
 *
 * Returns the safe identifiers on success -- the ref and the host, and nothing
 * else. The URL and the keys stay with the caller, so this module never has a
 * credential to leak.
 */
export function requireStagingTarget(
  env: TargetEnv = process.env,
  fail: (message: string) => never = (message) => {
    console.error(`FATAL: ${message}`)
    process.exit(1)
  }
): { projectRef: string; host: string } {
  const decision = checkTarget(env)
  if (!decision.ok) fail(decision.message)
  return { projectRef: decision.projectRef, host: decision.host }
}
