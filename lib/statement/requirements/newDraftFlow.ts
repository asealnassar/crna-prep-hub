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
import { requirementFromRow } from './repo.ts'

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
function requirementFromRowOrModel(value: unknown) {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  // The wire shape is camelCase; requirementFromRow reads the database's
  // snake_case. Translate the four keys whose names differ, then reuse the one
  // validator rather than writing a second interpretation of the same shape.
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
    ...flattenConstraints(row.constraints),
  })
}

/** The constraint object back into the column names requirementFromRow reads. */
function flattenConstraints(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return {}
  const c = value as Record<string, unknown>
  const words = c.words as Record<string, unknown> | null | undefined
  const characters = c.characters as Record<string, unknown> | null | undefined
  const pages = c.pages as Record<string, unknown> | null | undefined
  const typography = c.typography as Record<string, unknown> | null | undefined
  const citation = c.citation as Record<string, unknown> | null | undefined
  return {
    min_words: words?.min ?? null,
    max_words: words?.max ?? null,
    min_characters: characters?.min ?? null,
    max_characters: characters?.max ?? null,
    characters_include_spaces: characters?.spacesCount ?? null,
    min_pages: pages?.min ?? null,
    max_pages: pages?.max ?? null,
    page_spacing: pages?.spacing ?? null,
    font_size_pt: typography?.fontSizePt ?? null,
    font_family: typography?.fontFamily ?? null,
    margins_inches: typography?.marginsInches ?? null,
    citation_style: citation?.statedAs ?? null,
    citation_family: citation?.family ?? null,
    min_references: citation?.minReferences ?? null,
    other_instructions: c.otherInstructions ?? [],
  }
}

function parseVerification(value: unknown) {
  const known = ['unverified', 'needs-review', 'verified', 'conflicting'] as const
  if (value === null || typeof value !== 'object') {
    return { status: 'unverified' as const, sourceUrl: null, verifiedOn: null, verbatim: false }
  }
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
  }
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface RequirementDraftRequest {
  readonly title: string
  readonly requirementId: string
}

/**
 * The create body for one document.
 *
 * TWO KEYS, AND NEITHER IS THE WORDING. No promptId, no snapshot, no
 * constraints, no verification: the server resolves all of it from the catalog
 * under the caller's own client, and a body that named them would be naming
 * keys nothing reads. That is what makes a fabricated verified requirement
 * impossible to submit rather than merely unlikely.
 *
 * THE TITLE IS TRIMMED HERE AND VALIDATED THERE. Same division the prompt path
 * uses: the browser sends what the applicant typed, tidied, and the server's
 * own validator decides whether it is acceptable.
 */
export function requirementDraftRequest(
  title: string,
  requirementId: string
): RequirementDraftRequest {
  return { title: title.trim(), requirementId }
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
