/**
 * Reading the structured requirement catalog.
 *
 * EVERY FUNCTION HERE IS GATED, AND THE GATE IS NOT DECORATION. 20261002_005 is
 * written and NOT applied, so public.statement_requirement_sets and
 * public.statement_requirements do not exist. Naming an absent table in a
 * PostgREST request does not degrade gracefully -- it fails the request -- so
 * each entry point checks requirementsEnabled() and returns 'disabled' without
 * issuing a query. A caller that ignores the refusal gets no catalog, not a
 * broken one.
 *
 * READS ONLY. There is no insert, update or delete in this module and there is
 * no grant for one either: the migration gives anon and authenticated SELECT
 * and nothing else, and the catalog is populated by an operator in the SQL
 * editor. A browser that could write a requirement could write a sentence into
 * the analysis prompt.
 *
 * CALLER-SCOPED CLIENT, like every other repository here. The db handed in
 * carries the caller's own JWT, so RLS decides what is visible -- which for
 * these tables means active sets only, and the migration's CHECK makes an
 * active set necessarily a verified one with a source and a date. The editorial
 * rule "do not show applicants unverified requirements" and the RLS predicate
 * are therefore the same condition, and this module does not re-implement it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { requirementsEnabled } from '../draft/rollout.ts'
import { NO_CONSTRAINTS, type Citation, type Constraints, type Spacing } from './constraints.ts'
import {
  isDocumentType, type RequirementComponent, type RequirementSet, type WritingRequirement,
} from './requirement.ts'
import { isIsoDate, type Verification, type VerificationStatus } from './verification.ts'

export type RequirementRepoRefusal =
  /** The rollout flag is off. No query was issued. */
  | 'disabled'
  | 'not-found'
  | 'read-failed'
  | 'data-integrity'

export type RequirementRepoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: RequirementRepoRefusal; readonly detail: string }

/**
 * A database error, reduced to CODE AND MESSAGE ONLY, matching promptRepo.
 * A PostgREST error's `details` and `hint` can echo the row that failed.
 */
function failure(
  reason: RequirementRepoRefusal,
  error: { code?: string | null; message?: string | null } | null
): RequirementRepoResult<never> {
  const code = error?.code ?? 'UNKNOWN'
  const message = error?.message ?? 'no message'
  return { ok: false, reason, detail: `${code}: ${message}` }
}

const SETS = 'statement_requirement_sets'
const REQUIREMENTS = 'statement_requirements'

const SET_COLUMNS =
  'id, school_id, application_cycle, verification_status, source_url, verified_on, '
  + 'is_verbatim, original_text, notes, display_order'

const REQUIREMENT_COLUMNS =
  'id, set_id, school_id, document_type, label, prompt_text, components, '
  + 'min_words, max_words, min_characters, max_characters, characters_include_spaces, '
  + 'min_pages, max_pages, page_spacing, font_size_pt, font_family, margins_inches, '
  + 'citation_style, citation_family, min_references, other_instructions, '
  + 'choice_group, is_optional, notes, display_order'

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------
// STRICT, AND REFUSING RATHER THAN REPAIRING, for the reason rows.ts gives: a
// requirement read with its limits silently defaulted would be shown to an
// applicant as the school's requirement. The identity and wording fields are
// required; a malformed LIMIT degrades to absent, which is the same state as a
// school that stated none and is safe because no limit is ever enforced.

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const posInt = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null)
const posNum = (value: unknown): number | null =>
  (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function components(value: unknown): readonly RequirementComponent[] {
  if (!Array.isArray(value)) return []
  const out: RequirementComponent[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = str(raw.id)
    const text = str(raw.text)
    if (id === null || text === null) continue
    out.push({ id, text, optional: raw.optional === true })
  }
  return out
}

/**
 * The limit columns, assembled into a Constraints.
 *
 * A SECTION EXISTS ONLY IF THE SCHOOL STATED SOMETHING IN IT. All-null word
 * columns yield `words: null`, not `{min: null, max: null}` -- because the
 * latter reads downstream as "there is a word limit, with no bounds", and
 * liveCounts() would show a word counter for a school that gave none.
 */
function constraintsFromRow(row: Record<string, unknown>): Constraints {
  const minWords = posInt(row.min_words)
  const maxWords = posInt(row.max_words)
  const minChars = posInt(row.min_characters)
  const maxChars = posInt(row.max_characters)
  const minPages = posInt(row.min_pages)
  const maxPages = posInt(row.max_pages)
  const spacingRaw = str(row.page_spacing)
  const spacing: Spacing | null =
    spacingRaw === 'single' || spacingRaw === 'double' ? spacingRaw : null
  const fontSize = posInt(row.font_size_pt)
  const fontFamily = str(row.font_family)
  // numeric(4,2) arrives from PostgREST as a NUMBER for this range, but a
  // string is accepted too rather than losing the margin on a transport change.
  const marginsRaw = typeof row.margins_inches === 'string'
    ? Number(row.margins_inches)
    : row.margins_inches
  const margins = posNum(marginsRaw)
  const citationStyle = str(row.citation_style)
  const familyRaw = str(row.citation_family)
  const citation: Citation | null = citationStyle === null ? null : {
    family: familyRaw === 'apa' || familyRaw === 'ama' ? familyRaw : 'other',
    statedAs: citationStyle,
    minReferences: posInt(row.min_references),
  }

  return {
    words: minWords === null && maxWords === null ? null : { min: minWords, max: maxWords },
    characters: minChars === null && maxChars === null
      ? null
      : { min: minChars, max: maxChars, spacesCount: bool(row.characters_include_spaces) },
    pages: minPages === null && maxPages === null && spacing === null
      ? null
      : { min: minPages, max: maxPages, spacing },
    typography: fontSize === null && fontFamily === null && margins === null
      ? null
      : { fontSizePt: fontSize, fontFamily, marginsInches: margins },
    citation,
    otherInstructions: strings(row.other_instructions),
  }
}

export function requirementFromRow(value: unknown): WritingRequirement | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = str(row.id)
  const label = str(row.label)
  const promptText = str(row.prompt_text)
  if (id === null || label === null || promptText === null) return null
  if (label.trim().length === 0 || promptText.trim().length === 0) return null

  const documentType = row.document_type
  return {
    id,
    // AN UNRECOGNISED TYPE BECOMES 'other', never a guess at which one was
    // meant. The school's own wording survives in `label` regardless.
    documentType: isDocumentType(documentType) ? documentType : 'other',
    label,
    promptText,
    components: components(row.components),
    constraints: constraintsFromRow(row),
    choiceGroup: str(row.choice_group),
    optional: row.is_optional === true,
    displayOrder: posInt(row.display_order) ?? 0,
    notes: strings(row.notes),
  }
}

function verificationFromRow(row: Record<string, unknown>): Verification {
  const statusRaw = str(row.verification_status)
  const known: readonly VerificationStatus[] =
    ['unverified', 'needs-review', 'verified', 'conflicting']
  return {
    // DEGRADES TO 'unverified', NEVER TO 'verified'. A status this code does
    // not recognise must land in the state that withholds the claim.
    status: (known as readonly string[]).includes(statusRaw ?? '')
      ? (statusRaw as VerificationStatus)
      : 'unverified',
    sourceUrl: str(row.source_url),
    verifiedOn: isIsoDate(row.verified_on) ? row.verified_on : null,
    verbatim: row.is_verbatim === true,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every active requirement set for one school, with its documents.
 *
 * TWO QUERIES, NOT A JOIN, deliberately. PostgREST's embedded select would
 * work, but it makes the shape of the response depend on a relationship the
 * planner infers; two plain reads against the two indexes the migration creates
 * are predictable, and the second is skipped entirely when the first finds
 * nothing.
 *
 * AN EMPTY ARRAY IS NOT AN ERROR. A school with no researched requirements is
 * the overwhelmingly common case -- it is every school today -- and the caller
 * falls back to the statement_prompts catalog, which is the shipped behaviour.
 */
export async function listRequirementSets(
  db: SupabaseClient,
  schoolId: string,
  schoolName: string
): Promise<RequirementRepoResult<readonly RequirementSet[]>> {
  if (!requirementsEnabled()) {
    return { ok: false, reason: 'disabled', detail: 'STATEMENT_REQUIREMENTS is not on' }
  }

  const setRows = await db
    .from(SETS)
    .select(SET_COLUMNS)
    .eq('school_id', schoolId)
    .order('display_order', { ascending: true })
  if (setRows.error) return failure('read-failed', setRows.error)

  const sets = (setRows.data ?? []) as unknown as Record<string, unknown>[]
  if (sets.length === 0) return { ok: true, value: [] }

  const ids = sets.map((row) => str(row.id)).filter((id): id is string => id !== null)
  if (ids.length === 0) return failure('data-integrity', { code: 'NO_ID', message: 'set without id' })

  const requirementRows = await db
    .from(REQUIREMENTS)
    .select(REQUIREMENT_COLUMNS)
    .in('set_id', ids)
    .order('display_order', { ascending: true })
  if (requirementRows.error) return failure('read-failed', requirementRows.error)

  const bySet = new Map<string, WritingRequirement[]>()
  for (const raw of (requirementRows.data ?? []) as unknown as Record<string, unknown>[]) {
    const parsed = requirementFromRow(raw)
    const setId = str(raw.set_id)
    // A ROW THAT WILL NOT PARSE IS DROPPED, NOT GUESSED AT, and the set it
    // belonged to simply has one fewer document. Refusing the whole school's
    // catalog over one bad row would take away the requirements that are fine.
    if (parsed === null || setId === null) continue
    const existing = bySet.get(setId)
    if (existing === undefined) bySet.set(setId, [parsed])
    else existing.push(parsed)
  }

  const value: RequirementSet[] = []
  for (const row of sets) {
    const id = str(row.id)
    if (id === null) continue
    const requirements = bySet.get(id) ?? []
    // A SET WITH NO READABLE DOCUMENTS IS NOT A SET. Showing a school heading
    // with an empty checklist under it would read as "this school requires no
    // writing", which is a claim nobody made.
    if (requirements.length === 0) continue
    value.push({
      id,
      schoolId,
      schoolName,
      applicationCycle: str(row.application_cycle),
      verification: verificationFromRow(row),
      originalText: str(row.original_text) ?? '',
      requirements,
      notes: strings(row.notes),
    })
  }

  return { ok: true, value }
}

/**
 * One requirement, with the set it belongs to, for creating a draft against it.
 *
 * RESOLVED ON THE SERVER FROM AN ID, which is the whole point: a browser sends
 * a requirement id and nothing else, and the wording, the limits and the
 * provenance that get frozen onto the draft are read here. Nothing a caller
 * sends can become the question an essay is judged against.
 */
export async function readActiveRequirement(
  db: SupabaseClient,
  requirementId: string
): Promise<RequirementRepoResult<{
  readonly requirement: WritingRequirement
  readonly set: Omit<RequirementSet, 'requirements' | 'schoolName'>
}>> {
  if (!requirementsEnabled()) {
    return { ok: false, reason: 'disabled', detail: 'STATEMENT_REQUIREMENTS is not on' }
  }

  const found = await db
    .from(REQUIREMENTS)
    .select(REQUIREMENT_COLUMNS)
    .eq('id', requirementId)
    .maybeSingle()
  if (found.error) return failure('read-failed', found.error)
  // RLS DECIDES VISIBILITY, so "absent" and "inactive" are indistinguishable
  // here -- which is exactly the indistinguishability that is wanted.
  if (found.data === null) return { ok: false, reason: 'not-found', detail: 'no such requirement' }

  const row = found.data as unknown as Record<string, unknown>
  const requirement = requirementFromRow(row)
  if (requirement === null) {
    return failure('data-integrity', { code: 'BAD_ROW', message: 'requirement did not parse' })
  }
  const setId = str(row.set_id)
  const schoolId = str(row.school_id)
  if (setId === null || schoolId === null) {
    return failure('data-integrity', { code: 'BAD_ROW', message: 'requirement without a set' })
  }

  const setRow = await db.from(SETS).select(SET_COLUMNS).eq('id', setId).maybeSingle()
  if (setRow.error) return failure('read-failed', setRow.error)
  // The requirement's own RLS policy already required its set to be active, so
  // a missing set here is an inconsistency rather than an ordinary refusal.
  if (setRow.data === null) {
    return failure('data-integrity', { code: 'NO_SET', message: 'set is not readable' })
  }
  const raw = setRow.data as unknown as Record<string, unknown>

  return {
    ok: true,
    value: {
      requirement,
      set: {
        id: setId,
        schoolId,
        applicationCycle: str(raw.application_cycle),
        verification: verificationFromRow(raw),
        originalText: str(raw.original_text) ?? '',
        notes: strings(raw.notes),
      },
    },
  }
}

/** The columns these reads ask for, exported so a migration test can compare. */
export const REQUIREMENT_READ_COLUMNS = { SET_COLUMNS, REQUIREMENT_COLUMNS }
