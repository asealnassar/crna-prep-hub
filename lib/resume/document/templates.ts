/**
 * The three templates, as data.
 *
 * Blueprint decision: Creative and ATS-Optimized are retired, because ATS
 * safety is a property of all three rather than a style you pick. What survives
 * is classic, modern and compact, and the work is making them GENUINELY
 * DIFFERENT -- a different colour is not a template.
 *
 * They differ on four structural axes, not on palette:
 *
 *   layout       single column, or a narrow sidebar beside a main column
 *   headerAlign  where the applicant's name and contact details sit
 *   headingStyle how a section heading separates itself from what follows
 *   entryLayout  whether dates sit on their own line or opposite the title
 *
 * Tokens (type, spacing) ride along, but a template that changed only tokens
 * would fail `templatesDifferStructurally` in the tests beside this file.
 *
 * WHY THIS IS DATA AND NOT THREE COMPONENTS. Forking a component per template
 * is what makes a fourth template a rewrite. A definition plus one renderer
 * that honours it means a fourth is a new object here -- which is the
 * mitigation the blueprint asked for against exactly that risk.
 */

import type { ResumeSectionType, ResumeTemplate } from '../model/types.ts'
import type { DocumentBlock, DocumentPlan } from './plan.ts'
import { SANS_STACK, SERIF_STACK } from './fonts.ts'

export type TemplateLayout = 'single-column' | 'sidebar'
export type HeadingStyle = 'ruled' | 'caps' | 'inline'
export type EntryLayout = 'stacked' | 'opposed'
export type Density = 'roomy' | 'normal' | 'tight'

export interface TemplateTokens {
  /** Base body size in points. Print units, because this is a document. */
  readonly bodyPt: number
  readonly headingPt: number
  readonly namePt: number
  /** Multiplier applied to vertical rhythm. */
  readonly leading: number
  readonly sectionGapPt: number
  readonly entryGapPt: number
  readonly fontStack: string
}

export interface TemplateDefinition {
  readonly id: ResumeTemplate
  readonly name: string
  /** One line the applicant reads when choosing. */
  readonly summary: string
  readonly layout: TemplateLayout
  readonly headerAlign: 'center' | 'left'
  readonly headingStyle: HeadingStyle
  readonly entryLayout: EntryLayout
  readonly density: Density
  /**
   * For a sidebar layout: which section types move into the narrow column.
   * Short, factual sections go there; anything that carries written prose
   * stays in the main column where it has room to breathe.
   *
   * Empty for single-column templates, which is what makes `splitPlan` safe to
   * call for every template rather than only some.
   */
  readonly sidebarSections: readonly ResumeSectionType[]
  readonly tokens: TemplateTokens
}

/**
 * The faces this project ships, not a wish-list of what a machine might have.
 * See lib/resume/document/fonts.ts: naming a font you do not ship is how a
 * preview and its PDF stop matching.
 */
const SERIF = SERIF_STACK
const SANS = SANS_STACK

/**
 * Centred name, ruled headings, serif. What a CRNA programme's admissions
 * committee has seen a thousand times, done well -- and the default, because
 * the safest document is the right default for an application.
 *
 * DATES SIT OPPOSITE THE TITLE rather than on a line of their own. A date is
 * two words; giving it a whole line cost one line per entry, which on a
 * well-developed resume is most of a page. The stylesheet lets the employer
 * side wrap and keeps the date unbroken beside it, so a long hospital name
 * takes two lines instead of colliding.
 */
const CLASSIC: TemplateDefinition = {
  id: 'classic',
  name: 'Classic',
  summary: 'Centred header, ruled section headings, one column. Traditional and safe.',
  layout: 'single-column',
  headerAlign: 'center',
  headingStyle: 'ruled',
  entryLayout: 'opposed',
  density: 'roomy',
  sidebarSections: [],
  tokens: {
    bodyPt: 10.5, headingPt: 12, namePt: 22,
    leading: 1.45, sectionGapPt: 14, entryGapPt: 8, fontStack: SERIF,
  },
}

/**
 * A real second column. The short factual sections -- what the applicant holds
 * and where they trained -- move out of the narrative flow entirely, which is a
 * different document, not a different colour.
 *
 * WHAT GOES WHERE IS DECIDED BY SHAPE. A credential is a line: a name, a date,
 * maybe a number. It reads perfectly in a narrow column and wastes a wide one.
 * Clinical experience is paragraphs and bullets, and a narrow column turns each
 * bullet into four cramped lines -- so every narrative section stays in the main
 * column, which takes roughly three quarters of the width. Education is here
 * because a degree is three short lines, not because it matters less.
 */
const MODERN: TemplateDefinition = {
  id: 'modern',
  name: 'Modern',
  summary: 'Left-aligned header with a sidebar for education and credentials. Two columns.',
  layout: 'sidebar',
  headerAlign: 'left',
  headingStyle: 'caps',
  entryLayout: 'opposed',
  density: 'normal',
  sidebarSections: ['education', 'licensure', 'certifications', 'organizations', 'awards'],
  tokens: {
    bodyPt: 10, headingPt: 10.5, namePt: 20,
    leading: 1.35, sectionGapPt: 13, entryGapPt: 8, fontStack: SANS,
  },
}

/**
 * Built to fit. Headings sit inline with their content, dates run opposite the
 * title, and the vertical rhythm tightens throughout -- for an applicant with
 * ten years of ICU experience trying to stay on two pages.
 */
const COMPACT: TemplateDefinition = {
  id: 'compact',
  name: 'Compact',
  summary: 'Inline headings and tight spacing. Fits more on the page.',
  layout: 'single-column',
  headerAlign: 'left',
  headingStyle: 'inline',
  entryLayout: 'opposed',
  density: 'tight',
  sidebarSections: [],
  tokens: {
    bodyPt: 9.5, headingPt: 9.5, namePt: 17,
    leading: 1.25, sectionGapPt: 9, entryGapPt: 5, fontStack: SANS,
  },
}

export const TEMPLATES: Readonly<Record<ResumeTemplate, TemplateDefinition>> = {
  classic: CLASSIC,
  modern: MODERN,
  compact: COMPACT,
}

export const TEMPLATE_LIST: readonly TemplateDefinition[] = [CLASSIC, MODERN, COMPACT]

/** Falls back to Classic rather than throwing: a stored id must never blank the page. */
export function templateFor(id: string | null | undefined): TemplateDefinition {
  if (id && Object.prototype.hasOwnProperty.call(TEMPLATES, id)) {
    return TEMPLATES[id as ResumeTemplate]
  }
  return CLASSIC
}

/**
 * Longer than a heading gutter can hold.
 *
 * The compact template sets headings in a narrow column beside their content,
 * which is where it finds most of the space it saves. That column fits two
 * lines of a normal heading -- "Volunteer & Community Service" reads fine --
 * but a long custom heading would stack one word per line and shred the body
 * width beside it. Past this length the section gives up the gutter and puts
 * its heading above the content instead: a little less dense, and legible.
 *
 * A length rather than a measurement because the renderer has no layout engine.
 * Every heading this project ships is comfortably under it; what trips it is a
 * heading the applicant wrote themselves.
 */
export const LONG_HEADING_CHARS = 34

export function isLongHeading(heading: string): boolean {
  return heading.trim().length > LONG_HEADING_CHARS
}

export interface SplitPlan {
  readonly main: readonly DocumentBlock[]
  readonly sidebar: readonly DocumentBlock[]
}

/**
 * Divides a plan between the main column and the sidebar.
 *
 * Order within each column is the applicant's order, untouched. A single-column
 * template returns everything in `main` and an empty sidebar, so a presenter
 * never branches on layout to decide what to draw -- only on where to put it.
 *
 * NOTHING IS EVER DROPPED. Every block lands in exactly one column, which is
 * the property that makes "all three templates render every section type" hold
 * however the sidebar list changes.
 */
export function splitPlan(plan: DocumentPlan, template: TemplateDefinition): SplitPlan {
  if (template.layout !== 'sidebar' || template.sidebarSections.length === 0) {
    return { main: plan.blocks, sidebar: [] }
  }
  const byDefault = new Set<ResumeSectionType>(template.sidebarSections)
  // The applicant's own choice wins over the default, including the choice to
  // put something narrative in the sidebar. They can see the preview; the
  // template's opinion is a starting point, not a rule.
  const sidebar = (block: DocumentBlock) =>
    block.modernColumn ? block.modernColumn === 'sidebar' : byDefault.has(block.sectionType)

  return {
    main: plan.blocks.filter((b) => !sidebar(b)),
    sidebar: plan.blocks.filter(sidebar),
  }
}

/**
 * Every block in DOM order, which is not the same as visual order.
 *
 * A two-column template puts credentials beside the narrative, but an ATS and
 * anyone copying text out of the PDF read the DOM, not the grid. Emitting the
 * sidebar first -- as the visual left-hand column would suggest -- makes an
 * extracted resume open with a list of licence numbers before it says who the
 * applicant is. So the main column is emitted first and the stylesheet places
 * the sidebar to its left with explicit grid coordinates.
 *
 * For a single-column template this is simply the applicant's own order.
 */
export function readingOrder(plan: DocumentPlan, template: TemplateDefinition): DocumentBlock[] {
  if (template.layout !== 'sidebar' || template.sidebarSections.length === 0) {
    return [...plan.blocks]
  }
  // DELIBERATELY NOT `splitPlan`. Reading order follows what a section IS --
  // narrative, or supporting -- and not where the applicant chose to draw it.
  // Someone who moves their clinical experience into the sidebar for the look of
  // it has not decided that a parser should read their licences first, and the
  // locked order is header, then summary and experience, then the supporting
  // sections. Moving a section is a layout edit; it is not an ATS decision.
  const supporting = new Set<ResumeSectionType>(template.sidebarSections)
  return [
    ...plan.blocks.filter((b) => !supporting.has(b.sectionType)),
    ...plan.blocks.filter((b) => supporting.has(b.sectionType)),
  ]
}
