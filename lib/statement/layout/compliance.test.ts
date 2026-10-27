/**
 * Phase A: what the requirements panel says.
 *
 * THE BLANKET DISCLAIMER IS THE THING BEING REPLACED, so the first assertions
 * are about what is NOT said: for a school that stated only a page maximum and
 * a spacing, there is nothing the Studio cannot check, and claiming otherwise
 * would make a reviewer doubt the parts that are true.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MEASUREMENT_BASIS, appliedLines, complianceRows,
} from './compliance.ts'
import { resolveRequirementCapabilities } from './capabilities.ts'
import { contentBox, resolveGeometry } from './geometry.ts'
import {
  NO_CONSTRAINTS, characterLimit, pageLimit, wordLimit,
} from '../requirements/constraints.ts'
import type { Constraints } from '../requirements/constraints.ts'

const BOSTON: Constraints = {
  ...NO_CONSTRAINTS,
  pages: pageLimit({
    min: null, max: 1.5, spacing: 'double', enforcement: 'enforced',
    statedAs: 'explicit bound: "maximum"',
  }),
}
const GEOMETRY = resolveGeometry(BOSTON)
const PAGE = contentBox(GEOMETRY).heightPt

/** A measurement at a given fraction of a page. */
const at = (pages: number) => ({
  words: 0, characters: 0, contentHeightPt: PAGE * pages, pagesUsed: null,
})

/** A measurement from a paginated layout, which counted the pages itself. */
const measured = (pages: number, rawPages: number) => ({
  words: 0, characters: 0, contentHeightPt: PAGE * rawPages, pagesUsed: pages,
})
const rows = (constraints: Constraints, measurements: ReturnType<typeof at>) =>
  complianceRows({
    capabilities: resolveRequirementCapabilities(constraints), measurements,
  })

// ===========================================================================
// BOSTON COLLEGE
// ===========================================================================

test('Boston at 1.21 pages: double-spaced applied, within the maximum', () => {
  const result = rows(BOSTON, at(1.21))
  assert.deepEqual(result.map((r) => [r.id, r.status, r.detail]), [
    ['pages', 'met', '1.21 / 1.50 pages'],
    ['spacing', 'applied', null],
  ])
  assert.equal(result[0]!.label, 'Within 1.50-page maximum')
  assert.equal(result[1]!.label, 'Double-spaced')
})

test('Boston over the limit: breached, and the figure keeps climbing', () => {
  const result = rows(BOSTON, at(1.67))
  assert.equal(result[0]!.status, 'breached')
  assert.equal(result[0]!.label, 'Over the 1.50-page maximum')
  assert.equal(result[0]!.detail, '1.67 / 1.50 pages')
  // Spacing is unaffected by being over: it is how the page is laid out.
  assert.equal(result[1]!.status, 'applied')
})

test('Boston exactly at 1.50 pages is WITHIN, not over', () => {
  // The boundary belongs to the allowance. A draft that fills it exactly
  // complies; only crossing it does not.
  const result = rows(BOSTON, at(1.5))
  assert.equal(result[0]!.status, 'met')
  assert.equal(result[0]!.detail, '1.50 / 1.50 pages')
})

test('BOSTON HAS NOTHING THE STUDIO CANNOT CHECK', () => {
  // The replacement for "this editor counts words and characters only".
  const result = rows(BOSTON, at(1.21))
  assert.equal(result.some((r) => r.status === 'unverifiable'), false)
})

test('the two halves of the panel are generated from provenance', () => {
  // ONE LIST, SPLIT. The school stated a spacing and nothing else about the
  // page, so everything a page count also depends on is ours and is named.
  const caps = resolveRequirementCapabilities(BOSTON)
  assert.deepEqual(appliedLines(caps, 'school'), ['Double-spaced'])
  assert.deepEqual([...appliedLines(caps, 'studio-default')].sort(), [
    '1-inch margins', '12 pt', 'Tinos', 'US Letter',
  ])
  // The spacing is the school's, so it must NOT appear among our defaults.
  assert.equal(appliedLines(caps, 'studio-default').includes('Double-spaced'), false)
})

test('and the basis line never lets the number read as the school\'s', () => {
  assert.match(MEASUREMENT_BASIS, /school requirements plus the Studio defaults/)
})

test('before the first layout pass the page row is pending, not zero', () => {
  // Reporting 0.00 / 1.50 before anything is measured would be a false claim
  // about an essay that may already be two pages long.
  const result = complianceRows({
    capabilities: resolveRequirementCapabilities(BOSTON),
    measurements: { words: 0, characters: 0, contentHeightPt: null, pagesUsed: null },
  })
  assert.equal(result[0]!.status, 'pending')
  assert.equal(result[0]!.detail, null)
})

// ===========================================================================
// OTHER REQUIREMENT BASES -- EACH FROM ITS OWN MEASUREMENT
// ===========================================================================

test('a word-based school is evaluated in words', () => {
  const constraints: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ min: null, max: 500, enforcement: 'enforced', statedAs: null }),
  }
  const result = complianceRows({
    capabilities: resolveRequirementCapabilities(constraints),
    measurements: { words: 463, characters: 0, contentHeightPt: PAGE * 3, pagesUsed: null },
  })
  assert.deepEqual(result.map((r) => [r.id, r.status, r.detail]),
    [['words', 'met', '463 / 500 words']])
  // THREE PAGES OF TEXT AND NO PAGE ROW. The school stated words, so the page
  // count is not its limit and must not appear as one.
  assert.equal(result.some((r) => r.id === 'pages'), false)
})

test('a character-based school is evaluated in characters', () => {
  const constraints: Constraints = {
    ...NO_CONSTRAINTS,
    characters: characterLimit({
      min: null, max: 3000, spacesCount: true, enforcement: 'enforced', statedAs: null,
    }),
  }
  const result = complianceRows({
    capabilities: resolveRequirementCapabilities(constraints),
    measurements: { words: 9999, characters: 2840, contentHeightPt: PAGE * 5, pagesUsed: null },
  })
  assert.deepEqual(result.map((r) => [r.id, r.detail]),
    [['characters', '2,840 / 3,000 characters']])
})

test('a school stating BOTH gets both, judged independently', () => {
  const constraints: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ min: null, max: 500, enforcement: 'enforced', statedAs: null }),
    pages: pageLimit({
      min: null, max: 2, spacing: 'double', enforcement: 'enforced', statedAs: null,
    }),
  }
  const result = complianceRows({
    capabilities: resolveRequirementCapabilities(constraints),
    // Within the pages, over the words: two different verdicts at once.
    measurements: { words: 640, characters: 0, contentHeightPt: PAGE * 1.2, pagesUsed: null },
  })
  const byId = new Map(result.map((r) => [r.id, r]))
  assert.equal(byId.get('pages')!.status, 'met')
  assert.equal(byId.get('words')!.status, 'breached')
  // Neither figure is derived from the other.
  assert.equal(byId.get('pages')!.detail, '1.20 / 2.00 pages')
  assert.equal(byId.get('words')!.detail, '640 / 500 words')
})

test('minimums are reported too', () => {
  const constraints: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ min: 500, max: null, enforcement: 'enforced', statedAs: null }),
  }
  const short = complianceRows({
    capabilities: resolveRequirementCapabilities(constraints),
    measurements: { words: 120, characters: 0, contentHeightPt: null, pagesUsed: null },
  })
  assert.equal(short[0]!.id, 'words-min')
  assert.equal(short[0]!.status, 'breached')
  assert.equal(short[0]!.detail, '120 / 500 words')
})

// ===========================================================================
// WHAT WE STILL CANNOT CHECK -- NAMED, NEVER BLANKET
// ===========================================================================

test('a school-stated FONT is never shown as a passed check', () => {
  // Times New Roman is SUBSTITUTED: Tinos breaks the page where it would, so
  // the page figure holds, and the font itself was not delivered. The row says
  // both; what it must never say is that the requirement was met.
  const substituted: Constraints = {
    ...NO_CONSTRAINTS,
    typography: { fontSizePt: null, fontFamily: 'Times New Roman', marginsInches: null },
  }
  const font = rows(substituted, at(1)).find((r) => r.id === 'font-family')!
  assert.ok(font, 'the school\'s font requirement vanished')
  assert.equal(font.status, 'substituted')
  // THE SCHOOL'S WORDING ALONE in the requirement list; what the Studio renders
  // instead is a separate claim, under its own heading.
  assert.equal(font.label, 'Times New Roman')
  assert.doesNotMatch(font.label, /Tinos/)
  const caps = resolveRequirementCapabilities(substituted)
  assert.ok(caps.rendering.some((note) => /Tinos/.test(note)))

  // A font we do not ship at all is still handed back to the applicant.
  const unsupported: Constraints = {
    ...NO_CONSTRAINTS,
    typography: { fontSizePt: null, fontFamily: 'Garamond', marginsInches: null },
  }
  const manual = rows(unsupported, at(1)).find((r) => r.status === 'unverifiable')!
  assert.match(manual.label, /Garamond/)
  assert.match(manual.label, /final document/)
})

test('other instructions are listed one by one, and ABSENCES ARE NOT', () => {
  // Boston's own catalog row carries 'Not stated (typewritten)', which is the
  // importer recording that the school said nothing -- not a requirement. It
  // used to render as "Not stated (typewritten) — not checked by the Studio".
  const absence: Constraints = {
    ...BOSTON,
    otherInstructions: ['Not stated (typewritten)'],
  }
  assert.deepEqual(
    rows(absence, at(1.21)).filter((r) => r.status === 'unverifiable'), [])

  // A real instruction still reaches the applicant, and says what to do.
  const real: Constraints = {
    ...BOSTON,
    otherInstructions: ['BLINDED REVIEW — no personal identifying information may appear'],
  }
  assert.deepEqual(
    rows(real, at(1.21)).filter((r) => r.status === 'unverifiable').map((r) => r.label),
    ['BLINDED REVIEW — no personal identifying information may appear'
      + ' — not checked by the Studio'])
})

test('THE OLD BLANKET SENTENCE IS NEVER PRODUCED BY THIS MODULE', () => {
  const source = readFileSync(new URL('./compliance.ts', import.meta.url), 'utf8')
  // Named individually or not at all. The phrase may appear in prose explaining
  // what was replaced; it may not be a string this module emits.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.equal(code.includes('counts words and characters only'), false)
  assert.equal(code.includes('cannot check page count'), false)
})

test('a draft with no requirement has no panel at all', () => {
  assert.deepEqual(
    complianceRows({
      capabilities: resolveRequirementCapabilities(null),
      measurements: { words: 100, characters: 500, contentHeightPt: PAGE, pagesUsed: null },
    }),
    [],
  )
})

// ===========================================================================
// THE MEASURED PAGE COUNT
// ===========================================================================

test('A MEASURED PAGE COUNT WINS OVER THE RATIO', () => {
  // The editor counted 1.53 pages from the pages as they actually broke, while
  // the text's height divided by a page's comes to 1.48. The drawn limit line
  // is below the end of the text, so the panel has to say so -- taking the
  // ratio would have told the applicant they were still inside the maximum.
  const result = rows(BOSTON, measured(1.53, 1.48))
  assert.equal(result[0]!.status, 'breached')
  assert.equal(result[0]!.detail, '1.53 / 1.50 pages')
  assert.equal(result[0]!.label, 'Over the 1.50-page maximum')
})

test('and under the limit it reports the measured figure too', () => {
  const result = rows(BOSTON, measured(1.23, 1.21))
  assert.equal(result[0]!.status, 'met')
  assert.equal(result[0]!.detail, '1.23 / 1.50 pages')
})

test('exactly at the maximum is NOT over', () => {
  // The applicant who fills the allowance to the last line has complied.
  const result = rows(BOSTON, measured(1.5, 1.5))
  assert.equal(result[0]!.status, 'met')
  assert.equal(result[0]!.detail, '1.50 / 1.50 pages')
})

test('AN ABSENT PAGE COUNT IS NOT A PAGE COUNT OF ZERO', () => {
  // The regression that `?? null` closes. The field is required by the type and
  // the compiler does not check this file, so a caller can still hand over an
  // object without it -- and `undefined > 1.5` is false, which read as met.
  const result = complianceRows({
    capabilities: resolveRequirementCapabilities(BOSTON),
    measurements: {
      words: 0, characters: 0, contentHeightPt: PAGE * 1.67,
    } as Parameters<typeof complianceRows>[0]['measurements'],
  })
  assert.equal(result[0]!.status, 'breached', 'must fall back to the height')
  assert.equal(result[0]!.detail, '1.67 / 1.50 pages')
})
