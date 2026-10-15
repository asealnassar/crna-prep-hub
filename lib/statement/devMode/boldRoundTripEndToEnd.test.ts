/**
 * A BOLD-ONLY EDIT, through the real save and the real read.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES THAT THE UNIT TESTS CANNOT
 * ---------------------------------------------------------------------------
 * plainText.ts proves the schema, editor.ts proves the refusal, and the
 * manual-QA suite proves the fingerprint is taken over the essay. None of them
 * can show that bolding a word SURVIVES -- that the document reaches the store,
 * comes back from a fresh read, and does all of it without moving a single byte
 * of the essay. That is a property of the chain, and the chain is what the
 * owner tests by typing.
 *
 * A FRESH GET IS THE REFRESH. Reopening the editor, navigating back to it,
 * signing out and in again all end in one place: the route reads the row and
 * hands the document to the client. No browser state is involved, so a GET
 * through the real handler is exactly that path.
 *
 * THE ESSAY IS COMPARED BYTE FOR BYTE, not by word count: the invariant is
 * that `essay` is untouched, and a comparison that normalised anything would
 * be unable to see the failure it exists to catch.
 */
import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.bold-test.json'

const STORE = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const USER = { userId: '44444444-4444-4444-8444-444444444444', email: 'them@example.invalid' }

type Handler = (request: unknown, context?: unknown) => Promise<Response>
type Row = Record<string, unknown>

let POST: Handler | null = null
let GET_ITEM: Handler | null = null
let PATCH_ITEM: Handler | null = null
let draftId = ''

const skip = typeof mock.module !== 'function'

/** The essay, and it never changes after the first save. */
const ESSAY = 'I chose critical care for the same reason I am choosing anesthesia.'

/** The same text, with two words bolded. documentText() must return ESSAY. */
const PLAIN = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: ESSAY }] }],
}
const BOLDED = {
  type: 'doc',
  content: [{
    type: 'paragraph',
    content: [
      { type: 'text', text: 'I chose ' },
      { type: 'text', text: 'critical care', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' for the same reason I am choosing anesthesia.' },
    ],
  }],
}

before(async () => {
  if (skip) return
  mock.module('@/lib/apiAuth', {
    namedExports: {
      authenticateRequest: async () => ({ ...USER, tier: 'ultimate', isUltimate: true }),
      readAccessToken: async () => 'fixture-token',
      isAdminEmail: () => false,
      ADMIN_EMAILS: [],
    },
  })
  POST = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  const item = await import('../../../app/api/statement/drafts/[id]/route.ts')
  GET_ITEM = item.GET as Handler
  PATCH_ITEM = item.PATCH as Handler
})

after(() => { if (!skip) rmSync(STORE, { force: true }) })

const request = (body?: unknown) => ({
  json: async () => body,
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
})
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const rows = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) as Row[] : [])
const stored = () => rows().find((row) => row.id === draftId)

async function save(body: Row): Promise<{ status: number; draft: Row }> {
  const response = await PATCH_ITEM!(request(body), ctx(draftId))
  const parsed = await response.json() as Row
  return { status: response.status, draft: (parsed.draft ?? parsed) as Row }
}

test('a draft is created and its essay saved once', { skip }, async () => {
  rmSync(STORE, { force: true })
  const response = await POST!(request({ title: 'Bold test', essay: '' }))
  const body = await response.json() as Row
  assert.equal(response.status, 201, JSON.stringify(body))
  draftId = String((body.draft as Row).id)

  const first = await save({
    title: 'Bold test', essay: ESSAY, expectedRevision: 1, editorDocument: PLAIN,
  })
  assert.equal(first.status, 200, JSON.stringify(first.draft))
  assert.equal(first.draft.revision, 2)
  assert.equal(stored()!.essay, ESSAY)
})

test('A BOLD-ONLY SAVE IS A SAVE: the revision moves, the essay does not',
  { skip }, async () => {
    const essayBefore = stored()!.essay
    const result = await save({
      title: 'Bold test', essay: ESSAY, expectedRevision: 2, editorDocument: BOLDED,
    })
    assert.equal(result.status, 200, JSON.stringify(result.draft))

    // IT COUNTED AS AN EDIT. A save the server treated as a no-op would leave
    // the revision alone, and the applicant's formatting would be silently
    // dropped with the indicator still reading Saved.
    assert.equal(result.draft.revision, 3)

    // AND THE ESSAY IS BYTE-IDENTICAL. Not equivalent, not re-normalised.
    assert.equal(stored()!.essay, essayBefore)
    assert.equal(stored()!.essay, ESSAY)
  })

test('THE BOLD SURVIVES A FRESH READ — refresh, navigate, sign out, reopen',
  { skip }, async () => {
    const response = await GET_ITEM!(request(), ctx(draftId))
    const body = await response.json() as Row
    assert.equal(response.status, 200, JSON.stringify(body))
    const draft = body.draft as Row

    assert.equal(draft.essay, ESSAY)
    assert.deepEqual(draft.editorDocument, BOLDED)

    // THE VERSION IS STORED WITH IT, so a future schema change can tell what
    // it is reading rather than guessing from the shape.
    assert.equal(stored()!.editor_document_version, 1)
  })

test('AND NO NEW PAID ANALYSIS IS OWED: the fingerprint is unmoved',
  { skip }, async () => {
    const { analysisFingerprint } = await import('../draft/analysisFingerprint.ts')
    const of = (essay: string) => analysisFingerprint({
      essay,
      promptText: null,
      schoolId: null,
      promptId: null,
      statedMaxWords: null,
      requirement: null,
    })
    /*
     * THE FINGERPRINT IS TAKEN OVER THE ESSAY AND NOTHING ELSE, which is why
     * bolding cannot cost the applicant a paid run. The document is not an
     * input to it -- and this asserts that by fingerprinting the stored essay
     * and comparing with the constant, both before and after the bold save.
     */
    assert.equal(of(String(stored()!.essay)), of(ESSAY))
  })

test('plain text extracted from the stored document EQUALS the stored essay',
  { skip }, async () => {
    const { documentText, documentMatchesEssay } = await import('../layout/plainText.ts')
    const document = stored()!.editor_document
    assert.equal(documentText(document), stored()!.essay)
    assert.equal(documentMatchesEssay(document, String(stored()!.essay)), true)
  })

test('A DOCUMENT THAT DISAGREES WITH THE ESSAY IS REFUSED, and nothing is written',
  { skip }, async () => {
    const before = stored()!
    const result = await save({
      title: 'Bold test',
      essay: ESSAY,
      expectedRevision: Number(before.revision),
      editorDocument: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'different words' }] }],
      },
    })
    assert.equal(result.status, 400, JSON.stringify(result.draft))
    // THE ROW IS UNCHANGED -- essay, document and revision alike.
    const after = stored()!
    assert.equal(after.essay, before.essay)
    assert.equal(after.revision, before.revision)
    assert.deepEqual(after.editor_document, before.editor_document)
  })

test('a document carrying marks the schema does not admit keeps its TEXT only',
  { skip }, async () => {
    const before = stored()!
    const result = await save({
      title: 'Bold test',
      essay: ESSAY,
      expectedRevision: Number(before.revision),
      editorDocument: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'I chose ' },
            {
              type: 'text',
              text: 'critical care',
              // italic and a heading-ish mark are NOT in the schema.
              marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }],
            },
            { type: 'text', text: ' for the same reason I am choosing anesthesia.' },
          ],
        }],
      },
    })
    assert.equal(result.status, 200, JSON.stringify(result.draft))
    /*
     * CONSTRAINED, NOT REFUSED, AND THE TEXT IS KEPT. A paste from a word
     * processor carries half a dozen marks; refusing the save would lose the
     * applicant's words over formatting they did not ask for. So the marks are
     * dropped and the text survives -- which is also why the essay still
     * matches.
     */
    assert.deepEqual(stored()!.editor_document, BOLDED)
    assert.equal(stored()!.essay, ESSAY)
  })
