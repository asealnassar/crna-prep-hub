/**
 * QA-004: the raised ceiling, rehearsed through the routes the editor calls.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS A REHEARSAL OF
 * ---------------------------------------------------------------------------
 * University of Tennessee Knoxville publishes a maximum of 18,000 characters
 * EXCLUDING spaces. The column counts what is stored, which includes them.
 * Prose at exactly that maximum measures 18,000 excluding spaces and 22,287
 * stored -- so an applicant writing to their school's published limit could
 * not save at all against the 20,000-character CHECK.
 *
 * Migration 016 raises the CHECK to 30,000 and IS NOT APPLIED. This file
 * exercises the post-016 behaviour the only way it can be exercised without
 * applying anything: in simulated-live mode, where the local JSON store stands
 * in for the table AND NOW EMULATES THE POST-016 CHECK ITSELF. A store that
 * accepted every length would have proved only that the route's validator
 * refused first.
 *
 * NOTHING HERE TOUCHES PRODUCTION, and nothing here changes what the real
 * database enforces. maxSavedChars() answers 20,000 against the real table
 * whatever NODE_ENV says; see its own comment.
 *
 * ONLY AUTHENTICATION IS MOCKED. The real route, validator, repository,
 * guarded client and local store all run.
 */
import test, { before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'

const USER = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'a@example.invalid', tier: 'ultimate', isUltimate: true,
}
// ITS OWN STORE. This suite deletes the file it points at, and the developer's
// review drafts are not fixtures. See writeIsolation.test.ts for the guard
// that now checks every suite in this directory obeys this.
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.ceiling-test.json'
const STORE = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const PAYLOAD = 'local-review/statement_requirements_catalog.json'
const skip = !existsSync(PAYLOAD) || typeof mock.module !== 'function'

type Handler = (request: unknown, context?: unknown) => Promise<Response>
let POST: Handler | null = null
let GET_ITEM: Handler | null = null
let PATCH_ITEM: Handler | null = null
let GET_LIST: Handler | null = null
let requirementId = ''
let includeSpaces: boolean | null = null
let statedMax: number | null = null

/*
  THE FIXTURE, BUILT IN CLOSED FORM SO THE THREE NUMBERS ARE REPRODUCIBLE.

  4,288 words joined by single spaces carry exactly 4,287 spaces, so a text of
  18,000 non-space characters stores as 22,287. No randomness, no snapshot
  file: the arithmetic below IS the fixture's specification.
*/
const BANK = ('My path to nurse anesthesia began on a night shift in a cardiothoracic '
  + 'intensive care unit I learned to titrate vasoactive drips against a blood pressure '
  + 'that would not hold The attending asked me what I expected the next hour to look '
  + 'like and I had an answer Anesthesia is the discipline that lives inside that hour '
  + 'and I want to practise it I have spent four years at the bedside of patients whose '
  + 'physiology left no margin A failed extubation taught me more about preparation than '
  + 'any lecture ever did I read the chart before the handoff and I ask the question '
  + 'nobody has asked yet My charge nurse trusted me with the sickest assignment because '
  + 'I escalate early Graduate study is the next step and this programme is the one I '
  + 'have chosen').split(' ')

/** Prose of exactly `words` words and exactly `nonSpace` non-space characters. */
function proseOf(words: number, nonSpace: number): string {
  const chosen: string[] = []
  for (let i = 0; i < words; i += 1) chosen.push(BANK[i % BANK.length]!)
  let letters = chosen.reduce((n, w) => n + w.length, 0)
  for (let i = chosen.length - 1; i >= 0 && letters > nonSpace; i -= 1) {
    const w = chosen[i]!
    const cut = Math.min(w.length - 1, letters - nonSpace)
    chosen[i] = w.slice(0, w.length - cut)
    letters -= cut
  }
  for (let i = chosen.length - 1; i >= 0 && letters < nonSpace; i -= 1) {
    const add = Math.min(24, nonSpace - letters)
    chosen[i] = chosen[i]! + 'a'.repeat(add)
    letters += add
  }
  return chosen.join(' ')
}

/** Prose of exactly `stored` characters including spaces. */
function storedOf(stored: number): string {
  const out: string[] = []
  for (let k = 0; out.join(' ').length < stored + 40; k += 1) out.push(BANK[k % BANK.length]!)
  return out.join(' ').slice(0, stored)
}

const UTK = proseOf(4_288, 18_000)
const AT_CEILING = storedOf(30_000)
const OVER_CEILING = storedOf(30_001)

before(async () => {
  if (skip) return
  mock.module('@/lib/apiAuth', {
    namedExports: {
      authenticateRequest: async () => USER,
      readAccessToken: async () => 'fixture-token',
      isAdminEmail: () => true,
      ADMIN_EMAILS: [USER.email],
    },
  })
  const payload = JSON.parse(readFileSync(PAYLOAD, 'utf8'))
  // THE REAL SCHOOL, FOUND BY ITS REQUIREMENT AND NOT BY ITS NAME: the one
  // document in the catalog whose limit is counted without spaces.
  const doc = payload.documents.find((d: Record<string, unknown>) =>
    d.characters_include_spaces === false && d.max_characters != null)
  assert.ok(doc, 'the catalog no longer holds a without-spaces character limit')
  requirementId = String(doc.id)
  includeSpaces = doc.characters_include_spaces as boolean | null
  statedMax = Number(doc.max_characters)
  POST = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  GET_LIST = (await import('../../../app/api/statement/drafts/route.ts')).GET as Handler
  const item = await import('../../../app/api/statement/drafts/[id]/route.ts')
  GET_ITEM = item.GET as Handler
  PATCH_ITEM = item.PATCH as Handler
})

const request = (body?: unknown) => ({
  json: async () => body,
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
})
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const rows = () => JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, unknown>[]

// ------------------------------------------------- the fixture is the fixture

test('QA-004 the fixture is 18,000 school-counted and 22,287 stored', { skip }, async () => {
  const { characterCount } = await import('../requirements/constraints.ts')
  assert.equal(UTK.trim().split(/\s+/).length, 4_288)
  assert.equal(characterCount(UTK, false), 18_000, 'school-counted')
  assert.equal(UTK.length, 22_287, 'stored')
  // AND IT IS INSIDE THE SCHOOL'S REQUIREMENT, read from the catalog rather
  // than asserted as a number here.
  assert.equal(includeSpaces, false)
  assert.ok(statedMax !== null && characterCount(UTK, includeSpaces) <= statedMax,
    `${characterCount(UTK, includeSpaces)} exceeds the stated ${statedMax}`)
  // AND IT WAS OVER THE OLD CEILING, which is the whole defect.
  const { MAX_SAVED_CHARS, EXPANDED_SAVED_CHARS } = await import('../extract/limits.ts')
  assert.ok(UTK.length > MAX_SAVED_CHARS)
  assert.ok(UTK.length < EXPANDED_SAVED_CHARS)
})

// --------------------------------------------------------------- the journey

let draftId = ''

test('QA-004 the school’s own maximum SAVES through the real route', { skip }, async () => {
  rmSync(STORE, { force: true })
  const created = await POST!(request({
    title: 'QA-004 ceiling rehearsal', essay: '', requirementId,
  }))
  const body = await created.json() as Record<string, unknown>
  assert.equal(created.status, 201, JSON.stringify(body))
  draftId = String((body.draft as Record<string, unknown>).id)

  const saved = await PATCH_ITEM!(request({
    title: 'QA-004 ceiling rehearsal', essay: UTK, expectedRevision: 1,
  }), ctx(draftId))
  const after = await saved.json() as Record<string, unknown>
  assert.equal(saved.status, 200, JSON.stringify(after).slice(0, 300))
  const draft = after.draft as Record<string, unknown>
  assert.equal(draft.revision, 2, 'the save did not land')
  assert.equal(String(draft.essay).length, 22_287)
})

test('QA-004 it survives the LIBRARY list', { skip }, async () => {
  const listed = await GET_LIST!(request())
  assert.equal(listed.status, 200)
  const body = await listed.json() as Record<string, unknown>
  const drafts = body.drafts as Record<string, unknown>[]
  const mine = drafts.find((d) => d.id === draftId)
  assert.ok(mine, 'the draft is missing from All Drafts')
})

test('QA-004 it survives a REOPEN, byte for byte', { skip }, async () => {
  const reopened = await GET_ITEM!(request(), ctx(draftId))
  assert.equal(reopened.status, 200)
  const body = await reopened.json() as Record<string, unknown>
  const draft = body.draft as Record<string, unknown>
  assert.equal(draft.essay, UTK, 'the reopened essay is not the one that was saved')
  assert.equal(draft.revision, 2, 'reopening moved the revision')
})

test('QA-004 and the STORED row holds all 22,287 characters', { skip }, () => {
  const stored = rows().find((r) => r.id === draftId)
  assert.ok(stored)
  assert.equal(String(stored!.essay).length, 22_287)
  assert.equal(stored!.revision, 2)
})

// ------------------------------------------------------------- the boundaries

test('QA-004 exactly 30,000 stored is accepted', { skip }, async () => {
  assert.equal(AT_CEILING.length, 30_000)
  const response = await PATCH_ITEM!(request({
    title: 'QA-004 ceiling rehearsal', essay: AT_CEILING, expectedRevision: 2,
  }), ctx(draftId))
  const body = await response.json() as Record<string, unknown>
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300))
  assert.equal(String((body.draft as Record<string, unknown>).essay).length, 30_000)
})

test('QA-004 30,001 stored is refused, clearly, and changes nothing', { skip }, async () => {
  assert.equal(OVER_CEILING.length, 30_001)
  const before = rows().find((r) => r.id === draftId)!
  const response = await PATCH_ITEM!(request({
    title: 'QA-004 ceiling rehearsal', essay: OVER_CEILING, expectedRevision: 3,
  }), ctx(draftId))
  const body = await response.json() as Record<string, unknown>
  // 422, NOT 400, and deliberately: http.ts draws the line at whether the
  // request is malformed. An essay the applicant really wrote and which is
  // simply too long is a well-formed request with unacceptable content.
  assert.equal(response.status, 422, JSON.stringify(body).slice(0, 300))
  assert.equal(body.code, 'essay-too-long')
  // AND THE MESSAGE TELLS THEM WHAT TO DO, naming no internal.
  assert.match(String(body.error), /longer than a saved statement may be/)
  assert.doesNotMatch(String(body.error), /20,?000|30,?000|constraint|CHECK|column/i)
  // THE COUNT IS RETURNED so the editor can say how much has to go, and the
  // text never is.
  assert.equal(body.characters, 30_001)
  assert.equal('essay' in body, false, 'a refusal must not echo the essay')
  // AND THE STORED ROW IS UNTOUCHED.
  const after = rows().find((r) => r.id === draftId)!
  assert.equal(String(after.essay).length, String(before.essay).length)
  assert.equal(after.revision, before.revision)
})

test('QA-004 the local store emulates the CHECK, not just the validator', { skip }, async () => {
  /*
   * THE REASON THE STORE HAD TO LEARN THE CONSTRAINT. The refusal above came
   * from checkEssay() in the route. If that were the only gate, this rehearsal
   * would say nothing about the CHECK migration 016 actually installs -- and a
   * path that reached the table another way would be unrehearsed.
   *
   * Asked directly, the store answers the way PostgREST would: 23514,
   * check_violation, naming the constraint.
   */
  const { localDraftsBuilder } = await import('./localDrafts.ts')
  const result = await localDraftsBuilder()
    .update({ essay: OVER_CEILING })
    .eq('id', draftId)
    .select('*').maybeSingle()
  assert.equal(result.data, null)
  assert.equal(result.error?.code, '23514')
  assert.match(String(result.error?.message), /statement_drafts_essay_length/)
  // AND THE ROW IS STILL THE ACCEPTED ONE.
  assert.equal(String(rows().find((r) => r.id === draftId)!.essay).length, 30_000)
})

test('QA-004 none of this moved what the REAL table enforces', { skip }, async () => {
  const { maxSavedChars, MAX_SAVED_CHARS, EXPANDED_SAVED_CHARS } =
    await import('../extract/limits.ts')
  // Simulated live, which is what this file runs in: the post-016 figure.
  assert.equal(maxSavedChars({ NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    EXPANDED_SAVED_CHARS)
  // The same machine, pointed at the REAL database: the ceiling it still has.
  assert.equal(maxSavedChars({
    NODE_ENV: 'development', STATEMENT_SIMULATED_LIVE: 'off',
  } as NodeJS.ProcessEnv), MAX_SAVED_CHARS)
  // Production, until whoever applies 016 turns the flag on.
  assert.equal(maxSavedChars({} as NodeJS.ProcessEnv), MAX_SAVED_CHARS)
  assert.equal(maxSavedChars({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    MAX_SAVED_CHARS)
})
