/**
 * Whether the export will be one page or more, known before the download.
 *
 * WHY MEASURED AND NOT ESTIMATED. A word count cannot answer this: two resumes
 * with identical word counts paginate differently depending on template, bullet
 * wrapping and the break rules in document.css. The preview already renders the
 * document at full size, at the same 8.5x11in page box with the same half-inch
 * margins the PDF uses, so the answer is a height the browser has already
 * computed -- not a guess, and not a second render.
 *
 * WHY ONE-OR-MANY AND NOT A NUMBER. Whether a resume fits on one page is
 * decided exactly by that height: content that fits the page box cannot be
 * split, so it prints on one page, and content that overflows it cannot print
 * on one. How MANY pages an overflowing resume takes is not decided by height
 * alone -- `break-inside: avoid` moves whole entries across page boundaries,
 * which only pagination itself can see. So this module makes the claim it can
 * make exactly, and no other. Tests in lib/resume/export/pdf.test.ts hold it to
 * a real printed file on both sides of the boundary.
 *
 * WHY NOT ASK CHROMIUM. Printing per keystroke would cost seconds and a
 * function invocation each time, for an answer the page box already gives.
 */

/** US Letter at 96 CSS px per inch -- the renderer's own page box. */
export const PAGE_WIDTH_PX = 816
export const PAGE_HEIGHT_PX = 1056
/** The half-inch margin on each edge, matching @page in document.css. */
export const PAGE_MARGIN_PX = 48
/** What is left for content once both margins are taken. */
export const PAGE_CONTENT_WIDTH_PX = PAGE_WIDTH_PX - PAGE_MARGIN_PX * 2
export const PAGE_CONTENT_HEIGHT_PX = PAGE_HEIGHT_PX - PAGE_MARGIN_PX * 2

/**
 * Chromium's default body margin, which the PDF export keeps.
 *
 * The export hands Chromium a bare <body>, so printed text starts 8px inside
 * the page margin and runs in a box 16px narrower than the page area -- measured
 * from the PDF itself, not assumed. The paginated preview reproduces it rather
 * than the export dropping it: removing it from the export changed how the
 * text extractor read Compact pages, and the preview is the cheaper side to move.
 */
export const PRINT_BODY_MARGIN_PX = 8

/**
 * Space between one page's column and the next in the paginated preview.
 *
 * Never seen: each sheet shows exactly one column. It only has to be the same
 * number when the columns are laid out, counted and shifted into view.
 */
export const PAGE_FLOW_GAP_PX = 96

export type PageSpan = 'single' | 'multi'

/**
 * Floating-point noise only.
 *
 * The page box has a minimum height of exactly one page, so a document that
 * fits measures exactly 1056px. Anything that measurably exceeds it has content
 * that does not fit, and is not one page -- however little it overflows by.
 */
const FLOAT_NOISE_PX = 0.01

/**
 * One page or more, from the used height of the rendered page box.
 *
 * Null when there is no measurement to go on. No claim is better than a
 * confident one made without evidence.
 */
export function pageSpanFromDocumentHeight(documentHeightPx: number): PageSpan | null {
  if (!Number.isFinite(documentHeightPx) || documentHeightPx <= 0) return null
  return documentHeightPx <= PAGE_HEIGHT_PX + FLOAT_NOISE_PX ? 'single' : 'multi'
}

/** "1 page", or "Multi-page". Never a number the measurement cannot vouch for. */
export function describePageSpan(span: PageSpan): string {
  return span === 'single' ? '1 page' : 'Multi-page'
}

/**
 * The line shown when a resume will not fit on one page, or null when it will.
 *
 * A statement, not a warning to act on: nothing here shortens, compresses or
 * rewrites anything. A multi-page CRNA resume is legitimate. What was missing
 * was knowing before the download rather than after it.
 */
export function pageSpanNotice(span: PageSpan | null): string | null {
  return span === 'multi' ? 'This resume will export across multiple pages.' : null
}

// ---------------------------------------------------------------------------
// The paginated preview
// ---------------------------------------------------------------------------
//
// THE BROWSER PAGINATES, NOT THIS MODULE. The preview lays the document out in
// a multi-column flow whose every column is exactly one printed page's content
// box. The browser then breaks the content into columns with the same rules
// Chromium uses to break it into pages -- break-inside, break-after, orphans,
// widows, margins at a break -- because it is the same fragmentation engine and
// the same stylesheet. Nothing here decides where a page ends; these functions
// only count the columns the browser made and say where each one is.

/** Pages in the paginated preview, from the width its columns overflow into. */
export function pageCountFromFlowWidth(scrollWidthPx: number): number | null {
  if (!Number.isFinite(scrollWidthPx) || scrollWidthPx <= 0) return null
  const pitch = PAGE_CONTENT_WIDTH_PX + PAGE_FLOW_GAP_PX
  return Math.max(1, Math.round((scrollWidthPx + PAGE_FLOW_GAP_PX) / pitch))
}

/** How far the flow shifts so that page `index` (from 0) is the one in view. */
export function pageOffsetPx(index: number): number {
  return Math.max(0, Math.trunc(index)) * (PAGE_CONTENT_WIDTH_PX + PAGE_FLOW_GAP_PX)
}

/** One page or more, from the number of pages the preview drew. */
export function pageSpanFromPageCount(pages: number | null): PageSpan | null {
  if (pages === null || !Number.isFinite(pages) || pages < 1) return null
  return pages === 1 ? 'single' : 'multi'
}
