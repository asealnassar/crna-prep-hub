import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ENFORCEMENTS, NO_CONSTRAINTS, characterLimit, isStrict, pageLimit, wordLimit,
  type Constraints, type Enforcement,
  statedLength,
} from './constraints.ts'
import { analyzerUnmeasuredKinds } from './constraints.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

import { UT_KNOXVILLE } from './fixtures.ts'
import {
  NO_STATED_LENGTH, UNENFORCED_LENGTH_NOTICE, UNENFORCED_LENGTH_SUMMARY_NOTICE, constraintLines,
  constraintSummary, labelledConstraints, liveCountLabel, overageMessage, shortfallMessage,
  needsManualReview, statedWordings, truncationNotice, unenforcedLengthIsVerbatim,
  unenforcedLengthNotice,
} from './constraintText.ts'

const pages = (max: number, spacing: 'single' | 'double' | null): Constraints =>
  ({ ...NO_CONSTRAINTS, pages: pageLimit({ max, spacing, enforcement: 'enforced' }) })

test('a word maximum reads as a word maximum', () => {
  assert.deepEqual([...constraintLines({ ...NO_CONSTRAINTS,
    words: wordLimit({ min: null, max: 500, enforcement: 'enforced' }) })],
    ['500 words maximum'])
})

test('a word range reads as a range, with an en dash', () => {
  assert.deepEqual([...constraintLines({ ...NO_CONSTRAINTS,
    words: wordLimit({ min: 500, max: 1000, enforcement: 'enforced' }) })],
    ['500–1,000 words'])
})

test('a minimum alone reads as a minimum', () => {
  assert.deepEqual([...constraintLines({ ...NO_CONSTRAINTS,
    words: wordLimit({ min: 300, max: null, enforcement: 'enforced' }) })],
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
  const including: Constraints = { ...NO_CONSTRAINTS,
    characters: characterLimit({ min: null, max: 2500, spacesCount: true, enforcement: 'enforced' }) }
  assert.deepEqual([...constraintLines(including)], ['2,500 characters maximum including spaces'])
  const excluding: Constraints = { ...NO_CONSTRAINTS,
    characters: characterLimit({ min: null, max: 2500, spacesCount: false, enforcement: 'enforced' }) }
  assert.deepEqual([...constraintLines(excluding)], ['2,500 characters maximum excluding spaces'])
})

test('an unstated spaces rule SAYS SO rather than picking one', () => {
  const unstated: Constraints = { ...NO_CONSTRAINTS,
    characters: characterLimit({ min: null, max: 2500, spacesCount: null, enforcement: 'enforced' }) }
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
    words: wordLimit({ min: null, max: 500, enforcement: 'enforced' }),
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
    words: wordLimit({ min: null, max: 500, enforcement: 'enforced' }),
    pages: pageLimit({ min: null, max: 2, spacing: 'double', enforcement: 'enforced' }),
    typography: { fontSizePt: 12, fontFamily: null, marginsInches: 1 },
    citation: { family: 'ama', statedAs: 'AMA format', minReferences: null },
    otherInstructions: ['no cover page'],
  }
  const labelled = labelledConstraints(mixed)
  const measured = labelled.filter((l) => l.measured).map((l) => l.kind)
  const unmeasured = labelled.filter((l) => !l.measured).map((l) => l.kind)
  // PAGES JOINED THE MEASURED SIDE when the editor started laying out the page.
  // The font size and the margins are applied rather than measured, so they
  // stay on the other side of this particular split -- it asks which lines
  // carry a live figure, not which ones the Studio honours.
  assert.deepEqual(measured, ['words', 'pages'])
  assert.deepEqual(unmeasured, ['font', 'margins', 'citation', 'other'])
  // MEASURED COMES FIRST, so the reader sees the watched number before the rest.
  assert.equal(labelled[0]!.kind, 'words')
})

test('the labelled view and the plain view never disagree', () => {
  const mixed: Constraints = {
    words: wordLimit({ min: 500, max: 700, enforcement: 'enforced' }),
    characters: characterLimit({ min: 100, max: 3000, spacesCount: false, enforcement: 'enforced' }),
    pages: pageLimit({ min: 1, max: 3, spacing: 'single', enforcement: 'enforced' }),
    typography: { fontSizePt: 11, fontFamily: 'Arial', marginsInches: 1.5 },
    citation: { family: 'other', statedAs: 'Chicago', minReferences: 1 },
    unenforcedLength: statedLength({ text: 'A 2-3 page essay', verbatim: true }),
    otherInstructions: ['one instruction'],
  }
  assert.deepEqual(labelledConstraints(mixed).map((l) => l.text), [...constraintLines(mixed)])
  // AND A SUMMARY RENDERS IN BOTH VIEWS TOO, with the same words.
  const summarised: Constraints = {
    ...mixed,
    unenforcedLength: statedLength({ text: 'one personal essay, 1-2 pages', verbatim: false }),
  }
  assert.deepEqual(labelledConstraints(summarised).map((l) => l.text),
    [...constraintLines(summarised)])
})

test('A PAGE LIMIT AND A SPACING NO LONGER NEED A HUMAN', () => {
  /*
   * The behavioural change, stated as a test. This used to be true for a
   * 2-page double-spaced school, because the editor was a textarea and could
   * see neither. The Studio lays the page out, measures it, and applies the
   * spacing -- so there is nothing left for the applicant to check, and saying
   * otherwise sent them to re-do work that had already been done.
   */
  assert.equal(needsManualReview(pages(2, 'double')), false)
  assert.equal(needsManualReview({ ...NO_CONSTRAINTS,
    words: wordLimit({ min: null, max: 500, enforcement: 'enforced' }) }), false)
  assert.equal(needsManualReview(NO_CONSTRAINTS), false)
  // It stays true for what genuinely cannot be settled here.
  assert.equal(needsManualReview({ ...NO_CONSTRAINTS,
    citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: null } }), true)
  assert.equal(needsManualReview({ ...NO_CONSTRAINTS, otherInstructions: ['Typewritten'] }), true)
})

// -------------------------------------------------- the live counter label

test('a word counter shows the limit when there is one, and no slash when there is not', () => {
  const withMax: Constraints = { ...NO_CONSTRAINTS,
    words: wordLimit({ min: null, max: 1000, enforcement: 'enforced' }) }
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
  const chars: Constraints = { ...NO_CONSTRAINTS,
    characters: characterLimit({ min: null, max: 2500, spacesCount: false, enforcement: 'enforced' }) }
  const label = liveCountLabel({ kind: 'characters', constraints: chars, words: 2, text: 'ab cd' })
  assert.equal(label, '4 / 2,500 characters excluding spaces')
})

test('an ambiguous character limit shows a bare count, with no claim about spaces', () => {
  const chars: Constraints = { ...NO_CONSTRAINTS,
    characters: characterLimit({ min: null, max: 2500, spacesCount: null, enforcement: 'enforced' }) }
  const label = liveCountLabel({ kind: 'characters', constraints: chars, words: 2, text: 'ab cd' })
  assert.equal(label, '5 / 2,500 characters')
})

// ===========================================================================
// THE LENGTH REGISTER, IN WORDS
// ===========================================================================

const wordsIn = (max: number, enforcement: Enforcement, statedAs: string | null = null) =>
  ({ ...NO_CONSTRAINTS, words: wordLimit({ max, enforcement, statedAs }) }) as Constraints

test('THE WORD "MAXIMUM" IS RESERVED FOR BOUNDS THAT ARE ONE', () => {
  // THE WHOLE REQUIREMENT, AS FIVE SENTENCES. The same number, 250, in five
  // registers, and only two of them may be called a maximum.
  assert.deepEqual([...constraintLines(wordsIn(250, 'enforced'))], ['250 words maximum'])
  assert.deepEqual([...constraintLines(wordsIn(250, 'suggested'))], ['250 words suggested'])
  assert.deepEqual([...constraintLines(wordsIn(250, 'target'))],
    ['250 words (the stated length, not a maximum)'])
  assert.deepEqual([...constraintLines(wordsIn(250, 'unknown'))],
    ['250 words stated, without saying whether it is a limit'])
  assert.deepEqual([...constraintLines(wordsIn(250, 'truncated'))],
    ['250 words maximum — the school reads only this much'])
  // NEITHER SOFT REGISTER ASSERTS A MAXIMUM. 'suggested' avoids the word
  // entirely; 'target' uses it only inside an explicit negation, which is the
  // clearest way to say a figure is not one.
  assert.doesNotMatch(constraintLines(wordsIn(250, 'suggested'))[0]!, /maximum/i)
  assert.match(constraintLines(wordsIn(250, 'target'))[0]!, /not a maximum/)
  assert.doesNotMatch(constraintLines(wordsIn(250, 'target'))[0]!, /(?<!not a )maximum/)
})

test('a register qualifies a range and a minimum too', () => {
  const range: Constraints = {
    ...NO_CONSTRAINTS, words: wordLimit({ min: 500, max: 1000, enforcement: 'suggested' }),
  }
  assert.deepEqual([...constraintLines(range)], ['500–1,000 words suggested'])
  const floor: Constraints = {
    ...NO_CONSTRAINTS, words: wordLimit({ min: 300, enforcement: 'target' }),
  }
  assert.deepEqual([...constraintLines(floor)],
    ['300 words (the stated length, not a minimum)'])
})

test('A SOFT PAGE LIMIT IS STILL NEVER A WORD COUNT', () => {
  // The register must not become a back door for the conversion.
  for (const enforcement of ENFORCEMENTS) {
    const soft: Constraints = {
      ...NO_CONSTRAINTS,
      pages: pageLimit({ min: 2, max: 4, spacing: 'double', enforcement, statedAs: 'x' }),
    }
    const text = constraintLines(soft).join(' | ')
    assert.doesNotMatch(text, /\bwords?\b/i, enforcement)
    assert.doesNotMatch(text, /about|approx|roughly|~|est\./i, enforcement)
    assert.match(text, /2–4 pages/, enforcement)
  }
})

test('a truncated page limit says the school stops reading, in its own unit', () => {
  const truncated: Constraints = {
    ...NO_CONSTRAINTS,
    pages: pageLimit({ max: 2, spacing: 'double', enforcement: 'truncated', statedAs: 'x' }),
  }
  assert.deepEqual([...constraintLines(truncated)],
    ['2 pages maximum (double-spaced) — the school reads only this much'])
})

test('a character limit keeps its spaces rule in every register', () => {
  // The spaces rule is part of the limit and may never be dropped to make room
  // for the register.
  for (const enforcement of ENFORCEMENTS) {
    const chars: Constraints = {
      ...NO_CONSTRAINTS,
      characters: characterLimit({ max: 2500, spacesCount: false, enforcement, statedAs: 'x' }),
    }
    assert.match(constraintLines(chars)[0]!, /excluding spaces/, enforcement)
  }
})

// -------------------------------------------------- the school's own wording

test('statedWordings quotes what was recorded and invents nothing', () => {
  assert.deepEqual([...statedWordings(NO_CONSTRAINTS)], [])
  assert.deepEqual([...statedWordings(wordsIn(250, 'enforced'))], [],
    'no sentence was recorded, so none is produced')
  const quoted = wordsIn(250, 'suggested', 'Suggested Length: Maximum of 250 words')
  assert.deepEqual([...statedWordings(quoted)], ['Suggested Length: Maximum of 250 words'])
  // Several units, each with its own sentence, in display order; duplicates
  // collapse so one sentence covering two units is not shown twice.
  const many: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ max: 1, enforcement: 'target', statedAs: 'the same sentence' }),
    pages: pageLimit({ max: 1, spacing: null, enforcement: 'target', statedAs: 'the same sentence' }),
    characters: characterLimit({
      max: 1, spacesCount: null, enforcement: 'target', statedAs: 'a second sentence',
    }),
  }
  assert.deepEqual([...statedWordings(many)], ['the same sentence', 'a second sentence'])
  // Blank wording is not wording.
  assert.deepEqual([...statedWordings(wordsIn(250, 'target', '   '))], [])
})

// -------------------------------------------------- passing a bound

test('A SUGGESTED MAXIMUM DOES NOT TRIGGER THE VIOLATION MESSAGE', () => {
  // THE REQUIREMENT, STATED AS A TEST. Same count, same bound, same overage --
  // five different sentences, and only two of them say a rule was broken.
  const said = (enforcement: Enforcement) => overageMessage({
    kind: 'words', count: 400, max: 250, over: 150, enforcement, statedAs: null,
  })
  assert.match(said('enforced'), /over the school’s stated maximum of 250 words/)
  assert.match(said('truncated'), /may not be read at all/)
  assert.match(said('suggested'), /A suggested length is not a maximum/)
  assert.match(said('target'), /without calling it a maximum/)
  assert.match(said('target'), /not a breach of a stated limit/)
  assert.match(said('unknown'), /does not say whether that figure is a limit/)

  // NO TWO REGISTERS SHARE A SENTENCE.
  const all = ENFORCEMENTS.map(said)
  assert.equal(new Set(all).size, ENFORCEMENTS.length)

  // AND THE SOFT ONES NEVER CLAIM A MAXIMUM WAS EXCEEDED.
  for (const soft of ENFORCEMENTS.filter((e) => !isStrict(e))) {
    assert.doesNotMatch(said(soft), /over the school’s stated maximum/, soft)
    assert.doesNotMatch(said(soft), /non-compliant|violat|breach of the limit/i, soft)
  }
})

test('an overage message states a count against a number and gives no advice', () => {
  const message = overageMessage({
    kind: 'characters', count: 18_100, max: 18_000, over: 100, enforcement: 'enforced',
    statedAs: null,
  })
  assert.match(message, /18,100 characters/)
  assert.match(message, /18,000 characters/)
  assert.match(message, /100 characters/)
  // No page ever appears, and no instruction to cut.
  assert.doesNotMatch(message, /\bpages?\b/i)
  assert.doesNotMatch(message, /you should|try to|cut |trim /i)
})

test('a singular overage reads as one word, not "1 words"', () => {
  const message = overageMessage({
    kind: 'words', count: 251, max: 250, over: 1, enforcement: 'enforced', statedAs: null,
  })
  assert.match(message, /1 word over/)
  // \b matters: "251 words" contains the substring "1 words".
  assert.doesNotMatch(message, /\b1 words\b/)
})

test('a shortfall distinguishes a stated minimum from a described length', () => {
  const strict = shortfallMessage({
    kind: 'characters', count: 400, max: 5000, over: 4600, enforcement: 'enforced',
    statedAs: null,
  })
  assert.match(strict, /below the school’s stated minimum of 5,000 characters/)
  const soft = shortfallMessage({
    kind: 'words', count: 100, max: 500, over: 400, enforcement: 'target', statedAs: null,
  })
  assert.match(soft, /which it does not state as a minimum/)
  assert.doesNotMatch(soft, /stated minimum/)
})

// -------------------------------------------------- the truncation notice

test('the truncation notice reports the POLICY and makes no claim about a draft', () => {
  assert.equal(truncationNotice(NO_CONSTRAINTS), null)
  assert.equal(truncationNotice(wordsIn(250, 'enforced')), null, 'an ordinary cap is not this')
  const usm: Constraints = {
    ...NO_CONSTRAINTS,
    pages: pageLimit({
      max: 2,
      spacing: 'double',
      enforcement: 'truncated',
      statedAs: 'Only the first two pages will be read if your essay goes over the limit.',
    }),
  }
  const notice = truncationNotice(usm)!
  assert.match(notice, /reads only the first 2 pages/)
  assert.match(notice, /may not be read/)
  assert.match(notice, /Only the first two pages will be read/, 'the school’s own sentence')
  // NO MEASUREMENT IS CLAIMED. A page count cannot be observed here.
  assert.doesNotMatch(notice, /your draft|this draft|you are|over the limit by/i)
  assert.doesNotMatch(notice, /\bwords?\b/i)
})

test('the truncation notice works without a recorded sentence', () => {
  const bare: Constraints = {
    ...NO_CONSTRAINTS, words: wordLimit({ max: 500, enforcement: 'truncated' }),
  }
  const notice = truncationNotice(bare)!
  assert.match(notice, /reads only the first 500 words/)
  assert.doesNotMatch(notice, /wording/, 'nothing is quoted that was never recorded')
})

// -------------------------------------------------- the live counter

test('A SUGGESTED BOUND GETS NO QUOTA SLASH', () => {
  // "412 / 250 words" is the shape of a quota and reads as one at a glance.
  const base = { kind: 'words' as const, words: 412, text: '' }
  assert.equal(liveCountLabel({ ...base, constraints: wordsIn(250, 'enforced') }),
    '412 / 250 words')
  assert.equal(liveCountLabel({ ...base, constraints: wordsIn(250, 'suggested') }),
    '412 words (250 suggested)')
  assert.equal(liveCountLabel({ ...base, constraints: wordsIn(500, 'target') }),
    '412 words (500 the stated length)')
  assert.equal(liveCountLabel({ ...base, constraints: wordsIn(500, 'unknown') }),
    '412 words (500 stated, not confirmed as a limit)')
  // Truncated is a rule, so it keeps the slash.
  assert.equal(liveCountLabel({ ...base, constraints: wordsIn(250, 'truncated') }),
    '412 / 250 words')
})

test('a soft character bound keeps its spaces rule in the counter', () => {
  const soft: Constraints = {
    ...NO_CONSTRAINTS,
    characters: characterLimit({ max: 2500, spacesCount: false, enforcement: 'suggested' }),
  }
  assert.equal(
    liveCountLabel({ kind: 'characters', constraints: soft, words: 2, text: 'ab cd' }),
    '4 characters (2,500 suggested) excluding spaces')
})

// -------------------------------------------------- the source itself

test('NO CONVERSION CONSTANT ENTERED THIS MODULE EITHER', () => {
  // constraints.ts has had this guard since the feature shipped; the register
  // added a second place where a words-per-page figure could creep in.
  const source = read('./constraintText.ts').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(source, /wordsPerPage|charsPerWord|WORDS_PER_|CHARS_PER_|PER_PAGE/i)
  assert.doesNotMatch(source, /\b(?:250|275|300|500)\s*\*|\*\s*(?:250|275|300|500)\b/)
})

// ===========================================================================
// THE UT KNOXVILLE COUNTER'S LABEL
// ===========================================================================

test('THE COUNTER SAYS WHAT IT IS COUNTING, NOT JUST A NUMBER', () => {
  const constraints = UT_KNOXVILLE.requirements[0]!.constraints
  const label = liveCountLabel({
    kind: 'characters', constraints, words: 2, text: 'ab cd',
  })
  // THE SCHOOL STATED A RANGE, 5,000-18,000, and the counter now says so. It
  // used to show "4 / 18,000": the floor was invisible, which reads as though
  // four characters were merely a long way from the ceiling rather than far
  // below the minimum.
  assert.equal(label, '4 characters excluding spaces — required 5,000–18,000')
  // FOUR THINGS IN ONE STRING, and all four are needed: the count, BOTH bounds
  // it is measured against, and the RULE it was measured by. Drop the last and
  // an applicant at 17,900 cannot tell whether their spaces are in the number.
  assert.match(label, /^4 /, 'the count')
  assert.match(label, /5,000/, 'the school’s floor')
  assert.match(label, /18,000/, 'the school’s ceiling')
  assert.match(label, /excluding spaces/, 'the counting rule')
})

test('the label tracks the rule, so it can never describe the wrong count', () => {
  // Same text, three spaces rules, three honest labels.
  const text = 'ab cd'
  const of = (spacesCount: boolean | null) => liveCountLabel({
    kind: 'characters',
    constraints: {
      ...NO_CONSTRAINTS,
      characters: characterLimit({ max: 100, spacesCount, enforcement: 'enforced' }),
    },
    words: 2,
    text,
  })
  assert.equal(of(false), '4 / 100 characters excluding spaces')
  assert.equal(of(true), '5 / 100 characters including spaces')
  // UNSTATED SAYS NOTHING RATHER THAN PICKING. The count shown is the larger,
  // stricter one; the label does not claim a rule the school did not give.
  assert.equal(of(null), '5 / 100 characters')
  assert.doesNotMatch(of(null), /(in|ex)cluding spaces/)
})

test('THE PAGE AND SPACING REQUIREMENTS NEVER REACH THE COUNTER', () => {
  // UT Knoxville also states 3-5 double-spaced pages. The counter is the thing
  // that claims to measure, so no page number may appear in it.
  const constraints = UT_KNOXVILLE.requirements[0]!.constraints
  for (const kind of ['words', 'characters'] as const) {
    const label = liveCountLabel({ kind, constraints, words: 900, text: 'x '.repeat(900) })
    assert.doesNotMatch(label, /\bpages?\b/i, kind)
    assert.doesNotMatch(label, /spaced/i, kind)
    /*
      THE PAGE BOUND ITSELF, NOT ANY DIGIT IN ITS RANGE.

      This read /\b[3-5]\b/ -- any bare 3, 4 or 5 -- which was only ever a
      proxy for "3-5 pages". It started failing when the character counter
      began showing the school's real floor, because "5,000" opens with a 5.
      A proxy that rejects a correct string is not guarding the rule it was
      written for, so it is replaced by the rule: the page range must not
      appear as a bound.
    */
    assert.doesNotMatch(label, /\b3\s*[–-]\s*5\b/, `${kind}: the page range leaked`)
    assert.doesNotMatch(label, /\/\s*[35]\b/, `${kind}: a page bound leaked as a ceiling`)
  }
  // They are DISPLAYED instead, in the school's own unit.
  const lines = constraintLines(constraints)
  assert.ok(lines.some((line) => /3–5 pages \(double-spaced\)/.test(line)))

  // AND THE PAGE LINE IS NOW A MEASURED ONE. It used to be flagged unchecked
  // alongside the spacing, because a textarea could see neither; the Studio
  // lays the page out, counts it, and applies the spacing.
  const unchecked = labelledConstraints(constraints).filter((line) => !line.measured)
  assert.deepEqual(unchecked.map((line) => line.kind), [])
  assert.equal(needsManualReview(constraints), false)

  // The analyser's own scope is unchanged and still names both, deliberately:
  // widening what the model is asked to score is a rubric decision.
  assert.deepEqual([...analyzerUnmeasuredKinds(constraints)], ['pages', 'spacing'])
})

// ===========================================================================
// A QUOTATION AND A SUMMARY ARE NOT THE SAME CLAIM
// ===========================================================================

const quoted = (text: string): Constraints =>
  ({ ...NO_CONSTRAINTS, unenforcedLength: statedLength({ text, verbatim: true }) })
const summarised = (text: string): Constraints =>
  ({ ...NO_CONSTRAINTS, unenforcedLength: statedLength({ text, verbatim: false }) })

test('QUOTATION MARKS APPEAR ONLY FOR A QUOTATION', () => {
  // THE FAILURE THIS PREVENTS is a paraphrase presented as the school's
  // sentence: a misattribution the applicant cannot detect and cannot check.
  const school = constraintLines(quoted('Submit a 1-2 page essay using APA formatting.'))[0]!
  assert.match(school, /The school states: “Submit a 1-2 page essay using APA formatting\.”/)

  const ours = constraintLines(summarised('one personal essay, 1-2 pages, APA formatting'))[0]!
  assert.match(ours, /Recorded requirement, not the school’s exact wording: /)
  assert.doesNotMatch(ours, /“|”|"/, 'a summary carries no quotation marks at all')
  assert.doesNotMatch(ours, /The school states/)

  // BOTH SAY THE SAME THING ABOUT ENFORCEMENT, because that part is identical.
  for (const line of [school, ours]) {
    assert.match(line, /not enforced here, because the school does not say whether it is a limit/)
  }
})

test('A SUMMARY NEVER REACHES THE "school’s wording" LIST', () => {
  // statedWordings() feeds a heading that is itself a quotation claim.
  assert.deepEqual([...statedWordings(quoted('A 2-3 page essay'))], ['A 2-3 page essay'])
  assert.deepEqual([...statedWordings(summarised('about two or three pages'))], [],
    'nothing attributable, so nothing offered')
  assert.equal(unenforcedLengthIsVerbatim(quoted('x')), true)
  assert.equal(unenforcedLengthIsVerbatim(summarised('x')), false)
  assert.equal(unenforcedLengthIsVerbatim(NO_CONSTRAINTS), false)
})

test('THE TWO NOTICES DIFFER, AND THE SUMMARY ONE SAYS WHY', () => {
  // For a quoted instruction the open question is only what the figure MEANS.
  // For a summary it is also whether the wording is right.
  assert.equal(unenforcedLengthNotice(NO_CONSTRAINTS), null)
  const forQuote = unenforcedLengthNotice(quoted('A 2-3 page essay'))!
  const forSummary = unenforcedLengthNotice(summarised('two or three pages'))!
  assert.notEqual(forQuote, forSummary)
  assert.equal(forQuote, UNENFORCED_LENGTH_NOTICE)
  assert.equal(forSummary, UNENFORCED_LENGTH_SUMMARY_NOTICE)
  assert.match(forSummary, /RECORDED SUMMARY of their requirement, not their exact wording/)
  assert.doesNotMatch(forQuote, /SUMMARY/)
  // NEITHER CLAIMS TO HAVE CHECKED ANYTHING.
  for (const notice of [forQuote, forSummary]) {
    assert.match(notice, /nothing (?:is checked|against it)/)
    assert.match(notice, /own (?:application materials|instructions)/)
  }
})

test('AN ABSENT VERBATIM FLAG IS READ AS A SUMMARY, never as a quotation', () => {
  // The under-claiming direction, at the type boundary. A record built without
  // the flag -- by older code, by a hand-written insert -- is shown as a
  // summary: a quotation shown as a summary loses a little authority, and a
  // summary shown as a quotation invents a sentence.
  const bare = {
    ...NO_CONSTRAINTS,
    unenforcedLength: { text: 'two pages' } as unknown as Constraints['unenforcedLength'],
  } as Constraints
  assert.equal(unenforcedLengthIsVerbatim(bare), false)
  assert.deepEqual([...statedWordings(bare)], [])
  assert.doesNotMatch(constraintLines(bare)[0]!, /The school states/)
})
