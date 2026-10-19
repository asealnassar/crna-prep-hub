/**
 * AI-QA-018: a trailing "..." must not throw away a genuine excerpt, and an
 * internal one must still be refused.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, AND IT WAS A DEFECT IN THE AI-QA-002 FIX
 * ---------------------------------------------------------------------------
 * The excerpt verifier forbade every ellipsis, on the reasoning that a
 * quotation assembled out of fragments is a fabricated passage. That reasoning
 * is right about the MIDDLE and wrong about the ENDS: gpt-4o abbreviates a long
 * excerpt with a trailing marker, and the span before it is genuinely in the
 * essay.
 *
 * Measured on a real model call: six of seven categories verified, and the
 * seventh failed on
 *
 *   "My clinical background is three years in a twenty-eight bed
 *    cardiothoracic intensive care unit..."
 *
 * whose text, without the marker, occurs verbatim and contiguously. The whole
 * analysis was discarded, the applicant was told it "came back in a form we
 * could not read", and it still cost part of their burst allowance.
 *
 * ---------------------------------------------------------------------------
 * THE SECURITY PROPERTY IS UNCHANGED
 * ---------------------------------------------------------------------------
 * Evidence claimed as present must resolve to ONE CONTIGUOUS SPAN that exists
 * in the applicant's essay. Only a marker at a boundary is removed; the floor
 * then applies to what is left, so markers cannot be used to smuggle a
 * one-word match past it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_VERIFIABLE_QUOTE_CHARS, isEssayExcerpt } from './evidence.ts'

const ESSAY = [
  'My clinical background is three years in a twenty-eight bed cardiothoracic',
  'intensive care unit, caring for post-operative CABG and valve patients.',
  'One evening a post-operative valve patient began to decompensate and I called',
  'the intensivist before the numbers justified it. She told me afterwards that',
  'the early call was the reason the night ended the way it did.',
].join(' ')

/** A contiguous span, comfortably over the floor. */
const SPAN = 'My clinical background is three years in a twenty-eight bed cardiothoracic'
/** A second, distant span. */
const DISTANT = 'the early call was the reason the night ended the way it did'

const verifies = (excerpt: string) => isEssayExcerpt({ excerpt, essay: ESSAY })

// ===========================================================================
// ACCEPT
// ===========================================================================

test('an exact contiguous span', () => {
  assert.equal(verifies(SPAN), true)
})

test('a contiguous span followed by three dots', () => {
  assert.equal(verifies(`${SPAN}...`), true)
  assert.equal(verifies(`${SPAN} ...`), true)
  // The real failure, verbatim from the model.
  assert.equal(verifies(
    'My clinical background is three years in a twenty-eight bed cardiothoracic '
    + 'intensive care unit...'), true)
})

test('a contiguous span followed by the Unicode ellipsis', () => {
  assert.equal(verifies(`${SPAN}…`), true)
  assert.equal(verifies(`${SPAN} …`), true)
})

test('three dots then a contiguous span', () => {
  assert.equal(verifies(`...${SPAN}`), true)
  assert.equal(verifies(`... ${SPAN}`), true)
})

test('a Unicode ellipsis then a contiguous span', () => {
  assert.equal(verifies(`…${SPAN}`), true)
  assert.equal(verifies(`… ${SPAN}`), true)
})

test('markers at BOTH ends, over one contiguous span', () => {
  assert.equal(verifies(`...${SPAN}...`), true)
  assert.equal(verifies(`…${SPAN}…`), true)
  assert.equal(verifies(`... ${SPAN} …`), true)
})

test('four or more dots are still one marker, not a stop plus a marker', () => {
  assert.equal(verifies(`${SPAN}....`), true)
  assert.equal(verifies(`${SPAN}.....`), true)
})

test('a sentence that genuinely ends in a full stop is untouched', () => {
  // ONE dot is never a marker. The span keeps its own punctuation.
  assert.equal(verifies('the early call was the reason the night ended the way it did.'), true)
})

test('and the existing narrow normalisation still applies at the boundary', () => {
  assert.equal(verifies(`${SPAN.toUpperCase()}...`), true)
  assert.equal(verifies(`${SPAN.replace(/ /g, '  ')}…`), true)
})

// ===========================================================================
// REJECT
// ===========================================================================

test('REAL BEGINNING ... REAL ENDING, with the middle omitted', () => {
  // Both halves are genuine; presenting them as one passage is not.
  assert.equal(verifies(`${SPAN} ... ${DISTANT}`), false)
  assert.equal(verifies(`${SPAN}...${DISTANT}`), false)
})

test('the same stitch with the Unicode ellipsis', () => {
  assert.equal(verifies(`${SPAN} … ${DISTANT}`), false)
  assert.equal(verifies(`${SPAN}…${DISTANT}`), false)
})

test('a fabricated passage with a trailing marker', () => {
  assert.equal(verifies('I single-handedly resuscitated a patient in the trauma bay...'), false)
  assert.equal(verifies('…I led the rapid response team through the arrest that night'), false)
})

test('an excerpt reduced below the floor once the markers come off', () => {
  // THE CASE THE FLOOR EXISTS FOR. "patient" is in the essay; it is not evidence.
  assert.equal(verifies('...patient...'), false)
  assert.equal(verifies('…patient…'), false)
  assert.equal(verifies('...the...'), false)
  // And a span just under the floor, with markers, is still under it.
  const short = ESSAY.slice(0, MIN_VERIFIABLE_QUOTE_CHARS - 1)
  assert.ok(ESSAY.includes(short))
  assert.equal(verifies(`...${short}...`), false)
})

test('an excerpt that is nothing but markers', () => {
  for (const nothing of ['...', '......', '…', '……', '... ...', '   ...   ']) {
    assert.equal(verifies(nothing), false, JSON.stringify(nothing))
  }
})

test('an excerpt from another essay, marked or not', () => {
  const theirs = 'I worked nights in a neonatal unit for five years before applying'
  assert.ok(!ESSAY.includes(theirs))
  assert.equal(verifies(theirs), false)
  assert.equal(verifies(`${theirs}...`), false)
  assert.equal(verifies(`...${theirs}`), false)
})

test('AN INTERNAL MARKER IS REFUSED EVEN WHERE THE TEXT IS CONTIGUOUS', () => {
  /*
   * THE CASE THAT PINS "BOUNDARY ONLY", and it is the one a mutation hides
   * behind. A stitch of two DISTANT spans is refused by any implementation
   * that removes the marker, because what is left is not contiguous either
   * way. So that test alone does not distinguish removing markers at the ends
   * from removing them everywhere -- a global strip passes it.
   *
   * This one does distinguish. The marker sits in the middle of text that IS
   * contiguous in the essay, so a global strip would ACCEPT it and the
   * anchored rule REFUSES it.
   *
   * REFUSING IS RIGHT. The marker asserts that something was left out. Nothing
   * was, so the quotation is not what it presents itself as -- and a verifier
   * whose job is to vouch for a quotation must not vouch for one whose own
   * punctuation is making a claim it cannot check.
   */
  const contiguous = 'the early call was the reason the night ended the way it did'
  assert.ok(ESSAY.includes(contiguous))
  // Verbatim: accepted.
  assert.equal(verifies(contiguous), true)
  // The same words, with a marker inserted mid-span: refused.
  assert.equal(verifies('the early call was the reason ... the night ended the way it did'), false)
  assert.equal(verifies('the early call was the reason \u2026 the night ended the way it did'), false)
  // And with boundary markers as well, the internal one still decides.
  assert.equal(verifies('...the early call was the reason ... the night ended the way it did...'),
    false)
})

test('a span whose words are reordered, or one word changed', () => {
  assert.equal(verifies(`${SPAN.split(' ').reverse().join(' ')}...`), false)
  assert.equal(verifies(`${SPAN.replace('three', 'seven')}...`), false)
})

// ===========================================================================
// AN ELLIPSIS THE APPLICANT WROTE
// ===========================================================================

test('an ellipsis in the ESSAY ITSELF still verifies, because it is contiguous', () => {
  /*
   * ORDER MATTERS, AND THIS IS WHY. The whole excerpt is tried before any
   * marker is removed, so a span the applicant really wrote -- ellipsis and
   * all -- is matched as itself rather than taken apart.
   */
  const essay = 'She paused, said "I do not know ... I think I was frightened", and sat down again.'
  const span = 'I do not know ... I think I was frightened'
  assert.ok(essay.includes(span))
  assert.equal(isEssayExcerpt({ excerpt: span, essay }), true)
  // And a stitch across that same essay is still refused.
  assert.equal(isEssayExcerpt({
    excerpt: 'She paused, said ... and sat down again.', essay,
  }), false)
})

// ===========================================================================
// THE MODEL CONTRACT IS UNCHANGED
// ===========================================================================

test('the prompt still asks for a verbatim span and does NOT license omissions', async () => {
  const { reviewSystemPrompt } = await import('./reviewPrompt.ts')
  const prompt = reviewSystemPrompt(true, null)
  // Still asked for, in the same words.
  assert.match(prompt, /copied word for word/)
  assert.match(prompt, /one continuous run, no ellipsis/)
  // AND NOTHING TELLS IT AN INTERNAL OMISSION IS ACCEPTABLE. Tolerating a
  // presentation convention is not the same as inviting one.
  assert.doesNotMatch(prompt, /ellipsis is (allowed|acceptable|fine|permitted)/i)
  assert.doesNotMatch(prompt, /you may (omit|elide|abbreviate)/i)
})
