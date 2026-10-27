import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * STRUCTURAL SOURCE ASSERTIONS, for the reason the rest of this repository uses
 * them: a component importing next/navigation cannot be imported under
 * `node --test`, so its markup is checked by reading it as text. The decisions
 * worth testing at runtime were deliberately moved into checklistView.ts and
 * are tested there; what is left here is "does the markup render what it was
 * given, and does it render nothing it was not".
 *
 * COMMENTS ARE STRIPPED FIRST. These files explain at length what they do NOT
 * do -- "no fetch, no draft, no model call", "never converts a page count" --
 * and a naive grep would match that prose and report the opposite of the truth.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/**
 * THE REPOSITORY'S OWN STRIPPER, copied from editor.test.ts rather than
 * reinvented. The `{` and the `/*` must be ADJACENT: a version that allowed
 * whitespace between them matched from `interface ChecklistActions {` -- whose
 * body opens with a doc comment -- all the way to a later `*\/}` in the markup,
 * silently deleting a third of the file and passing every absence assertion.
 */
const stripComments = (source: string) => source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

const CHECKLIST_RAW = read('../../../app/statement-studio/components/RequirementChecklist.tsx')
const PREVIEW_RAW = read('../../../app/statement-studio/components/RequirementPreview.tsx')
const EDITOR_RAW = read('../../../app/statement-studio/components/StatementStudioClient.tsx')
const LIBRARY_RAW = read('../../../app/statement-studio/components/LibraryClient.tsx')
const CHIPS_RAW = read('../../../app/statement-studio/components/constraintChips.tsx')
const LIBRARY_PAGE_RAW = read('../../../app/statement-studio/page.tsx')
const EDITOR_PAGE_RAW = read('../../../app/statement-studio/[id]/page.tsx')

const CHECKLIST = stripComments(CHECKLIST_RAW)
const PREVIEW = stripComments(PREVIEW_RAW)
const EDITOR = stripComments(EDITOR_RAW)
const LIBRARY = stripComments(LIBRARY_RAW)
const CHIPS = stripComments(CHIPS_RAW)

// ===================================================== the checklist

test('the checklist makes NO decisions of its own', () => {
  // It renders a ChecklistView. It does not re-derive which card is started,
  // what a limit says, or how many are required -- those are tested at runtime.
  assert.doesNotMatch(CHECKLIST, /constraintLines|eligibilityFor|checklistView\(/)
  assert.doesNotMatch(CHECKLIST, /\.filter\(\(row\)/)
  assert.match(CHECKLIST, /progressLabel\(view\)/)
})

test('the checklist FETCHES NOTHING and creates nothing itself', () => {
  assert.doesNotMatch(CHECKLIST, /fetch\(|useEffect|router\.|\.push\(/)
  // Starting a draft is the parent's job, handed in as a callback.
  assert.match(CHECKLIST, /actions\.onStart\(card\.requirementId\)/)
})

test('a started card offers Continue and an unstarted one offers Start', () => {
  assert.match(CHECKLIST, /card\.started === null \?/)
  // THE LABELS ARE NOW CONDITIONAL, because the development preview's controls
  // create nothing and must not read as the applicant-facing action.
  assert.match(CHECKLIST, /\? 'Start \(preview only\)' : 'Start'/)
  assert.match(CHECKLIST, />\s*Continue\s*</, 'the real card still links')
  assert.match(CHECKLIST, /Continue \(preview only\)/)
})

test('QA-010 THREE REGISTERS RENDER DIFFERENTLY, AND THE MANUAL ONES ARE LABELLED', () => {
  /*
   * The visual rule, now in the one component both surfaces use. A boolean
   * gave two styles for three outcomes, so a type size the Studio typesets
   * looked exactly like a citation style it cannot touch -- and the only thing
   * telling them apart was the sentence that duplicated the chips.
   *
   * KEYED OFF `register` AND NOTHING ELSE. No kind, no school, no field name.
   */
  assert.match(CHIPS, /CHIP_CLASS\[limit\.register\]/)
  for (const register of ['counted:', 'applied:', 'manual:']) {
    assert.ok(CHIPS.includes(register), register)
  }
  assert.match(CHIPS, /bg-slate-900/, 'solid chip for a watched number')
  assert.match(CHIPS, /bg-slate-100/, 'soft chip for something we apply')
  assert.match(CHIPS, /border border-slate-300/, 'outlined chip for the applicant')
  // The group, and a label that names no requirement.
  assert.match(CHIPS, /register !== 'manual'/)
  assert.match(CHIPS, /register === 'manual'/)
  assert.match(CHIPS, /MANUAL_GROUP_LABEL/)
  assert.doesNotMatch(CHIPS, /Check in your final document/)
})

test('QA-010 THE CARD STATES EACH REQUIREMENT ONCE, AND WRITES NO COPY ITSELF', () => {
  /*
   * Two sentences have stood under these chips and both were wrong. The
   * blanket one claimed the Studio could not check pages, spacing, font or
   * margins. The narrow one that replaced it named exactly the fields a human
   * still had to handle -- which are exactly the fields the describer already
   * emitted a chip for, so every card that had the sentence printed its own
   * chips again directly underneath.
   *
   * THE CARD NOW HAS NO SENTENCE SLOT AT ALL, which is the only way the
   * duplication cannot come back: there is nowhere to put it.
   */
  assert.doesNotMatch(CHECKLIST, /manualReview/)
  assert.doesNotMatch(CHECKLIST, /Check in your final document/)
  assert.doesNotMatch(CHECKLIST, /UNMEASURED_NOTICE/)
  assert.doesNotMatch(CHECKLIST, /cannot check page count/)
  assert.doesNotMatch(CHECKLIST, /counts words and characters only/)
  // And the chips themselves come from the one shared renderer.
  assert.match(CHECKLIST, /<ConstraintChips limits=\{card\.constraints\} \/>/)
})

test('a choice renders as ONE row with nested options', () => {
  assert.match(CHECKLIST, /row\.kind === 'document'/)
  assert.match(CHECKLIST, /Choose one of these/)
  assert.match(CHECKLIST, /row\.options\.map/)
  assert.match(CHECKLIST, /Option \$\{index \+ 1\}/)
})

test('the questions are listed INSIDE the one card', () => {
  assert.match(CHECKLIST, /card\.questions\.map/)
  assert.match(CHECKLIST, /This one document must address/)
  // The optional marker exists, so omitting one does not read as a gap.
  assert.match(CHECKLIST, /question\.optional &&/)
})

test('the verification notice is ABOVE the cards', () => {
  const noticeAt = CHECKLIST.indexOf('view.verificationNotice')
  const rowsAt = CHECKLIST.indexOf('view.rows.map')
  assert.ok(noticeAt > 0 && rowsAt > 0)
  assert.ok(noticeAt < rowsAt, 'a reader must meet the warning before the requirements')
})

test('the research text is reachable and collapsed', () => {
  assert.match(CHECKLIST, /<details/)
  assert.match(CHECKLIST, /\{view\.originalText\}/)
  assert.match(CHECKLIST, /What was recorded for this school/)
})

test('model and catalog prose is rendered as ESCAPED TEXT, never as markup', () => {
  // Same rule the editor follows: there is no markdown parser in this path.
  assert.doesNotMatch(CHECKLIST, /dangerouslySetInnerHTML/)
  assert.doesNotMatch(PREVIEW, /dangerouslySetInnerHTML/)
  assert.match(CHECKLIST, /whitespace-pre-wrap/)
})

test('THE CHECKLIST NEVER CONVERTS A PAGE COUNT', () => {
  // No arithmetic on a limit anywhere in the markup.
  assert.doesNotMatch(CHECKLIST, /pages\s*\*|\*\s*pages|wordsPerPage|250|275/)
})

// ===================================================== the preview

test('THE PREVIEW CALLS NOTHING: no fetch, no model, no usage', () => {
  assert.doesNotMatch(PREVIEW, /fetch\(|analyzePath|\/api\//)
  assert.doesNotMatch(PREVIEW, /createClient|supabase/i)
  // onStart is local state and nothing else.
  assert.match(PREVIEW, /setStarted\(\(current\)/)
})

test('the preview renders through the REAL checklist component', () => {
  // The point of the preview: no second implementation to drift.
  assert.match(PREVIEW, /import RequirementChecklist from '\.\/RequirementChecklist'/)
  assert.match(PREVIEW, /checklistView\(\{ set, drafts \}\)/)
  assert.match(PREVIEW, /<RequirementChecklist/)
})

test('the preview says what it is BEFORE any requirement', () => {
  const noticeAt = PREVIEW.indexOf('FIXTURE_NOTICE')
  const checklistAt = PREVIEW.indexOf('<RequirementChecklist')
  assert.ok(noticeAt > 0 && checklistAt > 0)
  assert.ok(noticeAt < checklistAt)
  assert.match(PREVIEW, /\{FIXTURE_SOURCE\}/)
})

test('every fixture shape is reachable from the preview', () => {
  assert.match(PREVIEW, /FIXTURE_SETS\.map/)
  assert.match(PREVIEW, /aria-pressed=\{candidateIndex === index\}/)
})

test('the preview offers no real draft link', () => {
  assert.match(PREVIEW, /draftHref: \(\) => '#preview-no-draft'/)
})

// ===================================================== the gate

test('THE PREVIEW IS DECIDED ON THE SERVER, AFTER THE GATE', () => {
  const page = stripComments(LIBRARY_PAGE_RAW)
  // NODE_ENV from the process, so a deployed build cannot be addressed into it.
  assert.match(page, /nodeEnv: process\.env\.NODE_ENV/)
  assert.match(page, /isAdmin: isAdminEmail\(auth\.email\)/)
  assert.match(page, /requested: requirementsPreviewRequested\(params\[PASTE_PREVIEW_PARAM\]\)/)
  // Read AFTER the gate: the access check comes first in the file.
  assert.ok(page.indexOf('statementStudioAccess') < page.indexOf('requirementsPreview'))
})

test('the preview defaults to OFF, so production renders none', () => {
  assert.match(LIBRARY, /requirementsPreview = false/)
  // RENDERED INSTEAD OF THE LIBRARY, not beside it: the `&&` form placed it
  // as a second child of the flex root and squeezed the real content.
  // THE CONDITION WIDENED when ?preview=requirements became the real catalog
  // and ?preview=fixtures kept the shapes. The FORM is what matters here:
  // one ternary that replaces the library, never the `&&` sibling form.
  assert.match(LIBRARY, /\{requirementsPreview \|\| fixturesPreview \? \(/)
  assert.doesNotMatch(LIBRARY, /\{requirementsPreview && \(/)
})

test('the preview does not feed the rollout flag or any write path', () => {
  const page = stripComments(LIBRARY_PAGE_RAW)
  // submissionsEnabled stays the rollout flag and nothing else.
  assert.match(page, /submissionsEnabled=\{promptSubmissionsEnabled\(\)\}/)
  assert.doesNotMatch(page, /submissionsEnabled=\{requirementsPreview/)
})

// ===================================================== the editor panel

test('the editor shows the questions TOGETHER in the one prompt panel', () => {
  assert.match(EDITOR, /requirement\.components\.map/)
  assert.match(EDITOR, /This essay must address/)
  assert.match(EDITOR, /part\.optional &&/)
})

test('the editor shows the school’s own counter when it stated one', () => {
  assert.match(EDITOR, /requirementCounts\.map/)
  assert.match(EDITOR, /liveCountLabel\(\{/)
})

test('QA-010 the editor shows the SAME chips, from the same renderer, once each', () => {
  /*
   * The editor's prompt panel had its own copy of the chip markup and its own
   * copy of the restating sentence, so the duplication had to be fixed twice
   * and could drift apart in between. Both surfaces now call one component.
   */
  assert.match(EDITOR, /<ConstraintChips limits=\{requirementLimits\} \/>/)
  assert.doesNotMatch(EDITOR, /limit\.measured/)
  assert.doesNotMatch(EDITOR, /manualReview/)
  assert.doesNotMatch(EDITOR, /UNMEASURED_NOTICE/)
})

test('ONE RESOLVER DRIVES THE EDITOR, AND NO SCHOOL IS NAMED', () => {
  /*
   * The architectural constraint, asserted on the markup. The surface, the
   * page, the panel and the notice all come from resolveRequirementCapabilities
   * -- so a school that behaves unlike the others is a record, not a branch.
   */
  assert.match(EDITOR, /resolveRequirementCapabilities/)
  assert.match(EDITOR, /capabilities\.paginated/)
  const code = EDITOR.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  for (const forbidden of ['Boston', 'College']) {
    assert.equal(code.includes(forbidden), false, `the editor names ${forbidden}`)
  }
})

test('A LEGACY DRAFT KEEPS THE WORD-LIMIT LINE IT ALWAYS HAD', () => {
  // The backward-compatibility guarantee, in the markup: with no structured
  // requirement the panel renders wordLimitLabel and none of the new blocks.
  assert.match(EDITOR, /\{requirement === null && \(/)
  assert.match(EDITOR, /\{wordLimitLabel\(prompt\.statedMaxWords, promptOrigin\)\}/)
})

test('the requirement prop defaults to null', () => {
  assert.match(EDITOR, /requirement = null,/)
})

test('THE EDITOR PAGE PASSES THE STORED SNAPSHOT, NOT A PROJECTION', () => {
  const page = stripComments(EDITOR_PAGE_RAW)
  assert.match(page, /const requirement = parseRequirementSnapshot\(draft\.requirementSnapshot\)/)
  assert.match(page, /requirement=\{requirement\}/)
  // effectiveSnapshot would project an old draft's columns. It is not used.
  assert.doesNotMatch(page, /effectiveSnapshot/)
})

test('the editor still touches no draft state when rendering a requirement', () => {
  // The requirement is read-only reference data. No setter is wired to it.
  assert.doesNotMatch(EDITOR, /setRequirement|requirement =>|dispatch\(\{[^}]*requirement/)
})

test('the editor renders the requirement’s unresolved notes', () => {
  assert.match(EDITOR, /requirement\.notes\.map/)
  assert.match(EDITOR, /requirementWarning !== null &&/)
})

test('THE SIDEBAR IS NOT TOUCHED BY ANY NEW COMPONENT', () => {
  for (const [name, source] of [['checklist', CHECKLIST], ['preview', PREVIEW]] as const) {
    assert.doesNotMatch(source, /SidebarContext|useSidebarCollapsed|sidebarCollapsed/, name)
    assert.doesNotMatch(source, /lg:left-|lg:pl-6[04]|fixed inset-y/, name)
  }
})

test('THE STRIPPER DOES NOT EAT CODE', () => {
  // The bug this test file shipped with for one run: a JSX-comment regex that
  // allowed whitespace between `{` and `/*` matched from an interface body's
  // opening brace to a later `*/}` and deleted a third of the file, after
  // which every doesNotMatch assertion above passed for the wrong reason.
  for (const [name, stripped, raw] of [
    ['checklist', CHECKLIST, CHECKLIST_RAW],
    ['preview', PREVIEW, PREVIEW_RAW],
    ['editor', EDITOR, EDITOR_RAW],
    ['library', LIBRARY, LIBRARY_RAW],
  ] as const) {
    // Comments are a minority of every one of these files.
    assert.ok(stripped.length > raw.length * 0.5,
      `${name}: stripping removed ${raw.length - stripped.length} of ${raw.length} characters`)
  }
  // And the specific identifiers the assertions above depend on survive.
  for (const needle of ['function LimitChips', 'ConstraintChips', 'actions.onStart']) {
    assert.ok(CHECKLIST.includes(needle), needle)
  }
  assert.ok(CHIPS.includes('CHIP_CLASS'))
  assert.ok(CHIPS.length > CHIPS_RAW.length * 0.3,
    `chips: stripping removed ${CHIPS_RAW.length - CHIPS.length} of ${CHIPS_RAW.length}`)
  assert.ok(EDITOR.includes('ConstraintChips'))
  assert.ok(PREVIEW.includes('RequirementChecklist'))
})

// ===========================================================================
// THE LENGTH REGISTER IN THE EDITOR
// ===========================================================================
// STRUCTURAL ASSERTIONS, BY THE HOUSE CONVENTION. next/navigation and
// next/headers do not resolve under `node --test`, so this component cannot be
// rendered here. These read the source with comments stripped, exactly as the
// existing assertions in this file do.
//
// AND THE PANEL CANNOT BE EXERCISED IN A BROWSER EITHER, which is why the
// structural check carries the weight. It renders only for a requirement-backed
// draft, and that needs 20261002_005 and _006 applied, STATEMENT_REQUIREMENTS
// set, and a catalog row -- none of which exists.

test('THE EDITOR SHOWS THE REGISTER NOTICE, NOT JUST THE NUMBER', () => {
  // "250 words suggested" next to a counter is, at a glance, a number next to a
  // counter. The sentence is what stops an applicant cutting an essay to it.
  assert.match(EDITOR, /hasAdvisoryLength\(requirement\.constraints\)/)
  assert.match(EDITOR, /\{requirementAdvisory && requirementUnenforcedNotice === null && \(/)
  assert.match(EDITOR, /\{ADVISORY_LENGTH_NOTICE\}/)
})

test('AN UNENFORCED LENGTH GETS ITS OWN NOTICE, AND REPLACES THE GENERIC ONE', () => {
  // THE MORE SPECIFIC STATEMENT WINS. "Some of this school's lengths are
  // guidance" and "this school publishes a length but does not say whether it
  // is a maximum" are both true for an Option A document, and showing both
  // would be two paragraphs saying one thing. The second answers the question
  // the applicant actually has: why is nothing counting this?
  assert.match(EDITOR, /unenforcedLengthNotice\(requirement\.constraints\)/)
  assert.match(EDITOR, /\{requirementUnenforcedNotice !== null && \(/)
  assert.match(EDITOR, /\{requirementUnenforcedNotice\}/)
  // The generic one stands down rather than stacking.
  assert.match(EDITOR, /requirementAdvisory && requirementUnenforcedNotice === null/)
  // AND THE NOTICE IS CHOSEN BY THE HELPER, not by the component -- so a
  // summary can never be given the quotation notice by a JSX edit.
  assert.doesNotMatch(EDITOR, /UNENFORCED_LENGTH_NOTICE\b/,
    'the component must not hard-code one of the two notices')
})

test('THE SCHOOL’S OWN SENTENCE IS RENDERED, NOT JUST THE CLASSIFICATION', () => {
  assert.match(EDITOR, /statedWordings\(requirement\.constraints\)/)
  assert.match(EDITOR, /requirementWordings\.length > 0/)
  assert.match(EDITOR, /requirementWordings\.map\(/)
})

test('THE TRUNCATION POLICY IS RENDERED AS THE SCHOOL’S POLICY', () => {
  assert.match(EDITOR, /truncationNotice\(requirement\.constraints\)/)
  assert.match(EDITOR, /\{requirementTruncation !== null && \(/)
  // IT IS NOT COMPARED AGAINST THE DRAFT ANYWHERE in this component: no
  // arithmetic on a page count, because there is none to do.
  assert.doesNotMatch(EDITOR, /requirementTruncation.*words|pages.*>.*words/)
})

test('EVERY NEW PANEL IS INSIDE THE requirement !== null BRANCH', () => {
  // A length register belongs to a structured requirement. A legacy draft has
  // none, and its single length line is unchanged -- that line is what every
  // such draft has shown since the feature shipped.
  assert.match(EDITOR, /\{requirement === null && \(/)
  assert.match(EDITOR, /\{wordLimitLabel\(prompt\.statedMaxWords, promptOrigin\)\}/)
  for (const guard of ['requirementAdvisory', 'requirementTruncation',
    'requirementUnenforcedNotice']) {
    const derivation = new RegExp(
      `const ${guard} = requirement (?:===|!==) null\\s*\\n?\\s*[?&]`)
    assert.match(EDITOR, derivation, guard)
  }
  assert.match(EDITOR,
    /const requirementWordings = requirement === null \? \[\] : statedWordings\(/)
  // AND IT TAKES NO CLAIM OF STANDING OFF THE SNAPSHOT. The applicant holds
  // UPDATE on their own row, so `verification` decides nothing here; the
  // summary-versus-quotation distinction comes from a field the digest covers
  // and provenance authenticates. access.test.ts pins the wider rule.
  assert.doesNotMatch(EDITOR, /requirement\.verification/)
})

test('THE EDITOR STILL CONVERTS NO UNIT', () => {
  // The guard that matters most, re-checked after adding three length panels.
  assert.doesNotMatch(EDITOR, /wordsPerPage|charsPerWord|WORDS_PER_|PER_PAGE/i)
  assert.doesNotMatch(EDITOR, /about \$\{[^}]*\} words|roughly \$\{/i)
})

test('THE STORAGE CEILING IS LABELLED AS A CEILING, not as "characters"', () => {
  // TWO CHARACTER COUNTS SIT IN THE SAME ROW for a character-limited school:
  // the school's (UT Knoxville's, excluding spaces) and this editor's storage
  // ceiling (including them). Both previously ended in the bare word
  // "characters", which is the unexplained number this row exists to avoid.
  // READ THROUGH maxSavedChars(), not the constant: the ceiling moves with
  // migration 016, and the label must show whatever the database enforces.
  assert.match(EDITOR, /savedCeiling\.toLocaleString\('en-US'\)\} characters stored/)
  assert.match(EDITOR, /this editor’s own limit, spaces included/)
  // AND THE CLARIFICATION ONLY APPEARS WHERE IT IS NEEDED -- beside a character
  // counter, not on every draft in the product.
  assert.match(EDITOR, /requirementCounts\.includes\('characters'\)/)
})

test('THE SCHOOL’S COUNTER COMES FROM liveCountLabel, which carries its own rule', () => {
  // The editor never formats a character count itself; if it did, the
  // "excluding spaces" rule could drift out of the label.
  assert.match(EDITOR, /\{liveCountLabel\(\{/)
  assert.match(EDITOR, /kind, constraints: requirement\.constraints, words, text: essay,/)
  // No hand-rolled character arithmetic against a requirement anywhere.
  assert.doesNotMatch(EDITOR, /replace\(\/\\s\+\/g, ''\)/)
  /*
   * THE CANONICAL COUNTER MAY BE CALLED; A SECOND ONE MAY NOT.
   *
   * This used to forbid characterCount() outright, as a proxy for "no
   * hand-rolled arithmetic". The compliance panel needs a measured count, and
   * the right way to get one is the function that already carries the spaces
   * rule -- calling it is the opposite of hand-rolling. What WOULD reintroduce
   * the drift is calling it without the school's own flag, so that is what is
   * forbidden now.
   */
  for (const call of EDITOR.match(/characterCount\([\s\S]{0,160}?\)/g) ?? []) {
    assert.match(call, /spacesCount/, `characterCount without the flag: ${call}`)
  }
  // And it still never FORMATS the counter: that is liveCountLabel's job.
  assert.doesNotMatch(EDITOR, /\$\{characterCount\(/)
})
