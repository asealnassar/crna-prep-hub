import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ENFORCEMENT, ENFORCEMENTS, NO_CONSTRAINTS, characterCount,
  characterLimit, characterLimitAmbiguous, constraintKinds, hasAdvisoryLength,
  analyzerUnmeasuredKinds, hasTruncationPolicy, isStrict, liveCounts,
  overages, pageLimit, parseEnforcement, shortfalls, strictOverages, truncatedKinds,
  wordLimit, type Constraints,
} from './constraints.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

import { UT_KNOXVILLE } from './fixtures.ts'

function withWords(min: number | null, max: number | null): Constraints {
  return { ...NO_CONSTRAINTS, words: wordLimit({ min, max, enforcement: 'enforced' }) }
}
function withChars(max: number | null, spacesCount: boolean | null): Constraints {
  return { ...NO_CONSTRAINTS, characters: characterLimit({ max, spacesCount, enforcement: 'enforced' }) }
}

// -------------------------------------------------- what can be measured

test('THE ANALYSER\u2019S SCOPE IS FROZEN, AND IS NOT THE CAPABILITY MODEL', () => {
  /*
   * This file used to assert that words and characters were the only things
   * this product could measure. That is no longer true -- the Studio lays out
   * the page and counts it -- and what each field is worth now lives in
   * lib/statement/layout/capabilities.ts.
   *
   * What survives here is narrower and belongs to one caller: the kinds the
   * REVIEW PROMPT tells the model not to score. Widening it would change what
   * the analyser is asked to judge, which is a RUBRIC_VERSION decision.
   */
  const pages: Constraints = { ...NO_CONSTRAINTS,
    pages: pageLimit({ min: null, max: 2, spacing: 'double', enforcement: 'enforced' }) }
  assert.deepEqual([...analyzerUnmeasuredKinds(pages)], ['pages', 'spacing'])
  assert.deepEqual([...analyzerUnmeasuredKinds(withWords(null, 500))], [])
})

test('a page limit NEVER becomes a word limit', () => {
  const pages: Constraints = { ...NO_CONSTRAINTS,
    pages: pageLimit({ min: null, max: 2, spacing: 'double', enforcement: 'enforced' }) }
  // THE LOAD-BEARING ASSERTION: no word bound materialises from a page count.
  assert.equal(pages.words, null)
  // And the live counter falls back to a plain word count with nothing to compare.
  assert.deepEqual([...liveCounts(pages)], ['words'])
})

test('a word-only requirement states nothing beyond its words', () => {
  assert.deepEqual([...constraintKinds(withWords(null, 500))], ['words'])
})

test('constraintKinds reports every kind present, and only those', () => {
  assert.deepEqual([...constraintKinds(NO_CONSTRAINTS)], [])
  const everything: Constraints = {
    words: wordLimit({ min: 500, max: 700, enforcement: 'enforced' }),
    characters: characterLimit({ min: null, max: 2500, spacesCount: true, enforcement: 'enforced' }),
    pages: pageLimit({ min: null, max: 3, spacing: 'single', enforcement: 'enforced' }),
    typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: 1 },
    citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: 3 },
    unenforcedLength: 'a summary (1-2 pages)',
    otherInstructions: ['excluding cover and references'],
  }
  assert.deepEqual([...constraintKinds(everything)],
    ['words', 'characters', 'pages', 'spacing', 'font', 'margins', 'citation',
      'unenforced-length', 'other'])
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

test('THE BLANKET NOTICE IS GONE AND MUST NOT COME BACK', () => {
  /*
   * It told every applicant that this editor "counts words and characters only"
   * and could not check page count, spacing, font or margins. The Studio lays
   * out the page and measures it, so the sentence understated what the product
   * knew and sent people to re-do work it had already done.
   *
   * Asserted on the source, so a helpful future re-addition fails here.
   */
  const source = readFileSync(new URL('./constraints.ts', import.meta.url), 'utf8')
  assert.equal(source.includes("'This editor counts words"), false)
  assert.equal(/export function measurableInEditor/.test(source), false)
  assert.equal(/export const UNMEASURED_NOTICE/.test(source), false)
})

// -------------------------------------------------- live counters

test('the counter follows the unit the school used', () => {
  assert.deepEqual([...liveCounts(withWords(null, 500))], ['words'])
  assert.deepEqual([...liveCounts(withChars(2500, true))], ['characters'])
  // Both stated: both shown, words first.
  const both: Constraints = { ...withWords(null, 500), characters: characterLimit({ min: null, max: 3000, spacesCount: false, enforcement: 'enforced' }) }
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
  assert.deepEqual(found[0], {
    kind: 'words', count: 540, max: 500, over: 40, enforcement: 'enforced', statedAs: null,
  })
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
  const pages: Constraints = { ...NO_CONSTRAINTS,
    pages: pageLimit({ min: null, max: 1, spacing: 'double', enforcement: 'enforced' }) }
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
  assert.deepEqual(short[0], {
    kind: 'words', count: 10, max: 500, over: 490, enforcement: 'enforced', statedAs: null,
  })
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

// ===========================================================================
// THE LENGTH REGISTER
// ===========================================================================

test('the five registers are exactly the five the schools use', () => {
  assert.deepEqual([...ENFORCEMENTS],
    ['truncated', 'enforced', 'target', 'suggested', 'unknown'])
})

test('ONLY TWO REGISTERS ARE RULES', () => {
  // THE PREDICATE THE WHOLE FEATURE TURNS ON. A draft past a target, a
  // suggestion or an unknown figure has broken nothing.
  assert.equal(isStrict('enforced'), true)
  assert.equal(isStrict('truncated'), true)
  assert.equal(isStrict('target'), false)
  assert.equal(isStrict('suggested'), false)
  assert.equal(isStrict('unknown'), false)
})

test('AN ABSENT REGISTER IS READ AS THE STRICT DEFAULT', () => {
  // Every draft saved before this field existed has a word maximum that this
  // product has treated as a hard cap since the feature shipped. Reading an
  // absent register as anything softer would withdraw that warning from all of
  // them, which is a regression dressed up as a correction.
  assert.equal(DEFAULT_ENFORCEMENT, 'enforced')
  assert.equal(isStrict(DEFAULT_ENFORCEMENT), true)
  for (const absent of [undefined, null, '', 'ENFORCED', 'advisory-ish', 7, {}, []]) {
    assert.equal(parseEnforcement(absent), 'enforced', JSON.stringify(absent))
  }
  // And every real register survives a round trip.
  for (const known of ENFORCEMENTS) assert.equal(parseEnforcement(known), known)
})

test('an exceedance carries the register it broke, and the school’s words', () => {
  const suggested: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({
      max: 250, enforcement: 'suggested', statedAs: 'Suggested Length: Maximum of 250 words',
    }),
  }
  const found = overages({ constraints: suggested, words: 400, text: '' })
  assert.equal(found.length, 1, 'it is still reported -- the applicant wants to know')
  assert.equal(found[0]!.enforcement, 'suggested')
  assert.equal(found[0]!.statedAs, 'Suggested Length: Maximum of 250 words')
  assert.equal(found[0]!.over, 150)
})

test('strictOverages REPORTS ONLY WHAT THE SCHOOL MADE A RULE', () => {
  const soft = (enforcement: Parameters<typeof isStrict>[0]): Constraints =>
    ({ ...NO_CONSTRAINTS, words: wordLimit({ max: 250, enforcement, statedAs: 'x' }) })
  for (const enforcement of ENFORCEMENTS) {
    const constraints = soft(enforcement)
    const all = overages({ constraints, words: 400, text: '' })
    const strict = strictOverages({ constraints, words: 400, text: '' })
    assert.equal(all.length, 1, enforcement)
    assert.equal(strict.length, isStrict(enforcement) ? 1 : 0, enforcement)
  }
})

test('A TRUNCATED PAGE LIMIT PRODUCES NO OVERAGE, however long the draft', () => {
  // The strictest register there is still cannot make a page measurable.
  const truncated: Constraints = {
    ...NO_CONSTRAINTS,
    pages: pageLimit({
      max: 2,
      spacing: 'double',
      enforcement: 'truncated',
      statedAs: 'Only the first two pages will be read if your essay goes over the limit.',
    }),
  }
  assert.deepEqual(overages({ constraints: truncated, words: 50_000, text: 'x'.repeat(200_000) }), [])
  assert.deepEqual(strictOverages({ constraints: truncated, words: 50_000, text: 'x' }), [])
  // It is surfaced as a POLICY instead.
  assert.equal(hasTruncationPolicy(truncated), true)
  assert.deepEqual([...truncatedKinds(truncated)], ['pages'])
})

test('truncatedKinds names every unit the school stops reading', () => {
  assert.deepEqual([...truncatedKinds(NO_CONSTRAINTS)], [])
  assert.equal(hasTruncationPolicy(NO_CONSTRAINTS), false)
  const words: Constraints = {
    ...NO_CONSTRAINTS, words: wordLimit({ max: 500, enforcement: 'truncated', statedAs: 'x' }),
  }
  assert.deepEqual([...truncatedKinds(words)], ['words'])
  const both: Constraints = {
    ...words,
    characters: characterLimit({
      max: 2500, spacesCount: true, enforcement: 'truncated', statedAs: 'x',
    }),
  }
  assert.deepEqual([...truncatedKinds(both)], ['words', 'characters'])
})

test('hasAdvisoryLength is true only when something softer than a rule exists', () => {
  assert.equal(hasAdvisoryLength(NO_CONSTRAINTS), false, 'no length at all is not advisory')
  assert.equal(hasAdvisoryLength(withWords(null, 500)), false, 'an enforced maximum is a rule')
  for (const enforcement of ENFORCEMENTS) {
    const constraints: Constraints = {
      ...NO_CONSTRAINTS, words: wordLimit({ max: 500, enforcement, statedAs: 'x' }),
    }
    assert.equal(hasAdvisoryLength(constraints), !isStrict(enforcement), enforcement)
  }
  // A soft limit on ANY unit counts, including one nothing can measure.
  const softPages: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ max: 500, enforcement: 'enforced' }),
    pages: pageLimit({ min: 2, max: 4, spacing: null, enforcement: 'suggested', statedAs: 'x' }),
  }
  assert.equal(hasAdvisoryLength(softPages), true)
})

test('THE REGISTER CHANGES NO COUNT AND NO MEASURABILITY', () => {
  // It governs what is SAID about a bound, never what is measured. Changing it
  // must not move a character count, a word count or what the editor claims to
  // be able to check.
  const text = 'a '.repeat(10)
  for (const enforcement of ENFORCEMENTS) {
    const constraints: Constraints = {
      ...NO_CONSTRAINTS,
      characters: characterLimit({ max: 15, spacesCount: false, enforcement, statedAs: 'x' }),
    }
    assert.equal(characterCount(text, constraints.characters!.spacesCount), 10, enforcement)
    assert.deepEqual([...liveCounts(constraints)], ['characters'], enforcement)
    assert.deepEqual([...analyzerUnmeasuredKinds(constraints)], [], enforcement)
  }
})

// ===========================================================================
// THE CHARACTER COUNTER, AGAINST UT KNOXVILLE'S ACTUAL RULE
// ===========================================================================
// "MINIMUM 5000 characters - not counting spaces and MAXIMUM 18,000 characters
// - not counting spaces". The counter has to apply that rule to text a person
// actually produces: typed prose, pressed Return, and text pasted out of Word
// or a PDF. Each case below is one of those.

const UTK = UT_KNOXVILLE.requirements[0]!.constraints
const utkCount = (text: string) => characterCount(text, UTK.characters!.spacesCount)

test('UT KNOXVILLE’S COUNTER EXCLUDES SPACES, AS THE SCHOOL STATES', () => {
  assert.equal(UTK.characters?.spacesCount, false, 'the fixture under test')
  assert.equal(utkCount('ab cd'), 4, 'one ordinary space is not counted')
  assert.equal(utkCount('a b c d e'), 5)
  // "leading" + "and" + "trailing" = 7 + 3 + 8.
  assert.equal(utkCount('   leading and trailing   '), 18)
  // Runs of spaces collapse to nothing, not to one.
  assert.equal(utkCount('a' + ' '.repeat(50) + 'b'), 2)
})

test('A LINE BREAK IS NOT A CHARACTER UNDER THIS SCHOOL’S RULE', () => {
  // The documented interpretation: a school writing "excluding spaces" is
  // describing the visible characters of their text. Counting the newline
  // between two paragraphs while excluding the space between two words would
  // be a rule nobody intends.
  assert.equal(utkCount('one\ntwo'), 6)
  assert.equal(utkCount('one\r\ntwo'), 6, 'a pasted Windows line ending')
  assert.equal(utkCount('para one\n\npara two'), 14)
  assert.equal(utkCount('a\tb'), 2, 'a tab')
  assert.equal(utkCount('\n\n\n'), 0, 'whitespace alone is nothing')
})

test('PASTED TEXT COUNTS THE WAY ITS CHARACTERS READ', () => {
  // WHAT ACTUALLY ARRIVES FROM A PASTE. Word and PDF copy non-breaking spaces,
  // smart quotes, en and em dashes and ellipses; none of those may be
  // miscounted, and the invisible one must not count at all.
  assert.equal(utkCount('a b'), 2, 'a non-breaking space is whitespace')
  assert.equal(utkCount('a b c'), 3, 'thin and narrow no-break spaces')
  assert.equal(utkCount('a b c'), 3, 'line and paragraph separators')
  // Visible punctuation IS text and counts once each.
  assert.equal(utkCount('“quoted”'), 8, 'smart quotes are characters')
  assert.equal(utkCount('a—b'), 3, 'an em dash is a character')
  assert.equal(utkCount('yes…'), 4, 'an ellipsis is one character')
  // CODE POINTS, NOT UTF-16 UNITS. An astral character is one character to the
  // applicant and to Postgres char_length(), and two to String.length.
  assert.equal(utkCount('\u{1F600}'), 1)
  assert.equal('\u{1F600}'.length, 2, 'which String.length would have got wrong')
})

test('THE COUNTER IS MONOTONIC: adding visible text always adds to the count', () => {
  // A paste cannot make the number go down.
  let previous = 0
  let text = ''
  for (const chunk of ['The ', 'patient ', 'in\nbed ', 'four was ', 'stable—just.']) {
    text += chunk
    const now = utkCount(text)
    assert.ok(now >= previous, `${JSON.stringify(chunk)} reduced the count`)
    previous = now
  }
  assert.equal(previous, utkCount(text))
})

test('UT KNOXVILLE’S BOUNDS ARE CHECKED AGAINST THE SPACES-EXCLUDED COUNT', () => {
  // 18,000 visible characters plus any amount of whitespace is still within.
  const atMax = 'x'.repeat(18_000)
  assert.deepEqual(overages({ constraints: UTK, words: 1, text: atMax }), [])
  const padded = 'x '.repeat(18_000)
  assert.deepEqual(overages({ constraints: UTK, words: 1, text: padded }), [],
    '18,000 x’s and 18,000 spaces is exactly at the limit, not over it')
  const over = `${atMax}y`
  const found = overages({ constraints: UTK, words: 1, text: over })
  assert.equal(found.length, 1)
  assert.equal(found[0]!.count, 18_001)
  assert.equal(found[0]!.enforcement, 'enforced', 'the school wrote MAXIMUM in capitals')
  // And the minimum is a shortfall measured the same way.
  const short = shortfalls({ constraints: UTK, words: 1, text: 'x '.repeat(100) })
  assert.equal(short.length, 1)
  assert.equal(short[0]!.count, 100, 'the 100 spaces do not help reach 5,000')
})

test('NOTHING ABOUT UT KNOXVILLE’S PAGES OR SPACING IS CLAIMED AS MEASURED', () => {
  // It also states 3-5 double-spaced pages. The editor has no pages, so those
  // are displayed and never checked, and no overage can come from them.
  assert.deepEqual([...liveCounts(UTK)], ['characters'], 'the counter is characters only')
  assert.deepEqual([...analyzerUnmeasuredKinds(UTK)], ['pages', 'spacing'])
  assert.equal(UTK.words, null, 'and no word bound materialised from the pages')
  // A draft of 200,000 whitespace-padded characters is over the CHARACTER
  // maximum and is not "over" any page count, because none was measured.
  const found = overages({ constraints: UTK, words: 50_000, text: 'x '.repeat(100_000) })
  assert.deepEqual(found.map((f) => f.kind), ['characters'])
})

// ===========================================================================
// OPTION A -- A LENGTH SHOWN AND NOT ENFORCED
// ===========================================================================

const SHOWN_NOT_ENFORCED: Constraints = {
  ...NO_CONSTRAINTS,
  unenforcedLength: 'Autobiographical Essay of 500 to 1000 words',
}

test('AN UNENFORCED LENGTH CAN NEVER PRODUCE AN OVERAGE OR A SHORTFALL', () => {
  // IT IS PROSE. There is nothing to compare, and the approved policy is that
  // nothing is compared. A draft of twenty words and a draft of twenty thousand
  // are both compliant with a requirement that states no rule.
  for (const words of [0, 20, 500, 1000, 20_000]) {
    assert.deepEqual(
      overages({ constraints: SHOWN_NOT_ENFORCED, words, text: 'x '.repeat(words) }), [])
    assert.deepEqual(
      shortfalls({ constraints: SHOWN_NOT_ENFORCED, words, text: 'x '.repeat(words) }), [])
  }
  assert.deepEqual(strictOverages({ constraints: SHOWN_NOT_ENFORCED, words: 99_999, text: 'x' }),
    [])
})

test('IT IS NOT MEASURABLE, AND IT IS NOT A TRUNCATION', () => {
  assert.deepEqual([...constraintKinds(SHOWN_NOT_ENFORCED)], ['unenforced-length'])
  assert.deepEqual([...analyzerUnmeasuredKinds(SHOWN_NOT_ENFORCED)], ['unenforced-length'])
  // No register, so no truncation policy can be read off it.
  assert.equal(hasTruncationPolicy(SHOWN_NOT_ENFORCED), false)
  assert.deepEqual([...truncatedKinds(SHOWN_NOT_ENFORCED)], [])
})

test('IT COUNTS AS AN ADVISORY LENGTH, so the interface says something', () => {
  assert.equal(hasAdvisoryLength(SHOWN_NOT_ENFORCED), true)
  assert.equal(hasAdvisoryLength(NO_CONSTRAINTS), false, 'silence is not advisory')
})

test('THE WORD COUNTER KEEPS WORKING, with nothing to compare against', () => {
  // THE OWNER'S FIFTH CONDITION. The counter is not switched off -- a writer
  // wants to know how long their draft is -- it simply has no quota to show.
  assert.deepEqual([...liveCounts(SHOWN_NOT_ENFORCED)], ['words'])
  assert.equal(SHOWN_NOT_ENFORCED.words, null, 'and no bound materialised to show it against')
})

test('NO NUMBER IS PARSED OUT OF THE SENTENCE', () => {
  // "500 to 1000" is sitting right there in the prose. Nothing extracts it,
  // which is the difference between showing a school's words and inventing a
  // limit from them.
  assert.equal(SHOWN_NOT_ENFORCED.words, null)
  assert.equal(SHOWN_NOT_ENFORCED.characters, null)
  assert.equal(SHOWN_NOT_ENFORCED.pages, null)
  const source = read('./constraints.ts').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  // No parsing of the field anywhere in this module: no regex over it, no
  // Number(), no match().
  assert.doesNotMatch(source, /unenforcedLength[^\n]*(?:match|replace|Number|parseInt|split)/)
})

test('A BOUND AND AN UNENFORCED SENTENCE DO NOT COEXIST IN THE MODEL EITHER', () => {
  // The database refuses the combination outright. If one ever reaches this
  // module anyway -- hand-built in a test, say -- the bound still behaves as a
  // bound and the sentence still shows: nothing crashes and nothing is
  // silently dropped. This records that, so the schema's CHECK is the single
  // place the contradiction is prevented rather than two half-guards.
  const contradictory: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ max: 1000, enforcement: 'enforced' }),
    unenforcedLength: 'Essay of 500 to 1000 words',
  }
  assert.equal(overages({ constraints: contradictory, words: 1200, text: '' }).length, 1)
  assert.deepEqual([...constraintKinds(contradictory)], ['words', 'unenforced-length'])
})
