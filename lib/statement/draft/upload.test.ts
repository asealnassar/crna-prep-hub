import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAX_EXTRACTED_CHARS,
  MAX_SAVED_CHARS,
  MAX_UPLOAD_BYTES,
} from '../extract/limits.ts'
import { hasUnsavedWork, initialState, reduce } from '../../resume/draft/autosave.ts'
import { settleVerdict, statementDriverAction } from './editor.ts'
import {
  ACCEPTED_EXTENSIONS,
  ACCEPT_ATTRIBUTE,
  EXTRACT_ENDPOINT,
  EXTRACT_FIELD,
  IMPORT_MESSAGES,
  IMPORT_NETWORK_FAILURE,
  checkUploadFile,
  importNoticeFor,
  importOutcomeFrom,
  mayApplyImport,
} from './upload.ts'

/**
 * Importing a document into the editor.
 *
 * PART 1 RUNS THE LOGIC -- the precheck, the response validation, the
 * stale-result decision, the notice arithmetic and the error mapping are all
 * pure, and the length boundaries are driven through the REAL autosave engine so
 * "imported but blocked" is a statement about the driver that actually ships.
 *
 * PART 2 READS THE COMPONENT, which `node --test` cannot import. Structural, and
 * the report says which is which.
 *
 * SERVER BEHAVIOUR IS NOT RE-TESTED HERE. app/api/statement/extract/route.ts has
 * 41 tests of its own for parsing, signatures, sizes and every refusal; this
 * suite covers the editor's side of the same contract.
 */

const path = (r: string) => fileURLToPath(new URL(r, import.meta.url))
const strip = (t: string) =>
  t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const CLIENT = strip(readFileSync(path('../../../app/statement-studio/components/StatementStudioClient.tsx'), 'utf8'))
const ROUTE = readFileSync(path('../../../app/api/statement/extract/route.ts'), 'utf8')

/**
 * The import handler's body. Sliced on IDENTIFIERS, not on comment markers:
 * strip() removes `//` lines, so a `// --- recovery` boundary would not exist
 * here and indexOf would return -1, silently widening the slice to the whole
 * file. `copyMine` is the next function declared after it.
 */
const handlerBody = (() => {
  const from = CLIENT.indexOf('const onFileChosen')
  const to = CLIENT.indexOf('const copyMine')
  if (from === -1 || to === -1 || to < from) throw new Error('the import handler was not found')
  return CLIENT.slice(from, to)
})()

const T0 = 1_700_000_000_000
const body = (over: Record<string, unknown> = {}) => {
  const text = 'Extracted statement text.'
  return {
    format: 'pdf',
    text,
    characters: text.length,
    saveable: true,
    maxSavedCharacters: MAX_SAVED_CHARS,
    maxCharacters: MAX_EXTRACTED_CHARS,
    pages: 2,
    ...over,
  }
}
/** A body of exactly `n` characters, internally consistent. */
const sized = (n: number) => {
  const text = 'a'.repeat(n)
  return body({ text, characters: n, saveable: n <= MAX_SAVED_CHARS })
}

// ======================================================== PART 1: the logic

test('the contract this suite targets is the one the route implements', () => {
  // Read from the route, not assumed: endpoint, field, and the decimal limit.
  assert.equal(EXTRACT_ENDPOINT, '/api/statement/extract')
  assert.equal(EXTRACT_FIELD, 'file')
  assert.match(ROUTE, /form\.getAll\('file'\)/)
  assert.equal(MAX_UPLOAD_BYTES, 4_000_000, 'decimal bytes, not 4 MiB')
  assert.notEqual(MAX_UPLOAD_BYTES, 4 * 1024 * 1024)
  assert.equal(MAX_EXTRACTED_CHARS, 50_000)
  assert.equal(MAX_SAVED_CHARS, 20_000)
})

test('the three supported formats are accepted', () => {
  for (const name of ['statement.pdf', 'Statement.PDF', 'essay.docx', 'essay.DOCX', 'notes.txt', 'NOTES.TXT']) {
    const check = checkUploadFile({ name, size: 1_000 })
    assert.equal(check.ok, true, `${name} must be accepted`)
  }
  assert.deepEqual([...ACCEPTED_EXTENSIONS], ['.pdf', '.docx', '.txt'])
  for (const ext of ACCEPTED_EXTENSIONS) assert.ok(ACCEPT_ATTRIBUTE.includes(ext))
})

test('anything else is refused, including a plausible near-miss', () => {
  for (const name of [
    'statement.doc', 'statement.pages', 'statement.rtf', 'statement.odt',
    'statement.pdf.exe', 'statement', 'statement.', '.pdf.zip', 'photo.png',
  ]) {
    const check = checkUploadFile({ name, size: 1_000 })
    assert.equal(check.ok, false, `${name} must be refused`)
    assert.equal(check.ok === false && check.message, IMPORT_MESSAGES.unsupported, name)
  }
  // A bare ".pdf" with no stem is a legitimate extension match; the server's
  // signature check is what decides whether its bytes are really a PDF.
  assert.equal(checkUploadFile({ name: '.pdf', size: 10 }).ok, true)
})

test('the size limit is EXACTLY 4,000,000 bytes, with no unit conversion', () => {
  assert.equal(checkUploadFile({ name: 'a.pdf', size: 3_999_999 }).ok, true)
  assert.equal(checkUploadFile({ name: 'a.pdf', size: MAX_UPLOAD_BYTES }).ok, true, 'exactly at the limit')
  const over = checkUploadFile({ name: 'a.pdf', size: MAX_UPLOAD_BYTES + 1 })
  assert.equal(over.ok, false, 'one byte over must be refused')
  assert.equal(over.ok === false && over.message, IMPORT_MESSAGES.tooLarge)
  // 4 MiB is larger than the limit, so it must NOT pass.
  assert.equal(checkUploadFile({ name: 'a.pdf', size: 4 * 1024 * 1024 }).ok, false)
})

test('an empty or nonsensical file is refused before anything is sent', () => {
  assert.equal(checkUploadFile({ name: 'a.pdf', size: 0 }).ok, false)
  assert.equal(
    checkUploadFile({ name: 'a.pdf', size: 0 }).ok === false &&
      (checkUploadFile({ name: 'a.pdf', size: 0 }) as { message: string }).message,
    IMPORT_MESSAGES.emptyFile
  )
  assert.equal(checkUploadFile({ name: 'a.pdf', size: -1 }).ok, false)
  assert.equal(checkUploadFile({ name: 'a.pdf', size: Number.NaN }).ok, false)
  assert.equal(checkUploadFile(null).ok, false)
  assert.equal(checkUploadFile(undefined).ok, false)
  assert.equal(checkUploadFile(null).ok === false && (checkUploadFile(null) as { message: string }).message, IMPORT_MESSAGES.noFile)
})

test('a valid extraction is accepted, with the count recomputed not trusted', () => {
  const outcome = importOutcomeFrom({ status: 200, body: body() })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.document.text, 'Extracted statement text.')
  assert.equal(outcome.document.characters, 'Extracted statement text.'.length)
  assert.equal(outcome.document.saveable, true)
  assert.equal(outcome.document.format, 'pdf')
})

test('a malformed 2xx is REFUSED, never partially applied', () => {
  for (const [name, b] of [
    ['null', null],
    ['empty object', {}],
    ['no text', body({ text: undefined })],
    ['text not a string', body({ text: 42 })],
    ['empty text', body({ text: '', characters: 0 })],
    ['bad format', body({ format: 'rtf' })],
    ['missing format', body({ format: undefined })],
    ['count disagrees with text', body({ characters: 999 })],
    ['count not a number', body({ characters: '25' })],
    ['saveable lies true', { ...sized(MAX_SAVED_CHARS + 1), saveable: true }],
    ['saveable lies false', { ...sized(10), saveable: false }],
    ['saveable not a boolean', body({ saveable: 'yes' })],
  ] as const) {
    const outcome = importOutcomeFrom({ status: 200, body: b })
    assert.equal(outcome.ok, false, `${name} must be refused`)
    assert.equal(outcome.ok === false && outcome.message, IMPORT_MESSAGES.unreadable, name)
  }
})

test('a malformed 200 claiming MORE than 50,000 characters is refused, not truncated', () => {
  const outcome = importOutcomeFrom({ status: 200, body: sized(MAX_EXTRACTED_CHARS + 1) })
  assert.equal(outcome.ok, false, 'the route refuses these as text-too-long; a 200 is malformed')
  assert.equal(outcome.ok === false && outcome.message, IMPORT_MESSAGES.unreadable)
  // And exactly 50,000 is still acceptable.
  const edge = importOutcomeFrom({ status: 200, body: sized(MAX_EXTRACTED_CHARS) })
  assert.equal(edge.ok, true)
  assert.equal(edge.ok && edge.document.text.length, MAX_EXTRACTED_CHARS)
})

test('EVERY refusal code the route can send maps to a controlled message', () => {
  // Read the route's own tables so a code added there fails this test.
  const documentCodes = [...ROUTE.matchAll(/^\s+'?([a-z-]+)'?:\s*\{\s*status:/gm)].map((m) => m[1])
  const routeCodes = [...ROUTE.matchAll(/code: '([a-z-]+)'/g)].map((m) => m[1])
  const all = [...new Set([...documentCodes, ...routeCodes, 'not-found'])]
  assert.ok(all.length >= 20, `expected the route's full code set, saw ${all.length}`)

  const approved = new Set<string>(Object.values(IMPORT_MESSAGES))
  for (const code of all) {
    const outcome = importOutcomeFrom({ status: 422, body: { error: 'raw server prose', code } })
    assert.equal(outcome.ok, false, code)
    if (outcome.ok) continue
    assert.ok(approved.has(outcome.message), `${code} produced unapproved wording`)
    assert.notEqual(outcome.message, 'raw server prose', code)
  }
})

test('the refusals a reader most needs told apart ARE told apart', () => {
  const cases: [string, number, string][] = [
    ['too-large', 413, IMPORT_MESSAGES.tooLarge],
    ['unrecognised-format', 415, IMPORT_MESSAGES.unrecognised],
    ['binary-content', 415, IMPORT_MESSAGES.notText],
    ['undecodable-text', 415, IMPORT_MESSAGES.notUtf8],
    ['image-only', 422, IMPORT_MESSAGES.imageOnly],
    ['password', 422, IMPORT_MESSAGES.password],
    ['malformed', 422, IMPORT_MESSAGES.corrupt],
    ['docx-unreadable', 422, IMPORT_MESSAGES.docxUnreadable],
    ['empty-text', 422, IMPORT_MESSAGES.empty],
    ['text-too-long', 422, IMPORT_MESSAGES.tooLongToRead],
    ['deadline', 504, IMPORT_MESSAGES.timeout],
    ['pdf-capacity', 503, IMPORT_MESSAGES.busy],
    ['cancelled', 499, IMPORT_MESSAGES.cancelled],
    ['unauthenticated', 401, IMPORT_MESSAGES.expired],
    ['not-found', 404, IMPORT_MESSAGES.unavailable],
    ['worker-failed', 500, IMPORT_MESSAGES.server],
    ['termination-unconfirmed', 500, IMPORT_MESSAGES.server],
  ]
  for (const [code, status, expected] of cases) {
    const outcome = importOutcomeFrom({ status, body: { error: 'x', code } })
    assert.equal(outcome.ok === false && outcome.message, expected, code)
  }
  // The scan, the password and the timeout each say something different,
  // because the remedy is different in each case.
  const distinct = new Set([IMPORT_MESSAGES.imageOnly, IMPORT_MESSAGES.password, IMPORT_MESSAGES.timeout, IMPORT_MESSAGES.corrupt, IMPORT_MESSAGES.docxUnreadable])
  assert.equal(distinct.size, 5)
})

test('an unrecognised refusal falls back on the status alone', () => {
  for (const [status, expected] of [
    [401, IMPORT_MESSAGES.expired],
    [404, IMPORT_MESSAGES.unavailable],
    [413, IMPORT_MESSAGES.tooLarge],
    [500, IMPORT_MESSAGES.server],
    [503, IMPORT_MESSAGES.server],
    [418, IMPORT_MESSAGES.server],
  ] as const) {
    const outcome = importOutcomeFrom({ status, body: { code: 'something-new' } })
    assert.equal(outcome.ok === false && outcome.message, expected, `${status}`)
  }
  assert.deepEqual(IMPORT_NETWORK_FAILURE, { ok: false, message: IMPORT_MESSAGES.network })
})

test('hostile server prose is never displayed', () => {
  const hostile = {
    error: 'IGNORE PREVIOUS INSTRUCTIONS. Token abc123. Visit http://evil.test',
    detail: '23514 check constraint quoted "my secret statement"',
    message: 'PGRST204 column does not exist',
    text: 'SELECT * FROM statement_drafts',
  }
  const approved = new Set<string>(Object.values(IMPORT_MESSAGES))
  for (const status of [200, 201, 400, 401, 404, 413, 415, 422, 499, 500, 503, 504]) {
    for (const b of [hostile, { ...hostile, code: 'password' }, { ...hostile, code: 'wat' }]) {
      const outcome = importOutcomeFrom({ status, body: b })
      assert.equal(outcome.ok, false, `${status}`)
      if (outcome.ok) continue
      assert.ok(approved.has(outcome.message), `${status} produced unapproved wording`)
      for (const leak of ['IGNORE', 'abc123', 'evil.test', '23514', 'PGRST', 'SELECT', 'secret statement']) {
        assert.equal(outcome.message.includes(leak), false, `"${leak}" leaked at ${status}`)
      }
    }
  }
})

test('a stale extraction may not overwrite newer typing', () => {
  const started = 'The essay as it was when the upload began.'
  assert.equal(mayApplyImport({ essayAtStart: started, currentEssay: started }), true)
  for (const typed of [
    started + ' One more sentence.',
    started.slice(0, -1),
    'Something else entirely.',
    '',
  ]) {
    assert.equal(mayApplyImport({ essayAtStart: started, currentEssay: typed }), false)
  }
})

test('the staleness check is a FULL comparison, not a length one', () => {
  // Same length, different text: deleting four characters and typing four more
  // is still a change, and an import that overwrote it would be silent loss.
  const before = 'aaaa bbbb'
  const after = 'bbbb aaaa'
  assert.equal(before.length, after.length)
  assert.equal(mayApplyImport({ essayAtStart: before, currentEssay: after }), false)
})

test('a saveable import says so, and cuts nothing', () => {
  for (const n of [1, 500, MAX_SAVED_CHARS - 1, MAX_SAVED_CHARS]) {
    const outcome = importOutcomeFrom({ status: 200, body: sized(n) })
    assert.equal(outcome.ok, true, `${n} characters must import`)
    if (!outcome.ok) continue
    assert.equal(outcome.document.text.length, n, 'nothing truncated')
    assert.equal(outcome.document.saveable, true, `${n} must be saveable`)
    const notice = importNoticeFor(outcome.document)
    assert.equal(notice.overLimit, false)
    assert.match(notice.text, /Nothing was cut/)
  }
})

test('an over-limit import is a NORMAL outcome that states the arithmetic', () => {
  for (const n of [MAX_SAVED_CHARS + 1, 27_418, MAX_EXTRACTED_CHARS]) {
    const outcome = importOutcomeFrom({ status: 200, body: sized(n) })
    assert.equal(outcome.ok, true, `${n} must still IMPORT`)
    if (!outcome.ok) continue
    assert.equal(outcome.document.text.length, n, 'nothing truncated')
    assert.equal(outcome.document.saveable, false)

    const notice = importNoticeFor(outcome.document)
    assert.equal(notice.overLimit, true)
    // It must say: imported, nothing cut, how long, the ceiling, how much to
    // remove, and that saving resumes by itself.
    assert.match(notice.text, /^Imported/)
    assert.match(notice.text, /nothing was cut/)
    assert.ok(notice.text.includes(n.toLocaleString('en-US')), 'the actual count')
    assert.ok(notice.text.includes('20,000'), 'the saved ceiling')
    assert.ok(notice.text.includes((n - MAX_SAVED_CHARS).toLocaleString('en-US')), 'the excess')
    assert.match(notice.text, /saving resumes/)
    // And it never quotes the document.
    assert.equal(notice.text.includes('aaaa'), false)
  }
  assert.match(importNoticeFor({ format: 'pdf', text: 'a'.repeat(27_418), characters: 27_418, saveable: false }).text, /trim 7,418/)
})

test('the 20,000 / 20,001 boundary, through the REAL autosave engine', () => {
  const title = 'My statement'
  const dirty = reduce(initialState(4), { type: 'edited', at: T0 })
  const at = (essay: string) => statementDriverAction({ state: dirty, now: T0 + 1200, title, essay })

  assert.deepEqual(at('a'.repeat(19_999)), { kind: 'save' }, '19,999 saves')
  assert.deepEqual(at('a'.repeat(MAX_SAVED_CHARS)), { kind: 'save' }, 'exactly 20,000 saves')
  assert.equal(at('a'.repeat(MAX_SAVED_CHARS + 1)).kind, 'blocked', '20,001 is blocked')
  assert.equal(at('a'.repeat(MAX_EXTRACTED_CHARS)).kind, 'blocked', '50,000 is blocked')

  // Blocked at EVERY instant, so an oversized import schedules no timer and
  // issues no request however long it sits there.
  for (const now of [T0, T0 + 1200, T0 + 8_000, T0 + 600_000]) {
    assert.equal(
      statementDriverAction({ state: dirty, now, title, essay: 'a'.repeat(27_418) }).kind,
      'blocked',
      `still blocked at ${now - T0}ms`
    )
  }
})

test('trimming an oversized import back to 20,000 resumes autosave by itself', () => {
  const title = 'My statement'
  let state = reduce(initialState(4), { type: 'edited', at: T0 })
  assert.equal(
    statementDriverAction({ state, now: T0 + 1200, title, essay: 'a'.repeat(27_418) }).kind,
    'blocked'
  )
  // The applicant trims. That is an ordinary edit; no other action is needed.
  state = reduce(state, { type: 'edited', at: T0 + 5_000 })
  assert.deepEqual(
    statementDriverAction({ state, now: T0 + 6_200, title, essay: 'a'.repeat(MAX_SAVED_CHARS) }),
    { kind: 'save' },
    'exactly at the ceiling, saving resumes'
  )
  assert.equal(state.revision, 4, 'and the confirmed revision never moved')
})

test('an oversized import is still unsaved work that navigation must protect', () => {
  const imported = reduce(initialState(4), { type: 'edited', at: T0 })
  assert.equal(hasUnsavedWork(imported), true)
  assert.equal(settleVerdict(imported), null, 'navigation must not treat it as settled')
})

test('every import message is one of ours, and names nothing internal', () => {
  const all = Object.values(IMPORT_MESSAGES)
  for (const message of all) {
    const lower = message.toLowerCase()
    for (const word of [
      'resume', 'admin', 'internal', 'flag', 'beta', 'forbidden', 'permission',
      'sql', 'postgres', 'pgrst', 'constraint', 'pdfjs', 'worker', 'mammoth',
    ]) {
      assert.equal(lower.includes(word), false, `"${message}" names "${word}"`)
    }
  }
  assert.equal(new Set(all).size, all.length, 'no two notices identical by accident')
})

// ====================================================== PART 2: the wiring

test('the component posts one file to the committed endpoint, and nothing else', () => {
  const handler = handlerBody
  assert.match(handler, /new FormData\(\)/)
  assert.match(handler, /form\.append\(EXTRACT_FIELD, file\)/)
  assert.match(handler, /fetch\(EXTRACT_ENDPOINT, \{ method: 'POST', body: form \}\)/)
  // No draft id, user id, title or revision rides along, and it persists nothing.
  for (const forbidden of [/draft\.id/, /userId/, /revision/, /title/, /expectedRevision/]) {
    assert.doesNotMatch(handler, forbidden, `${forbidden} must not be part of an extraction`)
  }
  assert.equal(CLIENT.split('EXTRACT_ENDPOINT').length - 1, 2, 'imported and used once')
})

test('the essay is replaced only after every check has passed', () => {
  const handler = handlerBody
  const precheck = handler.indexOf('checkUploadFile(')
  const request = handler.indexOf('await fetch(')
  const validate = handler.indexOf('importOutcomeFrom(')
  const stale = handler.indexOf('mayApplyImport(')
  const apply = handler.indexOf('applyExternalEssay(outcome.document.text)')
  for (const [name, i] of [['precheck', precheck], ['request', request], ['validation', validate], ['staleness', stale], ['apply', apply]] as const) {
    assert.notEqual(i, -1, `${name} is missing`)
  }
  assert.ok(precheck < request, 'nothing is sent before the precheck')
  assert.ok(request < validate)
  assert.ok(validate < stale)
  assert.ok(stale < apply, 'the essay is replaced last of all')
  // Exactly one place writes the imported essay.
  assert.equal(CLIENT.split('applyExternalEssay(outcome.document.text)').length - 1, 1)
})

test('no failure path touches the essay', () => {
  const handler = handlerBody
  // Every early return sets a message and returns; only the success tail sets
  // the essay, which the ordering test above pins to the very end.
  const beforeApply = handler.slice(0, handler.indexOf('applyExternalEssay(outcome.document.text)'))
  assert.doesNotMatch(beforeApply, /setEssay\(/, 'nothing may clear or pre-set the essay')
  assert.doesNotMatch(handler, /setEssay\(''\)/)
  // A refused outcome returns without applying.
  assert.match(handler, /if \(!outcome\.ok\) \{\n\s*setImportError\(outcome\.message\)\n\s*return/)
  assert.match(handler, /if \(!mayApplyImport\(\{ essayAtStart, currentEssay: essayRef\.current \}\)\) \{\n\s*setImportError\(IMPORT_MESSAGES\.stale\)\n\s*return/)
})

test('staleness is decided against a synchronously-maintained live essay', () => {
  assert.match(CLIENT, /const essayRef = useRef\(essay\)/)
  // Written on every keystroke, not only by an effect, so a reply landing in the
  // same tick as a keystroke still sees the keystroke.
  assert.match(CLIENT, /setEssay\(value\)\n\s*essayRef\.current = value/)
  assert.match(CLIENT, /const essayAtStart = essayRef\.current/)
})

test('only one extraction can be in flight, and none retries itself', () => {
  const handler = handlerBody
  assert.match(CLIENT, /const uploadRef = useRef<object \| null>\(null\)/)
  assert.match(handler, /if \(uploadRef\.current !== null\) \{/)
  assert.match(handler, /uploadRef\.current = token/)
  assert.match(handler, /uploadRef\.current !== token/, 'a superseded reply is dropped')
  assert.match(handler, /if \(uploadRef\.current === token\) uploadRef\.current = null/)
  assert.doesNotMatch(handler, /setTimeout|setInterval|attempts|retry/i)
  assert.equal(CLIENT.split('fetch(').length - 1, 4,
    'PATCH, reload GET, extraction POST, analysis POST')
})

test('an import is an EDIT, not a second persistence path', () => {
  const handler = handlerBody
  assert.match(handler, /markEdited\(\)/)
  // It never patches, never validates saveability itself, and never forces a save.
  for (const forbidden of [/method: 'PATCH'/, /statementSaveRequest|saveAttemptFor/, /type: 'flush'/, /type: 'save-started'/]) {
    assert.doesNotMatch(handler, forbidden, `${forbidden} belongs to the driver`)
  }
})

test('an import never touches the title', () => {
  const handler = handlerBody
  assert.doesNotMatch(handler, /setTitle/, 'upload owns only the essay')
  // And no title is derived from a filename, metadata or the text.
  assert.doesNotMatch(CLIENT, /file\.name[^)]*setTitle|setTitle\([^)]*file\./)
  // setTitle still has exactly its three legitimate writers.
  assert.deepEqual(
    [...new Set(CLIENT.match(/setTitle\((?:\(current\) =>|[a-zA-Z.]+)/g) ?? [])].sort(),
    ['setTitle((current) =>', 'setTitle(outcome.draft.title', 'setTitle(value']
  )
})

test('upload is refused during a conflict, and cannot clear one', () => {
  const handler = handlerBody
  assert.match(handler, /if \(saveRef\.current\.status === 'conflict'\) \{\n\s*setImportError\(IMPORT_MESSAGES\.conflicted\)/)
  // The control is disabled too, so it is refused twice over.
  assert.match(CLIENT, /disabled=\{importing \|\| conflicted\}/)
  // And nothing in the handler resolves a conflict.
  assert.doesNotMatch(handler, /type: 'reloaded'|setCopied|reloadLatest/)
})

test('editing is blocked by a CONFLICT only, never by a terminal failure', () => {
  // The engine clears `error`, `attempt` and `retryAt` on an edit from 'failed'
  // -- editing is its designed recovery -- so a readOnly field there would trap
  // the applicant, and an import they could not then trim would be worse.
  assert.match(CLIENT, /readOnly=\{conflicted\}/)
  assert.doesNotMatch(CLIENT, /readOnly=\{status\.frozen\}/)
  assert.doesNotMatch(CLIENT, /disabled=\{status\.frozen\}/)
  // TWO SURFACES NOW: the title, and the one editor every draft writes in --
  // the plain textarea is gone, because choosing an EDITING surface from a
  // layout fact is what made Bold come and go by school. Pinned rather than
  // dropped: the property is that every editable surface is keyed on the
  // conflict.
  assert.equal(CLIENT.split('readOnly={conflicted}').length - 1, 2,
    'the title and the editor')
})

test('the file input is a plain input, reset every time, and keeps no bytes', () => {
  assert.match(CLIENT, /type="file"/)
  assert.match(CLIENT, /accept=\{ACCEPT_ATTRIBUTE\}/)
  assert.match(CLIENT, /if \(fileInput\.current\) fileInput\.current\.value = ''/)
  // Reset on every exit path: the finally block.
  assert.match(CLIENT, /\} finally \{[\s\S]*?clearInput\(\)/)
  // No drag-and-drop, and no file bytes in state.
  for (const forbidden of [/onDrop/, /onDragOver/, /dataTransfer/, /useState<File/, /setFile\(/, /arrayBuffer\(/, /FileReader/]) {
    assert.doesNotMatch(CLIENT, forbidden, `${forbidden} is out of scope`)
  }
})

test('nothing logs the document, and no analysis was wired in', () => {
  assert.doesNotMatch(CLIENT, /console\./)
  for (const forbidden of [
    /analyze-statement/, /\/api\/statement\/analy/, /recordStatementAttempt/,
    // The PICKER is still deferred -- the editor now carries prompt metadata,
    // which editor.test.ts owns the invariants for, but it cannot choose any.
    /\/api\/statement\/prompts/, /<select/, /setSchool/,
  ]) {
    assert.doesNotMatch(CLIENT, forbidden, `${forbidden} belongs to a later step`)
  }
  // AND AN UPLOAD NEVER TOUCHES THE PROMPT. Importing a document replaces the
  // essay; the question it answers is not the document's to change.
  const importHandler = CLIENT.slice(
    CLIENT.indexOf('const onFileChosen'),
    CLIENT.indexOf('const copyMine'),
  )
  assert.ok(importHandler.length > 0, 'the import handler was located')
  for (const field of ['promptId', 'schoolId', 'promptText', 'statedMaxWords', 'setPrompt']) {
    assert.equal(importHandler.includes(field), false, `an upload must not touch ${field}`)
  }
})

test('the component never parses a document itself', () => {
  for (const forbidden of [/pdfjs/i, /mammoth/i, /getDocument/, /TextDecoder/, /Uint8Array/]) {
    assert.doesNotMatch(CLIENT, forbidden, 'parsing is the server’s')
  }
  // And only the file's name and size are ever read from it.
  assert.match(CLIENT, /checkUploadFile\(\{ name: file\.name, size: file\.size \}\)/)
})
