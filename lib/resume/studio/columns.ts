/**
 * Which column a section sits in, and what "move up" means once there are two.
 *
 * TWO DIFFERENT QUESTIONS, KEPT APART. Where a section is DRAWN is a layout
 * choice the applicant makes and this module answers. In what order a section is
 * READ -- by an applicant tracking system, or by anyone copying text out of the
 * PDF -- is not up for grabs: see `readingOrder` in lib/resume/document/
 * templates.ts, which ignores everything here.
 *
 * Only a sidebar template has columns at all. For Classic and Compact every
 * function below reports one column containing everything, so the editor asks
 * the same questions for every template and gets sensible answers.
 */

import type { TemplateDefinition } from '../document/templates.ts'
import type { ResumeSectionType, ResumeSectionV2 } from '../model/types.ts'

export type ResumeColumn = 'sidebar' | 'main'

/** Whether this template draws two columns at all. */
export function hasColumns(template: TemplateDefinition): boolean {
  return template.layout === 'sidebar' && template.sidebarSections.length > 0
}

/** Where the template would put this type if the applicant never said. */
export function defaultColumnFor(
  template: TemplateDefinition,
  type: ResumeSectionType
): ResumeColumn {
  if (!hasColumns(template)) return 'main'
  return template.sidebarSections.includes(type) ? 'sidebar' : 'main'
}

/**
 * Where this section is actually drawn.
 *
 * The applicant's own choice wins over the template's default, including the
 * choice to put something the template calls narrative into the sidebar. The
 * preview is right there; they can see whether it works.
 */
export function effectiveColumn(
  template: TemplateDefinition,
  section: Pick<ResumeSectionV2, 'type' | 'modernColumn'>
): ResumeColumn {
  if (!hasColumns(template)) return 'main'
  return section.modernColumn ?? defaultColumnFor(template, section.type)
}

/** The column a section would move to, or null when the template has one column. */
export function otherColumn(
  template: TemplateDefinition,
  section: Pick<ResumeSectionV2, 'type' | 'modernColumn'>
): ResumeColumn | null {
  if (!hasColumns(template)) return null
  return effectiveColumn(template, section) === 'sidebar' ? 'main' : 'sidebar'
}

/**
 * The absolute index "move up" or "move down" should send a section to.
 *
 * Up and down move a section past its neighbour IN THE SAME COLUMN, because
 * that is the only movement a person can see. Swapping with a section drawn in
 * the other column would reorder the array and change nothing on the page,
 * which reads as a broken button.
 *
 * Returns null when there is no neighbour that way -- the caller disables the
 * control rather than emitting a patch that would do nothing.
 */
export function moveTargetIndex(
  sections: readonly ResumeSectionV2[],
  template: TemplateDefinition,
  index: number,
  direction: 'up' | 'down'
): number | null {
  const section = sections[index]
  if (!section) return null

  const column = effectiveColumn(template, section)
  const step = direction === 'up' ? -1 : 1

  for (let i = index + step; i >= 0 && i < sections.length; i += step) {
    if (effectiveColumn(template, sections[i]) === column) return i
  }
  return null
}
