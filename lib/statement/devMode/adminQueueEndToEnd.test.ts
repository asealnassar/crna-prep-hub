/**
 * The admin review queue, through the real endpoint, in simulated-live mode.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY EVERY OTHER TEST PASSED
 * ---------------------------------------------------------------------------
 * The queue failed with "Those submissions could not be loaded" while the
 * applicant path worked perfectly, and nothing caught it, because the two
 * faults were both OUTSIDE the parts under test:
 *
 *   1. requireAdmin() demanded SUPABASE_SERVICE_ROLE_KEY. No test had ever
 *      called the admin ROUTE -- submissionEndToEnd.test.ts calls
 *      statementAdminClient() and listSubmissionsForReview() directly, which
 *      skips the guard entirely. So the repository and the client were both
 *      proven to work while the thing in front of them returned 500.
 *
 *   2. listSchoolPickerOptions() reads public.schools, and the local admin
 *      client threw on every table it did not serve. A THROW, not an error
 *      result -- so the route's existing "show the id instead" fallback never
 *      ran, and one missing school NAME took the whole queue down.
 *
 * The lesson is in the shape of this file: it calls the route, with the
 * environment a developer's machine actually has -- no service key -- and
 * asserts the response body, not the repository's return value.
 */
import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.admin-test.json'
process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE = 'dev-submissions.admin-test.json'
process.env.STATEMENT_LOCAL_CANONICAL_FILE = 'dev-canonical.admin-test.json'
/*
 * THE KEY IS DELETED, DELIBERATELY, AND THIS IS THE REGRESSION.
 *
 * A developer's machine has no production service-role key and has no reason to
 * hold one. The queue has to work without it, because the local admin client
 * never reads it -- and demanding one is exactly what broke.
 */
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const DRAFTS = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const SUBMISSIONS = `local-review/${process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE}`
const CANONICAL = `local-review/${process.env.STATEMENT_LOCAL_CANONICAL_FILE}`

const ADMIN = { userId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' }
const APPLICANT = { userId: '22222222-2222-4222-8222-222222222222', email: 'them@example.invalid' }
let current = ADMIN
/** Whether the current session is on the admin allowlist. */
let adminAllowed = true

type Handler = (request: unknown, context?: unknown) => Promise<Response>
type Row = Record<string, unknown>

let CREATE: Handler | null = null
let ADMIN_GET: Handler | null = null
let ADMIN_PATCH: Handler | null = null
let OWN_GET: Handler | null = null
/** A school the local catalog HAS requirements for, and one it does not. */
let schoolWithCatalog = ''
const schoolWithoutCatalog = '99999999-9999-4999-8999-999999999999'

const PROMPT = 'Describe, in no more than 750 words, the clinical experience that '
  + 'prepared you for the responsibilities of a nurse anesthetist.'

const skip = !existsSync('local-review/statement_requirements_catalog.json')
  || typeof mock.module !== 'function'

/**
 * public.schools, for this test process only.
 *
 * ON A REAL MACHINE THE ANON CLIENT READS IT, which is what the fix restored --
 * the directory is ordinary reference data and anon holds SELECT on it. There
 * is no Supabase in a test process, so the one read the queue makes is answered
 * here; `null` for an unknown table is how the "could not be read" branch is
 * reached on purpose.
 */
function directoryFixture(table: string): unknown {
  if (table !== 'schools') return null
  const rows = [
    { id: schoolWithCatalog, name: 'Fixture University', location_state: 'TX' },
    { id: schoolWithoutCatalog, name: 'Prompt-less College', location_state: 'OH' },
  ]
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'like', 'gte', 'is', 'range']) {
    builder[method] = () => builder
  }
  builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
  builder.single = async () => ({ data: rows[0] ?? null, error: null })
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve)
  return builder
}

before(async () => {
  if (skip) return
  const payload = JSON.parse(
    readFileSync('local-review/statement_requirements_catalog.json', 'utf8')) as { sets: Row[] }
  schoolWithCatalog = String(payload.sets[0]!.school_id)

  mock.module('@supabase/supabase-js', {
    namedExports: {
      createClient: () => ({
        from: (table: string) => {
          const served = directoryFixture(table)
          if (served !== null) return served
          // Anything else behaves as PostgREST would for a table this role
          // cannot read: an error result, never a throw.
          const builder: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in', 'order', 'limit', 'like', 'gte', 'is', 'range']) {
            builder[m] = () => builder
          }
          const fail = { data: null, error: { code: '42501', message: 'permission denied' } }
          builder.maybeSingle = async () => fail
          builder.single = async () => fail
          builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(fail).then(resolve)
          return builder
        },
        rpc: () => { throw new Error('the real client must never be asked for an rpc here') },
      }),
    },
  })
  mock.module('@/lib/apiAuth', {
    namedExports: {
      authenticateRequest: async () => ({ ...current, tier: 'ultimate', isUltimate: true }),
      readAccessToken: async () => 'fixture-token',
      isAdminEmail: (email?: string) => adminAllowed && email === ADMIN.email,
      ADMIN_EMAILS: [ADMIN.email],
    },
  })

  CREATE = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  const admin = await import('../../../app/api/admin/statement-prompts/route.ts')
  ADMIN_GET = admin.GET as Handler
  ADMIN_PATCH = admin.PATCH as Handler
  OWN_GET = (await import(
    '../../../app/api/statement/prompt-submissions/route.ts')).GET as Handler
})

after(() => {
  if (skip) return
  for (const file of [DRAFTS, SUBMISSIONS, CANONICAL]) rmSync(file, { force: true })
})

const request = (qs = '') => ({
  nextUrl: { searchParams: new URLSearchParams(qs) },
  headers: new Headers(),
  json: async () => ({}),
})
const post = (body: unknown) => ({
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
  json: async () => body,
})
const submissions = () => (existsSync(SUBMISSIONS)
  ? JSON.parse(readFileSync(SUBMISSIONS, 'utf8')) as Row[] : [])

/** One submission, through the REAL applicant path. */
async function submit(schoolId: string, overrides: Row = {}): Promise<string> {
  const previous = current
  current = APPLICANT
  try {
    const response = await CREATE!(post({
      title: 'My statement',
      essay: '',
      promptSubmission: {
        schoolId,
        promptText: PROMPT,
        statedMaxWords: 750,
        applicationCycle: '2026-2027',
        sourceUrl: 'https://example.invalid/apply',
        confirmed: true,
        documentLabel: 'Personal Statement',
        documentTypeHint: 'Letter of intent',
        statedMinWords: 500,
        statedMaxCharacters: 4000,
        statedMaxPages: 1.5,
        statedPagesText: '2 pages, double-spaced',
        formattingInstructions: 'Times New Roman 12pt, double-spaced',
        otherInstructions: 'Upload as PDF',
        submitterNote: 'Copied from the programme page.',
        ...overrides,
      },
    }))
    const body = await response.json() as Row
    assert.equal(response.status, 201, `submit failed: ${JSON.stringify(body)}`)
    return String(body.submissionId)
  } finally {
    current = previous
  }
}

async function queue(qs = ''): Promise<{ status: number; body: Row }> {
  const response = await ADMIN_GET!(request(qs))
  return { status: response.status, body: await response.json() as Row }
}

// =========================================================================
// THE FAILURE, REPRODUCED AS A PASSING ASSERTION
// =========================================================================

test('THE QUEUE LOADS WITH NO SERVICE-ROLE KEY IN THE ENVIRONMENT',
  { skip }, async () => {
    // Fault 1. This returned 500 "Server configuration error", which the page
    // reported as "Those submissions could not be loaded".
    assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, undefined,
      'the test is not reproducing the condition it was written for')
    const { status, body } = await queue()
    assert.equal(status, 200, `the queue failed: ${JSON.stringify(body)}`)
    assert.ok(Array.isArray(body.submissions))
  })

test('AND THE SCHOOL DIRECTORY READ DOES NOT THROW', { skip }, async () => {
  // Fault 2. The local admin client refused every table it did not serve, so
  // reading public.schools raised SimulatedLiveWriteBlocked -- past the route's
  // own "show the id instead" fallback, and out as a 500.
  const { status, body } = await queue()
  assert.equal(status, 200)
  assert.equal(body.schoolsUnavailable, false, 'the directory could not be read')
  assert.ok((body.schools as Row[]).length >= 1)
})

test('an EMPTY queue is a queue, not an error', { skip }, async () => {
  rmSync(SUBMISSIONS, { force: true })
  const { status, body } = await queue()
  assert.equal(status, 200)
  assert.deepEqual(body.submissions, [])
  assert.deepEqual(body.pendingPerSchool, {})
  assert.deepEqual(body.duplicateGroups, {})
})

// =========================================================================
// THE SUBMISSION ARRIVES, WHOLE
// =========================================================================

test('the applicant\'s submission reaches the queue with its RICH fields',
  { skip }, async () => {
    rmSync(SUBMISSIONS, { force: true })
    rmSync(DRAFTS, { force: true })
    const id = await submit(schoolWithCatalog)

    const { status, body } = await queue()
    assert.equal(status, 200)
    const rows = body.submissions as Row[]
    assert.equal(rows.length, 1)
    const row = rows[0]!
    assert.equal(row.id, id)

    // THE LOCAL STORE IS WHAT ANSWERED. The id the applicant path wrote to
    // dev-submissions.json is the id the queue returned.
    assert.equal(row.id, String(submissions()[0]!.id))

    // Every 20261006_008 field, through the route's own serializer.
    assert.equal(row.documentLabel, 'Personal Statement')
    assert.equal(row.documentTypeHint, 'Letter of intent')
    assert.equal(row.statedMinWords, 500)
    assert.equal(row.statedMaxWords, 750)
    assert.equal(row.statedMaxCharacters, 4000)
    // numeric(4,1): a page and a half survives the round trip.
    assert.equal(row.statedMaxPages, 1.5)
    assert.equal(row.statedPagesText, '2 pages, double-spaced')
    assert.equal(row.formattingInstructions, 'Times New Roman 12pt, double-spaced')
    assert.equal(row.otherInstructions, 'Upload as PDF')
    assert.equal(row.submitterNote, 'Copied from the programme page.')
    assert.equal(row.applicationCycle, '2026-2027')
    assert.equal(row.status, 'pending')
    assert.equal(row.approvedRequirementId, null)
  })

test('the school RESOLVES to a name the reviewer can recognise', { skip }, async () => {
  const { body } = await queue()
  const row = (body.submissions as Row[])[0]!
  const school = (body.schools as Row[]).find((s) => s.id === row.schoolId)
  assert.ok(school, 'the submission\'s school is not in the directory')
  assert.equal(school!.name, 'Fixture University')
})

test('the reviewer sees the ADMIN-ONLY columns', { skip }, async () => {
  const row = (await queue()).body.submissions as Row[]
  assert.ok('reviewNote' in row[0]!, 'the review note is withheld from the reviewer')
  assert.ok('textFingerprint' in row[0]!)
})

// =========================================================================
// CONTEXT
// =========================================================================

test('a school WITH canonical requirements reports them', { skip }, async () => {
  const { body } = await queue()
  const context = (body.catalog as Record<string, Row>)[schoolWithCatalog]
  assert.ok(context, 'no catalog context for this school')
  assert.equal(context.available, true, `catalog read failed: ${JSON.stringify(context)}`)
  const sets = context.sets as Row[]
  assert.ok(sets.length >= 1, 'the local catalog returned no sets for a school that has them')
  const documents = sets.reduce((n, set) => n + (set.requirements as Row[]).length, 0)
  assert.ok(documents >= 1)
  // Named, so "already has N" is checkable rather than a number to trust.
  assert.equal(typeof (sets[0]!.requirements as Row[])[0]!.label, 'string')
})

test('a school with NO canonical requirement reports an empty catalog',
  { skip }, async () => {
    rmSync(SUBMISSIONS, { force: true })
    rmSync(DRAFTS, { force: true })
    await submit(schoolWithoutCatalog)
    const { body } = await queue()
    const context = (body.catalog as Record<string, Row>)[schoolWithoutCatalog]
    assert.ok(context)
    assert.equal(context.available, true)
    assert.deepEqual(context.sets, [], 'a school with no requirements reported some')
  })

test('pending counts and IDENTICAL-WORDING groups are reported', { skip }, async () => {
  rmSync(SUBMISSIONS, { force: true })
  rmSync(DRAFTS, { force: true })
  // Two submissions of the SAME wording, and one different.
  await submit(schoolWithCatalog)
  await submit(schoolWithCatalog)
  await submit(schoolWithCatalog, { promptText: `${PROMPT} And a second question.` })

  const { body } = await queue()
  assert.equal((body.submissions as Row[]).length, 3)
  assert.equal((body.pendingPerSchool as Row)[schoolWithCatalog], 3)

  const groups = body.duplicateGroups as Record<string, string[]>
  const entries = Object.entries(groups)
  // ONLY THE GROUP WITH MORE THAN ONE MEMBER. A group of one is a submission.
  assert.equal(entries.length, 1, `unexpected groups: ${JSON.stringify(groups)}`)
  assert.equal(entries[0]![1].length, 2)
  // AND NOTHING WAS MERGED. Three rows in, three rows out.
  assert.equal(submissions().length, 3)
})

// =========================================================================
// THE FILTERS
// =========================================================================

test('the pending, approved and rejected filters each return their own rows',
  { skip }, async () => {
    rmSync(SUBMISSIONS, { force: true })
    rmSync(DRAFTS, { force: true })
    const first = await submit(schoolWithCatalog)
    const second = await submit(schoolWithCatalog, { promptText: `${PROMPT} Two.` })
    const third = await submit(schoolWithCatalog, { promptText: `${PROMPT} Three.` })

    const approval = await ADMIN_PATCH!(post({
      id: second, decision: 'approved', label: 'Essay 1',
    }))
    assert.equal(approval.status, 200, JSON.stringify(await approval.json()))
    assert.equal((await ADMIN_PATCH!(post({ id: third, decision: 'rejected' }))).status, 200)

    const pending = await queue('status=pending')
    assert.deepEqual((pending.body.submissions as Row[]).map((r) => r.id), [first])

    const approved = await queue('status=approved')
    assert.deepEqual((approved.body.submissions as Row[]).map((r) => r.id), [second])

    const rejected = await queue('status=rejected')
    assert.deepEqual((rejected.body.submissions as Row[]).map((r) => r.id), [third])

    const all = await queue()
    assert.equal((all.body.submissions as Row[]).length, 3)

    // An unknown status is ignored rather than returning nothing.
    const bogus = await queue('status=sideways')
    assert.equal((bogus.body.submissions as Row[]).length, 3)
  })

// =========================================================================
// WHO MAY READ IT
// =========================================================================

test('a NON-ADMIN cannot reach the queue at all', { skip }, async () => {
  current = APPLICANT
  try {
    const response = await ADMIN_GET!(request())
    assert.equal(response.status, 403, 'an applicant read the review queue')
  } finally {
    current = ADMIN
  }
})

test('and the private columns never reach an applicant\'s own endpoint',
  { skip }, async () => {
    current = APPLICANT
    try {
      const body = await (await OWN_GET!(request())).json() as Row
      const rows = body.submissions as Row[]
      assert.ok(rows.length >= 1, 'the applicant cannot see their own submissions')
      for (const row of rows) {
        assert.equal('reviewNote' in row, false, 'a review note reached the applicant')
        assert.equal('reviewedBy' in row, false, 'a reviewer identity reached the applicant')
      }
      // And the rich fields ARE theirs to read back.
      assert.equal(rows[0]!.documentLabel, 'Personal Statement')
    } finally {
      current = ADMIN
    }
  })

// =========================================================================
// WHAT IT DID NOT DO
// =========================================================================

test('ZERO PRODUCTION WRITES, and no service key was ever needed', { skip }, async () => {
  assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, undefined)

  const { statementAdminClient } = await import('./guardedClient.ts')
  const { SimulatedLiveWriteBlocked } = await import('./gate.ts')
  const admin = statementAdminClient('', { userId: ADMIN.userId, isAdmin: true })

  // READS PASS, WRITES DO NOT -- including on the table that now passes through
  // to a real anon client. guardBuilder wraps it, so the directory is readable
  // and unwritable.
  for (const table of ['schools', 'statement_prompt_submissions',
    'statement_requirement_sets', 'statement_requirements', 'user_profiles']) {
    for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
      assert.throws(
        () => (admin.from(table) as unknown as Record<string, () => unknown>)[operation]!(),
        SimulatedLiveWriteBlocked, `${table}.${operation}`)
    }
  }
  // And only the reviewed submission functions are callable.
  for (const fn of ['record_ai_usage', 'claim_statement_analysis']) {
    assert.throws(() => admin.rpc(fn), SimulatedLiveWriteBlocked, fn)
  }

  // The production payload is untouched by the whole suite.
  const payload = JSON.parse(
    readFileSync('local-review/statement_requirements_catalog.json', 'utf8')) as {
      sets: Row[]; documents: Row[]
    }
  assert.equal(payload.sets.length, 63)
  assert.equal(payload.documents.length, 80)
  assert.equal(payload.sets.filter((s) => s.is_active === true).length, 0)
})

test('the admin route demands the key OUTSIDE development', { skip }, () => {
  // The production behaviour the fix had to leave alone: no key, no privileged
  // client, no queue.
  const source = readFileSync('app/api/admin/statement-prompts/route.ts', 'utf8')
  assert.match(source, /if \(!serviceKey && !simulatedLiveEnabled\(\)\) \{/)
  assert.match(source, /Server configuration error/)
})
