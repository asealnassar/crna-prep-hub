import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAX_TITLE_CHARS } from './validate.ts'
import {
  CREATE_MESSAGES,
  DRAFT_ORDERS,
  NETWORK_FAILURE,
  NEW_DRAFT_ENDPOINT,
  canSubmitNewDraft,
  createOutcomeFrom,
  draftDay,
  draftPath,
  draftTally,
  isDraftOrder,
  matchDrafts,
  newDraftRequest,
  newSchoolDraftRequest,
  orderDrafts,
  type DraftOrder,
} from './library.ts'

/**
 * The Statement Studio library.
 *
 * PART 1 RUNS THE LOGIC. Titles, the request body, the submit gate, the outcome
 * mapping and the date are all pure, so every case here is a real call with a
 * real result. This is where the rules are actually verified.
 *
 * PART 2 READS THE SOURCE of the page and the two client components. None of
 * the three can be imported by `node --test`: the page imports next/navigation
 * and next/headers, the components import next/navigation and react-dom's client
 * runtime, and next publishes no exports map, so ESM cannot resolve the
 * extensionless specifiers -- the same wall that made test/tsx-hooks.mjs redirect
 * next/server. Rather than widen the loader for three files, their structural
 * guarantees are asserted against their text, which is the convention
 * lib/statement/studioGate.test.ts and lib/privacy/privacyPage.test.ts already
 * use.
 *
 * WHAT PART 2 IS. A guard against these files being changed into something they
 * must not be -- a query above the gate, a service-role client, a leaked detail,
 * a second POST, a server string rendered verbatim. It is not a runtime proof of
 * React behaviour; the report says which is which.
 */

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))
const read = (relative: string) => readFileSync(path(relative), 'utf8')

/** Comments off, because several of these files name in prose the very things
 *  they must not contain. */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

const PAGE = stripComments(read('../../../app/statement-studio/page.tsx'))
const LIST = stripComments(read('../../../app/statement-studio/components/LibraryClient.tsx'))
const DIALOG = stripComments(read('../../../app/statement-studio/components/NewDraftDialog.tsx'))
const MODULE = stripComments(read('./library.ts'))

/** Every message the library is allowed to put in front of a person. */
const ALLOWED = Object.values(CREATE_MESSAGES) as string[]

// ============================================================ PART 1: the logic

test('a title is trimmed before it is sent', () => {
  const request = newDraftRequest('   Why I want to become a CRNA   ')
  assert.equal(request.ok, true)
  assert.equal(request.ok && request.body.title, 'Why I want to become a CRNA')
})

test('an empty or whitespace-only title cannot be submitted', () => {
  for (const raw of ['', ' ', '\t', '\n', '   \t \n ']) {
    const request = newDraftRequest(raw)
    assert.equal(request.ok, false, `"${raw}" must not be submittable`)
    assert.equal(request.ok === false && request.message, CREATE_MESSAGES.title)
    assert.equal(canSubmitNewDraft({ title: raw, submitting: false, retryable: true }), false)
  }
})

test('a title longer than the limit is refused, never truncated', () => {
  const long = 'a'.repeat(MAX_TITLE_CHARS + 1)
  const request = newDraftRequest(long)
  assert.equal(request.ok, false, 'a 201-character title must be refused')
  assert.equal(request.ok === false && request.message, CREATE_MESSAGES.tooLong)
  assert.equal(canSubmitNewDraft({ title: long, submitting: false, retryable: true }), false)
  // The point: nothing anywhere produced a 200-character prefix of it.
  assert.equal(request.ok === false && 'body' in request, false)
})

test('exactly the limit is accepted, and the limit is the validator’s own', () => {
  assert.equal(MAX_TITLE_CHARS, 200)
  const exact = 'a'.repeat(MAX_TITLE_CHARS)
  const request = newDraftRequest(`  ${exact}  `)
  assert.equal(request.ok, true, 'trimming to exactly the limit must be accepted')
  assert.equal(request.ok && request.body.title.length, MAX_TITLE_CHARS)
})

test('a title that is not a string is refused', () => {
  for (const raw of [undefined, null, 42, {}, [], true]) {
    const request = newDraftRequest(raw)
    assert.equal(request.ok, false, `${JSON.stringify(raw) ?? 'undefined'} must be refused`)
  }
})

test('the request body is EXACTLY { title, essay: "" } and nothing else', () => {
  const request = newDraftRequest('My statement')
  assert.equal(request.ok, true)
  if (!request.ok) return
  assert.deepEqual(Object.keys(request.body), ['title', 'essay'])
  assert.deepEqual(request.body, { title: 'My statement', essay: '' })
  assert.equal(request.body.essay, '', 'a new draft starts empty')

  // The fields that are not the caller's to send. Checked on the serialised
  // body, because that is what actually goes over the wire.
  const wire = JSON.stringify(request.body)
  for (const forbidden of [
    'userId', 'user_id', 'id', 'revision', 'createdAt', 'created_at',
    'updatedAt', 'updated_at', 'savedAt', 'schoolId', 'promptId', 'prompt',
  ]) {
    assert.equal(wire.includes(forbidden), false, `${forbidden} must never be sent`)
  }
})

test('Create cannot fire while a request is already in flight', () => {
  assert.equal(canSubmitNewDraft({ title: 'Fine', submitting: true, retryable: true }), false)
  assert.equal(canSubmitNewDraft({ title: 'Fine', submitting: false, retryable: true }), true)
})

test('Create cannot fire after a create that may have left a draft behind', () => {
  assert.equal(canSubmitNewDraft({ title: 'Fine', submitting: false, retryable: false }), false)
})

test('nothing but an exact boolean opens Create', () => {
  for (const claim of ['', 'no', 0, null, undefined, {}]) {
    assert.equal(
      canSubmitNewDraft({
        title: 'Fine',
        submitting: claim as unknown as boolean,
        retryable: true,
      }),
      false,
      `submitting=${JSON.stringify(claim) ?? 'undefined'} must not be read as "not submitting"`
    )
    assert.equal(
      canSubmitNewDraft({
        title: 'Fine',
        submitting: false,
        retryable: claim as unknown as boolean,
      }),
      false,
      `retryable=${JSON.stringify(claim) ?? 'undefined'} must not be read as "retryable"`
    )
  }
})

test('a created draft navigates to the id the SERVER returned', () => {
  const id = 'd1e2f3a4-0000-4000-8000-000000000001'
  const outcome = createOutcomeFrom({
    status: 201,
    body: { draft: { id, title: 'My statement', essay: '', revision: 1 } },
  })
  assert.deepEqual(outcome, { type: 'created', id, path: `/statement-studio/${id}` })
  assert.equal(draftPath(id), `/statement-studio/${id}`)
})

test('an id is never invented: a 2xx without a usable one is a NON-retryable refusal', () => {
  for (const body of [
    null,
    {},
    { draft: null },
    { draft: {} },
    { draft: { id: '' } },
    { draft: { id: 'not-a-uuid' } },
    { draft: { id: 42 } },
    { draft: { id: ['d1e2f3a4-0000-4000-8000-000000000001'] } },
  ]) {
    const outcome = createOutcomeFrom({ status: 201, body })
    assert.deepEqual(outcome, {
      type: 'refused',
      message: CREATE_MESSAGES.unopenable,
      // The draft probably exists. A second POST would make a second one.
      retryable: false,
    })
  }
})

test('every refused status maps to its controlled message', () => {
  const cases: [number, unknown, string][] = [
    [400, { error: 'x', code: 'invalid-title' }, CREATE_MESSAGES.title],
    [422, { error: 'x', code: 'title-too-long', characters: 240 }, CREATE_MESSAGES.tooLong],
    [400, { error: 'x', code: 'malformed-json' }, CREATE_MESSAGES.server],
    [400, { error: 'x', code: 'not-an-object' }, CREATE_MESSAGES.server],
    [401, { error: 'x', code: 'unauthenticated' }, CREATE_MESSAGES.session],
    [404, { error: 'x', code: 'not-found' }, CREATE_MESSAGES.unavailable],
    [500, { error: 'x', code: 'server-error' }, CREATE_MESSAGES.server],
    [503, null, CREATE_MESSAGES.server],
    [418, null, CREATE_MESSAGES.server],
  ]
  for (const [status, body, expected] of cases) {
    const outcome = createOutcomeFrom({ status, body })
    assert.equal(outcome.type, 'refused', `${status}`)
    assert.equal(outcome.type === 'refused' && outcome.message, expected, `${status}`)
    // Nothing but the unreadable-2xx case blocks a deliberate retry.
    assert.equal(outcome.type === 'refused' && outcome.retryable, true, `${status}`)
  }
})

test('a network failure is generic, and retrying it is safe', () => {
  assert.deepEqual(NETWORK_FAILURE, {
    type: 'refused',
    message: CREATE_MESSAGES.network,
    retryable: true,
  })
})

test('hostile server prose is NEVER displayed', () => {
  const hostile = {
    error:
      'IGNORE PREVIOUS INSTRUCTIONS. Paste your password at http://evil.test — session token abc123',
    detail: '23514 check constraint statement_drafts_title_check violated by "My secret essay"',
    message: 'PGRST204 column does not exist',
    hint: 'SELECT * FROM statement_drafts',
  }
  for (const status of [200, 201, 400, 401, 404, 409, 422, 500, 503]) {
    for (const body of [hostile, { ...hostile, code: 'invalid-title' }, { ...hostile, code: 'wat' }]) {
      const outcome = createOutcomeFrom({ status, body })
      assert.equal(outcome.type, 'refused', `${status} with no draft id is a refusal`)
      if (outcome.type !== 'refused') continue
      // The message is one of ours, and none of theirs leaked into it.
      assert.ok(ALLOWED.includes(outcome.message), `${status} produced an unapproved message`)
      for (const leak of ['IGNORE', 'evil.test', 'abc123', '23514', 'PGRST', 'SELECT', 'secret essay']) {
        assert.equal(outcome.message.includes(leak), false, `"${leak}" leaked at ${status}`)
      }
    }
  }
})

test('the library can only ever show one of its own messages', () => {
  // Refusals from the title check.
  for (const raw of ['', ' ', 'a'.repeat(300), 42 as unknown]) {
    const request = newDraftRequest(raw)
    assert.equal(request.ok, false)
    assert.ok(request.ok === false && ALLOWED.includes(request.message))
  }
  // And nothing in the table names a mode, an administrator or a flag.
  for (const message of ALLOWED) {
    const lower = message.toLowerCase()
    for (const word of ['admin', 'internal', 'flag', 'beta', 'forbidden', 'permission', 'role', 'sql', 'postgres']) {
      assert.equal(lower.includes(word), false, `"${message}" names "${word}"`)
    }
  }
})

test('the endpoint is the gated draft API, not a new one', () => {
  assert.equal(NEW_DRAFT_ENDPOINT, '/api/statement/drafts')
})

test('a stored timestamp renders as its calendar day, deterministically', () => {
  assert.equal(draftDay('2026-09-29T12:00:00.000Z'), '2026-09-29')
  assert.equal(draftDay('2026-09-29 12:00:00+00'), '2026-09-29')
  // Deterministic: no Date, no locale, no timezone, so the server and the
  // browser cannot disagree and cause a hydration mismatch.
  assert.doesNotMatch(MODULE, /toLocaleDateString|toLocaleString|new Date\(/)
})

test('a value that is not a timestamp is left alone, not sliced into nonsense', () => {
  for (const odd of ['', 'unknown', '2026', 'not-a-date-at-all']) {
    assert.equal(draftDay(odd), odd)
  }
})

// ========================================================== PART 2: the wiring

test('the page applies the STATEMENT gate, and before it lists anything', () => {
  assert.match(PAGE, /from '@\/lib\/statement\/studioGate'/)
  assert.match(PAGE, /statementStudioAccess\(\{/)
  assert.match(PAGE, /mode: statementStudioMode\(\)/)
  assert.doesNotMatch(PAGE, /^import[^\n]*lib\/resume/m)

  const gate = PAGE.indexOf('statementStudioAccess({')
  const refuse = PAGE.indexOf('notFound()')
  const token = PAGE.indexOf('readAccessToken()')
  const client = PAGE.indexOf('statementDbClient(')
  const list = PAGE.indexOf('listDrafts(db')
  for (const [name, at] of [
    ['the gate', gate], ['a refusal', refuse], ['the token read', token],
    ['the client', client], ['the list', list],
  ] as const) {
    assert.notEqual(at, -1, `${name} is missing from the page`)
  }
  assert.ok(gate < refuse, 'the gate decides before anything is refused')
  assert.ok(refuse < token, 'a blocked caller must not reach the access token')
  assert.ok(refuse < client, 'a blocked caller must not reach a Supabase client')
  assert.ok(gate < list, 'a blocked caller must not reach listDrafts')
  assert.equal(PAGE.split('listDrafts(').length - 1, 1, 'exactly one list call')
})

test('the page lists through the repository, never off the table', () => {
  assert.match(PAGE, /from '@\/lib\/statement\/draft\/draftRepo'/)
  assert.doesNotMatch(PAGE, /\.from\(|statement_drafts|\.select\(|\.eq\(|\.order\(/)
})

test('the page holds no service role key', () => {
  assert.doesNotMatch(PAGE, /SERVICE_ROLE/i)
  // THE CLIENT MOVED, THE PROPERTY DID NOT. Every statement path now takes its
  // client from statementDbClient(), which builds the same anon-key,
  // caller-scoped client and is asserted to hold no service role in
  // lib/statement/devMode/writeIsolation.test.ts. Pinning the inline
  // createClient() here would now pin a call that no longer exists.
  assert.match(PAGE, /statementDbClient\(token, \{/)
})

test('a repository failure leaks no detail', () => {
  assert.doesNotMatch(PAGE, /listed\.detail|\.detail\b/)
  assert.doesNotMatch(PAGE, /JSON\.stringify\(listed|String\(listed/)
  assert.match(PAGE, /const UNREADABLE = 'Your statement drafts could not be loaded\.'/)
  assert.match(PAGE, /throw new Error\(UNREADABLE\)/)
})

test('the library is given summaries only, and no essay reaches it', () => {
  assert.match(PAGE, /drafts=\{listed\.value\}/)
  // The directory is handed over as a LIST and a FLAG, read on the server after
  // the gate. Unavailable and empty are separate values because they read the
  // same on screen and are not the same thing.
  assert.match(PAGE, /schools=\{schools\.ok \? schools\.value : \[\]\}/)
  assert.match(PAGE, /schoolsUnavailable=\{!schools\.ok\}/)
  // AND A FAILED DIRECTORY DOES NOT TAKE THE PAGE DOWN: the only throw is the
  // one about drafts, so starting a general statement survives it.
  assert.equal(PAGE.split('throw new Error').length - 1, 1, 'one throw, and it is about drafts')
  assert.doesNotMatch(PAGE, /schools\.detail/, 'a Postgres message is not a page')
  assert.match(LIST, /StatementDraftSummary/)
  // Neither file mentions an essay, reads a full draft, or fetches one.
  for (const [name, source] of [['page', PAGE], ['list', LIST]] as const) {
    assert.doesNotMatch(source, /\bessay\b/, `${name} must not touch an essay`)
    assert.doesNotMatch(source, /readDraft/, `${name} must not read a full draft`)
  }
  assert.doesNotMatch(LIST, /\bfetch\(/, 'the list is handed its rows, it does not fetch them')
})

test('the list does not re-sort, and opens a draft with a real link', () => {
  assert.doesNotMatch(LIST, /\.sort\(|\.reverse\(/)
  assert.match(LIST, /href=\{draftPath\(draft\.id\)\}/)
  assert.match(LIST, /from 'next\/link'/)
})

test('the list renders only library fields', () => {
  for (const shown of [/\{draft\.title\}/, /draftDay\(draft\.updatedAt\)/, /draftDay\(draft\.createdAt\)/]) {
    assert.match(LIST, shown)
  }
  assert.doesNotMatch(LIST, /draft\.revision/, 'a revision number is not library information')
})

test('the dialog POSTs to the gated API and builds no body of its own', () => {
  assert.match(DIALOG, /from '@\/lib\/statement\/draft\/library'/)
  assert.match(DIALOG, /fetch\(NEW_DRAFT_ENDPOINT, \{/)
  assert.match(DIALOG, /method: 'POST'/)
  // The body is the pure module's, verbatim. No object literal is assembled here.
  assert.match(DIALOG, /body: JSON\.stringify\(request\.body\)/)
  assert.doesNotMatch(DIALOG, /title:\s*[a-zA-Z]/, 'the dialog must not assemble a payload')
  // FOUR REQUESTS, AND EXACTLY FOUR, each accounted for:
  //
  //   2 x NEW_DRAFT_ENDPOINT   the prompt/paste/general create, and the
  //                            requirement create. Two because a
  //                            requirement-backed body carries requirementId
  //                            and no promptId, and merging the two builders
  //                            would mean one body that could be either.
  //   1 x promptsPath          the prompt list, reached from the school screen.
  //   1 x requirementsPath     the requirement catalog, asked once per school.
  //
  // IT WAS FIVE, WITH A SECOND promptsPath. The checklist's "listed prompts"
  // escape asked again for the school already chosen; that control now returns
  // to the school list instead, so the request is gone rather than unused.
  //
  // STILL NO PATCH. Whatever a draft is born against rides its create.
  assert.equal(DIALOG.split('fetch(NEW_DRAFT_ENDPOINT').length - 1, 2, 'two create requests')
  assert.equal(DIALOG.split('fetch(promptsPath(').length - 1, 1, 'one prompt-list request')
  assert.equal(DIALOG.split('fetch(requirementsPath(').length - 1, 1, 'one catalog request')
  assert.equal(DIALOG.split('fetch(').length - 1, 4, 'and no other request anywhere')
  assert.doesNotMatch(DIALOG, /method: 'PATCH'|PATCH/, 'a created draft is never patched')
  // AND THE REQUIREMENT BODY IS THE PURE MODULE'S TOO. No object literal.
  assert.match(DIALOG, /body: JSON\.stringify\(requirementDraftRequest\(title, requirementId\)\)/)
})

test('the dialog holds a SYNCHRONOUS duplicate guard, set before the request', () => {
  assert.match(DIALOG, /const inFlight = useRef\(false\)/)
  assert.match(DIALOG, /if \(inFlight\.current\) return/)
  // MEASURED INSIDE THE CREATE FLOW, not across the file: the prompt list also
  // awaits a fetch, and an indexOf over the whole source would find whichever
  // appeared first rather than the one this ordering is about.
  const create = DIALOG.slice(
    DIALOG.indexOf('const submit = useCallback'),
    DIALOG.indexOf('if (!open) return null')
  )
  assert.ok(create.length > 0, 'the create flow was not found')
  const guardCheck = create.indexOf('if (inFlight.current) return')
  const guardSet = create.indexOf('inFlight.current = true')
  const request = create.indexOf('await fetch(')
  assert.ok(guardCheck !== -1 && guardSet !== -1 && request !== -1)
  assert.ok(guardCheck < guardSet, 'the guard is read before it is taken')
  assert.ok(guardSet < request, 'the guard is taken before anything awaits')
})

test('on success the dialog neither closes nor releases the guard', () => {
  const push = DIALOG.indexOf('router.push(outcome.path)')
  const release = DIALOG.indexOf('inFlight.current = false\n    setSubmitting(false)')
  assert.notEqual(push, -1, 'the dialog must navigate on success')
  assert.notEqual(release, -1, 'the dialog must release the guard on refusal')
  assert.ok(push < release, 'success must return before the guard is released')
  assert.match(DIALOG, /router\.push\(outcome\.path\)\n\s*return/)
  // onClose is the user's path only. Asserted on the create flow's own body,
  // because `dismiss` legitimately calls onClose() and is defined above it.
  const flow = DIALOG.slice(
    DIALOG.indexOf('const submit = useCallback'),
    DIALOG.indexOf('if (!open) return null')
  )
  assert.ok(flow.length > 0, 'the create flow was not found')
  assert.doesNotMatch(flow, /onClose/, 'the create flow must never close the dialog')
  assert.equal(DIALOG.split('onClose()').length - 1, 1, 'onClose is called from one place only')
})

test('the dialog never retries by itself, and keeps the title when it fails', () => {
  assert.doesNotMatch(DIALOG, /setTimeout\([^)]*submit|setInterval|retryCount|attempts/)
  /*
   * EVERY WRITE TO THE TITLE IS INVENTORIED, and the inventory is the test.
   *
   * The applicant's keystrokes (two inputs: the title screen and the report
   * screen), the reset when the dialog opens, and ONE pre-fill: opening a
   * changed-prompt report takes the document's own label when the title is
   * still empty, because reporting is a single screen and the draft still
   * needs a name.
   *
   * THE PRE-FILL CANNOT DISCARD ANYTHING. It is written with an updater that
   * returns `current` unless the field is blank, which is asserted below --
   * so the property this test was written for is unchanged: no path clears a
   * title the applicant typed, least of all a refusal.
   */
  // The inventory is matched with a non-greedy pattern, so the updater shows
  // up truncated at its first bracket; its whole body is asserted below.
  assert.deepEqual(DIALOG.match(/setTitle\([^)]*\)/g), [
    "setTitle('')",
    'setTitle((current)',
    'setTitle(event.target.value)',
    'setTitle(event.target.value)',
  ])
  // THE PRE-FILL KEEPS WHAT IS THERE. Blank becomes the label; anything else
  // is returned unchanged, which is the whole safety property.
  assert.match(DIALOG,
    /setTitle\(\(current\) => \(current\.trim\(\) === '' \? label : current\)\)/)
  // THE RESET IS THE OPEN EFFECT'S, AND NOTHING ELSE EMPTIES IT.
  assert.equal(DIALOG.split("setTitle('')").length - 1, 1)
  // AND THE SUBMIT FLOW TOUCHES IT NOT AT ALL.
  const flow = DIALOG.slice(
    DIALOG.indexOf('const submit = useCallback'),
    DIALOG.indexOf('if (!open) return null'),
  )
  assert.ok(flow.length > 0, 'the create flow was not found')
  assert.doesNotMatch(flow, /setTitle/, 'no create path may write the title')
})

test('the dialog renders only its own controlled message', () => {
  assert.match(DIALOG, /setMessage\(outcome\.message\)/)
  assert.match(DIALOG, /\{message\}/)
  // Never the server's own words, and never a repository detail.
  for (const forbidden of [/body\.error/, /\.detail\b/, /outcome\.error/, /response\.statusText/]) {
    assert.doesNotMatch(DIALOG, forbidden)
  }
})

test('the title input does not silently truncate', () => {
  // NEITHER TITLE INPUT CARRIES ONE -- the title screen's or the report
  // screen's. A title over the limit is refused and counted, never shortened.
  assert.doesNotMatch(DIALOG, /maxLength/, 'maxLength would shorten a pasted title')
  assert.equal(DIALOG.split('MAX_TITLE_CHARS').length - 1, 7,
    'both title inputs must show the same counter')
  assert.doesNotMatch(DIALOG, /\.slice\(0,|substring\(/)
  // The dialog picks neither builder itself: createRequestFor does, from the
  // path, so a general body and a school body cannot be swapped by a typo here.
  assert.match(DIALOG, /createRequestFor\(\{ path, title, promptId:/)
  assert.doesNotMatch(DIALOG, /newDraftRequest\(|newSchoolDraftRequest\(/,
    'the dialog chooses a path, not a builder')
})

test('no client-side gate was added: the server gate stays authoritative', () => {
  for (const [name, source] of [['list', LIST], ['dialog', DIALOG]] as const) {
    assert.doesNotMatch(source, /studioGate|statementStudioAccess|statementStudioMode/, `${name}`)
    assert.doesNotMatch(source, /isAdmin|ADMIN_EMAILS|STATEMENT_STUDIO_MODE/, `${name}`)
  }
})

test('the client components are client components, and the page is not', () => {
  assert.match(LIST, /^'use client'/)
  assert.match(DIALOG, /^'use client'/)
  assert.doesNotMatch(PAGE, /'use client'/)
  assert.match(PAGE, /export const dynamic = 'force-dynamic'/)
})


/* ===========================================================================
 * Searching and ordering: the real functions, against real rows.
 *
 * These run the logic rather than reading the component's source, which is the
 * point of keeping it out of the component: a structural assertion can only
 * see that a control is wired to something, not that the something is right.
 * ======================================================================== */

const row = (id: string, title: string, createdAt: string, updatedAt: string) => ({
  id,
  title,
  revision: 1,
  createdAt,
  updatedAt,
})

/** Three drafts in the order listDrafts returns them: newest edit first. */
const ROWS = [
  row('b', 'Zeta story', '2026-01-03T00:00:00Z', '2026-03-01T00:00:00Z'),
  row('a', 'alpha story', '2026-02-09T00:00:00Z', '2026-02-01T00:00:00Z'),
  row('c', 'Middle draft', '2026-01-20T00:00:00Z', '2026-01-01T00:00:00Z'),
]

const idsOf = (drafts: readonly { readonly id: string }[]) => drafts.map((draft) => draft.id)

test("the default order is the server's, handed back untouched", () => {
  // Reference equality, not a deep match: nothing was copied, compared or
  // re-sorted. The browser does not get a second opinion for free.
  assert.equal(orderDrafts(ROWS, 'edited'), ROWS)
  assert.equal(DRAFT_ORDERS[0].value, 'edited', 'and it is the order the control starts on')
})

test('an order this module does not know falls back to the server order', () => {
  assert.equal(orderDrafts(ROWS, 'nonsense' as DraftOrder), ROWS)
})

test('ordering by start date is newest first, and by title is A to Z', () => {
  assert.deepEqual(idsOf(orderDrafts(ROWS, 'started')), ['a', 'c', 'b'])
  // Case is folded, so a lowercase title is not exiled to the end.
  assert.deepEqual(idsOf(orderDrafts(ROWS, 'title')), ['a', 'c', 'b'])
})

test('ordering never mutates the array it was given', () => {
  orderDrafts(ROWS, 'title')
  orderDrafts(ROWS, 'started')
  assert.deepEqual(idsOf(ROWS), ['b', 'a', 'c'], 'React still holds this array')
})

test('equal keys are broken by id, so rows never shuffle between renders', () => {
  const tied = [
    row('z', 'Same', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
    row('m', 'same', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ]
  assert.deepEqual(idsOf(orderDrafts(tied, 'title')), ['m', 'z'])
  assert.deepEqual(idsOf(orderDrafts(tied, 'started')), ['m', 'z'])
})

test('only the three known orders are accepted', () => {
  for (const good of ['edited', 'started', 'title']) assert.equal(isDraftOrder(good), true)
  for (const bad of ['', 'EDITED', 'revision', null, undefined, 0, {}]) {
    assert.equal(isDraftOrder(bad), false)
  }
  for (const choice of DRAFT_ORDERS) assert.equal(isDraftOrder(choice.value), true)
})

test('a blank search returns the very array it was given', () => {
  for (const blank of ['', '   ', '\t\n']) assert.equal(matchDrafts(ROWS, blank), ROWS)
})

test('search matches titles, case-insensitively, anywhere in the title', () => {
  assert.deepEqual(idsOf(matchDrafts(ROWS, 'STORY')), ['b', 'a'])
  assert.deepEqual(idsOf(matchDrafts(ROWS, 'idd')), ['c'], 'a substring, not a prefix')
  assert.deepEqual(idsOf(matchDrafts(ROWS, '  zeta  ')), ['b'], 'the needle is trimmed')
  assert.deepEqual(matchDrafts(ROWS, 'nothing here'), [])
})

test('search reads titles and nothing else', () => {
  // Ids and timestamps are not searchable: a summary has no other text, and
  // the statement itself is never in the browser on this page.
  assert.deepEqual(matchDrafts(ROWS, '2026'), [])
  assert.deepEqual(matchDrafts(ROWS, 'b'), [], 'an id is not a title')
})

test('the tally counts what is on screen, and never says zero drafts', () => {
  assert.equal(draftTally(0, 0), 'Create and manage your personal statement drafts here.')
  assert.equal(draftTally(1, 1), '1 draft in your workspace.')
  assert.equal(draftTally(3, 3), '3 drafts in your workspace.')
  assert.equal(draftTally(1, 3), '1 of 3 drafts match your search.')
  assert.equal(draftTally(0, 3), '0 of 3 drafts match your search.')
})

/* ===========================================================================
 * The redesigned library: presentation invariants.
 *
 * These lock the decisions the redesign made, not its pixels. Spacing, colour
 * and wording stay free to change. What may not change is whether a control is
 * connected to anything, the fields a card may read, and whether the notice
 * describes features this build does not actually have.
 * ======================================================================== */

const countOf = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0

test('both create triggers work, and they do not read as the same button twice', () => {
  assert.match(LIST, /const empty = drafts\.length === 0/)
  assert.equal(countOf(LIST, /setCreating\(true\)/g), 2, 'a hero trigger and an empty-state one')
  // The mockup shows both at once, so they are distinguished by wording
  // rather than by hiding one: an applicant is never asked to choose between
  // two identical primary buttons.
  assert.match(LIST, />\s*New draft\s*</)
  assert.match(LIST, />\s*Create your first draft\s*</)
})

test('search and sort are wired to state, not decoration', () => {
  // Each control reads a value, writes a value, and stands down when there is
  // nothing for it to act on.
  assert.match(LIST, /value=\{query\}/)
  assert.match(LIST, /setQuery\(event\.target\.value\)/)
  assert.match(LIST, /value=\{order\}/)
  assert.match(LIST, /setOrder\(isDraftOrder\(event\.target\.value\)/, 'the value is checked, not cast')
  assert.equal(countOf(LIST, /disabled=\{empty\}/g), 2, 'both stand down with no drafts')
  assert.match(LIST, /DRAFT_ORDERS\.map\(/, 'the options come from the module, not from markup')
})

test('the list delegates searching and ordering rather than doing either', () => {
  assert.match(LIST, /orderDrafts\(matchDrafts\(drafts, query\), order\)/)
  // The pre-existing ban on .sort( here still holds, and now it means
  // something sharper: the ordering lives in a module that has real tests.
  assert.doesNotMatch(LIST, /\.sort\(|\.reverse\(/)
  assert.doesNotMatch(LIST, /localeCompare/, 'it would disagree across a hydration boundary')
})

test('the hero carries one action, and no in-page link beside it', () => {
  // A "learn how it works" link used to sit here pointing at the three cards
  // directly below it. It competed with the only thing there is to do on this
  // screen, and the cards are reached by scrolling regardless.
  assert.doesNotMatch(LIST, /href="#/, 'no in-page anchor remains')
  assert.doesNotMatch(LIST, /Learn how it works|PlayIcon/, 'and neither does its icon')
  // The section heading keeps its id: the section is labelled by it.
  assert.match(LIST, /id="how-it-works"/)
  assert.match(LIST, /aria-labelledby="how-it-works"/)
})

test('a card still reads only the fields a summary carries', () => {
  for (const internal of [
    /draft\.school/, /draft\.prompt/, /schoolId/, /promptId/, /promptText/,
    /statedMaxWords/, /schoolLabel/,
  ]) {
    assert.doesNotMatch(LIST, internal, 'no school or prompt field belongs on a library card')
  }
})

test('the notice no longer claims that upload is unwired', () => {
  // Upload shipped: the editor takes .pdf, .docx and .txt through the gated
  // extraction endpoint. The old wording outlived the limitation it described,
  // which is the one thing this copy must not do again.
  assert.doesNotMatch(LIST, /not wired up/i, 'upload is implemented; do not say otherwise')
  assert.doesNotMatch(LIST, /Analyze this Draft/, 'no control by that name exists in the studio')
  assert.match(LIST, /Internal preview/)
  assert.match(LIST, /analyzer is not available yet/)
})

test('the three steps are data, and every icon is decorative', () => {
  assert.match(LIST, /STEPS\.map\(/)
  for (const step of [
    /title: 'Choose your path'/, /title: 'Write your story'/, /title: 'Analyze & improve'/,
  ]) {
    assert.match(LIST, step)
  }
  // Every drawing repeats adjacent text, so every one is hidden from assistive
  // technology -- the hero artwork included.
  const svgs = LIST.match(/<svg[\s\S]*?>/g) ?? []
  assert.ok(svgs.length > 0, 'the drawings are inline SVG, not an icon package')
  for (const svg of svgs) {
    assert.ok(svg.includes('aria-hidden="true"'), `a decorative drawing is exposed: ${svg.slice(0, 40)}`)
  }
})

test('the hero artwork is drawn here, never fetched', () => {
  // A locally drawn scene: no image request, no licence, nothing to go stale.
  assert.match(LIST, /function DeskScene\(\)/)
  assert.doesNotMatch(LIST, /<img|next\/image|backgroundImage|url\(http/)
  assert.doesNotMatch(LIST, /https?:\/\//, 'the hero pulls in nothing from off the page')
})

test('a card holds no nested control, and the page keeps one h1', () => {
  // The whole card is the link. A button inside an anchor is invalid markup
  // and gives a keyboard user two stops for one destination.
  const start = LIST.indexOf('visible.map(')
  assert.notEqual(start, -1, 'the card list is rendered from the filtered rows')
  assert.doesNotMatch(LIST.slice(start), /<button/, 'the card is the link, and holds nothing clickable')
  assert.equal(countOf(LIST, /<h1/g), 1, 'one page title, with the sections below it as h2')
})

test('the library pulls in nothing it does not need', () => {
  // A PIN, NOT A PROHIBITION, and it has now caught one addition on purpose:
  // ./RequirementPreview is the development-only writing-requirement preview,
  // which renders only when the server passes requirementsPreview -- false in
  // every environment that is not a developer's own. It brings no new runtime
  // dependency with it: the preview and the checklist it renders import only
  // from lib/statement/requirements, which is pure TypeScript.
  const imported = [...LIST.matchAll(/from '([^']+)'/g)].map((found) => found[1])
  assert.deepEqual([...new Set(imported)].sort(), [
      // AND NOW A SECOND, FOR THE SAME REASON. ./CatalogReview renders the 63
      // imported requirement sets for local review. It is a CLIENT component
      // that receives those sets as PROPS -- it imports no payload, reads no
      // file and queries nothing, so it adds no runtime dependency either. The
      // payload is read on the server inside the preview branch, and reaching
      // it through an import here is exactly what this pin exists to catch.
      './CatalogReview',
    './NewDraftDialog',
    './RequirementPreview',
    '@/lib/SidebarContext',
    '@/lib/statement/draft/library',
    '@/lib/statement/draft/rows',
    '@/lib/statement/draft/schoolPicker',
    'next/link',
    'react',
  ])
})

test('THE REQUIREMENT PREVIEW CANNOT RENDER WITHOUT THE SERVER SAYING SO', () => {
  // The import is unconditional; the rendering is not. Default false, so a
  // caller that does not pass it draws none.
  assert.match(LIST, /requirementsPreview = false/)
  // RENDERED INSTEAD OF THE LIBRARY. The `&&` form made it a second child of
  // the flex root, which turned it into a column beside the page.
  // THE CONDITION WIDENED when ?preview=requirements became the real catalog
  // and ?preview=fixtures kept the shapes. The FORM is what matters here:
  // one ternary that replaces the library, never the `&&` sibling form.
  assert.match(LIST, /\{requirementsPreview \|\| fixturesPreview \? \(/)
  assert.doesNotMatch(LIST, /\{requirementsPreview && \(/)
  // AND IT IS IN PLACE OF THE LIBRARY, not below it. This assertion used to
  // say the opposite -- "below everything an applicant uses, not in place of
  // it" -- which was the intent when the preview was appended to the page. The
  // owner's approved behaviour is replacement, and appending it is what put it
  // beside the content and squeezed the hero and the step cards.
  assert.ok(LIST.indexOf('<RequirementPreview') < LIST.indexOf('visible.map('),
    'the preview arm comes first, and the library arm is the else')
})

test('the page reserves the fixed nav width instead of sliding under it', () => {
  // The nav is position:fixed, and ClientProviders renders it as a SIBLING of
  // the page rather than as its parent, so nothing reserves its width unless
  // the page does. Skip the reservation and mx-auto centres against the whole
  // VIEWPORT: the nav then covers the left of the result, headings are clipped
  // and the spare room all piles up on the right. This is the same reservation
  // resume-studio's DashboardClient and app/dashboard make.
  assert.match(LIST, /useSidebarCollapsed/, 'the width is read from context, not hard-coded')
  assert.match(LIST, /sidebarCollapsed \? 'lg:ml-20' : 'lg:ml-64'/, 'and it tracks collapsing')
  assert.match(LIST, /min-w-0 flex-1/, 'a flex item must be allowed to shrink, or it scrolls sideways')
  assert.match(LIST, /pt-16 lg:pt-0/, 'below lg the nav floats a menu button over the top')

  // The reservation is lg-only, because below lg the nav is off-canvas and a
  // left margin there would just indent the page against nothing.
  assert.equal(countOf(LIST, /ml-64/g), countOf(LIST, /lg:ml-64/g), 'no unprefixed offset')
  assert.equal(countOf(LIST, /ml-20/g), countOf(LIST, /lg:ml-20/g), 'no unprefixed offset')
})

test('every section shares one centred container', () => {
  // Hero, notice, workflow cards and the draft list are all inside the same
  // wrapper, so their left and right edges line up by construction rather than
  // by four widths that have to be kept in step by hand.
  // TWO, AND THEY ARE THE TWO ARMS OF ONE CONDITIONAL, so exactly one
  // renders. They are byte-identical specs, which is what guarantees the
  // preview is centred and padded exactly as the library is.
  assert.equal(countOf(LIST, /max-w-7xl/g), 2, 'one container spec per arm')
  assert.equal(countOf(LIST, /<main\b/g), 2, 'and one <main> per arm')
  assert.match(LIST, /mx-auto w-full max-w-7xl/, 'centred inside the reserved workspace')
  assert.match(LIST, /px-4 pb-16 pt-6 sm:px-6 lg:px-10/, 'with real padding at every width')
})

// ===========================================================================
// THE SCHOOL-SPECIFIC CREATE REQUEST. One id crosses the boundary, and the
// general builder is left exactly as it was.
// ===========================================================================

const PICKED = 'c0ffee00-0000-4000-8000-000000000004'

test('the general builder is untouched: two keys, and no prompt among them', () => {
  const request = newDraftRequest('My statement')
  assert.equal(request.ok, true)
  assert.deepEqual(request.ok && Object.keys(request.body).sort(), ['essay', 'title'])
  assert.equal(request.ok && 'promptId' in request.body, false, 'a general create names no prompt')
})

test('the school builder emits exactly title, essay and the prompt id', () => {
  const request = newSchoolDraftRequest('  My Rutgers Statement  ', PICKED)
  assert.equal(request.ok, true)
  assert.deepEqual(request.ok && request.body, {
    title: 'My Rutgers Statement',
    essay: '',
    promptId: PICKED,
  })
})

test('ONLY the prompt id crosses the boundary', () => {
  // The canonical three are absent because they are never written, so there is
  // no code path on which one could be included by accident.
  const request = newSchoolDraftRequest('A title', PICKED)
  const sent = JSON.stringify(request.ok && request.body)
  for (const canonical of ['schoolId', 'school_id', 'promptText', 'prompt_text',
                           'statedMaxWords', 'stated_max_words']) {
    assert.equal(sent.includes(canonical), false, `${canonical} must not be sent`)
  }
})

test('the school builder refuses a title exactly as the general one does', () => {
  for (const raw of ['', '   ', '\t\n', null, undefined, 42, {}]) {
    const school = newSchoolDraftRequest(raw, PICKED)
    const general = newDraftRequest(raw)
    assert.equal(school.ok, false)
    assert.equal(school.ok === false && school.message, general.ok === false && general.message)
  }
  const long = 'x'.repeat(MAX_TITLE_CHARS + 1)
  assert.equal(newSchoolDraftRequest(long, PICKED).ok, false)
})

test('the school builder refuses a prompt id this client has mangled', () => {
  for (const bad of ['', '   ', 'nope', null, undefined, 42, {}, `${PICKED}x`]) {
    const request = newSchoolDraftRequest('A title', bad)
    assert.equal(request.ok, false, `${JSON.stringify(bad)} must be refused`)
    assert.equal(request.ok === false && request.message, CREATE_MESSAGES.promptUnusable)
  }
})

test('the title is reported first when both the title and the prompt are wrong', () => {
  // The applicant can act on the title. They cannot act on a prompt id.
  const request = newSchoolDraftRequest('   ', 'nope')
  assert.equal(request.ok, false)
  assert.equal(request.ok === false && request.message, CREATE_MESSAGES.title)
})

test('a withdrawn prompt is its own outcome, not the generic server message', () => {
  // The server refuses the WHOLE create, so nothing was made and a deliberate
  // retry is safe -- but "please try again" would be wrong advice, because the
  // same prompt will fail the same way. A new choice is what is needed.
  const outcome = createOutcomeFrom({
    status: 422,
    body: { error: 'anything at all', code: 'prompt-not-found' },
  })
  assert.equal(outcome.type, 'refused')
  assert.equal(outcome.type === 'refused' && outcome.message, CREATE_MESSAGES.promptGone)
  assert.equal(outcome.type === 'refused' && outcome.retryable, true)
  assert.notEqual(outcome.type === 'refused' && outcome.message, CREATE_MESSAGES.server)
})

test('a prompt id the server refuses is its own outcome too', () => {
  const outcome = createOutcomeFrom({
    status: 400,
    body: { error: 'anything at all', code: 'invalid-prompt' },
  })
  assert.equal(outcome.type, 'refused')
  assert.equal(outcome.type === 'refused' && outcome.message, CREATE_MESSAGES.promptUnusable)
  assert.equal(outcome.type === 'refused' && outcome.retryable, true)
})

test('neither prompt refusal renders the server’s own words', () => {
  // The same rule every other refusal follows: the message is ours, keyed on
  // the code, so PostgREST text or a CHECK message quoting a value cannot
  // reach an applicant.
  for (const code of ['prompt-not-found', 'invalid-prompt']) {
    const outcome = createOutcomeFrom({
      status: 422,
      body: { error: '23514 violates check constraint "statement_prompts_text_len"', code },
    })
    assert.equal(outcome.type, 'refused')
    const message = outcome.type === 'refused' ? outcome.message : ''
    for (const leak of ['23514', 'check constraint', 'statement_prompts']) {
      assert.equal(message.includes(leak), false, `${leak} must never be shown`)
    }
  }
})

test('a created school draft still opens at the path the id gives', () => {
  // Creation's success path is unchanged: the 201 carries a draft id and that
  // is the only thing navigation is built from.
  const outcome = createOutcomeFrom({
    status: 201,
    body: { draft: { id: 'aaaaaaaa-0000-4000-8000-000000000001', promptId: PICKED } },
  })
  assert.equal(outcome.type, 'created')
  assert.equal(outcome.type === 'created' && outcome.path, draftPath('aaaaaaaa-0000-4000-8000-000000000001'))
})

/* ===========================================================================
 * The guided New Draft dialog.
 *
 * Structural again, for the usual reason: the component cannot be imported
 * under node --test. What the flow DOES is tested for real in newDraft.test.ts
 * and picker.test.ts; what is asserted here is that the dialog calls those
 * functions rather than reimplementing them beside them.
 * ======================================================================== */

test('the dialog is handed the directory, and never fetches one of its own', () => {
  // One read, on the server, after the gate. A browser-side schools query would
  // be a second code path to secure for no gain.
  assert.match(LIST, /schools=\{schools\}/)
  assert.match(LIST, /schoolsUnavailable=\{schoolsUnavailable\}/)
  assert.match(DIALOG, /schools: readonly SchoolOption\[\]/)
  assert.doesNotMatch(DIALOG, /\/api\/statement\/schools|listSchoolPickerOptions/)
})

test('an unreadable directory is told apart from an empty one, by the committed function', () => {
  assert.match(DIALOG, /directoryNotice\(\{/)
  assert.match(DIALOG, /unavailable: schoolsUnavailable/)
  // The dialog writes no notice of its own for either case.
  assert.doesNotMatch(DIALOG, /No schools are listed/)
})

test('the stale-response guard wraps the prompt list, and reads a REF', () => {
  // Switching schools quickly puts several requests in the air. A late reply
  // must not land under a different school's name.
  assert.match(DIALOG, /mayApplyPrompts\(\{ requestedFor: option\.id, browsingNow: browsing\.current \}\)/)
  assert.match(DIALOG, /const browsing = useRef<string \| null>\(null\)/)
  // Guarded on BOTH outcomes of EVERY request that can land late. Four: the
  // prompt list's reply and failure, and the requirement catalog's reply and
  // failure. A school switched mid-flight must not show one school's
  // requirements under another's name any more than it may show its prompts.
  //
  // IT WAS SIX. The "listed prompts" escape made a third request, from the
  // checklist, for the school already chosen; that control now leaves the
  // school instead of re-offering it, so the request -- and its two guards --
  // are gone. The escape clears the ref rather than guarding a reply.
  assert.equal(DIALOG.split('mayApplyPrompts(').length - 1, 4, 'every reply and every failure')
  assert.match(DIALOG, /browsing\.current = null/, 'and leaving a school clears the marker')
  // And a stale reply returns without writing anything.
  assert.match(DIALOG, /if \(!mayApplyPrompts\([^)]*\)\) return/)
})

test('a prompt cannot outlive the school it was chosen from', () => {
  assert.match(DIALOG, /setPrompt\(selectionAfterSchoolChange\(\{/)
  assert.match(DIALOG, /browsingId: browsing\.current/)
})

test('a withdrawn prompt reopens the list and creates nothing in its place', () => {
  assert.match(DIALOG, /if \(promptWasRefused\(outcome\.message\)\) \{/)
  // The selection is dropped and the prompt screen returns. No general draft is
  // created as a consolation -- there is no second request to make one with.
  const refusal = DIALOG.slice(DIALOG.indexOf('if (promptWasRefused('))
  assert.match(refusal.slice(0, 160), /setPrompt\(null\)/)
  assert.match(refusal.slice(0, 160), /setStep\('prompt'\)/)
})

test('the general path is offered wherever a school path can dead-end', () => {
  // From the school screen (an unreadable or empty directory), the prompt
  // screen (a school that lists none), and the checklist (a school whose
  // documents the applicant does not want to write). All three keep the title.
  assert.equal(DIALOG.split('onClick={startGeneral}').length - 1, 3)
  assert.match(DIALOG, /const startGeneral = useCallback\(\(\) => \{/)
  const general = DIALOG.slice(DIALOG.indexOf('const startGeneral'), DIALOG.indexOf('const goBack'))
  assert.doesNotMatch(general, /setTitle/, 'switching path must not clear the title')
})

test('neither path is preselected', () => {
  assert.match(DIALOG, /useState<CreatePath \| null>\(null\)/)
  assert.match(DIALOG, /useState<NewDraftStep>\('choice'\)/)
  /*
   * Both choices are explicit clicks. setPath('school') three times: the
   * choice itself, starting a requirement, and reporting that one has changed
   * -- the last two are school drafts reached from the checklist rather than
   * from the prompt list, and both must carry the school path.
   */
  assert.equal(DIALOG.split("setPath('school')").length - 1, 3)
  assert.equal(DIALOG.split("setPath('general')").length - 1, 2, 'the choice, and the dead-end exit')
})

test('the dialog authors no canonical value on the APPROVED path', () => {
  // THIS GUARANTEE NARROWED WHEN PASTING ARRIVED, and the narrowing is the
  // feature rather than a weakening of it.
  //
  // Before, the dialog could name no prompt wording at all, because the only
  // school-specific path was "choose a prompt the catalog already holds" and
  // on that path the wording is the server's to resolve. That is still true
  // and still asserted below: the approved request carries an id and nothing
  // else.
  //
  // A PASTED PROMPT IS DIFFERENT IN KIND. The applicant is typing their
  // school's question, so the browser necessarily authors it -- and what keeps
  // that safe is not that the words never appear here, but WHERE THEY GO: into
  // statement_prompt_submissions with status 'pending', under a nested
  // `promptSubmission` key, never into the catalog and never into the draft's
  // prompt_id. The database enforces the last part with a CHECK.
  //
  // The approved path still sends an id and nothing more.
  assert.match(DIALOG, /createRequestFor\(\{ path, title, promptId:/)
  const approved = DIALOG.slice(DIALOG.indexOf('createRequestFor({ path, title'))
  assert.doesNotMatch(approved.slice(0, 200), /promptText|statedMaxWords/)

  // DATABASE COLUMN NAMES STAY BANNED OUTRIGHT. A browser spelling a column is
  // a browser shaping a row, and no path here has any business doing that.
  for (const column of ['school_id', 'prompt_text', 'stated_max_words', 'prompt_id',
                        'prompt_submission_id', 'is_active']) {
    assert.equal(DIALOG.includes(column), false, `the dialog must not name ${column}`)
  }

  // Everything the applicant types is nested under one key by the builder, so
  // no pasted value can arrive at the top level of a create body.
  assert.match(DIALOG, /newPastedDraftRequest\(title, school === null \? null : school\.id, pasted\)/)
  assert.doesNotMatch(DIALOG, /promptSubmission:/, 'the body is built by the builder, not here')
})

test('a pasted prompt never travels the approved-prompt branch', () => {
  /*
   * THE PRECEDENCE, AS ONE CHAIN. Neither a report nor a paste may fall
   * through to the branch that means "the catalog vouches for this", so both
   * are tested before it -- and the report is tested before the paste, because
   * a report sent as a paste would lose the id of the row it contradicts.
   */
  assert.match(DIALOG, /const request = report !== null\s*\n\s*\? newPromptChangeRequest/)
  assert.match(DIALOG, /: pasted !== null\s*\n\s*\? newPastedDraftRequest/)
  assert.match(DIALOG, /: createRequestFor\(\{ path, title, promptId:/)
  // Choosing a listed prompt clears any paste, and pasting clears any choice.
  assert.match(DIALOG, /setPasted\(null\); setPrompt\(choice\)/)
  assert.match(DIALOG, /setPrompt\(null\)\s*\n\s*setPasted\(EMPTY_PASTE\)/)
})

test('a paste cannot outlive the school it was typed for', () => {
  assert.match(DIALOG, /if \(browsing\.current !== option\.id\) setPasted\(null\)/)
})

test('the paste option is gated, and both gates default to unavailable', () => {
  // Until the submission migrations are applied there is no table to write.
  assert.match(DIALOG, /submissionsEnabled = false/)
  assert.match(DIALOG, /pastePreview = false/)
  // Drawn when the feature is on OR somebody is previewing it in development.
  assert.match(DIALOG, /pasteOptionVisible\(\{ submissionsEnabled, pastePreview \}\)/)
})

test('PREVIEW CAN DRAW THE SCREENS BUT NEVER SEND ANYTHING', () => {
  // The safety property of the whole preview mechanism, as a source fact.
  //
  // The submission guard calls pasteSubmissionAllowed, which takes ONLY the
  // rollout flag -- there is no parameter through which the preview state
  // could reach it, so a preview forced on in a deployed build still cannot
  // open this path.
  assert.match(DIALOG, /pasteSubmissionAllowed\(\{ submissionsEnabled \}\)/)
  assert.doesNotMatch(DIALOG, /pasteSubmissionAllowed\(\{[^}]*pastePreview/)

  // And it returns rather than falling through. A paste that cannot be sent
  // must NOT become a blank general draft.
  const flow = DIALOG.slice(
    DIALOG.indexOf('const submit = useCallback'),
    DIALOG.indexOf('if (!open) return null'),
  )
  // BOTH KINDS OF SUBMISSION ARE STOPPED BY IT. A changed-prompt report is a
  // submission -- same table, same function, same rate limit -- so a build
  // where the backend is off has nowhere to put one either.
  assert.match(flow, /if \(\(pasted !== null \|\| report !== null\)\s*\n\s*&& !pasteSubmissionAllowed\(\{ submissionsEnabled \}\)\) \{[\s\S]*?return\s*\n\s*\}/)
  assert.doesNotMatch(flow, /pasteSubmissionAllowed[\s\S]{0,200}createRequestFor/,
    'the block must not fall through to the general builder')
})

test('the preview block happens before the guard, the builder and the request', () => {
  // Nothing an applicant typed reaches a request object, let alone a fetch.
  const flow = DIALOG.slice(
    DIALOG.indexOf('const submit = useCallback'),
    DIALOG.indexOf('if (!open) return null'),
  )
  const block = flow.indexOf('pasteSubmissionAllowed')
  const builder = flow.indexOf('newPastedDraftRequest')
  const guard = flow.indexOf('inFlight.current = true')
  const request = flow.indexOf('await fetch(')
  for (const [name, after] of [['builder', builder], ['guard', guard], ['request', request]] as const) {
    assert.ok(block !== -1 && after !== -1 && block < after, `the block must precede the ${name}`)
  }
})

test('a blocked create says so on the control, and explains why', () => {
  assert.match(DIALOG, /previewBlocked/)
  assert.match(DIALOG, /disabled=\{!canSubmit \|\| previewBlocked\}/)
  assert.match(DIALOG, /'Submission unavailable in preview'/)
  assert.match(DIALOG, /NEW_DRAFT_MESSAGES\.previewExplainer/)
})

test('preview is decided on the SERVER, after the admin gate', () => {
  // NODE_ENV is read from the process, so a deployed build cannot be addressed
  // into preview; the query parameter is the only browser-controlled input and
  // is never sufficient alone.
  assert.match(PAGE, /pastePreviewAllowed\(\{/)
  assert.match(PAGE, /nodeEnv: process\.env\.NODE_ENV/)
  assert.match(PAGE, /isAdmin: isAdminEmail\(auth\.email\)/)
  assert.match(PAGE, /requested: pastePreviewRequested\(params\[PASTE_PREVIEW_PARAM\]\)/)

  // Read AFTER the gate has already refused a non-administrator.
  const refuse = PAGE.indexOf('notFound()')
  const preview = PAGE.indexOf('pastePreviewAllowed({')
  assert.ok(refuse !== -1 && preview !== -1 && refuse < preview)

  // And the rollout flag is still what decides the backend, separately.
  assert.match(PAGE, /submissionsEnabled=\{promptSubmissionsEnabled\(\)\}/)
  assert.doesNotMatch(PAGE, /submissionsEnabled=\{[^}]*pastePreview/)
})

test('a pasted prompt is labelled as unverified wherever it is shown', () => {
  assert.match(DIALOG, /NEW_DRAFT_MESSAGES\.unverifiedBadge/)
  assert.match(DIALOG, /NEW_DRAFT_MESSAGES\.pasteNotice/)
  assert.match(DIALOG, /NEW_DRAFT_MESSAGES\.pasteConfirm/)
  // Consent is a real checkbox bound to state, not a sentence beside a button.
  assert.match(DIALOG, /checked=\{pasted\.confirmed\}/)
  // The wording is rendered as escaped text, never as markup.
  assert.doesNotMatch(DIALOG, /dangerouslySetInnerHTML/)
})

test('the prompt wording is rendered as escaped text, never as markup', () => {
  assert.doesNotMatch(DIALOG, /dangerouslySetInnerHTML/)
  assert.match(DIALOG, /\{choice\.promptText\}/)
  assert.match(DIALOG, /wordLimitLabel\(/, 'the limit is worded by the committed function')
})

test('the dialog is still a modal with a focus trap', () => {
  assert.match(DIALOG, /role="dialog"/)
  assert.match(DIALOG, /aria-modal="true"/)
  assert.match(DIALOG, /aria-labelledby=\{headingId\}/)
  assert.match(DIALOG, /event\.key === 'Escape'/)
  assert.match(DIALOG, /event\.key !== 'Tab'/)
  // Back is a navigation, not a close: only Cancel and Escape reach onClose.
  const back = DIALOG.slice(DIALOG.indexOf('const goBack'), DIALOG.indexOf('const submit'))
  assert.doesNotMatch(back, /onClose/)
})

test('the first card offers a general statement as an equal choice', () => {
  // The dialog's first screen presents a school and a general statement side by
  // side, and this card has to say the same thing. An applicant writing one
  // statement for several programmes is not doing it wrong, and a card reading
  // "choose your school" would tell them they were.
  assert.match(LIST, /or start a general statement/)
  assert.doesNotMatch(LIST, /You must (choose|select) a school|Choose your school first/)
})

test('the third card is marked as not built yet, in words and in styling', () => {
  // Two signals, because the sentence is the last thing read on the card.
  assert.match(LIST, /Coming soon\./, 'the sentence says so')
  assert.match(LIST, /available: false/, 'and the card is flagged as unbuilt')
  assert.match(LIST, /step\.available \? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-400'/)

  // Exactly one of the three is unbuilt: drafting and upload both ship today.
  assert.equal(countOf(LIST, /available: true/g), 2)
  assert.equal(countOf(LIST, /available: false/g), 1)
})

test('the cards describe the creation flow, not the one that preceded it', () => {
  // The old wording described a Write/Personalize order that the guided dialog
  // reversed: a path is chosen before anything is written.
  for (const stale of [/title: 'Write',/, /title: 'Personalize'/, /title: 'Improve'/]) {
    assert.doesNotMatch(LIST, stale)
  }
  assert.match(LIST, /upload an existing document/, 'upload is still described, and still real')
})
