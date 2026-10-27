/**
 * An applicant submitting their school's own prompt, and an administrator
 * reviewing it -- through the routes the UI calls, in simulated-live mode.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The submission subsystem was built, migrated and unit-tested, and then became
 * unreachable on localhost: V2 gave requirementsEnabled() a development branch
 * so the catalog could be reviewed, promptSubmissionsEnabled() never got one,
 * and the three writes are rpc() calls that the simulated-live guard refuses.
 * Two different reasons, both invisible from the screen -- the applicant simply
 * saw a dead end.
 *
 * So this exercises the whole path with nothing stubbed but authentication:
 * the real route, the real validators, the real repository, the guarded client,
 * and the local stand-ins for the three definer functions.
 */
import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.submission-test.json'
process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE = 'dev-submissions.submission-test.json'
process.env.STATEMENT_LOCAL_CANONICAL_FILE = 'dev-canonical.submission-test.json'
const DRAFTS = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const SUBMISSIONS = `local-review/${process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE}`
const CANONICAL = `local-review/${process.env.STATEMENT_LOCAL_CANONICAL_FILE}`

const USER = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.invalid',
  tier: 'ultimate',
}
/** A second applicant, for the "cannot see or touch yours" assertions. */
const OTHER = {
  userId: '22222222-2222-4222-8222-222222222222',
  email: 'other@example.invalid',
  tier: 'ultimate',
}
let current = USER
let admin = true

type Handler = (request: unknown, context?: unknown) => Promise<Response>
type Row = Record<string, unknown>

let CREATE: Handler | null = null
let SUBMISSIONS_GET: Handler | null = null
let SUBMISSIONS_PATCH: Handler | null = null
let schoolId = ''

const skip = typeof mock.module !== 'function'

/** A realistic school question, pasted by an applicant. */
const PROMPT = 'In 750 words or fewer, describe the clinical experience that '
  + 'prepared you for the responsibilities of a nurse anesthetist, and explain '
  + 'how our programme fits the practice you intend to build.'

/**
 * The school directory, served for this test process only.
 *
 * NOT MOVED INTO devMode. On localhost the guarded client reads
 * public.schools from production -- read-only, and correctly so: the whole
 * point of this feature is the schools we have NO prompt for, and only the real
 * directory lists them. A local fixture would narrow the picker to the 63
 * schools that already have requirements, which is the opposite of the case
 * being reviewed. There is simply no Supabase in a test process, so the one
 * read this path makes is answered here.
 */
function schoolsFixture(table: string): unknown {
  const rows = table === 'schools' ? [{ id: schoolId, name: 'Fixture School' }] : []
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'like', 'gte']) {
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
  // A school the directory lists. Read first: the fixture closes over it.
  const payload = JSON.parse(
    readFileSync('local-review/statement_requirements_catalog.json', 'utf8')) as { sets: Row[] }
  schoolId = String(payload.sets[0]!.school_id)

  mock.module('@supabase/supabase-js', {
    namedExports: {
      createClient: () => ({
        from: (table: string) => schoolsFixture(table),
        rpc: () => { throw new Error('the real client should never be asked for an rpc here') },
      }),
    },
  })
  mock.module('@/lib/apiAuth', {
    namedExports: {
      authenticateRequest: async () => ({ ...current, isUltimate: true }),
      readAccessToken: async () => 'fixture-token',
      isAdminEmail: (email?: string) => admin && email === USER.email,
      ADMIN_EMAILS: [USER.email],
    },
  })
  CREATE = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  const own = await import('../../../app/api/statement/prompt-submissions/route.ts')
  SUBMISSIONS_GET = own.GET as Handler
  SUBMISSIONS_PATCH = own.PATCH as Handler
})

after(() => {
  if (skip) return
  rmSync(DRAFTS, { force: true })
  rmSync(SUBMISSIONS, { force: true })
  rmSync(CANONICAL, { force: true })
})

const request = (body?: unknown) => ({
  json: async () => body,
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
})
const submissions = () => (existsSync(SUBMISSIONS)
  ? JSON.parse(readFileSync(SUBMISSIONS, 'utf8')) as Row[]
  : [])
const drafts = () => (existsSync(DRAFTS)
  ? JSON.parse(readFileSync(DRAFTS, 'utf8')) as Row[]
  : [])

function body(overrides: Row = {}): Row {
  return {
    title: 'My statement for this school',
    essay: '',
    promptSubmission: {
      schoolId,
      promptText: PROMPT,
      statedMaxWords: 750,
      applicationCycle: '2026-2027',
      sourceUrl: 'https://example.invalid/apply',
      confirmed: true,
      ...overrides,
    },
  }
}

// ------------------------------------------------ the reconnection itself

test('THE FEATURE READS AS ON IN DEVELOPMENT, and off everywhere else',
  { skip }, async () => {
    const { promptSubmissionsEnabled } = await import('../draft/rollout.ts')
    // This is the line the feature was lost on.
    assert.equal(promptSubmissionsEnabled(), true, 'simulated-live still refuses submissions')
    assert.equal(
      promptSubmissionsEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), false)
    assert.equal(
      promptSubmissionsEnabled(
        { NODE_ENV: 'production', STATEMENT_PROMPT_SUBMISSIONS: 'on' } as NodeJS.ProcessEnv),
      true, 'the real flag must still release it')
  })

// --------------------------------------------------------- the applicant

let draftId = ''
let submissionId = ''

test('an applicant submits their school prompt AND gets a usable draft',
  { skip }, async () => {
    rmSync(DRAFTS, { force: true })
    rmSync(SUBMISSIONS, { force: true })
    const response = await CREATE!(request(body()))
    const payload = await response.json() as Row
    assert.equal(response.status, 201, `create failed: ${JSON.stringify(payload)}`)
    draftId = String((payload.draft as Row).id)
    submissionId = String(payload.submissionId)
    assert.match(submissionId, /^[0-9a-f-]{36}$/)

    // ONE TRANSACTION, BOTH ROWS. The whole reason the create is a function.
    assert.equal(drafts().length, 1)
    assert.equal(submissions().length, 1)
    assert.equal(drafts()[0]!.prompt_submission_id, submissionId,
      'the draft does not point at the submission')
  })

test('the submission is stamped, not taken from the request', { skip }, async () => {
  const row = submissions()[0]!
  // The two columns that are the whole trust boundary.
  assert.equal(row.submitted_by, USER.userId)
  assert.equal(row.status, 'pending')
  // Review columns stay empty until somebody reviews it.
  for (const column of ['reviewed_by', 'reviewed_at', 'review_note',
    'approved_prompt_id', 'approved_requirement_id', 'duplicate_of_id']) {
    assert.equal(row[column], null, column)
  }
  assert.equal(row.prompt_text, PROMPT)
  assert.equal(row.stated_max_words, 750)
  assert.equal(typeof row.text_fingerprint, 'string')
})

test('a submitter cannot name themselves, their status or their reviewer',
  { skip }, async () => {
    rmSync(DRAFTS, { force: true })
    rmSync(SUBMISSIONS, { force: true })
    // A hostile body: every privileged column, supplied by the browser.
    const response = await CREATE!(request(body({
      submittedBy: OTHER.userId,
      submitted_by: OTHER.userId,
      status: 'approved',
      reviewedBy: USER.userId,
      reviewed_by: USER.userId,
      approvedPromptId: '33333333-3333-4333-8333-333333333333',
    })))
    assert.equal(response.status, 201)
    const row = submissions()[0]!
    assert.equal(row.submitted_by, USER.userId, 'a submission was attributed to someone else')
    assert.equal(row.status, 'pending', 'a browser set its own review status')
    assert.equal(row.reviewed_by, null)
    assert.equal(row.approved_prompt_id, null)
  })

test('the draft carries the pasted wording and no catalog claim', { skip }, async () => {
  const row = drafts()[0]!
  assert.equal(row.prompt_text, PROMPT)
  // NEITHER a catalog prompt NOR a catalog requirement: a pasted question must
  // never travel the path that means "we vouch for this".
  assert.equal(row.prompt_id, null)
  assert.equal(row.requirement_id, null)
  assert.equal(row.requirement_snapshot, null)
})

test('the editor is told the prompt is the applicant\'s, and awaiting review',
  { skip }, async () => {
    const { statementDbClient } = await import('./guardedClient.ts')
    const { readDraftPromptStatus } = await import('../draft/submissionRepo.ts')
    const { promptStatusLabel } = await import('../draft/promptSubmission.ts')
    const db = statementDbClient('fixture-token', { userId: USER.userId, isAdmin: false })
    const status = await readDraftPromptStatus(db, String(drafts()[0]!.id))
    assert.equal(status.ok, true)
    assert.equal(status.ok && status.value?.status, 'pending')
    assert.equal(status.ok && status.value?.submissionId, String(submissions()[0]!.id))
    // AND IT IS NEVER PRESENTED AS VERIFIED. The label says the opposite, in
    // the applicant's own words, and says whose prompt it is.
    const label = String(promptStatusLabel({ origin: 'user', status: 'pending' }))
    assert.match(label, /user-provided/i, `the label hides whose prompt it is: ${label}`)
    assert.match(label, /not yet verified/i, `the label does not disclaim: ${label}`)
    // A catalog prompt is the one that may say nothing of the sort.
    assert.doesNotMatch(label, /^Verified/i)
  })

test('an applicant sees only their OWN submissions, and never a review note',
  { skip }, async () => {
  const mine = await (await SUBMISSIONS_GET!(request())).json() as Row
  assert.equal((mine.submissions as Row[]).length, 1)
  // THE COLUMN AN APPLICANT HOLDS NO GRANT ON. A note about a submission must
  // not be readable by the person who made it.
  for (const row of mine.submissions as Row[]) {
    assert.equal('reviewNote' in row, false, 'a review note reached the applicant')
    assert.equal('review_note' in row, false, 'a review note reached the applicant')
  }

  current = OTHER
  try {
    const theirs = await (await SUBMISSIONS_GET!(request())).json() as Row
    assert.equal((theirs.submissions as Row[]).length, 0,
      'one applicant can read another\'s submissions')
  } finally {
    current = USER
  }
})

test('an applicant cannot withdraw somebody else\'s submission', { skip }, async () => {
  const id = String(submissions()[0]!.id)
  current = OTHER
  try {
    const response = await SUBMISSIONS_PATCH!(request({ id, action: 'withdraw' }))
    assert.equal(response.status, 404, 'another applicant withdrew a submission')
  } finally {
    current = USER
  }
  assert.equal(submissions()[0]!.status, 'pending', 'the row changed anyway')
})

test('the rate limit the function applies is applied locally too', { skip }, async () => {
  rmSync(DRAFTS, { force: true })
  rmSync(SUBMISSIONS, { force: true })
  for (let n = 0; n < 3; n += 1) {
    const ok = await CREATE!(request(body({ promptText: `${PROMPT} Variation ${n}.` })))
    assert.equal(ok.status, 201, `submission ${n + 1} was refused`)
  }
  const fourth = await CREATE!(request(body({ promptText: `${PROMPT} One too many.` })))
  const refused = await fourth.json() as Row
  assert.equal(fourth.status, 429, 'the hourly limit did not apply')
  assert.equal(refused.code, 'rate-limited')
  assert.equal(submissions().length, 3, 'a refused submission was written anyway')
})

// ------------------------------------------------------------ the admin

test('THE ADMIN QUEUE NEVER GETS THE SERVICE KEY IN DEVELOPMENT', { skip }, async () => {
  const { statementAdminClient } = await import('./guardedClient.ts')
  const { SimulatedLiveWriteBlocked } = await import('./gate.ts')
  // A key is accepted and must never be used: the local branch reads no key and
  // builds no real client, so an admin reviewing local submissions cannot
  // reach production and Approve cannot write it.
  const admin = statementAdminClient('a-service-key-that-must-not-be-used', {
    userId: USER.userId, isAdmin: true,
  })
  // It is not a Supabase client at all on this branch.
  assert.throws(() => (admin as unknown as Record<string, unknown>).auth,
    SimulatedLiveWriteBlocked)
  /*
   * A TABLE THE LOCAL REVIEW DOES NOT SERVE IS READ-ONLY, NOT REFUSED.
   *
   * This asserted a throw, and the throw was the bug: public.schools is the
   * school directory, and refusing it took the whole review queue down with an
   * uncaught SimulatedLiveWriteBlocked. Reads now pass through to an ANON-key
   * client -- so RLS still decides, and nothing uses the service key -- while
   * every write still stops here.
   */
  const directory = admin.from('schools') as unknown as Record<string, () => unknown>
  assert.equal(typeof directory.select, 'function', 'the directory is unreadable')
  for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
    assert.throws(() => directory[operation]!(), SimulatedLiveWriteBlocked, `schools.${operation}`)
  }
  // And no function but the three submission paths is callable.
  assert.throws(() => admin.rpc('record_ai_usage'), SimulatedLiveWriteBlocked)
})

test('an administrator sees every submission, with its review note', { skip }, async () => {
  const { statementAdminClient } = await import('./guardedClient.ts')
  const { listSubmissionsForReview } = await import('../draft/submissionRepo.ts')
  const admin = statementAdminClient('unused', { userId: USER.userId, isAdmin: true })
  const listed = await listSubmissionsForReview(admin, {})
  assert.equal(listed.ok, true)
  assert.ok(listed.ok && listed.value.length >= 1, 'the queue is empty')
  // The column an applicant holds no grant on is readable here, which is the
  // asymmetry the grants create in production.
  assert.equal('reviewNote' in (listed.ok ? listed.value[0]! : {}), true)
})

test('an admin decision records the review and publishes NOTHING', { skip }, async () => {
  const { statementAdminClient } = await import('./guardedClient.ts')
  const { decideSubmission } = await import('../draft/submissionRepo.ts')
  const admin = statementAdminClient('unused', { userId: USER.userId, isAdmin: true })
  const id = String(submissions()[0]!.id)
  /*
   * THROUGH THE REPOSITORY, NOT A HAND-WRITTEN rpc CALL.
   *
   * This test used to pass its own parameter names straight to the stand-in,
   * which meant both sides of a mismatch agreed with each other and neither
   * agreed with decideSubmission() -- so a local Approve was refused as
   * 'invalid-status' while this passed. Calling the repository is what makes a
   * stand-in's signature worth asserting.
   */
  const decided = await decideSubmission(admin, {
    submissionId: id,
    decision: 'approved',
    reviewerId: USER.userId,
    label: 'Essay 1',
    reviewNote: 'Checked against the school site.',
  })
  assert.equal(decided.ok, true, JSON.stringify(decided))

  const row = submissions().find((r) => r.id === id)!
  assert.equal(row.status, 'approved')
  assert.equal(row.reviewed_by, USER.userId)
  assert.ok(typeof row.reviewed_at === 'string')
  // THE FIVE STATES STAY FIVE. "Reviewed" is not "canonical requirement
  // created", and approving must not have created one.
  assert.equal(row.approved_prompt_id, null, 'approval published a catalog prompt')
  assert.equal(row.approved_requirement_id, null, 'approval published a requirement')
})

test('a decided submission cannot be decided again', { skip }, async () => {
  const { statementAdminClient } = await import('./guardedClient.ts')
  const { decideSubmission } = await import('../draft/submissionRepo.ts')
  const admin = statementAdminClient('unused', { userId: USER.userId, isAdmin: true })
  const id = String(submissions()[0]!.id)
  const again = await decideSubmission(admin, {
    submissionId: id, decision: 'rejected', reviewerId: USER.userId,
  })
  assert.equal(again.ok, false)
  assert.equal(again.ok === false && again.reason, 'already-decided')
  assert.equal(submissions().find((r) => r.id === id)!.status, 'approved')
})

// =========================================================================
// PROMOTION -- submission becomes catalog data, and only an admin can do it
// =========================================================================

/** The administrator's own decisions. Nothing here is read from the submission. */
const REQUIREMENT = {
  label: 'Personal Statement',
  document_type: 'personal-statement',
  prompt_text: 'The wording an administrator edited and approved.',
  components: [{ id: 'c1', text: 'Why nurse anesthesia', optional: false }],
  min_words: 500,
  max_words: 750,
  // A page and a half: the value an integer column read as nothing before 007.
  max_pages: 1.5,
  words_enforcement: 'enforced',
  words_stated_as: 'Maximum of 750 words',
  other_instructions: ['Upload as PDF'],
  display_order: 0,
}
const SET = {
  application_cycle: '2026-2027',
  source_url: 'https://example.invalid/apply',
  verification_status: 'unverified',
  notes: ['Checked against the programme page.'],
}

/** A fresh pending submission, and its id. */
async function freshSubmission(): Promise<string> {
  rmSync(DRAFTS, { force: true })
  rmSync(SUBMISSIONS, { force: true })
  rmSync(CANONICAL, { force: true })
  const created = await CREATE!(request(body()))
  assert.equal(created.status, 201)
  return String(submissions()[0]!.id)
}

async function adminClient() {
  const { statementAdminClient } = await import('./guardedClient.ts')
  return statementAdminClient('unused', { userId: USER.userId, isAdmin: true })
}

test('AN ADMIN PROMOTION CREATES A SET AND A DOCUMENT, BOTH INACTIVE',
  { skip }, async () => {
    const id = await freshSubmission()
    const admin = await adminClient()
    const { data } = await admin.rpc('promote_statement_submission_to_requirement', {
      p_submission_id: id,
      p_mode: 'new-set',
      p_requirement: REQUIREMENT,
      p_set: SET,
    }) as unknown as { data: Row }
    assert.equal(data.ok, true, JSON.stringify(data))
    assert.equal(data.created, 'set')
    assert.equal(data.isActive, false)

    const { localCanonical } = await import('./localCanonical.ts')
    const stored = localCanonical()
    assert.equal(stored.sets.length, 1)
    assert.equal(stored.documents.length, 1)
    // THE ONE PROPERTY THAT MATTERS MOST. Both tables default is_active to
    // TRUE; the promotion path writes FALSE into both, explicitly.
    assert.equal(stored.sets[0]!.is_active, false, 'the set was created ACTIVE')
    assert.equal(stored.documents[0]!.is_active, false, 'the document was created ACTIVE')
  })

test('the canonical values are the ADMIN\'S, never the submission\'s', { skip }, async () => {
  const { localCanonical } = await import('./localCanonical.ts')
  const doc = localCanonical().documents[0]!
  assert.equal(doc.prompt_text, REQUIREMENT.prompt_text)
  assert.notEqual(doc.prompt_text, PROMPT, 'the applicant\u2019s wording was published')
  assert.equal(doc.label, 'Personal Statement')
  assert.equal(doc.document_type, 'personal-statement')
  // A page and a half survives, which is the whole point of numeric(4,1).
  assert.equal(doc.max_pages, 1.5)
  assert.equal(doc.words_enforcement, 'enforced')
  assert.deepEqual(doc.other_instructions, ['Upload as PDF'])
})

test('the submission now LINKS to the catalog row, and says approved', { skip }, async () => {
  const row = submissions()[0]!
  const { localCanonical } = await import('./localCanonical.ts')
  assert.equal(row.approved_requirement_id, localCanonical().documents[0]!.id)
  assert.equal(row.status, 'approved')
  assert.equal(row.reviewed_by, USER.userId)
  // AND THE V1 LINK IS UNTOUCHED. approved_prompt_id points at
  // statement_prompts; this promotion published nothing there.
  assert.equal(row.approved_prompt_id, null)
})

test('NOTHING BECAME APPLICANT-VISIBLE BY SAVING', { skip }, async () => {
  const { activeLocalCanonical } = await import('./localCanonical.ts')
  const visible = activeLocalCanonical()
  assert.equal(visible.sets.length, 0, 'a promoted set is already visible to applicants')
  assert.equal(visible.documents.length, 0)
})

test('ACTIVATION IS A SECOND, EXPLICIT ACT -- and it needs evidence',
  { skip }, async () => {
    const { localCanonical, simulateActivation, activeLocalCanonical } =
      await import('./localCanonical.ts')
    const setId = String(localCanonical().sets[0]!.id)

    // THE SAME CONDITION 20261002_005 PUTS ON is_active. The set was promoted
    // 'unverified', so activating it is refused rather than waved through --
    // otherwise the local preview would show what production would refuse.
    const refused = simulateActivation(setId)
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'needs-evidence')
    assert.equal(activeLocalCanonical().sets.length, 0)
  })

test('promotion REQUIRES ADMIN AUTHORIZATION', { skip }, async () => {
  const id = await freshSubmission()
  const { statementDbClient } = await import('./guardedClient.ts')
  // An applicant's own client, authenticated and not an administrator.
  const db = statementDbClient('fixture-token', { userId: USER.userId, isAdmin: false })
  const { data } = await db.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: id, p_mode: 'new-set', p_requirement: REQUIREMENT, p_set: SET,
  }) as unknown as { data: Row }
  assert.equal(data.ok, false)
  assert.equal(data.reason, 'not-authorized')
  const { localCanonical } = await import('./localCanonical.ts')
  assert.equal(localCanonical().sets.length, 0, 'an applicant created catalog data')
})

test('THE SET IS NEVER GUESSED: a missing or wrong mode is refused', { skip }, async () => {
  const id = await freshSubmission()
  const admin = await adminClient()
  for (const mode of [undefined, null, '', 'whatever', 'new_set']) {
    const { data } = await admin.rpc('promote_statement_submission_to_requirement', {
      p_submission_id: id, p_mode: mode, p_requirement: REQUIREMENT, p_set: SET,
    }) as unknown as { data: Row }
    assert.equal(data.ok, false, `mode ${String(mode)} was accepted`)
    assert.equal(data.reason, 'invalid-mode')
  }
  const { localCanonical } = await import('./localCanonical.ts')
  assert.equal(localCanonical().sets.length, 0)
})

test('existing-set mode needs a set, and the set must be THIS school\'s',
  { skip }, async () => {
    const id = await freshSubmission()
    const admin = await adminClient()

    const noSet = await admin.rpc('promote_statement_submission_to_requirement', {
      p_submission_id: id, p_mode: 'existing-set', p_requirement: REQUIREMENT,
    }) as unknown as { data: Row }
    assert.equal(noSet.data.ok, false)
    assert.equal(noSet.data.reason, 'set-required')

    const foreign = await admin.rpc('promote_statement_submission_to_requirement', {
      p_submission_id: id, p_mode: 'existing-set',
      p_set_id: '00000000-0000-5000-8000-000000000000',
      p_requirement: REQUIREMENT,
    }) as unknown as { data: Row }
    assert.equal(foreign.data.ok, false)
    assert.equal(foreign.data.reason, 'set-not-found')

    const { localCanonical } = await import('./localCanonical.ts')
    assert.equal(localCanonical().documents.length, 0, 'a refusal wrote a document')
  })

test('A REFUSAL CREATES NEITHER A PARTIAL SET NOR A PARTIAL DOCUMENT',
  { skip }, async () => {
    const id = await freshSubmission()
    const admin = await adminClient()
    // Valid mode, valid set payload, INVALID requirement: the set would be
    // created first if the two writes were not one act.
    for (const bad of [
      { ...REQUIREMENT, label: '   ' },
      { ...REQUIREMENT, prompt_text: '' },
      { ...REQUIREMENT, document_type: 'letter-of-intent' },
    ]) {
      const { data } = await admin.rpc('promote_statement_submission_to_requirement', {
        p_submission_id: id, p_mode: 'new-set', p_requirement: bad, p_set: SET,
      }) as unknown as { data: Row }
      assert.equal(data.ok, false, JSON.stringify(bad))
      const { localCanonical } = await import('./localCanonical.ts')
      assert.equal(localCanonical().sets.length, 0, 'an orphan set survived a refusal')
      assert.equal(localCanonical().documents.length, 0)
    }
    // And the submission was not marked approved by a failed promotion.
    assert.equal(submissions()[0]!.status, 'pending')
    assert.equal(submissions()[0]!.approved_requirement_id, null)
  })

test('a submission cannot be promoted TWICE', { skip }, async () => {
  const id = await freshSubmission()
  const admin = await adminClient()
  const first = await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: id, p_mode: 'new-set', p_requirement: REQUIREMENT, p_set: SET,
  }) as unknown as { data: Row }
  assert.equal(first.data.ok, true)

  const second = await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: id, p_mode: 'new-set', p_requirement: REQUIREMENT, p_set: SET,
  }) as unknown as { data: Row }
  assert.equal(second.data.ok, false)
  assert.equal(second.data.reason, 'already-promoted')
  const { localCanonical } = await import('./localCanonical.ts')
  assert.equal(localCanonical().sets.length, 1, 'a second set was created')
})

test('a REJECTED submission cannot be promoted', { skip }, async () => {
  const id = await freshSubmission()
  const admin = await adminClient()
  const { decideSubmission } = await import('../draft/submissionRepo.ts')
  const rejected = await decideSubmission(admin, {
    submissionId: id, decision: 'rejected', reviewerId: USER.userId,
  })
  assert.equal(rejected.ok, true, JSON.stringify(rejected))
  const { data } = await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: id, p_mode: 'new-set', p_requirement: REQUIREMENT, p_set: SET,
  }) as unknown as { data: Row }
  assert.equal(data.ok, false)
  assert.equal(data.reason, 'not-promotable')
})

test('A DUPLICATE SUBMISSION DOES NOT OVERWRITE CANONICAL DATA', { skip }, async () => {
  // Two applicants send the same wording; the first is promoted. The second
  // must be able to be promoted as its own row, or refused -- never to replace
  // what the first produced.
  const first = await freshSubmission()
  const admin = await adminClient()
  await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: first, p_mode: 'new-set', p_requirement: REQUIREMENT, p_set: SET,
  })
  const { localCanonical } = await import('./localCanonical.ts')
  const originalDoc = { ...localCanonical().documents[0]! }

  // A second submission of the same question, by the same applicant here but
  // identical in every respect that matters: it shares the fingerprint.
  const second = await CREATE!(request(body()))
  assert.equal(second.status, 201)
  const secondId = String(submissions().find((r) => r.id !== first)!.id)
  assert.equal(
    submissions().find((r) => r.id === secondId)!.text_fingerprint,
    submissions().find((r) => r.id === first)!.text_fingerprint,
    'the two submissions do not share a fingerprint')

  // Promoting it creates ANOTHER row. Nothing is merged and nothing is edited.
  const { data } = await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: secondId, p_mode: 'new-set',
    p_requirement: { ...REQUIREMENT, label: 'Essay 2' }, p_set: SET,
  }) as unknown as { data: Row }
  assert.equal(data.ok, true)
  assert.deepEqual(localCanonical().documents[0], originalDoc,
    'the first promotion was overwritten')
  assert.equal(localCanonical().documents.length, 2)
})

test('AN EXISTING SCHOOL REQUIREMENT IS NEVER REPLACED', { skip }, async () => {
  // Adding to an existing set appends a document; it does not touch the ones
  // already there.
  const id = await freshSubmission()
  const admin = await adminClient()
  const made = await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: id, p_mode: 'new-set', p_requirement: REQUIREMENT, p_set: SET,
  }) as unknown as { data: Row }
  const setId = String(made.data.setId)
  const { localCanonical } = await import('./localCanonical.ts')
  const before = JSON.parse(JSON.stringify(localCanonical().documents)) as Row[]

  const another = await CREATE!(request(body({ promptText: `${PROMPT} Second document.` })))
  assert.equal(another.status, 201)
  const nextId = String(submissions().find((r) => r.id !== id)!.id)

  const { data } = await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: nextId, p_mode: 'existing-set', p_set_id: setId,
    p_requirement: { ...REQUIREMENT, label: 'Diversity Statement',
      document_type: 'diversity-statement' },
  }) as unknown as { data: Row }
  assert.equal(data.ok, true, JSON.stringify(data))
  assert.equal(data.created, 'requirement', 'a second set was created instead')
  assert.equal(data.setId, setId)

  const after = localCanonical().documents
  assert.equal(after.length, before.length + 1)
  assert.deepEqual(after[0], before[0], 'the existing document was modified')
  // AND THE NEW ONE IS ALSO INACTIVE, which is the hazard case: a document
  // added to an ALREADY-ACTIVE set would otherwise be visible immediately.
  assert.equal(after[after.length - 1]!.is_active, false)
})

test('a verified set CAN be activated, and only then is it visible', { skip }, async () => {
  const id = await freshSubmission()
  const admin = await adminClient()
  const made = await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: id,
    p_mode: 'new-set',
    p_requirement: REQUIREMENT,
    // THE EVIDENCE 20261002_005 REQUIRES: verified, with a source and a date.
    p_set: { ...SET, verification_status: 'verified', verified_on: '2026-10-06' },
  }) as unknown as { data: Row }
  assert.equal(made.data.ok, true)

  const { activeLocalCanonical, simulateActivation } = await import('./localCanonical.ts')
  // STILL INVISIBLE. Being verifiable is not being published.
  assert.equal(activeLocalCanonical().sets.length, 0)

  const activated = simulateActivation(String(made.data.setId))
  assert.equal(activated.ok, true, activated.reason)
  assert.equal(activeLocalCanonical().sets.length, 1)
  assert.equal(activeLocalCanonical().documents.length, 1)
})

test('THE PRODUCTION PAYLOAD IS NEVER WRITTEN BY ANY OF THIS', { skip }, async () => {
  const payload = 'local-review/statement_requirements_catalog.json'
  const { readFileSync: read } = await import('node:fs')
  const parsed = JSON.parse(read(payload, 'utf8')) as { sets: Row[]; documents: Row[] }
  // The imported record of what production holds: 63 sets, 80 documents.
  assert.equal(parsed.sets.length, 63, 'the production payload changed')
  assert.equal(parsed.documents.length, 80, 'the production payload changed')
  // And nothing in it was ever marked active by this workflow.
  assert.equal(parsed.sets.filter((set) => set.is_active === true).length, 0,
    'a production set was activated')
})

// ------------------------------------- the canonical catalog is untouchable

test('NOTHING AN APPLICANT DOES CAN WRITE THE CANONICAL CATALOG', { skip }, async () => {
  const { statementDbClient } = await import('./guardedClient.ts')
  const { SimulatedLiveWriteBlocked } = await import('./gate.ts')
  const db = statementDbClient('fixture-token', { userId: USER.userId, isAdmin: false })
  for (const table of ['statement_requirement_sets', 'statement_requirements',
    'statement_prompts', 'statement_prompt_submissions']) {
    for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
      assert.throws(
        () => (db.from(table) as unknown as Record<string, () => unknown>)[operation]!(),
        SimulatedLiveWriteBlocked, `${table}.${operation}`)
    }
  }
  // And no function other than the three submission paths is callable.
  for (const fn of ['decide_statement_prompt_submission_unchecked',
    'record_ai_usage', 'claim_statement_analysis']) {
    assert.throws(() => db.rpc(fn), SimulatedLiveWriteBlocked, fn)
  }
})

test('an applicant cannot DECIDE their own submission', { skip }, async () => {
  const { statementDbClient } = await import('./guardedClient.ts')
  // A FRESH, UNDECIDED ROW. The admin tests above decided the earlier one, and
  // "already-decided" would pass this test for the wrong reason.
  rmSync(DRAFTS, { force: true })
  rmSync(SUBMISSIONS, { force: true })
  assert.equal((await CREATE!(request(body()))).status, 201)
  const db = statementDbClient('fixture-token', { userId: USER.userId, isAdmin: false })
  const id = String(submissions()[0]!.id)
  const { decideSubmission } = await import('../draft/submissionRepo.ts')
  const attempt = await decideSubmission(db, {
    submissionId: id, decision: 'approved', reviewerId: USER.userId, label: 'Essay 1',
  })
  assert.equal(attempt.ok, false)
  assert.equal(attempt.ok === false && attempt.detail, 'not-authorized')
  assert.equal(submissions().find((row) => row.id === id)!.status, 'pending')
})
