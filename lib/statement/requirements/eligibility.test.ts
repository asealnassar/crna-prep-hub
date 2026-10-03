import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MIN_ANALYSIS_WORDS, SHORT_PROMPT_CEILING, eligibilityFor } from '../draft/rubric.ts'
import { NO_CONSTRAINTS, type Constraints } from './constraints.ts'
import {
  FLOOR_UNREACHABLE, eligibilityForRequirement, minimumCharactersFor, shortfallLabel,
  statedWordMaximum, tooShortLabel, wordFloorFits,
} from './eligibility.ts'
import { ALBANY, BUFFALO, MINNESOTA, RUTGERS, SIUE, UC_DAVIS } from './fixtures.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const words = (max: number | null): Constraints => ({ ...NO_CONSTRAINTS, words: { min: null, max } })
const chars = (max: number | null, spacesCount: boolean | null = true): Constraints =>
  ({ ...NO_CONSTRAINTS, characters: { min: null, max, spacesCount } })
const pages = (max: number): Constraints =>
  ({ ...NO_CONSTRAINTS, pages: { min: null, max, spacing: 'double' } })

// ===================================================== the invented policy is gone

test('NO CHARACTER THRESHOLD EXISTS IN THIS MODULE ANY MORE', () => {
  // The two numbers this file used to define -- a 500-character floor and a
  // 300-character short-response ceiling -- were invented here and never
  // approved. Their absence is the point of this test.
  const source = read('./eligibility.ts')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /MIN_ANALYSIS_CHARACTERS|SHORT_CHARACTER_CEILING/)
  assert.doesNotMatch(code, /= 500\b|= 300\b/)
  // And nothing exports them, so no caller can reach for one.
  assert.doesNotMatch(source, /export const (MIN_ANALYSIS_CHARACTERS|SHORT_CHARACTER_CEILING)/)
})

test('nothing in the codebase still imports the removed constants', async () => {
  const { readdirSync, statSync } = await import('node:fs')
  const roots = ['lib', 'app']
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(entry)) continue
      const source = readFileSync(full, 'utf8')
      if (/MIN_ANALYSIS_CHARACTERS|SHORT_CHARACTER_CEILING/.test(source)) {
        // This test file names them in order to assert their absence.
        if (!full.endsWith('eligibility.test.ts')) offenders.push(full)
      }
    }
  }
  for (const root of roots) walk(root)
  assert.deepEqual(offenders, [])
})

test('the module defines no new eligibility type either', () => {
  // It returns rubric.ts's own Eligibility. A parallel type carrying a `unit`
  // existed only to describe the removed character policy.
  const source = read('./eligibility.ts')
  assert.doesNotMatch(source, /RequirementEligibility|requirement-too-short|CountUnit/)
})

// ===================================================== the approved rules decide

test('THE WORD PATH AGREES WITH rubric.eligibilityFor FOR EVERY CASE', () => {
  const maxima = [null, 40, 49, 50, 60, 80, 99, 100, 250, 500, 1000, 5000]
  const counts = [0, 1, 39, 40, 48, 79, 80, 99, 100, 101, 499, 500, 1001]
  let compared = 0
  for (const max of maxima) {
    for (const count of counts) {
      const expected = eligibilityFor({ words: count, statedMaxWords: max })
      const actual = eligibilityForRequirement({
        constraints: max === null ? NO_CONSTRAINTS : words(max),
        words: count,
      })
      assert.deepEqual(actual, expected, `max=${max} words=${count}`)
      compared += 1
    }
  }
  assert.equal(compared, maxima.length * counts.length)
  assert.ok(compared >= 150, 'the comparison is not vacuous')
})

test('the approved constants are untouched', () => {
  assert.equal(MIN_ANALYSIS_WORDS, 100)
  assert.equal(SHORT_PROMPT_CEILING, 50)
})

test('A CHARACTER LIMIT DOES NOT MOVE THE FLOOR', () => {
  // UC Davis: 2,500 characters, no word maximum. The floor is the ordinary 100
  // words -- the same as a general statement -- because no approved rule
  // converts characters into words.
  const decision = eligibilityForRequirement({ constraints: chars(2500), words: 100 })
  assert.deepEqual(decision, { kind: 'eligible', minimumWords: 100 })
  const short = eligibilityForRequirement({ constraints: chars(2500), words: 99 })
  assert.deepEqual(short, { kind: 'too-short', minimumWords: 100, words: 99 })
  // And it is byte-identical to having stated nothing at all.
  assert.deepEqual(decision, eligibilityForRequirement({ constraints: NO_CONSTRAINTS, words: 100 }))
})

test('A PAGE LIMIT DOES NOT MOVE THE FLOOR EITHER', () => {
  for (const max of [1, 2, 3, 4]) {
    assert.deepEqual(
      eligibilityForRequirement({ constraints: pages(max), words: 100 }),
      { kind: 'eligible', minimumWords: 100 }, `${max} pages`)
  }
  // A page limit can never make a draft prompt-too-short, however small.
  for (const max of [1, 2]) {
    assert.notEqual(
      eligibilityForRequirement({ constraints: pages(max), words: 500 }).kind,
      'prompt-too-short')
  }
})

test('only a WORD MAXIMUM is read, and nothing else is', () => {
  assert.equal(statedWordMaximum(words(500)), 500)
  assert.equal(statedWordMaximum(chars(2500)), null)
  assert.equal(statedWordMaximum(pages(2)), null)
  assert.equal(statedWordMaximum(NO_CONSTRAINTS), null)
  // A minimum is not a maximum.
  assert.equal(statedWordMaximum({ ...NO_CONSTRAINTS, words: { min: 500, max: null } }), null)
  // Formatting rules are not a maximum.
  assert.equal(statedWordMaximum({
    ...NO_CONSTRAINTS,
    typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: 1 },
    citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: 3 },
  }), null)
})

test('a short WORD prompt still trips the approved ceiling', () => {
  // Unchanged behaviour: the rule that exists, applied through the new path.
  assert.deepEqual(eligibilityForRequirement({ constraints: words(40), words: 100 }),
    { kind: 'prompt-too-short', statedMaxWords: 40 })
  assert.equal(eligibilityForRequirement({ constraints: words(50), words: 100 }).kind, 'eligible')
})

// ===================================================== the provable bound

test('THE BOUND IS ARITHMETIC, NOT A CONVERSION', () => {
  // n words need at least n characters plus the n-1 separators between them.
  // One-letter words reach it exactly; nothing is below it.
  assert.equal(minimumCharactersFor(1), 1)
  assert.equal(minimumCharactersFor(2), 3)
  assert.equal(minimumCharactersFor(100), 199)
  assert.equal(minimumCharactersFor(0), 0)
  // Demonstrated rather than asserted: the shortest possible 100-word text.
  const shortest = Array.from({ length: 100 }, () => 'x').join(' ')
  assert.equal(shortest.split(/\s+/).length, 100)
  assert.equal(shortest.length, minimumCharactersFor(100))
})

test('the bound contains NO assumed word length', () => {
  const code = read('./eligibility.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  // No multiplier anywhere: a conversion would need one.
  assert.doesNotMatch(code, /words\s*\*|\*\s*words|charsPerWord|wordsPerPage/i)
  assert.match(code, /return words \+ \(words - 1\)/)
})

test('a limit the floor cannot fit inside is reported, not legislated', () => {
  // Below the bound: provably unreachable.
  assert.equal(wordFloorFits(chars(198)), false)
  assert.equal(wordFloorFits(chars(199)), true, 'exactly at the bound is reachable')
  assert.equal(wordFloorFits(chars(250)), true)
  // Excluding spaces, the separators do not count toward the school's limit.
  assert.equal(wordFloorFits(chars(99, false)), false)
  assert.equal(wordFloorFits(chars(100, false)), true)
  // Unstated spaces rule takes the including-spaces bound.
  assert.equal(wordFloorFits(chars(198, null)), false)
  // No limit at all, or a limit with no maximum: nothing to be unreachable.
  assert.equal(wordFloorFits(NO_CONSTRAINTS), true)
  assert.equal(wordFloorFits(chars(null)), true)
  assert.equal(wordFloorFits(pages(1)), true)
  assert.equal(wordFloorFits(words(40)), true)
})

test('IT CHANGES NO ELIGIBILITY DECISION', () => {
  // The function exists to explain, not to decide. A requirement whose floor is
  // unreachable still returns exactly what the approved rules say.
  const tiny = chars(100)
  assert.equal(wordFloorFits(tiny), false)
  assert.deepEqual(
    eligibilityForRequirement({ constraints: tiny, words: 100 }),
    eligibilityFor({ words: 100, statedMaxWords: null }),
    'the decision is the approved one regardless')
  // And eligibility.ts never calls it internally.
  const code = read('./eligibility.ts')
  const inside = code.slice(code.indexOf('export function eligibilityForRequirement'),
    code.indexOf('export function minimumCharactersFor'))
  assert.doesNotMatch(inside, /wordFloorFits/)
})

test('the explanation promises nothing and blames nobody', () => {
  assert.match(FLOOR_UNREACHABLE, /shorter than the full analysis supports/)
  assert.match(FLOOR_UNREACHABLE, /still write and save it here/)
  // No invented number, and no claim about what the school should have done.
  assert.doesNotMatch(FLOOR_UNREACHABLE, /\d/)
})

// ===================================================== the labels

test('the shortfall reads in words, because the floor is in words', () => {
  const decision = eligibilityForRequirement({ constraints: words(1000), words: 40 })
  assert.equal(shortfallLabel(decision), '40 of 100 words needed.')
  assert.equal(tooShortLabel(decision), null)
})

test('the too-short explanation names the school’s own word maximum', () => {
  const decision = eligibilityForRequirement({ constraints: words(40), words: 10 })
  assert.match(tooShortLabel(decision)!, /at most 40 words/)
  assert.equal(shortfallLabel(decision), null)
})

test('an eligible draft gets neither label', () => {
  const decision = eligibilityForRequirement({ constraints: words(500), words: 200 })
  assert.equal(shortfallLabel(decision), null)
  assert.equal(tooShortLabel(decision), null)
})

// ===================================================== every real fixture

test('EVERY RESEARCH FIXTURE IS ANALYSABLE AT 100 WORDS', () => {
  // The practical check that the rollback did not strand anybody: none of the
  // eight real requirements has a limit that excludes the approved floor.
  for (const set of [ALBANY, RUTGERS, MINNESOTA, SIUE, UC_DAVIS, BUFFALO]) {
    for (const requirement of set.requirements) {
      assert.equal(wordFloorFits(requirement.constraints), true,
        `${set.schoolName}/${requirement.label}`)
      assert.equal(
        eligibilityForRequirement({ constraints: requirement.constraints, words: 100 }).kind,
        'eligible', `${set.schoolName}/${requirement.label}`)
    }
  }
})

test('UC Davis’ 2,500 characters comfortably clears the bound', () => {
  const requirement = UC_DAVIS.requirements[0]!
  assert.equal(requirement.constraints.characters?.max, 2500)
  assert.ok(2500 > minimumCharactersFor(MIN_ANALYSIS_WORDS))
  assert.equal(wordFloorFits(requirement.constraints), true)
})
