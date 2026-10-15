import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'
import { statementAdminClient } from '@/lib/statement/devMode/guardedClient'
import { simulatedLiveEnabled } from '@/lib/statement/devMode/gate'
import { listSchoolPickerOptions } from '@/lib/statement/draft/schoolPicker'

/**
 * The canonical prompt catalog, for administrators.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECOND ENDPOINT AND NOT MORE VERBS ON THE FIRST
 * ---------------------------------------------------------------------------
 * /api/admin/statement-prompts is about SUBMISSIONS: what applicants sent, and
 * the decisions taken on them. This is about the CATALOG: the reviewed rows
 * those decisions produce, plus every row that was imported rather than
 * submitted. They are different records with different lifecycles, and the one
 * thing they must never do is blur together -- a canonical entry is not a
 * submission with a flag set, and editing one must not touch the other.
 *
 * ---------------------------------------------------------------------------
 * TWO SOURCES, ONE OF WHICH IS READ-ONLY, AND THE DIFFERENCE IS REPORTED
 * ---------------------------------------------------------------------------
 *   IMPORTED      the 63 sets and 80 documents copied from production. Served
 *                 unfiltered so a 'needs-review' set is visible to the person
 *                 whose job is to review it -- but marked `editable: false`,
 *                 because writing them means writing production and that is a
 *                 separate design nobody has approved.
 *   LOCAL         sets and documents created here, by promoting a submission or
 *                 by an administrator adding one. Editable, activatable for
 *                 preview, and all of it in a gitignored file.
 *
 * NOTHING HERE CAN WRITE PRODUCTION. Every mutation goes through
 * lib/statement/devMode/localCanonical.ts, which imports node:fs and nothing
 * else -- no Supabase client, no service key, no rpc. The whole route is gated
 * on simulatedLiveEnabled(), so in a deployed build it answers 404.
 */

type Row = Record<string, unknown>

type Guard =
  | { ok: true; reviewerId: string }
  | { ok: false; response: NextResponse }

/**
 * The same two checks every admin surface makes, in the same order.
 *
 * THE DEV GATE COMES FIRST, deliberately: in production this route is
 * indistinguishable from a path that was never written, and that is decided
 * before any session is read.
 */
async function requireAdmin(): Promise<Guard> {
  if (!simulatedLiveEnabled()) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }
  const auth = await authenticateRequest()
  if (!auth) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!isAdminEmail(auth.email)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { ok: true, reviewerId: auth.userId }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const id = (value: unknown): string | null =>
  (typeof value === 'string' && UUID.test(value) ? value : null)
const obj = (value: unknown): Row | null =>
  (typeof value === 'object' && value !== null ? value as Row : null)

/**
 * Every set and document the local rehearsal can see, with its provenance.
 *
 * ONE RESPONSE, BECAUSE THE SCREEN IS ONE LIST. Searching and filtering happen
 * in the browser over a catalog of 63 sets; paginating it would add state to
 * both sides to save a few kilobytes on a developer's machine.
 */
export async function GET(): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const { importedCatalog } = await import('@/lib/statement/devMode/localCatalog')
  const { localCanonical, activationShortfall } =
    await import('@/lib/statement/devMode/localCanonical')
  const { localSubmissions } = await import('@/lib/statement/devMode/localSubmissions')

  const imported = importedCatalog()
  const local = localCanonical()

  /*
   * WHICH LOCAL DOCUMENT CAME FROM WHICH SUBMISSION.
   *
   * FROM THE SUBMISSION'S OWN LINK, not from the document. approved_requirement_id
   * is written by the promotion path and is the only authoritative statement
   * that the two are related -- a `local_origin` of 'promoted' says a row came
   * from SOME submission, which is not enough to link to one.
   */
  const submissionFor = new Map<string, string>()
  for (const row of localSubmissions()) {
    const requirementId = row.approved_requirement_id
    if (typeof requirementId === 'string') submissionFor.set(requirementId, String(row.id))
  }

  // THE DIRECTORY, read-only, for school names. A failure costs legibility and
  // not the page: the school id is shown instead.
  const db = statementAdminClient('', { userId: guard.reviewerId, isAdmin: true })
  const schools = await listSchoolPickerOptions(db).catch(() => ({ ok: false as const }))
  const names = new Map(
    (schools.ok ? schools.value : []).map((school) => [school.id, school.name]))

  const documentsBySet = new Map<string, Row[]>()
  for (const document of [...imported.documents, ...local.documents]) {
    const setId = String(document.set_id)
    const list = documentsBySet.get(setId) ?? []
    list.push(document)
    documentsBySet.set(setId, list)
  }

  const describe = (set: Row, source: 'import' | 'local') => {
    const setId = String(set.id)
    const documents = (documentsBySet.get(setId) ?? [])
      .slice()
      .sort((a, b) => Number(a.display_order ?? 0) - Number(b.display_order ?? 0))
    return {
      id: setId,
      schoolId: String(set.school_id),
      schoolName: names.get(String(set.school_id)) ?? String(set.school_id),
      applicationCycle: set.application_cycle ?? null,
      verificationStatus: String(set.verification_status ?? 'unverified'),
      sourceUrl: set.source_url ?? null,
      verifiedOn: set.verified_on ?? null,
      isActive: set.is_active === true,
      notes: Array.isArray(set.notes) ? set.notes : [],
      originalText: set.original_text ?? '',
      source,
      // IMPORTED ROWS ARE READ-ONLY HERE, and the screen says why rather than
      // offering a button that would fail.
      editable: source === 'local',
      // Only a local set can be previewed, and only when it meets the same
      // three conditions 20261002_005 puts on activation.
      activationMissing: source === 'local' ? activationShortfall(set) : null,
      documentCount: documents.length,
      documents: documents.map((document) => ({
        ...document,
        id: String(document.id),
        source,
        editable: source === 'local',
        // 'student-submission' only when a submission actually points at it.
        provenance: source === 'import'
          ? 'catalog-import'
          : submissionFor.has(String(document.id)) ? 'student-submission' : 'admin-created',
        submissionId: submissionFor.get(String(document.id)) ?? null,
      })),
    }
  }

  const sets = [
    ...imported.sets.map((set) => describe(set, 'import')),
    ...local.sets.map((set) => describe(set, 'local')),
  // ALPHABETICAL BY SCHOOL, as the default the owner asked for. Ties broken by
  // cycle so a school with two sets is always listed in the same order.
  ].sort((a, b) => a.schoolName.localeCompare(b.schoolName)
    || String(a.applicationCycle ?? '').localeCompare(String(b.applicationCycle ?? '')))

  return NextResponse.json({
    sets,
    schools: schools.ok ? schools.value : [],
    schoolsUnavailable: !schools.ok,
    counts: {
      imported: imported.sets.length,
      importedDocuments: imported.documents.length,
      local: local.sets.length,
      localDocuments: local.documents.length,
      // Said plainly, because it is the number the owner checks.
      activeImported: imported.sets.filter((set) => set.is_active === true).length,
    },
  })
}

/**
 * Add a requirement: a new local set, or another document in an existing one.
 *
 * THE DESTINATION IS CHOSEN, NEVER GUESSED, exactly as promotion requires. A
 * school with a set already might want another document in it or a set for a
 * new cycle; those are different facts, so `mode` has no default.
 *
 * AN EXISTING SET MUST BE A LOCAL ONE. Adding a document to one of the imported
 * 63 would be writing production catalog data, which this route cannot and must
 * not do -- so the id is looked up in the local store only, and an imported id
 * is 'set-not-found'.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const payload = obj(body)
  if (payload === null) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const mode = payload.mode
  if (mode !== 'new-set' && mode !== 'existing-set') {
    return NextResponse.json(
      { error: 'Choose whether to create a new set or add to an existing local set' },
      { status: 400 },
    )
  }
  const schoolId = id(payload.schoolId)
  if (!schoolId) return NextResponse.json({ error: 'Choose a school' }, { status: 400 })
  const setId = id(payload.setId)
  if (mode === 'existing-set' && !setId) {
    return NextResponse.json({ error: 'Choose the local set to add to' }, { status: 400 })
  }
  const requirement = obj(payload.requirement)
  if (requirement === null) {
    return NextResponse.json({ error: 'The requirement fields are missing' }, { status: 400 })
  }

  const { createLocalCanonicalEntry } = await import('@/lib/statement/devMode/localCanonical')
  const made = createLocalCanonicalEntry({
    schoolId,
    mode,
    setId,
    set: obj(payload.set) ?? {},
    requirement,
    // NOT 'promoted': no submission produced this, and the catalog manager says so.
    origin: 'admin',
  })
  if (!made.ok) {
    return NextResponse.json({
      error: MESSAGES[made.reason] ?? 'That requirement could not be created.',
      code: made.reason,
    }, { status: made.reason === 'set-not-found' ? 404 : 400 })
  }
  return NextResponse.json({
    setId: made.setId,
    requirementId: made.requirementId,
    created: made.created,
    // SAID PLAINLY. Creating catalog data is not releasing it.
    isActive: false,
  })
}

/**
 * Edit a local entry, or switch its local preview on and off.
 *
 * ONE HANDLER, THREE ACTIONS, all of them the same act underneath: change one
 * row in local-review/dev-canonical.json. The activation logic is NOT
 * reimplemented here -- simulateActivation()/simulateDeactivation() are the
 * same functions the submission queue calls, so the readiness rule exists once.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const payload = obj(body)
  if (payload === null) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const local = await import('@/lib/statement/devMode/localCanonical')
  const action = payload.action

  if (action === 'activate' || action === 'deactivate') {
    const setId = id(payload.setId)
    if (!setId) return NextResponse.json({ error: 'Invalid set id' }, { status: 400 })
    const outcome = action === 'activate'
      ? local.simulateActivation(setId)
      : local.simulateDeactivation(setId)
    if (!outcome.ok) {
      if (outcome.reason === 'not-found') {
        return NextResponse.json({
          error: 'That set is production-backed, so it cannot be previewed locally.',
          code: 'not-found',
        }, { status: 404 })
      }
      return NextResponse.json({
        error: `This set cannot be activated yet: ${(outcome.missing ?? []).join('; ')}.`,
        code: outcome.reason,
        missing: outcome.missing ?? [],
      }, { status: 400 })
    }
    return NextResponse.json({ setId, isActive: outcome.isActive, localOnly: true })
  }

  if (action !== 'edit') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const requirementId = id(payload.requirementId)
  if (!requirementId) {
    return NextResponse.json({ error: 'Invalid requirement id' }, { status: 400 })
  }
  const requirement = obj(payload.requirement)
  if (requirement === null) {
    return NextResponse.json({ error: 'The requirement fields are missing' }, { status: 400 })
  }

  const edited = local.updateLocalCanonicalEntry({
    requirementId,
    set: obj(payload.set) ?? {},
    requirement,
  })
  if (!edited.ok) {
    if (edited.reason === 'not-found') {
      // AN IMPORTED ROW LANDS HERE, and the wording is the one the screen shows
      // instead of offering an Edit button at all.
      return NextResponse.json({
        error: 'Production-backed catalog entry — editing is disabled in local rehearsal.',
        code: 'production-backed',
      }, { status: 404 })
    }
    if (edited.reason === 'active-needs-evidence') {
      return NextResponse.json({
        error: 'This set is active in local preview. Deactivate it first, or keep its '
          + `verification, source URL and verified date (${edited.detail}).`,
        code: edited.reason,
      }, { status: 400 })
    }
    return NextResponse.json({
      error: MESSAGES[edited.reason] ?? 'Those edits could not be saved.',
      code: edited.reason,
    }, { status: 400 })
  }
  return NextResponse.json({
    setId: edited.setId,
    requirementId: edited.requirementId,
    isActive: local.localPreviewFor(edited.requirementId)?.isActive === true,
    localOnly: true,
  })
}

/** One sentence per refusal the local writer can return. */
const MESSAGES: Readonly<Record<string, string>> = {
  'invalid-mode': 'Choose whether to create a new set or add to an existing one.',
  'invalid-school': 'Choose a school.',
  'set-required': 'Choose the set to add this document to.',
  'set-not-found': 'That set is not a local set for this school.',
  'invalid-label': 'Give the document a label.',
  'invalid-prompt-text': 'The prompt wording cannot be empty.',
  'invalid-document-type': 'Choose one of the nine document types.',
  'not-found': 'That entry no longer exists.',
}
