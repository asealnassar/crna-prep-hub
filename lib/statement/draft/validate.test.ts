import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TITLE_CHARS, MIN_TITLE_CHARS,
  checkDraftCreate, checkDraftUpdate, checkEssay, checkExpectedRevision, checkTitle,
} from './validate.ts'
import { MAX_SAVED_CHARS } from '../extract/limits.ts'
import { MAX_STATEMENT_CHARS } from '../limits.ts'

/**
 * Pure. Nothing here opens a connection, reads a row or looks at a clock.
 *
 * CHARACTERS ARE UTF-16 CODE UNITS throughout, matching String.prototype.length,
 * which is what checkStatement() and extractDocument.ts already measure. The
 * astral-character case is asserted explicitly at the end so the choice is
 * recorded as a decision rather than an accident.
 */

const text = (n: number) => 'a'.repeat(n)

/** Every non-string a malformed body could realistically carry. */
const NOT_STRINGS: readonly unknown[] = [
  undefined, null, 0, 1, -1, NaN, true, false, {}, [], ['a'],
  { toString: () => 'looks like a string' },
]

// ------------------------------------------------------------------ the limits

test('draft: the approved limits are exactly the approved values', () => {
  assert.equal(MAX_SAVED_CHARS, 20_000)
  assert.equal(MIN_TITLE_CHARS, 1)
  assert.equal(MAX_TITLE_CHARS, 200)
})

// ------------------------------------------------------------------- the title

test('title: a normal title is accepted and returned unchanged', () => {
  const result = checkTitle('My CRNA personal statement')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.title, 'My CRNA personal statement')
})

test('title: outer whitespace is trimmed, and the trimmed value is what comes back', () => {
  // THE POINT: the length that was checked is the length that gets stored.
  // Returning the untrimmed string would let a 200-character title arrive with
  // padding and be stored longer than the bound that admitted it.
  const result = checkTitle('\t  Draft two \n ')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.title, 'Draft two')
})

test('title: inner whitespace is preserved -- only the ends are trimmed', () => {
  const result = checkTitle('  Draft  two   three  ')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.title, 'Draft  two   three')
})

test('title: an empty string is refused', () => {
  const result = checkTitle('')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'invalid-title')
})

test('title: whitespace-only is refused, the same way as empty', () => {
  // After trimming there is no title, and the database CHECK on btrim(title)
  // would reject both for the same reason.
  for (const blank of [' ', '   ', '\t', '\n', ' \t\n\r ']) {
    const result = checkTitle(blank)
    assert.equal(result.ok, false, JSON.stringify(blank))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-title')
  }
})

test('title: exactly 1 trimmed character is allowed', () => {
  const result = checkTitle('  a  ')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.title, 'a')
})

test('title: exactly 200 is allowed, 201 is refused', () => {
  const at = checkTitle(text(200))
  assert.equal(at.ok, true)
  if (at.ok) assert.equal(at.title.length, 200)

  const over = checkTitle(text(201))
  assert.equal(over.ok, false)
  if (over.ok) return
  assert.equal(over.code, 'title-too-long')
  assert.equal(over.characters, 201)
})

test('title: the bound is measured AFTER trimming, so padding does not push it over', () => {
  const padded = checkTitle('   ' + text(200) + '   ')
  assert.equal(padded.ok, true)
  if (!padded.ok) return
  assert.equal(padded.title.length, 200)
})

test('title: a non-string is refused, never coerced', () => {
  for (const value of NOT_STRINGS) {
    const result = checkTitle(value)
    assert.equal(result.ok, false, String(value))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-title')
  }
})

// ------------------------------------------------------------------- the essay

test('essay: an empty essay is allowed -- a draft exists before a word is written', () => {
  const result = checkEssay('')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.essay, '')
  assert.equal(result.characters, 0)
})

test('essay: a normal essay is allowed and its count is reported', () => {
  const essay = 'I first met a CRNA in a trauma bay.\n\nThat shift changed my plan.'
  const result = checkEssay(essay)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.essay, essay)
  assert.equal(result.characters, essay.length)
})

test('essay: exactly 20,000 is allowed, 20,001 is refused with its count', () => {
  const at = checkEssay(text(MAX_SAVED_CHARS))
  assert.equal(at.ok, true)
  if (at.ok) assert.equal(at.characters, 20_000)

  const over = checkEssay(text(MAX_SAVED_CHARS + 1))
  assert.equal(over.ok, false)
  if (over.ok) return
  assert.equal(over.code, 'essay-too-long')
  // The COUNT is returned so a route can say how much has to go.
  assert.equal(over.characters, 20_001)
})

test('essay: NOTHING IS TRUNCATED -- the accepted essay is the input, byte for byte', () => {
  // The refusal exists precisely so that truncation never has to. An earlier
  // ceiling that sliced would have silently destroyed the end of an essay.
  const essay = text(MAX_SAVED_CHARS)
  const result = checkEssay(essay)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.essay, essay)
  assert.equal(result.essay.length, MAX_SAVED_CHARS)
  assert.equal(result.essay === essay, true, 'the same string is returned, not a copy of part of it')
})

test('essay: an over-length essay carries no text back at all', () => {
  const result = checkEssay(text(MAX_SAVED_CHARS + 500))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal('essay' in result, false)
})

test('essay: leading and trailing whitespace is PRESERVED, unlike the title', () => {
  // A statement's blank lines are part of what the applicant wrote, and the
  // value is measured exactly as it will be stored.
  const essay = '\n\n  Opening line.\n\nClosing line.\n\n'
  const result = checkEssay(essay)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.essay, essay)
  assert.equal(result.characters, essay.length)
})

test('essay: a non-string is refused, never coerced', () => {
  for (const value of NOT_STRINGS) {
    const result = checkEssay(value)
    assert.equal(result.ok, false, String(value))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-essay')
  }
})

// ---------------------------------------------------------------- the revision

test('revision: 1 is allowed -- it is where every row starts', () => {
  const result = checkExpectedRevision(1)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.revision, 1)
})

test('revision: any positive integer is allowed', () => {
  for (const value of [1, 2, 7, 1_000, 9_007_199_254_740_991]) {
    const result = checkExpectedRevision(value)
    assert.equal(result.ok, true, String(value))
    if (result.ok) assert.equal(result.revision, value)
  }
})

test('revision: 0 and negatives are refused', () => {
  for (const value of [0, -0, -1, -1_000]) {
    const result = checkExpectedRevision(value)
    assert.equal(result.ok, false, String(value))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-revision')
  }
})

test('revision: a fraction is refused', () => {
  for (const value of [1.5, 0.5, 2.000001, -1.5]) {
    const result = checkExpectedRevision(value)
    assert.equal(result.ok, false, String(value))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-revision')
  }
})

test('revision: the string "1" is refused, never parsed', () => {
  // A client may not send a revision as text. The opposite direction -- a
  // bigint arriving FROM PostgREST as a string -- is the repository's problem,
  // and lib/resume/repo/resumeRepo.ts already coerces it there.
  for (const value of ['1', '2', ' 1 ', '1e0']) {
    const result = checkExpectedRevision(value)
    assert.equal(result.ok, false, JSON.stringify(value))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-revision')
  }
})

test('revision: NaN and both infinities are refused', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const result = checkExpectedRevision(value)
    assert.equal(result.ok, false, String(value))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-revision')
  }
})

test('revision: a value past MAX_SAFE_INTEGER is refused, because bigint would not survive it', () => {
  // The column is bigint. A number this large cannot round-trip through JSON
  // intact, and a compare-and-swap on a value that silently changed is worse
  // than a refusal.
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 2 ** 60]) {
    const result = checkExpectedRevision(value)
    assert.equal(result.ok, false, String(value))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-revision')
  }
})

test('revision: a non-number is refused', () => {
  for (const value of [undefined, null, true, {}, [], [1]]) {
    const result = checkExpectedRevision(value)
    assert.equal(result.ok, false, String(value))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-revision')
  }
})

// -------------------------------------------------------------- create

test('create: a valid title with an EMPTY essay succeeds -- a draft starts blank', () => {
  const result = checkDraftCreate({ title: 'Draft one', essay: '' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.input, { title: 'Draft one', essay: '' })
  assert.equal(result.characters, 0)
})

test('create: a valid title with a normal essay succeeds', () => {
  const essay = 'I first met a CRNA in a trauma bay.\n\nThat shift changed my plan.'
  const result = checkDraftCreate({ title: 'Draft one', essay })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.input.essay, essay)
  assert.equal(result.characters, essay.length)
})

test('create: the title is normalised to its trimmed form', () => {
  const result = checkDraftCreate({ title: '\t  Draft two \n ', essay: 'Body.' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.input.title, 'Draft two')
})

test('create: an invalid title is refused', () => {
  for (const title of ['', '   ', text(201), 42, null, undefined]) {
    const result = checkDraftCreate({ title, essay: 'Body.' })
    assert.equal(result.ok, false, String(title))
    if (result.ok) continue
    assert.ok(result.code === 'invalid-title' || result.code === 'title-too-long', result.code)
  }
})

test('create: an over-length essay is refused, with its count', () => {
  const result = checkDraftCreate({ title: 'Draft one', essay: text(MAX_SAVED_CHARS + 1) })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'essay-too-long')
  assert.equal(result.characters, MAX_SAVED_CHARS + 1)
})

test('create: NO REVISION IS REQUIRED -- the column supplies 1', () => {
  // A row that does not exist yet has no revision for a caller to have read, so
  // asking for one would be asking for a value it cannot know.
  const result = checkDraftCreate({ title: 'Draft one', essay: 'Body.' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal('expectedRevision' in result.input, false)
  assert.deepEqual(Object.keys(result.input).sort(), ['essay', 'title'])
})

test('create: an extraneous revision is IGNORED, not validated and not forwarded', () => {
  // The parameter names two fields. A body that carries a third must not change
  // creation semantics -- and in particular an UNUSABLE revision must not refuse
  // a creation for being "stale" against a row that does not exist. Assigned to
  // a variable first because TypeScript's excess-property check applies only to
  // fresh object literals; the runtime shape is what is under test.
  const withExtra = { title: '  Draft one  ', essay: 'Body.', expectedRevision: 0 }
  const result = checkDraftCreate(withExtra)
  assert.equal(result.ok, true, 'an ignored field must not cause a refusal')
  if (!result.ok) return
  assert.deepEqual(result.input, { title: 'Draft one', essay: 'Body.' })
  assert.equal('expectedRevision' in result.input, false)

  // The same is true of a revision that would have been VALID: still ignored.
  const alsoValid = { title: 'Draft one', essay: 'Body.', expectedRevision: 7 }
  const second = checkDraftCreate(alsoValid)
  assert.equal(second.ok, true)
  if (second.ok) assert.equal('expectedRevision' in second.input, false)
})

test('create: the refusal order is fixed -- title, then essay', () => {
  const bothWrong = { title: '', essay: 42 }
  const first = checkDraftCreate(bothWrong)
  assert.equal(first.ok, false)
  if (!first.ok) assert.equal(first.code, 'invalid-title')

  const second = checkDraftCreate({ ...bothWrong, title: 'ok' })
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.code, 'invalid-essay')
})

test('create: an empty object reports the missing title rather than throwing', () => {
  const result = checkDraftCreate({})
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'invalid-title')
})

// -------------------------------------------------------------- update

test('update: a valid title, essay and revision succeed together', () => {
  const result = checkDraftUpdate({
    title: 'Draft one',
    essay: 'Opening line.',
    expectedRevision: 3,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.input, {
    title: 'Draft one',
    essay: 'Opening line.',
    expectedRevision: 3,
  })
  assert.equal(result.characters, 'Opening line.'.length)
})

test('update: the title is normalised to its trimmed form', () => {
  const result = checkDraftUpdate({
    title: '  Draft two  ',
    essay: 'Body.',
    expectedRevision: 2,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.input.title, 'Draft two')
})

test('update: revision 1 succeeds -- the value a freshly created row holds', () => {
  const result = checkDraftUpdate({ title: 'Draft one', essay: 'Body.', expectedRevision: 1 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.input.expectedRevision, 1)
})

test('update: a bad revision is refused', () => {
  for (const expectedRevision of [
    0, -1, 1.5, '1', NaN, Infinity, -Infinity, null, undefined, {},
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const result = checkDraftUpdate({ title: 'Draft one', essay: 'Body.', expectedRevision })
    assert.equal(result.ok, false, String(expectedRevision))
    if (result.ok) continue
    assert.equal(result.code, 'invalid-revision')
  }
})

test('update: an over-length essay is refused, with its count', () => {
  const result = checkDraftUpdate({
    title: 'Draft one',
    essay: text(MAX_SAVED_CHARS + 7),
    expectedRevision: 1,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'essay-too-long')
  assert.equal(result.characters, MAX_SAVED_CHARS + 7)
})

test('update: NOTHING IS TRUNCATED at the ceiling -- the essay passes through whole', () => {
  const essay = text(MAX_SAVED_CHARS)
  const result = checkDraftUpdate({ title: 'Draft one', essay, expectedRevision: 4 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.input.essay === essay, true, 'the same string, not a slice of it')
  assert.equal(result.input.essay.length, MAX_SAVED_CHARS)
  assert.equal(result.characters, MAX_SAVED_CHARS)
})

test('update: the refusal order is fixed -- title, then essay, then revision', () => {
  // A payload wrong in several ways must always report the same code, or a
  // route built on this is not deterministic and cannot be tested for it.
  const allWrong = { title: '', essay: 42, expectedRevision: 0 }
  const first = checkDraftUpdate(allWrong)
  assert.equal(first.ok, false)
  if (!first.ok) assert.equal(first.code, 'invalid-title')

  const second = checkDraftUpdate({ ...allWrong, title: 'ok' })
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.code, 'invalid-essay')

  const third = checkDraftUpdate({ ...allWrong, title: 'ok', essay: '' })
  assert.equal(third.ok, false)
  if (!third.ok) assert.equal(third.code, 'invalid-revision')
})

test('update: an empty object reports the missing title rather than throwing', () => {
  const result = checkDraftUpdate({})
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'invalid-title')
})

// --------------------------------------------- neither operation leaks the essay

test('no refusal from either operation carries the essay text', () => {
  // Same rule as every other statement surface: counts and fixed words only.
  const creates = [
    { title: '', essay: 'secret essay' },
    { title: 'ok', essay: text(MAX_SAVED_CHARS + 1) },
  ]
  const updates = [
    { title: '', essay: 'secret essay', expectedRevision: 1 },
    { title: 'ok', essay: text(MAX_SAVED_CHARS + 1), expectedRevision: 1 },
    { title: 'ok', essay: 'secret essay', expectedRevision: 0 },
  ]
  for (const result of [
    ...creates.map((p) => checkDraftCreate(p)),
    ...updates.map((p) => checkDraftUpdate(p)),
  ]) {
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal('essay' in result, false)
    assert.equal('input' in result, false)
    assert.ok(/^[a-z-]+$/.test(result.code), `code is not a plain word: ${result.code}`)
  }
})

// -------------------------------------------- the two approved 20,000 constants

test('the two approved 20,000 constants remain equal', () => {
  // WHY THIS TEST EXISTS. MAX_SAVED_CHARS bounds what may be PERSISTED and
  // MAX_STATEMENT_CHARS bounds what may be ANALYZED. A draft saved at the
  // ceiling is then analyzed, so if these ever diverged downward on the analyzer
  // side, an applicant could save an essay the analyzer refuses to read.
  //
  // The approved decision is to keep them as two constants for now rather than
  // refactor committed Phase 1/2 code, so this asserts the coupling instead of
  // removing it. NEITHER CONSTANT MAY BE CHANGED TO MAKE THIS PASS: if they
  // diverge on purpose, that is a product decision and this test is where it
  // gets argued.
  assert.equal(MAX_SAVED_CHARS, MAX_STATEMENT_CHARS)
  assert.equal(MAX_SAVED_CHARS, 20_000)
})

// ----------------------------------------------- the character-semantics choice

test('characters are UTF-16 code units, which is what the rest of the app measures', () => {
  // '😀' is ONE code point but TWO code units, and .length reports 2. The
  // database CHECK uses char_length(), which counts code points, so it is the
  // more permissive of the two. This module is therefore the stricter gate --
  // nothing the database would refuse is accepted here.
  const emoji = '😀'
  assert.equal(emoji.length, 2)
  assert.equal([...emoji].length, 1)

  const exactly = emoji.repeat(MAX_SAVED_CHARS / 2)
  assert.equal(exactly.length, MAX_SAVED_CHARS)
  assert.equal(checkEssay(exactly).ok, true)

  const oneOver = emoji.repeat(MAX_SAVED_CHARS / 2 + 1)
  assert.equal(oneOver.length, MAX_SAVED_CHARS + 2)
  const refused = checkEssay(oneOver)
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.equal(refused.characters, MAX_SAVED_CHARS + 2)
})
