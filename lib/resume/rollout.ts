/**
 * WHICH RESUME BUILDER IS LIVE. One flag, one reader, one meaning.
 *
 * Phase 12 replaces the permanent admin-only dev gate (blueprint decision 12)
 * with a rollout mode, because cutover needs three states and the old gate had
 * two: V1 for everyone, V1 for users while admins test V2, and V2 for
 * everyone. The middle state is the whole point -- it is what lets the legacy
 * data migration run and be validated while normal users are still on V1.
 *
 * THE FLAG IS SERVER-SIDE ONLY, and there is deliberately no NEXT_PUBLIC_
 * mirror of it. A second copy readable by the browser is a second thing that
 * can disagree with the first, and a rollout flag that disagrees with itself is
 * worse than no flag: the UI would offer V2 while the server refused it, or
 * hide V1 while the server still served it. Everything that acts on the mode
 * is a Server Component or a route handler, so one server-side value is enough.
 *
 * FAILURE IS SAFE BY CONSTRUCTION. Unset, misspelled, empty, or set to
 * anything that is not exactly "v2" means v1. There is no way to arrive in v2
 * mode by accident -- only by writing the one string that means it.
 *
 * WHAT IT DOES NOT DO. It does not touch entitlements. Free/Premium/Ultimate
 * and the finalize + export gate are resolved from the database in
 * lib/resume/entitlement.ts and are identical in both modes: a rollout flag
 * decides which BUILDER a user sees, never what they are allowed to do in it.
 *
 * ROLLBACK. Setting the flag back to v1 returns every normal user to V1 with
 * no data change of any kind -- V2 rows stay where they are, V1 rows were
 * never touched, and V1's own queries filter V2 rows out (see
 * legacyResumeFilter below). On Vercel an environment change takes effect on
 * the next deployment, so rollback is a redeploy, not a database operation.
 */

export type ResumeBuilderMode = 'v1' | 'v2'

/** The name of the one environment variable. Exported so tests can assert it. */
export const RESUME_BUILDER_MODE_ENV = 'RESUME_BUILDER_MODE'

/** What an absent, unreadable or unrecognised value means. */
export const DEFAULT_MODE: ResumeBuilderMode = 'v1'

/**
 * Pure. Anything that is not exactly "v2" (after trimming and lower-casing) is
 * v1, including "V2 " with a stray space, "true", "2", and undefined.
 */
export function parseMode(raw: string | null | undefined): ResumeBuilderMode {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'v2' ? 'v2' : DEFAULT_MODE
}

/**
 * THE single read of the environment. Every caller goes through here, so
 * grepping for RESUME_BUILDER_MODE finds exactly one place that consults it.
 */
export function resumeBuilderMode(): ResumeBuilderMode {
  return parseMode(process.env[RESUME_BUILDER_MODE_ENV])
}

export type LegacyDisposition =
  | { readonly visible: true }
  | { readonly visible: false; readonly redirectTo: '/resume-studio' }

/**
 * What happens to the V1 builder's pages in each mode.
 *
 * In v2 mode V1 is REDIRECTED, not deleted and not left reachable. Redirecting
 * means the old bookmarks, the sidebar link and the dashboard card all land on
 * the Studio without any of them having to know the mode -- which is why no
 * client component needs the flag. It also means the V1 code is still there,
 * one environment variable away from serving again, for the 30-day emergency
 * rollback window.
 */
export function legacyBuilderDisposition(mode: ResumeBuilderMode): LegacyDisposition {
  return mode === 'v2' ? { visible: false, redirectTo: '/resume-studio' } : { visible: true }
}

/**
 * The PostgREST filter that keeps V2 rows out of V1's lists and editors.
 *
 * Once the writer has run, a user's `resumes` rows are a mix of generations.
 * V1 selects `*` with no schema_version predicate, so without this it would
 * list every migrated resume a second time, and -- far worse -- let its editor
 * open one and overwrite V2 section data with V1 shapes on the next save.
 *
 * `schema_version is null` is in the filter on purpose. The column is added by
 * migration 001 with `not null default 1`, so nothing should be null; the
 * clause costs nothing and means V1 keeps working unchanged if this filter
 * somehow ships before that migration is applied.
 */
export const LEGACY_SCHEMA_FILTER = 'schema_version.is.null,schema_version.eq.1'
