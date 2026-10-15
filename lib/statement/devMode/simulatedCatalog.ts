/**
 * The requirement catalog as the rollout will serve it, read from the local
 * payload instead of from production.
 *
 * WHAT IT SIMULATES, EXACTLY. Production holds 63 sets with `is_active = false`.
 * Activation is a separate owner decision that has not been taken. This module
 * answers the question "what would the applicant see if the verified sets were
 * active" WITHOUT changing a single database row -- the activation is simulated
 * in a filter here, and `is_active` in production stays false.
 *
 * ---------------------------------------------------------------------------
 * SOUTH DAKOTA IS WITHHELD, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * 62 of the 63 sets are `verified`. One -- University of South Dakota -- is
 * `needs-review`, because 08_IMPORT_REVIEW.md says its corrected word count
 * must be confirmed against the source before anybody relies on it.
 *
 * 005's activation constraint already refuses to activate a set that is not
 * `verified`, so the database would withhold it. This filter applies the SAME
 * rule rather than a convenient one: simulating activation must not simulate
 * activating something the database would refuse, or the review would approve a
 * screen that cannot exist. It is withheld and SAID TO BE WITHHELD -- the
 * withheld list is returned so the interface can show it as pending rather than
 * silently omit a school the owner knows was imported.
 */
import type { RequirementSet, WritingRequirement } from '../requirements/requirement.ts'
import { loadLocalReviewCatalog } from '../requirements/localReviewCatalog.ts'

export interface SimulatedCatalog {
  /** The sets activation would make visible: verified, and nothing else. */
  readonly available: readonly RequirementSet[]
  /** Imported but not activatable, with the reason the database would give. */
  readonly withheld: readonly { readonly set: RequirementSet; readonly reason: string }[]
}

/** The rule 005 enforces, applied here rather than approximated. */
function activatable(set: RequirementSet): boolean {
  return set.verification.status === 'verified'
    && set.verification.sourceUrl !== null
    && set.verification.verifiedOn !== null
}

let cached: SimulatedCatalog | null = null

export function simulatedCatalog(): SimulatedCatalog {
  if (cached !== null) return cached
  const loaded = loadLocalReviewCatalog()
  if (loaded === null) {
    cached = { available: [], withheld: [] }
    return cached
  }
  const available: RequirementSet[] = []
  const withheld: { set: RequirementSet; reason: string }[] = []
  for (const set of loaded.sets) {
    if (activatable(set)) available.push(set)
    else {
      withheld.push({
        set,
        reason: set.verification.status === 'verified'
          ? 'verified but missing a source URL or a checked-on date'
          : `verification_status is ${set.verification.status}; `
            + '005 refuses to activate a set that is not verified',
      })
    }
  }
  cached = { available, withheld }
  return cached
}

/** Every available set for one school. The shape listRequirementSets returns. */
export function simulatedSetsForSchool(
  schoolId: string, schoolName: string,
): readonly RequirementSet[] {
  return simulatedCatalog().available
    .filter((set) => set.schoolId === schoolId)
    // schoolName is the caller's, exactly as the real read does it: the picker
    // already resolved the school and its name is not this table's to supply.
    .map((set) => (schoolName === '' ? set : { ...set, schoolName }))
}

/** One requirement by id, and the set it belongs to. Available sets only. */
export function simulatedRequirement(requirementId: string): {
  readonly requirement: WritingRequirement
  readonly set: RequirementSet
} | null {
  for (const set of simulatedCatalog().available) {
    const requirement = set.requirements.find((entry) => entry.id === requirementId)
    if (requirement !== undefined) return { requirement, set }
  }
  return null
}

/** For the banner, so the counts shown are the counts served. */
export function simulatedCatalogCounts(): {
  readonly availableSets: number
  readonly availableDocuments: number
  readonly withheldSets: number
} {
  const { available, withheld } = simulatedCatalog()
  return {
    availableSets: available.length,
    availableDocuments: available.reduce((n, set) => n + set.requirements.length, 0),
    withheldSets: withheld.length,
  }
}
