/**
 * The only module that reads public.schools for Statement Studio.
 *
 * WHY NOT getPublicSchools(). That function exists, works, and is the right
 * shape for the school DIRECTORY -- but it selects sixteen columns, including
 * tuition, GPA requirements, programme length and prerequisites. A picker needs
 * a name and an id. Reusing it would pull a school's whole free profile into a
 * page that shows a dropdown, and would put this module one refactor away from
 * carrying the paid columns too.
 *
 * AND DEFINITELY NOT select('*'). Four columns on public.schools are paid --
 * application_deadline, gre_requirement, application_method, website_url -- and
 * lib/schools.ts says so. app/schools/SchoolsClient.tsx reads them with a
 * browser `select('*')` and blurs them client-side, which is presentation
 * rather than access control. That pattern is not copied here: this projection
 * names three columns and none of them is paid.
 *
 * THE CLIENT IS THE CALLER'S, never constructed here, so the Studio page passes
 * the request-scoped client it already built with the applicant's own JWT.
 * Nothing in this file creates a service-role client and nothing needs one: the
 * school directory is public reference data.
 *
 * NOTHING HERE IS A WRITE. The legacy schools table, its policies and its
 * grants are untouched by this checkpoint; this module only reads.
 *
 * NOT A PICKER, AND NOT A SEARCH. Filtering and grouping are the UI's business
 * and belong in the checkpoint that renders one. What this returns is the whole
 * list, ordered, so a caller can do either without a second query.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const SCHOOLS = 'schools'

/**
 * Columns this module reads. Named explicitly -- never `*` -- so a schema
 * addition cannot silently start arriving, and so no paid column can reach a
 * page that has no business with one.
 *
 * `location_state` IS HERE FOR DISAMBIGUATION ONLY. Two programmes can share a
 * name, and a picker that offers the same label twice is a picker an applicant
 * cannot use. lib/states.ts records that this column is inconsistent in the
 * data -- mostly two-letter abbreviations, seven full names -- so whatever
 * renders it should normalise through that module rather than printing the raw
 * value. This module returns it as stored.
 */
const SCHOOL_COLUMNS = 'id, name, location_state'

/**
 * The uuid shape a school id must have.
 *
 * DUPLICATED FROM http.ts's UUID, as validate.ts and rows.ts already duplicate
 * it, so that this module depends on nothing but the Supabase client type.
 * schoolPicker.test.ts asserts the two patterns stay character-for-character
 * identical, which is what stops the copies drifting apart.
 */
const SCHOOL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One row of the projection, as PostgREST hands it over. */
export interface SchoolOptionRow {
  id: string | null
  name: string | null
  location_state: string | null
}

/**
 * One school a picker may offer. Three fields, and no more will be added here
 * without a reason stated in this comment.
 *
 * `locationState` null is legitimate: not every row records one.
 */
export interface SchoolOption {
  readonly id: string
  readonly name: string
  readonly locationState: string | null
}

/**
 * Why a school read did not produce a list.
 *
 * TWO CATEGORIES, AND NO 'not-found'. A directory has no "not found" answer:
 * either it can be read or it cannot. 'read-failed' is the database or the
 * network having failed, or a response this code did not expect;
 * 'data-integrity' is a row this application cannot interpret. The same two
 * words promptRepo.ts uses, declared here rather than imported, because a
 * shared result type would be the first thread of coupling a school module to
 * the prompt repository.
 */
export type SchoolRepoRefusal = 'read-failed' | 'data-integrity'

export type SchoolRepoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SchoolRepoRefusal; readonly detail: string }

/**
 * A database error, reduced to something safe to log: CODE AND MESSAGE ONLY.
 * A PostgREST error's `details` and `hint` can echo the row that failed. The
 * same rule draftRepo and promptRepo apply.
 */
function failure(reason: SchoolRepoRefusal, error: unknown): SchoolRepoResult<never> {
  const err = error as { code?: string; message?: string } | null
  return { ok: false, reason, detail: `${err?.code ?? ''} ${err?.message ?? ''}`.trim() }
}

/** A row came back but could not be read. Fixed words: never the row. */
function integrity(where: string): SchoolRepoResult<never> {
  return { ok: false, reason: 'data-integrity', detail: `unusable stored row (${where})` }
}

/**
 * One row as an option, or null when the row cannot be trusted.
 *
 * THE NAME IS RETURNED EXACTLY AS STORED. `trim()` decides whether there is a
 * name at all; what comes back is the school's own text, because an institution
 * writes its own name and this module is not entitled to tidy it.
 *
 * AN ABSENT FIELD IS NOT A NULL ONE. undefined on any of the three means the
 * row did not come from this projection, which would otherwise make every
 * school look state-less -- the kind of invisible wrongness a parser exists to
 * refuse.
 *
 * NO LENGTH CEILING IS INVENTED. public.schools has no migration in this
 * repository, so this module does not know what its CHECKs are and will not
 * guess at one. The floor -- a name must be a name -- is the part that protects
 * a consumer.
 */
export function schoolOptionFromRow(
  row: SchoolOptionRow | null | undefined,
): SchoolOption | null {
  if (!row || typeof row !== 'object') return null

  if (typeof row.id !== 'string' || !SCHOOL_UUID.test(row.id)) return null
  if (typeof row.name !== 'string' || row.name.trim().length === 0) return null

  const state = row.location_state
  if (state !== null) {
    if (typeof state !== 'string') return null
  }

  return { id: row.id, name: row.name, locationState: state }
}

/**
 * Every school a picker may offer, ordered. One statement, and it writes
 * nothing.
 *
 * ORDER: name, THEN id. Names are unique in the current data -- lib/schools.ts
 * says so -- but nothing enforces it, and an unbroken tie would let the list
 * shuffle between two renders of the same data.
 *
 * AN EMPTY ARRAY IS A SUCCESS. A directory with nothing in it is a legitimate
 * answer and must stay distinguishable from a read that failed: a page that
 * showed "no schools" for a dropped connection would tell an applicant this
 * product knows of no CRNA programmes.
 *
 * BUT ZERO ROWS MEANS AN EMPTY ARRAY, AND NOTHING ELSE. A `data` that is null,
 * or is not an array, is 'read-failed'. There is no `?? []` here on purpose --
 * that coercion is exactly how an unexpected response becomes a confident lie.
 *
 * ONE MALFORMED ROW FAILS THE WHOLE LIST. Returning the other hundred and
 * thirty would silently hide a school, and an applicant would conclude their
 * programme is not supported. The same discipline listDrafts and
 * listActivePrompts apply.
 */
export async function listSchoolPickerOptions(
  db: SupabaseClient,
): Promise<SchoolRepoResult<SchoolOption[]>> {
  const { data, error } = await db
    .from(SCHOOLS)
    .select(SCHOOL_COLUMNS)
    .order('name', { ascending: true })
    .order('id', { ascending: true })
  if (error) return failure('read-failed', error)

  if (!Array.isArray(data)) {
    return failure('read-failed', { code: 'NO_ROWS', message: 'select returned no array' })
  }

  const options: SchoolOption[] = []
  for (const row of data as unknown as SchoolOptionRow[]) {
    const option = schoolOptionFromRow(row)
    if (!option) return integrity('school-option')
    options.push(option)
  }
  return { ok: true, value: options }
}
