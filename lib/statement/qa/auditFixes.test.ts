/**
 * The pre-Analyze audit's findings, one test per issue.
 *
 * ONE FILE, NUMBERED BY FINDING, so a retest maps to a test and a regression
 * names itself: QA-001 through QA-014, in the order the audit reported them.
 * The earlier owner-reported issues live in manualQa.test.ts and keep their
 * own numbering; nothing here renumbers them.
 *
 * SCHOOLS APPEAR ONLY AS FIXTURES OR AS CATALOG ROWS. No assertion in this
 * file may depend on a school name reaching an implementation — several of
 * these findings exist precisely because a surface had started to behave
 * differently for particular schools, and a test that pins a name would make
 * that permanent.
 *
 * THE CATALOG-WIDE TESTS READ THE REAL CATALOG. A finding of the form "58 of
 * 79 documents show X" cannot be retested on a fixture: the fixture is the
 * thing that passed while production did not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  NO_CONSTRAINTS, characterLimit, hasStructuredLengthBound, pageLimit, wordLimit,
  type Constraints,
} from '../requirements/constraints.ts'
import {
  labelledConstraints, liveCountLabel, liveCountVerdict, statedAsQuote, statedWordings,
  unenforcedLengthNotice,
} from '../requirements/constraintText.ts'
import { checklistView, type RequirementCard } from '../requirements/checklistView.ts'
import {
  activatableForApplicants, evidenceKindFrom, evidenceNotice, textAttribution,
  type Verification,
} from '../requirements/verification.ts'
import { loadLocalReviewCatalog } from '../requirements/localReviewCatalog.ts'
import { resolveRequirementCapabilities } from '../layout/capabilities.ts'
import { wordLimitLabel } from '../draft/picker.ts'
import {
  draftStateMatches, saveFailedOnExpiredSession, statementSaveRequest,
} from '../draft/editor.ts'
import { SAVE_MESSAGES } from '../draft/save.ts'
import {
  EXPANDED_SAVED_CHARS, MAX_SAVED_CHARS, ceilingFromServer, maxSavedChars,
} from '../extract/limits.ts'
import { constrainDocument, essayToDoc } from '../layout/plainText.ts'
import { documentWasEdited } from '../draft/editor.ts'

const e = 'enforced' as const

/**
 * Every document an applicant can actually reach, from the real catalog.
 *
 * ACTIVATABLE ONLY, by the same test the product applies, so these are the
 * rows a signed-in applicant sees and not the whole table.
 */
const CATALOG = loadLocalReviewCatalog()
const LIVE_SETS = (CATALOG?.sets ?? []).filter((set) => activatableForApplicants(set.verification))
const LIVE_CARDS: readonly { school: string; card: RequirementCard; constraints: Constraints }[] =
  LIVE_SETS.flatMap((set) => {
    const view = checklistView({ set, drafts: [] })
    const cards = view.rows.flatMap((row) => row.kind === 'document' ? [row.card] : row.options)
    return cards.map((card) => ({
      school: set.schoolName,
      card,
      constraints: set.requirements.find((r) => r.id === card.requirementId)!.constraints,
    }))
  })

test('the catalog loaded, so every catalog-wide test below is real', () => {
  // WITHOUT THIS THE FILE PASSES VACUOUSLY. A missing payload would make every
  // `for (const … of LIVE_CARDS)` a no-op and report nine green findings.
  assert.ok(CATALOG !== null, 'the local review catalog must load')
  assert.ok(LIVE_CARDS.length >= 70, `only ${LIVE_CARDS.length} documents reachable`)
})

// ===========================================================================
// QA-001 — an approved submission was described as an official source
// ===========================================================================

const verified = (over: Partial<Verification> = {}): Verification => ({
  status: 'verified',
  sourceUrl: 'https://example.edu/admissions',
  verifiedOn: '2026-10-01',
  verbatim: true,
  evidenceKind: 'published-source',
  ...over,
} as Verification)

test('QA-001 an admin-approved submission is NEVER called an official source', () => {
  /*
   * The finding: a set published from an applicant's submission rendered
   * "Confirmed against the school's published materials" and "Quoted from the
   * school's application materials". Nobody had looked at the school's page.
   */
  const submission = verified({ evidenceKind: 'admin-approved-submission' })
  for (const sentence of [textAttribution(submission), evidenceNotice(submission) ?? '']) {
    assert.doesNotMatch(sentence, /Confirmed against the school/i)
    assert.doesNotMatch(sentence, /Quoted from the school/i)
    assert.doesNotMatch(sentence, /published materials/i)
  }
  // AND IT SAYS WHAT IT IS INSTEAD, including that nobody checked the page.
  assert.match(textAttribution(submission), /approved by CRNAPREPHUB/i)
  assert.match(textAttribution(submission), /[Nn]ot checked against the school/)
  assert.match(evidenceNotice(submission)!, /submitted by an applicant/i)
})

test('QA-001 a published source still gets the sentence it earned', () => {
  // The fix must not flatten everything into a warning: a row verified against
  // the school's own page is the case the reassurance was written for.
  const published = verified()
  assert.match(textAttribution(published), /Quoted from the school/)
  assert.equal(evidenceNotice(published), null, 'nothing to warn about')
  assert.equal(activatableForApplicants(published), true)
})

test('QA-001 and an approved submission is activatable WITHOUT a source URL', () => {
  // Which is the reason the evidence kind had to be read at all: these rows
  // have no school page to link, and gating on a URL hid them entirely.
  const submission = verified({ evidenceKind: 'admin-approved-submission', sourceUrl: null })
  assert.equal(activatableForApplicants(submission), true)
  assert.notEqual(evidenceNotice(submission), null, 'but it must carry its notice')
})

// ===========================================================================
// QA-002 — internal normalisation jargon rendered as the school's wording
// ===========================================================================

/** The normaliser's own vocabulary. None of it is any school's sentence. */
const JARGON = [
  /length used adjectivally/i, /explicit bound/i, /target marker/i,
  /implicit bound/i, /inferred from/i, /^length used/i, /^explicit /i, /^target /i,
]

test('QA-002 no school is quoted saying this product’s classification labels', () => {
  /*
   * The finding: 58 of 79 documents rendered a `*_stated_as` value under a
   * heading attributing it to the school -- 'length used adjectivally: "200
   * word limit"' and the like, nested quotes and all.
   */
  let quoting = 0
  for (const { school, card } of LIVE_CARDS) {
    for (const wording of card.statedWordings) {
      quoting++
      for (const pattern of JARGON) {
        assert.doesNotMatch(wording, pattern, `${school}: ${wording}`)
      }
    }
  }
  // AND SOMETHING SURVIVED. A fix that emptied the field would also pass the
  // loop above, so the count is asserted: genuine quotations are still shown.
  assert.ok(quoting > 0, 'every quotation was thrown away')
})

test('QA-002 a basis with no quotation yields NOTHING, not a tidied basis', () => {
  // Omitting the quote is the honest answer when the school's words were
  // never captured. Inventing one from the classification is not.
  for (const bare of [
    'length used adjectivally', 'explicit bound', 'target marker',
    'implicit bound', 'inferred from page count',
  ]) {
    assert.equal(statedAsQuote(bare), null, bare)
  }
  // A quoted figure is the school's and is kept.
  assert.equal(statedAsQuote('explicit bound: "maximum of 500 words"'),
    'maximum of 500 words')
  // A quoted fragment with no figure and almost no words is not a sentence a
  // school published -- 'target marker: "not labeled a maximum"' is the
  // researcher describing an absence.
  assert.equal(statedAsQuote('target marker: "not labeled a maximum"'), null)
})

// ===========================================================================
// QA-003 — the "you gave us this prompt" badge vanished in the editor
// ===========================================================================

const EDITOR = readFileSync(
  fileURLToPath(new URL('../../../app/statement-studio/components/StatementStudioClient.tsx',
    import.meta.url)), 'utf8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

test('QA-003 the editor knows where the prompt came from, and says so', () => {
  /*
   * The finding: the picker warned that a reported prompt was the applicant's
   * own wording, and then the editor opened the draft under the heading "Your
   * school's prompt" with no badge anywhere. The provenance survived exactly
   * as long as the dialog did.
   *
   * STRUCTURAL, because this component cannot be imported under node --test.
   * The decisions it renders are tested as logic elsewhere in this file.
   */
  assert.match(EDITOR, /promptOrigin\?: PromptOrigin \| null/, 'the origin is a prop')
  assert.match(EDITOR, /const userProvidedPrompt = promptOrigin === 'user'/)
  // THE HEADING IS THE CLAIM, so it is the thing that changes.
  assert.match(EDITOR, /userProvidedPrompt \? 'Your prompt'/)
  assert.match(EDITOR, /userProvidedPrompt && promptNotice !== null/)
  // AND THE WORD LIMIT PANEL DOES NOT CALL THE APPLICANT'S FIGURE THE SCHOOL'S.
  assert.match(EDITOR, /userProvidedPrompt \? 'Word limit you entered'/)
  assert.match(EDITOR, /wordLimitLabel\(prompt\.statedMaxWords, promptOrigin\)/)
})

// ===========================================================================
// QA-004 — the saved-draft ceiling was below what a school's own rule allows
// ===========================================================================

test('QA-004 the storage ceiling clears the largest allowance in the catalog', () => {
  /*
   * REPRODUCED BEFORE IT WAS FIXED. One school's maximum is 18,000 characters
   * EXCLUDING spaces. Prose at 18,000 characters excluding spaces stores at
   * roughly 22,000-24,000 characters including them, so a compliant essay was
   * refused by a 20,000-character column.
   *
   * The figures below are the measured fixture from that reproduction: 4,288
   * words, 18,000 characters excluding spaces, 22,287 stored.
   */
  const worstCaseStored = 22_287
  assert.ok(worstCaseStored > MAX_SAVED_CHARS,
    'the fixture must still be over the old ceiling, or it proves nothing')
  assert.ok(EXPANDED_SAVED_CHARS > worstCaseStored,
    `${EXPANDED_SAVED_CHARS} does not clear ${worstCaseStored}`)
})

test('QA-004 the ceiling is the OLD one until the migration is applied', () => {
  /*
   * THE COLUMN CONSTRAINT IS THE REAL LIMIT. Raising the number the editor
   * believes in, before 016 is applied, would move the refusal from a message
   * the applicant can act on to a 400 from PostgREST mid-save.
   */
  assert.equal(maxSavedChars({} as NodeJS.ProcessEnv), MAX_SAVED_CHARS)
  assert.equal(maxSavedChars({ STATEMENT_DRAFT_LENGTH_CEILING: 'on' } as NodeJS.ProcessEnv),
    EXPANDED_SAVED_CHARS)
  assert.equal(maxSavedChars({ NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    EXPANDED_SAVED_CHARS)
})

test('QA-004 and no character limit in the catalog exceeds what we can store', () => {
  for (const { school, constraints } of LIVE_CARDS) {
    const max = constraints.characters?.max ?? null
    if (max === null) continue
    // Worst case for prose: every word is short, so spaces are ~1 in 5
    // characters. A limit counted without spaces costs 4/3 of itself stored.
    const stored = constraints.characters?.includeSpaces === false
      ? Math.ceil(max * 4 / 3)
      : max
    assert.ok(stored <= EXPANDED_SAVED_CHARS, `${school}: needs ${stored}`)
  }
})

// ===========================================================================
// QA-005 — CORRECTED FINDING, not a fix
// ===========================================================================

test('QA-005 a target length is never labelled a maximum (the finding was wrong)', () => {
  /*
   * THE AUDIT REPORTED THIS AND THE AUDIT WAS WRONG. Checklist cards for
   * target-register documents were reported as reading "500 words maximum".
   * Read back through the product's own path they read "500 words (the stated
   * length, not a maximum)". The finding was a transcription error.
   *
   * THE TEST IS KEPT ANYWAY, pinning the behaviour that was already correct,
   * because an audit that mis-reads a screen twice is cheaper than a product
   * that starts calling targets limits.
   */
  const target = { ...NO_CONSTRAINTS, words: wordLimit({ max: 500, enforcement: 'target' }) }
  const chips = labelledConstraints(target as Constraints).map((c) => c.text)
  assert.deepEqual(chips, ['500 words (the stated length, not a maximum)'])
  for (const { school, card, constraints } of LIVE_CARDS) {
    const register = constraints.words?.enforcement ?? constraints.pages?.enforcement ?? null
    if (register !== 'target' && register !== 'suggested') continue
    for (const chip of card.constraints) {
      if (chip.kind !== 'words' && chip.kind !== 'pages' && chip.kind !== 'characters') continue
      assert.doesNotMatch(chip.text, /^\d[\d,]* \w+ maximum$/, `${school}: ${chip.text}`)
    }
  }
})

// ===========================================================================
// QA-006 — one requirement described as enforced AND as not enforced
// ===========================================================================

/** Everything a card says about a requirement, as one string. */
function cardProse(card: RequirementCard): string {
  return [
    card.constraintSummary,
    card.unenforcedLengthNotice ?? '',
    ...card.constraints.map((c) => c.text),
    ...card.statedWordings,
  ].join(' || ')
}

const DENIES_ENFORCEMENT =
  /not enforced here|nothing is checked against it|does not bound it/i

test('QA-006 the catalog no longer contains a bound beside its own prose', () => {
  /*
   * THIS ASSERTION HAS BEEN INVERTED, DELIBERATELY, AND THE OLD ONE WAS RIGHT
   * AT THE TIME.
   *
   * When QA-006 was raised, EIGHT served documents carried a structured bound
   * and the sentence saying their length was unconfirmed, and the fix was in
   * the renderer: suppress the notice, the chip and the manual item wherever a
   * bound exists. The test asserted `bound >= 8` so that the suppression had
   * something to suppress -- otherwise it would have passed on an empty loop.
   *
   * Those eight no longer exist. Migration 006 forbids the combination, which
   * made the eight corrections that would have introduced it IMPOSSIBLE to
   * apply, and the fix for that went into the pipeline:
   * scripts/statement_catalog_invariants.py now clears prose a bound has
   * superseded, and all three generators refuse to emit a row the applied
   * schema would reject.
   *
   * So the data-level assertion is now ZERO, and keeping `>= 8` would be
   * asserting that the defect is still in the catalog. The RENDERER guard is
   * still tested, on a constructed row, by the test below -- because the
   * catalog can no longer supply one.
   */
  const both = LIVE_CARDS.filter(({ constraints }) =>
    constraints.unenforcedLength !== null && hasStructuredLengthBound(constraints))
  assert.deepEqual(both.map((c) => c.school), [],
    'a served document carries a bound beside the prose it was normalised from')
})

test('QA-006 the renderer suppresses the notice even if a row arrives with both', () => {
  /*
   * THE GUARD, NOT THE DATA. The database refuses this row and the generators
   * cannot emit it -- but the catalog is not the only source of a Constraints
   * object. The New Draft dialog builds one by flattening the server's model
   * back into column names, the local simulated-live stores are plain JSON
   * with no CHECK constraints, and an administrator can type a word range and
   * a prose sentence into the same promotion form today. Any of those can
   * produce the shape in memory.
   *
   * So the renderer still has to be right about it, and that is tested here on
   * a row built for the purpose rather than found in the catalog.
   */
  const both: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ min: 500, max: 1000, enforcement: e }),
    unenforcedLength: { text: 'Roughly 500-1,000 words', verbatim: true },
  }
  assert.ok(hasStructuredLengthBound(both), 'the fixture must carry a bound')
  assert.equal(both.unenforcedLength?.text !== undefined, true,
    'and the prose beside it')

  // The notice is withheld...
  assert.equal(unenforcedLengthNotice(both), null)
  // ...the chip too, so nothing on the card denies the bound...
  const chips = labelledConstraints(both).map((c) => c.text).join(' || ')
  assert.doesNotMatch(chips, DENIES_ENFORCEMENT)
  // ...and it is not handed to the applicant as work to do by hand.
  assert.deepEqual(
    resolveRequirementCapabilities(both).manualReview
      .filter((item) => item.field === 'unenforced-length'),
    [])

  // AND THE SAME ROW WITHOUT THE BOUND KEEPS ALL THREE, which is what makes
  // this a rule about the data rather than a suppression.
  const proseOnly: Constraints = { ...both, words: null }
  assert.equal(hasStructuredLengthBound(proseOnly), false)
  assert.notEqual(unenforcedLengthNotice(proseOnly), null)
  assert.match(labelledConstraints(proseOnly).map((c) => c.text).join(' || '),
    DENIES_ENFORCEMENT)
})

test('QA-006 a length left as prose KEEPS its notice, decided by the data', () => {
  /*
   * THE OTHER HALF OF THE RULE, and the reason it is not a suppression. Three
   * documents carry prose and no bound because the source genuinely does not
   * say whether the figure is a limit. Nothing may be enforced against them
   * and the applicant has to be told so.
   *
   * NO SCHOOL IS NAMED. The split is `hasStructuredLengthBound` and nothing
   * else, which is why the count is asserted and the names are not.
   */
  let prose = 0
  for (const { school, card, constraints } of LIVE_CARDS) {
    if (constraints.unenforcedLength === null) continue
    if (hasStructuredLengthBound(constraints)) continue
    prose++
    assert.match(cardProse(card), DENIES_ENFORCEMENT, school)
  }
  assert.ok(prose >= 3, `only ${prose} prose-only documents found`)
})

// ===========================================================================
// QA-007 — a word range lost its minimum in the editor panel
// ===========================================================================

test('QA-007 a range shows BOTH bounds wherever a count is shown', () => {
  const range: Constraints = {
    ...NO_CONSTRAINTS, words: wordLimit({ min: 350, max: 500, enforcement: e }),
  }
  const label = liveCountLabel({ kind: 'words', constraints: range, words: 120, text: '' })
  assert.match(label, /350/, 'the minimum must be visible')
  assert.match(label, /500/)
  // AND THE CHIP TOO, which is the surface the audit found it missing from.
  assert.deepEqual(labelledConstraints(range).map((c) => c.text), ['350–500 words'])
})

test('QA-007 a bare maximum is still shown as one', () => {
  // The fix must not turn every limit into a range with an invented floor.
  const max: Constraints = {
    ...NO_CONSTRAINTS, words: wordLimit({ max: 500, enforcement: e }),
  }
  assert.deepEqual(labelledConstraints(max).map((c) => c.text), ['500 words maximum'])
})

// ===========================================================================
// QA-008 — a target RANGE was judged as if it were enforced
// ===========================================================================

test('QA-008 a length that is not a limit never produces an over/under verdict', () => {
  const targetRange: Constraints = {
    ...NO_CONSTRAINTS, words: wordLimit({ min: 500, max: 700, enforcement: 'target' }),
  }
  for (const words of [120, 600, 2_000]) {
    const verdict = liveCountVerdict({
      kind: 'words', constraints: targetRange, words, text: '' })
    if (verdict === null) continue
    assert.doesNotMatch(verdict, /over the maximum|under the minimum/, `${words} words`)
  }
})

test('QA-008 and an enforced range still says over and under', () => {
  const enforcedRange: Constraints = {
    ...NO_CONSTRAINTS, words: wordLimit({ min: 500, max: 700, enforcement: e }),
  }
  const at = (words: number) => liveCountVerdict({
    kind: 'words', constraints: enforcedRange, words, text: '' })
  assert.match(at(900)!, /over the maximum/)
  assert.match(at(100)!, /under the minimum/)
  assert.equal(at(600), null, 'inside the range is not a verdict')
})

// ===========================================================================
// QA-009 — the editor was unusable on a phone
// ===========================================================================

const PAGE_EDITOR = readFileSync(
  fileURLToPath(new URL('../../../app/statement-studio/components/PaginatedEditor.tsx',
    import.meta.url)), 'utf8')
const TOUCH = readFileSync(
  fileURLToPath(new URL('../../../app/statement-studio/components/touchTarget.ts',
    import.meta.url)), 'utf8')

test('QA-009 the page is NEVER made to fit the viewport', () => {
  /*
   * THE CONSTRAINT FIRST, because it rules out the obvious fix. The text
   * column is the measurement: narrow it and the same essay wraps into more
   * lines, so the page count would depend on the width of the reader's
   * device. Nothing here may make the sheet responsive.
   */
  assert.match(PAGE_EDITOR, /width: var\(--page-width\)/)
  assert.match(PAGE_EDITOR, /overflow-x: auto/)
  // NO BREAKPOINT ON THE PAPER OR ITS COLUMN, and no transform scaling it --
  // getBoundingClientRect is what the gap measurement reads, so a scale would
  // corrupt the page count rather than merely shrink the view.
  const sheet = PAGE_EDITOR.slice(PAGE_EDITOR.indexOf('.statement-page-sheet'))
  const surface = sheet.slice(0, sheet.indexOf('.statement-page-break'))
  assert.doesNotMatch(surface, /@media[^{]*max-width/)
  assert.doesNotMatch(surface, /transform:\s*scale/)
  assert.doesNotMatch(surface, /zoom:/)
})

test('QA-009 and the reader is told so at phone width', () => {
  // A page wider than the screen with no explanation is the reported bug. The
  // note is the smallest honest fix, and it is the one thing that IS
  // responsive here.
  assert.match(PAGE_EDITOR, /sm:hidden/)
  assert.match(PAGE_EDITOR, /real printed size/)
  assert.match(PAGE_EDITOR, /does not re-wrap/)
})

test('QA-009 every control a finger has to hit is at least 44px', () => {
  /*
   * ONE CONSTANT, ASSERTED AS THE THING IN USE. The Bold button was 32 x 32,
   * the Draft/Complete toggle about 26 high and the font select smaller
   * again. `min-h-11` is 44px in this Tailwind scale.
   */
  assert.match(TOUCH, /export const TOUCH_TARGET = 'min-h-11 sm:min-h-0'/)
  assert.match(TOUCH, /TOUCH_TARGET_SQUARE = 'min-h-11 min-w-11 sm:min-h-0 sm:min-w-0'/)
  // The toolbar's two controls use it, and the row wraps rather than squashing.
  assert.match(PAGE_EDITOR, /\$\{TOUCH_TARGET_SQUARE\}/)
  assert.match(PAGE_EDITOR, /\$\{TOUCH_TARGET\}/)
  assert.match(PAGE_EDITOR, /flex w-full max-w-\[8\.5in\] flex-wrap/)
  // AND NOTHING IS LEFT AT THE OLD SIZE. h-8/w-8 survives only behind sm:.
  assert.doesNotMatch(PAGE_EDITOR, /className=\{`h-8 w-8/)
  // The editor shell's own controls carry the same floor.
  const shell = EDITOR.match(/\$\{TOUCH_TARGET\}/g) ?? []
  assert.ok(shell.length >= 7, `only ${shell.length} controls carry the floor`)
})

// ===========================================================================
// QA-011 — opening a draft saved it
// ===========================================================================

test('QA-011 the editor arriving is not an edit', () => {
  /*
   * REPRODUCED BEFORE IT WAS FIXED, in two shapes.
   *
   * A DRAFT WITH NO STORED DOCUMENT -- every newly created one -- had the
   * editor build a document out of its essay and emit it. Compared as bytes
   * against null that is a change, so opening a draft saved it: the revision
   * moved, `updated_at` moved, and a draft the applicant only looked at rose
   * to the top of their library as recently edited.
   */
  const essay = 'My path to anesthesia began in the ICU.\n\nI learned to titrate.'
  const asDocument = constrainDocument(essayToDoc(essay))
  assert.equal(documentWasEdited({ before: null, after: asDocument, essay }), false)

  /*
   * A STORED DOCUMENT THAT DIFFERS ONLY IN SHAPE. ProseMirror writes an empty
   * paragraph as `content: []` where the constrainer omits the key, and
   * splits runs with identical marks. Byte comparison called those edits too,
   * so reopening a formatted draft saved it as well.
   */
  const incidental = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'One.' }] },
      { type: 'paragraph', content: [] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'Two ' }, { type: 'text', text: 'and three.' }] },
    ],
  }
  assert.equal(documentWasEdited({
    before: incidental, after: constrainDocument(incidental), essay }), false)
})

test('QA-011 and a real edit still saves', () => {
  /*
   * THE OTHER HALF, and the reason the comparison is canonical rather than
   * simply permissive. A first bold on a draft that has never been formatted
   * must save, which means the baseline for a null document has to be the
   * document the ESSAY implies -- not "anything" and not "nothing".
   */
  const essay = 'My path to anesthesia began in the ICU.'
  const plain = constrainDocument(essayToDoc(essay))
  const bolded = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'My path to anesthesia began in the ' },
      { type: 'text', text: 'ICU.', marks: [{ type: 'bold' }] },
    ] }],
  }
  assert.equal(documentWasEdited({ before: null, after: bolded, essay }), true)
  assert.equal(documentWasEdited({ before: bolded, after: plain, essay }), true,
    'un-bolding is an edit too')
  assert.equal(documentWasEdited({
    before: plain, after: essayToDoc(`${essay} More.`), essay }), true)
})

test('QA-011 the component asks ONE question, centrally', () => {
  /*
   * This used to assert a guard inside onDocumentChange. That guard was right
   * and insufficient: six other handlers dispatched unconditionally, so create,
   * reopen and refresh all still saved. The comparison moved into markEdited,
   * which every handler now calls -- see the test below it.
   */
  assert.match(EDITOR, /markEdited\(\)/)
  // AND THE REF STILL TAKES THE DOCUMENT, so the next real save carries it
  // whether or not this emission counted as an edit.
  const handler = EDITOR.slice(EDITOR.indexOf('const onDocumentChange'))
  const body = handler.slice(0, handler.indexOf('const onFontChange'))
  assert.ok(body.indexOf('documentRef.current = next') < body.indexOf('markEdited()'),
    'the document must be recorded before the edit question is asked')
})

// ===========================================================================
// QA-012 — a missing local key cost seconds and production egress
// ===========================================================================

test('QA-012 the participants route checks its key before reading anything', () => {
  /*
   * The finding: in local development SUPABASE_SERVICE_ROLE_KEY is routinely
   * absent, and the check for it sat after two paging steps -- so every inbox
   * refresh read every thread, every participant row and every message body,
   * around 37 Supabase requests against PRODUCTION, then returned 500 and
   * threw all of it away. Four to eight seconds, repeatedly, for nothing.
   *
   * ASSERTED AS AN ORDERING, which is the rule. The route cannot answer
   * without the key, so nothing may be read before the key is known to exist.
   */
  const route = readFileSync(
    fileURLToPath(new URL('../../../app/api/messages/participants/route.ts',
      import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  const guard = route.indexOf('SUPABASE_SERVICE_ROLE_KEY')
  const firstRead = route.indexOf('.from(')
  assert.ok(guard > 0 && firstRead > 0)
  assert.ok(guard < firstRead, 'the key must be checked before the first read')
  // AND THE PRIVILEGE ORDER IS UNCHANGED: the service role is still used only
  // after the caller-scoped reads have bounded what it may resolve.
  assert.ok(route.indexOf('adminClient') > firstRead)
})

// ===========================================================================
// QA-010 — a manual requirement rendered twice on one card
// ===========================================================================

test('QA-010 no requirement appears twice on a card', () => {
  /*
   * The finding: an outlined chip reading "APA citation and reference
   * formatting" with "Check in your final document: APA citation and
   * reference formatting" directly underneath. Eleven cards did this.
   *
   * ASSERTED AS THE RULE, not as the absence of one sentence: no text a card
   * shows for one requirement may appear in another thing the same card shows.
   */
  for (const { school, card } of LIVE_CARDS) {
    const chips = card.constraints.map((c) => c.text.trim()).filter((t) => t.length > 0)
    assert.equal(new Set(chips).size, chips.length, `${school}: a chip is repeated`)
    for (const chip of chips) {
      const others = chips.filter((other) => other !== chip)
      for (const other of others) {
        assert.ok(!other.includes(chip), `${school}: "${chip}" is inside "${other}"`)
      }
    }
  }
})

test('QA-010 every manual requirement is still SHOWN, in its own register', () => {
  /*
   * The other half: removing the sentence must not remove the fact. Every
   * item the resolver calls manual is a chip in the 'manual' register, so the
   * group label covers it, and the two registers the Studio handles itself are
   * distinguishable from it.
   */
  let manual = 0
  for (const { school, card, constraints } of LIVE_CARDS) {
    const items = resolveRequirementCapabilities(constraints).manualReview
    for (const item of items) {
      if (item.field === 'font-family') continue
      manual++
      const chip = card.constraints.find((c) => c.text.includes(item.label))
      assert.ok(chip !== undefined, `${school}: "${item.label}" is on no chip`)
      assert.equal(chip!.register, 'manual', `${school}: ${item.label}`)
    }
    for (const chip of card.constraints) {
      assert.ok(['counted', 'applied', 'manual'].includes(chip.register), chip.register)
    }
  }
  assert.ok(manual >= 10, `only ${manual} manual requirements found`)
})

test('QA-010 a spacing or a type size the Studio APPLIES is not the applicant’s job', () => {
  /*
   * The boolean this replaced put "12-point Times New Roman" in the same
   * register as "AMA format", so eleven documents told applicants to apply a
   * type size the Studio typesets for them.
   */
  const typeset: Constraints = {
    ...NO_CONSTRAINTS,
    pages: pageLimit({ max: 2, spacing: 'double', enforcement: e }),
    typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: 1 },
  }
  const byKind = new Map(labelledConstraints(typeset).map((c) => [c.kind, c.register]))
  assert.equal(byKind.get('pages'), 'counted', 'the page count is measured')
  assert.equal(byKind.get('font'), 'applied', 'a font we ship is typeset, not homework')
  assert.equal(byKind.get('margins'), 'applied')
  assert.deepEqual(resolveRequirementCapabilities(typeset).manualReview, [])

  // A SPACING WITH NO PAGE COUNT IS ITS OWN CHIP, and still ours to apply.
  const spacingOnly: Constraints = {
    ...NO_CONSTRAINTS, pages: pageLimit({ spacing: 'double', enforcement: e }),
  }
  assert.deepEqual(
    labelledConstraints(spacingOnly).map((c) => [c.kind, c.register]),
    [['spacing', 'applied']])
})

// ===========================================================================
// QA-013 — an expired session was reported as a deleted draft
// ===========================================================================

test('QA-013 "deleted" is never said for a save that failed on an expired session', () => {
  /*
   * The finding: once the browser session expired every Studio API returned
   * the privacy-preserving 404, and the editor told the applicant their draft
   * "no longer exists" -- about a draft that was fine.
   *
   * THE SERVER STILL RETURNS 404. Distinguishing the two cases on the server
   * would mean telling an unauthenticated caller whether a draft id exists.
   * The distinction is made on the client, from its own session.
   */
  assert.equal(saveFailedOnExpiredSession({
    status: 'error', error: SAVE_MESSAGES.expired,
  } as never), true)
  assert.equal(saveFailedOnExpiredSession({
    status: 'error', error: SAVE_MESSAGES.missing,
  } as never), false)
  // A CONFLICT IS NOT AN EXPIRY, whatever it carries.
  assert.equal(saveFailedOnExpiredSession({
    status: 'conflict', error: SAVE_MESSAGES.expired,
  } as never), false)
  // And the two messages say different things to the applicant.
  assert.notEqual(SAVE_MESSAGES.expired, SAVE_MESSAGES.missing)
  assert.doesNotMatch(SAVE_MESSAGES.expired, /deleted|no longer exists/i)
})

// ===========================================================================
// QA-014 — an applicant's own figure attributed to their school
// ===========================================================================

test('QA-014 a limit the applicant typed is never "as stated by the school"', () => {
  const mine = wordLimitLabel(500, 'user')
  assert.doesNotMatch(mine, /as stated by the school/i)
  assert.doesNotMatch(mine, /maximum, as stated/i)
  assert.match(mine, /as you entered it/i)
  assert.match(mine, /has not checked/i)
  // A CATALOG PROMPT KEEPS THE ATTRIBUTION IT EARNED.
  assert.match(wordLimitLabel(500, 'catalog'), /as stated by the school/i)
  // And no limit at all is still no limit, whoever the prompt came from.
  for (const origin of ['user', 'catalog', null] as const) {
    assert.equal(wordLimitLabel(null, origin), 'No stated word limit.')
  }
})

// ===========================================================================
// The browser-audit round: what the first fix missed
// ===========================================================================

test('QA-001 no parser may turn an approved submission into an official source', () => {
  /*
   * THE BROWSER PROOF. The API returned `admin-approved-submission` for
   * AdventHealth, the view layer renders it correctly, and the client's own
   * parser overwrote it one hop earlier with the literal 'official-source' --
   * so an applicant's approved submission was presented as "Confirmed against
   * the school's published materials".
   *
   * ASSERTED ON THE PARSERS THEMSELVES, because the bug was never in the
   * sentence: it was in what the sentence was handed.
   */
  for (const kind of ['admin-approved-submission', 'official-source', null, undefined, 'nonsense']) {
    const parsed = evidenceKindFrom(kind)
    if (kind === 'admin-approved-submission') {
      assert.equal(parsed, 'admin-approved-submission', 'the one value that must survive')
    } else {
      assert.equal(parsed, 'official-source', String(kind))
    }
  }
  // AND NO MODULE IN THE FLOW MAY WRITE THE LITERAL as a parsed value.
  for (const rel of [
    '../requirements/newDraftFlow.ts',
    '../requirements/snapshot.ts',
    '../requirements/provenance.ts',
  ]) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    const literals = (src.match(/evidenceKind: 'official-source'/g) ?? []).length
    const parsed = (src.match(/evidenceKind: evidenceKindFrom\(/g) ?? []).length
    assert.ok(parsed >= 1, `${rel} parses no evidence kind`)
    // provenance.ts keeps exactly one, in a value that is hashed and never
    // shown; its own comment says so. Nothing else may keep any.
    const allowed = rel.endsWith('provenance.ts') ? 1 : 0
    assert.equal(literals, allowed, `${rel} still hard-codes ${literals}`)
  }
})

test('QA-001 the AdventHealth shape renders the submission sentence end to end', () => {
  // The real evidence shape: verified, verbatim, approved from a submission,
  // and WITHOUT a source URL -- those rows have no school page to link.
  const submission: Verification = {
    status: 'verified', sourceUrl: null, verifiedOn: '2026-10-12',
    verbatim: true, evidenceKind: 'admin-approved-submission',
  }
  const set = {
    id: 's', schoolId: 'x', schoolName: 'Example University', applicationCycle: null,
    verification: submission, originalText: 'x', notes: [],
    requirements: [{
      id: 'r', documentType: 'personal-statement' as const, label: 'Personal Statement',
      promptText: 'Why anesthesia?', components: [], constraints: NO_CONSTRAINTS,
      choiceGroup: null, optional: false, displayOrder: 0, notes: [],
    }],
  }
  const view = checklistView({ set, drafts: [] })
  for (const sentence of [view.verificationNotice ?? '', view.textAttribution]) {
    assert.doesNotMatch(sentence, /Confirmed against the school/i)
    assert.doesNotMatch(sentence, /Quoted from the school/i)
    assert.doesNotMatch(sentence, /published materials/i)
  }
  assert.match(view.textAttribution, /approved by CRNAPREPHUB/i)
  assert.match(view.verificationNotice!, /submitted by an applicant/i)
  // AND IT IS STILL ACTIVATABLE, which is why the sourceUrl is null above.
  assert.equal(activatableForApplicants(submission), true)
})

test('QA-004 the ceiling the client uses comes from the server, and fails closed', () => {
  /*
   * The browser refused 22,287 characters while the API accepted them, because
   * maxSavedChars() reads an environment the client bundle does not have. The
   * client is told the number now; this is the parser that reads it.
   */
  assert.equal(ceilingFromServer(EXPANDED_SAVED_CHARS), EXPANDED_SAVED_CHARS)
  assert.equal(ceilingFromServer(MAX_SAVED_CHARS), MAX_SAVED_CHARS)
  // EVERYTHING ELSE IS THE OLD CEILING: a client that cannot read the
  // capability refuses MORE than the server would, never less.
  for (const bad of [
    undefined, null, 'ninety', NaN, Infinity, -1, 0, 19_999, 30_001, 1e9, 25_000.5, {}, [],
  ]) {
    assert.equal(ceilingFromServer(bad), MAX_SAVED_CHARS, String(bad))
  }
  // A value between the two is honoured: a future ceiling need not be exact.
  assert.equal(ceilingFromServer(25_000), 25_000)
})

test('QA-004 the editor refuses at the ceiling it was given, not at its own', () => {
  const long = 'a'.repeat(22_287)
  const atOld = statementSaveRequest({ title: 'T', essay: long, revision: 1 })
  assert.equal(atOld.ok, false, 'the default is still the conservative one')
  const told = statementSaveRequest({
    title: 'T', essay: long, revision: 1, savedCharacterCeiling: EXPANDED_SAVED_CHARS,
  })
  assert.equal(told.ok, true, 'told the real ceiling, it sends the essay')
  const over = statementSaveRequest({
    title: 'T', essay: 'a'.repeat(30_001), revision: 1,
    savedCharacterCeiling: EXPANDED_SAVED_CHARS,
  })
  assert.equal(over.ok, false)
  assert.match((over as { message: string }).message, /30,000 characters/)
})

test('QA-011 a draft that matches what is stored is not an edit', () => {
  /*
   * ONE COMPARISON FOR SEVEN DISPATCHERS. Create, reopen and refresh each
   * advanced the revision with nothing typed, because every handler dispatched
   * the engine's `edited` event unconditionally.
   */
  const essay = 'My path to anesthesia began in the ICU.'
  const stored = { title: 'T', essay, document: null, font: null }
  // THE EDITOR ARRIVING: it materialises the essay as a document.
  assert.equal(draftStateMatches(stored, {
    ...stored, document: constrainDocument(essayToDoc(essay)),
  }), true)
  // A STORED DOCUMENT RE-EMITTED in ProseMirror's own shape.
  const shaped = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'One.' }] },
    { type: 'paragraph', content: [] },
  ] }
  assert.equal(draftStateMatches(
    { title: 'T', essay: 'One.\n', document: shaped, font: null },
    { title: 'T', essay: 'One.\n', document: constrainDocument(shaped), font: null },
  ), true)
  // AND THE FONT CONTROL REPORTING THE FACE IT RESOLVED, unchanged.
  assert.equal(draftStateMatches(
    { ...stored, font: 'tinos' }, { ...stored, font: 'tinos' }), true)
})

test('QA-011 and every real edit still is one', () => {
  const essay = 'My path to anesthesia began in the ICU.'
  const stored = { title: 'T', essay, document: null, font: null }
  const bolded = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'My path to anesthesia began in the ' },
    { type: 'text', text: 'ICU.', marks: [{ type: 'bold' }] },
  ] }] }
  assert.equal(draftStateMatches(stored, { ...stored, essay: `${essay} More.` }), false, 'typing')
  assert.equal(draftStateMatches(stored, { ...stored, document: bolded }), false, 'bold')
  assert.equal(draftStateMatches(stored, { ...stored, font: 'arimo' }), false, 'font')
  assert.equal(draftStateMatches(stored, { ...stored, title: 'New' }), false, 'title')
  // Un-bolding back to plain is an edit too.
  assert.equal(draftStateMatches(
    { ...stored, document: bolded },
    { ...stored, document: constrainDocument(essayToDoc(essay)) }), false)
})

test('QA-011 the component has ONE place a draft becomes dirty', () => {
  // Seven dispatchers became one, so there is one thing to get right.
  assert.match(EDITOR, /const markEdited = useCallback/)
  assert.match(EDITOR, /if \(draftStateMatches\(persistedRef\.current, proposed\)\) return/)
  const dispatches = (EDITOR.match(/type: 'edited', at: Date\.now\(\)/g) ?? []).length
  assert.equal(dispatches, 1, `${dispatches} direct dispatches remain`)
  // AND THE BASELINE ADVANCES ONLY ON A CONFIRMED SAVE.
  assert.match(EDITOR, /persistedRef\.current = \{/)
  assert.match(EDITOR, /event\.type === 'save-succeeded'/)
})
