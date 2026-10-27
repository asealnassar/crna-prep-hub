import { simulatedLiveEnabled } from '../devMode/gate.ts'
/**
 * Whether applicant-submitted prompts are switched on.
 *
 * WHY THIS EXISTS AT ALL. The feature's four migrations are written but not
 * applied, and the localhost this is developed against talks to the production
 * database. Every code path that names statement_prompt_submissions, or the
 * statement_drafts.prompt_submission_id column, or any of the three functions,
 * fails against a database that has not run them -- PostgREST answers an
 * unknown column or an unknown function with an error, not with a null.
 *
 * So the feature ships DARK. With the variable unset -- which is every
 * environment today, including the owner's localhost -- this returns false and
 * not one new query is issued: general drafts, approved-prompt drafts, the
 * library, the editor and the existing POST all take byte-for-byte the paths
 * they take now. Turning it on is a deliberate act AFTER the migrations run.
 *
 * DELIBERATELY NOT A BUILD-TIME CONSTANT. It is read per call from the live
 * environment, exactly as statementStudioMode() is, so flipping it needs a
 * restart rather than a rebuild and the two gates behave the same way.
 *
 * FAILING CLOSED IS THE WHOLE POINT. Anything other than the exact string 'on'
 * is off, including 'true', '1', 'ON' and a trailing space. A rollout flag that
 * guesses is a rollout flag that turns itself on.
 */
export const PROMPT_SUBMISSIONS_ENV = 'STATEMENT_PROMPT_SUBMISSIONS'

export function promptSubmissionsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // SIMULATED LIVE ANSWERS AS THOUGH THE ROLLOUT HAD HAPPENED, exactly as
  // requirementsEnabled() below does.
  //
  // THIS IS THE LINE THE FEATURE WAS LOST ON. Applicant-submitted prompts were
  // built, migrated and tested, and then V2 gave requirementsEnabled() a
  // development branch so the catalog could be reviewed on localhost -- and
  // this function did not get one. The result was a localhost where the
  // requirement path is live and the "we do not have your school's prompt yet"
  // path returns 404, which reads as a missing feature rather than an unset
  // flag. Nothing was removed; one branch was never added.
  //
  // THE GATE IS NODE_ENV, so a deployed build cannot reach this and the real
  // flag remains the only thing that releases anything.
  //
  // THE ENV IS THREADED THROUGH, so this function's own parameter decides the
  // whole answer. Reading process.env for half the decision would make
  // promptSubmissionsEnabled({ NODE_ENV: 'production' }) return true inside a
  // development process -- a test asserting the production answer would pass or
  // fail depending on which process ran it.
  if (simulatedLiveEnabled(env)) return true
  return env[PROMPT_SUBMISSIONS_ENV] === 'on'
}

/**
 * Whether stored analysis results are switched on.
 *
 * A SECOND, INDEPENDENT FLAG. Applicant-submitted prompts and the analysis
 * cache are different features with different migrations, and tying them to one
 * variable would mean turning on whichever was ready last.
 *
 * OFF MEANS NO QUERY NAMES THE TABLE. 20261002_004 is written but not applied,
 * so public.statement_analyses and its two functions do not exist; with this
 * unset the route takes a different path rather than catching an error, which
 * is what keeps the current editor working against the unmigrated database.
 *
 * AND OFF DOES NOT MEAN "ANALYSE REPEATEDLY WITHOUT SAYING SO". With the cache
 * off every request is a fresh model call, exactly as today -- that is the
 * behaviour being replaced, not a silent fallback introduced by this feature.
 * What must never happen is the cache being ON and quietly degrading to repeat
 * paid calls when a query fails; the route treats that as a failure.
 *
 * FAILS CLOSED, like promptSubmissionsEnabled: anything but the exact string
 * 'on' is off.
 */
export const ANALYSIS_CACHE_ENV = 'STATEMENT_ANALYSIS_CACHE'

export function analysisCacheEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ANALYSIS_CACHE_ENV] === 'on'
}

/**
 * Whether the structured school-requirement catalog is switched on.
 *
 * A THIRD, INDEPENDENT FLAG, for the same reason the second one exists.
 * Applicant-submitted prompts, the analysis cache and the requirement catalog
 * are three features with three migrations, and one variable would mean turning
 * on whichever was ready last. Nothing here touches PROMPT_SUBMISSIONS_ENV or
 * its migrations.
 *
 * OFF MEANS NO QUERY NAMES THE NEW TABLES. 20261002_005 is written but not
 * applied, so public.statement_requirement_sets, public.statement_requirements
 * and the two new statement_drafts columns do not exist. With this unset the
 * picker reads statement_prompts exactly as it does today and no draft is
 * written with a requirement -- which is what keeps the live Arkansas State
 * prompt, and every saved draft, working against the unmigrated database.
 *
 * AND OFF LOSES NOTHING THAT EXISTS. The single-prompt path is not a degraded
 * mode; it is the shipped product. This flag adds a capability rather than
 * replacing one, so the off state is simply today.
 *
 * FAILS CLOSED, like both flags above: anything but the exact string 'on' is off.
 */
/**
 * Whether the richer applicant submission fields are switched on.
 *
 * A FOURTH, INDEPENDENT FLAG, for the reason the other three are independent:
 * 20261006_008 is written and NOT applied, so document_label,
 * document_type_hint, the three extra bounds, stated_pages_text, the two
 * instruction fields, submitter_note and approved_requirement_id do not exist
 * yet. Naming one in a PostgREST select fails the WHOLE request with a 42703
 * rather than degrading, so the review queue would stop working entirely
 * instead of losing a field -- and passing an unknown named parameter to the
 * creation function fails to match an overload at all.
 *
 * So both the projection and the parameter list are computed from this flag.
 * Off, and every query is byte-identical to the one shipped today.
 *
 * FAILS CLOSED, like the other three: anything but the exact string 'on' is off.
 */
export const SUBMISSION_FIELDS_ENV = 'STATEMENT_SUBMISSION_FIELDS'

export function submissionFieldsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Simulated live answers as though 008 had been applied, because the local
  // store serves the columns; see lib/statement/devMode/localSubmissions.ts.
  // The env is threaded through for the reason promptSubmissionsEnabled gives.
  if (simulatedLiveEnabled(env)) return true
  return env[SUBMISSION_FIELDS_ENV] === 'on'
}

/**
 * Whether a submission may declare itself a report about an existing row.
 *
 * SAME SHAPE, SAME REASON AS 008'S FLAG. Migration 012 adds submission_kind
 * and challenged_requirement_id; naming either in a select or passing either
 * as a named parameter fails the whole request against a database that does
 * not have them. So the projection and the parameter list are computed from
 * this flag, and off means byte-identical to today.
 *
 * FAILS CLOSED: anything but the exact string 'on' is off.
 */
export const PROMPT_CHANGE_REPORTS_ENV = 'STATEMENT_PROMPT_CHANGE_REPORTS'

export function promptChangeReportsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Simulated live answers as though 012 had been applied, because the local
  // store serves the columns; see lib/statement/devMode/localSubmissions.ts.
  if (simulatedLiveEnabled(env)) return true
  return env[PROMPT_CHANGE_REPORTS_ENV] === 'on'
}

/**
 * Whether a draft may carry a constrained editor document.
 *
 * SAME SHAPE, SAME REASON as the other column flags. Migration 013 adds
 * editor_document and editor_document_version; writing either against a
 * database that lacks them fails the whole UPDATE, which would stop autosave
 * entirely rather than lose formatting. Off means the body's document is
 * accepted, validated and then not stored -- the essay still saves.
 *
 * FAILS CLOSED: anything but the exact string 'on' is off.
 */
export const EDITOR_DOCUMENTS_ENV = 'STATEMENT_EDITOR_DOCUMENTS'

export function editorDocumentsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Simulated live answers as though 013 had been applied, because the local
  // draft store serves the columns.
  if (simulatedLiveEnabled(env)) return true
  return env[EDITOR_DOCUMENTS_ENV] === 'on'
}

/**
 * Whether a draft may carry a chosen font.
 *
 * SAME SHAPE, SAME REASON as the other column flags. Migration 015 adds
 * document_font; writing it against a database that lacks it fails the whole
 * UPDATE, which would stop autosave rather than lose a preference. Off means
 * the body's font is accepted, validated and then not stored -- the essay
 * still saves, and the editor still renders the Studio default.
 *
 * FAILS CLOSED: anything but the exact string 'on' is off.
 */
export const DOCUMENT_FONT_ENV = 'STATEMENT_DOCUMENT_FONT'

export function documentFontEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Simulated live answers as though 015 had been applied, because the local
  // draft store serves the column.
  if (simulatedLiveEnabled(env)) return true
  return env[DOCUMENT_FONT_ENV] === 'on'
}

/**
 * Whether a requirement set may say WHAT it was published on.
 *
 * SAME SHAPE, SAME REASON as the other column flags. Migration 011 adds
 * evidence_kind and evidence_submission_id; naming either in a select against
 * a database that lacks them fails the whole request with a 42703 rather than
 * degrading, which would take the catalog down.
 *
 * OFF IS NOT HARMLESS HERE, WHICH IS WHY THE FLAG EXISTS AT ALL. With the
 * column unselected every set reads as 'official-source', so a prompt
 * published from an applicant's submission is described to applicants as
 * "Quoted from the school's application materials" -- the exact false claim
 * 011 was written to keep visible. Nothing in production has been published
 * that way yet, so the degradation is currently inert there; locally the
 * column exists and the flag is forced on so the real wording is exercised.
 *
 * FAILS CLOSED: anything but the exact string 'on' is off.
 */
export const SUBMISSION_EVIDENCE_ENV = 'STATEMENT_SUBMISSION_EVIDENCE'

export function submissionEvidenceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (simulatedLiveEnabled(env)) return true
  return env[SUBMISSION_EVIDENCE_ENV] === 'on'
}

/**
 * Whether a requirement may offer the FONTS AND SIZES a school permits.
 *
 * SAME SHAPE, SAME REASON as every other column flag. Migration 010 adds
 * font_family_options and font_size_pt_options; naming either in a select
 * against a database that lacks them fails the whole request with a 42703, so
 * the catalog would go down everywhere 010 is unapplied -- which is
 * everywhere.
 *
 * OFF IS HARMLESS HERE, UNLIKE THE EVIDENCE FLAG. With the columns unselected
 * both option sets read as absent, which is exactly the state of a school that
 * permitted nothing in particular: the single required family or size is still
 * read and applied. Nothing is misdescribed, only unoffered.
 *
 * FAILS CLOSED: anything but the exact string 'on' is off.
 */
export const TYPOGRAPHY_OPTIONS_ENV = 'STATEMENT_TYPOGRAPHY_OPTIONS'

export function typographyOptionsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (simulatedLiveEnabled(env)) return true
  return env[TYPOGRAPHY_OPTIONS_ENV] === 'on'
}

/**
 * Whether a requirement may name a WHOLE-DOCUMENT format standard.
 *
 * Migration 014 adds document_format_profile. Same 42703 hazard, same
 * fail-closed rule.
 *
 * OFF IS HARMLESS, AND VISIBLY SO. With the column unselected the profile
 * reads as null, and a null profile is what every document had before 014:
 * the citation style is still shown as the school's own instruction and the
 * geometry still comes from the Studio's defaults. The APA page layout is
 * simply not applied -- an absence, never a false claim.
 *
 * FAILS CLOSED: anything but the exact string 'on' is off.
 */
export const FORMAT_PROFILE_ENV = 'STATEMENT_FORMAT_PROFILE'

export function formatProfileEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (simulatedLiveEnabled(env)) return true
  return env[FORMAT_PROFILE_ENV] === 'on'
}

export const REQUIREMENTS_ENV = 'STATEMENT_REQUIREMENTS'

export function requirementsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // SIMULATED LIVE answers as though the rollout had happened, so the whole
  // feature -- the catalog read, the draft's requirement columns, the
  // checklist -- behaves on localhost as it will after release. The gate is
  // NODE_ENV, so a deployed build can never reach this branch and the real
  // flag remains the only thing that releases anything.
  // The env is threaded through for the reason promptSubmissionsEnabled gives.
  if (simulatedLiveEnabled(env)) return true
  return env[REQUIREMENTS_ENV] === 'on'
}
