/**
 * Where the page breaks fall.
 *
 * ---------------------------------------------------------------------------
 * COMPUTED FROM THE UNDECORATED FLOW, THEN RENDERED INTO IT
 * ---------------------------------------------------------------------------
 * A page boundary belongs where the text reaches k x the usable content height.
 * The gaps that make the break visible are themselves part of the layout, so
 * once one is inserted every y-coordinate below it has moved -- and measuring
 * the decorated layout to decide where to decorate would chase its own tail.
 *
 * It does not have to. Each gap has a KNOWN height, and the k-th break always
 * has exactly k-1 gaps above it, so the target for break k in the decorated
 * layout is
 *
 *     contentTop + k x pageHeight + (k - 1) x gapHeight
 *
 * which is computable in one pass and is a fixed point: if the decorations are
 * already right, the same positions come back out. No iteration, no settling.
 *
 * PURE. Takes numbers, returns numbers. The caller owns the DOM and does the
 * coordinate-to-position lookup, which is what keeps this testable under
 * `node --test` -- the arithmetic is the part that can be wrong in a way nobody
 * would see.
 *
 * ---------------------------------------------------------------------------
 * THE CLOSED FORM IS A REFERENCE, NOT THE LIVE PATH
 * ---------------------------------------------------------------------------
 * `breakOffsetPx` and `allowanceOffsetPx` describe a flow whose lines divide
 * the page exactly. Real lines do not, so the editor walks the snapped sequence
 * in RAW SPACE below instead. The closed form stays because the measured walk
 * has to be provable against something: feed it the starts an unsnapped layout
 * would produce and it must reproduce these offsets exactly, which is what
 * keeps a bug in the walk from looking like a new convention.
 *
 * THERE IS DELIBERATELY NO CLOSED-FORM BREAK COUNT. How many pages a document
 * occupies is now answered by the walk, from the layout; a second formula that
 * could disagree with what is on screen is the whole class of bug this module
 * exists to avoid.
 */

/** Everything a break calculation needs, in CSS pixels. */
export interface PaginationGeometry {
  /** Usable content height of one page. */
  readonly pageHeightPx: number
  /** Total height of one break: bottom margin + gutter + top margin. */
  readonly gapHeightPx: number
  /** The line box, which is the pitch every line in the document sits on. */
  readonly lineHeightPx: number
}

/**
 * The y-offset, relative to the top of the content, of the k-th page break in
 * the DECORATED layout.
 *
 * `index` is zero-based: 0 is the break between page 1 and page 2.
 */
export function breakOffsetPx(index: number, geometry: PaginationGeometry): number {
  return (index + 1) * geometry.pageHeightPx + index * geometry.gapHeightPx
}

/**
 * Where the school's allowance ends, as a y-offset in the DECORATED layout.
 *
 * FRACTIONS LAND INSIDE A PAGE. Boston's 1.5 pages is one whole page, one gap,
 * then half of the next page's content -- which is what puts the boundary
 * halfway down page two rather than at the foot of it.
 *
 * null WHEN THE SCHOOL STATED NO PAGE MAXIMUM. There is no line to draw.
 */
export function allowanceOffsetPx(
  maxPages: number | null,
  geometry: PaginationGeometry,
): number | null {
  if (maxPages === null || !(maxPages > 0)) return null
  // Whole pages contribute a page plus the gap that follows each of them.
  const whole = Math.floor(maxPages)
  const fraction = maxPages - whole
  return whole * (geometry.pageHeightPx + geometry.gapHeightPx)
    + fraction * geometry.pageHeightPx
    // A limit that lands exactly on a page boundary sits at the foot of that
    // page, not at the head of the next: back off the gap it would otherwise
    // have crossed.
    - (fraction === 0 ? geometry.gapHeightPx : 0)
}

/* ===========================================================================
 * RAW SPACE: THE LAYOUT WITH THE GAPS TAKEN BACK OUT
 * ===========================================================================
 *
 * The closed form above answers "where should break k go" for a flow whose
 * lines happen to divide the page evenly. They do not. A page holds 23 whole
 * 37px lines in 864px, which is 851px of text -- the remaining 13px cannot hold
 * a 24th line, so the break lands at 851, not at 864. A LINE IS NEVER SPLIT
 * ACROSS A PAGE: the one that does not fit moves down whole, which is what a
 * word processor does and what the applicant expects to see.
 *
 * That snap makes each page's start depend on the previous page's snap, so the
 * offsets have to be walked in sequence rather than computed independently --
 * and walked in a coordinate space the gaps do not move.
 *
 * RAW SPACE IS THAT SPACE: the offset a point would have if no gap had been
 * inserted. Every rendered gap has a known height, so raw and live convert both
 * ways exactly. The reason this is sound is that A BREAK PLACED AT A LINE START
 * DOES NOT CHANGE LINE BREAKING -- the gap is a block in the flow, so it ends
 * the line it sits in, and a line that was already ending there wraps exactly
 * as it did before. The raw layout is therefore stable no matter how many gaps
 * are currently rendered, which is what makes one measuring pass enough.
 */

/** A page gap as it is currently rendered, in live CSS pixels. */
export interface RenderedGap {
  /** Offset of the gap's top from the top of the content. */
  readonly topPx: number
  readonly heightPx: number
}

/** Gaps ordered down the page, defensively: the DOM order is not a guarantee. */
function ordered(gaps: readonly RenderedGap[]): readonly RenderedGap[] {
  return [...gaps].sort((a, b) => a.topPx - b.topPx)
}

/**
 * The raw offset of each rendered gap's top.
 *
 * A GAP'S OWN RAW POSITION EXCLUDES THE GAPS ABOVE IT but not itself, so the
 * k-th gap sits at its live top minus the heights of the k-1 gaps before it.
 */
export function rawGapTops(gaps: readonly RenderedGap[]): readonly number[] {
  const tops: number[] = []
  let above = 0
  for (const gap of ordered(gaps)) {
    tops.push(gap.topPx - above)
    above += gap.heightPx
  }
  return tops
}

/**
 * Live offset for a raw offset.
 *
 * INCLUSIVE AT A GAP'S OWN TOP. A raw offset that lands exactly where a gap
 * begins is the first line of the page after it -- the gap is counted, so the
 * result is a y-coordinate in text rather than one inside the gutter, where
 * there is no position to look up.
 */
export function liveOffsetPx(rawPx: number, gaps: readonly RenderedGap[]): number {
  const list = ordered(gaps)
  const tops = rawGapTops(list)
  let live = rawPx
  for (let i = 0; i < list.length; i += 1) {
    if (tops[i] <= rawPx) live += list[i].heightPx
  }
  return live
}

/** Raw offset for a live offset. The inverse, over the same gap table. */
export function rawOffsetPx(livePx: number, gaps: readonly RenderedGap[]): number {
  let raw = livePx
  for (const gap of ordered(gaps)) {
    if (gap.topPx + gap.heightPx <= livePx) raw -= gap.heightPx
    else if (gap.topPx <= livePx) raw -= livePx - gap.topPx
  }
  return raw
}

/** The height of the text alone, with every rendered gap subtracted back out. */
export function rawTextHeightPx(
  liveHeightPx: number,
  gaps: readonly RenderedGap[],
): number {
  const total = gaps.reduce((sum, gap) => sum + gap.heightPx, 0)
  return Math.max(0, liveHeightPx - total)
}

/**
 * Where to look for page k's break: one page's worth of content below where
 * that page starts, in raw space.
 *
 * The line found at this offset is the first that does not fit, so the break
 * goes at ITS top -- which is at or above the probe, never below.
 */
export function breakProbePx(rawPageStartPx: number, geometry: PaginationGeometry): number {
  return rawPageStartPx + geometry.pageHeightPx
}

/**
 * Whether a page starting here has any text below its foot.
 *
 * Strictly greater, for the same reason `breakCount` is: text that ends exactly
 * at the boundary has not spilled, and a gap with nothing after it would show
 * the applicant a blank page they did not write.
 */
export function needsBreakAfter(
  rawPageStartPx: number,
  rawHeightPx: number,
  geometry: PaginationGeometry,
): boolean {
  if (geometry.pageHeightPx <= 0) return false
  return rawHeightPx > breakProbePx(rawPageStartPx, geometry)
}

/**
 * Where each page begins, in raw space, given where the breaks actually landed.
 *
 * PAGE ONE BEGINS AT ZERO and every later page begins at the break above it, so
 * the snap that moved a break up moves that whole page's content up with it.
 */
export function rawPageStarts(rawBreakTopsPx: readonly number[]): readonly number[] {
  return [0, ...rawBreakTopsPx]
}

/**
 * Where the school's allowance ends, in raw space, measured against the pages
 * as they actually broke.
 *
 * A FRACTION IS READ INSIDE ITS PAGE. Boston's 1.5 is one whole page and then
 * half of page two's usable height -- measured from where page two really
 * begins, so the line sits halfway down the content area the applicant can see
 * rather than halfway down a page the arithmetic imagined.
 *
 * A WHOLE NUMBER IS THE FOOT OF ITS PAGE, not the head of the next.
 *
 * null WHEN THAT PAGE HAS NOT BEEN REACHED, because its start is not known yet
 * and guessing it would put the line somewhere the next keystroke moves.
 */
export function allowanceRawOffsetPx(
  maxPages: number | null,
  starts: readonly number[],
  geometry: PaginationGeometry,
): number | null {
  if (maxPages === null || !(maxPages > 0)) return null
  const whole = Math.floor(maxPages)
  const fraction = maxPages - whole
  if (fraction === 0) {
    const start = starts[whole - 1]
    return start === undefined ? null : start + geometry.pageHeightPx
  }
  const start = starts[whole]
  return start === undefined ? null : start + fraction * geometry.pageHeightPx
}

/**
 * How much of the allowance the text occupies, measured from the rendered
 * layout rather than divided out of a total height.
 *
 * THE PANEL AND THE PAGE MUST AGREE. Dividing the text height by the page
 * height assumes every page holds a page's worth, and the snap means page one
 * holds 851px of a 864px box. An essay that ends just past the limit line on
 * screen has to read as past the limit in the panel, and only counting the
 * pages the way they actually broke makes those the same question.
 */
export function pagesUsedFromLayout(input: {
  readonly rawHeightPx: number
  readonly starts: readonly number[]
  readonly geometry: PaginationGeometry
}): number {
  const { rawHeightPx, starts, geometry } = input
  if (geometry.pageHeightPx <= 0) return 0
  const whole = starts.length - 1
  const lastStart = starts[whole] ?? 0
  const onLast = Math.max(0, rawHeightPx - lastStart) / geometry.pageHeightPx
  return whole + onLast
}

/**
 * The top of the line box that contains a raw offset.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MEASURED COORDINATE IS NOT THE ANSWER
 * ---------------------------------------------------------------------------
 * Asked where a document position is, a browser answers with the rectangle
 * around the TEXT, not around the line box it sits in. At 12pt on a 37px line
 * the glyphs occupy about 18px, so the rest is leading split above and below
 * and the reported top is ~9px BELOW where the line actually begins. Measured
 * in Chromium: a line starting at 851 reported 860.5.
 *
 * Taking that as the page start put every page below it 9px out, and nothing
 * about the number looks wrong -- it is a plausible offset, just not a line
 * boundary. WORSE, HOW MUCH IT IS OUT BY IS THE ENGINE'S BUSINESS: the inset
 * depends on how a browser chooses to report a caret rectangle, so the page
 * count could differ between Chrome and Safari for that reason alone.
 *
 * ---------------------------------------------------------------------------
 * SO IT IS NOT MEASURED, IT IS SNAPPED
 * ---------------------------------------------------------------------------
 * Every line box in the document sits on the same pitch. Paragraphs carry no
 * margin or padding and an empty one is held open to exactly one line box, so
 * in raw space -- gaps removed -- every line begins at a whole multiple of the
 * line height. A measurement only has to say WHICH line, and the nearest
 * multiple answers that.
 *
 * NEAREST, NOT FLOOR. It has to absorb an inset in either direction: an engine
 * reporting the text top lands ~9px below the boundary, one reporting the line
 * box top lands on it, and a third rounding fractionally under it would floor
 * to the line above -- a whole line of error from a rounding difference.
 */
export function lineTopPx(rawPx: number, geometry: PaginationGeometry): number {
  const pitch = geometry.lineHeightPx
  if (!(pitch > 0)) return rawPx
  return Math.round(rawPx / pitch) * pitch
}

/**
 * What one measuring pass found, for the parts of the UI outside the editor.
 *
 * Defined here rather than in the component because it is layout data, and
 * because the comparison below has to be testable: reporting it is what feeds
 * React, and React is what triggers the next pass.
 */
export interface PaginationLayout {
  /** Page breaks rendered. One break means two pages. */
  readonly breaks: number
  /** Pages occupied, measured from where the pages actually broke. */
  readonly pagesUsed: number
  /** Rendered height of the text alone, gaps excluded, in CSS pixels. */
  readonly rawHeightPx: number
  /** Where the allowance ends in the rendered layout, or null if unreached. */
  readonly allowanceOffsetPx: number | null
}

/**
 * Whether a pass found anything the UI did not already know.
 *
 * ---------------------------------------------------------------------------
 * WITHOUT THIS THE EDITOR MEASURES FOREVER
 * ---------------------------------------------------------------------------
 * Reporting a measurement sets React state. A React render makes Tiptap update
 * the editor view. A view update tells every plugin view to update, which is
 * when this one schedules its next measuring pass -- which reports, which
 * renders, which updates. Measured on the Boston draft: around six thousand
 * passes a second, each one correctly concluding that nothing had changed and
 * each one starting the next.
 *
 * THE DECORATIONS WERE NEVER THE PROBLEM -- they were computed once and held
 * steady. It was the reporting that fed the loop, so the cut goes here: an
 * unchanged layout is not reported, the render does not happen, and the chain
 * ends on the first pass that finds nothing new.
 */
export function sameLayout(
  previous: PaginationLayout | null,
  next: PaginationLayout,
): boolean {
  if (previous === null) return false
  return previous.breaks === next.breaks
    && previous.pagesUsed === next.pagesUsed
    && previous.rawHeightPx === next.rawHeightPx
    && previous.allowanceOffsetPx === next.allowanceOffsetPx
}
