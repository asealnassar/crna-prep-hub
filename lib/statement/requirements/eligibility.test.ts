import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MIN_ANALYSIS_WORDS, SHORT_PROMPT_CEILING, eligibilityFor } from '../draft/rubric.ts'
import {
  NO_CONSTRAINTS, type Constraints, wordLimit, characterLimit, pageLimit,
  ENFORCEMENTS,
  type Enforcement,
} from './constraints.ts'
import {
  FLOOR_UNREACHABLE, eligibilityForRequirement, enforcedWordMaximum, minimumCharactersFor,
  shortfallLabel, statedWordMaximum, tooShortLabel, wordFloorFits,
} from './eligibility.ts'
import {
  ALBANY, BUFFALO, MINNESOTA, RUTGERS, SIUE, UC_DAVIS, UT_KNOXVILLE,
} from './fixtures.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const words = (max: number | null): Constraints => ({ ...NO_CONSTRAINTS,
  words: wordLimit({ max, enforcement: 'enforced' }) })
const chars = (max: number | null, spacesCount: boolean | null = true): Constraints =>
  ({ ...NO_CONSTRAINTS, characters: characterLimit({ max, spacesCount, enforcement: 'enforced' }) })
const pages = (max: number): Constraints =>
  ({ ...NO_CONSTRAINTS, pages: pageLimit({ max, spacing: 'double', enforcement: 'enforced' }) })

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
  assert.equal(statedWordMaximum({ ...NO_CONSTRAINTS,
    words: wordLimit({ min: 500, max: null, enforcement: 'enforced' }) }), null)
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

test('UT Knoxville’s 18,000 characters comfortably clears the bound', () => {
  // UC Davis stood here and has no character limit at all.
  const requirement = UT_KNOXVILLE.requirements[0]!
  assert.equal(requirement.constraints.characters?.max, 18_000)
  assert.ok(18_000 > minimumCharactersFor(MIN_ANALYSIS_WORDS))
  assert.equal(wordFloorFits(requirement.constraints), true)
})

// ===========================================================================
// THE SHORT-PROMPT EXCEPTION IS ABOUT CAPS ONLY
// ===========================================================================
// THESE REPLACE AN EARLIER PIN THAT SAID THE OPPOSITE. The first version of
// this feature pinned "eligibility ignores the register", on the reasoning that
// the owner-approved word policy must not be touched. Reviewing it, that was
// the wrong reading: the policy's two clauses -- refuse below 50, drop the floor
// to 80% below 100 -- exist BECAUSE A CAP MAKES THE 100-WORD FLOOR UNREACHABLE.
// A suggestion forbids nothing, so the floor is reachable and the exception has
// nothing to apply to. Treating a suggestion as a cap there is exactly the
// error. No constant in rubric.ts moved.

const withRegister = (max: number, enforcement: Enforcement): Constraints =>
  ({ ...NO_CONSTRAINTS, words: wordLimit({ max, enforcement, statedAs: 'the school’s words' }) })

test('AN ENFORCED MAXIMUM BELOW 100 STILL LOWERS THE FLOOR, exactly as approved', () => {
  // Unchanged behaviour, pinned first so the correction cannot be mistaken for
  // a relaxation of the policy.
  const cap = withRegister(80, 'enforced')
  assert.equal(enforcedWordMaximum(cap), 80)
  assert.deepEqual(eligibilityForRequirement({ constraints: cap, words: 70 }),
    eligibilityFor({ words: 70, statedMaxWords: 80 }))
  assert.equal(eligibilityForRequirement({ constraints: cap, words: 64 }).kind, 'eligible',
    '80% of 80 is 64')
  assert.equal(eligibilityForRequirement({ constraints: cap, words: 63 }).kind, 'too-short')
})

test('AN ENFORCED MAXIMUM BELOW THE CEILING STILL REFUSES, exactly as approved', () => {
  const tiny = withRegister(40, 'enforced')
  assert.equal(eligibilityForRequirement({ constraints: tiny, words: 100 }).kind,
    'prompt-too-short')
})

test('A TRUNCATED MAXIMUM IS A CAP TOO, so it behaves like an enforced one', () => {
  // The school reads only the first N: that is the strictest cap there is.
  const truncated = withRegister(80, 'truncated')
  assert.equal(enforcedWordMaximum(truncated), 80)
  assert.deepEqual(eligibilityForRequirement({ constraints: truncated, words: 70 }),
    eligibilityForRequirement({ constraints: withRegister(80, 'enforced'), words: 70 }))
})

test('A SUGGESTED LENGTH DOES NOT LOWER THE 100-WORD FLOOR', () => {
  // THE CORRECTION. "80 words suggested" forbids nothing, so an applicant can
  // reach 100 and the exception must not fire.
  const suggested = withRegister(80, 'suggested')
  assert.equal(statedWordMaximum(suggested), 80, 'the figure is still published')
  assert.equal(enforcedWordMaximum(suggested), null, 'and is not a cap')
  assert.deepEqual(eligibilityForRequirement({ constraints: suggested, words: 70 }),
    eligibilityFor({ words: 70, statedMaxWords: null }),
    'the ordinary floor applies, as for a school that stated nothing')
  assert.equal(eligibilityForRequirement({ constraints: suggested, words: 70 }).kind,
    'too-short')
  assert.equal(eligibilityForRequirement({ constraints: suggested, words: 70 }).minimumWords,
    MIN_ANALYSIS_WORDS)
  assert.equal(eligibilityForRequirement({ constraints: suggested, words: 100 }).kind,
    'eligible')
})

test('A TARGET LENGTH DOES NOT LOWER THE FLOOR EITHER', () => {
  // South Dakota's shape: "A written 500 word statement", never called a limit.
  const target = withRegister(80, 'target')
  assert.equal(enforcedWordMaximum(target), null)
  assert.deepEqual(eligibilityForRequirement({ constraints: target, words: 70 }),
    eligibilityFor({ words: 70, statedMaxWords: null }))
})

test('A SUGGESTED LENGTH UNDER THE CEILING IS NOT REFUSED AS A SHORT PROMPT', () => {
  // The other direction, and the more damaging one. A school SUGGESTING 40
  // words has not capped anything; refusing the analysis outright would deny an
  // applicant a feature over a limit that does not exist.
  for (const soft of ['suggested', 'target', 'unknown'] as const) {
    const constraints = withRegister(40, soft)
    const decision = eligibilityForRequirement({ constraints, words: 100 })
    assert.notEqual(decision.kind, 'prompt-too-short', soft)
    assert.equal(decision.kind, 'eligible', soft)
  }
  // And an enforced 40 is still refused.
  assert.equal(
    eligibilityForRequirement({ constraints: withRegister(40, 'enforced'), words: 100 }).kind,
    'prompt-too-short')
})

test('AN UNKNOWN REGISTER IS NOT A CAP FOR ELIGIBILITY', () => {
  // 'unknown' means the school published a figure and no standing for it. Using
  // it to refuse or to lower a floor would be asserting the standing.
  const unknown = withRegister(80, 'unknown')
  assert.equal(enforcedWordMaximum(unknown), null)
  assert.deepEqual(eligibilityForRequirement({ constraints: unknown, words: 70 }),
    eligibilityFor({ words: 70, statedMaxWords: null }))
})

test('EVERY REGISTER AT OR ABOVE THE FLOOR BEHAVES IDENTICALLY', () => {
  // Where the figure is 100 or more the register cannot matter, because neither
  // clause of the policy applies. UC Davis's 250 is in this band, so the
  // correction changes nothing for any real school in the research record.
  for (const enforcement of ENFORCEMENTS) {
    const constraints = withRegister(250, enforcement)
    assert.deepEqual(eligibilityForRequirement({ constraints, words: 99 }),
      eligibilityFor({ words: 99, statedMaxWords: null }), enforcement)
    assert.equal(eligibilityForRequirement({ constraints, words: 100 }).kind, 'eligible',
      enforcement)
  }
})

test('A PAGE-ONLY REQUIREMENT HAS NO WORD MAXIMUM IN ANY REGISTER', () => {
  // The oldest guarantee in this module, re-checked against the register: a
  // page count yields no word bound, so it can never reach the exception.
  for (const enforcement of ENFORCEMENTS) {
    const pageOnly: Constraints = {
      ...NO_CONSTRAINTS,
      pages: pageLimit({ min: 1, max: 2, spacing: 'double', enforcement, statedAs: 'x' }),
    }
    assert.equal(statedWordMaximum(pageOnly), null, enforcement)
    assert.equal(enforcedWordMaximum(pageOnly), null, enforcement)
    assert.deepEqual(eligibilityForRequirement({ constraints: pageOnly, words: 100 }),
      eligibilityFor({ words: 100, statedMaxWords: null }), enforcement)
    assert.equal(wordFloorFits(pageOnly), true, enforcement)
  }
})

test('A SUGGESTED CHARACTER LIMIT NEVER REFUSES AN ANALYSIS', () => {
  // wordFloorFits()'s entire output is a refusal. A character figure the school
  // did not make a rule must not produce one, however small it is.
  const tiny = 10
  assert.equal(wordFloorFits({
    ...NO_CONSTRAINTS,
    characters: characterLimit({ max: tiny, spacesCount: true, enforcement: 'enforced' }),
  }), false, 'an enforced tiny limit is still provably unreachable')
  for (const soft of ['suggested', 'target', 'unknown'] as const) {
    assert.equal(wordFloorFits({
      ...NO_CONSTRAINTS,
      characters: characterLimit({ max: tiny, spacesCount: true, enforcement: soft,
        statedAs: 'x' }),
    }), true, soft)
  }
})

test('NO CONVERSION OR NEW THRESHOLD ENTERED THIS MODULE', () => {
  // The correction narrowed which figures count as a cap. It introduced no
  // characters-per-word figure and no new numeric policy.
  const source = read('./eligibility.ts').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(source, /charsPerWord|CHARS_PER_|wordsPerChar|AVERAGE_/i)
  // The only numbers left are the provable bound's own arithmetic.
  const literals = source.match(/\b\d+\b/g) ?? []
  assert.deepEqual([...new Set(literals)].sort(), ['0', '1'],
    `unexpected numeric literals: ${[...new Set(literals)].join(', ')}`)
})


test('AN UNENFORCED LENGTH LEAVES THE APPROVED ELIGIBILITY RULES UNTOUCHED', () => {
  // THE OWNER'S SEVENTH CONDITION. A length shown and not bounded must not move
  // the word floor, must not refuse a short prompt, and must not be convertible
  // into either -- the figures are inside a sentence and nothing reads them.
  const shown: Constraints = {
    ...NO_CONSTRAINTS,
    unenforcedLength: 'A 2-3 page essay describing your interest in nurse anesthesia',
  }
  assert.equal(statedWordMaximum(shown), null)
  assert.equal(enforcedWordMaximum(shown), null)
  assert.deepEqual(eligibilityForRequirement({ constraints: shown, words: 100 }),
    eligibilityFor({ words: 100, statedMaxWords: null }))
  assert.equal(eligibilityForRequirement({ constraints: shown, words: 99 }).kind, 'too-short')
  assert.equal(eligibilityForRequirement({ constraints: shown, words: 99 }).minimumWords,
    MIN_ANALYSIS_WORDS, 'the ordinary floor, unmoved')
  // AND IT NEVER REFUSES AN ANALYSIS. wordFloorFits() reads a character
  // maximum; prose is not one.
  assert.equal(wordFloorFits(shown), true)
})

test('A SENTENCE CONTAINING A TINY NUMBER STILL DOES NOT REFUSE AN ANALYSIS', () => {
  // The hazard in reverse: "a 40 word answer" inside prose must not become a
  // short-prompt refusal, because nothing parsed it and nothing should.
  const shown: Constraints = {
    ...NO_CONSTRAINTS, unenforcedLength: 'a 40 word answer is usually enough',
  }
  assert.equal(eligibilityForRequirement({ constraints: shown, words: 100 }).kind, 'eligible')
  assert.equal(wordFloorFits(shown), true)
})
