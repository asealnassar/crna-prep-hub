/**
 * The admin catalog manager, through the real endpoint.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT HAS TO GET RIGHT
 * ---------------------------------------------------------------------------
 * The manager shows two kinds of row side by side, and the whole value of the
 * screen is that it never blurs them:
 *
 *   IMPORTED  the 63 sets copied from production. Shown UNFILTERED -- including
 *             the one whose verification is 'needs-review', which the applicant
 *             reader correctly withholds -- and read-only, because writing them
 *             means writing production.
 *   LOCAL     created here, by promoting a submission or by an administrator.
 *             Editable, previewable, and entirely in a gitignored file.
 *
 * So the assertions are mostly about that boundary: an imported id must be
 * unwritable through every verb, a local id must be writable through all of
 * them, and nothing either way may create an ACTIVE row.
 */
import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.catalog-test.json'
process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE = 'dev-submissions.catalog-test.json'
process.env.STATEMENT_LOCAL_CANONICAL_FILE = 'dev-canonical.catalog-test.json'
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const DRAFTS = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const SUBMISSIONS = `local-review/${process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE}`
const CANONICAL = `local-review/${process.env.STATEMENT_LOCAL_CANONICAL_FILE}`
const PAYLOAD = 'local-review/statement_requirements_catalog.json'

const ADMIN = { userId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' }
const APPLICANT = { userId: '22222222-2222-4222-8222-222222222222', email: 'them@example.invalid' }
let current = ADMIN

type Handler = (request?: unknown) => Promise<Response>
type Row = Record<string, unknown>

let GET: Handler | null = null
let POST: Handler | null = null
let PUT: Handler | null = null
let CREATE_DRAFT: Handler | null = null
let PROMPTS_PUT: Handler | null = null

/** A school the imported payload has requirements for, and one it does not. */
let importedSchool = ''
let importedSetId = ''
let importedDocumentId = ''
const freshSchool = '99999999-9999-4999-8999-999999999999'

const skip = !existsSync(PAYLOAD) || typeof mock.module !== 'function'

const REQUIREMENT = {
  label: 'Personal Statement',
  document_type: 'personal-statement',
  prompt_text: 'The wording an administrator reviewed.',
  components: [{ id: 'c1', text: 'Why nurse anesthesia', optional: false }],
  min_words: 500,
  max_words: 750,
  max_pages: 1.5,
  words_enforcement: 'enforced',
  display_order: 0,
}
const EVIDENCE = {
  application_cycle: '2026-2027',
  source_url: 'https://example.invalid/apply',
  verification_status: 'verified',
  verified_on: '2026-10-06',
  notes: [],
}

before(async () => {
  if (skip) return
  const payload = JSON.parse(readFileSync(PAYLOAD, 'utf8')) as { sets: Row[]; documents: Row[] }
  importedSetId = String(payload.sets[0]!.id)
  importedSchool = String(payload.sets[0]!.school_id)
  importedDocumentId = String(
    payload.documents.find((doc) => doc.set_id === importedSetId)!.id)

  mock.module('@supabase/supabase-js', {
    namedExports: {
      createClient: () => ({
        from: (table: string) => {
          const rows = table === 'schools'
            ? [
              { id: importedSchool, name: 'Alpha University', location_state: 'TX' },
              { id: freshSchool, name: 'Zeta College', location_state: 'OH' },
            ]
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

  const route = await import('../../../app/api/admin/statement-requirements/route.ts')
  GET = route.GET as Handler
  POST = route.POST as Handler
  PUT = route.PUT as Handler
  CREATE_DRAFT = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  PROMPTS_PUT = (await import(
    '../../../app/api/admin/statement-prompts/route.ts')).PUT as Handler
})

after(() => {
  if (skip) return
  for (const f of [DRAFTS, SUBMISSIONS, CANONICAL]) rmSync(f, { force: true })
})

const body = (payload: unknown) => ({
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
  json: async () => payload,
})
const catalog = async (): Promise<Row> => (await (await GET!()).json()) as Row
const submissions = () => (existsSync(SUBMISSIONS)
  ? JSON.parse(readFileSync(SUBMISSIONS, 'utf8')) as Row[] : [])
const payloadNow = () => JSON.parse(readFileSync(PAYLOAD, 'utf8')) as {
  sets: Row[]; documents: Row[]
}
const BASELINE = skip ? { sets: [], documents: [] } as { sets: Row[]; documents: Row[] } : payloadNow()

const setsOf = (c: Row) => c.sets as Row[]
const findSet = (c: Row, id: string) => setsOf(c).find((s) => s.id === id)

// =========================================================================
// WHAT IT SHOWS
// =========================================================================

test('EVERY imported set appears, unfiltered, alphabetical by school', { skip }, async () => {
  const c = await catalog()
  const imported = setsOf(c).filter((s) => s.source === 'import')
  // ALL 63, NOT THE 62 THE APPLICANT READER SERVES. The withheld one is
  // precisely the row whose verification a manager needs to see.
  assert.equal(imported.length, 63, 'the manager is hiding imported sets')
  assert.equal((c.counts as Row).importedDocuments, 80)
  assert.ok(imported.some((s) => s.verificationStatus !== 'verified'),
    'the needs-review set is being filtered out')

  const names = setsOf(c).map((s) => String(s.schoolName))
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)),
    'the default order is not alphabetical by school')
})

test('an imported set carries its set-level facts and document count', { skip }, async () => {
  const set = findSet(await catalog(), importedSetId)!
  assert.ok(set, 'the imported set is missing')
  assert.equal(typeof set.verificationStatus, 'string')
  assert.equal(set.isActive, false, 'an imported set is reported active')
  assert.equal(set.documentCount, (set.documents as Row[]).length)
  assert.ok((set.documents as Row[]).length >= 1)
})

test('IMPORTED ROWS ARE READ-ONLY, and say where they came from', { skip }, async () => {
  const set = findSet(await catalog(), importedSetId)!
  assert.equal(set.editable, false, 'an imported set is editable')
  assert.equal(set.activationMissing, null, 'an imported set offers local activation')
  for (const document of set.documents as Row[]) {
    assert.equal(document.editable, false)
    assert.equal(document.provenance, 'catalog-import')
    assert.equal(document.submissionId, null)
  }
})

test('a multi-document school lists every document, in display order', { skip }, async () => {
  const c = await catalog()
  const multi = setsOf(c).find((s) => (s.documents as Row[]).length > 1)
  if (multi === undefined) return // the payload may have none; not a failure
  const orders = (multi.documents as Row[]).map((d) => Number(d.display_order ?? 0))
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
})

// =========================================================================
// WHAT IT REFUSES TO WRITE
// =========================================================================

test('an imported DOCUMENT cannot be edited, and no write is attempted', { skip }, async () => {
  const before = readFileSync(PAYLOAD, 'utf8')
  const response = await PUT!(body({
    action: 'edit', requirementId: importedDocumentId, set: EVIDENCE, requirement: REQUIREMENT,
  }))
  const out = await response.json() as Row
  assert.equal(response.status, 404)
  assert.equal(out.code, 'production-backed')
  assert.match(String(out.error), /Production-backed catalog entry/)
  assert.equal(readFileSync(PAYLOAD, 'utf8'), before, 'the imported payload was written')
})

test('an imported SET cannot be activated for local preview', { skip }, async () => {
  const response = await PUT!(body({ action: 'activate', setId: importedSetId }))
  const out = await response.json() as Row
  assert.equal(response.status, 404)
  assert.equal(out.code, 'not-found')
  assert.match(String(out.error), /production-backed/i)
})

test('a document cannot be added to an imported set', { skip }, async () => {
  const response = await POST!(body({
    mode: 'existing-set', schoolId: importedSchool, setId: importedSetId,
    requirement: REQUIREMENT, set: EVIDENCE,
  }))
  const out = await response.json() as Row
  assert.equal(response.status, 404)
  assert.equal(out.code, 'set-not-found')
})

// =========================================================================
// ADD REQUIREMENT
// =========================================================================

let createdSetId = ''
let createdRequirementId = ''

test('CREATE A NEW LOCAL SET, and it defaults to INACTIVE', { skip }, async () => {
  for (const f of [DRAFTS, SUBMISSIONS, CANONICAL]) rmSync(f, { force: true })
  const response = await POST!(body({
    mode: 'new-set', schoolId: freshSchool, set: EVIDENCE, requirement: REQUIREMENT,
  }))
  const out = await response.json() as Row
  assert.equal(response.status, 200, JSON.stringify(out))
  assert.equal(out.created, 'set')
  assert.equal(out.isActive, false)
  createdSetId = String(out.setId)
  createdRequirementId = String(out.requirementId)

  const { localCanonical } = await import('./localCanonical.ts')
  const stored = localCanonical()
  assert.equal(stored.sets[0]!.is_active, false, 'a new set was created ACTIVE')
  assert.equal(stored.documents[0]!.is_active, false, 'a new document was created ACTIVE')
  // Added by an administrator, not promoted from anybody's submission.
  assert.equal(stored.documents[0]!.local_origin, 'admin')
})

test('it appears in the manager as local, editable, admin-created', { skip }, async () => {
  const set = findSet(await catalog(), createdSetId)!
  assert.ok(set, 'the created set is not in the catalog')
  assert.equal(set.source, 'local')
  assert.equal(set.editable, true)
  assert.equal(set.schoolName, 'Zeta College')
  assert.equal(set.isActive, false)
  assert.deepEqual(set.activationMissing, [], 'it should already qualify')
  const document = (set.documents as Row[])[0]!
  assert.equal(document.provenance, 'admin-created')
  assert.equal(document.submissionId, null)
})

test('ADD A DOCUMENT to an existing local set', { skip }, async () => {
  const response = await POST!(body({
    mode: 'existing-set', schoolId: freshSchool, setId: createdSetId,
    requirement: { ...REQUIREMENT, label: 'Diversity Statement',
      document_type: 'diversity-statement', display_order: 1 },
  }))
  const out = await response.json() as Row
  assert.equal(response.status, 200, JSON.stringify(out))
  assert.equal(out.created, 'requirement')
  assert.equal(out.setId, createdSetId, 'a second set was created instead')
  assert.equal(out.isActive, false)

  const set = findSet(await catalog(), createdSetId)!
  assert.equal(set.documentCount, 2)
  assert.deepEqual((set.documents as Row[]).map((d) => d.label),
    ['Personal Statement', 'Diversity Statement'])
})

test('the destination is never guessed, and a school is required', { skip }, async () => {
  for (const payload of [
    { schoolId: freshSchool, requirement: REQUIREMENT },
    { mode: 'whatever', schoolId: freshSchool, requirement: REQUIREMENT },
  ]) {
    assert.equal((await POST!(body(payload))).status, 400, JSON.stringify(payload))
  }
  assert.equal((await POST!(body({ mode: 'new-set', requirement: REQUIREMENT }))).status, 400)
  assert.equal((await POST!(body({
    mode: 'existing-set', schoolId: freshSchool, requirement: REQUIREMENT,
  }))).status, 400)
})

// =========================================================================
// EDIT AND LOCAL ACTIVATION
// =========================================================================

test('a LOCAL entry can be edited through the manager', { skip }, async () => {
  const response = await PUT!(body({
    action: 'edit',
    requirementId: createdRequirementId,
    set: { ...EVIDENCE, application_cycle: '2027-2028' },
    requirement: { ...REQUIREMENT, label: 'Personal Statement (revised)', max_words: 900 },
  }))
  const out = await response.json() as Row
  assert.equal(response.status, 200, JSON.stringify(out))
  assert.equal(out.isActive, false, 'saving an edit activated the set')

  const set = findSet(await catalog(), createdSetId)!
  assert.equal(set.applicationCycle, '2027-2028')
  const document = (set.documents as Row[]).find((d) => d.id === createdRequirementId)!
  assert.equal(document.label, 'Personal Statement (revised)')
  assert.equal(document.max_words, 900)
})

test('local activation and deactivation work, through the shared rules', { skip }, async () => {
  const on = await PUT!(body({ action: 'activate', setId: createdSetId }))
  assert.equal(on.status, 200, JSON.stringify(await on.json()))
  assert.equal(findSet(await catalog(), createdSetId)!.isActive, true)

  const off = await PUT!(body({ action: 'deactivate', setId: createdSetId }))
  assert.equal(off.status, 200)
  assert.equal(findSet(await catalog(), createdSetId)!.isActive, false)
})

test('an unqualified local set is refused, naming what is missing', { skip }, async () => {
  const made = await POST!(body({
    mode: 'new-set', schoolId: freshSchool,
    set: { application_cycle: '2025' }, requirement: REQUIREMENT,
  }))
  const setId = String(((await made.json()) as Row).setId)
  const response = await PUT!(body({ action: 'activate', setId }))
  const out = await response.json() as Row
  assert.equal(response.status, 400)
  assert.equal((out.missing as string[]).length, 3)
})

// =========================================================================
// PROVENANCE, AND THE SUBMISSION STAYS SEPARATE
// =========================================================================

test('a PROMOTED entry says it came from a student submission, and links to it',
  { skip }, async () => {
    for (const f of [DRAFTS, SUBMISSIONS, CANONICAL]) rmSync(f, { force: true })
    // A real submission, through the real applicant path.
    current = APPLICANT
    try {
      const created = await CREATE_DRAFT!(body({
        title: 'My statement',
        essay: '',
        promptSubmission: {
          schoolId: importedSchool,
          promptText: 'The question my school actually asks this year.',
          statedMaxWords: 750,
          confirmed: true,
        },
      }))
      assert.equal(created.status, 201, JSON.stringify(await created.json()))
    } finally {
      current = ADMIN
    }
    const submissionId = String(submissions()[0]!.id)

    // Promoted through the SUBMISSION queue, as an administrator would.
    const { statementAdminClient } = await import('./guardedClient.ts')
    const admin = statementAdminClient('', { userId: ADMIN.userId, isAdmin: true })
    const { data } = await admin.rpc('promote_statement_submission_to_requirement', {
      p_submission_id: submissionId,
      p_mode: 'new-set',
      p_requirement: REQUIREMENT,
      p_set: EVIDENCE,
    }) as unknown as { data: Row }
    assert.equal(data.ok, true, JSON.stringify(data))

    const set = findSet(await catalog(), String(data.setId))!
    const document = (set.documents as Row[])[0]!
    assert.equal(document.provenance, 'student-submission')
    assert.equal(document.submissionId, submissionId,
      'the canonical row does not link back to its submission')
  })

test('EDITING THE CANONICAL ENTRY LEAVES THE SUBMISSION UNTOUCHED', { skip }, async () => {
  const original = JSON.parse(JSON.stringify(submissions()[0]!)) as Row
  const requirementId = String(original.approved_requirement_id)

  const response = await PUT!(body({
    action: 'edit',
    requirementId,
    set: { ...EVIDENCE, verification_status: 'needs-review', verified_on: null },
    requirement: {
      ...REQUIREMENT,
      label: 'Rewritten by the reviewer',
      prompt_text: 'Wording the administrator replaced entirely.',
      document_type: 'supplemental-essay',
    },
  }))
  assert.equal(response.status, 200, JSON.stringify(await response.json()))

  const after = submissions()[0]!
  for (const column of ['prompt_text', 'stated_max_words', 'application_cycle', 'source_url',
    'submitted_by', 'status', 'reviewed_by', 'text_fingerprint', 'created_at',
    'approved_requirement_id']) {
    assert.deepEqual(after[column], original[column], `the submission's ${column} changed`)
  }
  // And the canonical row really did change.
  const { localCanonicalEntryFor } = await import('./localCanonical.ts')
  const entry = localCanonicalEntryFor(requirementId)!
  assert.equal(entry.requirement.label, 'Rewritten by the reviewer')
  assert.equal(entry.set.verification_status, 'needs-review')
})

// =========================================================================
// WHO MAY USE IT, AND WHAT IT NEVER TOUCHED
// =========================================================================

test('a NON-ADMIN is blocked from every verb', { skip }, async () => {
  current = APPLICANT
  try {
    assert.equal((await GET!()).status, 403)
    assert.equal((await POST!(body({
      mode: 'new-set', schoolId: freshSchool, requirement: REQUIREMENT,
    }))).status, 403)
    assert.equal((await PUT!(body({
      action: 'activate', setId: createdSetId,
    }))).status, 403)
  } finally {
    current = ADMIN
  }
})

test('the whole route is development-only', { skip }, async () => {
  const source = readFileSync('app/api/admin/statement-requirements/route.ts', 'utf8')
  const guard = source.slice(source.indexOf('async function requireAdmin'))
  const gate = guard.indexOf('if (!simulatedLiveEnabled()) {')
  const auth = guard.indexOf('await authenticateRequest()')
  assert.ok(gate > 0 && gate < auth, 'the dev gate must come before authentication')
  // And it never builds a privileged client of its own.
  assert.equal(source.includes('SUPABASE_SERVICE_ROLE_KEY'), false)
  assert.equal(source.includes('createClient('), false)
})

test('ZERO PRODUCTION WRITES, and the imported payload is byte-identical', { skip }, async () => {
  const after = payloadNow()
  assert.equal(after.sets.length, 63)
  assert.equal(after.documents.length, 80)
  assert.equal(after.sets.filter((s) => s.is_active === true).length, 0,
    'a production set was activated')
  assert.deepEqual(after.sets.map((s) => s.is_active), BASELINE.sets.map((s) => s.is_active))
  assert.deepEqual(after.documents.map((d) => d.is_active),
    BASELINE.documents.map((d) => d.is_active))

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

test('the activation rule is not reimplemented here', { skip }, async () => {
  // One readiness rule, in localCanonical.ts. A second copy would drift.
  const route = readFileSync('app/api/admin/statement-requirements/route.ts', 'utf8')
  assert.match(route, /local\.simulateActivation\(setId\)/)
  assert.match(route, /local\.simulateDeactivation\(setId\)/)
  assert.equal(route.includes("verification_status !== 'verified'"), false,
    'the route restates the readiness condition')
  // activationShortfall is IMPORTED, not defined here -- the route may read
  // set.verified_on to display it, but it may not decide readiness from it.
  assert.match(route, /activationShortfall\s*\}\s*=\s*\n?\s*await import/)
  assert.equal(route.includes('function activationShortfall'), false)
})

test('and the manager reuses the canonical editor rather than a second one',
  { skip }, async () => {
    const page = readFileSync('app/admin/statement-requirements/page.tsx', 'utf8')
    assert.match(page, /import PromotionEditor.*statement-prompts\/PromotionEditor/)
    assert.match(page, /mode="edit"/)
    assert.match(page, /mode="create"/)
    // The read-only wording the owner asked for, exactly.
    assert.match(page, /Production-backed catalog entry/)
    assert.match(page, /Source: Student submission/)
    assert.match(page, /Source: Verified catalog import/)
  })
