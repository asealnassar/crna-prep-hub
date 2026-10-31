import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  REPORT_MESSAGES,
  canReportNow,
  emptyPromptChangeReport,
  newPromptChangeRequest,
  reportIsComplete,
} from './promptChangeReport.ts'
import { PROMPT_STATUS_LABELS, checkPromptSubmission } from './promptSubmission.ts'
import { SCHOOL_CHOICE_RESET } from './newDraft.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const DIALOG = stripTs(read('../../../app/statement-studio/components/NewDraftDialog.tsx'))
const CHECKLIST = stripTs(read('../../../app/statement-studio/components/RequirementChecklist.tsx'))
const ADMIN_PAGE = stripTs(read('../../../app/admin/statement-prompts/page.tsx'))
const ADMIN_ROUTE = stripTs(read('../../../app/api/admin/statement-prompts/route.ts'))
const EDITOR = stripTs(read('../../../app/admin/statement-prompts/PromotionEditor.tsx'))

const REQUIREMENT = 'a8482c8f-c8dd-5150-8e9f-12fb3326db46'
const SCHOOL = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const WORDING = 'Tell us, in 500 words, why you want to become a nurse anesthetist.'

const complete = () => ({
  requirementId: REQUIREMENT, promptText: WORDING, confirmed: true,
})

// ===========================================================================
// THE REQUEST CARRIES THE ONE FACT A NEW PROMPT CANNOT
// ===========================================================================

test('a report names the row it contradicts, and declares itself a report', () => {
  const built = newPromptChangeRequest('My statement', SCHOOL, complete())
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.body.promptSubmission.kind, 'prompt-change')
  assert.equal(built.body.promptSubmission.challengedRequirementId, REQUIREMENT)
  assert.equal(built.body.promptSubmission.promptText, WORDING)
  assert.equal(built.body.promptSubmission.schoolId, SCHOOL)
  // CONSENT IS A LITERAL true, not the applicant's value passed through: the
  // builder refuses an unconfirmed report rather than forwarding `false`.
  assert.equal(built.body.promptSubmission.confirmed, true)
})

test('NO SOURCE URL AND NO APPLICATION CYCLE — not blank, ABSENT', () => {
  const built = newPromptChangeRequest('My statement', SCHOOL, complete())
  assert.equal(built.ok, true)
  if (!built.ok) return
  const keys = Object.keys(built.body.promptSubmission)
  /*
   * ASSERTED AS ABSENCE OF A KEY, not as a null value. A key present and null
   * is a field a future screen can start filling in; a key that does not exist
   * has to be added deliberately, and adding it fails this test.
   */
  assert.equal(keys.includes('sourceUrl'), false)
  assert.equal(keys.includes('applicationCycle'), false)
  // AND NO CATALOG ID. A reported prompt must not travel the path that means
  // "the catalog vouches for this".
  assert.equal(keys.includes('promptId'), false)
  assert.equal(Object.keys(built.body).includes('promptId'), false)
})

test('the server accepts exactly what the builder sends', () => {
  const built = newPromptChangeRequest('My statement', SCHOOL, complete())
  assert.equal(built.ok, true)
  if (!built.ok) return
  const checked = checkPromptSubmission(built.body.promptSubmission)
  assert.equal(checked.ok, true, checked.ok ? '' : checked.code)
  if (!checked.ok) return
  assert.equal(checked.input.kind, 'prompt-change')
  assert.equal(checked.input.challengedRequirementId, REQUIREMENT)
  // THE TWO FIELDS THE FORM DOES NOT HAVE READ AS "NOT STATED", which is the
  // truth: nobody was asked.
  assert.equal(checked.input.sourceUrl, null)
  assert.equal(checked.input.applicationCycle, null)
})

// ===========================================================================
// WHAT IS REQUIRED, AND WHAT IS REFUSED
// ===========================================================================

test('wording and consent are required; nothing else is', () => {
  assert.equal(reportIsComplete(complete()), true)
  assert.equal(reportIsComplete({ ...complete(), promptText: '   ' }), false)
  assert.equal(reportIsComplete({ ...complete(), confirmed: false }), false)
  assert.equal(reportIsComplete({ ...complete(), requirementId: 'not-a-uuid' }), false)
  assert.equal(reportIsComplete(null), false)
  assert.equal(reportIsComplete(emptyPromptChangeReport(REQUIREMENT)), false)
})

test('an empty report starts on its requirement and consents to nothing', () => {
  const empty = emptyPromptChangeReport(REQUIREMENT)
  assert.equal(empty.requirementId, REQUIREMENT)
  assert.equal(empty.promptText, '')
  assert.equal(empty.confirmed, false)
})

test('Submit is closed without a school, a title, wording or consent', () => {
  const base = {
    title: 'My statement', schoolId: SCHOOL, report: complete(),
    submitting: false, retryable: true,
  }
  assert.equal(canReportNow(base), true)
  assert.equal(canReportNow({ ...base, schoolId: null }), false)
  assert.equal(canReportNow({ ...base, title: '  ' }), false)
  assert.equal(canReportNow({ ...base, submitting: true }), false)
  assert.equal(canReportNow({ ...base, retryable: false }), false)
  assert.equal(canReportNow({ ...base, report: null }), false)
  assert.equal(canReportNow({ ...base, report: { ...complete(), confirmed: false } }), false)
})

test('a refused report explains itself rather than failing silently', () => {
  const noTitle = newPromptChangeRequest('   ', SCHOOL, complete())
  assert.equal(noTitle.ok, false)
  const noSchool = newPromptChangeRequest('My statement', null, complete())
  assert.equal(noSchool.ok, false)
  if (!noSchool.ok) assert.equal(noSchool.message, REPORT_MESSAGES.incomplete)
  const noWording = newPromptChangeRequest(
    'My statement', SCHOOL, { ...complete(), promptText: '' })
  assert.equal(noWording.ok, false)
})

// ===========================================================================
// THE WORDING
// ===========================================================================

test('the control says what is wrong, in the owner’s words', () => {
  assert.equal(REPORT_MESSAGES.action, 'Report: This Prompt Has Changed')
})

test('the draft a report creates is labelled exactly as a pending submission is', () => {
  // ONE SENTENCE, ONE SOURCE. The report screen promises a label and
  // promptStatusLabel() renders it afterwards; two copies could disagree.
  assert.equal(REPORT_MESSAGES.badge, PROMPT_STATUS_LABELS.pending)
  assert.match(REPORT_MESSAGES.badge, /Not yet verified by CRNAPREPHUB/)
})

test('the notice says both halves: the prompt may be shared, the essay never is', () => {
  assert.match(REPORT_MESSAGES.notice, /reviewed by CRNAPREPHUB/i)
  assert.match(REPORT_MESSAGES.notice, /remain private/i)
})

// ===========================================================================
// ZERO SCHOOL-NAME CONDITIONALS
// ===========================================================================

test('NOTHING IN THIS FEATURE BRANCHES ON A SCHOOL', () => {
  /*
   * The owner's standing rule. A report is about a requirement id, and every
   * surface resolves what to show from that id -- so a school's name never
   * reaches a condition. Asserted over the source of all six files the feature
   * touches, with comments stripped so prose naming a school is not a failure.
   */
  const sources: readonly [string, string][] = [
    ['promptChangeReport.ts', stripTs(read('./promptChangeReport.ts'))],
    ['NewDraftDialog.tsx', DIALOG],
    ['RequirementChecklist.tsx', CHECKLIST],
    ['admin page.tsx', ADMIN_PAGE],
    ['admin route.ts', ADMIN_ROUTE],
    ['PromotionEditor.tsx', EDITOR],
  ]
  for (const [name, source] of sources) {
    // BOTH SPELLINGS OF CEDAR. The catalog's own value is 'Ceder Crest' -- the
    // school's name as the import found it -- so a conditional written against
    // the real data would use that one.
    for (const school of ['Boston College', 'Cedar Crest', 'Ceder Crest',
      'Keiser', 'Rush', 'Duke', 'Goldfarb', 'Saint Mary', 'New Mexico State']) {
      assert.equal(source.includes(school), false,
        `${name} names ${school}; this feature must be generic`)
    }
  }
})

// ===========================================================================
// THE WIRING, ASSERTED OVER SOURCE
// ===========================================================================

test('the checklist offers the control only where a handler exists', () => {
  // THE PREVIEW SURFACES PASS NO HANDLER, so they render no control: a visual
  // preview that submitted reports would be writing data.
  assert.match(CHECKLIST, /actions\.onReportChange !== undefined/)
  assert.match(CHECKLIST, /actions\.onReportChange\?\.\(card\.requirementId\)/)
  // ONE SENTENCE, FROM THE MODULE. A second copy in JSX could drift.
  assert.match(CHECKLIST, /REPORT_MESSAGES\.action/)
  assert.equal(CHECKLIST.includes('Report: This Prompt Has Changed'), false)
  for (const surface of [
    '../../../app/statement-studio/components/RequirementPreview.tsx',
    '../../../app/statement-studio/components/CatalogReview.tsx',
  ]) {
    assert.equal(read(surface).includes('onReportChange'), false,
      `${surface} must not submit reports`)
  }
})

test('the dialog clears the report wherever it clears a pasted prompt', () => {
  /*
   * A REPORT AND A PASTE ARE MUTUALLY EXCLUSIVE, and submit() checks the
   * report FIRST -- so a report left behind by a transition does not merely
   * look wrong, it sends the wrong body entirely. Every handler that clears
   * `pasted` must clear `report`.
   */
  assert.match(DIALOG, /newPromptChangeRequest\(title, school === null \? null : school\.id, report\)/)
  const clears = DIALOG.split('setPasted(')
  assert.ok(clears.length >= 5, 'the dialog no longer clears pasted where it used to')
  assert.match(DIALOG, /setReport\(SCHOOL_CHOICE_RESET\.report\)/)
  assert.equal(SCHOOL_CHOICE_RESET.report, null)
  // The report is reset when the dialog opens, too.
  assert.match(DIALOG, /setReport\(null\)/)
  // AND IT CANNOT CARRY A REQUIREMENT ID: that would be a second question.
  assert.match(DIALOG, /setReport\(emptyPromptChangeReport\(id\)\)\s*\n\s*setRequirementId\(null\)/)
})

test('a report is stopped by the same rollout gate a pasted prompt is', () => {
  // It is a submission: the same table, the same function, the same limit.
  assert.match(DIALOG, /\(pasted !== null \|\| report !== null\)\s*\n?\s*&& !pasteSubmissionAllowed/)
})

// ===========================================================================
// THE ADMIN QUEUE'S FOUR CHOICES
// ===========================================================================

test('the queue names the report, and shows both prompts side by side', () => {
  assert.match(ADMIN_PAGE, /Prompt Change Report/)
  assert.match(ADMIN_PAGE, /Current catalog prompt/)
  assert.match(ADMIN_PAGE, /Student-reported prompt/)
  // OUR SIDE COMES FROM THE SERVER'S RESOLUTION OF THE ID, not from the row.
  assert.match(ADMIN_PAGE, /challenged\[row\.id\]/)
})

test('FOUR CHOICES, ALL NAMED, AND NO Approve ON A REPORT', () => {
  for (const choice of ['Replace Existing Prompt', 'Add as Additional Prompt',
    'Reject', 'Duplicate']) {
    assert.ok(ADMIN_PAGE.includes(choice), `the queue does not offer ${choice}`)
  }
  /*
   * Approving a report would record a yes without saying to WHAT. The generic
   * Approve button is still there for a NEW prompt, so the assertion is that
   * the report branch is the one without it: the report's own control block
   * offers Reject and Duplicate and nothing else.
   */
  const reportBlock = ADMIN_PAGE.slice(
    ADMIN_PAGE.indexOf("row.status === 'pending' && row.kind === 'prompt-change'"),
    ADMIN_PAGE.indexOf("row.status === 'pending' && row.kind !== 'prompt-change'"))
  assert.ok(reportBlock.length > 200, 'the report decision block was not found')
  assert.equal(reportBlock.includes('Approve'), false)
  assert.equal(reportBlock.includes('Catalog label'), false)
})

test('REPLACE VS ADD IS NEVER INFERRED — the server refuses a report without it', () => {
  assert.match(ADMIN_ROUTE, /change-action-required/)
  assert.match(ADMIN_ROUTE, /not-a-report/)
  // The kind is read from the ROW, never from the request body.
  assert.match(ADMIN_ROUTE, /readSubmissionForReview\(guard\.admin, id\)/)
  assert.match(ADMIN_ROUTE, /submission\.value\.kind === 'prompt-change'/)
  /*
    REPLACEMENT IS NO LONGER REFUSED FOR A MIGRATION THAT IS APPLIED.

    This asserted `needs-012`, a hard refusal whose message read "Replacing a
    prompt needs migration 012, which is not applied". 20261008_012 IS applied
    -- hardened, even -- so the sentence became false and the refusal became
    unreachable capability rather than safety. The promotion function records
    the supersession itself, and the route now checks what the function actually
    did instead of what it believes about migrations.

    SO THE TRIPWIRE MOVED RATHER THAN BEING REMOVED. It now pins the
    replacement: the route reads the id the RPC says it linked, and reports a
    named error when the deployed function recorded nothing.

    AND IT MOVED A SECOND TIME, FOR THE SAME REASON. It named 20261028_019A /
    019B, which is what the earlier draft was going to ship. D2 shipped as
    20261028_022 instead: 019A and 019B were generated over 018, so each
    carries D3 as well, and each places the challenged-requirement check after
    the two INSERTs, where a refusal leaves an orphan set and requirement
    behind. A route that told an operator to apply one of them would be telling
    them to revert the ordering 022 exists to fix.
  */
  assert.doesNotMatch(ADMIN_ROUTE, /needs-012/, 'the stale refusal is gone')
  assert.match(ADMIN_ROUTE, /typeof result\.supersedes === 'string'/)
  assert.match(ADMIN_ROUTE, /Migration 20261028_022 is not applied\./)
  assert.doesNotMatch(ADMIN_ROUTE, /019A or 019B is not applied/)
  // The supersession is recorded AFTER the replacement exists.
  assert.ok(ADMIN_ROUTE.indexOf('recordLocalSupersession')
    > ADMIN_ROUTE.indexOf('promote_statement_submission_to_requirement'),
    'the replacement must exist before the supersession is recorded')
})

test('the editor carries the chosen word and says which outcome it will produce', () => {
  assert.match(EDITOR, /changeAction/)
  assert.match(EDITOR, /\.\.\.\(changeAction === null \? \{\} : \{ changeAction \}\)/)
  // BOTH consequences are spelled out, including "nothing is removed".
  assert.match(EDITOR, /stops offering the/)
  assert.match(EDITOR, /left exactly as it is and keeps being offered/)
  // AND THERE IS NO CONTROL FOR IT HERE: the choice is made before this opens.
  assert.equal(EDITOR.includes('setChangeAction'), false)
})

// ===========================================================================
// A REAL RENDER, NOT ONLY A SOURCE MATCH
// ===========================================================================

test('THE CONTROL RENDERS ON EVERY CARD, and on none without a handler',
  async () => {
    /*
     * The source assertions above prove the JSX is wired to the right handler.
     * They cannot prove it renders -- a mistake in the surrounding markup
     * compiles, type-checks, matches every regex and throws at runtime. So the
     * real component is rendered with a real fixture set.
     *
     * UC Davis is a FIXTURE here and nothing more: it is used because it has
     * several documents, so "on every card" is a claim with something to
     * count. No assertion depends on which school it is.
     */
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { checklistView } = await import('../requirements/checklistView.ts')
    const { UC_DAVIS } = await import('../requirements/fixtures.ts')
    const Checklist = (await import(
      '../../../app/statement-studio/components/RequirementChecklist.tsx')).default

    const view = checklistView({ set: UC_DAVIS, drafts: [] })
    const documents = view.rows.filter((row) => row.kind === 'document').length
    assert.ok(documents >= 2, 'the fixture has too few documents to count')

    const withHandler = renderToStaticMarkup(createElement(Checklist, {
      view,
      actions: { onStart: () => {}, draftHref: () => '#', onReportChange: () => {} },
    }))
    assert.equal(withHandler.split(REPORT_MESSAGES.action).length - 1, documents,
      'the control must appear once per document card')

    // THE PREVIEW SURFACES PASS NO HANDLER, and render no control at all.
    const withoutHandler = renderToStaticMarkup(createElement(Checklist, {
      view,
      actions: { onStart: () => {}, draftHref: () => '#' },
    }))
    assert.equal(withoutHandler.includes(REPORT_MESSAGES.action), false)
    // AND LOSING IT COSTS NOTHING ELSE: the cards are otherwise identical.
    assert.equal(
      withHandler.replaceAll(/<button type="button"[^>]*>Report:[^<]*<\/button>/g, ''),
      withoutHandler.replaceAll(/<button type="button"[^>]*>Report:[^<]*<\/button>/g, ''))
  })

// ===========================================================================
// THE CARD'S ACTION ROW — two controls, never one sentence
// ===========================================================================

test('READ THE PROMPT IS THE PRIMARY ACTION, and reporting is under it', async () => {
  /*
   * The owner read the card as "Report: This Prompt Has ChangedRead the
   * prompt" -- two bare underlined controls with nothing between them. The fix
   * is structural, so it is asserted structurally: they are siblings in a
   * grid, in that order, with a gap and a rule above them.
   */
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { checklistView } = await import('../requirements/checklistView.ts')
  const { UC_DAVIS } = await import('../requirements/fixtures.ts')
  const Checklist = (await import(
    '../../../app/statement-studio/components/RequirementChecklist.tsx')).default

  const html = renderToStaticMarkup(createElement(Checklist, {
    view: checklistView({ set: UC_DAVIS, drafts: [] }),
    actions: { onStart: () => {}, draftHref: () => '#', onReportChange: () => {} },
  }))

  /*
   * NO CONCATENATION: each label is inside its own element, so there is no
   * point in the markup where the two texts are adjacent. (Whether they SIT
   * apart is a layout fact, measured in the browser: 8px between them at both
   * 375px and desktop width, never on the same line.)
   */
  assert.doesNotMatch(html, /Changed\s*Read the prompt/)
  assert.doesNotMatch(html, /prompt\s*Report: This/)

  // ORDER: the ordinary action comes first.
  const read = html.indexOf('Read the prompt')
  const report = html.indexOf(REPORT_MESSAGES.action)
  assert.ok(read !== -1 && report !== -1)
  assert.ok(read < report, 'Read the prompt must precede the report link')

  // THE ROW IS FENCED OFF and lays them out as a column with a gap.
  assert.match(CHECKLIST, /border-t border-slate-200 pt-3/)
  assert.match(CHECKLIST, /grid justify-items-start gap-2/)
})

test('they are different KINDS of control, and both are reachable', () => {
  // Read the prompt is a bordered, touch-sized button; reporting is quiet text.
  // ANCHORED ON CODE: CHECKLIST is comment-stripped, so a comment is not there.
  const start = CHECKLIST.indexOf('grid justify-items-start gap-2')
  assert.notEqual(start, -1, 'the action row was not found')
  const row = CHECKLIST.slice(start)
  assert.match(row, /rounded-lg border border-slate-300 bg-white px-3 py-2[^"]*text-blue-700/)
  assert.match(row, /text-\[11px\] font-semibold text-slate-500 underline/)
  // BOTH CARRY A VISIBLE FOCUS RING. A control that can only be found with a
  // mouse is a control some readers do not have.
  const buttons = row.split('<button').slice(1, 3)
  for (const button of buttons) {
    assert.match(button.slice(0, 900), /focus-visible:ring-2/)
    assert.match(button.slice(0, 900), /focus-visible:ring-offset-2/)
  }
  // And neither is a bare anchor to nowhere.
  assert.equal(row.includes('href="#"'), false)
})

test('the row is a column at EVERY width, so it cannot re-concatenate', () => {
  /*
   * A row that becomes two lines on a narrow screen is a row that can run
   * together again. There is no `sm:flex-row` here and no `flex-wrap`: it is a
   * grid with one column and a gap, at 375px and at 1440px alike.
   */
  const start = CHECKLIST.indexOf('grid justify-items-start gap-2')
  assert.notEqual(start, -1, 'the action row was not found')
  // The container's own class list, read back from its opening tag.
  const container = CHECKLIST.slice(CHECKLIST.lastIndexOf('<div', start), start + 60)
  assert.doesNotMatch(container, /flex-row|flex-wrap|sm:|md:|lg:/)
  assert.match(container, /grid/)
})
