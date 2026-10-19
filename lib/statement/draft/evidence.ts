/**
 * Whether a quotation the model offered is actually in the essay.
 *
 * THE PROBLEM THIS SOLVES. The analyser asks for evidence quoted from the
 * applicant's own writing, and a language model will sometimes produce a
 * sentence that reads like the essay without being in it -- a paraphrase
 * presented between quotation marks. That is the worst failure this feature
 * can have: an applicant is told "you wrote X" about something they did not
 * write, and every judgement resting on it is unfounded.
 *
 * BOUNDED ON PURPOSE. Matching is done on normalised text -- whitespace runs
 * collapsed, case folded, typographic quotes and dashes folded to ASCII --
 * because a model that reproduces a sentence faithfully but re-wraps it is not
 * fabricating anything, and refusing an entire analysis over a line break would
 * be a worse failure than the one being prevented.
 *
 * AND ONLY SUBSTANTIAL SPANS ARE CHECKED. A quoted fragment of three words may
 * legitimately be the model's own phrasing in quotation marks, and hunting
 * those would reject constantly for nothing. A span long enough to be a real
 * excerpt is long enough to be verifiable.
 *
 * ELISION IS ALLOWED. A quotation containing an ellipsis is a deliberate cut,
 * so its parts are checked rather than the whole.
 */

/** Shorter than this, a quoted span is not treated as a verifiable excerpt. */
export const MIN_VERIFIABLE_QUOTE_CHARS = 25

/**
 * Text reduced to what two renderings of the same sentence must share.
 *
 * Typographic quotes and dashes are folded because a model commonly "tidies"
 * them when quoting, and that is a rendering difference rather than a different
 * sentence.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * The spans a piece of evidence presents as direct quotation.
 *
 * READS DOUBLE QUOTES ONLY. An apostrophe is a letter in English -- "the
 * patient's chart" -- so treating single quotes as delimiters would carve
 * nonsense out of ordinary prose and verify it against the essay.
 */
export function quotedSpans(evidence: string): readonly string[] {
  const spans: string[] = []
  const pattern = /["“]([^"“”]{1,1200})["”]/g
  let match = pattern.exec(evidence)
  while (match !== null) {
    spans.push(match[1])
    match = pattern.exec(evidence)
  }
  return spans
}

/**
 * The quoted spans that do NOT appear in the essay.
 *
 * An empty result means every verifiable quotation checked out. A non-empty one
 * means the model presented words as the applicant's that the applicant did not
 * write.
 *
 * SPLIT ON ELLIPSES, so a legitimately elided quotation is checked in parts.
 * Each part is then subject to the same length floor, which is what stops an
 * ellipsis being used to reduce every fragment below the threshold.
 */
export function fabricatedQuotes(input: {
  readonly evidence: string
  readonly essay: string
}): readonly string[] {
  const haystack = normalizeForMatch(input.essay)
  const missing: string[] = []

  for (const span of quotedSpans(input.evidence)) {
    for (const part of span.split(/\.{3}|…|\[\s*\.{3}\s*\]/)) {
      const needle = normalizeForMatch(part)
      if (needle.length < MIN_VERIFIABLE_QUOTE_CHARS) continue
      if (!haystack.includes(needle)) missing.push(part.trim())
    }
  }
  return missing
}

// ---------------------------------------------------------------------------
// AI-QA-002: evidence claimed as present must be PROVABLY present
// ---------------------------------------------------------------------------

/**
 * Whether a span is a verbatim excerpt of the essay.
 *
 * ---------------------------------------------------------------------------
 * WHY `fabricatedQuotes` WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * That function answers "is anything the model put inside quotation marks
 * absent from the essay?", and it only looks at spans of at least
 * MIN_VERIFIABLE_QUOTE_CHARS. Both bounds were load-bearing and both were
 * escapable: a model that claimed `evidenceFound: true` and then wrote
 * "Your essay contains strong material for this category" used no quotation
 * marks at all, so nothing was checked, at any score. A 90/100 with six Strong
 * bands and no evidence whatsoever validated cleanly.
 *
 * The answer is not a better quotation heuristic. It is to stop inferring the
 * excerpt from punctuation and require it as its OWN FIELD, which this function
 * verifies. Prose remains prose; the claim lives in a field that can be proved.
 *
 * ---------------------------------------------------------------------------
 * THE NORMALISATION RULE, EXACTLY
 * ---------------------------------------------------------------------------
 * The excerpt must occur in the essay as a CONTIGUOUS run, after
 * normalizeForMatch() and nothing else: whitespace runs collapsed to one
 * space, ends trimmed, case folded, and typographic quotes and dashes folded
 * to ASCII. Those are the differences between two renderings of the same
 * sentence -- a model re-wrapping a line or tidying an apostrophe is not
 * fabricating anything.
 *
 * NOTHING ELSE IS FORGIVEN. No ellipsis, so an excerpt cannot be assembled
 * out of fragments; no stemming; no word-order tolerance; no partial credit.
 * An excerpt that has had a word changed is a different sentence and is
 * refused, which is the whole point of the field.
 */
export function isEssayExcerpt(input: {
  readonly excerpt: string
  readonly essay: string
}): boolean {
  const haystack = normalizeForMatch(input.essay)

  /*
    FIRST, THE EXCERPT EXACTLY AS GIVEN.

    Tried before any marker is stripped, which is what lets an ellipsis the
    APPLICANT actually wrote survive: if the essay contains "I waited ... and
    then she spoke", an excerpt of that span is contiguous and genuine, and
    stripping anything would be the wrong move. Only a span that fails this
    is reconsidered below.
  */
  const whole = normalizeForMatch(input.excerpt)
  if (whole.length >= MIN_VERIFIABLE_QUOTE_CHARS && haystack.includes(whole)) return true

  /*
    THEN, BOUNDARY ABBREVIATION ONLY. AI-QA-018.

    gpt-4o abbreviates a long excerpt with a trailing "...", and refusing that
    threw away complete, honest analyses: measured on a real call, six of seven
    categories verified and the seventh failed on a trailing marker over a span
    that IS in the essay. The applicant saw "the analysis came back in a form
    we could not read" and lost a slice of their burst allowance for it.

    SO ONLY THE ENDS ARE FORGIVEN, AND ONLY THE MARKER. An ellipsis in the
    MIDDLE is the thing the rule exists for -- "real beginning ... real ending"
    presents two distant passages as one, which is a fabricated passage
    assembled out of true parts. That case is refused by construction here:
    removing the ends leaves the internal marker in place, so the remainder is
    not contiguous in the essay and does not match.

    THE LENGTH FLOOR APPLIES TO WHAT WAS VERIFIED, not to what was submitted.
    Otherwise "...patient..." would clear a 25-character floor on the strength
    of markers and a single word that appears somewhere.

    NO OTHER PUNCTUATION IS TOUCHED. A sentence's own full stop is one dot, not
    three, so it is never mistaken for a marker, and nothing else is stripped.
  */
  const stripped = normalizeForMatch(
    input.excerpt.replace(BOUNDARY_ELLIPSIS_START, '').replace(BOUNDARY_ELLIPSIS_END, ''))
  if (stripped === whole) return false
  if (stripped.length < MIN_VERIFIABLE_QUOTE_CHARS) return false
  return haystack.includes(stripped)
}

/**
 * A presentation marker at the start or end of a quotation, and nothing else.
 *
 * THE ORDINARY THREE-DOT FORM AND THE UNICODE ELLIPSIS, each optionally with
 * surrounding whitespace, anchored to one end. `\.{3,}` rather than `\.{3}` so
 * a model writing four dots is not treated as having written a sentence stop
 * followed by a marker.
 */
const BOUNDARY_ELLIPSIS_START = /^\s*(?:\.{3,}|\u2026)\s*/
const BOUNDARY_ELLIPSIS_END = /\s*(?:\.{3,}|\u2026)\s*$/
