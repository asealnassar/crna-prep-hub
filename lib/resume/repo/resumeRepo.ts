/**
 * The only module that reads or writes V2 resume rows.
 *
 * Deliberately thin. Every decision -- what a row means, whether a write may
 * proceed, which rows are orphaned -- lives in the pure modules beside it and
 * is unit-tested without a database. What remains here is the wiring, in the
 * same shape as lib/interview's route shell: authenticate upstream, decide
 * with a pure function, then persist.
 *
 * The client is supplied by the caller rather than constructed here, so a
 * route can pass a request-scoped client carrying the user's JWT and RLS stays
 * in force. Nothing in this file creates a service-role client. The one
 * resume route that ever did was retired in 123981b for exactly that reason.
 *
 * NOT YET WIRED TO ANYTHING. Phase 2 builds the layer; Phase 3 is the first
 * caller. It is exercised here only by its pure collaborators' tests.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResumeV2 } from '../model/types.ts'
import {
  V2_SCHEMA_VERSION, contactRowId, fromRows, toSavePayload,
} from './rows.ts'
import type { ReadResult, ResumeRow, SectionRow } from './rows.ts'
import { decideWrite } from './concurrency.ts'
import type { StoredResumeState, WriteDecision } from './concurrency.ts'

const RESUMES = 'resumes'
const SECTIONS = 'resume_sections'

/** Columns V2 reads. Named explicitly so a schema addition cannot surprise us. */
const RESUME_COLUMNS =
  'id, user_id, title, template_id, created_at, updated_at, schema_version, status, revision, strength_score, strength_computed_at, strength_revision'
const SECTION_COLUMNS =
  'id, resume_id, section_type, section_data, order_index, visible, label'

export type RepoResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly reason: string
      readonly detail: string
      /** Set only on 'stale-revision': the revision the database actually
       *  holds, so a caller can resync without a second round trip that could
       *  race with yet another writer. */
      readonly storedRevision?: number
    }

function failure(reason: string, detail: unknown): RepoResult<never> {
  // Code and message only. A PostgREST error's `details` can echo the row that
  // failed, which for a resume is a name, an email address and a phone number.
  const err = detail as { code?: string; message?: string } | null
  return { ok: false, reason, detail: `${err?.code ?? ''} ${err?.message ?? ''}`.trim() }
}

/** Lists the caller's V2 resumes. RLS scopes it; the filter keeps V1 out. */
export async function listResumes(
  db: SupabaseClient,
  userId: string
): Promise<RepoResult<ResumeRow[]>> {
  const { data, error } = await db
    .from(RESUMES)
    .select(RESUME_COLUMNS)
    .eq('user_id', userId)
    .eq('schema_version', V2_SCHEMA_VERSION)
    .order('updated_at', { ascending: false })
  if (error) return failure('list-failed', error)
  return { ok: true, value: (data ?? []) as unknown as ResumeRow[] }
}

/** Reads one resume and its sections. Returns a null resume for a V1 row. */
export async function readResume(
  db: SupabaseClient,
  resumeId: string
): Promise<RepoResult<ReadResult>> {
  const { data: row, error: rowError } = await db
    .from(RESUMES).select(RESUME_COLUMNS).eq('id', resumeId).maybeSingle()
  if (rowError) return failure('read-failed', rowError)

  const { data: sections, error: sectionError } = await db
    .from(SECTIONS).select(SECTION_COLUMNS).eq('resume_id', resumeId).order('order_index')
  if (sectionError) return failure('read-failed', sectionError)

  return {
    ok: true,
    value: fromRows(
      (row ?? null) as unknown as ResumeRow | null,
      (sections ?? []) as unknown as SectionRow[]
    ),
  }
}

/** The stored state a write decision needs, without reading the whole resume. */
export async function readWriteState(
  db: SupabaseClient,
  resumeId: string
): Promise<RepoResult<StoredResumeState | null>> {
  const { data, error } = await db
    .from(RESUMES).select('user_id, revision, schema_version').eq('id', resumeId).maybeSingle()
  if (error) return failure('read-failed', error)
  if (!data) return { ok: true, value: null }
  const row = data as { user_id: string; revision: number | string; schema_version: number }
  return {
    ok: true,
    value: {
      userId: row.user_id,
      revision: Number(row.revision) || 1,
      schemaVersion: Number(row.schema_version) || 1,
    },
  }
}

/**
 * Saves a resume. One call, one transaction, all or nothing.
 *
 * The whole write -- the parent row, every section, and the removal of
 * sections the applicant deleted -- happens inside save_resume_v2. Doing it
 * from here as separate PostgREST calls could not be atomic, and left three
 * real failure modes: a committed parent with stale sections, deleted
 * sections reappearing, and an in-flight section write landing on top of a
 * newer save from another tab. See 20260910_002 for the full account.
 *
 * `decideWrite` is still used, but only as a pre-flight courtesy: it turns the
 * common refusals into a specific message before spending a round trip. The
 * authority is the compare-and-swap inside the function, and this code trusts
 * the function's answer over its own.
 *
 * WHY `expectedRevision` IS A PARAMETER AND NOT `resume.revision`. The two are
 * different numbers as soon as anything is edited. Every model mutator bumps
 * `resume.revision` -- that field counts CONTENT versions, and three edits make
 * it stored+3. What the compare-and-swap needs is the revision the caller last
 * READ, which only the caller knows. Passing the resume's own field would make
 * the first edit self-conflict and every later edit conflict harder. The caller
 * gets this number from the read that produced the document, or from the
 * revision the previous save returned.
 */
export async function saveResume(
  db: SupabaseClient,
  resume: ResumeV2,
  expectedRevision: number,
  actingUserId: string
): Promise<RepoResult<{ revision: number }>> {
  const payload = toSavePayload(resume)

  const { data, error } = await db.rpc('save_resume_v2', {
    p_resume_id: resume.id,
    p_expected_revision: expectedRevision,
    p_resume: payload.resume,
    p_sections: payload.sections,
  })
  if (error) return failure('save-failed', error)

  const result = data as SaveRpcResult | null
  if (!result || typeof result.ok !== 'boolean') {
    return { ok: false, reason: 'save-failed', detail: 'unrecognised response' }
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason ?? 'save-failed',
      detail: result.detail ?? '',
      ...(typeof result.stored_revision === 'number'
        ? { storedRevision: result.stored_revision }
        : {}),
    }
  }
  // `actingUserId` is not sent: ownership is RLS's answer, not a claim the
  // client makes. It stays in the signature so callers cannot forget who they
  // authenticated, and so pre-flight checks have it.
  void actingUserId
  return { ok: true, value: { revision: Number(result.revision) } }
}

/** What save_resume_v2 returns. Mirrors the jsonb the function builds. */
interface SaveRpcResult {
  ok: boolean
  reason?: string
  detail?: string
  revision?: number
  stored_revision?: number
}

/**
 * Optional pre-flight. Reads the stored state and decides locally, so the UI
 * can say "reload, someone else saved" without a round trip that will fail.
 *
 * Never a substitute for the save itself -- between this read and that write
 * anything may happen, which is precisely why the function re-checks.
 */
export async function previewWrite(
  db: SupabaseClient,
  resumeId: string,
  expectedRevision: number,
  actingUserId: string
): Promise<RepoResult<WriteDecision>> {
  const state = await readWriteState(db, resumeId)
  if (!state.ok) return state
  return {
    ok: true,
    value: decideWrite({ stored: state.value, actingUserId, expectedRevision }),
  }
}

/**
 * Creates a new V2 resume and its sections. One call, one transaction.
 *
 * Ownership is not passed: the function reads auth.uid() itself, so a client
 * cannot create a resume for another user or attach sections to one. The
 * server also sets schema_version, revision and both timestamps.
 *
 * This replaced two inserts with a compensating delete. If that delete had
 * ever failed -- on the same network that just dropped the section insert --
 * the result was a parent row with no sections, which renders as an empty
 * document. See 20260910_003.
 */
export async function createResumeRows(
  db: SupabaseClient,
  resume: ResumeV2
): Promise<RepoResult<{ id: string; revision: number }>> {
  const payload = toSavePayload(resume)

  const { data, error } = await db.rpc('create_resume_v2', {
    p_resume_id: resume.id,
    p_resume: payload.resume,
    p_sections: payload.sections,
  })
  if (error) return failure('create-failed', error)

  const result = data as CreateRpcResult | null
  if (!result || typeof result.ok !== 'boolean') {
    return { ok: false, reason: 'create-failed', detail: 'unrecognised response' }
  }
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? 'create-failed', detail: result.detail ?? '' }
  }
  return { ok: true, value: { id: String(result.id), revision: Number(result.revision) } }
}

/** What create_resume_v2 returns. Mirrors the jsonb the function builds. */
interface CreateRpcResult {
  ok: boolean
  reason?: string
  detail?: string
  id?: string
  revision?: number
}

/**
 * Stores a computed Resume Strength.
 *
 * A SCOPED UPDATE, not a save. Going through `save_resume_v2` would bump the
 * revision, and the revision is exactly what decides whether a score is stale --
 * so storing a score would immediately mark it out of date. Writing only the
 * three strength columns leaves the document's revision where it was.
 *
 * One statement, so it is atomic without an RPC, and RLS scopes it to the
 * owner. `strength_revision` records which revision the number describes.
 */
export async function saveStrength(
  db: SupabaseClient,
  resumeId: string,
  strength: { readonly score: number; readonly computedAt: string; readonly computedAtRevision: number }
): Promise<RepoResult<null>> {
  const { error } = await db
    .from(RESUMES)
    .update({
      strength_score: strength.score,
      strength_computed_at: strength.computedAt,
      strength_revision: strength.computedAtRevision,
    })
    .eq('id', resumeId)
    .eq('schema_version', V2_SCHEMA_VERSION)
  if (error) return failure('strength-save-failed', error)
  return { ok: true, value: null }
}

/** Deletes a resume. The FK cascade removes its sections and any score row. */
export async function deleteResume(
  db: SupabaseClient,
  resumeId: string
): Promise<RepoResult<null>> {
  const { error } = await db.from(RESUMES).delete().eq('id', resumeId)
  if (error) return failure('delete-failed', error)
  return { ok: true, value: null }
}

export { contactRowId }
