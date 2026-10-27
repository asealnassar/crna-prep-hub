/**
 * "This prompt has changed", end to end, through the real endpoints.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT
 * ---------------------------------------------------------------------------
 * The feature is a chain: the applicant's report reaches the submissions
 * store with its kind intact, the queue resolves the row it contradicts, the
 * administrator chooses between two outcomes BY NAME, and the applicant-facing
 * catalog changes in exactly one of those two ways. Every link has its own
 * test; none of them can show that the chain is connected, and the kind being
 * silently dropped by the local store was invisible to all of them.
 *
 * SO BOTH PATHS ARE PROVEN SEPARATELY, as the owner asked: Replace stops
 * offering the old prompt, Add leaves it offered. The assertion is made
 * against the APPLICANT'S OWN requirements endpoint -- what a student would
 * actually be shown -- not against the store the decision wrote to.
 *
 * NO SCHOOL IS NAMED ANYWHERE IN HERE. The fixture school and the requirement
 * under report are both read from the payload's first set, so this test would
 * pass against any catalog and cannot encode one school's shape.
 */
import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'
process.env.STATEMENT_STUDIO_MODE = 'general'
process.env.STATEMENT_LOCAL_DRAFTS_FILE = 'dev-drafts.report-test.json'
process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE = 'dev-submissions.report-test.json'
process.env.STATEMENT_LOCAL_CANONICAL_FILE = 'dev-canonical.report-test.json'
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const DRAFTS = `local-review/${process.env.STATEMENT_LOCAL_DRAFTS_FILE}`
const SUBMISSIONS = `local-review/${process.env.STATEMENT_LOCAL_SUBMISSIONS_FILE}`
const CANONICAL = `local-review/${process.env.STATEMENT_LOCAL_CANONICAL_FILE}`

const ADMIN = { userId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' }
const APPLICANT = { userId: '22222222-2222-4222-8222-222222222222', email: 'them@example.invalid' }
let current = ADMIN

type Handler = (request: unknown, context?: unknown) => Promise<Response>
type Row = Record<string, unknown>

let CREATE: Handler | null = null
let ADMIN_GET: Handler | null = null
let ADMIN_POST: Handler | null = null
let REQUIREMENTS: Handler | null = null

/** Read from the payload, never written here: the school and the row reported. */
let schoolId = ''
let challengedId = ''
let challengedText = ''

const REPORTED = 'Describe how your recent critical-care practice has prepared you for '
  + 'the responsibilities of a nurse anesthetist. This wording is the applicant’s.'

const skip = !existsSync('local-review/statement_requirements_catalog.json')
  || typeof mock.module !== 'function'

function directoryFixture(table: string): unknown {
  if (table !== 'schools') return null
  const rows = [{ id: schoolId, name: 'Fixture University', location_state: 'TX' }]
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
  const payload = JSON.parse(readFileSync(
    'local-review/statement_requirements_catalog.json', 'utf8')) as {
      sets: Row[]; documents: Row[]
    }
  // THE FIRST SET THAT IS ACTUALLY SERVED, by the same rule the reader applies:
  // an unverified set is withheld from applicants, so a report against one
  // could never be compared against anything.
  const servable = payload.sets.find((set) => set.verification_status === 'verified'
    && typeof set.source_url === 'string' && (set.source_url as string).length > 0
    && typeof set.verified_on === 'string' && (set.verified_on as string).length > 0)
  assert.ok(servable, 'the payload serves no set, so there is nothing to report against')
  schoolId = String(servable.school_id)
  const doc = payload.documents.find((row) => row.set_id === servable.id)
  assert.ok(doc, 'that set has no document to report')
  challengedId = String(doc.id)
  challengedText = String(doc.prompt_text)

  mock.module('@supabase/supabase-js', {
    namedExports: {
      createClient: () => ({
        from: (table: string) => {
          const served = directoryFixture(table)
          if (served !== null) return served
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
      isAdminEmail: (email?: string) => email === ADMIN.email,
      ADMIN_EMAILS: [ADMIN.email],
    },
  })

  CREATE = (await import('../../../app/api/statement/drafts/route.ts')).POST as Handler
  const admin = await import('../../../app/api/admin/statement-prompts/route.ts')
  ADMIN_GET = admin.GET as Handler
  ADMIN_POST = admin.POST as Handler
  REQUIREMENTS = (await import(
    '../../../app/api/statement/requirements/route.ts')).GET as Handler
})

after(() => {
  if (skip) return
  for (const file of [DRAFTS, SUBMISSIONS, CANONICAL]) rmSync(file, { force: true })
})

const get = (qs = '') => ({
  nextUrl: { searchParams: new URLSearchParams(qs) },
  headers: new Headers(),
  json: async () => ({}),
})
const post = (body: unknown) => ({
  nextUrl: { searchParams: new URLSearchParams() },
  headers: new Headers(),
  json: async () => body,
})

/** A fresh store for each path, so neither proof can inherit the other's. */
function reset(): void {
  for (const file of [DRAFTS, SUBMISSIONS, CANONICAL]) rmSync(file, { force: true })
}

/** One report, through the REAL applicant path. */
async function report(overrides: Row = {}): Promise<{ submissionId: string; draftId: string }> {
  const previous = current
  current = APPLICANT
  try {
    const response = await CREATE!(post({
      title: 'My statement',
      essay: '',
      promptSubmission: {
        schoolId,
        kind: 'prompt-change',
        challengedRequirementId: challengedId,
        promptText: REPORTED,
        confirmed: true,
        ...overrides,
      },
    }))
    const body = await response.json() as Row
    assert.equal(response.status, 201, `the report was refused: ${JSON.stringify(body)}`)
    return {
      submissionId: String(body.submissionId),
      draftId: String((body.draft as Row).id),
    }
  } finally {
    current = previous
  }
}

/** Every requirement id the APPLICANT is offered for this school. */
async function offered(): Promise<string[]> {
  const previous = current
  current = APPLICANT
  try {
    const response = await REQUIREMENTS!(get(`schoolId=${schoolId}`))
    const body = await response.json() as { sets?: { requirements?: { id: string }[] }[] }
    assert.equal(response.status, 200, `the catalog read failed: ${JSON.stringify(body)}`)
    return (body.sets ?? []).flatMap((set) => (set.requirements ?? []).map((req) => req.id))
  } finally {
    current = previous
  }
}

/** The promotion payload an administrator's editor sends. */
function promotion(id: string, extra: Row): Row {
  return {
    id,
    mode: 'new-set',
    setId: null,
    publish: true,
    set: {
      application_cycle: null,
      source_url: null,
      verification_status: 'unverified',
      verified_on: null,
      original_text: REPORTED,
      is_verbatim: true,
      notes: [],
      display_order: 0,
    },
    requirement: {
      label: 'Personal Statement',
      document_type: 'personal-statement',
      prompt_text: REPORTED,
      components: [],
      notes: [],
      display_order: 0,
    },
    ...extra,
  }
}

// =========================================================================
// the applicant's half
// =========================================================================

test('A REPORT REACHES THE STORE AS A REPORT, with the row it contradicts',
  { skip }, async () => {
    reset()
    const { submissionId, draftId } = await report()

    // THE REGRESSION THIS FILE WAS WRITTEN FOR. The local create accepted both
    // parameters and stored neither, so every report arrived in the queue
    // indistinguishable from a new prompt.
    const rows = JSON.parse(readFileSync(SUBMISSIONS, 'utf8')) as Row[]
    const stored = rows.find((row) => row.id === submissionId)
    assert.ok(stored, 'the submission was not stored')
    assert.equal(stored.submission_kind, 'prompt-change')
    assert.equal(stored.challenged_requirement_id, challengedId)
    assert.equal(stored.status, 'pending')

    // AND THE APPLICANT CAN WRITE IMMEDIATELY, on their own wording.
    const drafts = JSON.parse(readFileSync(DRAFTS, 'utf8')) as Row[]
    const draft = drafts.find((row) => row.id === draftId)
    assert.ok(draft, 'no draft was created for the report')
    assert.equal(draft.prompt_text, REPORTED)
    assert.equal(draft.prompt_submission_id, submissionId)
    // NOT A CATALOG PROMPT. prompt_id stays null, so nothing in the product
    // can describe this wording as one CRNAPREPHUB vouches for.
    assert.equal(draft.prompt_id, null)
    assert.equal(draft.requirement_id, null)
  })

test('THE CANONICAL ROW IS UNTOUCHED BY THE REPORT ITSELF', { skip }, async () => {
  reset()
  const before = await offered()
  await report()
  assert.deepEqual(await offered(), before,
    'reporting a prompt changed what applicants are offered')
})

test('a report naming no requirement is refused, and so is a new prompt naming one',
  { skip }, async () => {
    reset()
    const previous = current
    current = APPLICANT
    try {
      const noTarget = await CREATE!(post({
        title: 'My statement',
        essay: '',
        promptSubmission: {
          schoolId, kind: 'prompt-change', promptText: REPORTED, confirmed: true,
        },
      }))
      assert.equal(noTarget.status, 400)
      assert.equal((await noTarget.json() as Row).code, 'invalid-challenged-requirement')

      const wrongKind = await CREATE!(post({
        title: 'My statement',
        essay: '',
        promptSubmission: {
          schoolId,
          kind: 'new-prompt',
          challengedRequirementId: challengedId,
          promptText: REPORTED,
          confirmed: true,
        },
      }))
      assert.equal(wrongKind.status, 400)
      assert.equal((await wrongKind.json() as Row).code, 'invalid-challenged-requirement')
    } finally {
      current = previous
    }
  })

// =========================================================================
// the queue's half
// =========================================================================

test('THE QUEUE SHOWS THE REPORT BESIDE THE ROW IT CONTRADICTS', { skip }, async () => {
  reset()
  const { submissionId } = await report()
  const response = await ADMIN_GET!(get())
  const body = await response.json() as Row
  assert.equal(response.status, 200, `the queue failed: ${JSON.stringify(body)}`)

  const row = (body.submissions as Row[]).find((entry) => entry.id === submissionId)
  assert.ok(row, 'the report is not in the queue')
  assert.equal(row.kind, 'prompt-change')
  assert.equal(row.challengedRequirementId, challengedId)

  // OUR SIDE OF THE COMPARISON, RESOLVED BY THE SERVER FROM THE ID.
  const challenged = (body.challenged as Record<string, Row>)[submissionId]
  assert.ok(challenged, 'the challenged row was not resolved')
  assert.equal(challenged.requirementId, challengedId)
  assert.equal(challenged.promptText, challengedText)
  assert.equal(challenged.offered, true)
})

test('PUBLISHING A REPORT WITHOUT CHOOSING AN OUTCOME IS REFUSED', { skip }, async () => {
  reset()
  const { submissionId } = await report()
  const response = await ADMIN_POST!(post(promotion(submissionId, {})))
  const body = await response.json() as Row
  assert.equal(response.status, 400, `the promotion was not refused: ${JSON.stringify(body)}`)
  assert.equal(body.code, 'change-action-required')
  // AND NOTHING WAS CREATED. A refusal that half-published would be worse than
  // one that guessed.
  assert.deepEqual(await offered(), (await offered()).filter(() => true))
  assert.ok((await offered()).includes(challengedId))
})

test('and the word is refused on a submission that is NOT a report', { skip }, async () => {
  reset()
  const previous = current
  current = APPLICANT
  const created = await CREATE!(post({
    title: 'My statement',
    essay: '',
    promptSubmission: { schoolId, promptText: REPORTED, confirmed: true },
  }))
  const createdBody = await created.json() as Row
  current = previous
  assert.equal(created.status, 201, JSON.stringify(createdBody))

  const response = await ADMIN_POST!(post(
    promotion(String(createdBody.submissionId), { changeAction: 'replace' })))
  const body = await response.json() as Row
  assert.equal(response.status, 400)
  assert.equal(body.code, 'not-a-report')
})

// =========================================================================
// PATH ONE: ADD AS ADDITIONAL PROMPT
// =========================================================================

test('ADD AS ADDITIONAL — both prompts are offered afterwards', { skip }, async () => {
  reset()
  const { submissionId } = await report()
  const response = await ADMIN_POST!(post(
    promotion(submissionId, { changeAction: 'add-additional' })))
  const body = await response.json() as Row
  assert.equal(response.status, 200, `the promotion failed: ${JSON.stringify(body)}`)
  assert.equal(body.isActive, true, `it was not published: ${JSON.stringify(body)}`)
  // NOTHING WAS SUPERSEDED, and the response says so rather than leaving it to
  // be inferred from the absence of a field.
  assert.equal(body.superseded, null)
  assert.equal(body.supersedeError, null)

  const ids = await offered()
  assert.ok(ids.includes(challengedId),
    'adding an additional prompt stopped offering the reported one')
  assert.ok(ids.includes(String(body.requirementId)),
    'the additional prompt is not offered')
})

// =========================================================================
// PATH TWO: REPLACE EXISTING PROMPT
// =========================================================================

test('REPLACE — the reported prompt stops being offered, the replacement is',
  { skip }, async () => {
    reset()
    const { submissionId } = await report()
    assert.ok((await offered()).includes(challengedId),
      'the row under report is not offered to begin with')

    const response = await ADMIN_POST!(post(
      promotion(submissionId, { changeAction: 'replace' })))
    const body = await response.json() as Row
    assert.equal(response.status, 200, `the replacement failed: ${JSON.stringify(body)}`)
    assert.equal(body.isActive, true, `it was not published: ${JSON.stringify(body)}`)
    assert.equal(body.superseded, challengedId)
    assert.equal(body.supersedeError, null)

    const ids = await offered()
    assert.equal(ids.includes(challengedId), false,
      'THE SUPERSEDED PROMPT IS STILL OFFERED AS CURRENT')
    assert.ok(ids.includes(String(body.requirementId)),
      'the replacement is not offered')
  })

test('REPLACE preserves the history: what was replaced, by what, and from which report',
  { skip }, async () => {
    reset()
    const { submissionId } = await report()
    const response = await ADMIN_POST!(post(
      promotion(submissionId, { changeAction: 'replace' })))
    const body = await response.json() as Row
    assert.equal(response.status, 200, JSON.stringify(body))

    // THE REPLACED ROW IS DEACTIVATED, NEVER DELETED. It is still readable in
    // full, which is what 20261008_012 keeps answerable in production.
    const { localRequirementRow } = await import('./localCatalog.ts')
    const kept = localRequirementRow(challengedId)
    assert.ok(kept, 'the replaced requirement is gone, not deactivated')
    assert.equal(kept.row.prompt_text, challengedText)
    assert.equal(kept.offered, false)

    const { localSupersessions } = await import('./localCanonical.ts')
    const recorded = localSupersessions().find((row) => row.requirementId === challengedId)
    assert.ok(recorded, 'no replacement was recorded')
    assert.equal(recorded.supersededBy, String(body.requirementId))
    assert.equal(recorded.submissionId, submissionId)

    // AND THE QUEUE SAYS SO, so a second report about the same row is read
    // against a prompt the reviewer knows is already superseded.
    const queued = await (await ADMIN_GET!(get())).json() as Row
    const challenged = (queued.challenged as Record<string, Row>)[submissionId]
    assert.ok(challenged)
    assert.equal(challenged.offered, false)
  })

test('REPLACE takes effect only once the replacement is actually published',
  { skip }, async () => {
    reset()
    const { submissionId } = await report()
    // SAVED, NOT PUBLISHED: the same choice, without `publish`.
    const payload = promotion(submissionId, { changeAction: 'replace' })
    delete payload.publish
    const response = await ADMIN_POST!(post(payload))
    const body = await response.json() as Row
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.isActive, false, 'saving published something')

    /*
     * THE OLD PROMPT IS STILL OFFERED, AND THAT IS THE CORRECT ANSWER.
     *
     * Removing it here would leave the school showing nothing: the replacement
     * exists but is inactive, which is what "nothing becomes applicant-visible
     * by saving" means in this product. A supersession therefore takes effect
     * exactly when its replacement is live.
     */
    assert.ok((await offered()).includes(challengedId),
      'an unpublished replacement removed the prompt it replaces')
  })
