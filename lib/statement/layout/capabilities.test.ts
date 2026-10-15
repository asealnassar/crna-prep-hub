/**
 * The regression matrix.
 *
 * ONE TABLE, MANY SCHOOLS. Every row is a different shape of canonical record,
 * and the whole point of the test is that nothing in the resolver knows which
 * row it is looking at. A school behaves the way it does because of its fields;
 * if any behaviour ever needed a name to produce it, one of these would fail.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NO_CONSTRAINTS, characterLimit, pageLimit, wordLimit,
  type Constraints,
} from '../requirements/constraints.ts'
import {
  STUDIO_CAPABILITIES, capabilityOf, fontFamilyCapability,
  resolveRequirementCapabilities,
} from './capabilities.ts'
import { complianceRows } from './compliance.ts'
import { contentBox } from './geometry.ts'

const enforced = 'enforced' as const

/** A school that states a page maximum, optionally spaced and bounded below. */
const pageSchool = (input: {
  max?: number | null, min?: number | null, spacing?: 'single' | 'double' | null,
}): Constraints => ({
  ...NO_CONSTRAINTS,
  pages: pageLimit({
    min: input.min ?? null, max: input.max ?? null,
    spacing: input.spacing ?? null, enforcement: enforced,
    statedAs: 'explicit bound: "maximum"',
  }),
})

const typography = (input: {
  fontSizePt?: number | null, fontFamily?: string | null, marginsInches?: number | null,
}) => ({
  fontSizePt: input.fontSizePt ?? null,
  fontFamily: input.fontFamily ?? null,
  marginsInches: input.marginsInches ?? null,
})

// ===========================================================================
// THE MATRIX
// ===========================================================================

/** 1. A one-page, single-spaced school. */
const ONE_PAGE_SINGLE = pageSchool({ max: 1, spacing: 'single' })

/** 2. A page and a half, double-spaced. The fractional case. */
const PAGE_AND_A_HALF = pageSchool({ max: 1.5, spacing: 'double' })

/** 3. Two pages, double-spaced. */
const TWO_PAGE_DOUBLE = pageSchool({ max: 2, spacing: 'double' })

/** 4. A word count and nothing else. */
const WORDS_ONLY: Constraints = {
  ...NO_CONSTRAINTS,
  words: wordLimit({ max: 500, enforcement: enforced, statedAs: '500 words maximum' }),
}

/** 5. A character count and nothing else, spaces included. */
const CHARACTERS_ONLY: Constraints = {
  ...NO_CONSTRAINTS,
  characters: characterLimit({
    max: 3000, spacesCount: true, enforcement: enforced,
    statedAs: '3,000 characters including spaces',
  }),
}

/** 6. Both a word count and a page bound, which bind independently. */
const WORDS_AND_PAGES: Constraints = {
  ...pageSchool({ max: 2, spacing: 'double' }),
  words: wordLimit({ max: 500, enforcement: enforced, statedAs: '500 words maximum' }),
}

/** 7. Pages with an explicit font and margins stated. */
const PAGES_WITH_TYPOGRAPHY: Constraints = {
  ...pageSchool({ max: 2 }),
  typography: typography({ fontSizePt: 11, fontFamily: 'Times New Roman', marginsInches: 1.25 }),
}

/** 8. A school that stated a length but no formatting at all. */
const NO_FORMATTING = WORDS_ONLY

/** 9. A citation format, which no amount of layout work can verify. */
const CITATION_SCHOOL: Constraints = {
  ...pageSchool({ max: 2, spacing: 'double' }),
  citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: null },
}

/** 10. A fractional bound that is not 1.5, to prove 1.5 is not special. */
const HALF_PAGE = pageSchool({ max: 0.5, spacing: 'single' })

/** A minimum as well as a maximum. */
const PAGE_RANGE = pageSchool({ min: 1, max: 2, spacing: 'double' })

/** A school with no stated requirement whatsoever. */
const NOTHING_STATED = NO_CONSTRAINTS

// ===========================================================================
// CAPABILITY
// ===========================================================================

test('A FIELD’S CAPABILITY IS A FACT ABOUT THE PRODUCT, NOT THE SCHOOL', () => {
  // Pages are measured because the Studio lays the page out. The font family is
  // the one typography field it cannot honour, because one face is embedded.
  assert.equal(capabilityOf('pages'), 'measured')
  assert.equal(capabilityOf('words'), 'measured')
  assert.equal(capabilityOf('characters'), 'measured')
  assert.equal(capabilityOf('spacing'), 'applied')
  assert.equal(capabilityOf('font-size'), 'applied')
  assert.equal(capabilityOf('margins'), 'applied')
  assert.equal(capabilityOf('citation'), 'manual')
  // THE FONT FAMILY IS NOT IN THE FIXED TABLE, because what we can do with it
  // depends on which family was asked for. That is the whole correction.
  assert.equal(fontFamilyCapability('Tinos'), 'applied')
  assert.equal(fontFamilyCapability('Times New Roman'), 'substituted')
  assert.equal(fontFamilyCapability('Garamond'), 'manual')
  // Every field is accounted for: a new one cannot be added without a decision.
  for (const [field, capability] of Object.entries(STUDIO_CAPABILITIES)) {
    assert.ok(['measured', 'applied', 'manual'].includes(capability), field)
  }
})

test('1. one page single-spaced: measured pages, applied single spacing', () => {
  const caps = resolveRequirementCapabilities(ONE_PAGE_SINGLE)
  assert.equal(caps.paginated, true)
  assert.deepEqual({ min: caps.pages!.min, max: caps.pages!.max }, { min: null, max: 1 })
  assert.equal(caps.pages!.spacing, 'single')
  assert.equal(caps.pages!.spacingSource, 'school')
  assert.equal(caps.pages!.fractionalMax, false)
  assert.equal(caps.words, null)
  assert.deepEqual(caps.manualReview, [])
})

test('2. a page and a half double-spaced: the fractional boundary', () => {
  const caps = resolveRequirementCapabilities(PAGE_AND_A_HALF)
  assert.equal(caps.pages!.max, 1.5)
  assert.equal(caps.pages!.fractionalMax, true)
  assert.equal(caps.pages!.spacing, 'double')
  assert.equal(caps.pages!.spacingSource, 'school')
  // The line box doubles, which is what makes the page hold half as much.
  assert.equal(caps.geometry.lineHeightPt, 27.75)
  assert.deepEqual(caps.manualReview, [])
})

test('3. two pages double-spaced: a whole bound is not fractional', () => {
  const caps = resolveRequirementCapabilities(TWO_PAGE_DOUBLE)
  assert.equal(caps.pages!.max, 2)
  assert.equal(caps.pages!.fractionalMax, false)
  assert.equal(caps.pages!.spacing, 'double')
})

test('4. words only: NO PAGE LIMIT IS MANUFACTURED', () => {
  // The refusal this product is built on. A word count says nothing about how
  // many pages it fills, so there is no page bound and no page to lay out.
  const caps = resolveRequirementCapabilities(WORDS_ONLY)
  assert.deepEqual(caps.words, { min: null, max: 500 })
  assert.equal(caps.pages, null)
  assert.equal(caps.paginated, false)
  assert.deepEqual(caps.manualReview, [])
})

test('5. characters only: the school’s own spacesCount rule travels with it', () => {
  const caps = resolveRequirementCapabilities(CHARACTERS_ONLY)
  assert.deepEqual(caps.characters, { min: null, max: 3000, spacesCount: true })
  assert.equal(caps.pages, null)
  assert.equal(caps.paginated, false)
})

test('6. words AND pages: both bind, and neither excuses the other', () => {
  const caps = resolveRequirementCapabilities(WORDS_AND_PAGES)
  assert.deepEqual(caps.words, { min: null, max: 500 })
  assert.equal(caps.pages!.max, 2)
  assert.equal(caps.paginated, true)
})

test('7. pages with typography: size and margins applied, family handed over', () => {
  const caps = resolveRequirementCapabilities(PAGES_WITH_TYPOGRAPHY)
  const applied = Object.fromEntries(caps.applied.map((a) => [a.field, a]))
  assert.equal(applied['font-size']!.label, '11 pt')
  assert.equal(applied['font-size']!.source, 'school')
  assert.equal(applied.margins!.label, '1.25-inch margins')
  assert.equal(applied.margins!.source, 'school')
  // The school said nothing about spacing or paper, so those stay ours.
  assert.equal(applied.spacing!.source, 'studio-default')
  assert.equal(applied.paper!.source, 'studio-default')
  // THE FONT IS SUBSTITUTED, not handed back: Tinos breaks the page where
  // Times New Roman would, so the figure holds -- and it is still not that
  // font, which the panel says in its own row.
  assert.equal(caps.font.support, 'substituted')
  assert.deepEqual(caps.manualReview.map((m) => m.field), [])
  // And the content box really did narrow: 1.25in margins, not our 1in.
  assert.equal(contentBox(caps.geometry).widthPt, (8.5 - 2.5) * 72)
})

test('8. nothing stated about formatting: every applied line is ours', () => {
  const caps = resolveRequirementCapabilities(NO_FORMATTING)
  assert.ok(caps.applied.every((a) => a.source === 'studio-default'))
  assert.deepEqual(
    caps.applied.map((a) => a.label).sort(),
    ['1-inch margins', '12 pt', 'Single-spaced', 'Tinos', 'US Letter'],
  )
})

test('9. a citation format gets a NARROW manual-review line, not a disclaimer', () => {
  const caps = resolveRequirementCapabilities(CITATION_SCHOOL)
  assert.deepEqual(caps.manualReview.map((m) => m.field), ['citation'])
  assert.equal(caps.manualReview[0]!.label, 'APA 7th edition')
  assert.match(caps.manualReview[0]!.reason, /not checked by the Studio/)
  // And the list says nothing about pages, spacing or margins, which the
  // Studio measures or applies. The sentence that used to be asserted here is
  // gone -- it was a second copy of the chips; see QA-010.
  for (const item of caps.manualReview) {
    assert.doesNotMatch(item.field, /page|spacing|margin/i)
  }
})

test('10. a fractional bound that is not 1.5 behaves identically', () => {
  const caps = resolveRequirementCapabilities(HALF_PAGE)
  assert.equal(caps.pages!.max, 0.5)
  assert.equal(caps.pages!.fractionalMax, true)
  for (const max of [0.25, 1.1, 2.75, 3.5]) {
    const other = resolveRequirementCapabilities(pageSchool({ max }))
    assert.equal(other.pages!.fractionalMax, true, `max ${max}`)
  }
})

test('a minimum is a bound too', () => {
  const caps = resolveRequirementCapabilities(PAGE_RANGE)
  assert.deepEqual({ min: caps.pages!.min, max: caps.pages!.max }, { min: 1, max: 2 })
})

test('no requirement at all: nothing measured, nothing to review', () => {
  for (const constraints of [NOTHING_STATED, null]) {
    const caps = resolveRequirementCapabilities(constraints)
    assert.equal(caps.words, null)
    assert.equal(caps.characters, null)
    assert.equal(caps.pages, null)
    assert.equal(caps.paginated, false)
    assert.deepEqual(caps.manualReview, [])
  }
})

test('A SPACING WITH NO PAGE COUNT STILL LAYS OUT THE PAGE', () => {
  // The school said how it must be spaced. Honouring that means rendering it,
  // even though there is no page figure to report.
  const caps = resolveRequirementCapabilities(pageSchool({ spacing: 'double' }))
  assert.equal(caps.paginated, true)
  assert.equal(caps.pages, null, 'no numbers were stated, so nothing is bounded')
  assert.equal(caps.geometry.spacing.source, 'school')
})

test('margins or a font size alone are enough to make the page real', () => {
  for (const t of [{ marginsInches: 1.5 }, { fontSizePt: 11 }]) {
    const caps = resolveRequirementCapabilities({ ...NO_CONSTRAINTS, typography: typography(t) })
    assert.equal(caps.paginated, true, JSON.stringify(t))
  }
  // But a font family alone is not: we cannot apply it, so there is nothing to
  // render differently and nothing a page would add.
  const family = resolveRequirementCapabilities(
    { ...NO_CONSTRAINTS, typography: typography({ fontFamily: 'Arial' }) })
  assert.equal(family.paginated, false)
  assert.deepEqual(family.manualReview.map((m) => m.field), ['font-family'])
})

test('NO SCHOOL IS NAMED ANYWHERE IN THE RESOLVER', () => {
  /*
   * The constraint the owner set, asserted on the source. Boston College is an
   * acceptance fixture, not an implementation detail, and the moment a name
   * appears here the whole model has been abandoned.
   */
  const source = readFileSync(new URL('./capabilities.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  for (const forbidden of ['Boston', 'College', 'schoolName', 'school_name', 'setId']) {
    assert.equal(source.includes(forbidden), false, `the resolver mentions ${forbidden}`)
  }
})

// ===========================================================================
// THE PANEL EACH SCHOOL PRODUCES
// ===========================================================================
//
// The same matrix, one layer up. Capability is only worth resolving if the
// panel differs because of it, so every row here is the compliance output for
// the record above -- different figures, different statuses, from one resolver.

/** The panel for a school, at a given measurement. */
const panel = (constraints: Constraints, m: {
  words?: number, characters?: number, pagesUsed?: number | null,
}) => complianceRows({
  capabilities: resolveRequirementCapabilities(constraints),
  measurements: {
    words: m.words ?? 0,
    characters: m.characters ?? 0,
    pagesUsed: m.pagesUsed ?? null,
    contentHeightPt: m.pagesUsed == null ? null
      : m.pagesUsed * contentBox(resolveRequirementCapabilities(constraints).geometry).heightPt,
  },
})

test('PANEL 1. one page single-spaced', () => {
  const rows = panel(ONE_PAGE_SINGLE, { pagesUsed: 0.84 })
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.detail]), [
    ['pages', 'met', '0.84 / 1.00 pages'],
    ['spacing', 'applied', null],
  ])
  assert.equal(panel(ONE_PAGE_SINGLE, { pagesUsed: 1.02 })[0]!.status, 'breached')
})

test('PANEL 2. a page and a half double-spaced', () => {
  const rows = panel(PAGE_AND_A_HALF, { pagesUsed: 1.42 })
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.detail]), [
    ['pages', 'met', '1.42 / 1.50 pages'],
    ['spacing', 'applied', null],
  ])
})

test('PANEL 3. two pages double-spaced reports against 2.00', () => {
  assert.equal(panel(TWO_PAGE_DOUBLE, { pagesUsed: 1.42 })[0]!.detail, '1.42 / 2.00 pages')
})

test('PANEL 4. a word school is evaluated in WORDS and never in pages', () => {
  const rows = panel(WORDS_ONLY, { words: 438 })
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.detail]), [
    ['words', 'met', '438 / 500 words'],
  ])
  // THE REFUSAL, AT THE PANEL. No page row appears even once a page height is
  // reported, because this school bounded no pages.
  assert.deepEqual(
    panel(WORDS_ONLY, { words: 438, pagesUsed: 3 }).map((r) => r.id), ['words'])
})

test('PANEL 5. a character school uses the canonical counter', () => {
  assert.deepEqual(panel(CHARACTERS_ONLY, { characters: 2840 })
    .map((r) => [r.id, r.status, r.detail]), [
    ['characters', 'met', '2,840 / 3,000 characters'],
  ])
})

test('PANEL 6. BOTH BIND, AND ONE PASSING DOES NOT EXCUSE THE OTHER', () => {
  // Inside the pages, over the words: two verdicts at once, neither softened.
  const rows = panel(WORDS_AND_PAGES, { words: 640, pagesUsed: 1.2 })
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(byId.pages!.status, 'met')
  assert.equal(byId.words!.status, 'breached')
  assert.equal(byId.words!.detail, '640 / 500 words')
  // And the other way round.
  const other = panel(WORDS_AND_PAGES, { words: 200, pagesUsed: 2.4 })
  const byId2 = Object.fromEntries(other.map((r) => [r.id, r]))
  assert.equal(byId2.pages!.status, 'breached')
  assert.equal(byId2.words!.status, 'met')
})

test('PANEL 7. stated typography is applied; the font is handed over', () => {
  const caps2 = resolveRequirementCapabilities(PAGES_WITH_TYPOGRAPHY)
  const rows = panel(PAGES_WITH_TYPOGRAPHY, { pagesUsed: 1.1 })
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(byId['font-size']!.status, 'applied')
  assert.equal(byId['font-size']!.label, '11 pt')
  assert.equal(byId.margins!.status, 'applied')
  assert.equal(byId.margins!.label, '1.25-inch margins')
  // The spacing is ours, so it is NOT claimed as a requirement of this school.
  assert.equal(byId.spacing, undefined)
  // AND THE FONT IS ITS OWN ROW, marked substituted rather than passed.
  assert.equal(rows.filter((r) => r.status === 'unverifiable').length, 0)
  const font = rows.find((r) => r.id === 'font-family')!
  assert.equal(font.status, 'substituted')
  assert.equal(font.label, 'Times New Roman')
  assert.ok(caps2.rendering.some((note) => /Tinos/.test(note)))
})

test('PANEL 8. nothing stated: no applied rows, because none were required', () => {
  assert.deepEqual(panel(NO_FORMATTING, { words: 100 }).map((r) => r.id), ['words'])
})

test('PANEL 9. a citation gets ONE narrow line, and pages are still measured', () => {
  const rows = panel(CITATION_SCHOOL, { pagesUsed: 1.42 })
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(byId.pages!.status, 'met', 'the page count is still measured')
  const manual = rows.filter((r) => r.status === 'unverifiable')
  assert.equal(manual.length, 1)
  assert.match(manual[0]!.label, /APA 7th edition/)
  // AND IT SAYS NOTHING ABOUT PAGES OR SPACING, which is what the blanket
  // sentence got wrong for exactly this shape of school.
  assert.doesNotMatch(manual[0]!.label, /page|spacing|margin/i)
})

test('PANEL 10. a 0.5-page bound is reported like any other', () => {
  assert.equal(panel(HALF_PAGE, { pagesUsed: 0.4 })[0]!.detail, '0.40 / 0.50 pages')
  assert.equal(panel(HALF_PAGE, { pagesUsed: 0.6 })[0]!.status, 'breached')
})

test('PANEL: a minimum is judged as well as a maximum', () => {
  const short = Object.fromEntries(
    panel(PAGE_RANGE, { pagesUsed: 0.8 }).map((r) => [r.id, r]))
  assert.equal(short.pages!.status, 'met', 'under the maximum')
  assert.equal(short['pages-min']!.status, 'breached', 'but under the minimum too')
  assert.equal(short['pages-min']!.detail, '0.80 / 1.00 pages')
  const ok = Object.fromEntries(
    panel(PAGE_RANGE, { pagesUsed: 1.5 }).map((r) => [r.id, r]))
  assert.equal(ok['pages-min']!.status, 'met')
})

test('PANEL: before the first layout pass, a page row is PENDING not met', () => {
  const rows = panel(PAGE_AND_A_HALF, {})
  assert.equal(rows[0]!.status, 'pending')
  assert.equal(rows[0]!.detail, null)
})

test('NO PANEL CLAIMS A PAGE COUNT CANNOT BE CHECKED', () => {
  // The sentence this whole model replaced, asserted across the matrix.
  for (const constraints of [ONE_PAGE_SINGLE, PAGE_AND_A_HALF, TWO_PAGE_DOUBLE,
    WORDS_ONLY, CHARACTERS_ONLY, WORDS_AND_PAGES, PAGES_WITH_TYPOGRAPHY,
    CITATION_SCHOOL, HALF_PAGE, PAGE_RANGE, NOTHING_STATED]) {
    for (const row of panel(constraints, { words: 10, characters: 10, pagesUsed: 1 })) {
      assert.doesNotMatch(row.label, /counts words and characters only/i)
      assert.doesNotMatch(row.label, /cannot check page count/i)
    }
  }
})

// ===========================================================================
// THE FONT FAMILY, AND THE OTHER-INSTRUCTIONS BUCKET
// ===========================================================================

const withFont = (fontFamily: string | null): Constraints => ({
  ...pageSchool({ max: 2, spacing: 'double' }),
  typography: typography({ fontFamily, fontSizePt: 12, marginsInches: 1 }),
})

test('A SUPPORTED FONT IS APPLIED, NOT SENT TO MANUAL REVIEW', () => {
  const caps = resolveRequirementCapabilities(withFont('Tinos'))
  assert.equal(caps.font.support, 'exact')
  assert.deepEqual(caps.manualReview.map((m) => m.field), [])
  const applied = Object.fromEntries(caps.applied.map((a) => [a.field, a]))
  assert.equal(applied['font-family']!.source, 'school')
  assert.equal(applied['font-family']!.label, 'Tinos')
})

test('A SUBSTITUTED FONT IS NEITHER APPLIED NOR MANUAL', () => {
  /*
   * The state this exists for. The page breaks where it would break in Times
   * New Roman, so the page figure is trustworthy -- and the school did not get
   * the font it asked for, so nothing claims it did.
   */
  const caps = resolveRequirementCapabilities(withFont('Times New Roman'))
  assert.equal(caps.font.support, 'substituted')
  assert.deepEqual(caps.manualReview.map((m) => m.field), [],
    'a substitution is not handed back to the applicant')
  const applied = Object.fromEntries(caps.applied.map((a) => [a.field, a]))
  assert.equal(applied['font-family']!.source, 'studio-default',
    'and it is NOT listed as a requirement we met')

  // It surfaces as its own row, marked as its own thing.
  const rows = panel(withFont('Times New Roman'), { pagesUsed: 1.2 })
  const font = rows.find((r) => r.id === 'font-family')
  assert.notEqual(font, undefined, 'the substitution must be visible')
  assert.equal(font!.status, 'substituted')
  // THE ROW CARRIES THE SCHOOL'S WORDING ONLY. What the Studio renders instead
  // is a separate claim under its own heading, so this row cannot be misread
  // as "Tinos satisfies Times New Roman".
  assert.equal(font!.label, 'Times New Roman')
  assert.doesNotMatch(font!.label, /Tinos/)
  assert.ok(caps.rendering.some((note) => /Tinos/.test(note)))
  assert.ok(caps.rendering.some((note) =>
    /does not satisfy the font-family requirement/.test(note)))
  // NO ROW IN THE PANEL CALLS THIS A PASS.
  assert.notEqual(font!.status, 'applied')
  assert.notEqual(font!.status, 'met')
})

test('an unsupported font goes to manual review with a specific message', () => {
  const caps = resolveRequirementCapabilities(withFont('Garamond'))
  assert.equal(caps.font.support, 'unsupported')
  assert.deepEqual(caps.manualReview.map((m) => m.label), ['Garamond'])
  assert.match(caps.manualReview[0]!.reason, /does not ship this font/)
  // And no font row claims anything in the panel.
  const rows = panel(withFont('Garamond'), { pagesUsed: 1.2 })
  assert.equal(rows.some((r) => r.status === 'substituted'), false)
})

test('the size and margins are applied whatever the font does', () => {
  // The fields are independent: an unrecognised family does not drag the
  // numbers beside it into manual review.
  const caps = resolveRequirementCapabilities(withFont('Garamond'))
  const applied = Object.fromEntries(caps.applied.map((a) => [a.field, a]))
  assert.equal(applied['font-size']!.source, 'school')
  assert.equal(applied.margins!.source, 'school')
})

test('"NOT STATED" IS AN ABSENCE, NOT A REQUIREMENT', () => {
  /*
   * Every one of these is a real other_instructions value from the imported
   * catalog. The first group is the importer recording that a school said
   * nothing; passing them through produced lines like
   *
   *     Not stated (typewritten) — not checked by the Studio
   *
   * which sends an applicant to verify something never asked of them.
   */
  const absences = [
    'Not stated (typewritten)',
    'Not stated (typed)',
    "Not stated (only 'typed')",
    'Not stated (typewritten or word-processed)',
  ]
  for (const instruction of absences) {
    const caps = resolveRequirementCapabilities(
      { ...pageSchool({ max: 1.5, spacing: 'double' }), otherInstructions: [instruction] })
    assert.deepEqual(caps.manualReview, [], instruction)
  }
})

test('and an instruction that MENTIONS "not stated" is still a requirement', () => {
  /*
   * The distinction that makes the rule safe rather than a keyword filter.
   * These are also real catalog values: each one opens with something the
   * school DID require, and only then notes what it left unsaid.
   */
  const kept = [
    'Typewritten; font and margins not stated',
    'Times New Roman, 12 point; margins not stated',
    '12-point; family and margins not stated',
  ]
  for (const instruction of kept) {
    const caps = resolveRequirementCapabilities(
      { ...NO_CONSTRAINTS, otherInstructions: [instruction] })
    assert.deepEqual(caps.manualReview.map((m) => m.label), [instruction], instruction)
  }
})

test('THE WHOLE IMPORTED CATALOG, run through the resolver', () => {
  /*
   * Not a fixture: the real file, every document. The resolver must produce a
   * sane panel for all 80 without any of them being named anywhere in it.
   */
  const catalog = JSON.parse(
    readFileSync('local-review/statement_requirements_catalog.json', 'utf8')) as {
      documents: readonly Record<string, unknown>[]
    }
  assert.equal(catalog.documents.length, 80)
  let reviewed = 0
  for (const doc of catalog.documents) {
    const instructions = (doc.other_instructions ?? []) as readonly string[]
    const constraints: Constraints = {
      ...NO_CONSTRAINTS,
      otherInstructions: Array.isArray(instructions) ? instructions : [],
      pages: doc.max_pages == null && doc.page_spacing == null ? null : pageLimit({
        min: (doc.min_pages ?? null) as number | null,
        max: (doc.max_pages ?? null) as number | null,
        spacing: (doc.page_spacing ?? null) as 'single' | 'double' | null,
        enforcement: enforced,
      }),
    }
    const caps = resolveRequirementCapabilities(constraints)
    reviewed += caps.manualReview.length
    // NOT ONE DOCUMENT PRODUCES AN ABSENCE AS A REQUIREMENT.
    for (const item of caps.manualReview) {
      assert.doesNotMatch(item.label, /^not stated/i, `${String(doc.id)}: ${item.label}`)
    }
  }
  // And the bucket is not empty either: real instructions still reach a human.
  assert.ok(reviewed > 0, 'genuine instructions must still be reviewed')
})

// ===========================================================================
// PERMITTED CHOICES  (migration 010; no catalog row uses these yet)
// ===========================================================================

const choiceSchool = (
  families: readonly string[] | null, sizes: readonly number[] | null,
): Constraints => ({
  ...pageSchool({ max: 2, spacing: 'double' }),
  typography: {
    fontSizePt: null, fontFamily: null, marginsInches: null,
    fontFamilyOptions: families, fontSizePtOptions: sizes,
  },
})

test('SOUTHERN MISSISSIPPI: a choice is a permission, not a requirement', () => {
  // "Times Roman or Arial, 11 or 12 point", stored in the school's own wording.
  const caps = resolveRequirementCapabilities(
    choiceSchool(['Arial', 'Times Roman'], [11, 12]))

  // THE STUDIO DEFAULT IS CHOSEN BECAUSE THE SCHOOL PERMITS IT -- not because
  // 12 is larger. Larger is stricter against a maximum and looser against a
  // minimum, so "larger is safer" is not a rule.
  assert.equal(caps.geometry.fontSizePt.value, 12)
  assert.equal(caps.geometry.fontSizePt.source, 'school-choice')

  // Times Roman resolves through the registry to the Tinos substitution; Arial
  // does not resolve at all. The better of the two decides the set.
  assert.equal(caps.font.support, 'substituted')
  assert.deepEqual(caps.manualReview, [], 'a permitted set is not handed back')

  // The panel shows the SET under what the school said, never the one we chose.
  const applied = Object.fromEntries(caps.applied.map((a) => [a.field, a]))
  assert.equal(applied['font-family']!.label, 'Arial or Times Roman')
  assert.equal(applied['font-family']!.source, 'school-choice')
  assert.equal(applied['font-size']!.label, '11 or 12 pt')
  assert.equal(applied['font-size']!.source, 'school-choice')
})

test('and the rendering note NEVER implies the school permits Tinos', () => {
  const caps = resolveRequirementCapabilities(
    choiceSchool(['Arial', 'Times Roman'], [11, 12]))
  const notes = caps.rendering.join(' ')
  assert.match(notes, /substitute for the permitted Times Roman option/)
  assert.match(notes, /Use an explicitly permitted font in the final submitted document/)
  assert.match(notes, /Rendering at 12 pt, which the school permits/)
  /*
    The claim that must never appear: Tinos itself being permitted.

    ASSERTED ON THE CLAIM, NOT ON PROXIMITY. A regex forbidding "permit"
    anywhere after "Tinos" also rejects the correct sentence -- "a substitute
    for the PERMITTED Times Roman option" -- where what is permitted is Times
    Roman. The wrong statement is Tinos as the subject of the permission.
  */
  for (const forbidden of [
    /Tinos,? (is|was|would be)? ?(permitted|allowed|accepted)/i,
    /(permitted|allowed|accepted) font:? Tinos/i,
    /Tinos,? which the school (permits|allows|accepts)/i,
  ]) {
    assert.doesNotMatch(notes, forbidden, String(forbidden))
  }
  // And the compliance row stays substituted, never applied.
  const rows = panel(choiceSchool(['Arial', 'Times Roman'], [11, 12]), { pagesUsed: 1.2 })
  assert.equal(rows.find((r) => r.id === 'font-family')!.status, 'substituted')
})

test('A CHOICE CONTAINING A FONT WE SHIP IS MET EXACTLY', () => {
  // The upside of a permission: we may pick the option we honour, so a school
  // offering a choice can be satisfied where one naming a single unshipped
  // font could not.
  const caps = resolveRequirementCapabilities(choiceSchool(['Garamond', 'Tinos'], null))
  assert.equal(caps.font.support, 'exact')
  assert.deepEqual(caps.manualReview, [])
  assert.ok(caps.rendering.some((n) => /Rendering in Tinos, which the school permits/.test(n)))
})

test('a choice of fonts we neither ship nor approximate is manual', () => {
  const caps = resolveRequirementCapabilities(choiceSchool(['Arial', 'Calibri'], null))
  assert.equal(caps.font.support, 'unsupported')
  assert.deepEqual(caps.manualReview.map((m) => m.label), ['Arial or Calibri'])
})

test('the chosen size is the permitted one NEAREST our default', () => {
  // Our default is 12. When it is not permitted the choice is deterministic and
  // disclosed, never dressed up as the safe option.
  for (const [options, expected] of [
    [[10, 11], 11], [[13, 14], 13], [[10, 14], 10], [[11, 13], 11],
  ] as const) {
    const caps = resolveRequirementCapabilities(choiceSchool(null, [...options]))
    assert.equal(caps.geometry.fontSizePt.value, expected, options.join('/'))
    assert.equal(caps.geometry.fontSizePt.source, 'school-choice')
  }
})

test('a permitted set alone makes the page real', () => {
  assert.equal(resolveRequirementCapabilities({
    ...NO_CONSTRAINTS,
    typography: {
      fontSizePt: null, fontFamily: null, marginsInches: null,
      fontFamilyOptions: null, fontSizePtOptions: [11, 12],
    },
  }).paginated, true)
})

test('THE SCHOOL’S WORDING IS NEVER REWRITTEN TO THE REGISTRY’S', () => {
  /*
   * "Times Roman" is an alias the registry recognises, and resolving it is a
   * RENDERING decision. What a school said is not edited to make a fingerprint
   * stable -- deterministic ordering already does that.
   */
  const caps = resolveRequirementCapabilities(choiceSchool(['Arial', 'Times Roman'], null))
  const applied = Object.fromEntries(caps.applied.map((a) => [a.field, a]))
  assert.match(applied['font-family']!.label, /Times Roman/)
  assert.doesNotMatch(applied['font-family']!.label, /Times New Roman/)
  // The registry still resolved it: that is what makes the substitution legal.
  assert.equal(caps.font.support, 'substituted')
})

test('NO TWO COMPLIANCE ROWS EVER SHARE AN ID', () => {
  /*
   * The font briefly had two: an `applied` row from the layout list and a
   * `substituted` row of its own. Whichever a reader met first won, and the
   * first was the one that called a substitution a pass.
   */
  for (const constraints of [ONE_PAGE_SINGLE, PAGE_AND_A_HALF, TWO_PAGE_DOUBLE,
    WORDS_ONLY, CHARACTERS_ONLY, WORDS_AND_PAGES, PAGES_WITH_TYPOGRAPHY,
    CITATION_SCHOOL, HALF_PAGE, PAGE_RANGE,
    choiceSchool(['Arial', 'Times Roman'], [11, 12]),
    choiceSchool(['Garamond', 'Tinos'], null),
    choiceSchool(['Arial', 'Calibri'], null)]) {
    const ids = panel(constraints, { words: 10, characters: 10, pagesUsed: 1 })
      .map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length, ids.join(','))
  }
})

// ===========================================================================
// THE NORMALIZED CATALOG
// ===========================================================================

test('TYPOGRAPHY IS STRUCTURED, NOT PROSE, ACROSS THE WHOLE CATALOG', () => {
  /*
   * The regression the normalization stage closes. Every school that states a
   * font, a size or a margin must carry it in the typed columns -- not in
   * other_instructions, where the resolver would hand it back to the applicant
   * as something to verify by hand.
   *
   * Reads the real generated catalog, not a fixture.
   */
  const catalog = JSON.parse(readFileSync(
    'local-review/statement_requirements_catalog.json', 'utf8')) as {
      documents: readonly Record<string, unknown>[]
    }
  assert.equal(catalog.documents.length, 80)

  let structured = 0
  for (const doc of catalog.documents) {
    const prose = (doc.other_instructions ?? []) as readonly string[]
    if (doc.font_size_pt != null || doc.font_family != null
      || doc.margins_inches != null) structured += 1

    for (const line of prose) {
      // AN ABSENCE IS NOT A REQUIREMENT.
      assert.doesNotMatch(line, /^\s*not stated/i, `${String(doc.id)}: ${line}`)
      // A SIZE OR A FAMILY LEFT IN PROSE means the typed column was skipped.
      // The one exception is a permitted CHOICE, which this schema cannot hold
      // until migration 010 adds the option columns.
      if (/\bor\b/i.test(line)) continue
      assert.doesNotMatch(line, /\b1[0-4][\s-]*(pt|point)\b/i,
        `${String(doc.id)}: a size is still prose -- ${line}`)
      assert.doesNotMatch(line, /\btimes new roman\b/i,
        `${String(doc.id)}: a family is still prose -- ${line}`)
    }
  }
  assert.equal(structured, 8, 'eight documents state typography')
})

test('the normalized catalog produces NO manual line for a typed-medium school', () => {
  // Boston College's row carried "Not stated (typewritten)". A Studio essay is
  // typewritten by construction, so there is nothing for the applicant to do.
  const catalog = JSON.parse(readFileSync(
    'local-review/statement_requirements_catalog.json', 'utf8')) as {
      documents: readonly { id: string, other_instructions?: readonly string[] }[]
    }
  const boston = catalog.documents.find(
    (d) => d.id === 'd4e79cfc-8aa1-5c27-882b-3a9febbf3172')
  assert.notEqual(boston, undefined, 'the Boston row moved')
  assert.deepEqual([...(boston!.other_instructions ?? [])], [])
})
