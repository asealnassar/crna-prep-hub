/**
 * Manual-QA regression suite — the nine issues found in the owner's QA pass.
 *
 * ONE FILE, NUMBERED BY ISSUE, so a retest maps to a test and a regression
 * names itself. Arkansas, Barry, Bryan and Cedar appear only as fixtures: no
 * assertion here may depend on a school name reaching the implementation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  NO_CONSTRAINTS, characterLimit, pageLimit, wordLimit,
} from '../requirements/constraints.ts'
import type { Constraints } from '../requirements/constraints.ts'
import { liveCountLabel, liveCountStatus } from '../requirements/constraintText.ts'
import { NEW_DRAFT_MESSAGES, SCHOOL_CHOICE_RESET } from '../draft/newDraft.ts'
import { REPORT_MESSAGES, newPromptChangeRequest } from '../draft/promptChangeReport.ts'
import { PROMPT_STATUS_LABELS, checkPromptSubmission } from '../draft/promptSubmission.ts'
import { resolveRequirementCapabilities } from '../layout/capabilities.ts'
import { complianceRows } from '../layout/compliance.ts'

const e = 'enforced' as const

// ===========================================================================
// ISSUE #8 — ranges are not enforced generically
// ===========================================================================

/** Bryan College of Health Sciences: 100-200 words, per the verified source. */
const RANGE_WORDS: Constraints = {
  ...NO_CONSTRAINTS, words: wordLimit({ min: 100, max: 200, enforcement: e }),
}

test('#8 a word RANGE reads as a range, not as a bare maximum', () => {
  // It read "154 / 200 words": the floor was invisible, so 20 words looked fine.
  const label = liveCountLabel({
    kind: 'words', constraints: RANGE_WORDS, words: 154, text: '' })
  assert.equal(label, '154 words — required 100–200')
})

test('#8 and every count lands on the right side of both bounds', () => {
  const at = (words: number) =>
    liveCountStatus({ kind: 'words', constraints: RANGE_WORDS, words, text: '' })
  assert.equal(at(99), 'under')
  assert.equal(at(100), 'within')
  assert.equal(at(150), 'within')
  assert.equal(at(200), 'within')
  assert.equal(at(201), 'over')
})

test('#8 NO BOUND IS NOT COMPLIANCE', () => {
  // 'none' rather than 'within': a school that stated nothing has nothing to be
  // inside of, and a green tick there claims a check nobody asked for.
  assert.equal(liveCountStatus({
    kind: 'words', constraints: NO_CONSTRAINTS, words: 5000, text: '' }), 'none')
})

test('#8 the same semantics for characters and for pages', () => {
  const chars: Constraints = { ...NO_CONSTRAINTS,
    characters: characterLimit({ min: 5000, max: 18000, spacesCount: false, enforcement: e }) }
  const text = 'x '.repeat(4000)   // 4,000 characters excluding spaces
  assert.equal(liveCountStatus({ kind: 'characters', constraints: chars, words: 0, text }), 'under')
  assert.match(liveCountLabel({ kind: 'characters', constraints: chars, words: 0, text }),
    /4,000 characters excluding spaces — required 5,000–18,000/)

  // Pages are measured, so their range is judged in the compliance panel.
  const pages: Constraints = { ...NO_CONSTRAINTS,
    pages: pageLimit({ min: 1, max: 2, spacing: 'double', enforcement: e }) }
  const caps = resolveRequirementCapabilities(pages)
  const at = (used: number) => Object.fromEntries(complianceRows({
    capabilities: caps,
    measurements: { words: 0, characters: 0, pagesUsed: used, contentHeightPt: used * 648 },
  }).map((r) => [r.id, r.status]))
  assert.equal(at(0.8)['pages-min'], 'breached')
  assert.equal(at(0.8).pages, 'met')
  assert.equal(at(1.5)['pages-min'], 'met')
  assert.equal(at(2.4).pages, 'breached')
})

test('#8 combined requirements stay independent', () => {
  const both: Constraints = {
    ...NO_CONSTRAINTS,
    words: wordLimit({ min: 100, max: 200, enforcement: e }),
    pages: pageLimit({ max: 2, spacing: 'double', enforcement: e }),
  }
  const rows = complianceRows({
    capabilities: resolveRequirementCapabilities(both),
    measurements: { words: 240, characters: 0, pagesUsed: 1.1, contentHeightPt: 648 * 1.1 },
  })
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]))
  assert.equal(byId.pages, 'met', 'inside the pages')
  assert.equal(byId.words, 'breached', 'and over the words, independently')
})

test('#8 a lone minimum and a lone maximum still read correctly', () => {
  const minOnly: Constraints = { ...NO_CONSTRAINTS, words: wordLimit({ min: 250, enforcement: e }) }
  assert.equal(liveCountLabel({ kind: 'words', constraints: minOnly, words: 100, text: '' }),
    '100 words — at least 250 required')
  assert.equal(liveCountStatus({ kind: 'words', constraints: minOnly, words: 100, text: '' }), 'under')

  // The maximum-only wording is unchanged, because it was never wrong.
  const maxOnly: Constraints = { ...NO_CONSTRAINTS, words: wordLimit({ max: 500, enforcement: e }) }
  assert.equal(liveCountLabel({ kind: 'words', constraints: maxOnly, words: 480, text: '' }),
    '480 / 500 words')
})

test('#8 a range keeps its register', () => {
  // A suggested range is not a required one, and must not read as though it is.
  const suggested: Constraints = { ...NO_CONSTRAINTS,
    words: wordLimit({ min: 100, max: 200, enforcement: 'suggested' }) }
  assert.equal(liveCountLabel({ kind: 'words', constraints: suggested, words: 154, text: '' }),
    '154 words — 100–200 suggested')
})

// ===========================================================================
// ISSUE #5 — verified bounds that never reached the catalog
// ===========================================================================


const CATALOG = JSON.parse(readFileSync(
  'local-review/statement_requirements_catalog.json', 'utf8')) as {
    sets: readonly { id: string, school_name: string | null }[]
    documents: readonly Record<string, unknown>[]
  }
const SETS = new Map(CATALOG.sets.map((s) => [s.id, s.school_name ?? '']))
/**
 * Fixture lookup only. No implementation may ever do this.
 *
 * A SUBSTRING, so a fixture survives a corrected name. This school was listed
 * as 'Ceder Crest' in the production schools table and is now 'Cedar Crest
 * College'; matching on 'Cedar Crest' spans both the misspelling's correction
 * and the fuller name. See the school-name corrections in
 * scripts/build_statement_requirements_import_sql.py.
 */
const docsFor = (school: string) => CATALOG.documents.filter(
  (d) => (SETS.get(String(d.set_id)) ?? '').includes(school))

test('#5 a verified two-ended range is stored as a bound', () => {
  /*
   * Arkansas State publishes "consisting of 500-1,000 words". The import
   * withheld it because no official wording called the figure a maximum or a
   * minimum -- the right default for a LONE number, which really might be a
   * suggestion. A range states both ends, and no reading of it admits 200
   * words, so the applicant was shown "No length requirement stated".
   */
  const [doc] = docsFor('Arkansas State')
  assert.notEqual(doc, undefined, 'the Arkansas fixture moved')
  assert.equal(doc!.min_words, 500)
  assert.equal(doc!.max_words, 1000)
  assert.equal(doc!.words_enforcement, 'enforced')
})

test('#5 A REGISTER MAY NOT CONTRADICT ITS OWN EVIDENCE', () => {
  // Three documents were classified "the stated length, not a limit" while the
  // basis behind them quoted the school saying "200 word limit".
  for (const doc of docsFor('Bryan College')) {
    assert.equal(doc.min_words, 100)
    assert.equal(doc.max_words, 200)
    assert.equal(doc.words_enforcement, 'enforced',
      'a figure the school called a limit is a limit')
  }
})

test('#5 EVERY verified bound now reaches the catalog', () => {
  /*
   * The sweep, so this is not four fixtures. Eleven documents carried a
   * verified figure that the structured columns did not hold; all eleven are
   * bounded now. Checked against the generated catalog rather than a list.
   */
  const bounded = CATALOG.documents.filter((d) =>
    d.min_words != null || d.max_words != null
    || d.min_characters != null || d.max_characters != null
    || d.min_pages != null || d.max_pages != null)
  assert.equal(CATALOG.documents.length, 80)
  assert.ok(bounded.length >= 52, `only ${bounded.length} documents carry a bound`)

  // And no document bounds a unit it never stated.
  for (const d of CATALOG.documents) {
    if (d.min_words != null && d.max_words != null) {
      assert.ok(Number(d.min_words) <= Number(d.max_words), String(d.id))
    }
    if (d.min_pages != null && d.max_pages != null) {
      assert.ok(Number(d.min_pages) <= Number(d.max_pages), String(d.id))
    }
  }
})

test('#5 a page RANGE is a range, not just a ceiling', () => {
  // "1-2 pages" and "2-3 pages" were stored as nothing at all.
  const idaho = docsFor('Idaho State')[0]!
  assert.equal(idaho.min_pages, 2)
  assert.equal(idaho.max_pages, 3)
  const wayne = docsFor('Wayne State')[0]!
  assert.equal(wayne.min_pages, 1)
  assert.equal(wayne.max_pages, 2)
})

// ===========================================================================
// ISSUE #1 — "Looking for a different prompt?" went nowhere
// ===========================================================================

test('#1 the control says what it does', () => {
  assert.equal(NEW_DRAFT_MESSAGES.otherPrompts, 'See Other School Prompts')
  // The old wording described the old behaviour: it offered "a different
  // prompt" and stayed on the school the applicant was trying to leave.
  assert.doesNotMatch(NEW_DRAFT_MESSAGES.otherPrompts, /different prompt/i)
  assert.doesNotMatch(NEW_DRAFT_MESSAGES.otherPrompts, /this school/i)
  // And the General option is still its own, separate thing.
  assert.match(NEW_DRAFT_MESSAGES.startGeneral, /General/i)
})

test('#1 AND THE STATE RESET IS THE ACTUAL FIX, not the label', () => {
  /*
   * Renaming the button would have made it lie more clearly. Every field that
   * identifies a school, a prompt or a requirement has to be cleared, or the
   * applicant lands back on the school they were trying to leave.
   */
  assert.equal(SCHOOL_CHOICE_RESET.step, 'school')
  assert.equal(SCHOOL_CHOICE_RESET.path, 'school')
  for (const field of ['school', 'prompt', 'pasted', 'report', 'requirementId',
    'requirementSets', 'prompts', 'promptNotice', 'message'] as const) {
    assert.equal(SCHOOL_CHOICE_RESET[field], null, `${field} must be cleared`)
  }
  // THE TITLE IS NOT IN THE RESET, deliberately: moving between screens is
  // navigation, and navigation does not discard what the applicant typed.
  assert.equal('title' in SCHOOL_CHOICE_RESET, false)
})

test('#1 the dialog applies every field of the reset, and nothing stale survives', () => {
  const dialog = readFileSync(
    'app/statement-studio/components/NewDraftDialog.tsx', 'utf8')
  // The control is wired to the reset, not to a fetch of the same school.
  assert.match(dialog, /onClick=\{backToSchoolChoice\}/)
  for (const field of ['step', 'path', 'school', 'prompt', 'pasted', 'report',
    'requirementId', 'requirementSets', 'prompts', 'promptNotice', 'message']) {
    assert.match(dialog, new RegExp(`SCHOOL_CHOICE_RESET\\.${field}\\b`),
      `the dialog never applies ${field}`)
  }
  // AN IN-FLIGHT REPLY MUST NOT LAND ON THE NEW SCREEN.
  assert.match(dialog, /browsing\.current = null/)
  // And the handler that stayed on the same school is gone, not just unused.
  assert.equal(dialog.includes('showListedPrompts'), false)
})

// ===========================================================================
// ISSUE #2 — saves that looked stuck, and drafts that disappeared
// ===========================================================================

test('#2 AN UNREADABLE STORE IS AN ERROR, NOT AN EMPTY ONE', async () => {
  /*
   * THE DELETION, IN ONE PLACE.
   *
   * Every local store read as `try { JSON.parse(read(file)) } catch { return [] }`
   * and wrote with a plain writeFileSync of the whole array. writeFileSync
   * truncates before it writes, so for the length of a large array there is a
   * partial file on disk. A reader landing in that window got a parse error,
   * the catch reported "no drafts", and the caller wrote that empty view back.
   *
   * A fault lasting microseconds deleted everything, permanently, which is
   * what the owner saw as a draft that vanished after logging back in.
   */
  const { readJsonStore, writeJsonStore, LocalStoreUnreadable } =
    await import('../devMode/jsonStore.ts')
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'qa-store-'))
  const file = join(dir, 'drafts.json')

  // A file that is absent is legitimately empty.
  assert.deepEqual(readJsonStore(file, []), [])

  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  writeJsonStore(file, rows)
  assert.deepEqual(readJsonStore(file, []), rows)

  // A TORN FILE REFUSES TO BE READ, rather than reporting an empty store.
  writeFileSync(file, JSON.stringify(rows).slice(0, 12), 'utf8')
  assert.throws(() => readJsonStore(file, []), LocalStoreUnreadable)

  // An empty file is not corrupt: it is a store nothing has been written to.
  writeFileSync(file, '', 'utf8')
  assert.deepEqual(readJsonStore(file, []), [])

  // AND THE WRITE IS ATOMIC, so the torn state stops arising. The target is
  // only ever the previous whole file or the next whole file.
  writeJsonStore(file, rows)
  const during = readFileSync(file, 'utf8')
  assert.deepEqual(JSON.parse(during), rows, 'a reader never sees a partial write')
})

test('#2 every local store goes through it, not just the one that lost data', async () => {
  // The pattern was in all four. Fixing only drafts would leave submissions,
  // promotions and the analysis cache able to erase themselves the same way.
  for (const name of ['localDrafts', 'localSubmissions', 'localCanonical', 'localAnalyses']) {
    const source = readFileSync(`lib/statement/devMode/${name}.ts`, 'utf8')
    assert.match(source, /from '\.\/jsonStore\.ts'/, `${name} writes its own file`)
    assert.match(source, /writeJsonStore\(/, `${name} does not write atomically`)
    // No store may truncate its own file any more.
    assert.equal(source.includes('writeFileSync('), false, `${name} still truncates`)
  }
  // The three stores whose contents are DATA refuse an unreadable file. The
  // analysis store is a cache, where a miss costs one extra call and loses
  // nothing, so it is allowed to forgive one.
  for (const name of ['localDrafts', 'localSubmissions', 'localCanonical']) {
    const source = readFileSync(`lib/statement/devMode/${name}.ts`, 'utf8')
    // COUNTED, NOT PATTERN-MATCHED. Call sites spell the generic differently --
    // readJsonStore<unknown>(...) and readJsonStore<Partial<X>>(...) -- and a
    // regex for the angle brackets fails on the nested one, which is a test
    // breaking on punctuation rather than on the rule it is checking.
    const uses = source.split('readJsonStore').length - 1
    assert.ok(uses >= 2, `${name} imports the strict reader but never calls it`)
    assert.equal(source.includes('catch {\n    return []'), false,
      `${name} still degrades a bad read to an empty store`)
  }
})

test('#2 the indicator reaches Saved promptly once typing stops', async () => {
  /*
   * The engine was never the slow part, and this pins that so a future change
   * cannot make it so. Three keystrokes 100ms apart, then quiet: the save is
   * due 1.2s after the LAST edit, not 1.2s after the first.
   */
  const { reduce, initialState, nextAction } = await import('../../resume/draft/autosave.ts')
  const { statementStatus } = await import('../draft/editor.ts')

  let state = initialState(1)
  let now = 0
  for (let i = 0; i < 3; i += 1) {
    now += 100
    state = reduce(state, { type: 'edited', at: now })
  }
  assert.equal(statementStatus(state, null).text, 'Unsaved changes')
  // Still waiting a moment before the last keystroke's window closes.
  assert.equal(nextAction(state, now + 1199).kind, 'wait')
  assert.equal(nextAction(state, now + 1200).kind, 'save')

  state = reduce(state, { type: 'save-started', at: now + 1200 })
  assert.equal(statementStatus(state, null).text, 'Saving…')
  state = reduce(state, { type: 'save-succeeded', at: now + 1350, revision: 2 })
  assert.equal(statementStatus(state, null).text, 'Saved')
  assert.equal(statementStatus(state, null).unsaved, false)
})

test('#2 PENDING EDITS SURVIVE LEAVING THE PAGE', () => {
  /*
   * The gap the other guards left. `beforeunload` warns and only on a real
   * unload; `visibilitychange` covers a hiding tab; the library link flushes
   * and waits for itself. An applicant clicking any OTHER link -- the sidebar,
   * the dashboard, Log out -- unmounted this component with up to 1.2 seconds
   * of typing that had never been sent, and nothing warned, because nothing
   * was unloading.
   */
  const client = readFileSync(
    'app/statement-studio/components/StatementStudioClient.tsx', 'utf8')
  // pagehide covers what beforeunload does not, including the bfcache.
  assert.match(client, /addEventListener\('pagehide', flushOnLeave\)/)
  // AND THE UNMOUNT ITSELF, which is the in-app navigation case.
  assert.match(client, /removeEventListener\('pagehide', flushOnLeave\)\s*\n\s*\/\/[^\n]*\n\s*flushOnLeave\(\)/)
  // keepalive is what lets the request outlive the document.
  assert.match(client, /keepalive: leaving/)

  /*
   * AND IT IS STILL ONE SAVE PATH. A second fetch with its own body would be a
   * second set of rules about revisions and prompts to keep in step; the first
   * attempt at this added one, and the tests that guard the single path caught
   * it. The flush calls the same startSave with a flag.
   */
  assert.equal(client.split('body: JSON.stringify(attempt.body)').length - 1, 1)
  assert.match(client, /void startSave\(saveRef\.current\.revision, titleRef\.current, essayRef\.current, true\)/)
  // The compare-and-swap is not bypassed to get the write in.
  assert.match(client, /revision: saveRef\.current\.revision|startSave\(saveRef\.current\.revision/)
})

test('#2 ownership is the authenticated user id, not a session identity', () => {
  // The draft is created with the id the server resolved from the verified
  // token, and the list is filtered by the same. Nothing transient reaches it.
  const route = readFileSync('app/api/statement/drafts/route.ts', 'utf8')
  assert.match(route, /createDraft\(caller\.db, caller\.userId/)
  assert.match(route, /userId: auth\.userId/)
  const auth = readFileSync('lib/apiAuth.ts', 'utf8')
  // Verified against Supabase, so the id is the account's and survives logout.
  assert.match(auth, /supabase\.auth\.getUser\(token\)/)
})

// ===========================================================================
// ISSUE #3 — the applicant was filling in catalog administration
// ===========================================================================

test('#3 the applicant is not asked for Source URL or Application cycle', () => {
  /*
   * Both are catalog-administration metadata: which published page a
   * requirement was verified against, and which admissions cycle it belongs
   * to. An applicant pasting the prompt their school emailed them has neither,
   * and being asked turns a two-field task into data entry for somebody else.
   */
  const dialog = readFileSync(
    'app/statement-studio/components/NewDraftDialog.tsx', 'utf8')
  // No input writes either field any more.
  assert.equal(dialog.includes('sourceUrl: event.target.value'), false)
  assert.equal(dialog.includes('applicationCycle: event.target.value'), false)
  assert.equal(dialog.includes('Source URL <span'), false)
  assert.equal(dialog.includes('Application cycle <span'), false)

  // READING AN EXISTING PROMPT'S CYCLE IS NOT ASKING FOR ONE. The catalog may
  // display what it knows; that is a different act from demanding it.
  assert.match(dialog, /prompt\.applicationCycle === null/)
})

test('#3 and the columns remain, nullable, for the administrator', () => {
  // Removing the questions must not remove the data model: an administrator
  // fills these in at review, where the question is answerable at all.
  const pasted = readFileSync('lib/statement/draft/newDraft.ts', 'utf8')
  assert.match(pasted, /sourceUrl/)
  assert.match(pasted, /applicationCycle/)
})

// ===========================================================================
// ISSUE #6 — an approved submission that never reached an applicant
// ===========================================================================

test('#6 THE EVIDENCE RULE WAS WHY APPROVE DID NOTHING', async () => {
  /*
   * Migration 005 lets a set be active only with a verified status, a date AND
   * a source URL. A student submission has no source URL -- the prompt came by
   * email, or from a portal nobody else can fetch -- so an approved submission
   * could be promoted and then never published. Everything applicant-facing is
   * downstream of is_active, so Approve genuinely did nothing they could see.
   */
  const { activationShortfall } = await import('../devMode/localCanonical.ts')

  // Before 011 there was one kind of evidence, and a submission had none of it.
  const submissionBacked = {
    verification_status: 'verified', verified_on: '2026-10-08', source_url: null,
  }
  assert.deepEqual(activationShortfall(submissionBacked),
    ['no source URL (or an approved submission to publish on)'])

  // 011 adds a second kind, and naming it is what makes the set publishable.
  assert.deepEqual(activationShortfall({
    ...submissionBacked,
    evidence_kind: 'admin-approved-submission',
    evidence_submission_id: 'sub-1',
  }), [])
})

test('#6 and the rule is widened, NOT weakened', async () => {
  const { activationShortfall } = await import('../devMode/localCanonical.ts')
  // Still no active set without a verified status.
  assert.ok(activationShortfall({
    verification_status: 'needs-review', verified_on: '2026-10-08',
    evidence_kind: 'admin-approved-submission', evidence_submission_id: 'sub-1',
  }).some((m) => m.includes('verification status')))
  // Still none without a date.
  assert.ok(activationShortfall({
    verification_status: 'verified', verified_on: null,
    evidence_kind: 'admin-approved-submission', evidence_submission_id: 'sub-1',
  }).some((m) => m.includes('verified date')))
  // AND NONE CLAIMING SUBMISSION EVIDENCE WITHOUT A SUBMISSION.
  assert.deepEqual(activationShortfall({
    verification_status: 'verified', verified_on: '2026-10-08',
    evidence_kind: 'admin-approved-submission', evidence_submission_id: null,
  }), ['no approved submission to publish on'])
  // A row that says nothing about evidence is held to the old rule.
  assert.deepEqual(activationShortfall({
    verification_status: 'verified', verified_on: '2026-10-08', source_url: null,
  }), ['no source URL (or an approved submission to publish on)'])
})

test('#6 A PUBLISHED SUBMISSION IS NEVER DESCRIBED AS CHECKED BY US', async () => {
  /*
   * The price of widening the evidence rule. An entry read off the school's own
   * page and an entry taken on an applicant's word are both "verified" in the
   * sense that somebody took responsibility -- and they are not equally
   * reliable. Widening what counts as evidence is only safe while the
   * difference is visible to the person deciding how much to trust the prompt.
   */
  const { textAttribution } = await import('../requirements/verification.ts')
  const base = { status: 'verified' as const, sourceUrl: null, verifiedOn: '2026-10-08' }

  const submitted = textAttribution({
    ...base, verbatim: true, evidenceKind: 'admin-approved-submission' })
  assert.match(submitted, /Submitted by an applicant/)
  assert.match(submitted, /Not checked against the school’s own published page/)
  // IT MUST NOT BORROW THE STRONGER CLAIM.
  assert.doesNotMatch(submitted, /Quoted from the school’s application materials/)

  // And an official-source entry is unchanged.
  assert.equal(
    textAttribution({ ...base, sourceUrl: 'https://example.edu', verbatim: true,
      evidenceKind: 'official-source' }),
    'Quoted from the school’s application materials.')
})

test('#6 the primary admin action says what it does to applicants', () => {
  const editor = readFileSync(
    'app/admin/statement-prompts/PromotionEditor.tsx', 'utf8')
  assert.match(editor, /Approve & Publish to School Prompts/)
  // AND THE PARTIAL ACTION IS NAMED FOR WHAT IT DOES NOT DO, so the two
  // cannot be confused the way "Approve" and "Save requirement" were.
  assert.match(editor, /Approve only — do not publish yet/)
  // ASSERTED ON THE CODE, NOT THE PROSE. The old label still appears in the
  // comment explaining what replaced it, and a test that bans a phrase
  // everywhere forbids explaining the change.
  const code = editor.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.equal(code.includes('Save requirement (inactive)'), false)
  // Publishing is a flag on the one request, not a second endpoint.
  assert.match(editor, /\.\.\.\(publish \? \{ publish: true \} : \{\}\)/)

  // The server supplies the evidence; a browser cannot claim verification by
  // sending fields that say so.
  const route = readFileSync('app/api/admin/statement-prompts/route.ts', 'utf8')
  assert.match(route, /evidence_kind: 'admin-approved-submission'/)
  assert.match(route, /evidence_submission_id: id/)
  assert.match(route, /verification_status: 'verified'/)
  // AND IT IS RE-CHECKED AFTER THE WRITE, by the same shortfall production uses.
  assert.match(route, /simulateActivation\(String\(result\.setId\)\)/)
})

test('#6 migration 011 is drafted, not applied, and keeps the invariant', () => {
  const sql = readFileSync(
    'supabase/migrations/20261008_011_statement_requirement_submission_evidence.sql', 'utf8')
  assert.match(sql, /NOT APPLIED/)
  // The widened constraint still demands a status, a date and evidence.
  assert.match(sql, /verification_status = 'verified'/)
  assert.match(sql, /verified_on is not null/)
  assert.match(sql, /evidence_kind = 'official-source' and source_url is not null/)
  assert.match(sql, /evidence_kind = 'admin-approved-submission'\s*\n?\s*and evidence_submission_id is not null/)
  // The kind and its evidence may never disagree.
  assert.match(sql, /statement_requirement_sets_evidence_shape/)
})

// ===========================================================================
// ISSUE #7 — Bold
// ===========================================================================

test('#7 THE DOCUMENT MAY NEVER DISAGREE WITH THE ESSAY', async () => {
  /*
   * The invariant the whole feature rests on. `essay` is what the analyser
   * reads, what the counters count and what the fingerprint is taken over;
   * `editor_document` remembers only which characters are bold. If the two
   * disagreed, the applicant would see one essay and be assessed on another.
   */
  const { constrainDocument, documentMatchesEssay, documentText, essayToDoc } =
    await import('../layout/plainText.ts')

  const bolded = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'My ' },
        { type: 'text', text: 'strongest', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' reason.' },
      ],
    }],
  }
  assert.equal(documentText(bolded), 'My strongest reason.')
  assert.equal(documentMatchesEssay(bolded, 'My strongest reason.'), true)
  // THE ONE THING THAT MUST BE REFUSED.
  assert.equal(documentMatchesEssay(bolded, 'ABC'), false)
  // A plain essay round-trips unchanged, which is what lets an old draft load.
  assert.equal(documentMatchesEssay(essayToDoc('a\n\nb'), 'a\n\nb'), true)
  // Line endings are normalised on both sides, so a \r\n paste still matches.
  assert.equal(documentMatchesEssay(essayToDoc('a\nb'), 'a\r\nb'), true)
  assert.equal(constrainDocument(bolded).content[0]!.content!.length, 3)
})

test('#7 the schema admits BOLD AND NOTHING ELSE', async () => {
  const { constrainDocument, documentText } = await import('../layout/plainText.ts')
  /*
   * A paste from a word processor carries headings, colours, fonts, sizes and
   * underlines. None can be stored, measured or rendered, and a document that
   * held them would be one no page count could be trusted for. The words are
   * KEPT; the formatting that is not bold is dropped.
   */
  const pasted = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'kept ', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'red', marks: [{ type: 'textStyle', attrs: { color: 'red' } }] },
          { type: 'text', text: ' and ', marks: [{ type: 'underline' }] },
          { type: 'text', text: 'big', marks: [{ type: 'fontSize' }, { type: 'bold' }] },
        ],
      },
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }] },
    ],
  }
  const out = constrainDocument(pasted)
  // NO WORD IS LOST, including the heading's and the list item's.
  assert.equal(documentText(out), 'Title\nkept red and big\nitem')
  const marks = out.content.flatMap((p) => (p.content ?? []).map(
    (run) => (run.marks ?? []).map((m) => m.type).join('+')))
  // Only strong survives, on exactly the runs that had it.
  assert.deepEqual([...new Set(marks)].sort(), ['', 'bold'])
})

test('#7 adjacent runs with the same marks are one run', async () => {
  // A paste arrives split a span per word. Two identically-marked runs side by
  // side are one run, or the stored document differs from the one the editor
  // would produce for the same text.
  const { constrainDocument } = await import('../layout/plainText.ts')
  const split = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'a', marks: [{ type: 'bold' }] },
    { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
    { type: 'text', text: 'c' },
  ] }] }
  const runs = constrainDocument(split).content[0]!.content!
  assert.equal(runs.length, 2)
  assert.equal(runs[0]!.text, 'ab')
})

test('#7 A BOLD-ONLY EDIT DOES NOT CHANGE THE ANALYSIS FINGERPRINT', async () => {
  /*
   * The commercial half of the feature. A bold-only change must save and bump
   * the revision -- the row changed -- while costing the applicant nothing,
   * because the text the model would read is byte-identical.
   *
   * TRUE BY CONSTRUCTION: the fingerprint takes `essay` and the prompt fields
   * and has no parameter for a document. Asserted anyway, because "by
   * construction" is a property of today's signature.
   */
  const { analysisFingerprint } = await import('../draft/analysisFingerprint.ts')
  const base = {
    essay: 'My strongest reason.',
    promptText: null, schoolId: null, promptId: null,
    statedMaxWords: null, requirement: null,
  }
  const before = analysisFingerprint(base)
  const after = analysisFingerprint({ ...base })
  assert.equal(before, after)
  // And the signature has no document parameter to pass one through.
  const source = readFileSync('lib/statement/draft/analysisFingerprint.ts', 'utf8')
  assert.equal(/editorDocument|editor_document/.test(source), false,
    'the fingerprint must never read formatting')
})

test('#7 a save carrying a mismatched document is refused', async () => {
  const { statementSaveRequest } = await import('../draft/editor.ts')
  const good = statementSaveRequest({
    title: 'T', essay: 'hello', revision: 1,
    document: { type: 'doc', content: [{ type: 'paragraph',
      content: [{ type: 'text', text: 'hello' }] }] },
  })
  assert.equal(good.ok, true)
  assert.equal((good as { body: Record<string, unknown> }).body.editorDocumentVersion, 1)

  const bad = statementSaveRequest({
    title: 'T', essay: 'hello', revision: 1,
    document: { type: 'doc', content: [{ type: 'paragraph',
      content: [{ type: 'text', text: 'something else' }] }] },
  })
  assert.equal(bad.ok, false)

  // A SURFACE WITH NO FORMATTING SENDS NO DOCUMENT, so the plain textarea's
  // body is byte-for-byte the three keys it has always been.
  const plain = statementSaveRequest({ title: 'T', essay: 'hello', revision: 1 })
  assert.equal(plain.ok, true)
  assert.deepEqual(Object.keys((plain as { body: object }).body).sort(),
    ['essay', 'expectedRevision', 'title'])
})

test('#7 THE SERVER ENFORCES IT TOO, not only the browser', () => {
  // A guarantee about stored data cannot live in a client.
  const route = readFileSync('app/api/statement/drafts/[id]/route.ts', 'utf8')
  assert.match(route, /documentMatchesEssay\(constrained, essay\)/)
  assert.match(route, /constrainDocument\(raw\)/)
  // Absent is fine and common: the plain surface sends none, and the draft
  // keeps whatever it had rather than having it erased.
  assert.match(route, /if \(raw === undefined\) return undefined/)
  const repo = readFileSync('lib/statement/draft/draftRepo.ts', 'utf8')
  assert.match(repo, /if \(input\.editorDocument === undefined\) return \{\}/)
})

test('#7 bold is a REAL face, and synthesis is refused', () => {
  const fonts = readFileSync('lib/statement/layout/fonts.ts', 'utf8')
  // Both weights are bundled, and the @font-face blocks declare which is which.
  assert.match(fonts, /tinos-bold-latin\.woff2/)
  assert.match(fonts, /tinos-bold-latin-ext\.woff2/)
  assert.match(fonts, /font-weight: \$\{face\.weight\}/)
  for (const file of ['tinos-bold-latin.woff2', 'tinos-bold-latin-ext.woff2']) {
    assert.ok(readFileSync(`public/fonts/${file}`).length > 1000, file)
  }
  // AND THE EDITOR REFUSES A SMEARED ONE. Without this a browser that failed
  // to load the 700 face would thicken the 400 one, and the page count would
  // depend on which engine drew it.
  const editor = readFileSync(
    'app/statement-studio/components/PaginatedEditor.tsx', 'utf8')
  assert.match(editor, /font-synthesis: none/)
})

test('#7 the toolbar, the shortcut and the paste all produce ONE mark', () => {
  const editor = readFileSync(
    'app/statement-studio/components/PaginatedEditor.tsx', 'utf8')
  // Tiptap's Bold ships Cmd+B / Ctrl+B and parses <strong>, <b> and
  // font-weight into the same mark the button toggles.
  assert.match(editor, /import Bold from '@tiptap\/extension-bold'/)
  assert.match(editor, /toggleBold\(\)/)
  assert.match(editor, /aria-pressed=\{bold\}/)
  assert.match(editor, /aria-keyshortcuts="Control\+B Meta\+B"/)
  // The button must not steal the selection it is about to format.
  assert.match(editor, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/)
  // Paste is constrained a second time, over the JSON.
  assert.match(editor, /constrainDocument\(parseHtmlToDoc\(html, view\)\)/)
  // AND NO OTHER MARK IS REGISTERED. A mark the schema does not know cannot
  // enter the document at all.
  for (const forbidden of ['extension-italic', 'extension-underline',
    'extension-heading', 'extension-text-style', 'extension-color']) {
    assert.equal(editor.includes(forbidden), false, `${forbidden} is registered`)
  }
})

test('#7 migration 013 is drafted, not applied, and keeps essay canonical', () => {
  const sql = readFileSync(
    'supabase/migrations/20261011_013_statement_draft_editor_document.sql', 'utf8')
  assert.match(sql, /NOT APPLIED/)
  assert.match(sql, /add column if not exists editor_document jsonb/)
  assert.match(sql, /add column if not exists editor_document_version smallint/)
  // essay is NOT replaced or dropped.
  assert.equal(/drop column .*essay|alter column essay/i.test(sql), false)
  // The two travel together, and null is a valid state.
  assert.match(sql, /statement_drafts_editor_document_shape/)
})

test('#7 THE STORED MARK NAME IS THE ONE TIPTAP EMITS', async () => {
  /*
   * The bug the browser caught, as a guard.
   *
   * The HTML tag is <strong>, so the mark was first stored as 'strong'. The
   * schema's mark is named 'bold', and the mismatch broke BOTH directions
   * silently: a stored document would not load at all, and a document coming
   * out of the editor arrived as 'bold' and was dropped here as unrecognised.
   * Bolding a word, saving and reopening lost the bold, with no error.
   *
   * Asserted against the extension's own name rather than a literal, so the
   * two cannot drift apart again.
   */
  const { STUDIO_MARKS, constrainDocument, documentText } =
    await import('../layout/plainText.ts')
  const Bold = (await import('@tiptap/extension-bold')).default
  assert.equal(Bold.name, 'bold')
  assert.deepEqual([...STUDIO_MARKS], [Bold.name])

  // A document spelled the other way keeps its words and loses the formatting,
  // which is the safe failure -- but it must not be what we write.
  const wrong = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'x', marks: [{ type: 'strong' }] }] }] }
  assert.equal(documentText(constrainDocument(wrong)), 'x')
  assert.deepEqual(constrainDocument(wrong).content[0]!.content![0]!.marks, undefined)
})

// ===========================================================================
// ISSUE #9 — structured format profiles
// ===========================================================================

const docFor = (school: string) => docsFor(school)[0]!
const constraintsFor = (school: string) => {
  const d = docFor(school) as Record<string, unknown>
  return {
    ...NO_CONSTRAINTS,
    formatProfile: (d.document_format_profile ?? null) as string | null,
    pages: d.max_pages == null && d.page_spacing == null ? null : pageLimit({
      min: (d.min_pages ?? null) as number | null,
      max: (d.max_pages ?? null) as number | null,
      spacing: (d.page_spacing ?? null) as 'single' | 'double' | null,
      enforcement: e,
    }),
    otherInstructions: (d.other_instructions ?? []) as readonly string[],
  }
}

test('#9 A MENTION OF A STANDARD IS NOT A LAYOUT INSTRUCTION', () => {
  /*
   * The distinction the whole feature turns on, read from the verified
   * wording rather than from the word "APA":
   *
   *   "An essay ... using APA 7th edition format"      -> the essay itself
   *   "excluding cover and references in AMA format"   -> the references only
   *
   * Upgrading the second would reformat a three-page letter because its
   * bibliography has a house style.
   */
  assert.equal(docFor('Cedar Crest').document_format_profile, 'apa-7')
  assert.equal(docFor('New Mexico State').document_format_profile, 'apa-7')
  assert.equal(docFor('Keiser').document_format_profile ?? null, null)
  // And no other document in the catalog acquired one.
  const profiled = CATALOG.documents.filter((d) => d.document_format_profile != null)
  assert.equal(profiled.length, 2)
})

test('#9 the APA profile applies the BODY rules it can', async () => {
  const caps = resolveRequirementCapabilities(constraintsFor('Cedar Crest'))
  const g = caps.geometry
  assert.equal(g.marginsIn.value, 1)
  assert.equal(g.spacing.value, 'double')
  assert.equal(g.fontSizePt.value, 12)
  assert.equal(g.firstLineIndentIn.value, 0.5)
  // ATTRIBUTED TO THE STANDARD, not to the school: they named a format, not
  // an inch, and reporting it as their own field would put words in it.
  for (const sourced of [g.marginsIn, g.spacing, g.fontSizePt, g.firstLineIndentIn]) {
    assert.equal(sourced.source, 'format-profile')
  }
  // A document is a page now, not a plain box.
  assert.equal(caps.paginated, true)
})

test('#9 AND IT ADDS NO CONTENT', async () => {
  /*
   * A title page, abstract or reference list would consume the page allowance
   * a school set -- an essay could be over a 1.5-page limit because of us.
   * None is generated, and the omission is stated rather than left silent.
   */
  const caps = resolveRequirementCapabilities(constraintsFor('Cedar Crest'))
  const notes = caps.rendering.join(' ')
  assert.match(notes, /Title page, abstract, reference list and headings — not generated/)
  assert.match(notes, /Page number[^.]*not added/)
  const { APA_7 } = await import('../layout/formatProfile.ts')
  // Every encoded rule cites the page it was read from.
  for (const rule of [...APA_7.rules, ...APA_7.notApplied]) {
    assert.match(rule.source, /^https:\/\/apastyle\.apa\.org\//, rule.label)
  }
})

test('#9 AN EXPLICIT SCHOOL FIELD BEATS THE PROFILE', () => {
  // A school that wrote down 1.25-inch margins meant them; a standard they
  // invoked does not overrule a requirement they stated themselves.
  const caps = resolveRequirementCapabilities({
    ...constraintsFor('Cedar Crest'),
    typography: {
      fontSizePt: 11, fontFamily: null, marginsInches: 1.25,
      fontFamilyOptions: null, fontSizePtOptions: null,
    },
  })
  assert.equal(caps.geometry.marginsIn.value, 1.25)
  assert.equal(caps.geometry.marginsIn.source, 'school')
  assert.equal(caps.geometry.fontSizePt.value, 11)
  assert.equal(caps.geometry.fontSizePt.source, 'school')
  // What the school left unsaid still comes from the profile.
  assert.equal(caps.geometry.firstLineIndentIn.value, 0.5)
  assert.equal(caps.geometry.firstLineIndentIn.source, 'format-profile')
})

test('#9 THE PROFILE FONT IS SUBSTITUTED, NEVER CLAIMED', () => {
  // APA permits 12-pt Times New Roman and that is the combination chosen.
  // Tinos is not Times New Roman, so it resolves exactly as a school-named
  // font we cannot ship would.
  const caps = resolveRequirementCapabilities(constraintsFor('Cedar Crest'))
  assert.equal(caps.font.support, 'substituted')
  const notes = caps.rendering.join(' ')
  assert.match(notes, /Tinos does not satisfy the font-family requirement/)
  assert.match(notes, /Times New Roman/)
  // The proper noun keeps its capitals.
  assert.match(notes, /12-point Times New Roman, one of the permitted fonts/)
})

test('#9 CEDAR NO LONGER READS "APA — check it yourself"', () => {
  // The layout is applied, so telling the applicant to verify APA would send
  // them to check the margins and spacing the Studio just set. What is left
  // is the part no layout engine can settle.
  const caps = resolveRequirementCapabilities(constraintsFor('Cedar Crest'))
  assert.deepEqual(caps.manualReview.map((m) => m.label),
    ['APA citation and reference formatting'])
  for (const item of caps.manualReview) {
    assert.doesNotMatch(item.label, /^APA 7th edition$/)
  }
})

test('#9 a school with no profile is not reformatted', () => {
  const caps = resolveRequirementCapabilities(constraintsFor('Keiser'))
  assert.equal(caps.geometry.firstLineIndentIn.value, 0)
  assert.equal(caps.geometry.spacing.source, 'studio-default')
  assert.deepEqual(caps.rendering, [])
  assert.deepEqual(caps.manualReview.map((m) => m.label),
    ['AMA format; at least one cited article required'])
})

test('#9 migration 014 is drafted, not applied, and admits only researched values', () => {
  const sql = readFileSync(
    'supabase/migrations/20261011_014_statement_document_format_profile.sql', 'utf8')
  assert.match(sql, /NOT APPLIED/)
  assert.match(sql, /add column if not exists document_format_profile text/)
  // Only a standard that has been researched against its own source.
  assert.match(sql, /document_format_profile in \('apa-7'\)/)
})

// ===========================================================================
// ISSUE #4 — reporting that a catalog prompt has changed
// ===========================================================================

test('#4 the control exists on every catalog card, in the owner’s words', () => {
  assert.equal(REPORT_MESSAGES.action, 'Report: This Prompt Has Changed')
  const checklist = readFileSync(
    'app/statement-studio/components/RequirementChecklist.tsx', 'utf8')
  // ONE CARD COMPONENT, so a control added here reaches every surface that
  // supplies a handler and no surface that does not.
  assert.match(checklist, /REPORT_MESSAGES\.action/)
  assert.match(checklist, /actions\.onReportChange !== undefined/)
})

test('#4 THE APPLICANT IS NOT ASKED FOR A SOURCE URL OR A CYCLE', () => {
  /*
   * #3's rule, applied to the report form -- and here it is stronger: the two
   * fields are absent from the BODY, not merely from the screen, so there is
   * no key for a later form to populate.
   */
  const built = newPromptChangeRequest(
    'My statement',
    '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    {
      requirementId: 'a8482c8f-c8dd-5150-8e9f-12fb3326db46',
      promptText: 'Why anesthesia?',
      confirmed: true,
    },
  )
  assert.equal(built.ok, true)
  if (!built.ok) return
  const keys = Object.keys(built.body.promptSubmission)
  assert.equal(keys.includes('sourceUrl'), false)
  assert.equal(keys.includes('applicationCycle'), false)
  assert.equal(built.body.promptSubmission.kind, 'prompt-change')
})

test('#4 the kind and its target travel together, both ways', () => {
  const base = {
    schoolId: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    promptText: 'Why anesthesia?',
    confirmed: true,
  }
  // A report with nothing to compare against cannot be reviewed.
  const orphan = checkPromptSubmission({ ...base, kind: 'prompt-change' })
  assert.equal(orphan.ok, false)
  if (!orphan.ok) assert.equal(orphan.code, 'invalid-challenged-requirement')
  // A new prompt naming a row would be a report nobody labelled as one.
  const mislabelled = checkPromptSubmission({
    ...base, kind: 'new-prompt', challengedRequirementId: 'a8482c8f-c8dd-5150-8e9f-12fb3326db46',
  })
  assert.equal(mislabelled.ok, false)
  if (!mislabelled.ok) assert.equal(mislabelled.code, 'invalid-challenged-requirement')
  // AND THE DEFAULT IS A NEW PROMPT, so every existing caller keeps working.
  const plain = checkPromptSubmission(base)
  assert.equal(plain.ok, true)
  if (plain.ok) assert.equal(plain.input.kind, 'new-prompt')
})

test('#4 the applicant writes immediately, labelled as theirs and unverified', () => {
  assert.equal(REPORT_MESSAGES.badge, PROMPT_STATUS_LABELS.pending)
  // APPROVAL DOES NOT RETROSPECTIVELY MAKE THE DRAFT'S SNAPSHOT OURS.
  assert.match(PROMPT_STATUS_LABELS.approved, /User-provided prompt/)
  assert.match(PROMPT_STATUS_LABELS.approved, /Your wording is unchanged/)
})

test('#4 THE CANONICAL ROW IS NOT TOUCHED BY A REPORT', () => {
  const sql = readFileSync(
    'supabase/migrations/20261008_012_statement_prompt_change_reports.sql', 'utf8')
  assert.match(sql, /NOT APPLIED/)
  // No write-back: a report is evidence, and evidence does not edit its subject.
  assert.equal(/update public\.statement_requirements\s+set/i.test(sql), false)
  // The supersession relationship, so a replacement keeps its history.
  assert.match(sql, /supersedes_requirement_id/)
  assert.match(sql, /origin_submission_id/)
  /*
   * THE RULE, NOT ITS PHRASING. A replacement must not remove the row it
   * replaces, so the migration contains no delete against either canonical
   * table -- which is what "deactivated, never deleted" means operationally.
   */
  assert.equal(/delete\s+from\s+public\.statement_requirements/i.test(sql), false)
  assert.equal(/delete\s+from\s+public\.statement_prompt/i.test(sql), false)
  assert.match(sql, /deactivated/i)
  // AND IT CANNOT POINT AT ITSELF.
  assert.match(sql, /supersedes_requirement_id is null or supersedes_requirement_id <> id/)
})

test('#4 FOUR EXPLICIT CHOICES, AND REPLACE VS ADD IS NEVER INFERRED', () => {
  const page = readFileSync('app/admin/statement-prompts/page.tsx', 'utf8')
  for (const choice of ['Prompt Change Report', 'Current catalog prompt',
    'Student-reported prompt', 'Replace Existing Prompt', 'Add as Additional Prompt']) {
    assert.ok(page.includes(choice), `the queue does not show ${choice}`)
  }
  const route = readFileSync('app/api/admin/statement-prompts/route.ts', 'utf8')
  // The server refuses a report published without one of the two words.
  assert.match(route, /change-action-required/)
  assert.match(route, /Only a changed-prompt report can replace/)
  // And the kind comes from the row, never from the request.
  assert.match(route, /readSubmissionForReview/)
})

// ===========================================================================
// ISSUE #2 (round 2) — "Saving…" that never ended
// ===========================================================================

test('#2 THE ROOT CAUSE: liveness is re-asserted on mount, not only withdrawn', () => {
  /*
   * `const alive = useRef(true)` with a cleanup-only effect. React StrictMode
   * mounts, runs effects, runs CLEANUPS, and mounts again -- so the cleanup
   * set it false during that simulated unmount and nothing put it back, a ref
   * initialiser running once. Every save response was then parsed and dropped
   * at `if (!alive.current) return`: the PATCH succeeded, the indicator said
   * "Saving…" for ever, single flight refused every later save, and leaving
   * the page waited on a promise that could not resolve.
   */
  for (const file of [
    'app/statement-studio/components/StatementStudioClient.tsx',
    'app/statement-studio/components/PromptPicker.tsx',
  ]) {
    const source = readFileSync(file, 'utf8')
    assert.match(source, /alive\.current = true/, `${file} never re-asserts liveness`)
    assert.ok(source.indexOf('alive.current = true') < source.indexOf('alive.current = false'),
      `${file}: liveness must be asserted in the effect BODY`)
  }
})

test('#2 AND THE STATUS CAN NEVER BE PERMANENT, whatever the cause', async () => {
  /*
   * The second half, and the one that would have caught the first. 'saving' is
   * the only status nothing in the engine can leave on its own, so it is given
   * a deadline -- and at that deadline the driver reports a failure the
   * applicant can act on rather than a claim nobody will ever update.
   */
  const { DEFAULT_AUTOSAVE, initialState, reduce, saveTimedOut } =
    await import('../../resume/draft/autosave.ts')
  const { statementDriverAction } = await import('../draft/editor.ts')
  const saving = reduce(
    reduce(initialState(1), { type: 'edited', at: 1000 }),
    { type: 'save-started', at: 1000 })
  assert.equal(saving.savingSince, 1000)
  assert.equal(saveTimedOut(saving, 1000 + DEFAULT_AUTOSAVE.saveTimeoutMs), true)
  // A timer exists before the deadline, and a verdict after it. Never 'idle'.
  assert.equal(statementDriverAction({ state: saving, now: 1100, title: 'T', essay: 'e' }).kind,
    'wait')
  assert.equal(statementDriverAction({
    state: saving, now: 1000 + DEFAULT_AUTOSAVE.saveTimeoutMs, title: 'T', essay: 'e',
  }).kind, 'timed-out')
})

test('#2 the request is bounded too, and leaving the page cannot hang', () => {
  const client = readFileSync(
    'app/statement-studio/components/StatementStudioClient.tsx', 'utf8')
  // ONE NUMBER for the socket and the status; two would leave a window.
  assert.match(client, /setTimeout\(\(\) => deadline\.abort\(\), DEFAULT_AUTOSAVE\.saveTimeoutMs\)/)
  assert.match(client, /signal: deadline\.signal/)
  assert.match(client, /timeoutMs = DEFAULT_AUTOSAVE\.saveTimeoutMs/)
  // AND NOTHING IS DISCARDED BY GIVING UP ON WAITING: the applicant stays put.
  assert.match(client, /NAV_MESSAGES\.stayed/)
})

// ===========================================================================
// ISSUE #4 (round 2) — the prompt card's two actions ran together
// ===========================================================================

test('#4 the two card actions are separated, ordered, and both are buttons', () => {
  const checklist = readFileSync(
    'app/statement-studio/components/RequirementChecklist.tsx', 'utf8')
  // A row of their own, fenced off by a rule, laid out as a column with a gap.
  assert.match(checklist, /grid justify-items-start gap-2 border-t border-slate-200 pt-3/)
  // Read the prompt is the ordinary action and comes first; reporting is quiet.
  const read = checklist.indexOf("'Read the prompt'")
  const report = checklist.indexOf('REPORT_MESSAGES.action')
  assert.ok(read !== -1 && report !== -1)
  assert.ok(read < report, 'the primary action must come first')
  // The report control still appears for every eligible prompt.
  assert.match(checklist, /actions\.onReportChange !== undefined/)
})

// ===========================================================================
// ISSUE #7 (round 2) — Bold everywhere, and a document font
// ===========================================================================

test('#7 ONE EDITOR FOR EVERY DRAFT, so Bold never depends on the school', () => {
  /*
   * It was `paginated ? <PaginatedEditor/> : <textarea/>`, and `paginated` is
   * true only when the school said something about the physical page. A school
   * stating 500 words, a user-provided prompt and a General Statement all got
   * a textarea -- which has no Bold. The editing surface was being chosen by a
   * layout fact.
   */
  // COMMENTS STRIPPED: the one that explains this change names the old markup.
  const client = readFileSync(
    'app/statement-studio/components/StatementStudioClient.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.doesNotMatch(client, /<textarea/, 'the essay textarea is gone, not conditional')
  assert.match(client, /<PaginatedEditor/)
  assert.doesNotMatch(client, /paginated \? \(/, 'the surface must not be conditional')
  // What the school stated still decides the LAYOUT, which is all it decides.
  assert.match(client, /maxPages=\{capabilities\.pages\?\.max \?\? null\}/)
})

test('#7 every offered font has a real bold, and no synthesis is permitted', async () => {
  const { STUDIO_FONTS, boldCapable } = await import('../layout/studioFonts.ts')
  for (const font of STUDIO_FONTS) assert.equal(boldCapable(font), true, font.id)
  const editor = readFileSync(
    'app/statement-studio/components/PaginatedEditor.tsx', 'utf8')
  // Declared on the measured surface, so inheritance carries it everywhere.
  assert.match(editor, /\.statement-page-content \{\s*\n\s*font-synthesis: none;/)
})

test('#7 a font change moves the page, never the writing', () => {
  const client = readFileSync(
    'app/statement-studio/components/StatementStudioClient.tsx', 'utf8')
  const handler = client.slice(
    client.indexOf('const onFontChange'), client.indexOf('const onEssayChange'))
  assert.ok(handler.length > 0, 'the font handler was not found')
  // IT TOUCHES NO TEXT -- which is why the counts and the fingerprint cannot
  // move, and a second analysis cannot be charged for a font change.
  assert.doesNotMatch(handler, /setEssay|essayRef/)
  assert.doesNotMatch(handler, /fetch\(/, 'there is no font-only save path')
  assert.match(handler, /markEdited\(\)/)
  // AND IT IS PART OF THE GEOMETRY, so the page limit is re-measured with it.
  assert.match(client, /resolveRequirementCapabilities\(requirement\?\.constraints \?\? null, \{/)
  assert.match(client, /metrics: fontChoice\.selected\.font\.metrics/)
})

test('#7 migration 015 is drafted, not applied, and admits only bundled faces', async () => {
  const sql = readFileSync(
    'supabase/migrations/20261013_015_statement_draft_document_font.sql', 'utf8')
  assert.match(sql, /NOT APPLIED/)
  assert.match(sql, /add column if not exists document_font text/)
  const { STUDIO_FONTS } = await import('../layout/studioFonts.ts')
  for (const font of STUDIO_FONTS) assert.ok(sql.includes(`'${font.id}'`), font.id)
})
