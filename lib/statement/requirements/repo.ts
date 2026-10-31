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
import {
  formatProfileEnabled, requirementsEnabled, submissionEvidenceEnabled,
  typographyOptionsEnabled,
} from '../draft/rollout.ts'
import {
  NO_CONSTRAINTS, type Citation, type Constraints, type Spacing, type StatedLength,
  parseEnforcement,
} from './constraints.ts'
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

const SET_COLUMNS_BASE =
  'id, school_id, application_cycle, verification_status, source_url, verified_on, '
  + 'is_verbatim, original_text, notes, display_order'

/**
 * 20261008_011's evidence columns, selected only behind their flag.
 *
 * NAMED COLUMNS FAIL WHOLE REQUESTS. PostgREST answers a select that mentions
 * an absent column with a 42703 for the entire query, so adding these
 * unconditionally would take the catalog down anywhere 011 is unapplied. 011 IS
 * applied in production and STATEMENT_SUBMISSION_EVIDENCE is on, so the flag no
 * longer hides anything there; it is what keeps a build pointed at an
 * unmigrated database working.
 *
 * WITHOUT THEM verificationFromRow degrades to 'official-source', and that
 * degradation is a FALSE REASSURANCE rather than a missing field: see
 * textAttribution(). THE SET-LEVEL CLAIM IS NO LONGER THE WHOLE STORY -- a
 * requirement carries its own origin_submission_id, which is NOT flag-gated for
 * exactly this reason, and requirementVerification() resolves the two per
 * document. So a set read without its evidence can still only ever be
 * over-trusted at the set level, never on a card.
 */
const SET_EVIDENCE_COLUMNS = 'evidence_kind, evidence_submission_id'

function setColumns(): string {
  return submissionEvidenceEnabled()
    ? `${SET_COLUMNS_BASE}, ${SET_EVIDENCE_COLUMNS}`
    : SET_COLUMNS_BASE
}

// THE SIX REGISTER COLUMNS ARE ADDED BY 20261002_006 AND ARE NAMED HERE, which
// means this select FAILS if 006 has not been applied -- and failing is the
// correct behaviour. requirementProvenance() turns a read error into
// 'read-failed' and refuses to vouch for the requirement, so a half-migrated
// database withholds authority instead of authenticating requirements whose
// registers it cannot see. 005 and 006 must both be applied before
// STATEMENT_REQUIREMENTS is turned on; migration.test.ts pins that this list
// names nothing the two migration files do not create.
const REQUIREMENT_COLUMNS_BASE =
  'id, set_id, school_id, document_type, label, prompt_text, components, '
  + 'min_words, max_words, words_enforcement, words_stated_as, '
  + 'min_characters, max_characters, characters_include_spaces, '
  + 'characters_enforcement, characters_stated_as, '
  + 'min_pages, max_pages, page_spacing, pages_enforcement, pages_stated_as, '
  + 'font_size_pt, font_family, margins_inches, '
  + 'citation_style, citation_family, min_references, '
  + 'unenforced_length, unenforced_length_verbatim, other_instructions, '
  + 'choice_group, is_optional, notes, display_order, '
  // ---- 20261008_012, AND DELIBERATELY NOT BEHIND A FLAG --------------------
  // Every other migration's columns are gated, because naming an absent column
  // fails the whole request with a 42703. These two are named unconditionally
  // anyway, for the reason the six register columns above are: failing is the
  // correct behaviour. A flag that hid them would make the read degrade to
  // origin_submission_id = null, and null means "this is official research" --
  // the strongest claim in the system. The 011 evidence flag already taught
  // this lesson once: a gate on a provenance column is a gate that turns OFF
  // into a false reassurance. There is no flag state in which it is safe to
  // forget where a requirement came from, so there is no flag.
  + 'origin_submission_id, supersedes_requirement_id'

/** 20261008_010's permitted-value sets, selected only behind their flag. */
const REQUIREMENT_OPTION_COLUMNS = 'font_family_options, font_size_pt_options'

/** 20261011_014's whole-document standard, selected only behind its flag. */
const REQUIREMENT_PROFILE_COLUMNS = 'document_format_profile'

/**
 * What a requirement read asks for, given the schema in front of us.
 *
 * ---------------------------------------------------------------------------
 * STORED AND NEVER SELECTED IS THE SAME AS NOT STORED
 * ---------------------------------------------------------------------------
 * constraintsFromRow has always read these columns "if they arrive", which
 * made the parser forward-compatible and the READ nothing of the kind: this
 * list never asked for them, so applying 010 or 014 changed nothing an
 * applicant could see and the catalog corrections that populate them would
 * have been written and never read.
 *
 * SELECTED ONLY BEHIND THEIR FLAGS, for the reason setColumns() gives:
 * PostgREST answers a select naming an absent column with a 42703 for the
 * WHOLE query, so asking unconditionally would take the catalog down wherever
 * the migration is unapplied -- which is production, today.
 *
 * BOTH DEGRADE TO ABSENCE, NOT TO A CLAIM. Without the option sets a school
 * that permits two fonts reads as a school that permitted none, and the single
 * required family is still applied. Without the profile a document reads as
 * one that named no standard, which is what every document was before 014.
 * Neither flag off can make the Studio say something untrue -- which is why
 * these two are safe to leave off indefinitely, and why the evidence flag is
 * not.
 */
function requirementColumns(): string {
  let columns = REQUIREMENT_COLUMNS_BASE
  if (typographyOptionsEnabled()) columns = `${columns}, ${REQUIREMENT_OPTION_COLUMNS}`
  if (formatProfileEnabled()) columns = `${columns}, ${REQUIREMENT_PROFILE_COLUMNS}`
  return columns
}

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
const nonBlank = (value: unknown): string | null => {
  const text = str(value)
  return text !== null && text.trim().length > 0 ? text : null
}

/** Shared with snapshot.ts's parser, so the two cannot read a flag differently. */
const statedLengthFrom = (text: string | null, verbatim: unknown): StatedLength | null =>
  (text === null ? null : { text, verbatim: verbatim === true })

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

/**
 * A permitted-value set of strings, or null.
 *
 * TRIMMED AND ORDER-NORMALISED ON READ, not because the database allows dirt --
 * migration 010 refuses it -- but because a snapshot written before 010 may
 * hold the same set in another order, and two spellings of one permission must
 * not read as a changed requirement.
 */
function textOptions(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null
  const out = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (out.length < 2) return null
  return [...new Set(out)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

/** A permitted-value set of point sizes, ascending. */
function intOptions(raw: unknown): readonly number[] | null {
  if (!Array.isArray(raw)) return null
  const out = raw
    .map((value) => (typeof value === 'string' ? Number(value) : value))
    .filter((value): value is number => typeof value === 'number'
      && Number.isInteger(value) && value > 0)
  if (out.length < 2) return null
  return [...new Set(out)].sort((a, b) => a - b)
}

function constraintsFromRow(row: Record<string, unknown>): Constraints {
  const minWords = posInt(row.min_words)
  const maxWords = posInt(row.max_words)
  const minChars = posInt(row.min_characters)
  const maxChars = posInt(row.max_characters)
  // numeric(4,1) AS OF MIGRATION 007, so these are parsed exactly as
  // margins_inches is below -- and NOT with posInt, which would read Boston
  // College's 1.5-page limit as absent and show the applicant no limit at all.
  // A whole number comes back from this column as 5.0; Number() makes that 5,
  // so the rendered line stays "5 pages" and never "5.0 pages".
  const minPages = posNum(typeof row.min_pages === 'string'
    ? Number(row.min_pages) : row.min_pages)
  const maxPages = posNum(typeof row.max_pages === 'string'
    ? Number(row.max_pages) : row.max_pages)
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
  /*
    PERMITTED-VALUE SETS, READ ONLY IF THEY ARRIVE.

    The columns are added by migration 010 and are deliberately NOT in the
    select list above: naming a column that does not exist yet would fail every
    catalog read on a database where 010 has not run. Reading them off the row
    when present makes this forward-compatible with no second deploy -- the
    select list gains them in the same change that applies 010.
  */
  const familyOptions = textOptions(row.font_family_options)
  const sizeOptions = intOptions(row.font_size_pt_options)

  const citationStyle = str(row.citation_style)
  const familyRaw = str(row.citation_family)
  const citation: Citation | null = citationStyle === null ? null : {
    family: familyRaw === 'apa' || familyRaw === 'ama' ? familyRaw : 'other',
    statedAs: citationStyle,
    minReferences: posInt(row.min_references),
  }

  return {
    // 20261011_014. Null unless the verified wording applies a named standard
    // to the document itself; a citation style lives in `citation`.
    formatProfile: str(row.document_format_profile),
    words: minWords === null && maxWords === null ? null : {
      min: minWords,
      max: maxWords,
      enforcement: parseEnforcement(row.words_enforcement),
      statedAs: str(row.words_stated_as),
    },
    characters: minChars === null && maxChars === null
      ? null
      : {
        min: minChars,
        max: maxChars,
        spacesCount: bool(row.characters_include_spaces),
        enforcement: parseEnforcement(row.characters_enforcement),
        statedAs: str(row.characters_stated_as),
      },
    pages: minPages === null && maxPages === null && spacing === null
      ? null
      : {
        min: minPages,
        max: maxPages,
        spacing,
        enforcement: parseEnforcement(row.pages_enforcement),
        statedAs: str(row.pages_stated_as),
      },
    typography:
      fontSize === null && fontFamily === null && margins === null
      && familyOptions === null && sizeOptions === null
        ? null
        : {
          fontSizePt: fontSize,
          fontFamily,
          marginsInches: margins,
          fontFamilyOptions: familyOptions,
          fontSizePtOptions: sizeOptions,
        },
    citation,
    // THE SCHOOL'S LENGTH SENTENCE, WITH NO BOUND BESIDE IT. Blank is absent:
    // an empty column is not an instruction, and must not render as a quotation
    // with nothing in it.
    //
    // A MISSING VERBATIM FLAG READS AS false, so a row written without one is
    // shown as a summary rather than quoted. Under-claiming is the safe
    // direction: a quotation shown as a summary loses a little authority, and a
    // summary shown as a quotation invents a sentence the school never wrote.
    unenforcedLength: statedLengthFrom(
      nonBlank(row.unenforced_length), row.unenforced_length_verbatim),
    otherInstructions: strings(row.other_instructions),
  }
}

/**
 * The inverse of constraintsFromRow: a model back into the columns it reads.
 *
 * ---------------------------------------------------------------------------
 * ONE PARSER, AND THIS IS ITS INVERSE -- NOT A SECOND INTERPRETATION
 * ---------------------------------------------------------------------------
 * /api/statement/requirements returns what listRequirementSets() built: the
 * canonical model, camelCase, already parsed. The New Draft dialog revalidates
 * it rather than casting, which is right -- a browser must drop a malformed
 * document, not render a card with no question on it -- and it did that by
 * flattening the model back into column names and calling requirementFromRow.
 *
 * THE FLATTENING WAS A HAND-WRITTEN LIST, AND IT WAS ELEVEN COLUMNS SHORT:
 * all three enforcement registers, all three `*_stated_as`, both
 * `unenforced_length` columns, `document_format_profile` and the two font
 * option sets. So the dialog read every register as 'enforced' and showed
 * Albany Medical College's advisory "500 words" as "500 words maximum", while
 * the editor -- fed by the server -- called the same figure a stated length.
 * One requirement, two meanings, depending on which screen you were on.
 *
 * SO THE ADAPTER LIVES HERE, beside the reader it is the inverse of, and the
 * round-trip is asserted over every served document: parse, flatten, parse
 * again, and the two models must be identical. A column the reader learns and
 * this forgets fails that test instead of reaching an applicant.
 *
 * IT IS A TRANSPORT ADAPTER, NOT A SECOND OPINION. Every value is copied
 * verbatim out of an already-normalised model; nothing here decides anything,
 * which is why it cannot drift in meaning even while the reader evolves.
 */
export function columnsFromConstraints(c: Constraints): Record<string, unknown> {
  return {
    document_format_profile: c.formatProfile,

    min_words: c.words?.min ?? null,
    max_words: c.words?.max ?? null,
    words_enforcement: c.words?.enforcement ?? null,
    words_stated_as: c.words?.statedAs ?? null,

    min_characters: c.characters?.min ?? null,
    max_characters: c.characters?.max ?? null,
    characters_include_spaces: c.characters?.spacesCount ?? null,
    characters_enforcement: c.characters?.enforcement ?? null,
    characters_stated_as: c.characters?.statedAs ?? null,

    min_pages: c.pages?.min ?? null,
    max_pages: c.pages?.max ?? null,
    page_spacing: c.pages?.spacing ?? null,
    pages_enforcement: c.pages?.enforcement ?? null,
    pages_stated_as: c.pages?.statedAs ?? null,

    font_size_pt: c.typography?.fontSizePt ?? null,
    font_family: c.typography?.fontFamily ?? null,
    margins_inches: c.typography?.marginsInches ?? null,
    font_family_options: c.typography?.fontFamilyOptions ?? null,
    font_size_pt_options: c.typography?.fontSizePtOptions ?? null,

    citation_style: c.citation?.statedAs ?? null,
    citation_family: c.citation?.family ?? null,
    min_references: c.citation?.minReferences ?? null,

    unenforced_length: c.unenforcedLength?.text ?? null,
    unenforced_length_verbatim: c.unenforcedLength?.verbatim ?? null,

    other_instructions: c.otherInstructions,
  }
}

/**
 * Every column constraintsFromRow reads, for the parity test.
 *
 * DERIVED FROM THE ADAPTER, so the list cannot be forgotten separately: the
 * test asserts this covers what the reader reads, and the round-trip asserts
 * the values survive.
 */
export const CONSTRAINT_COLUMNS: readonly string[] =
  Object.keys(columnsFromConstraints(NO_CONSTRAINTS))

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
    // A NON-STRING BECOMES null, which reads as "official research". That is
    // the right default for every pre-012 row and the WRONG one for a
    // submission-derived row whose column failed to arrive -- which is exactly
    // why the column is not flag-gated above. If it is selected, it is honest.
    originSubmissionId: str(row.origin_submission_id),
  }
}

// EXPORTED so the development-only catalog review can assemble a set through
// the same parser the real read uses. A second implementation would be a
// second thing to drift.
export function verificationFromRow(row: Record<string, unknown>): Verification {
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
    // DEGRADES TO 'official-source', which is what every row written before
    // migration 011 was. An unrecognised value must not be read as the weaker
    // claim by accident, nor as the stronger one.
    evidenceKind: row.evidence_kind === 'admin-approved-submission'
      ? 'admin-approved-submission'
      : 'official-source',
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
    .select(setColumns())
    .eq('school_id', schoolId)
    .order('display_order', { ascending: true })
  if (setRows.error) return failure('read-failed', setRows.error)

  const sets = (setRows.data ?? []) as unknown as Record<string, unknown>[]
  if (sets.length === 0) return { ok: true, value: [] }

  const ids = sets.map((row) => str(row.id)).filter((id): id is string => id !== null)
  if (ids.length === 0) return failure('data-integrity', { code: 'NO_ID', message: 'set without id' })

  const requirementRows = await db
    .from(REQUIREMENTS)
    .select(requirementColumns())
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
    .select(requirementColumns())
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

  const setRow = await db.from(SETS).select(setColumns()).eq('id', setId).maybeSingle()
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
/**
 * The read projections other modules share.
 *
 * SET_COLUMNS IS A FUNCTION, because the evidence columns are flag-gated and a
 * frozen string cannot be. provenance.ts held the base projection, so
 * `evidence_kind` was never selected and every set it judged looked like an
 * official source -- which is the activation test an approved submission has
 * to pass without a source URL.
 */
export const REQUIREMENT_READ_COLUMNS = {
  /** The pre-011 projection, which is what the migration test compares. */
  SET_COLUMNS: SET_COLUMNS_BASE,
  REQUIREMENT_COLUMNS: REQUIREMENT_COLUMNS_BASE,
  requirementColumns,
  /** What a read actually asks for, evidence columns included behind the flag. */
  setColumns,
}
