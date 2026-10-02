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
  const client = PAGE.indexOf('createClient(')
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
  assert.match(PAGE, /NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  assert.match(PAGE, /Authorization: `Bearer \$\{token\}`/)
})

test('a repository failure leaks no detail', () => {
  assert.doesNotMatch(PAGE, /listed\.detail|\.detail\b/)
  assert.doesNotMatch(PAGE, /JSON\.stringify\(listed|String\(listed/)
  assert.match(PAGE, /const UNREADABLE = 'Your statement drafts could not be loaded\.'/)
  assert.match(PAGE, /throw new Error\(UNREADABLE\)/)
})

test('the library is given summaries only, and no essay reaches it', () => {
  assert.match(PAGE, /<LibraryClient drafts=\{listed\.value\} \/>/)
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
  assert.equal(DIALOG.split('fetch(').length - 1, 1, 'exactly one request in the whole flow')
})

test('the dialog holds a SYNCHRONOUS duplicate guard, set before the request', () => {
  assert.match(DIALOG, /const inFlight = useRef\(false\)/)
  assert.match(DIALOG, /if \(inFlight\.current\) return/)
  const guardCheck = DIALOG.indexOf('if (inFlight.current) return')
  const guardSet = DIALOG.indexOf('inFlight.current = true')
  const request = DIALOG.indexOf('await fetch(')
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
  // The only writes to the title are the applicant's keystrokes and the reset
  // when the dialog opens. A refusal path never clears it.
  assert.deepEqual(DIALOG.match(/setTitle\([^)]*\)/g), [
    "setTitle('')",
    'setTitle(event.target.value)',
  ])
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
  assert.doesNotMatch(DIALOG, /maxLength/, 'maxLength would shorten a pasted title')
  assert.doesNotMatch(DIALOG, /\.slice\(0,|substring\(/)
  assert.match(DIALOG, /newDraftRequest\(title\)/)
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

test('Learn how it works points at something that exists', () => {
  assert.match(LIST, /href="#how-it-works"/)
  assert.match(LIST, /id="how-it-works"/, 'a link to a missing anchor is an ornament')
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
  for (const step of [/title: 'Write'/, /title: 'Personalize'/, /title: 'Improve'/]) {
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

test('the redesign added no dependency', () => {
  const imported = [...LIST.matchAll(/from '([^']+)'/g)].map((found) => found[1])
  assert.deepEqual([...new Set(imported)].sort(), [
    './NewDraftDialog',
    '@/lib/SidebarContext',
    '@/lib/statement/draft/library',
    '@/lib/statement/draft/rows',
    'next/link',
    'react',
  ])
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
  assert.equal(countOf(LIST, /max-w-7xl/g), 1, 'exactly one content container')
  assert.match(LIST, /mx-auto w-full max-w-7xl/, 'centred inside the reserved workspace')
  assert.match(LIST, /px-4 pb-16 pt-6 sm:px-6 lg:px-10/, 'with real padding at every width')
})
