/**
 * Whether a requirement-backed draft's question really came from the catalog.
 *
 * WHY THIS CANNOT BE READ OFF THE DRAFT. public.statement_drafts grants
 * `authenticated` table-level UPDATE and has an own-rows UPDATE policy, which
 * is correct -- an applicant edits their own draft -- and which also means an
 * applicant can PATCH their own row directly through PostgREST and put anything
 * they like in requirement_id and requirement_snapshot. A snapshot whose
 * `verification` field says `status: 'verified'` with a plausible source URL is
 * therefore worth exactly nothing: the browser wrote it.
 *
 * SO PROVENANCE IS ESTABLISHED BY READING THE CATALOG, never by believing the
 * draft. Four things must all hold before this returns 'catalog':
 *
 *   1. The requirement id resolves to a row the CALLER CAN SEE. The read uses
 *      the caller's own JWT, and the RLS policy admits a requirement only when
 *      its own is_active is true AND its set's is_active is true. The
 *      migration's CHECK makes an active set necessarily verified with a source
 *      and a date, so "visible" already implies "authorized".
 *   2. The SET's verification passes activatableForApplicants() -- re-checked
 *      here against the catalog's own columns rather than the snapshot's,
 *      because the whole point is not to trust the snapshot.
 *   3. The stored wording still MATCHES the catalog's current wording, by the
 *      same equality provenanceOf() uses for prompts. A snapshot that has
 *      drifted describes a question the catalog no longer asks, and this
 *      product does not vouch for it.
 *   4. The snapshot's school agrees with the catalog row's school, so a
 *      requirement cannot be presented as belonging to a school it does not.
 *   5. EVERY FIELD THIS PRODUCT ATTRIBUTES TO THE SCHOOL matches the catalog,
 *      compared as one canonical digest. Conditions 1-4 were not enough: they
 *      authenticated the id, the school and the top-level prompt text, and
 *      left the rest of the snapshot unchecked. The rest of the snapshot is
 *      most of what the analyser actually reads -- the numbered components
 *      that become <prompt-requirements>, the word and character limits, the
 *      free-text formatting instructions, the document label, the choice
 *      group, and the notes that are quoted as "the catalog records unresolved
 *      uncertainty". An applicant holding owner UPDATE on their own draft row
 *      could rewrite any of those, keep the three authenticated fields
 *      untouched, and be handed an analysis stamped 'catalog'.
 *
 * ANYTHING ELSE FAILS CLOSED TO 'user'. A missing row, an inactive one, a read
 * error, a disabled rollout flag, drifted wording, a mismatched school: all of
 * them mean "this product has not verified this question", which is what 'user'
 * means and is the safe direction to be wrong in.
 *
 * IT CANNOT RETURN null FOR A REQUIREMENT-BACKED DRAFT. null means "there is no
 * question" and is reserved for general statements; a requirement-backed draft
 * always has one, so the answer is 'catalog' or 'user'.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { requirementsEnabled } from '../draft/rollout.ts'
import { provenanceOf, type PromptOrigin } from '../draft/promptSubmission.ts'
import {
  activatableForApplicants, evidenceKindFrom, isIsoDate, type VerificationStatus,
} from './verification.ts'
import { snapshotOf, type RequirementSnapshot } from './snapshot.ts'
import { REQUIREMENT_READ_COLUMNS, requirementFromRow } from './repo.ts'
import { requirementDigest } from './digest.ts'

/** Why a requirement could not be authenticated. For logs, never for a reader. */
export type ProvenanceRefusal =
  | 'disabled'
  | 'not-found'
  | 'read-failed'
  | 'set-not-verified'
  | 'school-mismatch'
  | 'text-drifted'
  /** A catalog row this build cannot read. Fails closed like everything else. */
  | 'unreadable-catalog-row'
  /** The identifiers and the prompt text match; something else does not. */
  | 'contents-differ'

export interface RequirementProvenance {
  readonly origin: PromptOrigin
  /** Present only when the origin fell back to 'user'. */
  readonly refusal: ProvenanceRefusal | null
}

const UNVERIFIED_RESULT = (refusal: ProvenanceRefusal): RequirementProvenance =>
  ({ origin: 'user', refusal })

/**
 * The catalog's verdict on one requirement-backed draft.
 *
 * TWO READS, BOTH WITH THE CALLER'S CLIENT. The requirement, then its set. The
 * set is read separately rather than embedded because its verification columns
 * are the ones condition 2 tests, and an embedded select would make the shape
 * of that answer depend on a relationship the planner infers.
 */
export async function requirementProvenance(
  db: SupabaseClient,
  snapshot: RequirementSnapshot
): Promise<RequirementProvenance> {
  // The tables do not exist until 20261002_005 is applied, so there is nothing
  // to authenticate against and nothing may be vouched for.
  if (!requirementsEnabled()) return UNVERIFIED_RESULT('disabled')

  const found = await db
    .from('statement_requirements')
    // THE WHOLE ROW, because condition 5 compares the whole requirement. An
    // earlier version selected four columns, which is exactly why the rest of
    // the snapshot went unauthenticated.
    .select(REQUIREMENT_READ_COLUMNS.REQUIREMENT_COLUMNS)
    .eq('id', snapshot.requirementId)
    .maybeSingle()
  // A READ ERROR IS NOT A VERIFICATION. Failing open here would mean a dropped
  // connection could make a fabricated requirement look official.
  if (found.error) return UNVERIFIED_RESULT('read-failed')
  // RLS already refused an inactive requirement or one whose set is inactive,
  // so "not visible" and "absent" are the same answer and both mean no.
  if (found.data === null) return UNVERIFIED_RESULT('not-found')

  const row = found.data as unknown as Record<string, unknown>
  const catalogSchool = typeof row.school_id === 'string' ? row.school_id : null
  const catalogText = typeof row.prompt_text === 'string' ? row.prompt_text : null
  const setId = typeof row.set_id === 'string' ? row.set_id : null
  if (setId === null) return UNVERIFIED_RESULT('not-found')

  // CONDITION 4, checked before the wording: a requirement that belongs to
  // another school is not this draft's requirement whatever its text says.
  if (catalogSchool === null || catalogSchool !== snapshot.schoolId) {
    return UNVERIFIED_RESULT('school-mismatch')
  }

  const setRow = await db
    .from('statement_requirement_sets')
    // application_cycle and notes are needed to RECONSTRUCT the snapshot the
    // catalog would produce today, because snapshotOf() folds the set's notes
    // in with the document's.
    .select(REQUIREMENT_READ_COLUMNS.setColumns())
    .eq('id', setId)
    .maybeSingle()
  if (setRow.error) return UNVERIFIED_RESULT('read-failed')
  if (setRow.data === null) return UNVERIFIED_RESULT('not-found')

  const setFields = setRow.data as unknown as Record<string, unknown>
  const statusRaw = typeof setFields.verification_status === 'string'
    ? setFields.verification_status
    : null
  const known: readonly VerificationStatus[] =
    ['unverified', 'needs-review', 'verified', 'conflicting']
  // CONDITION 2, AGAINST THE CATALOG'S OWN COLUMNS. An unrecognised status
  // degrades to 'unverified' rather than to 'verified', so a newer catalog
  // writing a status this build does not know cannot be read as an
  // endorsement.
  const status: VerificationStatus = (known as readonly string[]).includes(statusRaw ?? '')
    ? (statusRaw as VerificationStatus)
    : 'unverified'

  const verified = activatableForApplicants({
    status,
    sourceUrl: typeof setFields.source_url === 'string' ? setFields.source_url : null,
    verifiedOn: isIsoDate(setFields.verified_on) ? setFields.verified_on : null,
    // Not part of activation: nothing here reads it.
    verbatim: false,
    /*
      AND THE EVIDENCE KIND IS PART OF ACTIVATION, WHICH IT DID NOT USED TO BE.

      The comment here said the stored value was irrelevant to this test, and
      that stopped being true when activatableForApplicants learned that an
      approved applicant submission is activatable WITHOUT a source URL --
      those rows have no school page to link. Passing the literal meant a
      promoted submission failed condition 2 and every draft against one was
      reported unverified.
    */
    evidenceKind: evidenceKindFrom(setFields.evidence_kind),
  })
  if (!verified) return UNVERIFIED_RESULT('set-not-verified')

  // CONDITION 3, by the SAME equality the prompt path uses, so a catalog prompt
  // and a catalog requirement are held to one standard. Checked before the
  // digest so that the commonest honest difference -- a school reworded its
  // question -- reports the reason a reader would expect.
  const origin = provenanceOf({ promptText: snapshot.promptText, catalogText })
  if (origin !== 'catalog') return UNVERIFIED_RESULT('text-drifted')

  // ---- CONDITION 5: the whole attributed requirement ----------------------
  //
  // THE CATALOG'S OWN ROW IS REBUILT INTO A SNAPSHOT and the two are compared
  // as one canonical digest. Rebuilding rather than comparing field by field is
  // what keeps this honest as the model grows: a new constraint column added to
  // statement_requirements lands in requirementDigest automatically, so it
  // cannot be forgotten here and silently become un-authenticated.
  //
  // snapshotOf() IS THE SAME FUNCTION THE CREATE PATH USES, so the
  // reconstruction is built exactly as the original was -- including the way it
  // concatenates the set's notes with the document's. Two different builders
  // would disagree about that and every draft would fail authentication.
  const catalogRequirement = requirementFromRow(row)
  if (catalogRequirement === null) return UNVERIFIED_RESULT('unreadable-catalog-row')

  const catalogSnapshot = snapshotOf(
    {
      id: setId,
      schoolId: catalogSchool,
      // Not digested: see requirementDigest's note on what is left out.
      schoolName: '',
      applicationCycle: typeof setFields.application_cycle === 'string'
        ? setFields.application_cycle
        : null,
      verification: {
        // NOT DIGESTED, all four of them: see requirementDigest's note on what
        // the comparison deliberately leaves out. These are placeholders in a
        // value that exists only to be hashed, not shown.
        status, sourceUrl: null, verifiedOn: null, verbatim: false,
        evidenceKind: 'official-source',
      },
      originalText: '',
      requirements: [],
      notes: Array.isArray(setFields.notes)
        ? setFields.notes.filter((note): note is string => typeof note === 'string')
        : [],
    },
    catalogRequirement,
  )

  if (requirementDigest(snapshot) !== requirementDigest(catalogSnapshot)) {
    return UNVERIFIED_RESULT('contents-differ')
  }

  return { origin: 'catalog', refusal: null }
}

/**
 * Provenance for any draft, AND whether its requirement may be treated as the
 * school's.
 *
 * ONE ENTRY POINT, SO NO CALLER CHOOSES. The route asks this and gets the right
 * answer for whichever kind of draft it holds; there is no branch in the route
 * that could be written the wrong way round, and the legacy path is reached by
 * exactly the drafts that had it before.
 *
 * `authentic` IS THE FIELD THAT CLOSED THE TAMPERING HOLE. Provenance alone was
 * not enough to act on: the route still read the snapshot's components, limits
 * and notes to build the model prompt and to decide eligibility, whatever
 * provenance said. So the verdict is returned explicitly, and the route refuses
 * to give an unauthenticated snapshot any authority at all.
 *
 * IT IS false FOR EVERY DRAFT THAT HAS NO STRUCTURED REQUIREMENT, which is the
 * safe default: a legacy, pasted or general draft has no catalog requirement to
 * authenticate, and nothing should start reading one off it.
 */
export interface DraftProvenance {
  readonly provenance: PromptOrigin | null
  /**
   * True only when the stored snapshot's attributed contents are identical to
   * what the catalog publishes right now. False for a legacy draft, a general
   * draft, a drifted snapshot and a tampered one alike.
   */
  readonly authentic: boolean
  /** Why authentication was refused. For logs and for the editor's label. */
  readonly refusal: ProvenanceRefusal | null
}

export async function draftProvenance(
  db: SupabaseClient,
  draft: {
    readonly promptId: string | null
    readonly promptText: string | null
  },
  snapshot: RequirementSnapshot | null,
  /** The existing prompt-path verifier, injected so this module imports no repo. */
  verifyPrompt: (
    db: SupabaseClient,
    draft: { readonly promptId: string | null; readonly promptText: string | null },
  ) => Promise<PromptOrigin | null>
): Promise<DraftProvenance> {
  if (snapshot !== null) {
    const result = await requirementProvenance(db, snapshot)
    return {
      provenance: result.origin,
      // AUTHENTIC ONLY ON THE ONE OUTCOME THAT CHECKED EVERYTHING. Deriving it
      // from `origin === 'catalog'` would be the same thing today and would
      // quietly stop being the same thing if a future refusal returned
      // 'catalog' with a caveat.
      authentic: result.origin === 'catalog' && result.refusal === null,
      refusal: result.refusal,
    }
  }
  return {
    provenance: await verifyPrompt(db, draft),
    authentic: false,
    refusal: null,
  }
}
