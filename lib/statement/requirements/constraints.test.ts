import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  NO_CONSTRAINTS, UNMEASURED_NOTICE, characterCount, characterLimitAmbiguous,
  constraintKinds, hasUnmeasurableConstraint, liveCounts, measurableInEditor, overages,
  shortfalls, unmeasurableKinds, type Constraints,
} from './constraints.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

function withWords(min: number | null, max: number | null): Constraints {
  return { ...NO_CONSTRAINTS, words: { min, max } }
}
function withChars(max: number | null, spacesCount: boolean | null): Constraints {
  return { ...NO_CONSTRAINTS, characters: { min: null, max, spacesCount } }
}

// -------------------------------------------------- what can be measured

test('words and characters are measurable; nothing else is', () => {
  assert.equal(measurableInEditor('words'), true)
  assert.equal(measurableInEditor('characters'), true)
  for (const kind of ['pages', 'spacing', 'font', 'margins', 'citation', 'other'] as const) {
    assert.equal(measurableInEditor(kind), false, kind)
  }
})

test('a page limit is reported as unmeasurable, and never as a word limit', () => {
  const pages: Constraints = { ...NO_CONSTRAINTS, pages: { min: null, max: 2, spacing: 'double' } }
  assert.deepEqual([...unmeasurableKinds(pages)], ['pages', 'spacing'])
  assert.equal(hasUnmeasurableConstraint(pages), true)
  // THE LOAD-BEARING ASSERTION: no word bound materialises from a page count.
  assert.equal(pages.words, null)
  // And the live counter falls back to a plain word count with nothing to compare.
  assert.deepEqual([...liveCounts(pages)], ['words'])
})

test('a word-only requirement needs no notice', () => {
  assert.equal(hasUnmeasurableConstraint(withWords(null, 500)), false)
  assert.deepEqual([...unmeasurableKinds(withWords(null, 500))], [])
})

test('constraintKinds reports every kind present, and only those', () => {
  assert.deepEqual([...constraintKinds(NO_CONSTRAINTS)], [])
  const everything: Constraints = {
    words: { min: 500, max: 700 },
    characters: { min: null, max: 2500, spacesCount: true },
    pages: { min: null, max: 3, spacing: 'single' },
    typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: 1 },
    citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: 3 },
    otherInstructions: ['excluding cover and references'],
  }
  assert.deepEqual([...constraintKinds(everything)],
    ['words', 'characters', 'pages', 'spacing', 'font', 'margins', 'citation', 'other'])
})

test('margins alone still register, and font alone does not claim margins', () => {
  const marginsOnly: Constraints = {
    ...NO_CONSTRAINTS, typography: { fontSizePt: null, fontFamily: null, marginsInches: 1 },
  }
  assert.deepEqual([...constraintKinds(marginsOnly)], ['margins'])
  const fontOnly: Constraints = {
    ...NO_CONSTRAINTS, typography: { fontSizePt: 12, fontFamily: null, marginsInches: null },
  }
  assert.deepEqual([...constraintKinds(fontOnly)], ['font'])
})

test('the notice says what it cannot check, and promises no checking', () => {
  assert.match(UNMEASURED_NOTICE, /counts words and characters only/)
  for (const unmeasured of ['page count', 'spacing', 'font', 'margins', 'citation']) {
    assert.ok(UNMEASURED_NOTICE.includes(unmeasured), unmeasured)
  }
  assert.doesNotMatch(UNMEASURED_NOTICE, /verif(y|ied)|check(ed|s) your (page|font|margin)/i)
})

// -------------------------------------------------- live counters

test('the counter follows the unit the school used', () => {
  assert.deepEqual([...liveCounts(withWords(null, 500))], ['words'])
  assert.deepEqual([...liveCounts(withChars(2500, true))], ['characters'])
  // Both stated: both shown, words first.
  const both: Constraints = { ...withWords(null, 500), characters: { min: null, max: 3000, spacesCount: false } }
  assert.deepEqual([...liveCounts(both)], ['words', 'characters'])
  // Nothing stated: a word count, with nothing to compare it against.
  assert.deepEqual([...liveCounts(NO_CONSTRAINTS)], ['words'])
})

// -------------------------------------------------- characters

test('characters are counted in CODE POINTS, matching the database', () => {
  // An astral character is ONE code point and TWO UTF-16 units. Postgres
  // char_length() says 1; String.length says 2. This counter must say 1.
  const astral = '\u{1F600}'
  assert.equal(astral.length, 2, 'precondition: two UTF-16 units')
  assert.equal(characterCount(astral, true), 1)
})

test('excluding spaces excludes ALL whitespace, newlines included', () => {
  const text = 'ab cd\nef\tgh'
  assert.equal(characterCount(text, true), 11)
  assert.equal(characterCount(text, false), 8)
})

test('an unstated spaces rule counts spaces -- the stricter reading', () => {
  const text = 'a b c'
  assert.equal(characterCount(text, null), characterCount(text, true))
  assert.notEqual(characterCount(text, null), characterCount(text, false))
})

test('the ambiguity is surfaced rather than resolved', () => {
  assert.equal(characterLimitAmbiguous(withChars(2500, null)), true)
  assert.equal(characterLimitAmbiguous(withChars(2500, true)), false)
  assert.equal(characterLimitAmbiguous(withChars(2500, false)), false)
  assert.equal(characterLimitAmbiguous(NO_CONSTRAINTS), false)
})

test('a non-string counts as nothing rather than throwing', () => {
  assert.equal(characterCount(undefined as unknown as string, true), 0)
})

// -------------------------------------------------- overages and shortfalls

test('over a word maximum is reported with the overage', () => {
  const found = overages({ constraints: withWords(null, 500), words: 540, text: 'x' })
  assert.equal(found.length, 1)
  assert.deepEqual(found[0], { kind: 'words', count: 540, max: 500, over: 40 })
})

test('exactly at the maximum is NOT over', () => {
  assert.deepEqual(overages({ constraints: withWords(null, 500), words: 500, text: '' }), [])
})

test('over a character maximum is measured in the requirement’s own spaces rule', () => {
  const text = 'a '.repeat(10) // 20 chars with spaces, 10 without
  const including = overages({ constraints: withChars(15, true), words: 10, text })
  assert.equal(including.length, 1)
  assert.equal(including[0]!.count, 20)
  const excluding = overages({ constraints: withChars(15, false), words: 10, text })
  assert.deepEqual(excluding, [], '10 characters is within 15')
})

test('A PAGE LIMIT CAN NEVER PRODUCE AN OVERAGE', () => {
  // The headline guarantee. A 50,000-word draft against a one-page limit is
  // not "over" anything this system can observe.
  const pages: Constraints = { ...NO_CONSTRAINTS, pages: { min: null, max: 1, spacing: 'double' } }
  assert.deepEqual(overages({ constraints: pages, words: 50_000, text: 'x'.repeat(200_000) }), [])
  assert.deepEqual(shortfalls({ constraints: pages, words: 0, text: '' }), [])
})

test('typography and citation produce no overage either', () => {
  const formatting: Constraints = {
    ...NO_CONSTRAINTS,
    typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: 1 },
    citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: 3 },
    otherInstructions: ['business letter format'],
  }
  assert.deepEqual(overages({ constraints: formatting, words: 9999, text: 'x' }), [])
})

test('a minimum is a shortfall, not an overage', () => {
  assert.deepEqual(overages({ constraints: withWords(500, null), words: 10, text: '' }), [])
  const short = shortfalls({ constraints: withWords(500, null), words: 10, text: '' })
  assert.equal(short.length, 1)
  assert.deepEqual(short[0], { kind: 'words', count: 10, max: 500, over: 490 })
})

test('both bounds can fire independently', () => {
  const range = withWords(500, 700)
  assert.deepEqual(shortfalls({ constraints: range, words: 600, text: '' }), [])
  assert.deepEqual(overages({ constraints: range, words: 600, text: '' }), [])
  assert.equal(shortfalls({ constraints: range, words: 400, text: '' }).length, 1)
  assert.equal(overages({ constraints: range, words: 800, text: '' }).length, 1)
})

// -------------------------------------------------- the source itself

test('NO MODULE-LEVEL CONVERSION CONSTANT EXISTS', () => {
  // A words-per-page or characters-per-word number anywhere in this file would
  // be the beginning of the conversion this module forbids. There is none, and
  // this test fails if somebody adds one.
  const source = read('./constraints.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(source, /wordsPerPage|charsPerWord|WORDS_PER_|CHARS_PER_|PER_PAGE/i)
  // 250 and 500 are the usual invented words-per-page figures.
  assert.doesNotMatch(source, /\b(?:250|275|300|500)\s*\*|\*\s*(?:250|275|300|500)\b/)
})
