/**
 * AI-QA-001: `essay` and `editorDocument` may never spell different text.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * A formatted draft stores its text twice. Nothing owned keeping the two in
 * step, and three paths moved the essay alone: a file import, a conflict
 * re-read, and any hand-made PATCH. The editor's sync effect then replaced the
 * visible content with `setContent(..., { emitUpdate: false })`, which does not
 * emit, so the document the component held never caught up.
 *
 * Two failures followed. The autosave built a body whose halves disagreed and
 * `statementSaveRequest` refused it -- so imported text sat on screen, unsaved,
 * and was lost on reload. Or a divergent pair reached the database, and on
 * reopen the editor seeded from the stale document and its first save wrote
 * that older text back over the newer essay: sentences gone, no notice, no
 * conflict, no version entry.
 *
 * THREE LAYERS NOW, and this file tests all three:
 *   DERIVATION  documentForEssay() is the one way plain text becomes a document.
 *   REFUSAL     an essay-only save of a formatted draft is refused by the write.
 *   RECOVERY    a row that already diverged opens on its essay, not its document.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  FORMATTING_REBUILT, documentForEssay, hydrationFor, statementSaveRequest,
} from './editor.ts'
import { documentMatchesEssay, documentText } from '../layout/plainText.ts'

const ESSAY = 'I worked two years in a surgical ICU. I want to become a nurse anesthetist.'
const LONGER = `${ESSAY} I have since precepted four new graduates.`

// ---------------------------------------------------------------------------
// DERIVATION
// ---------------------------------------------------------------------------

test('a derived document always matches the text it came from', () => {
  for (const text of [
    ESSAY, LONGER, 'one word', '', '   ', 'line one\nline two',
    'line one\r\nline two', 'trailing space ', 'a\n\nb\n\nc',
    'unicode — em dash, curly ’quote’, 日本語',
  ]) {
    const doc = documentForEssay(text)
    assert.ok(documentMatchesEssay(doc, text),
      `derived document disagrees with ${JSON.stringify(text)}`)
  }
})

test('and a derived document round-trips through the save validator', () => {
  const request = statementSaveRequest({
    title: 'T', essay: LONGER, revision: 3, document: documentForEssay(LONGER),
  })
  assert.equal(request.ok, true,
    request.ok ? '' : `refused with ${request.code}`)
})

// ---------------------------------------------------------------------------
// THE RACE, as the audit ran it
// ---------------------------------------------------------------------------

test('THE RACE: text set from outside the editor is saveable immediately', () => {
  /*
   * Type, then click All Drafts before the 1.2s debounce. The flush dispatches
   * the same save the autosave would have made, so the body is whatever the
   * component holds -- and before the fix an import or a re-read left it
   * holding a document for the PREVIOUS text, which this validator refuses.
   *
   * Modelled exactly as the component now does it: the one writer derives the
   * document from the text in the same breath as setting it.
   */
  const outside = (text: string) => ({ essay: text, document: documentForEssay(text) })

  // The import replaced the whole essay...
  const imported = outside('An imported statement, several words long.')
  const afterImport = statementSaveRequest({ title: 'T', revision: 4, ...imported })
  assert.equal(afterImport.ok, true,
    afterImport.ok ? '' : `an imported essay could not be saved (${afterImport.code})`)

  // ...and a conflict re-read replaced it with the server's.
  const reread = outside('The version the server already had.')
  const afterReread = statementSaveRequest({ title: 'T', revision: 5, ...reread })
  assert.equal(afterReread.ok, true,
    afterReread.ok ? '' : `a re-read essay could not be saved (${afterReread.code})`)
})

test('the OLD behaviour is what this refuses: essay moved, document left behind', () => {
  // The exact body the component used to build after an import.
  const stale = documentForEssay(ESSAY)
  const request = statementSaveRequest({
    title: 'T', essay: LONGER, revision: 6, document: stale,
  })
  assert.equal(request.ok, false)
  assert.equal(request.ok ? '' : request.code, 'invalid-essay')
})

// ---------------------------------------------------------------------------
// THE OTHER SAVES MUST BE UNAFFECTED
// ---------------------------------------------------------------------------

test('a BOLD-ONLY save is still valid, and does not change the text', () => {
  // What the editor emits: same characters, one span marked.
  const bolded = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', marks: [{ type: 'bold' }], text: 'I worked two years' },
        { type: 'text', text: ESSAY.slice('I worked two years'.length) },
      ],
    }],
  }
  assert.equal(documentText(bolded), ESSAY, 'the fixture must not change the text')
  const request = statementSaveRequest({
    title: 'T', essay: ESSAY, revision: 7, document: bolded,
  })
  assert.equal(request.ok, true, request.ok ? '' : request.code)
})

test('a FONT-ONLY save and a TITLE-ONLY save still carry the text unchanged', () => {
  const doc = documentForEssay(ESSAY)
  const font = statementSaveRequest({
    title: 'T', essay: ESSAY, revision: 8, document: doc, font: 'tinos',
  })
  assert.equal(font.ok, true, font.ok ? '' : font.code)
  const title = statementSaveRequest({
    title: 'A new title', essay: ESSAY, revision: 9, document: doc,
  })
  assert.equal(title.ok, true, title.ok ? '' : title.code)
})

test('a PLAIN draft sends no document, exactly as it always did', () => {
  const request = statementSaveRequest({ title: 'T', essay: ESSAY, revision: 10 })
  assert.equal(request.ok, true)
  assert.ok(request.ok && !('editorDocument' in (request.body as object)),
    'a plain save must not start sending a document')
})

// ---------------------------------------------------------------------------
// RECOVERY
// ---------------------------------------------------------------------------

test('a draft with no document opens as stored', () => {
  const choice = hydrationFor({ essay: ESSAY, document: null })
  assert.equal(choice.kind, 'stored')
  assert.equal(choice.document, null)
})

test('a draft whose halves AGREE keeps its formatting', () => {
  const doc = documentForEssay(ESSAY)
  const choice = hydrationFor({ essay: ESSAY, document: doc })
  assert.equal(choice.kind, 'stored')
  assert.deepEqual(choice.document, doc)
})

test('RECOVERY: a diverged row opens on its ESSAY, never on the stale document', () => {
  /*
   * The row the audit produced: essay at the newer, longer text and the
   * document still spelling the older one. Seeding from the document is what
   * destroyed the newer text on the next save.
   */
  const choice = hydrationFor({ essay: LONGER, document: documentForEssay(ESSAY) })
  assert.equal(choice.kind, 'rebuilt')
  assert.equal(documentText(choice.document), LONGER,
    'the rebuilt document must spell the ESSAY, which is the newer half')
  assert.ok(documentMatchesEssay(choice.document, LONGER))
  // And the result is immediately saveable, so the recovery is not a dead end.
  const request = statementSaveRequest({
    title: 'T', essay: LONGER, revision: 11, document: choice.document,
  })
  assert.equal(request.ok, true, request.ok ? '' : request.code)
})

test('the rebuild is announced, not silent', () => {
  assert.match(FORMATTING_REBUILT, /formatting/i)
  assert.match(FORMATTING_REBUILT, /Nothing you wrote was lost/)
})

// ---------------------------------------------------------------------------
// THE WRITE PATH, AND THE COMPONENT, SOURCE-DERIVED
// ---------------------------------------------------------------------------

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

test('the repository refuses an essay-only save of a formatted draft', () => {
  const repo = read('./draftRepo.ts')
  // The guard is in the WRITE, not a read-then-write.
  assert.match(repo, /const guardsDocument = !sendsDocument && editorDocumentsEnabled\(\)/)
  assert.match(repo, /guardsDocument \? write\.is\('editor_document', null\) : write/)
  // And it is reported as its own refusal, not as a conflict.
  assert.match(repo, /reason: 'document-required'/)
  assert.match(repo, /\| 'document-required'/)
})

test('document-required is a 422, not a 409 and not a 500', () => {
  const http = read('./http.ts')
  assert.match(http, /case 'document-required': return 422/)
})

test('and it answers with its OWN code, not a generic server error', () => {
  /*
    A 422 reported as `server-error` is neither true nor actionable: the caller
    sent an incomplete body and can fix it. Measured in the browser before this
    was added -- status 422, code 'server-error'.
  */
  const route = read('../../../app/api/statement/drafts/[id]/route.ts')
  const block = route.slice(route.indexOf("result.reason === 'document-required'"))
    .slice(0, 420)
  assert.match(block, /code: 'document-required'/)
  assert.match(block, /has to include it/)
  // And it is decided BEFORE the generic fall-through.
  assert.ok(route.indexOf("result.reason === 'document-required'")
    < route.indexOf('SERVER_ERROR_BODY, { status }'))
})

test('the component has ONE writer for text that comes from outside the editor', () => {
  const client = read('../../../app/statement-studio/components/StatementStudioClient.tsx')
  // Defined once...
  assert.equal(client.split('const applyExternalEssay = useCallback(').length - 1, 1)
  // ...and called by the import and the conflict re-read, and nothing else.
  assert.equal(client.split('applyExternalEssay(').length - 1, 2,
    'expected exactly two call sites')
  assert.match(client, /applyExternalEssay\(outcome\.document\.text\)/)
  assert.match(client, /applyExternalEssay\(outcome\.draft\.essay\)/)
  // The writer sets BOTH halves; a version that forgot the document would be
  // the original defect wearing a new name.
  const body = client.slice(client.indexOf('const applyExternalEssay = useCallback('))
    .slice(0, 600)
  assert.match(body, /essayRef\.current = text/)
  assert.match(body, /documentRef\.current = next/)
  assert.match(body, /documentForEssay\(text\)/)
  // ...and neither sets the essay behind its back any more.
  const strayImport = /setEssay\(outcome\.document\.text\)/.test(client)
  const strayReread = /setEssay\(outcome\.draft\.essay\)/.test(client)
  assert.equal(strayImport, false, 'the import still sets the essay directly')
  assert.equal(strayReread, false, 'the re-read still sets the essay directly')
  // And hydration goes through the policy rather than the stored column.
  assert.match(client, /hydrationFor\(\{ essay: draft\.essay, document: draft\.editorDocument \}\)/)
  assert.doesNotMatch(client, /useRef<unknown>\(draft\.editorDocument \?\? null\)/)
})
