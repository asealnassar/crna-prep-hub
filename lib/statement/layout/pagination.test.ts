/**
 * Phase D: the arithmetic behind the page breaks.
 *
 * SEPARATED FROM THE DOM ON PURPOSE. Where a break falls is a sum, and a sum
 * that is wrong by one gap height puts every boundary below it in the wrong
 * place -- silently, because the page still looks like a page. The DOM lookup
 * that turns a y-coordinate into a document position is the editor's job; this
 * is the part that can be wrong in a way nobody would notice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowanceOffsetPx, allowanceRawOffsetPx, breakOffsetPx, breakProbePx, lineTopPx,
  liveOffsetPx, needsBreakAfter, pagesUsedFromLayout, rawGapTops, rawOffsetPx,
  rawPageStarts, rawTextHeightPx, sameLayout, type RenderedGap,
} from './pagination.ts'

/** Boston's geometry in CSS pixels: 9in of content, 1in margins, 24px gutter. */
const PAGE = 9 * 96        // 864 px of usable content
const GAP = 2 * 96 + 24    // bottom margin + gutter + top margin = 216 px
const G = { pageHeightPx: PAGE, gapHeightPx: GAP, lineHeightPx: 37 }

test('the first break is one page down', () => {
  assert.equal(breakOffsetPx(0, G), PAGE)
})

test('and each later one adds a page AND the gap above it', () => {
  // The gaps are part of the layout, so a break that ignored them would drift
  // further out of place on every page.
  assert.equal(breakOffsetPx(1, G), 2 * PAGE + GAP)
  assert.equal(breakOffsetPx(2, G), 3 * PAGE + 2 * GAP)
  assert.equal(breakOffsetPx(9, G), 10 * PAGE + 9 * GAP)
})

test('THE FORMULA IS A FIXED POINT', () => {
  // Re-deriving break k from a layout that already has k-1 gaps returns the
  // same offset. That is what lets the decorations be recomputed on every
  // keystroke without settling or oscillating.
  for (let k = 0; k < 6; k += 1) {
    const withGaps = breakOffsetPx(k, G)
    const textAbove = withGaps - k * GAP
    assert.equal(textAbove, (k + 1) * PAGE, `break ${k}`)
  }
})

// ===========================================================================
// HOW MANY BREAKS
// ===========================================================================

test('BOSTON: 1.5 pages lands halfway down page two', () => {
  const offset = allowanceOffsetPx(1.5, G)
  // One whole page, the gap after it, then half of page two's content.
  assert.equal(offset, PAGE + GAP + PAGE / 2)
  // Which is to say: half a page below where page two's text begins.
  assert.equal(offset! - (PAGE + GAP), PAGE / 2)
})

test('a whole-page limit sits at the foot of that page, not the head of the next', () => {
  // 1.0 pages means the first page is full -- the boundary must not jump the
  // gap and appear at the top of page two.
  assert.equal(allowanceOffsetPx(1, G), PAGE)
  assert.equal(allowanceOffsetPx(2, G), 2 * PAGE + GAP)
  assert.equal(allowanceOffsetPx(3, G), 3 * PAGE + 2 * GAP)
})

test('every fraction the schema allows lands where it should', () => {
  assert.equal(allowanceOffsetPx(0.5, G), PAGE / 2)
  assert.equal(allowanceOffsetPx(1.5, G), PAGE + GAP + PAGE / 2)
  assert.equal(allowanceOffsetPx(2.5, G), 2 * (PAGE + GAP) + PAGE / 2)
  // A tenth of a page is as real as a half.
  assert.equal(allowanceOffsetPx(1.1, G), PAGE + GAP + PAGE * 0.1)
})

test('no page maximum means no line to draw', () => {
  assert.equal(allowanceOffsetPx(null, G), null)
  assert.equal(allowanceOffsetPx(0, G), null)
  assert.equal(allowanceOffsetPx(-1, G), null)
})

test('the allowance is ABOVE the first break for Boston', () => {
  // Sanity on the relationship the applicant sees: page two exists, and the
  // limit sits inside it rather than beyond the document.
  const firstBreak = breakOffsetPx(0, G)
  const allowance = allowanceOffsetPx(1.5, G)!
  assert.ok(allowance > firstBreak, 'the limit should be below the first page break')
  assert.ok(allowance < breakOffsetPx(1, G), 'and above the second')
})

/* ===========================================================================
 * RAW SPACE
 * =========================================================================== */

/** Boston's real line box: 37 CSS px, so a 864px page holds 23 whole lines. */
const LINE = 37
/** The top of the first line that does not fit on a page starting at `start`. */
const snap = (start: number, probe: number) => {
  let top = start
  while (top + LINE <= probe) top += LINE
  return top
}

/** The gaps a given set of raw break tops renders as, top to bottom. */
const gapsFor = (rawTops: readonly number[]): RenderedGap[] =>
  rawTops.map((raw, i) => ({ topPx: raw + i * GAP, heightPx: GAP }))

test('a page holds whole lines, so the break lands ABOVE the probe', () => {
  // 864 / 37 = 23.35. The 24th line would end at 888, past the foot of the
  // page, so it moves down whole and the break goes at 851.
  assert.equal(snap(0, breakProbePx(0, G)), 23 * LINE)
  assert.equal(23 * LINE, 851)
  assert.ok(851 < PAGE, 'the break is above the arithmetic boundary')
})

test('EVERY PAGE HOLDS 23 LINES, which the closed form does not give', () => {
  // This is the whole reason raw space exists. Walking the snap in sequence,
  // each page starts where the last one broke and holds 23 lines again.
  const starts = [0]
  for (let page = 0; page < 5; page += 1) {
    const start = starts[page]
    const top = snap(start, breakProbePx(start, G))
    assert.equal((top - start) / LINE, 23, `page ${page + 1} line count`)
    starts.push(top)
  }
  assert.deepEqual(starts, [0, 851, 1702, 2553, 3404, 4255])

  // The closed form, by contrast, would put page three's break 24 lines down,
  // because it assumes page two began a full 864px after page one did.
  const ideal = breakOffsetPx(2, G) - 2 * GAP
  assert.equal(ideal, 3 * PAGE)
  assert.ok(ideal - starts[2] > LINE, 'a whole line of drift by page three')
})

test('raw and live convert both ways', () => {
  const gaps = gapsFor([851, 1702])
  // A point on page one is unmoved; below a gap it has shifted by that gap.
  assert.equal(liveOffsetPx(400, gaps), 400)
  assert.equal(liveOffsetPx(900, gaps), 900 + GAP)
  assert.equal(liveOffsetPx(1800, gaps), 1800 + 2 * GAP)
  for (const raw of [0, 1, 850, 851, 852, 1701, 1702, 1703, 5000]) {
    assert.equal(rawOffsetPx(liveOffsetPx(raw, gaps), gaps), raw, `raw ${raw}`)
  }
})

test('a raw offset AT a gap resolves into text, not into the gutter', () => {
  const gaps = gapsFor([851])
  // 851 is both the foot of page one and the head of page two. It must map to
  // the head, or posAtCoords would be asked about a point inside the gutter.
  assert.equal(liveOffsetPx(851, gaps), 851 + GAP)
})

test('the gap table reports where the gaps are in raw space', () => {
  assert.deepEqual(rawGapTops(gapsFor([851, 1702])), [851, 1702])
  // Order is not assumed: the DOM could hand them over in any sequence.
  assert.deepEqual(rawGapTops([...gapsFor([851, 1702])].reverse()), [851, 1702])
})

test('the measured height has the rendered gaps taken back out', () => {
  const gaps = gapsFor([851, 1702])
  assert.equal(rawTextHeightPx(2000 + 2 * GAP, gaps), 2000)
  // Never negative, however stale the measurement.
  assert.equal(rawTextHeightPx(0, gaps), 0)
})

test('a page with nothing below its foot gets no break', () => {
  assert.equal(needsBreakAfter(0, PAGE, G), false)
  assert.equal(needsBreakAfter(0, PAGE + 1, G), true)
  assert.equal(needsBreakAfter(851, 851 + PAGE, G), false)
  assert.equal(needsBreakAfter(851, 851 + PAGE + 1, G), true)
})

test('BOSTON: the limit lands halfway down page two AS RENDERED', () => {
  // Page two really begins at 851, not at 864, so half of its usable content
  // area is 851 + 432 -- which is the line the applicant sees.
  const starts = rawPageStarts([851])
  const raw = allowanceRawOffsetPx(1.5, starts, G)!
  assert.equal(raw, 851 + PAGE / 2)
  assert.equal(raw - starts[1], PAGE / 2, 'exactly half of page two');
  // And in the decorated layout it is below the gap.
  assert.equal(liveOffsetPx(raw, gapsFor([851])), 851 + GAP + PAGE / 2)
})

test('the closed form IS the no-snap case of the measured one', () => {
  // The two must not be independent answers to the same question. Feed the
  // measured version the starts an unsnapped layout would produce and it has
  // to reproduce the closed form exactly, gaps included.
  for (const max of [0.5, 1.1, 1.5, 2.5, 4.75]) {
    const whole = Math.ceil(max)
    const idealTops = Array.from({ length: whole }, (_, k) => (k + 1) * PAGE)
    const starts = rawPageStarts(idealTops)
    const raw = allowanceRawOffsetPx(max, starts, G)
    assert.notEqual(raw, null, `max ${max}`)
    assert.equal(liveOffsetPx(raw!, gapsFor(idealTops)), allowanceOffsetPx(max, G),
      `max ${max}`)
  }
})

test('A WHOLE-PAGE LIMIT IS THE ONE PLACE THE TWO READ DIFFERENTLY', () => {
  // And it is not a disagreement: the boundary sits exactly where a gap begins,
  // so the foot of the page above and the head of the page below are the same
  // raw offset seen from either side.
  //
  // liveOffsetPx resolves it DOWNWARD, into text, because its job is to produce
  // a y-coordinate posAtCoords can map to a document position -- a point inside
  // the gutter has none. The drawn line then goes back above the gap, which the
  // editor does by giving the limit widget a lower `side` than the break widget
  // at that same position rather than by moving the coordinate.
  for (const max of [1, 2, 3]) {
    const idealTops = Array.from({ length: max }, (_, k) => (k + 1) * PAGE)
    const starts = rawPageStarts(idealTops)
    const raw = allowanceRawOffsetPx(max, starts, G)!
    assert.equal(raw, max * PAGE, `max ${max}: the foot of page ${max}`)
    assert.equal(liveOffsetPx(raw, gapsFor(idealTops)),
      allowanceOffsetPx(max, G)! + GAP,
      `max ${max}: exactly one gap apart, never more`)
  }
})

test('a whole-page limit is the FOOT of that page', () => {
  const starts = rawPageStarts([851, 1702])
  assert.equal(allowanceRawOffsetPx(1, starts, G), PAGE)
  assert.equal(allowanceRawOffsetPx(2, starts, G), 851 + PAGE)
})

test('no line is drawn for a page that has not been reached', () => {
  const starts = rawPageStarts([])        // one page rendered so far
  assert.equal(allowanceRawOffsetPx(1.5, starts, G), null)
  assert.equal(allowanceRawOffsetPx(1, starts, G), PAGE)
  assert.equal(allowanceRawOffsetPx(null, starts, G), null)
  assert.equal(allowanceRawOffsetPx(0, starts, G), null)
})

test('PANEL AND PAGE AGREE AT THE BOUNDARY', () => {
  // The synchronisation Phase E requires: the figure in the panel crosses the
  // limit on exactly the keystroke that pushes the text past the drawn line.
  const starts = rawPageStarts([851])
  const limit = allowanceRawOffsetPx(1.5, starts, G)!
  const at = pagesUsedFromLayout({ rawHeightPx: limit, starts, geometry: G })
  assert.ok(Math.abs(at - 1.5) < 1e-9, `at the line it reads ${at}`)
  const under = pagesUsedFromLayout({ rawHeightPx: limit - LINE, starts, geometry: G })
  const over = pagesUsedFromLayout({ rawHeightPx: limit + LINE, starts, geometry: G })
  assert.ok(under < 1.5 && over > 1.5)
})

test('pages used counts the pages that actually broke', () => {
  // One full page and a quarter of the next reads as 1.25, measured from where
  // page two begins rather than divided out of the total.
  const starts = rawPageStarts([851])
  assert.equal(
    pagesUsedFromLayout({ rawHeightPx: 851 + PAGE / 4, starts, geometry: G }), 1.25)
  // An empty document occupies none of a page.
  assert.equal(
    pagesUsedFromLayout({ rawHeightPx: 0, starts: rawPageStarts([]), geometry: G }), 0)
})

test('PROPERTY: raw space survives any gap table', () => {
  // 500 random layouts. The invariant that matters is the round trip: if raw
  // and live ever disagreed, a break would be looked up at a y-coordinate that
  // belongs to a different line and the page would split mid-sentence.
  let seed = 0x5eed1
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
    const count = rand(6)
    const tops: number[] = []
    let start = 0
    for (let k = 0; k < count; k += 1) {
      start = snap(start, breakProbePx(start, G))
      tops.push(start)
    }
    const gaps = gapsFor(tops)
    const raw = rand(6000)
    assert.equal(rawOffsetPx(liveOffsetPx(raw, gaps), gaps), raw,
      `case ${caseIndex}: raw ${raw} over ${count} gaps`)
    // Monotonic: a point further down the text is never further UP the page.
    assert.ok(liveOffsetPx(raw + 1, gaps) >= liveOffsetPx(raw, gaps))
    // And every gap's raw top is where the walk said the break went.
    assert.deepEqual(rawGapTops(gaps), tops, `case ${caseIndex}`)
  }
})

test('A MEASURED COORDINATE IS SNAPPED TO ITS LINE, NOT TRUSTED', () => {
  /*
   * The bug this closes, with the real numbers. Page one holds 23 lines and
   * ends at 851. Chromium, asked where the first character of line 24 is,
   * answers 860.5 -- the top of the GLYPHS, inset by half the leading. Taken as
   * the page start it put page two 9.5px out, which showed up as a page count
   * of 1.2888 where the layout said 1.2998.
   */
  assert.equal(lineTopPx(860.5, G), 851)
  // An engine that reports the line box top instead must land in the same place.
  assert.equal(lineTopPx(851, G), 851)
  // And so must one that rounds a fraction under it, which floor would drop a
  // whole line.
  assert.equal(lineTopPx(850.6, G), 851)
  assert.equal(lineTopPx(869, G), 851)
})

test('every line boundary is a multiple of the line box', () => {
  for (let line = 0; line < 60; line += 1) {
    const top = line * 37
    // Anywhere inside the line resolves to the line.
    for (const inset of [0, 1, 9.5, 18, 18.4]) {
      assert.equal(lineTopPx(top + inset, G), top, `line ${line} + ${inset}`)
    }
  }
})

test('a zero line height cannot divide by zero', () => {
  const broken = { pageHeightPx: PAGE, gapHeightPx: GAP, lineHeightPx: 0 }
  assert.equal(lineTopPx(123.4, broken), 123.4)
})

test('AN UNCHANGED LAYOUT IS NOT REPORTED', () => {
  /*
   * The runaway this closes. Reporting sets React state, a render makes Tiptap
   * update the view, and a view update schedules the next measuring pass --
   * about six thousand a second on the Boston draft, every one of them finding
   * nothing changed and every one starting another.
   */
  const layout = { breaks: 1, pagesUsed: 1.2998, rawHeightPx: 1110, allowanceOffsetPx: 1503 }
  assert.equal(sameLayout(layout, { ...layout }), true)
  // The first pass always reports: there is nothing to compare against.
  assert.equal(sameLayout(null, layout), false)
})

test('and every field that moves is reported', () => {
  const layout = { breaks: 1, pagesUsed: 1.2998, rawHeightPx: 1110, allowanceOffsetPx: 1503 }
  assert.equal(sameLayout(layout, { ...layout, breaks: 2 }), false)
  assert.equal(sameLayout(layout, { ...layout, pagesUsed: 1.2999 }), false)
  assert.equal(sameLayout(layout, { ...layout, rawHeightPx: 1111 }), false)
  assert.equal(sameLayout(layout, { ...layout, allowanceOffsetPx: 1504 }), false)
  // Including the allowance appearing for the first time, which is what draws
  // the line on the page.
  assert.equal(sameLayout({ ...layout, allowanceOffsetPx: null }, layout), false)
})
