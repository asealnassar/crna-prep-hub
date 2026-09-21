import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { countInterviewsByUser } from './interviewCounts.ts'

/**
 * The admin analytics bug: a user's "interview_count" was the number of their
 * user_asked_questions rows (app/admin/analytics/page.tsx). The interview page
 * logs one of those per PRIMARY question, so a ten-question interview counted
 * as ten interviews -- and Quick Mock would have counted as five. An interview
 * is one interview_sessions row, however many questions it asked.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const PAGE = read('../../app/admin/analytics/page.tsx')
const API = read('../../app/api/admin/analytics/route.ts')

/** What one finished interview leaves behind in the two tables. */
function interview(userId: string, primaryQuestions: number) {
  return {
    session: { user_id: userId },
    questions: Array.from({ length: primaryQuestions }, (_, i) => ({ user_id: userId, question: `q${i + 1}` })),
  }
}

test('a 5-question Quick interview counts as one interview', () => {
  const quick = interview('quick-user', 5)
  assert.equal(quick.questions.length, 5, 'it logged five question rows')
  assert.deepEqual(countInterviewsByUser([quick.session]), { 'quick-user': 1 })
})

test('a 10-question Full interview also counts as one interview', () => {
  const full = interview('full-user', 10)
  assert.equal(full.questions.length, 10, 'it logged ten question rows')
  assert.deepEqual(countInterviewsByUser([full.session]), { 'full-user': 1 })
})

test('the old metric is exactly the bug: it counted question rows', () => {
  const quick = interview('u', 5)
  const full = interview('u', 10)
  const questionRows = [...quick.questions, ...full.questions]
  // What the page used to compute: userQuestions.length.
  assert.equal(questionRows.filter((q) => q.user_id === 'u').length, 15, 'two interviews read as fifteen')
  assert.deepEqual(countInterviewsByUser([quick.session, full.session]), { u: 2 }, 'and are two')
})

test('users are counted separately, and a row without a user counts for no one', () => {
  const rows = [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'a' }, { user_id: null }, {}]
  assert.deepEqual(countInterviewsByUser(rows), { a: 2, b: 1 })
  assert.deepEqual(countInterviewsByUser([]), {})
})

test('the admin page reads interviews from the server count, never from question rows', () => {
  assert.doesNotMatch(PAGE, /interview_count:\s*userQuestions\.length/)
  assert.match(PAGE, /interview_count: interviewsByUser\[authUser\.id\] \?\? 0/)
  assert.match(PAGE, /<th className="px-6 py-4 text-left text-sm font-semibold">Interviews<\/th>/)
  // The question count is still shown, under its own, accurate name.
  assert.match(PAGE, />Questions Asked<\/th>/)
})

test('the API counts one interview per session row, ordered, after the admin check', () => {
  assert.match(API, /\.from\('interview_sessions'\)\s*\.select\('user_id'\)\s*\.order\('id'\)/)
  assert.match(API, /interviewsByUser: countInterviewsByUser\(sessionRows\)/)
  // interview_sessions is under RLS (own rows only), which is exactly why this
  // count needs the service role -- so the service role must come last:
  // a verified session, then the admin allowlist, then the privileged client.
  const get = API.slice(API.indexOf('export async function GET'))
  const verified = get.indexOf('await authenticateRequest()')
  const allowlisted = get.indexOf('isAdminEmail(auth.email)')
  const privileged = get.indexOf('serviceClient()')
  assert.ok(verified > -1 && verified < allowlisted && allowlisted < privileged, 'authenticate, authorize, then elevate')
  assert.ok(privileged < get.indexOf("from('interview_sessions')"))
})

test('the API reads no session content and returns none', () => {
  // Code only: the file's comments describe what the old browser code did.
  const code = API.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  // The only interview_sessions read selects user_id alone...
  assert.equal(code.match(/from\('interview_sessions'\)/g)?.length, 1)
  assert.doesNotMatch(code, /conversation|engine_state|pending_turn|interview_type|select\('\*'\)/)
  // ...and the response is counts: four integers, a user-id -> count map, paging diagnostics.
  const body = code.match(/return NextResponse\.json\(\{\s*totalUsers[\s\S]*?\n\s*\}\)/)?.[0] ?? ''
  const keys = [...body.matchAll(/^\s+(\w+)[:,]/gm)].map((m) => m[1])
  assert.deepEqual(keys, ['totalUsers', 'usedInterview', 'ultimateMembers', 'questionsAsked', 'interviewsByUser', 'meta'])
})
