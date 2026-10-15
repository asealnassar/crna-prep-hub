/**
 * The chosen font, through the real save and the real read.
 *
 * ---------------------------------------------------------------------------
 * WHAT ONLY AN END-TO-END TEST CAN SHOW
 * ---------------------------------------------------------------------------
 * studioFonts.test.ts proves what may be chosen; geometry.test.ts proves what
 * the choice does to the page. Neither can show that a choice SURVIVES -- that
 * it reaches the column, comes back from a fresh read, and does all of it
 * without moving a byte of `essay`.
 *
 * A FRESH GET IS THE REFRESH, AND ALSO THE SIGN-OUT. Reopening the editor,
 * navigating back to it, and signing in again all end in the same place: the
 * route reads the row and hands the font down. No browser state is involved.
 */
import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.font-test.json'

const STORE = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const USER = { userId: '66666666-6666-4666-8666-666666666666', email: 'them@example.invalid' }

type Handler = (request: unknown, context?: unknown) => Promise<Response>
type Row = Record<string, unknown>

let POST: Handler | null = null
let GET_ITEM: Handler | null = null
let PATCH_ITEM: Handler | null = null
let draftId = ''

const skip = typeof mock.module !== 'function'
const ESSAY = 'I chose critical care for the same reason I am choosing anesthesia.'

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
const stored = () => rows().find((row) => row.id === draftId)!

async function save(body: Row): Promise<{ status: number; draft: Row }> {
  const response = await PATCH_ITEM!(request(body), ctx(draftId))
  const parsed = await response.json() as Row
  return { status: response.status, draft: (parsed.draft ?? parsed) as Row }
}

test('a draft starts with no font, which means the Studio default', { skip }, async () => {
  rmSync(STORE, { force: true })
  const response = await POST!(request({ title: 'Font test', essay: '' }))
  const body = await response.json() as Row
  assert.equal(response.status, 201, JSON.stringify(body))
  draftId = String((body.draft as Row).id)
  // PRESENT AND NULL OVER THE WIRE, never omitted: an absent key cannot be
  // told from a server too old to send one.
  assert.equal('documentFont' in (body.draft as Row), true)
  assert.equal((body.draft as Row).documentFont, null)

  const first = await save({ title: 'Font test', essay: ESSAY, expectedRevision: 1 })
  assert.equal(first.status, 200)
  assert.equal(stored().document_font ?? null, null)
})

test('AN ORDINARY SAVE DOES NOT NAME THE FONT, so it cannot clear one', { skip }, async () => {
  // Choose one first.
  const chosen = await save({
    title: 'Font test', essay: ESSAY, expectedRevision: 2, documentFont: 'arimo',
  })
  assert.equal(chosen.status, 200)
  assert.equal(stored().document_font, 'arimo')

  // Now an ordinary keystroke's body: three keys, no font.
  const typed = await save({
    title: 'Font test', essay: `${ESSAY} More.`, expectedRevision: 3,
  })
  assert.equal(typed.status, 200)
  assert.equal(stored().document_font, 'arimo', 'typing cleared the chosen font')
})

test('A FONT-ONLY CHANGE SAVES, and does not move a byte of the essay', { skip }, async () => {
  const before = stored()
  const result = await save({
    title: 'Font test',
    essay: String(before.essay),
    expectedRevision: Number(before.revision),
    documentFont: 'tinos',
  })
  assert.equal(result.status, 200)
  const after = stored()
  assert.equal(after.document_font, 'tinos')
  // IT COUNTED AS A SAVE.
  assert.equal(Number(after.revision), Number(before.revision) + 1)
  // AND THE WRITING IS BYTE-IDENTICAL.
  assert.equal(after.essay, before.essay)
})

test('AND NO NEW PAID ANALYSIS IS OWED: the fingerprint is unmoved', { skip }, async () => {
  const { analysisFingerprint } = await import('../draft/analysisFingerprint.ts')
  const of = (essay: string) => analysisFingerprint({
    essay, promptText: null, schoolId: null, promptId: null,
    statedMaxWords: null, requirement: null,
  })
  const before = of(String(stored().essay))
  const row = stored()
  await save({
    title: 'Font test', essay: String(row.essay),
    expectedRevision: Number(row.revision), documentFont: 'arimo',
  })
  assert.equal(stored().document_font, 'arimo')
  /*
   * THE FONT IS NOT AN INPUT TO THE FINGERPRINT, and that is the whole reason
   * trying both faces is free. It is a layout preference; the analyser reads
   * the essay.
   */
  assert.equal(of(String(stored().essay)), before)
})

test('THE CHOICE SURVIVES A FRESH READ — refresh, navigate, sign out, reopen',
  { skip }, async () => {
    const response = await GET_ITEM!(request(), ctx(draftId))
    const body = await response.json() as Row
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal((body.draft as Row).documentFont, 'arimo')
  })

test('clearing it is an explicit null, and returns the Studio default', { skip }, async () => {
  const row = stored()
  const result = await save({
    title: 'Font test', essay: String(row.essay),
    expectedRevision: Number(row.revision), documentFont: null,
  })
  assert.equal(result.status, 200)
  assert.equal(stored().document_font, null)
  const read = await (await GET_ITEM!(request(), ctx(draftId))).json() as Row
  assert.equal((read.draft as Row).documentFont, null)
})

test('A FONT THIS BUILD DOES NOT SHIP IS REFUSED, and nothing is written',
  { skip }, async () => {
    const before = stored()
    for (const bogus of ['comic-sans', 'Tinos', 'Arial', '', 7, true]) {
      const result = await save({
        title: 'Font test', essay: String(before.essay),
        expectedRevision: Number(before.revision), documentFont: bogus,
      })
      assert.equal(result.status, 400, `accepted ${String(bogus)}`)
      assert.equal(result.draft.code, 'invalid-font')
    }
    const after = stored()
    assert.equal(after.revision, before.revision, 'a refusal must write nothing')
    assert.equal(after.document_font ?? null, before.document_font ?? null)
  })

test('the builder refuses it too, so an obviously bad body costs no round trip',
  { skip }, async () => {
    const { saveAttemptFor } = await import('../draft/editor.ts')
    const ok = saveAttemptFor({ title: 'T', essay: ESSAY, revision: 1, font: 'arimo' })
    assert.equal(ok.ok, true)
    if (ok.ok) assert.equal((ok.body as Row).documentFont, 'arimo')

    const cleared = saveAttemptFor({ title: 'T', essay: ESSAY, revision: 1, font: null })
    assert.equal(cleared.ok, true)
    if (cleared.ok) assert.equal((cleared.body as Row).documentFont, null)

    const absent = saveAttemptFor({ title: 'T', essay: ESSAY, revision: 1 })
    assert.equal(absent.ok, true)
    if (absent.ok) assert.equal('documentFont' in (absent.body as Row), false)

    const bad = saveAttemptFor({ title: 'T', essay: ESSAY, revision: 1, font: 'comic-sans' })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.code, 'invalid-font')
  })
