import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PICKER_MESSAGES, PROMPTS_ENDPOINT, directoryNotice, hasSavedPrompt, matchingSchools,
  mayApplyPrompts, previewIsSaved, promptListFrom, promptsPath, schoolLabel, wordLimitLabel,
} from './picker.ts'
import type { SchoolOption } from './schoolPicker.ts'
// Imported ONLY to assert the response parser and the ROW parser agree.
import { promptOptionFromRow } from './promptRepo.ts'
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

test('component: a preview is LABELLED as not attached, every time', () => {
  assert.match(PICKER, /Preview — not attached to your draft/)
  assert.match(PICKER, /previewIsSaved\(\{/)
  // The attach action exists only as a disabled placeholder.
  assert.match(PICKER, /disabled\n\s*title="Attaching a prompt to a draft is not available yet\."/)
  assert.match(PICKER, /coming soon/)
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
