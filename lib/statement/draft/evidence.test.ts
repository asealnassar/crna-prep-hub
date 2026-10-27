import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_VERIFIABLE_QUOTE_CHARS, fabricatedQuotes, normalizeForMatch, quotedSpans,
} from './evidence.ts'

const ESSAY = `I spent three years in a cardiothoracic ICU, mostly post-op CABG and valve patients.

The night a trauma patient coded, the CRNA kept the room calm while the rest of us did not.
I want to practise in a rural critical-access hospital where CRNAs work independently.`

test('a genuine quotation is found', () => {
  assert.deepEqual(fabricatedQuotes({
    evidence: 'You write: "I spent three years in a cardiothoracic ICU".',
    essay: ESSAY,
  }), [])
})

test('A FABRICATED QUOTATION IS CAUGHT', () => {
  // The worst failure this feature can have: telling somebody they wrote
  // something they did not.
  const missing = fabricatedQuotes({
    evidence: '"I led a rapid response team through twelve cardiac arrests last year."',
    essay: ESSAY,
  })
  assert.equal(missing.length, 1)
  assert.ok(missing[0].includes('rapid response team'))
})

test('re-wrapping and retyped punctuation are NOT fabrication', () => {
  // A model that reproduces a sentence faithfully but tidies its quotes or
  // line breaks has invented nothing, and refusing an analysis over that would
  // be worse than the failure being prevented.
  for (const quoted of [
    'I spent three years in a cardiothoracic ICU,\n   mostly post-op CABG and valve patients',
    'I SPENT THREE YEARS IN A CARDIOTHORACIC ICU',
    'rural critical–access hospital where CRNAs work independently',
  ]) {
    assert.deepEqual(
      fabricatedQuotes({ evidence: `"${quoted}"`, essay: ESSAY }), [], quoted.slice(0, 30),
    )
  }
})

test('an elided quotation is checked in parts', () => {
  assert.deepEqual(fabricatedQuotes({
    evidence: '"I spent three years in a cardiothoracic ICU ... where CRNAs work independently"',
    essay: ESSAY,
  }), [])
  // And elision cannot be used to smuggle an invention through.
  const missing = fabricatedQuotes({
    evidence: '"I spent three years in a cardiothoracic ICU ... and published four papers on it"',
    essay: ESSAY,
  })
  assert.equal(missing.length, 1)
  assert.ok(missing[0].includes('published four papers'))
})

test('short quoted fragments are not treated as excerpts', () => {
  // Three words in quotation marks is often the model's own phrasing, and
  // hunting those would reject constantly for nothing.
  const short = '"calm" and "independently" are doing real work here.'
  assert.deepEqual(fabricatedQuotes({ evidence: short, essay: ESSAY }), [])
  assert.ok('calm'.length < MIN_VERIFIABLE_QUOTE_CHARS)
})

test('an explicit absence quotes nothing and passes', () => {
  assert.deepEqual(fabricatedQuotes({
    evidence: 'The draft does not describe any single patient encounter in detail.',
    essay: ESSAY,
  }), [])
})

test('apostrophes are letters, not delimiters', () => {
  // Treating single quotes as quotation marks would carve nonsense out of
  // ordinary prose and then verify it against the essay.
  assert.deepEqual(quotedSpans("the patient's chart and the nurse's note"), [])
  assert.deepEqual(fabricatedQuotes({
    evidence: "You describe the patient's chart, which is not in the essay at all.",
    essay: ESSAY,
  }), [])
})

test('several quotations in one field are each checked', () => {
  const missing = fabricatedQuotes({
    evidence: '"I spent three years in a cardiothoracic ICU" and "I ran the trauma bay for two years"',
    essay: ESSAY,
  })
  assert.equal(missing.length, 1)
  assert.ok(missing[0].includes('trauma bay'))
})

test('normalisation folds only rendering, never wording', () => {
  assert.equal(normalizeForMatch('  The   patient’s   chart  '), "the patient's chart")
  assert.notEqual(normalizeForMatch('a specific case'), normalizeForMatch('a specific cases'))
})
