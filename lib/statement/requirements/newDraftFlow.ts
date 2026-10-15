/**
 * The New Draft dialog's requirement step, as decisions rather than markup.
 *
 * WHAT THIS STEP IS FOR. A school with published, verified writing
 * requirements asks for named documents -- a personal statement, a diversity
 * essay, a writing sample -- and the applicant starts them one at a time. So
 * after they pick a school, the dialog asks the catalog what that school wants
 * and, if it knows, shows the checklist instead of the flat prompt list.
 *
 * AND IF IT DOES NOT KNOW, NOTHING CHANGES. An unavailable endpoint, a disabled
 * rollout flag, a school with no researched requirements and a read failure all
 * produce the same answer -- 'fallback' -- and the dialog does exactly what it
 * does today: fetch the prompt list from statement_prompts. That is the
 * property that keeps the shipped creation flow working on a deployment where
 * 20261002_005 has never been applied, and it is why the failure case and the
 * empty case are deliberately not distinguished.
 *
 * ONE DOCUMENT, ONE DRAFT. Starting a document sends ONE requirement id and a
 * title. The dialog never creates a draft per question -- a multipart essay is
 * one document and one id -- and it never creates all of a school's documents
 * at once, because an applicant who writes one and leaves is in a normal state.
 */

import type { RequirementSet } from './requirement.ts'
import { UNVERIFIED, evidenceKindFrom, type Verification } from './verification.ts'
import { columnsFromConstraints, requirementFromRow } from './repo.ts'
import type { Constraints } from './constraints.ts'

export const REQUIREMENTS_ENDPOINT = '/api/statement/requirements'

/** The catalog read for one school. Encoded, because a uuid is a query value. */
export function requirementsPath(schoolId: string): string {
  return `${REQUIREMENTS_ENDPOINT}?schoolId=${encodeURIComponent(schoolId)}`
}

/**
 * What the dialog does next after asking the catalog.
 *
 * TWO OUTCOMES, NOT FOUR. 'ready' with at least one set, or 'fallback'. There
 * is no 'error' state the applicant is shown, because there is nothing useful
 * to tell them: the prompt list still works, and an error banner over a working
 * screen would be noise about a feature they did not ask for.
 */
export type RequirementStepOutcome =
  | { readonly kind: 'ready'; readonly sets: readonly RequirementSet[] }
  | { readonly kind: 'fallback' }

const FALLBACK: RequirementStepOutcome = { kind: 'fallback' }

/**
 * The catalog's answer, parsed.
 *
 * STRICT, AND FALLING BACK RATHER THAN REPAIRING. A 404 is the rollout flag
 * being off. A 500 is this site failing. A 200 whose body is not the expected
 * shape is a response this build does not understand. All of them mean "use the
 * prompt list", which is the behaviour that is known to work.
 *
 * THE SCHOOL NAME IS STAMPED HERE, NOT TAKEN FROM THE RESPONSE. The endpoint
 * deliberately returns an empty name -- echoing one read from another table
 * would be vouching for a join it did not make -- and the dialog already has
 * the name, because the applicant picked the school from the directory it was
 * given.
 *
 * A SET WITH NO READABLE DOCUMENTS IS DROPPED. A school heading with an empty
 * checklist under it reads as "this school requires no writing", which is a
 * claim nobody made.
 */
export function requirementStepFrom(input: {
  readonly status: number
  readonly body: unknown
  readonly schoolId: string
  readonly schoolName: string
}): RequirementStepOutcome {
  if (input.status !== 200) return FALLBACK
  if (input.body === null || typeof input.body !== 'object') return FALLBACK

  const raw = (input.body as { sets?: unknown }).sets
  if (!Array.isArray(raw)) return FALLBACK

  const sets: RequirementSet[] = []
  for (const candidate of raw) {
    if (candidate === null || typeof candidate !== 'object') continue
    const row = candidate as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : null
    if (id === null) continue

    // THE SCHOOL MUST BE THE ONE THAT WAS ASKED ABOUT. A response naming
    // another school's requirements is dropped rather than displayed under
    // this heading -- the dialog asked about one school and shows one school.
    const schoolId = typeof row.schoolId === 'string' ? row.schoolId : null
    if (schoolId !== null && schoolId !== input.schoolId) continue

    const requirements = Array.isArray(row.requirements)
      ? row.requirements
        .map((item) => requirementFromRowOrModel(item))
        .filter((item): item is NonNullable<typeof item> => item !== null)
      : []
    if (requirements.length === 0) continue

    sets.push({
      id,
      schoolId: input.schoolId,
      schoolName: input.schoolName,
      applicationCycle: typeof row.applicationCycle === 'string' ? row.applicationCycle : null,
      verification: parseVerification(row.verification),
      originalText: typeof row.originalText === 'string' ? row.originalText : '',
      requirements,
      notes: Array.isArray(row.notes)
        ? row.notes.filter((note): note is string => typeof note === 'string')
        : [],
    })
  }

  return sets.length === 0 ? FALLBACK : { kind: 'ready', sets }
}

/**
 * One requirement from the response.
 *
 * THE RESPONSE IS ALREADY IN MODEL SHAPE, because the endpoint returns what
 * listRequirementSets() built -- camelCase, parsed, with its constraints
 * assembled. But it has crossed the wire, so it is validated again here rather
 * than cast: a browser receiving a malformed document must drop it, not render
 * a card with no question on it.
 */
/**
 * The wire's constraints, trusted only as far as their SHAPE.
 *
 * The endpoint sends the canonical model, so there is nothing to re-interpret
 * here -- but it has crossed the wire, so an object that is not one is
 * rejected and the document falls back to no constraints rather than
 * fabricating any.
 */
function normalisedConstraints(value: unknown): Constraints | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Constraints
}

function requirementFromRowOrModel(value: unknown) {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  // The wire shape is camelCase; requirementFromRow reads the database's
  // snake_case. Translate the four keys whose names differ, then reuse the one
  // validator rather than writing a second interpretation of the same shape.
  /*
    THE CONSTRAINTS GO BACK THROUGH THE READER'S OWN INVERSE.

    This used to flatten them with a list written here, and that list was
    eleven columns short -- every enforcement register among them -- so the
    dialog called an advisory length a maximum while the editor did not. See
    columnsFromConstraints, which lives beside the reader and is round-trip
    tested over every served document.
  */
  const constraints = normalisedConstraints(row.constraints)
  return requirementFromRow({
    id: row.id,
    label: row.label,
    prompt_text: row.promptText,
    document_type: row.documentType,
    components: row.components,
    choice_group: row.choiceGroup,
    is_optional: row.optional,
    notes: row.notes,
    display_order: row.displayOrder,
    ...(constraints === null ? {} : columnsFromConstraints(constraints)),
  })
}

function parseVerification(value: unknown): Verification {
  const known = ['unverified', 'needs-review', 'verified', 'conflicting'] as const
  // THE SHARED CONSTANT, not a copy of it: a response this build cannot read
  // is research with no source and no date, which is exactly what UNVERIFIED
  // means. Copying its fields was how a literal evidence kind got in here.
  if (value === null || typeof value !== 'object') return UNVERIFIED
  const row = value as Record<string, unknown>
  const status = typeof row.status === 'string' && (known as readonly string[]).includes(row.status)
    ? (row.status as typeof known[number])
    // DEGRADES TO 'unverified', NEVER TO 'verified'. A status this build does
    // not recognise must land in the state that withholds the claim.
    : 'unverified' as const
  return {
    status,
    sourceUrl: typeof row.sourceUrl === 'string' ? row.sourceUrl : null,
    verifiedOn: typeof row.verifiedOn === 'string' ? row.verifiedOn : null,
    verbatim: row.verbatim === true,
    // THE RESPONSE'S OWN VALUE. This was the literal 'official-source', which
    // threw away the one field that distinguishes an applicant's approved
    // submission from a school's published page -- and this parser is what the
    // New Draft dialog builds every set from. See QA-001.
    evidenceKind: evidenceKindFrom(row.evidenceKind),
  }
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface RequirementDraftRequest {
  readonly title: string
  /**
   * Empty, and PRESENT.
   *
   * A new draft starts with no essay -- the text arrives with the first save --
   * but the server validates `essay` for every create before it looks at what
   * kind of create it is, and checkEssay() refuses anything that is not a
   * string. Omitting the key made the server answer `invalid-essay` to a body
   * that was otherwise correct, which is how a requirement-backed draft could
   * not be created at all. Both sibling builders have always sent it; this one
   * did not, and that was the whole bug.
   */
  readonly essay: string
  readonly requirementId: string
}

/**
 * The create body for one document.
 *
 * THREE KEYS, AND NONE OF THEM IS THE WORDING. No promptId, no snapshot, no
 * constraints, no verification: the server resolves all of it from the catalog
 * under the caller's own client, and a body that named them would be naming
 * keys nothing reads. That is what makes a fabricated verified requirement
 * impossible to submit rather than merely unlikely.
 *
 * `essay: ''` IS THE THIRD, and it is not a relaxation of that rule: an empty
 * essay is the applicant's own text, not the school's question. It is sent for
 * the same reason the prompt path sends it -- the server validates the essay on
 * every create, before it decides which kind of create this is.
 *
 * THE TITLE IS TRIMMED HERE AND VALIDATED THERE. Same division the prompt path
 * uses: the browser sends what the applicant typed, tidied, and the server's
 * own validator decides whether it is acceptable.
 */
export function requirementDraftRequest(
  title: string,
  requirementId: string
): RequirementDraftRequest {
  return { title: title.trim(), essay: '', requirementId }
}

/**
 * Whether Create may fire for a requirement-backed draft.
 *
 * NOT THE DUPLICATE GUARD, exactly as canCreateNow is not: it decides what the
 * button looks like, and the dialog holds a ref set synchronously before the
 * request.
 */
export function canCreateRequirementNow(input: {
  readonly title: string
  readonly requirementId: string | null
  readonly submitting: boolean
}): boolean {
  if (input.submitting === true) return false
  if (input.requirementId === null) return false
  return input.title.trim().length > 0
}
