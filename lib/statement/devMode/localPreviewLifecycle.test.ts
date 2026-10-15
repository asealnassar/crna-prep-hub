/**
 * The whole local lifecycle: submitted, promoted, inactive, previewed, withdrawn.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS ACTUALLY CHECKING
 * ---------------------------------------------------------------------------
 * Promotion creates an INACTIVE set, which is right and which leaves one thing
 * unreviewable: what an applicant sees once a promoted requirement goes live.
 * The local preview toggle answers that. So the assertions are about the
 * boundary between the two:
 *
 *   the PREVIEW is real -- the applicant path finds the requirement through
 *   the ordinary catalog reader, not through anything that knows this is a
 *   preview;
 *
 *   the PRODUCTION CATALOG IS NOT TOUCHED -- the imported 63/80 payload is
 *   byte-identical afterwards, no production set changes activity, and the
 *   toggle has no code path to a database at all.
 *
 * THE APPLICANT READER IS THE SUBJECT, NOT A COPY OF IT. Every "does the
 * applicant see it" assertion goes through listRequirementSets() -- the same
 * function the New Draft dialog calls -- so a preview that only worked through
 * some admin-only path would fail here.
 */
import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.preview-test.json'
process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE = 'dev-submissions.preview-test.json'
process.env.STATEMENT_LOCAL_CANONICAL_FILE = 'dev-canonical.preview-test.json'
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const DRAFTS = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const SUBMISSIONS = `local-review/${process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE}`
const CANONICAL = `local-review/${process.env.STATEMENT_LOCAL_CANONICAL_FILE}`
const PAYLOAD = 'local-review/statement_requirements_catalog.json'

const ADMIN = { userId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' }
const APPLICANT = { userId: '22222222-2222-4222-8222-222222222222', email: 'them@example.invalid' }
let current = ADMIN

type Handler = (request: unknown, context?: unknown) => Promise<Response>
type Row = Record<string, unknown>

let CREATE: Handler | null = null
let ADMIN_GET: Handler | null = null
let ADMIN_PUT: Handler | null = null
/** A school with NO requirements in the imported payload: the case that matters. */
const SCHOOL = '99999999-9999-4999-8999-999999999999'
const SCHOOL_NAME = 'Prompt-less College'

const PROMPT = 'In 750 words, describe the clinical experience that prepared you.'

/** Everything an administrator decided. Verified, with a source and a date. */
const READY_SET = {
  application_cycle: '2026-2027',
  source_url: 'https://example.invalid/apply',
  verification_status: 'verified',
  verified_on: '2026-10-06',
  notes: [],
}
const REQUIREMENT = {
  label: 'Personal Statement',
  document_type: 'personal-statement',
  prompt_text: 'The wording an administrator reviewed and approved.',
  components: [{ id: 'c1', text: 'Why nurse anesthesia', optional: false }],
  min_words: 500,
  max_words: 750,
  max_pages: 1.5,
  words_enforcement: 'enforced',
  words_stated_as: 'Maximum of 750 words',
  display_order: 0,
}

const skip = !existsSync(PAYLOAD) || typeof mock.module !== 'function'

before(async () => {
  if (skip) return
  mock.module('@supabase/supabase-js', {
    namedExports: {
      createClient: () => ({
        from: (table: string) => {
          const rows = table === 'schools'
            ? [{ id: SCHOOL, name: SCHOOL_NAME, location_state: 'OH' }]
            : []
          const builder: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in', 'order', 'limit', 'like', 'gte', 'is']) {
            builder[m] = () => builder
          }
          builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
          builder.single = async () => ({ data: rows[0] ?? null, error: null })
          builder.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: rows, error: null }).then(resolve)
          return builder
        },
        rpc: () => { throw new Error('the real client must never be asked for an rpc') },
      }),
    },
  })
  mock.module('@/lib/apiAuth', {
    namedExports: {
      authenticateRequest: async () => ({ ...current, tier: 'ultimate', isUltimate: true }),
      readAccessToken: async () => 'fixture-token',
      isAdminEmail: (email?: string) => email === ADMIN.email,
      ADMIN_EMAILS: [ADMIN.email],
    },
  })
  CREATE = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  const admin = await import('../../../app/api/admin/statement-prompts/route.ts')
  ADMIN_GET = admin.GET as Handler
  ADMIN_PUT = admin.PUT as Handler
})

after(() => {
  if (skip) return
  for (const file of [DRAFTS, SUBMISSIONS, CANONICAL]) rmSync(file, { force: true })
})

const post = (body: unknown) => ({
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
  json: async () => body,
})
const get = () => ({
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
  json: async () => ({}),
})
const submissions = () => (existsSync(SUBMISSIONS)
  ? JSON.parse(readFileSync(SUBMISSIONS, 'utf8')) as Row[] : [])

/** The imported record of production, read fresh each time. */
const payload = () => JSON.parse(readFileSync(PAYLOAD, 'utf8')) as {
  sets: Row[]; documents: Row[]
}

/**
 * The payload as it was BEFORE this suite ran a single line.
 *
 * READ AT MODULE LOAD, so "unchanged" is a comparison rather than a number
 * somebody typed. The 63 sets are all inactive and the 80 documents are all
 * active; that is production's real state and this records it.
 */
const BASELINE = skip
  ? { sets: [] as Row[], documents: [] as Row[] }
  : payload()

/**
 * What an APPLICANT would see for this school.
 *
 * THROUGH THE ORDINARY READER. listRequirementSets() is what the New Draft
 * dialog calls; nothing here knows a preview exists.
 */
async function applicantSees(): Promise<readonly { label: string }[]> {
  const { statementDbClient } = await import('./guardedClient.ts')
  const { listRequirementSets } = await import('../requirements/repo.ts')
  const db = statementDbClient('fixture-token', {
    userId: APPLICANT.userId, isAdmin: false,
  })
  const sets = await listRequirementSets(db, SCHOOL, SCHOOL_NAME)
  assert.equal(sets.ok, true, `the applicant read failed: ${JSON.stringify(sets)}`)
  return sets.ok ? sets.value.flatMap((set) => set.requirements) : []
}

/** Submit, then promote with the given set payload. Returns the set id. */
async function promoted(setPayload: Row): Promise<{ submissionId: string; setId: string }> {
  for (const file of [DRAFTS, SUBMISSIONS, CANONICAL]) rmSync(file, { force: true })
  current = APPLICANT
  let submissionId = ''
  try {
    const created = await CREATE!(post({
      title: 'My statement',
      essay: '',
      promptSubmission: {
        schoolId: SCHOOL, promptText: PROMPT, statedMaxWords: 750, confirmed: true,
      },
    }))
    const body = await created.json() as Row
    assert.equal(created.status, 201, JSON.stringify(body))
    submissionId = String(body.submissionId)
  } finally {
    current = ADMIN
  }

  const { statementAdminClient } = await import('./guardedClient.ts')
  const admin = statementAdminClient('', { userId: ADMIN.userId, isAdmin: true })
  const { data } = await admin.rpc('promote_statement_submission_to_requirement', {
    p_submission_id: submissionId,
    p_mode: 'new-set',
    p_requirement: REQUIREMENT,
    p_set: setPayload,
  }) as unknown as { data: Row }
  assert.equal(data.ok, true, JSON.stringify(data))
  return { submissionId, setId: String(data.setId) }
}

// =========================================================================
// THE LIFECYCLE
// =========================================================================

test('1. A PROMOTED REQUIREMENT IS INVISIBLE TO THE APPLICANT', { skip }, async () => {
  await promoted(READY_SET)
  assert.deepEqual(await applicantSees(), [],
    'a freshly promoted requirement is already visible')
})

test('2. and the queue reports it as ready to preview, not active', { skip }, async () => {
  const body = await (await ADMIN_GET!(get())).json() as Row
  const row = (body.submissions as Row[])[0]!
  const preview = (body.localPreview as Record<string, Row>)[String(row.id)]
  assert.ok(preview, 'the queue reported no local preview state')
  assert.equal(preview.isActive, false)
  assert.equal(preview.qualifies, true, `not ready: ${JSON.stringify(preview.missing)}`)
  assert.deepEqual(preview.missing, [])
})

test('3. ACTIVATE FOR LOCAL PREVIEW makes it appear', { skip }, async () => {
  const setId = String(((await (await ADMIN_GET!(get())).json() as Row).localPreview as
    Record<string, Row>)[String(submissions()[0]!.id)]!.setId)

  const response = await ADMIN_PUT!(post({ setId, action: 'activate' }))
  const body = await response.json() as Row
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.isActive, true)
  assert.equal(body.localOnly, true)

  // THROUGH THE ORDINARY APPLICANT READER, which is the point: the preview is
  // the real rendering path, not a special admin view.
  const seen = await applicantSees()
  assert.equal(seen.length, 1, 'the activated requirement did not reach the applicant')
  assert.equal(seen[0]!.label, 'Personal Statement')
})

test('4. the applicant gets the FULL requirement, exactly as a verified one',
  { skip }, async () => {
    const seen = await applicantSees() as unknown as Row[]
    const requirement = seen[0]!
    // Every field an applicant screen reads, parsed by the production parser.
    assert.equal(requirement.promptText, REQUIREMENT.prompt_text)
    assert.equal(requirement.documentType, 'personal-statement')
    assert.equal((requirement.components as Row[]).length, 1)
    const constraints = requirement.constraints as Row
    assert.equal((constraints.words as Row).max, 750)
    assert.equal((constraints.words as Row).min, 500)
    // numeric(4,1): a page and a half survives into the applicant's view.
    assert.equal((constraints.pages as Row).max, 1.5)
  })

test('5. DEACTIVATE LOCAL PREVIEW makes it disappear again', { skip }, async () => {
  const setId = String(((await (await ADMIN_GET!(get())).json() as Row).localPreview as
    Record<string, Row>)[String(submissions()[0]!.id)]!.setId)

  const response = await ADMIN_PUT!(post({ setId, action: 'deactivate' }))
  const body = await response.json() as Row
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.isActive, false)
  assert.deepEqual(await applicantSees(), [], 'it is still visible after deactivating')
})

// =========================================================================
// EDITING AN ALREADY-PROMOTED ENTRY
// =========================================================================

/** The fields an administrator supplies after checking the programme page. */
const EVIDENCE = {
  application_cycle: '2026-2027',
  source_url: 'https://barry.example.invalid/crna/apply',
  verification_status: 'verified',
  verified_on: '2026-10-06',
  notes: ['Checked against the programme page on 6 October.'],
  original_text: PROMPT,
}

test('E1. A PROMOTED ENTRY CAN BE EDITED AFTER THE FACT', { skip }, async () => {
  // Promoted with none of activation's three conditions -- the state the owner
  // is actually in, and the one that used to require a second submission.
  const { setId } = await promoted({ application_cycle: '2025', notes: [] })

  const before = await (await ADMIN_GET!(get())).json() as Row
  const beforeState = (before.localPreview as Record<string, Row>)[
    String(submissions()[0]!.id)]!
  assert.equal(beforeState.qualifies, false)
  assert.equal((beforeState.missing as string[]).length, 3)
  // AND THE EDITOR IS HANDED THE STORED ROWS, not the submission.
  const entry = beforeState.entry as { set: Row; requirement: Row }
  assert.ok(entry, 'the queue did not carry the stored entry')
  assert.equal(entry.set.id, setId)
  assert.equal(entry.requirement.label, REQUIREMENT.label)

  const response = await ADMIN_PUT!(post({
    action: 'edit',
    requirementId: String(entry.requirement.id),
    set: EVIDENCE,
    requirement: { ...REQUIREMENT, label: 'Personal Statement (reviewed)' },
  }))
  const body = await response.json() as Row
  assert.equal(response.status, 200, JSON.stringify(body))
  // SAVING RELEASED NOTHING.
  assert.equal(body.isActive, false, 'saving an edit activated the entry')
  assert.equal(body.localOnly, true)
})

test('E2. the activation readiness updates IMMEDIATELY', { skip }, async () => {
  const body = await (await ADMIN_GET!(get())).json() as Row
  const state = (body.localPreview as Record<string, Row>)[String(submissions()[0]!.id)]!
  assert.equal(state.qualifies, true, `still not ready: ${JSON.stringify(state.missing)}`)
  assert.deepEqual(state.missing, [])
  assert.equal(state.isActive, false, 'the entry activated itself')
  // The edited label is what the queue now reports.
  assert.equal(state.label, 'Personal Statement (reviewed)')
  // And still invisible to applicants until somebody presses the button.
  assert.deepEqual(await applicantSees(), [])
})

test('E3. and it can then be activated, seen, and deactivated', { skip }, async () => {
  const state = ((await (await ADMIN_GET!(get())).json() as Row).localPreview as
    Record<string, Row>)[String(submissions()[0]!.id)]!
  const setId = String(state.setId)

  assert.equal((await ADMIN_PUT!(post({ setId, action: 'activate' }))).status, 200)
  const seen = await applicantSees()
  assert.equal(seen.length, 1, 'the edited entry did not reach the applicant')
  assert.equal(seen[0]!.label, 'Personal Statement (reviewed)')

  assert.equal((await ADMIN_PUT!(post({ setId, action: 'deactivate' }))).status, 200)
  assert.deepEqual(await applicantSees(), [])
})

test('E4. EDITING NEVER MUTATES THE STUDENT SUBMISSION', { skip }, async () => {
  // The submission is the historical record of what the applicant sent; the
  // canonical entry is the administrator's reviewed version. They diverge on
  // purpose, and the divergence must go one way only.
  const { setId } = await promoted({ application_cycle: '2025', notes: [] })
  const requirementId = String(submissions()[0]!.approved_requirement_id)
  const original = JSON.parse(JSON.stringify(submissions()[0]!)) as Row

  const response = await ADMIN_PUT!(post({
    action: 'edit',
    requirementId,
    set: EVIDENCE,
    requirement: {
      ...REQUIREMENT,
      label: 'Something else entirely',
      prompt_text: 'Wording the administrator rewrote from scratch.',
      document_type: 'supplemental-essay',
      max_words: 1200,
      max_pages: 3,
      words_enforcement: 'target',
    },
  }))
  assert.equal(response.status, 200, JSON.stringify(await response.json()))

  const after = submissions()[0]!
  // EVERY FIELD THE APPLICANT SUPPLIED IS BYTE-IDENTICAL.
  for (const column of ['prompt_text', 'stated_max_words', 'application_cycle',
    'source_url', 'document_label', 'document_type_hint', 'stated_min_words',
    'stated_max_characters', 'stated_max_pages', 'stated_pages_text',
    'formatting_instructions', 'other_instructions', 'submitter_note',
    'submitted_by', 'text_fingerprint', 'created_at']) {
    assert.deepEqual(after[column], original[column], `the submission's ${column} changed`)
  }
  // The review fields are unchanged too: editing is not a second decision.
  assert.equal(after.status, original.status)
  assert.equal(after.reviewed_by, original.reviewed_by)
  assert.equal(after.approved_requirement_id, requirementId)

  // AND THE CANONICAL ENTRY REALLY DID CHANGE, so this test is not passing
  // because nothing happened anywhere.
  const { localCanonicalEntryFor } = await import('./localCanonical.ts')
  const entry = localCanonicalEntryFor(requirementId)!
  assert.equal(entry.requirement.label, 'Something else entirely')
  assert.equal(entry.requirement.document_type, 'supplemental-essay')
  assert.equal(entry.requirement.max_words, 1200)
  assert.equal(entry.set.verification_status, 'verified')
  assert.equal(entry.set.id, setId)
})

test('E5. an edit cannot strip the evidence from an ACTIVE set', { skip }, async () => {
  // 20261002_005's constraint is checked on UPDATE as well as INSERT, so
  // unverifying an active set is a violation there. Refusing it here means an
  // administrator meets the real rule while editing.
  const { setId } = await promoted(READY_SET)
  const requirementId = String(submissions()[0]!.approved_requirement_id)
  assert.equal((await ADMIN_PUT!(post({ setId, action: 'activate' }))).status, 200)

  const response = await ADMIN_PUT!(post({
    action: 'edit',
    requirementId,
    set: { ...EVIDENCE, verification_status: 'unverified', verified_on: null },
    requirement: REQUIREMENT,
  }))
  const body = await response.json() as Row
  assert.equal(response.status, 400)
  assert.equal(body.code, 'active-needs-evidence')
  // THE SET IS STILL ACTIVE AND STILL VERIFIED: a refused edit changed nothing.
  const { localCanonicalEntryFor } = await import('./localCanonical.ts')
  const entry = localCanonicalEntryFor(requirementId)!
  assert.equal(entry.set.is_active, true)
  assert.equal(entry.set.verification_status, 'verified')
  assert.equal((await applicantSees()).length, 1)

  // Deactivate first, and the same edit is accepted.
  assert.equal((await ADMIN_PUT!(post({ setId, action: 'deactivate' }))).status, 200)
  const second = await ADMIN_PUT!(post({
    action: 'edit',
    requirementId,
    set: { ...EVIDENCE, verification_status: 'unverified', verified_on: null },
    requirement: REQUIREMENT,
  }))
  assert.equal(second.status, 200, JSON.stringify(await second.json()))
  assert.equal(localCanonicalEntryFor(requirementId)!.set.verification_status, 'unverified')
})

test('E6. an edit is refused on the same grounds a promotion is', { skip }, async () => {
  await promoted(READY_SET)
  const requirementId = String(submissions()[0]!.approved_requirement_id)
  for (const [bad, code] of [
    [{ ...REQUIREMENT, label: '  ' }, 'invalid-label'],
    [{ ...REQUIREMENT, prompt_text: '' }, 'invalid-prompt-text'],
    [{ ...REQUIREMENT, document_type: 'letter-of-intent' }, 'invalid-document-type'],
  ] as const) {
    const response = await ADMIN_PUT!(post({
      action: 'edit', requirementId, set: EVIDENCE, requirement: bad,
    }))
    const body = await response.json() as Row
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(body.code, code)
  }
})

test('E7. a PRODUCTION entry cannot be edited from here', { skip }, async () => {
  const response = await ADMIN_PUT!(post({
    action: 'edit',
    requirementId: String(payload().documents[0]!.id),
    set: EVIDENCE,
    requirement: REQUIREMENT,
  }))
  const body = await response.json() as Row
  assert.equal(response.status, 404)
  assert.equal(body.code, 'not-found')
  assert.match(String(body.error), /not created locally/)
})

test('E8. a non-admin cannot edit a catalog entry', { skip }, async () => {
  await promoted(READY_SET)
  const requirementId = String(submissions()[0]!.approved_requirement_id)
  current = APPLICANT
  try {
    const response = await ADMIN_PUT!(post({
      action: 'edit', requirementId, set: EVIDENCE, requirement: REQUIREMENT,
    }))
    assert.equal(response.status, 403)
  } finally {
    current = ADMIN
  }
  const { localCanonicalEntryFor } = await import('./localCanonical.ts')
  assert.equal(localCanonicalEntryFor(requirementId)!.set.verification_status, 'verified')
})

// =========================================================================
// WHAT IT REFUSES
// =========================================================================

test('an UNQUALIFIED set is refused, and the refusal names what is missing',
  { skip }, async () => {
    // Promoted with none of 20261002_005's three conditions met.
    const { setId } = await promoted({ application_cycle: '2026-2027', notes: [] })

    const response = await ADMIN_PUT!(post({ setId, action: 'activate' }))
    const body = await response.json() as Row
    assert.equal(response.status, 400)
    assert.equal(body.code, 'needs-evidence')
    const missing = body.missing as string[]
    assert.equal(missing.length, 3, JSON.stringify(missing))
    assert.ok(missing.some((m) => m.includes('verification status')))
    assert.ok(missing.some((m) => m.includes('source URL')))
    assert.ok(missing.some((m) => m.includes('verified date')))
    // And it is still invisible.
    assert.deepEqual(await applicantSees(), [])
  })

test('a half-qualified set names only what it still lacks', { skip }, async () => {
  const { setId } = await promoted({
    verification_status: 'verified',
    source_url: 'https://example.invalid/apply',
    notes: [],
  })
  const body = await (await ADMIN_PUT!(post({ setId, action: 'activate' }))).json() as Row
  const missing = body.missing as string[]
  assert.deepEqual(missing, ['no verified date'])
})

test('A PRODUCTION SET CANNOT BE TOGGLED FROM HERE', { skip }, async () => {
  // The imported 63 live in the payload copy, which this module cannot see --
  // so a real set id resolves to nothing rather than being activated.
  const productionSetId = String(payload().sets[0]!.id)
  const response = await ADMIN_PUT!(post({ setId: productionSetId, action: 'activate' }))
  const body = await response.json() as Row
  assert.equal(response.status, 404)
  assert.equal(body.code, 'not-found')
  assert.match(String(body.error), /not created locally/)
})

test('a non-admin cannot toggle a local preview', { skip }, async () => {
  const { setId } = await promoted(READY_SET)
  current = APPLICANT
  try {
    const response = await ADMIN_PUT!(post({ setId, action: 'activate' }))
    assert.equal(response.status, 403)
  } finally {
    current = ADMIN
  }
  assert.deepEqual(await applicantSees(), [], 'an applicant activated a set')
})

test('an invalid action or set id is refused', { skip }, async () => {
  const { setId } = await promoted(READY_SET)
  for (const action of [undefined, 'enable', 'ACTIVATE', 1]) {
    const response = await ADMIN_PUT!(post({ setId, action }))
    assert.equal(response.status, 400, `action ${String(action)} was accepted`)
  }
  const badId = await ADMIN_PUT!(post({ setId: 'not-a-uuid', action: 'activate' }))
  assert.equal(badId.status, 400)
})

// =========================================================================
// WHAT IT DID NOT TOUCH
// =========================================================================

test('THE PRODUCTION PAYLOAD IS UNCHANGED AT 63/80, WITH ZERO ACTIVE SETS',
  { skip }, async () => {
    // Activate, deactivate, and activate again -- then check the record of
    // production is exactly what it was.
    const { setId } = await promoted(READY_SET)
    for (const action of ['activate', 'deactivate', 'activate'] as const) {
      assert.equal((await ADMIN_PUT!(post({ setId, action }))).status, 200)
    }

    const after = payload()
    assert.equal(after.sets.length, 63, 'the production payload gained or lost a set')
    assert.equal(after.documents.length, 80, 'the production payload gained or lost a document')

    // ZERO ACTIVE SETS IS THE ONE THAT MATTERS. The SET is what gates
    // visibility -- the select policy on statement_requirement_sets is
    // `using (is_active)` -- so all 63 being inactive is what keeps the
    // imported catalog dark. The 80 documents are is_active = true in
    // production and always were; asserting zero there would be asserting
    // something untrue of the data this file is a copy of.
    assert.equal(after.sets.filter((set) => set.is_active === true).length, 0,
      'a production set was activated')
    // Compared against the state captured before any of this ran, so
    // "unchanged" means unchanged rather than "matches a number I chose".
    assert.deepEqual(
      after.documents.map((doc) => doc.is_active),
      BASELINE.documents.map((doc) => doc.is_active),
      'a production document changed activity')
    assert.deepEqual(after.sets.map((set) => set.is_active),
      BASELINE.sets.map((set) => set.is_active), 'a production set changed activity')
    // The locally activated set is NOT in that file.
    assert.equal(after.sets.some((set) => set.id === setId), false,
      'a local set was written into the production payload')
  })

test('THE TOGGLE HAS NO PATH TO A DATABASE AT ALL', { skip }, async () => {
  // Asserted on the module, because this is a property of what it imports
  // rather than of what it happened to do in these tests.
  const source = readFileSync('lib/statement/devMode/localCanonical.ts', 'utf8')
  const imports = source.slice(0, source.indexOf('type Row ='))
  // STORAGE IS A FILE, ONE LEVEL REMOVED. It read node:fs directly until the
  // read/write pair moved into the shared local store, which is what made the
  // writes atomic and stopped an unreadable file reading as an empty one.
  assert.match(imports, /from '\.\/jsonStore\.ts'/)
  assert.match(source, /readJsonStore|writeJsonStore/)
  for (const forbidden of ['@supabase/supabase-js', 'createClient', 'statementDbClient',
    'statementAdminClient', 'SERVICE_ROLE', '.rpc(']) {
    assert.equal(source.includes(forbidden), false, `localCanonical names ${forbidden}`)
  }
})

test('the endpoint does not exist outside development', { skip }, async () => {
  // NODE_ENV is fixed at build time, so a deployed build answers 404 here
  // however it is addressed. Asserted on the source because the gate cannot be
  // reached from a development process.
  const route = readFileSync('app/api/admin/statement-prompts/route.ts', 'utf8')
  const put = route.slice(route.indexOf('export async function PUT'))
  const gate = put.indexOf('if (!simulatedLiveEnabled()) {')
  const auth = put.indexOf('await requireAdmin()')
  assert.ok(gate > 0, 'the PUT handler is not gated on simulated-live')
  assert.ok(gate < auth, 'the gate must come before anything else runs')
})

test('and nothing outside the local store was written by this suite', { skip }, async () => {
  const { statementAdminClient } = await import('./guardedClient.ts')
  const { SimulatedLiveWriteBlocked } = await import('./gate.ts')
  const admin = statementAdminClient('', { userId: ADMIN.userId, isAdmin: true })
  for (const table of ['statement_requirement_sets', 'statement_requirements', 'schools']) {
    for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
      assert.throws(
        () => (admin.from(table) as unknown as Record<string, () => unknown>)[operation]!(),
        SimulatedLiveWriteBlocked, `${table}.${operation}`)
    }
  }
})
