/**
 * "Imported items to review": where an import keeps what it could not place.
 *
 * A SECTION, BECAUSE A SECTION PERSISTS. The resume row has no free JSON of its
 * own; a section's payload does. So the import's leftovers live in one hidden
 * custom section, flagged, and survive save and reload like everything else --
 * no column, no migration.
 *
 * IT NEVER PRINTS. The flag is what the document plan checks, not visibility,
 * so nothing an applicant has not placed can reach a programme even if the
 * section's visibility were somehow switched on.
 *
 * Pure.
 */

import type { CustomEntry, CustomSection, ResumeSectionV2, ResumeV2 } from './types.ts'

/** What imports have always called it. Still how an older import is recognised. */
export const IMPORT_REVIEW_HEADING = 'Imported — needs review'

/**
 * Whether a section is the import's holding area.
 *
 * Flagged sections, and -- for resumes imported before the flag existed -- the
 * same hidden custom section recognised by the heading imports gave it.
 */
export function isImportReviewSection(section: ResumeSectionV2): section is CustomSection {
  if (section.type !== 'custom') return false
  if (section.importReview === true) return true
  return !section.visible && section.heading === IMPORT_REVIEW_HEADING
}

/** The holding area, when the resume has one. */
export function importReviewSectionOf(resume: ResumeV2): CustomSection | null {
  return (resume.sections.find(isImportReviewSection) as CustomSection | undefined) ?? null
}

/** Every item still waiting to be placed, in the order the document had them. */
export function pendingImportItems(resume: ResumeV2): readonly CustomEntry[] {
  return importReviewSectionOf(resume)?.entries ?? []
}
