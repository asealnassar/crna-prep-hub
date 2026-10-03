import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NO_CONSTRAINTS, type Constraints } from './constraints.ts'
import {
  NO_STATED_LENGTH, constraintLines, constraintSummary, labelledConstraints, liveCountLabel,
  showUnmeasuredNotice,
} from './constraintText.ts'

const pages = (max: number, spacing: 'single' | 'double' | null): Constraints =>
  ({ ...NO_CONSTRAINTS, pages: { min: null, max, spacing } })

test('a word maximum reads as a word maximum', () => {
  assert.deepEqual([...constraintLines({ ...NO_CONSTRAINTS, words: { min: null, max: 500 } })],
    ['500 words maximum'])
})

test('a word range reads as a range, with an en dash', () => {
  assert.deepEqual([...constraintLines({ ...NO_CONSTRAINTS, words: { min: 500, max: 1000 } })],
    ['500–1,000 words'])
})

test('a minimum alone reads as a minimum', () => {
  assert.deepEqual([...constraintLines({ ...NO_CONSTRAINTS, words: { min: 300, max: null } })],
    ['300 words minimum'])
})

test('PAGES NEVER ACQUIRE A WORD ESTIMATE', () => {
  // Every phrasing a reader might mistake for a conversion is refused.
  for (const constraints of [pages(1, null), pages(2, 'double'), pages(3, 'single')]) {
    const text = constraintLines(constraints).join(' | ')
    assert.doesNotMatch(text, /word/i, text)
    assert.doesNotMatch(text, /about|approx|roughly|~|est\./i, text)
  }
})

test('spacing travels with the page count, because it changes what a page is', () => {
  assert.deepEqual([...constraintLines(pages(2, 'double'))], ['2 pages maximum (double-spaced)'])
  assert.deepEqual([...constraintLines(pages(1, 'single'))], ['1 page maximum (single-spaced)'])
  assert.deepEqual([...constraintLines(pages(1, null))], ['1 page maximum'])
})

test('a character limit always says whether spaces count', () => {
  const including: Constraints = { ...NO_CONSTRAINTS, characters: { min: null, max: 2500, spacesCount: true } }
  assert.deepEqual([...constraintLines(including)], ['2,500 characters maximum including spaces'])
  const excluding: Constraints = { ...NO_CONSTRAINTS, characters: { min: null, max: 2500, spacesCount: false } }
  assert.deepEqual([...constraintLines(excluding)], ['2,500 characters maximum excluding spaces'])
})

test('an unstated spaces rule SAYS SO rather than picking one', () => {
  const unstated: Constraints = { ...NO_CONSTRAINTS, characters: { min: null, max: 2500, spacesCount: null } }
  const line = constraintLines(unstated)[0]!
  assert.match(line, /does not state whether spaces count/)
  assert.doesNotMatch(line, /\bincluding spaces\b|\bexcluding spaces\b/)
})

test('typography, margins and citations are rendered in the school’s words', () => {
  const formatting: Constraints = {
    ...NO_CONSTRAINTS,
    typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: 1 },
    citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: 3 },
  }
  const lines = [...constraintLines(formatting)]
  assert.deepEqual(lines, ['12-point Times New Roman', '1-inch margins',
    'APA 7th edition, at least 3 references'])
  // The EDITION survives: collapsing to "apa" would lose part of the requirement.
  assert.ok(lines.some((l) => l.includes('7th edition')))
})

test('free-text instructions are reproduced verbatim and last', () => {
  const other: Constraints = {
    ...NO_CONSTRAINTS,
    words: { min: null, max: 500 },
    otherInstructions: ['excluding cover and references', 'business letter format'],
  }
  assert.deepEqual([...constraintLines(other)],
    ['500 words maximum', 'excluding cover and references', 'business letter format'])
})

test('nothing stated reads as nothing stated, not as "no limit"', () => {
  assert.deepEqual([...constraintLines(NO_CONSTRAINTS)], [])
  assert.equal(constraintSummary(NO_CONSTRAINTS), NO_STATED_LENGTH)
  assert.doesNotMatch(NO_STATED_LENGTH, /unlimited|no limit/i)
})

test('every line is tagged with whether this editor checks it', () => {
  const mixed: Constraints = {
    ...NO_CONSTRAINTS,
    words: { min: null, max: 500 },
    pages: { min: null, max: 2, spacing: 'double' },
    typography: { fontSizePt: 12, fontFamily: null, marginsInches: 1 },
    citation: { family: 'ama', statedAs: 'AMA format', minReferences: null },
    otherInstructions: ['no cover page'],
  }
  const labelled = labelledConstraints(mixed)
  const measured = labelled.filter((l) => l.measured).map((l) => l.kind)
  const unmeasured = labelled.filter((l) => !l.measured).map((l) => l.kind)
  assert.deepEqual(measured, ['words'])
  assert.deepEqual(unmeasured, ['pages', 'font', 'margins', 'citation', 'other'])
  // MEASURED COMES FIRST, so the reader sees the watched number before the rest.
  assert.equal(labelled[0]!.kind, 'words')
})

test('the labelled view and the plain view never disagree', () => {
  const mixed: Constraints = {
    words: { min: 500, max: 700 },
    characters: { min: 100, max: 3000, spacesCount: false },
    pages: { min: 1, max: 3, spacing: 'single' },
    typography: { fontSizePt: 11, fontFamily: 'Arial', marginsInches: 1.5 },
    citation: { family: 'other', statedAs: 'Chicago', minReferences: 1 },
    otherInstructions: ['one instruction'],
  }
  assert.deepEqual(labelledConstraints(mixed).map((l) => l.text), [...constraintLines(mixed)])
})

test('the notice appears only when something is unmeasurable', () => {
  assert.equal(showUnmeasuredNotice({ ...NO_CONSTRAINTS, words: { min: null, max: 500 } }), false)
  assert.equal(showUnmeasuredNotice(pages(2, 'double')), true)
  assert.equal(showUnmeasuredNotice(NO_CONSTRAINTS), false)
})

// -------------------------------------------------- the live counter label

test('a word counter shows the limit when there is one, and no slash when there is not', () => {
  const withMax: Constraints = { ...NO_CONSTRAINTS, words: { min: null, max: 1000 } }
  assert.equal(liveCountLabel({ kind: 'words', constraints: withMax, words: 412, text: '' }),
    '412 / 1,000 words')
  assert.equal(liveCountLabel({ kind: 'words', constraints: NO_CONSTRAINTS, words: 412, text: '' }),
    '412 words')
})

test('a page-limited requirement’s word counter states NO limit', () => {
  // Rutgers: one page, no word count. The counter must not borrow the page number.
  const label = liveCountLabel({ kind: 'words', constraints: pages(1, null), words: 412, text: '' })
  assert.equal(label, '412 words')
  assert.doesNotMatch(label, /\/|1\b.*page/)
})

test('a character counter counts the text by its own spaces rule', () => {
  const chars: Constraints = { ...NO_CONSTRAINTS, characters: { min: null, max: 2500, spacesCount: false } }
  const label = liveCountLabel({ kind: 'characters', constraints: chars, words: 2, text: 'ab cd' })
  assert.equal(label, '4 / 2,500 characters excluding spaces')
})

test('an ambiguous character limit shows a bare count, with no claim about spaces', () => {
  const chars: Constraints = { ...NO_CONSTRAINTS, characters: { min: null, max: 2500, spacesCount: null } }
  const label = liveCountLabel({ kind: 'characters', constraints: chars, words: 2, text: 'ab cd' })
  assert.equal(label, '5 / 2,500 characters')
})
