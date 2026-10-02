import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PICKER_MESSAGES, PROMPTS_ENDPOINT, confirmationApplies, directoryNotice, hasSavedPrompt,
  matchingSchools,
  mayApplyPrompts, needsPromptWrite, nextPendingPrompt, previewIsSaved, promptBadgeFor,
  promptForRequest,
  promptListFrom, promptsPath, samePendingPrompt, savedPromptFromResponse, schoolLabel,
  wordLimitLabel,
  schoolNameFor,
} from './picker.ts'
import type { PendingPrompt } from './picker.ts'
// Imported ONLY to build the three request bodies this lifecycle produces.
import { statementSaveRequest } from './editor.ts'
import type { SchoolOption } from './schoolPicker.ts'
// Imported ONLY to assert the response parser and the ROW parser agree.
import { promptOptionFromRow } from './promptRepo.ts'
import { draftPromptFrom } from './rows.ts'
// Imported ONLY to assert the technical storage ceiling is a different number
// from anything this picker displays.
import { MAX_SAVED_CHARS } from '../extract/limits.ts'

/**
 * Pure. No fetch, no window, no clock.
 *
 * THE COMPONENTS ARE ASSERTED ON THEIR SOURCE, at the end of this file, because
 * a client component cannot be imported under node --test: next/navigation does
 * not resolve. Everything a source assertion cannot establish -- that a stale
 * reply is dropped, that a malformed body is refused -- is decided by the
 * functions above and tested by execution here.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const P1 = 'c0ffee00-0000-4000-8000-00000000000a'
const P2 = 'c0ffee00-0000-4000-8000-00000000000b'
const WORDING = 'Why have you chosen nurse anaesthesia?'

const school = (over: Partial<SchoolOption> = {}): SchoolOption => ({
  id: A, name: 'Example University', locationState: 'TX', ...over,
})

const choice = (over: Record<string, unknown> = {}) => ({
  id: P1, label: 'Essay 1', promptText: WORDING,
  statedMaxWords: 500, applicationCycle: '2026', ...over,
})

const ok = (prompts: unknown[]) => ({ status: 200, body: { prompts } })

// ============================================================= school search

test('search: matches the NAME, case-insensitively, in the order given', () => {
  const list = [
    school({ id: A, name: 'Alpha University' }),
    school({ id: B, name: 'Beta College of Nursing' }),
  ]
  assert.deepEqual(matchingSchools(list, 'alpha').map((s) => s.id), [A])
  assert.deepEqual(matchingSchools(list, 'ALPHA').map((s) => s.id), [A])
  assert.deepEqual(matchingSchools(list, 'nursing').map((s) => s.id), [B])
  assert.deepEqual(matchingSchools(list, 'college OF nur').map((s) => s.id), [B])
  // Order is the server's, never re-sorted here.
  assert.deepEqual(matchingSchools(list, 'e').map((s) => s.id), [A, B])
})

test('search: an EMPTY or whitespace query matches everything', () => {
  const list = [school({ id: A }), school({ id: B, name: 'Beta' })]
  for (const query of ['', ' ', '\t\n  ']) {
    assert.deepEqual(matchingSchools(list, query), list, JSON.stringify(query))
  }
})

test('search: a query that matches nothing returns an empty list, not everything', () => {
  assert.deepEqual(matchingSchools([school()], 'zzzz'), [])
})

test('search: THE STATE IS NOT SEARCHED', () => {
  // Typing "TX" must not silently return every Texas programme as if the
  // applicant had asked for them.
  const list = [school({ name: 'Alpha University', locationState: 'TX' })]
  assert.deepEqual(matchingSchools(list, 'TX'), [])
})

test('search: a null state is safe, and leaves no dangling punctuation', () => {
  assert.equal(schoolLabel(school({ locationState: 'TX' })), 'Example University — TX')
  assert.equal(schoolLabel(school({ locationState: null })), 'Example University')
  // Blank and whitespace-only are treated as absent, not printed as a gap.
  assert.equal(schoolLabel(school({ locationState: '' })), 'Example University')
  assert.equal(schoolLabel(school({ locationState: '   ' })), 'Example University')
  for (const label of Object.values({ a: schoolLabel(school({ locationState: null })) })) {
    assert.equal(label.includes('null'), false)
    assert.equal(label.includes('—'), false)
  }
})

test('search: a full state name is shown as stored', () => {
  // lib/states.ts records that this column is inconsistent. The picker shows
  // what is there; normalising is the directory's business, not a label's.
  assert.equal(schoolLabel(school({ locationState: 'Michigan' })), 'Example University — Michigan')
})

// ======================================================= directory notices

test('directory: UNAVAILABLE and EMPTY are DIFFERENT messages', () => {
  const unavailable = directoryNotice({ unavailable: true, total: 0, matching: 0 })
  const empty = directoryNotice({ unavailable: false, total: 0, matching: 0 })
  assert.equal(unavailable, PICKER_MESSAGES.unavailable)
  assert.equal(empty, PICKER_MESSAGES.emptyDirectory)
  assert.notEqual(unavailable, empty)
  // The failed read is checked FIRST, even when the list it carries is empty.
  assert.equal(directoryNotice({ unavailable: true, total: 130, matching: 5 }),
    PICKER_MESSAGES.unavailable)
})

test('directory: the unavailable message says the ESSAY IS SAFE', () => {
  // A directory that cannot be read must not read as "your work is at risk".
  assert.match(PICKER_MESSAGES.unavailable, /essay is safe/)
  assert.match(PICKER_MESSAGES.unavailable, /saves normally/)
})

test('directory: no matches is its own message, and a hit shows the list', () => {
  assert.equal(directoryNotice({ unavailable: false, total: 130, matching: 0 }),
    PICKER_MESSAGES.noMatches)
  assert.equal(directoryNotice({ unavailable: false, total: 130, matching: 3 }), null)
})

test('directory: every message is distinct', () => {
  const messages = Object.values(PICKER_MESSAGES)
  assert.equal(new Set(messages).size, messages.length, 'two identical notices are one state')
  for (const message of messages) {
    assert.ok(message.length > 0)
    // UNAMBIGUOUS INTERNALS ONLY. 'schools' is deliberately NOT on this list:
    // "No schools are listed yet" is exactly what a reader calls it, and a
    // blacklist that matches ordinary English refuses good prose rather than
    // leaked jargon.
    for (const internal of [
      'public.schools', 'statement_prompts', 'statement_drafts', 'uuid', 'UUID',
      'PostgREST', 'Postgres', 'RLS', 'is_active', 'SELECT', 'constraint', 'column',
    ]) {
      assert.equal(message.includes(internal), false, `${internal} is not a reader's word`)
    }
  }
})

// ========================================================= the word limit

test('limit: a null stated maximum reads as NO STATED LIMIT', () => {
  assert.equal(wordLimitLabel(null), 'No stated word limit.')
})

test('limit: a stated maximum is shown, with a thousands separator', () => {
  assert.equal(wordLimitLabel(500), '500-word maximum, as stated by the school.')
  assert.equal(wordLimitLabel(1000), '1,000-word maximum, as stated by the school.')
  assert.equal(wordLimitLabel(5000), '5,000-word maximum, as stated by the school.')
})

test('limit: THE SCHOOL’S LIMIT IS NEVER OUR STORAGE CEILING', () => {
  // 20,000 characters is a technical maximum on what may be SAVED. It is not a
  // word count and it is not a school's instruction; conflating them would tell
  // an applicant a school permits 20,000 words.
  assert.equal(MAX_SAVED_CHARS, 20_000)
  for (const words of [null, 1, 500, 5000]) {
    const label = wordLimitLabel(words)
    assert.equal(label.includes('20,000'), false)
    assert.equal(label.includes('20000'), false)
    assert.equal(label.includes('character'), false)
  }
  // And the ceiling a school may state is far below it, so no label can collide.
  assert.ok(5000 < MAX_SAVED_CHARS)
})

// ======================================================= the prompt request

test('request: the path is the gated endpoint, with the id encoded', () => {
  assert.equal(PROMPTS_ENDPOINT, '/api/statement/prompts')
  assert.equal(promptsPath(A), `/api/statement/prompts?schoolId=${A}`)
  // A value interpolated without encoding is one that only behaves while well
  // formed.
  assert.equal(promptsPath('a b&c=d'), '/api/statement/prompts?schoolId=a%20b%26c%3Dd')
})

test('response: a well-formed list comes back in the order sent', () => {
  const outcome = promptListFrom(ok([
    choice({ id: P1, label: 'Essay 1' }),
    choice({ id: P2, label: 'Essay 2', statedMaxWords: 750 }),
  ]))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(outcome.prompts.map((p) => p.id), [P1, P2])
  assert.deepEqual(outcome.prompts.map((p) => p.label), ['Essay 1', 'Essay 2'])
  assert.deepEqual(outcome.prompts.map((p) => p.statedMaxWords), [500, 750])
})

test('response: AN EMPTY ARRAY IS A SUCCESS carrying no prompts', () => {
  const outcome = promptListFrom(ok([]))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(outcome.prompts, [])
})

test('response: nullable word limits and cycles survive', () => {
  const outcome = promptListFrom(ok([
    choice({ statedMaxWords: null, applicationCycle: null }),
  ]))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.prompts[0].statedMaxWords, null)
  assert.equal(outcome.prompts[0].applicationCycle, null)
})

test('response: THE WORDING IS PRESERVED EXACTLY', () => {
  const shaped = '  First paragraph.\n\n    Indented second.  '
  const outcome = promptListFrom(ok([choice({ promptText: shaped })]))
  assert.equal(outcome.ok && outcome.prompts[0].promptText, shaped)
})

test('response: a choice is BUILT -- a wider item cannot widen it', () => {
  const outcome = promptListFrom(ok([
    { ...choice(), schoolId: A, displayOrder: 3, isActive: true, secret: 'internal' },
  ]))
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.deepEqual(Object.keys(outcome.prompts[0]).sort(),
    ['applicationCycle', 'id', 'label', 'promptText', 'statedMaxWords'])
  assert.equal(JSON.stringify(outcome.prompts).includes('internal'), false)
})

test('response: a MALFORMED body is a failure, NOT an empty school', () => {
  // "No prompts here" is a claim about a programme and may not be made on the
  // evidence of a body this code could not read.
  for (const body of [
    null, undefined, 'prompts', 42, [], {}, { prompts: null }, { prompts: {} },
    { prompts: 'none' }, { data: [] },
  ]) {
    const outcome = promptListFrom({ status: 200, body })
    assert.equal(outcome.ok, false, JSON.stringify(body) ?? String(body))
    assert.equal(outcome.ok === false && outcome.message, PICKER_MESSAGES.failed)
  }
})

test('response: ONE malformed item fails the WHOLE list', () => {
  const outcome = promptListFrom(ok([
    choice({ id: P1 }),
    choice({ id: P2, label: '   ' }),   // the bad one
  ]))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.message, PICKER_MESSAGES.failed)
})

test('response: every malformed item shape is refused', () => {
  const broken: Record<string, unknown>[] = [
    { id: null }, { id: 'not-a-uuid' }, { id: '' },
    { label: null }, { label: '' }, { label: '  ' }, { label: 42 },
    { label: 'a'.repeat(201) },
    { promptText: null }, { promptText: '' }, { promptText: '  ' }, { promptText: 42 },
    { promptText: 'a'.repeat(5001) },
    { statedMaxWords: 0 }, { statedMaxWords: -1 }, { statedMaxWords: 5001 },
    { statedMaxWords: 1.5 }, { statedMaxWords: '500' }, { statedMaxWords: undefined },
    { applicationCycle: '' }, { applicationCycle: '26' }, { applicationCycle: '2026x' },
    { applicationCycle: 2026 }, { applicationCycle: undefined },
  ]
  for (const over of broken) {
    const outcome = promptListFrom(ok([choice(over)]))
    assert.equal(outcome.ok, false, JSON.stringify(over))
  }
})

test('response: a non-2xx status is a failure, and 401 says so plainly', () => {
  for (const status of [400, 403, 404, 422, 500, 502, 503]) {
    const outcome = promptListFrom({ status, body: { prompts: [choice()] } })
    assert.equal(outcome.ok, false, String(status))
    assert.equal(outcome.ok === false && outcome.message, PICKER_MESSAGES.failed)
  }
  const expired = promptListFrom({ status: 401, body: null })
  assert.equal(expired.ok === false && expired.message, PICKER_MESSAGES.expired)
})

test('response: NO SERVER PROSE IS EVER READ OR SHOWN', () => {
  const hostile = {
    status: 500,
    body: { error: 'permission denied for table statement_prompts', code: 'server-error' },
  }
  const outcome = promptListFrom(hostile)
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.message, PICKER_MESSAGES.failed)
  for (const leak of ['permission denied', 'statement_prompts', 'server-error']) {
    assert.equal(outcome.message.includes(leak), false, `${leak} must never be shown`)
  }
})

test('response: THE SAME CONTRACT AS THE ROW PARSER, not a second opinion', () => {
  // picker.ts repeats promptRepo's value rules rather than importing them, so
  // that a server data-access module stays out of the browser bundle. This is
  // what stops the two copies drifting apart.
  const cases: Record<string, unknown>[] = [
    {}, { statedMaxWords: null }, { applicationCycle: null },
    { label: 'a'.repeat(200) }, { label: 'a'.repeat(201) },
    { promptText: 'a'.repeat(5000) }, { promptText: 'a'.repeat(5001) },
    { statedMaxWords: 1 }, { statedMaxWords: 5000 }, { statedMaxWords: 0 },
    { statedMaxWords: 5001 }, { statedMaxWords: '500' },
    { applicationCycle: '2026-2027' }, { applicationCycle: '26' },
    { promptText: '\u{1f642}'.repeat(3000) },
  ]
  for (const over of cases) {
    const item = choice(over)
    const viaPicker = promptListFrom(ok([item])).ok
    const viaRow = promptOptionFromRow({
      id: item.id as never,
      label: item.label as never,
      prompt_text: item.promptText as never,
      stated_max_words: item.statedMaxWords as never,
      application_cycle: item.applicationCycle as never,
    }) !== null
    assert.equal(viaPicker, viaRow, `disagreed about ${JSON.stringify(over)}`)
  }
})

// ====================================================== the stale-reply guard

test('stale: a reply is applied ONLY when its school is still being browsed', () => {
  assert.equal(mayApplyPrompts({ requestedFor: A, browsingNow: A }), true)
  // The applicant has moved on: the older reply must be dropped.
  assert.equal(mayApplyPrompts({ requestedFor: A, browsingNow: B }), false)
  // Nothing is being browsed any more.
  assert.equal(mayApplyPrompts({ requestedFor: A, browsingNow: null }), false)
})

test('stale: THE OUT-OF-ORDER CASE, played out', () => {
  // Click school A, then school B. A's reply lands last. It must not be shown.
  let browsing: string | null = A
  browsing = B                                        // the second click
  assert.equal(mayApplyPrompts({ requestedFor: A, browsingNow: browsing }), false)
  assert.equal(mayApplyPrompts({ requestedFor: B, browsingNow: browsing }), true)
})

test('stale: the comparison is EXACT -- no truthiness, no prefix', () => {
  assert.equal(mayApplyPrompts({ requestedFor: A, browsingNow: A.toUpperCase() }), false)
  assert.equal(mayApplyPrompts({ requestedFor: A, browsingNow: A.slice(0, -1) }), false)
  assert.equal(mayApplyPrompts({ requestedFor: '', browsingNow: '' }), true)
})

// =================================================== saved versus previewed

test('saved: a preview is "saved" only when the DRAFT already answers it', () => {
  assert.equal(previewIsSaved({ previewId: P1, savedPromptId: P1 }), true)
  assert.equal(previewIsSaved({ previewId: P1, savedPromptId: P2 }), false)
  // A generic draft never "already uses" anything, however close the preview.
  assert.equal(previewIsSaved({ previewId: P1, savedPromptId: null }), false)
  assert.equal(previewIsSaved({ previewId: null, savedPromptId: P1 }), false)
  assert.equal(previewIsSaved({ previewId: null, savedPromptId: null }), false)
})

test('saved: the stored snapshot is shown from the DRAFT, prompt plus wording', () => {
  assert.equal(hasSavedPrompt({ promptId: P1, promptText: WORDING }), true)
  // A generic draft has nothing to show.
  assert.equal(hasSavedPrompt({ promptId: null, promptText: null }), false)
  // And a half-snapshot is not a snapshot. rows.ts already refuses such a row,
  // so this cannot arrive -- it is asserted so the panel cannot render half.
  assert.equal(hasSavedPrompt({ promptId: P1, promptText: null }), false)
  assert.equal(hasSavedPrompt({ promptId: null, promptText: WORDING }), false)
})

test('saved: A STORED PROMPT ABSENT FROM THE CATALOG STAYS VISIBLE', () => {
  // The draft stores its own wording precisely so a withdrawn or edited catalog
  // row cannot change the question an essay was written to answer. And absence
  // from a list proves nothing: it may be another school's list, or no list.
  assert.equal(hasSavedPrompt({ promptId: P1, promptText: WORDING }), true)
  // Whatever the fetched list holds -- empty, or other prompts entirely.
  for (const listed of [[], [choice({ id: P2 })]]) {
    const outcome = promptListFrom(ok(listed))
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.prompts.some((p) => p.id === P1), false, 'not in the list')
    // The panel's condition is unaffected by the list.
    assert.equal(hasSavedPrompt({ promptId: P1, promptText: WORDING }), true)
    assert.equal(previewIsSaved({ previewId: P2, savedPromptId: P1 }), false)
  }
})

// ===================================================== the pending selection

const SCHOOL_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const DOC = { title: 'My essay', essay: 'Essay content', revision: 4 }

/** The body a save would send for a given pending selection. */
const bodyFor = (pending: PendingPrompt | null) => {
  const request = statementSaveRequest({ ...DOC, prompt: promptForRequest(pending) })
  assert.equal(request.ok, true)
  return request.ok ? (request.body as Record<string, unknown>) : null
}

/** A save response carrying a canonical snapshot. */
const savedBody = (over: Record<string, unknown> = {}) => ({
  draft: {
    id: 'd1e2f3a4-0000-4000-8000-000000000001',
    title: 'My essay', essay: 'Essay content', revision: 5,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    schoolId: SCHOOL_A, promptId: P1, promptText: WORDING, statedMaxWords: 500,
    ...over,
  },
})

/**
 * A never-resetting token source, exactly as the component holds one.
 *
 * The component keeps `lastPromptToken` in a ref that is incremented on every
 * selection and cleared by nothing. This models that, so these tests exercise
 * the identity scheme the editor actually uses.
 */
function counter(): (promptId: string | null) => PendingPrompt {
  let last = 0
  return (promptId: string | null) => {
    const next = nextPendingPrompt(last, promptId)
    last = next.token
    return next
  }
}

test('pending: TOKENS MAKE A -> B -> A THREE DISTINGUISHABLE SELECTIONS', () => {
  // The whole reason a token exists. Comparing uuids could not tell the first A
  // from the third, so a response for the first would retire the third and the
  // applicant's standing choice would vanish with no error anywhere.
  const choose = counter()
  const first = choose(P1)
  const second = choose(P2)
  const third = choose(P1)

  assert.deepEqual([first.token, second.token, third.token], [1, 2, 3])
  assert.equal(first.promptId, P1)
  assert.equal(third.promptId, P1, 'the same uuid as the first')
  assert.notEqual(first.token, third.token, 'but NOT the same selection')
  assert.equal(samePendingPrompt(first, third), false)
  assert.equal(new Set([first.token, second.token, third.token]).size, 3)
})

test('pending: THE COUNTER NEVER RESETS, across successes and reloads', () => {
  // The correction J2b required. Counting from whatever is PENDING would
  // restart at 1 after every success -- and a response for the first token 1
  // could then retire a brand new token 1 issued after it.
  const choose = counter()
  const a = choose(P1)
  // …a succeeds, so the component retires it and pending becomes null.
  const afterSuccess = choose(P2)
  assert.equal(afterSuccess.token, 2, 'NOT 1 again')
  assert.equal(samePendingPrompt(a, afterSuccess), false)
  // …a conflict reload discards it, and pending becomes null again.
  const afterReload = choose(P1)
  assert.equal(afterReload.token, 3)
  assert.equal(samePendingPrompt(a, afterReload), false, 'the first A cannot retire this one')
})

test('pending: a clear is a selection too, with its own token', () => {
  const choose = counter()
  const select = choose(P1)
  const clear = choose(null)
  assert.equal(clear.token, 2)
  assert.equal(clear.promptId, null)
  assert.equal(samePendingPrompt(select, clear), false)
})

test('pending: identity is BY TOKEN, and nothing matches nothing', () => {
  const a = nextPendingPrompt(0, P1)
  assert.equal(samePendingPrompt(a, a), true)
  assert.equal(samePendingPrompt(a, { token: a.token, promptId: P2 }), true,
    'the token is the identity, not the id it carries')
  assert.equal(samePendingPrompt(a, null), false)
  assert.equal(samePendingPrompt(null, a), false)
  assert.equal(samePendingPrompt(null, null), false, 'no pending selection is not a match')
})

// --------------------------------------------------- what the request carries

test('request: NOTHING PENDING produces the original three keys', () => {
  const body = bodyFor(null)
  assert.deepEqual(Object.keys(body as object), ['title', 'essay', 'expectedRevision'])
  assert.equal('promptId' in (body as object), false)
  assert.equal(promptForRequest(null), undefined)
})

test('request: a PENDING UUID puts that id in the same PATCH body', () => {
  const body = bodyFor(nextPendingPrompt(0, P1))
  assert.equal((body as Record<string, unknown>).promptId, P1)
  assert.deepEqual(Object.keys(body as object).sort(),
    ['essay', 'expectedRevision', 'promptId', 'title'])
  assert.equal(promptForRequest(nextPendingPrompt(0, P1)), P1)
})

test('request: a PENDING CLEAR puts promptId: null in the same PATCH body', () => {
  const body = bodyFor(nextPendingPrompt(0, null))
  assert.equal((body as Record<string, unknown>).promptId, null)
  assert.equal('promptId' in (body as object), true)
  assert.equal(promptForRequest(nextPendingPrompt(0, null)), null)
  // AND IT IS NOT THE SAME AS NOTHING PENDING. Collapsing these would make
  // every keystroke wipe the applicant's prompt.
  assert.notEqual(promptForRequest(nextPendingPrompt(0, null)), promptForRequest(null))
})

// ----------------------------------------------- the response reconciliation

test('response: the SAVED SNAPSHOT COMES FROM THE SERVER, not from what we sent', () => {
  // The server resolved the school, the wording and the limit; the browser sent
  // only an id. So the display must take the server's four fields.
  const saved = savedPromptFromResponse(savedBody())
  assert.notEqual(saved, null)
  assert.deepEqual(saved, {
    schoolId: SCHOOL_A, promptId: P1, promptText: WORDING, statedMaxWords: 500,
  })
})

test('response: a GENERIC server snapshot comes back as four nulls', () => {
  const saved = savedPromptFromResponse(savedBody({
    schoolId: null, promptId: null, promptText: null, statedMaxWords: null,
  }))
  assert.deepEqual(saved, {
    schoolId: null, promptId: null, promptText: null, statedMaxWords: null,
  })
})

test('response: A MALFORMED SNAPSHOT RETURNS NULL -- never a false success', () => {
  // The caller must then neither update the display nor retire the pending
  // selection. Claiming a selection was saved on the strength of a body this
  // code could not read is the false success this guards against.
  const broken: unknown[] = [
    null, undefined, 'draft', 42, [], {}, { draft: null }, { draft: 'x' }, { draft: 42 },
    savedBody({ promptId: undefined }),
    savedBody({ schoolId: undefined }),
    savedBody({ promptText: undefined }),
    savedBody({ statedMaxWords: undefined }),
    savedBody({ promptId: 'not-a-uuid' }),
    savedBody({ schoolId: 'not-a-uuid' }),
    savedBody({ promptText: '   ' }),
    savedBody({ promptText: null }),             // partial: an id with no wording
    savedBody({ schoolId: null }),               // partial: wording with no school
    savedBody({ statedMaxWords: 0 }),
    savedBody({ statedMaxWords: 5001 }),
    savedBody({ statedMaxWords: '500' }),
  ]
  for (const body of broken) {
    assert.equal(savedPromptFromResponse(body), null, JSON.stringify(body) ?? String(body))
  }
})

test('response: the strict parser is ROWS.TS’s, not a second opinion', () => {
  // savedPromptFromResponse calls draftPromptFrom rather than repeating it, so
  // the editor cannot disagree with the repository about a coherent snapshot.
  const cases: Record<string, unknown>[] = [
    {},
    { statedMaxWords: null },
    { schoolId: null, promptId: null, promptText: null, statedMaxWords: null },
    { promptText: null }, { schoolId: null }, { statedMaxWords: 5001 },
    { promptText: 'a'.repeat(5001) },
  ]
  for (const over of cases) {
    const viaResponse = savedPromptFromResponse(savedBody(over)) !== null
    const row = { schoolId: SCHOOL_A, promptId: P1, promptText: WORDING, statedMaxWords: 500, ...over }
    const viaRows = draftPromptFrom(row) !== undefined
    assert.equal(viaResponse, viaRows, `disagreed about ${JSON.stringify(over)}`)
  }
})

// ------------------------------------------------------------- the races

test('race: A SUCCEEDS WITH NO NEWER CHOICE -> A is retired', () => {
  // The simple case. `current` models the component's ref.
  let current: PendingPrompt | null = nextPendingPrompt(0, P1)
  const captured = current                       // startSave captures it

  // …the response arrives, carrying a usable snapshot.
  assert.notEqual(savedPromptFromResponse(savedBody()), null)
  assert.equal(samePendingPrompt(current, captured), true)
  if (samePendingPrompt(current, captured)) current = null
  assert.equal(current, null, 'nothing is left pending')
})

test('race: A STARTS, B ARRIVES, A SUCCEEDS -> B REMAINS PENDING', () => {
  // The required scenario.
  let current: PendingPrompt | null = nextPendingPrompt(0, P1)   // choose A
  const captured = current                                          // A's PATCH leaves
  current = nextPendingPrompt(1, P2)                           // choose B mid-flight

  // A's response lands, with the server's snapshot for A.
  const saved = savedPromptFromResponse(savedBody({ promptId: P1 }))
  assert.notEqual(saved, null, 'the display takes the server’s answer for A')
  assert.equal(saved?.promptId, P1)

  // B MUST SURVIVE.
  assert.equal(samePendingPrompt(current, captured), false, 'the tokens differ')
  if (samePendingPrompt(current, captured)) current = null
  assert.notEqual(current, null)
  assert.equal(current?.promptId, P2)
  assert.equal(current?.token, 2)
  // And the next save sends B, in the same three-plus-one body shape.
  assert.equal((bodyFor(current) as Record<string, unknown>).promptId, P2)
})

test('race: A -> B -> A, and the FIRST A’s response must not retire the FINAL A', () => {
  // The case uuid comparison cannot solve.
  let current: PendingPrompt | null = nextPendingPrompt(0, P1)   // A
  const capturedFirstA = current                                    // A's PATCH leaves
  current = nextPendingPrompt(1, P2)                           // B
  current = nextPendingPrompt(2, P1)                           // A again

  // Same uuid as the captured one…
  assert.equal(current?.promptId, capturedFirstA.promptId)
  // …but NOT the same selection.
  assert.equal(samePendingPrompt(current, capturedFirstA), false)
  if (samePendingPrompt(current, capturedFirstA)) current = null
  assert.notEqual(current, null, 'the final A survives')
  assert.equal(current?.token, 3)
})

test('race: A MALFORMED SUCCESS RETIRES NOTHING', () => {
  let current: PendingPrompt | null = nextPendingPrompt(0, P1)
  const captured = current

  const saved = savedPromptFromResponse(savedBody({ promptText: null }))
  assert.equal(saved, null)
  // The component's guard is `if (saved !== null)`, so neither the display nor
  // the retirement happens. The selection stays pending.
  if (saved !== null && samePendingPrompt(current, captured)) current = null
  assert.notEqual(current, null, 'the selection is NOT claimed as saved')
  assert.equal(current?.promptId, P1)
})

test('race: EVERY FAILURE LEAVES THE SELECTION PENDING', () => {
  // Network throw, 400, 401, 409, 422, 500, and a 2xx whose revision is
  // unreadable. None of them produces a usable snapshot, so none retires.
  for (const body of [
    null, { error: 'nope' }, { draft: {} }, { draft: null },
  ]) {
    let current: PendingPrompt | null = nextPendingPrompt(0, P1)
    const captured = current
    const saved = savedPromptFromResponse(body)
    assert.equal(saved, null)
    if (saved !== null && samePendingPrompt(current, captured)) current = null
    assert.notEqual(current, null, JSON.stringify(body) ?? 'throw')
  }
})

test('race: a MANUAL RETRY sends the CURRENT selection, not a captured one', () => {
  // retrySave dispatches `retry`, which makes the driver save again -- and
  // startSave re-reads the ref, so the newest instruction goes out.
  let current: PendingPrompt | null = nextPendingPrompt(0, P1)
  const capturedByTheFailedSave = current
  current = nextPendingPrompt(1, P2)      // chosen after the failure

  assert.equal((bodyFor(current) as Record<string, unknown>).promptId, P2)
  assert.notEqual((bodyFor(current) as Record<string, unknown>).promptId,
    capturedByTheFailedSave.promptId)
})

// ------------------------------------------------- the no-redundant-write rule

test('write: choosing the ALREADY SAVED prompt with nothing pending is not a write', () => {
  // A second identical save would consume a revision and move the retention
  // clock to record a change that is not one.
  assert.equal(needsPromptWrite({ chosenId: P1, savedPromptId: P1, pending: null }), false)
  assert.equal(needsPromptWrite({ chosenId: P2, savedPromptId: P1, pending: null }), true)
  // A generic draft: choosing anything is a change; clearing nothing is not.
  assert.equal(needsPromptWrite({ chosenId: P1, savedPromptId: null, pending: null }), true)
  assert.equal(needsPromptWrite({ chosenId: null, savedPromptId: null, pending: null }), false)
  // Clearing a saved prompt IS a change.
  assert.equal(needsPromptWrite({ chosenId: null, savedPromptId: P1, pending: null }), true)
})

test('write: anything PENDING means a write, even for the saved id', () => {
  // The pending instruction may be a CLEAR, and "the draft already answers
  // this" says nothing about an instruction that has not landed.
  const pendingClear = nextPendingPrompt(0, null)
  assert.equal(needsPromptWrite({ chosenId: P1, savedPromptId: P1, pending: pendingClear }), true)
})

// ------------------------------------------- the in-flight reversal (J2b §3)

test('reversal: CHOOSING A WHILE B IS IN FLIGHT IS NOT A NO-OP', () => {
  // The required scenario. Saved is A, a request attaching B is in the air, and
  // the applicant chooses A again. Suppressing that would let B silently become
  // the final answer.
  const choose = counter()
  const pendingB = choose(P2)                  // B chosen, now in flight
  const captured = pendingB

  assert.equal(needsPromptWrite({ chosenId: P1, savedPromptId: P1, pending: pendingB }), true,
    'the pending instruction is B, so choosing A IS a change')

  const pendingA = choose(P1)                  // the reversal
  assert.equal(pendingA.token, 2)

  // B's response lands. It must not retire A.
  assert.equal(samePendingPrompt(pendingA, captured), false)
  // And the display takes the server's answer for B, which is honest: B really
  // was saved. A stays pending and the next save sends it.
  assert.equal(promptForRequest(pendingA), P1)
})

test('reversal: an IDENTICAL re-choice while in flight is NOT a second write', () => {
  // pending A, chosen A -> the instruction is already on its way.
  const pendingA = nextPendingPrompt(0, P1)
  assert.equal(needsPromptWrite({ chosenId: P1, savedPromptId: null, pending: pendingA }), false)
  // But pending <clear>, chosen A IS a change: the clear must be reversed.
  const pendingClear = nextPendingPrompt(0, null)
  assert.equal(needsPromptWrite({ chosenId: P1, savedPromptId: P1, pending: pendingClear }), true)
})

// ----------------------------------------- the three badges (J2b §4)

test('badge: SAVED only when the server confirmed it and nothing newer waits', () => {
  assert.equal(promptBadgeFor({ promptId: P1, savedPromptId: P1, pending: null }), 'saved')
  assert.equal(promptBadgeFor({ promptId: P2, savedPromptId: P1, pending: null }), 'preview')
  assert.equal(promptBadgeFor({ promptId: P1, savedPromptId: null, pending: null }), 'preview')
})

test('badge: PENDING BEATS SAVED, so a newer choice never looks settled', () => {
  // The rule that stops an older response making a newer instruction appear
  // finished. Even when the uuid matches the stored one.
  const pendingA = nextPendingPrompt(0, P1)
  assert.equal(promptBadgeFor({ promptId: P1, savedPromptId: P1, pending: pendingA }), 'pending')
  // And a prompt that is NOT the pending one is merely a preview, even if the
  // server's snapshot still names it.
  assert.equal(promptBadgeFor({ promptId: P1, savedPromptId: P1, pending: nextPendingPrompt(0, P2) }),
    'preview')
})

test('badge: a pending CLEAR leaves nothing looking saved', () => {
  const clearing = nextPendingPrompt(0, null)
  assert.equal(promptBadgeFor({ promptId: P1, savedPromptId: P1, pending: clearing }), 'preview')
})

// -------------------------- the unconfirmed 200 and its warning (J2b §5, §6)

test('confirm: a warning belongs to ONE selection, by token', () => {
  const choose = counter()
  const a = choose(P1)
  assert.equal(confirmationApplies({ failedToken: a.token, pending: a }), true)

  // The applicant chooses B: the warning for A no longer describes anything.
  const b = choose(P2)
  assert.equal(confirmationApplies({ failedToken: a.token, pending: b }), false,
    'a failure for A must not read as a failure of B')

  // Nothing pending, or no failure recorded: nothing to show.
  assert.equal(confirmationApplies({ failedToken: a.token, pending: null }), false)
  assert.equal(confirmationApplies({ failedToken: null, pending: b }), false)
  assert.equal(confirmationApplies({ failedToken: null, pending: null }), false)
})

test('confirm: the approved wording, exact, and a labelled retry', () => {
  assert.equal(
    PICKER_MESSAGES.confirmationFailed,
    'Your essay was saved, but we couldn’t confirm your prompt selection. '
    + 'Please try saving the prompt again.'
  )
  assert.equal(PICKER_MESSAGES.retryPromptSave, 'Try saving prompt again')
  // It says BOTH true things: the essay saved, the prompt did not confirm.
  assert.match(PICKER_MESSAGES.confirmationFailed, /essay was saved/)
  assert.match(PICKER_MESSAGES.confirmationFailed, /couldn’t confirm/)
})

test('confirm: AN UNREADABLE 200 LEAVES THE SELECTION PENDING AND WARNS', () => {
  // Played out as the component does it: the revision parsed, so the engine
  // will say saved -- but the four canonical fields did not, so the selection
  // is not confirmed.
  const choose = counter()
  let current: PendingPrompt | null = choose(P1)
  const captured = current

  const saved = savedPromptFromResponse(savedBody({ promptText: null }))
  assert.equal(saved, null, 'the canonical snapshot is unusable')

  // The component's branches, in order.
  let failedToken: number | null = null
  if (saved !== null) {
    if (samePendingPrompt(current, captured)) current = null
  } else if (captured !== null) {
    failedToken = captured.token
  }

  assert.notEqual(current, null, 'the selection is NOT retired')
  assert.equal(current?.promptId, P1)
  assert.equal(failedToken, captured.token)
  assert.equal(confirmationApplies({ failedToken, pending: current }), true, 'and it warns')
  // AND IT IS NOT SHOWN AS SAVED.
  assert.equal(promptBadgeFor({ promptId: P1, savedPromptId: null, pending: current }), 'pending')
})

test('confirm: a LATER SUCCESS clears the warning for that same selection', () => {
  const choose = counter()
  let current: PendingPrompt | null = choose(P1)
  let failedToken: number | null = current.token

  // The deliberate retry sends the same pending selection, and this time the
  // snapshot is readable.
  const captured = current
  const saved = savedPromptFromResponse(savedBody())
  assert.notEqual(saved, null)
  if (saved !== null && samePendingPrompt(current, captured)) {
    current = null
    if (failedToken === captured.token) failedToken = null
  }
  assert.equal(current, null, 'retired')
  assert.equal(failedToken, null, 'and the warning is spent')
  assert.equal(confirmationApplies({ failedToken, pending: current }), false)
})

test('confirm: A FAILURE FOR A DOES NOT BECOME B’S PROBLEM', () => {
  const choose = counter()
  const a = choose(P1)
  const failedToken: number | null = a.token
  // The applicant chooses B. The component clears the warning on a new
  // and even if it did not, confirmationApplies would refuse to show it.
  const b = choose(P2)
  assert.equal(confirmationApplies({ failedToken, pending: b }), false)
  assert.equal(promptBadgeFor({ promptId: P2, savedPromptId: null, pending: b }), 'pending')
})

// ----------------------------------------------- the conflict-reload notice

test('reload: the approved discard notice is exact', () => {
  assert.equal(
    PICKER_MESSAGES.selectionDiscarded,
    'Your unsaved prompt selection was not kept. Choose it again if you still want to use it.'
  )
  // Distinct from every other notice, so it is its own state.
  const messages = Object.values(PICKER_MESSAGES)
  assert.equal(new Set(messages).size, messages.length)
})

// ====================================================== the components' source

const path = (r: string) => fileURLToPath(new URL(r, import.meta.url))
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const PICKER = strip(readFileSync(path('../../../app/statement-studio/components/PromptPicker.tsx'), 'utf8'))
const CLIENT = strip(readFileSync(path('../../../app/statement-studio/components/StatementStudioClient.tsx'), 'utf8'))

test('component: the stripping kept the code and dropped the prose', () => {
  assert.equal(PICKER.includes('export default function PromptPicker'), true)
  assert.equal(PICKER.includes('THE ONE THING TO UNDERSTAND'), false)
  assert.equal(CLIENT.includes('<PromptPicker'), true)
})

test('component: BROWSING CANNOT WRITE -- the picker has no way to', () => {
  // The guarantee, as a property of the source. A function that is not passed
  // in cannot be called.
  // NOTE THE PARENTHESES on the setters. `setPrompt` without one is a substring
  // of this component's OWN `setPrompts` and `setPromptsFor`, so the bare form
  // would ban the picker's local state and prove nothing about the draft's.
  for (const forbidden of [
    'setPrompt(', 'setEssay(', 'setTitle(', 'setSave(',           // the editor's setters
    "type: 'edited'", "type: 'flush'", 'reduce(',                 // autosave events
    "method: 'PATCH'", "method: 'POST'", "method: 'PUT'",         // writes
    'draftApiPath', 'saveAttemptFor', 'statementSaveRequest',     // the save path
    'expectedRevision', 'promptSelectionOf',
  ]) {
    assert.equal(PICKER.includes(forbidden), false, `the picker must not touch ${forbidden}`)
  }
  // And the local setters it DOES have are its own, named distinctly.
  for (const own of ['setPrompts(', 'setPromptsFor(', 'setPreview(']) {
    assert.equal(PICKER.includes(own), true, `${own} is the picker's own state`)
  }
  // It is handed the snapshot and nothing that could change one.
  assert.match(CLIENT, /saved=\{prompt\}/)
  assert.equal(CLIENT.includes('onPromptChange'), false, 'no callback reaches back')
  assert.equal(CLIENT.includes('onSelectPrompt'), false)
})

test('component: the picker makes ONE kind of request, to the gated endpoint', () => {
  assert.equal((PICKER.match(/await fetch\(/g) ?? []).length, 1)
  assert.match(PICKER, /fetch\(promptsPath\(school\.id\)/)
  assert.match(PICKER, /method: 'GET'/)
  assert.match(PICKER, /cache: 'no-store'/)
  // NO BROWSER-SIDE DATABASE ACCESS, in either component.
  for (const source of [PICKER, CLIENT]) {
    for (const forbidden of [/createClient/, /supabase/i, /anon[_-]?key/i, /@supabase/]) {
      assert.doesNotMatch(source, forbidden, 'the browser must not query the database')
    }
  }
  // And the schools are NOT re-fetched: they arrive as a prop.
  assert.equal(PICKER.includes("from('schools')"), false)
  assert.equal(PICKER.includes('/api/statement/schools'), false)
})

test('component: the stale guard and the abort are both wired', () => {
  assert.match(PICKER, /inFlight\.current\?\.abort\(\)/)
  assert.match(PICKER, /new AbortController\(\)/)
  assert.match(PICKER, /signal: controller\.signal/)
  // The ref, not the state, is what the guard reads.
  assert.match(PICKER, /browsingRef\.current = school\.id/)
  assert.match(PICKER, /browsingNow: browsingRef\.current/)
  // The guard is applied on BOTH the success path and the catch path.
  assert.equal((PICKER.match(/mayApplyPrompts\(\{/g) ?? []).length, 2)
  // And the old list is cleared before the new request, so a previous school's
  // prompts cannot sit under a different school's name.
  const browse = PICKER.slice(PICKER.indexOf('const browseSchool'), PICKER.indexOf('const matches'))
  assert.ok(browse.length > 0, 'the handler was located')
  assert.ok(browse.indexOf('setPromptsFor(null)') < browse.indexOf('await fetch('))
  assert.ok(browse.indexOf('setPrompts([])') < browse.indexOf('await fetch('))
})

test('component: wording is ESCAPED REACT TEXT, never raw HTML', () => {
  for (const source of [PICKER, CLIENT]) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
  }
  // Rendered as a child, with whitespace preserved.
  assert.match(PICKER, /whitespace-pre-wrap[^\n]*>\s*\n?\s*\{preview\.promptText\}/)
  assert.match(PICKER, /whitespace-pre-wrap[^\n]*>\s*\n?\s*\{saved\.promptText\}/)
})

test('component: THREE BADGES, and a preview is never shown as attached', () => {
  // Retargeted: the attach action works now, so the invariant is no longer
  // "nothing is ever attached" but "the three states are distinguishable and a
  // chosen-but-unconfirmed prompt never reads as saved".
  assert.match(PICKER, /Preview — not attached to your draft/)
  // "not yet saved" rather than "saving with your next change": choosing a
  // prompt already dispatches `edited` and schedules the save, so telling the
  // applicant to make another change would be false.
  assert.match(PICKER, /Chosen — not yet saved/)
  assert.equal(PICKER.includes('saving with your next change'), false)
  assert.equal(PICKER.includes('next change'), false)
  assert.match(PICKER, /Already your draft&rsquo;s prompt/)
  // All three come from ONE decision, so they cannot overlap or both appear.
  assert.match(PICKER, /promptBadgeFor\(\{/)
  assert.match(PICKER, /previewBadge === 'saved'/)
  assert.match(PICKER, /previewBadge === 'pending'/)
  assert.match(PICKER, /previewBadge === 'preview'/)
  // And `pending` beats `saved` inside promptBadgeFor -- asserted on the pure
  // function above, which is what makes the UI claim safe.
  assert.equal(
    promptBadgeFor({ promptId: P1, savedPromptId: P1, pending: nextPendingPrompt(0, P1) }),
    'pending'
  )
})

test('component: the ATTACH BUTTON is enabled only when it would change something', () => {
  assert.match(PICKER, /disabled=\{!canUsePreview\}/)
  assert.match(PICKER, /onClick=\{\(\) => onUsePrompt\(preview\.id\)\}/)
  assert.match(PICKER, /const canUsePreview = preview !== null && needsPromptWrite\(\{/)
  // The placeholder is gone, and so is its title.
  assert.equal(PICKER.includes('coming soon'), false)
  assert.equal(PICKER.includes('not available yet'), false)
  // ONLY THE ID LEAVES. No school, no wording, no limit, no cycle.
  assert.equal(PICKER.includes('onUsePrompt(preview)'), false)
  assert.equal(PICKER.includes('onUsePrompt(choice)'), false)
  for (const field of ['schoolId', 'promptText', 'statedMaxWords', 'applicationCycle']) {
    assert.equal(PICKER.includes(`onUsePrompt(${field}`), false)
  }
  // And still no request of its own: one fetch, and it is the catalog GET.
  assert.equal((PICKER.match(/await fetch\(/g) ?? []).length, 1)
  assert.equal(PICKER.includes("method: 'PATCH'"), false)
})

test('component: the CONFIRMATION WARNING is shown with a deliberate retry', () => {
  assert.match(PICKER, /confirmationApplies\(\{ failedToken: confirmFailedToken, pending \}\)/)
  assert.match(PICKER, /PICKER_MESSAGES\.confirmationFailed/)
  assert.match(PICKER, /onClick=\{onRetryPromptSave\}/)
  assert.match(PICKER, /PICKER_MESSAGES\.retryPromptSave/)
  assert.match(PICKER, /role="alert"/)
  // The retry is a BUTTON the applicant presses. Nothing schedules it.
  assert.equal(PICKER.includes('setTimeout'), false)
  assert.equal(PICKER.includes('setInterval'), false)
})

test('component: no second save path, and no new PATCH field', () => {
  // The editor still has exactly one body expression, built by the validator.
  assert.equal(CLIENT.split('body: JSON.stringify(attempt.body)').length - 1, 1)
  assert.equal((CLIENT.match(/JSON\.stringify\(/g) ?? []).length, 1)
  // Three fetches in the editor, one in the picker: four in all, and the new
  // one is a GET to the catalog.
  assert.equal((CLIENT.match(/await fetch\(/g) ?? []).length, 3)
  assert.equal((PICKER.match(/await fetch\(/g) ?? []).length, 1)
})

test('component: accessible, and usable on a phone', () => {
  // A labelled search box, keyboard-reachable options, and announced notices.
  assert.match(PICKER, /htmlFor="statement-school-search"/)
  assert.match(PICKER, /id="statement-school-search"/)
  assert.match(PICKER, /role="status"/)
  assert.match(PICKER, /aria-pressed=/)
  // Options are BUTTONS, so Tab and Enter already work -- no div handlers.
  assert.doesNotMatch(PICKER, /<div[^>]*onClick/)
  assert.equal((PICKER.match(/type="button"/g) ?? []).length >= 4, true)
  // Wrapping rows rather than fixed widths.
  assert.match(PICKER, /flex-wrap/)
})

test('a saved snapshot can be given its school’s name', () => {
  const schools = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Duke University', locationState: 'NC' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Rutgers', locationState: null },
  ]
  assert.equal(schoolNameFor(schools, schools[0].id), 'Duke University — NC')
  // The null-state case goes through schoolLabel, so there is no dangling dash.
  assert.equal(schoolNameFor(schools, schools[1].id), 'Rutgers')
})

test('an unknown school id gets NULL, never an invented name', () => {
  // A draft can outlive a directory entry. The saved WORDING is on screen
  // either way, which is the part that matters.
  const schools = [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Duke', locationState: 'NC' }]
  assert.equal(schoolNameFor(schools, 'aaaaaaaa-0000-4000-8000-00000000beef'), null)
  assert.equal(schoolNameFor(schools, null), null)
  assert.equal(schoolNameFor(schools, '' as never), null)
  assert.equal(schoolNameFor([], 'aaaaaaaa-0000-4000-8000-000000000001'), null)
})

test('the picker can omit the saved panel the parent already shows', () => {
  // A presentation prop only. The markup is unchanged and still rendered
  // whenever the component is used on its own.
  assert.match(PICKER, /savedShownByParent = false/, 'and it defaults to showing it')
  assert.match(PICKER, /savedShownByParent \? null : savedVisible \? \(/)
  assert.match(PICKER, /\{!savedShownByParent && \(/, 'the heading goes with it')
  // Still there, still whitespace-preserving, for every other caller.
  assert.match(PICKER, /whitespace-pre-wrap[^\n]*>\s*\n?\s*\{saved\.promptText\}/)
})

test('NO RULE, GUARD OR REQUEST IS CONDITIONAL ON THE PRESENTATION PROP', () => {
  // The confirmation warning in particular is still rendered: an unconfirmed
  // save must stay visible wherever this component appears.
  const warning = PICKER.slice(PICKER.indexOf('confirmationApplies({'))
  assert.doesNotMatch(warning.slice(0, 200), /savedShownByParent/)
  for (const rule of ['fetch(promptsPath(', 'mayApplyPrompts(', 'needsPromptWrite(',
                      'promptBadgeFor(', 'browsingRef.current']) {
    const at = PICKER.indexOf(rule)
    assert.notEqual(at, -1, rule)
    assert.doesNotMatch(PICKER.slice(Math.max(0, at - 160), at), /savedShownByParent/,
      `${rule} must not depend on presentation`)
  }
})
