import { NextRequest, NextResponse } from 'next/server'
import { type SupabaseClient } from '@supabase/supabase-js'
import { statementAdminClient } from '@/lib/statement/devMode/guardedClient'
import { simulatedLiveEnabled } from '@/lib/statement/devMode/gate'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'
import { isSubmissionStatus } from '@/lib/statement/draft/promptSubmission'
import {
  decideSubmission, listSubmissionsForReview, readSubmissionForReview,
} from '@/lib/statement/draft/submissionRepo'
import { listSchoolPickerOptions } from '@/lib/statement/draft/schoolPicker'
import { listRequirementSets } from '@/lib/statement/requirements/repo'
import { promptSubmissionsEnabled } from '@/lib/statement/draft/rollout'

/**
 * Admin-only moderation of applicant-submitted school prompts.
 *
 * THE SAME SHAPE AS app/api/admin/reports/route.ts, deliberately: authenticate,
 * then authorize against the shared allowlist, and only THEN construct the
 * service-role client. Nothing privileged is built for a caller who has not
 * passed both, so an unauthorized request never reaches a client that could
 * bypass RLS.
 *
 * NO BROWSER FLAG DECIDES ANYTHING. isAdminEmail reads the verified session's
 * address, not a header, a body field or a cookie the caller controls. There is
 * no `isAdmin` in any request this route accepts.
 *
 * TWO INDEPENDENT BARRIERS ON THE CATALOG. This route is the only caller of
 * decide_statement_prompt_submission, and that function's EXECUTE is granted to
 * service_role alone -- so even a mistake here cannot be reached by a browser,
 * and even a stolen session cannot publish without the service key.
 *
 * THERE IS NO GENERAL-PURPOSE UPDATE. PATCH takes one of three decisions from a
 * fixed set and passes them to a function whose statements are fixed. The body
 * cannot name a column, so no other field of any table is writable from here.
 *
 * THE APPLICANT'S ESSAY IS NOWHERE IN THIS FILE. Moderation is about a question,
 * not about what anyone wrote in answer to it; statement_drafts is never read,
 * and `essay` appears in neither the query nor the response.
 */

export const dynamic = 'force-dynamic'

type Guard =
  | { ok: true; admin: SupabaseClient; reviewerId: string }
  | { ok: false; response: NextResponse }

async function requireAdmin(): Promise<Guard> {
  const auth = await authenticateRequest()
  if (!auth) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!isAdminEmail(auth.email)) {
    return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  if (!promptSubmissionsEnabled()) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  /*
   * THE KEY IS REQUIRED IN PRODUCTION AND MEANINGLESS IN SIMULATED LIVE.
   *
   * statementAdminClient() never reads it on the development branch -- the
   * local submission store answers the queue and the local catalog answers the
   * context -- so demanding one made the review queue unusable on a machine
   * that has no reason to hold a production service key. It returned 500
   * "Server configuration error", which the page reported as "Those
   * submissions could not be loaded".
   *
   * OUTSIDE DEVELOPMENT NOTHING CHANGES: no key, no privileged client, no
   * queue. The check is unchanged for every deployed build.
   */
  if (!serviceKey && !simulatedLiveEnabled()) {
    console.error('Admin statement prompts: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return {
      ok: false,
      response: NextResponse.json({ error: 'Server configuration error' }, { status: 500 }),
    }
  }

  return {
    ok: true,
    reviewerId: auth.userId,
    // THE SAME CLIENT AS BEFORE IN PRODUCTION, and never the service key in
    // development: see statementAdminClient(). Reviewing local submissions must
    // not read production, and Approve must not write it.
    admin: statementAdminClient(serviceKey ?? '', {
      userId: auth.userId,
      isAdmin: true,
    }),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DECISIONS = ['approved', 'rejected', 'duplicate'] as const
type Decision = (typeof DECISIONS)[number]

/**
 * What an administrator may do with a "this prompt has changed" report that
 * they accept.
 *
 * ---------------------------------------------------------------------------
 * TWO WORDS, AND NEITHER IS A DEFAULT
 * ---------------------------------------------------------------------------
 * 'replace'        this is the school's prompt now; the old row stops being
 *                  offered and records what replaced it.
 * 'add-additional' the school asks for both; the old row stays exactly as it
 *                  is and the reported wording joins it.
 *
 * THE DIFFERENCE IS NOT INFERABLE FROM THE SUBMISSION. An applicant reporting
 * a change cannot know whether their school dropped the old question or added
 * a second one, and a product that guessed would quietly delete a prompt other
 * applicants are mid-draft on -- or leave a prompt the school abandoned on
 * screen as current. So a report cannot be published without one of these two
 * words, and the handler refuses rather than choosing.
 */
const CHANGE_ACTIONS = ['replace', 'add-additional'] as const
type ChangeAction = (typeof CHANGE_ACTIONS)[number]

const isChangeAction = (value: unknown): value is ChangeAction =>
  typeof value === 'string' && (CHANGE_ACTIONS as readonly string[]).includes(value)

const isDecision = (value: unknown): value is Decision =>
  typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)

const optionalId = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null

const optionalText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/** The review queue, optionally narrowed to one status. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const asked = request.nextUrl.searchParams.get('status')
  const status = asked !== null && isSubmissionStatus(asked) ? asked : undefined

  const listed = await listSubmissionsForReview(guard.admin, { status })
  if (!listed.ok) {
    console.error('Admin statement prompts: list failed —', listed.reason)
    return NextResponse.json({ error: 'Could not load submissions' }, { status: 500 })
  }

  // THE SAME DIRECTORY THE PICKER OFFERS, not a second source of school names.
  // listSchoolPickerOptions reads three columns and is what the applicant saw
  // when they chose, so a reviewer and a submitter are looking at one list.
  //
  // A FAILED DIRECTORY READ DOES NOT FAIL THE QUEUE. Names are how a reviewer
  // recognises a school; ids are how the decision is applied. Losing the first
  // costs legibility, and the page falls back to showing the id.
  /*
   * CONTEXT IS BEST-EFFORT, AND A THROW IS NOT A FAILED QUEUE.
   *
   * The route already treated a failed directory read as "show the id instead".
   * It did not survive a THROWN one -- and simulated-live threw, because the
   * local admin client refused every table it did not serve. The result was a
   * 500 for the whole queue over a missing school NAME.
   *
   * So both context reads are caught. The submissions themselves are not: if
   * those cannot be read there is no queue to render, and saying so is right.
   */
  const schools = await listSchoolPickerOptions(guard.admin).catch((error: unknown) => {
    console.error('Admin statement prompts: directory read threw —',
      (error as { name?: string })?.name)
    return { ok: false as const, reason: 'read-failed' as const, detail: 'threw' }
  })
  const byId = new Map((schools.ok ? schools.value : []).map((s) => [s.id, s.name]))

  /*
   * WHAT THE SCHOOL ALREADY HAS, PER SCHOOL IN THE QUEUE.
   *
   * WHY THE REVIEWER NEEDS IT BEFORE DECIDING. A submission that looks new may
   * be this year's wording for a document already in the catalog, or a document
   * the school added, or the same question a different applicant sent last
   * week. Those are three different decisions, and the queue cannot be read
   * without knowing which -- so the catalog is fetched here rather than left
   * for the reviewer to go and look up.
   *
   * ONE READ PER DISTINCT SCHOOL, not one per submission: five submissions for
   * one school ask the same question five times.
   *
   * A FAILED READ IS NOT A FAILED QUEUE. Same reasoning as the directory above:
   * losing this costs context, and the screen says so rather than disappearing.
   */
  const schoolIds = [...new Set(listed.value.map((row) => row.schoolId))]
  const catalog: Record<string, unknown> = {}
  for (const schoolId of schoolIds) {
    const sets = await listRequirementSets(guard.admin, schoolId, byId.get(schoolId) ?? '')
      .catch((error: unknown) => {
        console.error('Admin statement prompts: catalog read threw —',
          (error as { name?: string })?.name)
        return { ok: false as const, reason: 'read-failed' as const, detail: 'threw' }
      })
    catalog[schoolId] = sets.ok
      ? {
        available: true,
        /*
         * ONLY ACTIVE SETS ARE HERE, AND THAT IS NOT A LIMITATION.
         *
         * listRequirementSets reads what an APPLICANT can see: the select
         * policy on statement_requirement_sets is `using (is_active)`, so an
         * inactive set is invisible to every reader including this one. That
         * makes this list exactly the right thing for a reviewer to compare a
         * submission against -- "what do applicants have today" -- and it is
         * why a set promoted a moment ago does not appear: it was created
         * inactive, which is the behaviour being demonstrated.
         *
         * A PROMOTED SUBMISSION SAYS SO ITSELF, through its own
         * approvedRequirementId. The queue reads that rather than looking for
         * a catalog row it is not allowed to see.
         */
        sets: sets.value.map((set) => ({
          id: set.id,
          applicationCycle: set.applicationCycle,
          verification: set.verification,
          requirements: set.requirements.map((req) => ({
            id: req.id,
            label: req.label,
            documentType: req.documentType,
            promptText: req.promptText,
          })),
        })),
      }
      : { available: false, reason: sets.reason }
  }

  /*
   * DUPLICATE CONTEXT, COMPUTED AND NOT DECIDED.
   *
   * THE FINGERPRINT GROUPS, A HUMAN DECIDES. 20261002_000 deliberately put no
   * unique constraint on text_fingerprint: two applicants sending the same
   * question is normal and both rows are kept. So this counts and groups, and
   * nothing merges anything.
   */
  const pendingPerSchool: Record<string, number> = {}
  const fingerprintGroups: Record<string, string[]> = {}
  for (const row of listed.value) {
    if (row.status === 'pending') {
      pendingPerSchool[row.schoolId] = (pendingPerSchool[row.schoolId] ?? 0) + 1
    }
    const group = fingerprintGroups[row.textFingerprint] ?? []
    group.push(row.id)
    fingerprintGroups[row.textFingerprint] = group
  }

  /*
   * DEVELOPMENT ONLY: the local preview state of anything already promoted.
   *
   * KEYED BY SUBMISSION, because that is what the queue renders. For each
   * promoted submission it reports whether its local set is switched on, and
   * if not, exactly which of 20261002_005's three conditions it still fails --
   * so the button can explain itself before it is pressed.
   *
   * EMPTY IN PRODUCTION. simulatedLiveEnabled() is NODE_ENV, and the module
   * that answers this is never even imported in a deployed build.
   */
  const localPreview: Record<string, unknown> = {}
  if (simulatedLiveEnabled()) {
    const { localPreviewFor, localCanonicalEntryFor } =
      await import('@/lib/statement/devMode/localCanonical')
    for (const row of listed.value) {
      if (row.approvedRequirementId === null) continue
      const state = localPreviewFor(row.approvedRequirementId)
      if (state === null) continue
      // THE STORED ROWS GO WITH IT, so "Edit Catalog Entry" reopens the editor
      // on exactly what is there rather than on the submission it came from.
      // Those two have diverged by now, and that divergence is the point.
      const entry = localCanonicalEntryFor(row.approvedRequirementId)
      localPreview[row.id] = { ...state, entry }
    }
  }

  /*
   * THE ROW EACH REPORT CONTRADICTS, RESOLVED FOR THE QUEUE.
   *
   * ---------------------------------------------------------------------
   * TWO SOURCES, IN THIS ORDER, AND NEITHER IS A GUESS
   * ---------------------------------------------------------------------
   * A report is reviewed by reading our wording beside the applicant's. The
   * catalog context above already holds what applicants are offered TODAY, so
   * that is asked first and `offered` is true.
   *
   * A row that is no longer offered still has to be readable, and that is not
   * an edge case: it is precisely the state a report leaves behind once a
   * previous replacement was accepted. Locally the unfiltered reader answers
   * it and `offered` is false, so the screen can say "this was replaced"
   * rather than showing an empty comparison.
   *
   * NOTHING IS SNAPSHOTTED INTO THE SUBMISSION. The report stores an id, and
   * the wording is resolved at read time -- so a catalog correction made after
   * the report was filed is visible to the reviewer instead of hidden behind a
   * stale copy.
   */
  const challenged: Record<string, unknown> = {}
  for (const row of listed.value) {
    if (row.kind !== 'prompt-change' || row.challengedRequirementId === null) continue
    const context = catalog[row.schoolId] as
      { available?: boolean; sets?: { requirements?: Record<string, unknown>[] }[] } | undefined
    let found: Record<string, unknown> | null = null
    for (const set of context?.sets ?? []) {
      const match = (set.requirements ?? []).find(
        (req) => req.id === row.challengedRequirementId)
      if (match !== undefined) { found = match; break }
    }
    if (found !== null) {
      challenged[row.id] = {
        requirementId: row.challengedRequirementId,
        label: found.label ?? null,
        documentType: found.documentType ?? null,
        promptText: found.promptText ?? null,
        offered: true,
      }
      continue
    }
    if (!simulatedLiveEnabled()) continue
    const { localRequirementRow } = await import('@/lib/statement/devMode/localCatalog')
    const stored = localRequirementRow(row.challengedRequirementId)
    if (stored === null) continue
    challenged[row.id] = {
      requirementId: row.challengedRequirementId,
      label: stored.row.label ?? null,
      documentType: stored.row.document_type ?? null,
      promptText: stored.row.prompt_text ?? null,
      offered: stored.offered,
      source: stored.source,
    }
  }

  /*
   * REPLACEMENTS ALREADY RECORDED, so a decided report shows its own outcome
   * rather than only its inputs. Development only; production reads this from
   * statement_requirements.supersedes_requirement_id once 012 is applied.
   */
  let supersessions: readonly unknown[] = []
  if (simulatedLiveEnabled()) {
    const { localSupersessions } = await import('@/lib/statement/devMode/localCanonical')
    supersessions = localSupersessions()
  }

  return NextResponse.json({
    submissions: listed.value,
    challenged,
    supersessions,
    schools: schools.ok ? schools.value : [],
    schoolsUnavailable: !schools.ok,
    catalog,
    localPreview,
    pendingPerSchool,
    // Only the groups with more than one member are worth a reviewer's
    // attention; a group of one is just a submission.
    duplicateGroups: Object.fromEntries(
      Object.entries(fingerprintGroups).filter(([, ids]) => ids.length > 1)),
  })
}

/**
 * One decision. Approve, reject, or mark duplicate.
 *
 * NOTHING IS PUBLISHED AUTOMATICALLY. Approval requires a label an
 * administrator typed, so no path exists on which a submission becomes a
 * catalog row without a person having looked at it.
 *
 * CORRECTED WORDING IS PUBLISHED, THE ORIGINAL IS KEPT. `promptText` here is
 * what goes into the catalog; the submission row is never overwritten, so the
 * audit trail survives a typo fix.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const id = optionalId(body.id)
  if (!id) return NextResponse.json({ error: 'Invalid submission id' }, { status: 400 })
  if (!isDecision(body.decision)) {
    return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })
  }

  // A label is required to publish, and is checked here as well as inside the
  // function so an obviously incomplete request costs no round trip.
  const label = optionalText(body.label, 200)
  if (body.decision === 'approved' && label === null) {
    return NextResponse.json({ error: 'A catalog label is required' }, { status: 400 })
  }
  const duplicateOf = optionalId(body.duplicateOf)
  if (body.decision === 'duplicate' && duplicateOf === null) {
    return NextResponse.json({ error: 'A duplicate target is required' }, { status: 400 })
  }

  const decided = await decideSubmission(guard.admin, {
    submissionId: id,
    decision: body.decision,
    reviewerId: guard.reviewerId,
    label,
    promptText: optionalText(body.promptText, 5000),
    duplicateOf,
    supersedes: optionalId(body.supersedes),
    deactivateOld: body.deactivateOld === true,
    reviewNote: optionalText(body.reviewNote, 2000),
  })

  if (decided.ok) return NextResponse.json(decided.value)

  // A settled submission is reported, not re-decided. Two administrators
  // clicking at once, or one retrying after a timeout, both land here.
  if (decided.reason === 'already-decided') {
    return NextResponse.json({ error: 'That submission was already reviewed.' }, { status: 409 })
  }
  if (decided.reason === 'not-found') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (decided.reason === 'invalid') {
    return NextResponse.json({ error: 'That decision could not be applied.' }, { status: 400 })
  }
  console.error('Admin statement prompts: decide failed —', decided.reason)
  return NextResponse.json({ error: 'Could not apply that decision' }, { status: 500 })
}

/**
 * Turn a reviewed submission into catalog data.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A POST AND NOT PART OF THE PATCH ABOVE
 * ---------------------------------------------------------------------------
 * PATCH records a DECISION about a submission: approved, rejected, duplicate.
 * This creates a ROW IN THE CATALOG. They are different acts with different
 * consequences and different payloads, and the owner asked for them to stay
 * separate -- pressing Approve must publish nothing. Two endpoints is how that
 * is true by construction rather than by a flag inside one.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE DECIDES ANYTHING ABOUT THE CONTENT
 * ---------------------------------------------------------------------------
 * Every canonical value arrives in the body, typed by an administrator who read
 * the submission. This route checks that the caller is an administrator, that
 * the ids are ids, and that a mode was chosen -- and then hands the payload to
 * the function. It does not read the submission's wording, its label or its
 * reported limits, and it does not fill a blank field from them: a fallback to
 * the applicant's value is how unreviewed text becomes reviewed data.
 *
 * THE SET IS NEVER GUESSED. `mode` is required, and 'existing-set' requires a
 * set id. A school with a set already might want another document in it or a
 * new set for a new cycle; those are different facts, so the administrator says
 * which and a missing answer is a 400 rather than a default.
 *
 * AND NOTHING BECOMES VISIBLE. The function writes is_active = false into both
 * rows, explicitly, whatever this body says -- see 20261015_017. Activation is a
 * separate owner action.
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
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const payload = body as Record<string, unknown>

  const id = optionalId(payload.id)
  if (!id) return NextResponse.json({ error: 'Invalid submission id' }, { status: 400 })

  /*
    WHICH KIND OF SUBMISSION THIS IS, READ FROM THE ROW AND NOT FROM THE BODY.

    The caller is an administrator, so this is not a privilege question -- it is
    a correctness one. A body that declared its own kind could ask for the
    report rules to be skipped, or for them to be applied to a submission that
    challenges nothing, and either way the rule would be decided by the request
    it is meant to constrain.
  */
  const submission = await readSubmissionForReview(guard.admin, id)
  if (!submission.ok) {
    if (submission.reason === 'not-found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    console.error('Admin statement prompts: submission read failed —', submission.reason)
    return NextResponse.json({ error: 'Could not read that submission' }, { status: 500 })
  }
  const isReport = submission.value.kind === 'prompt-change'
  const challengedId = submission.value.challengedRequirementId

  const changeAction = payload.changeAction
  if (isReport) {
    if (!isChangeAction(changeAction)) {
      return NextResponse.json({
        error: 'Choose whether this replaces the existing prompt or is an additional one.',
        code: 'change-action-required',
      }, { status: 400 })
    }
    // 012'S CHECK GUARANTEES THIS; re-read rather than assumed, because the
    // flag that selects the column may be off and a null would otherwise be
    // carried into a supersession naming nothing.
    if (challengedId === null) {
      return NextResponse.json({
        error: 'That report does not name the prompt it is about.',
        code: 'challenged-missing',
      }, { status: 400 })
    }
  } else if (changeAction !== undefined) {
    // A NEW PROMPT HAS NOTHING TO REPLACE. Accepting the word here would make
    // "replace" mean something different depending on the row it arrived with.
    return NextResponse.json({
      error: 'Only a changed-prompt report can replace an existing prompt.',
      code: 'not-a-report',
    }, { status: 400 })
  }

  /*
    THE 012 REFUSAL IS GONE, BECAUSE THE PREMISE WAS GONE.

    This used to refuse every replacement outright with "Replacing a prompt
    needs migration 012, which is not applied." 20261008_012 IS applied, and
    hardened -- Stage E step 17 measures its 26-column grant -- so the sentence
    was false and the refusal was unreachable capability, not safety. A guard
    whose stated reason is untrue is worse than no guard: the next reader
    believes it.

    WHAT REPLACED IT IS A CHECK ON BEHAVIOUR RATHER THAN A BELIEF ABOUT
    SCHEMA. The supersession is recorded by the promotion function itself
    (20261028_019A / 019B), which returns the id it linked. After the call
    succeeds, this route compares that id to the one it asked for and reports
    `supersedeError` when they disagree -- so a database still running
    20261015_017's function, which records nothing, is caught by its own silence
    instead of by a guess about which migrations ran.

    AND THE OLD WARNING NO LONGER APPLIES. It said a failed link would leave "a
    published replacement with the old prompt still offered beside it". Nothing
    this function writes is published: both rows are is_active = false, by the
    rule 017's header states and 018 keeps. A replacement whose link failed is
    inactive catalog data plus a visible error, and the challenged row is
    untouched -- recoverable, and visible rather than silent.
  */

  const mode = payload.mode
  if (mode !== 'new-set' && mode !== 'existing-set') {
    return NextResponse.json(
      { error: 'Choose whether to create a new set or add to an existing one' },
      { status: 400 },
    )
  }
  const setId = optionalId(payload.setId)
  if (mode === 'existing-set' && !setId) {
    return NextResponse.json({ error: 'Choose the set to add this document to' }, { status: 400 })
  }

  const requirement = typeof payload.requirement === 'object' && payload.requirement !== null
    ? payload.requirement as Record<string, unknown>
    : null
  if (requirement === null) {
    return NextResponse.json({ error: 'The requirement fields are missing' }, { status: 400 })
  }
  const set = typeof payload.set === 'object' && payload.set !== null
    ? payload.set as Record<string, unknown>
    : {}

  /*
    PUBLISH, OR MERELY PROMOTE.

    An administrator clicking Approve used to get a catalog row that no
    applicant could see, because publishing needs a verified status, a date and
    evidence -- and a student submission has no source URL to offer as
    evidence. Four separate steps stood between "yes, this is a real prompt"
    and anything happening.

    `publish` folds them into one act. The evidence it supplies is the
    administrator's own decision on THIS submission, recorded by id, which is
    the second kind of evidence migration 011 recognises. It is not a bypass:
    the row still carries a verified status, a date and something a person can
    point at, and the kind is stored so no reader mistakes it for a prompt
    checked against the school's own page.
  */
  /*
    AN OFFICIAL-SOURCE CLAIM NEEDS THE PAGE IT WAS CHECKED AGAINST, AND THIS IS
    THE ONLY LAYER THAT CAN TELL.

    20261029_023 made the catalog's own default honest: a new set created from a
    submission records 'admin-approved-submission' unless the payload says
    otherwise. An EXPLICIT 'official-source' still wins, deliberately, because
    an administrator who has read the school's page is the one case where the
    stronger claim is true -- but the function cannot tell a checked claim from
    an unchecked one, and a payload is a payload.

    SO THE EVIDENCE OF HAVING CHECKED IS WHAT MAKES THE CLAIM ADMISSIBLE: the
    URL of the page. That is the same thing 011's active_needs_evidence demands
    before such a set may go live, asked for at the moment the claim is made
    rather than weeks later at activation.

    THE FORM DOES NOT SEND evidence_kind AT ALL, so this refuses nothing an
    administrator can do through the screen. It closes the hand-crafted request
    that would otherwise use the one preserved path to put a false
    'official-source' on a prompt nobody checked.
  */
  const claimedKind = typeof set.evidence_kind === 'string' ? set.evidence_kind.trim() : ''
  const claimedUrl = typeof set.source_url === 'string' ? set.source_url.trim() : ''
  if (mode === 'new-set' && claimedKind === 'official-source' && claimedUrl === '') {
    return NextResponse.json({
      error: 'An official-source claim needs the school page it was checked against. '
        + 'Give the source URL, or leave the evidence for the catalog to record.',
      code: 'official-source-needs-url',
    }, { status: 400 })
  }

  const publish = payload.publish === true
  const evidence: Record<string, unknown> = publish
    ? {
      verification_status: 'verified',
      verified_on: new Date().toISOString().slice(0, 10),
      evidence_kind: 'admin-approved-submission',
      evidence_submission_id: id,
    }
    : {}

  const { data, error } = await guard.admin.rpc(
    'promote_statement_submission_to_requirement',
    {
      p_submission_id: id,
      // THE REVIEWER IS THE VERIFIED SESSION, never a body field. A payload
      // naming its own reviewer would let one administrator file a decision
      // under another's name.
      p_reviewer: guard.reviewerId,
      p_mode: mode,
      p_requirement: requirement,
      // THE EVIDENCE RIDES THE CREATE. Writing the row first and patching it a
      // moment later would leave a window in which it claims to be verified
      // with nothing behind it -- the state the constraint exists to forbid.
      p_set: { ...set, ...evidence },
      p_set_id: mode === 'existing-set' ? setId : null,
    },
  )
  if (error) {
    console.error('Admin statement prompts: promotion failed —', error.code, error.message)
    return NextResponse.json({ error: 'Could not create the requirement' }, { status: 500 })
  }

  const result = (data ?? {}) as Record<string, unknown>
  if (result.ok !== true) {
    // THE FUNCTION'S OWN WORD, mapped to a sentence. Each one names the field
    // or the choice that needs attention rather than reporting "failed".
    const reason = String(result.reason ?? 'unknown')
    const message = PROMOTION_MESSAGES[reason] ?? 'That submission could not be promoted.'
    return NextResponse.json({ error: message, code: reason }, { status: 400 })
  }

  /*
    THE PROVENANCE, READ BACK FROM THE FUNCTION RATHER THAN ASSUMED.

    20261029_023 records which submission a requirement came from and returns
    the id it wrote. A deployment still running 20261028_022 or earlier records
    nothing and returns no such key -- and a requirement with no origin reads as
    the school's own published wording, which is the strongest claim in the
    system and the exact falsehood D3 exists to remove.

    SO A SILENT FUNCTION IS A REPORTED ERROR, like the supersession below. The
    row is created either way and is inactive either way; what this refuses to
    do is let an administrator believe the attribution was recorded when it was
    not. Same mechanism, same reason: a check on behaviour, never a guess about
    which migrations ran.
  */
  const recordedOrigin = typeof result.originSubmissionId === 'string'
    ? result.originSubmissionId
    : null
  const provenanceError = recordedOrigin === id
    ? null
    : 'The requirement was created, but the catalog did not record which submission '
      + 'it came from \u2014 so it would be presented to applicants as the school\u2019s '
      + 'own wording. Migration 20261029_023 is not applied.'

  /*
    PUBLISHING IS A SECOND ACT, AND IT IS CHECKED.

    simulateActivation re-reads the row that was just written and applies the
    same shortfall test production's CHECK constraint would. A row this handler
    somehow left short is refused here rather than published, and the
    administrator is told which part is missing.

    LOCAL ONLY. Production activation remains an owner action, and that is a
    rule rather than a gap: 011 IS applied, the evidence really is written, and
    the one step that makes catalog data applicant-visible still may not be
    taken by an HTTP request from an administrator's browser.
  */
  let active = false
  let publishError: string | null = null
  if (publish) {
    if (!simulatedLiveEnabled()) {
      /*
        011 IS APPLIED, SO THE EVIDENCE WAS REALLY WRITTEN -- AND ACTIVATION IS
        STILL NOT THIS ROUTE'S TO DO.

        The old sentence here said publishing "needs migration 011, which is not
        applied", which stopped being true and made a working path read as a
        broken one. What `publish` actually does in production is supply the
        evidence that rides the create: a verified status, today's date, the
        kind, and this submission's id -- all of it stored by the RPC above, and
        all of it required by 011's active_needs_evidence check.

        RELEASING IT REMAINS AN OWNER ACTION, DELIBERATELY. Activation is the
        one step that makes catalog data applicant-visible, and no HTTP request
        from an administrator's browser may take it: that is the whole shape of
        this feature. So the row is created complete and inactive, and this says
        so plainly rather than reporting a migration that ran weeks ago.
      */
      publishError = 'Created with publication evidence and left inactive. '
        + 'Releasing it to applicants is a separate owner action.'
    } else {
      // DYNAMICALLY IMPORTED, like the other two local-only call sites in this
      // file: the module must not be reachable from a production build.
      const { simulateActivation } = await import('@/lib/statement/devMode/localCanonical')
      const activated = simulateActivation(String(result.setId))
      if (activated.ok) active = activated.isActive
      else {
        publishError = (activated.missing ?? []).join('; ')
          || 'That entry could not be published.'
      }
    }
  }

  /*
    THE SUPERSESSION, RECORDED AFTER THE REPLACEMENT EXISTS AND NOT BEFORE.

    Order matters in one direction only: a record pointing at a row that was
    never created would take the old prompt away and offer nothing in its
    place. The reverse -- a replacement created and the link not recorded --
    leaves both prompts offered, which is visibly wrong rather than silently
    wrong, and is reported as `supersedeError` instead of being swallowed.

    'add-additional' RECORDS NOTHING, which is the whole content of that
    choice: both prompts stay offered and the old row is untouched.
  */
  let supersedeError: string | null = null
  let superseded: string | null = null
  if (isReport && changeAction === 'replace' && challengedId !== null) {
    if (simulatedLiveEnabled()) {
      // DYNAMICALLY IMPORTED, like the other local-only call sites in this file:
      // the module must not be reachable from a production build. The local
      // store is the stand-in for the database the real path now uses.
      const { recordLocalSupersession } = await import('@/lib/statement/devMode/localCanonical')
      const recorded = recordLocalSupersession({
        requirementId: challengedId,
        supersededBy: String(result.requirementId),
        submissionId: id,
        reviewerId: guard.reviewerId,
      })
      if (recorded.ok) superseded = challengedId
      else supersedeError = recorded.reason
    } else {
      /*
        READ FROM THE FUNCTION, NOT INFERRED, AND NOT WRITTEN HERE.

        The supersession is one of the rows the promotion creates, so it belongs
        in the same transaction as the requirement it points at -- a second
        statement from this route could half-succeed. 20261028_022 writes it and
        returns the id it linked.

        A SILENT FUNCTION IS A REPORTED ERROR. If the deployed function still
        predates D2 it records nothing and returns no `supersedes`, and this
        says so instead of reporting a replacement that did not happen. That is
        the capability check the stale 012 refusal above was pretending to be.

        NOT 019A OR 019B. Those two were generated on top of 20261028_018 and
        each carries D3 as well, with the challenged-requirement check placed
        AFTER the inserts, where a refusal leaves an orphan set and requirement
        behind. The migration that is in force is 20261028_022; applying either
        019 over it would revert that ordering.
      */
      const linked = typeof result.supersedes === 'string' ? result.supersedes : null
      if (linked === challengedId) superseded = linked
      else {
        supersedeError = 'The replacement was created but the catalog did not record '
          + 'what it replaces. Migration 20261028_022 is not applied.'
      }
    }
  }

  return NextResponse.json({
    setId: result.setId,
    requirementId: result.requirementId,
    created: result.created,
    // SAID PLAINLY, so the screen does not have to assume.
    isActive: active,
    publishError,
    /** The row that stopped being offered, when one did. Never inferred. */
    superseded,
    supersedeError,
    /** Null when the catalog recorded where this requirement came from. */
    provenanceError,
  })
}

/** One sentence per refusal the function can return. */
const PROMOTION_MESSAGES: Readonly<Record<string, string>> = {
  'not-found': 'That submission no longer exists.',
  'already-promoted': 'That submission is already in the catalog.',
  // 20261028_021 ADDED 'duplicate' TO THE FUNCTION'S REFUSAL LIST, so this
  // sentence has to name it. A duplicate points at the submission that is the
  // real one, and that is the row to promote.
  'not-promotable':
    'A rejected, withdrawn or duplicate submission cannot be promoted. '
    + 'A duplicate names the submission that is the real one \u2014 promote that.',
  'invalid-mode': 'Choose whether to create a new set or add to an existing one.',
  'set-required': 'Choose the set to add this document to.',
  'set-not-found': 'That set does not belong to this school.',
  // 20261028_022. The report names a requirement that is not this school's, or
  // no longer exists. 20261028_020A now adds the foreign key 012 left out, so
  // the "no longer exists" half is refused at insert time and the function's
  // own check is what catches a cross-school report.
  'challenged-not-found':
    'The prompt this report is about is not one of this school\u2019s listed requirements.',
  'invalid-label': 'Give the document a label.',
  'invalid-prompt-text': 'The prompt wording cannot be empty.',
  'invalid-document-type': 'Choose one of the nine document types.',
  'invalid-reviewer': 'Your session could not be identified. Sign in again.',
  'not-authorized': 'You are not authorized to publish requirements.',
}

/**
 * DEVELOPMENT ONLY: switch a locally promoted set on or off for preview.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ENDPOINT EXISTS AND WHY IT CANNOT EXIST IN PRODUCTION
 * ---------------------------------------------------------------------------
 * Promotion deliberately creates an INACTIVE set, because activation is an
 * owner decision and not a side effect of filing catalog data. That is correct,
 * and it leaves one thing unreviewable before launch: what an applicant
 * actually sees once a promoted requirement goes live. This endpoint answers
 * that, and nothing else.
 *
 * IT IS GATED ON simulatedLiveEnabled(), WHICH IS NODE_ENV. A deployed build
 * answers 404 here however it is addressed and by whoever addresses it -- there
 * is no flag, no header and no query parameter that reaches this code in
 * production. Real activation stays what it was: an owner action against a
 * reviewed row.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT TOUCH PRODUCTION, AND NOT BECAUSE IT PROMISES NOT TO
 * ---------------------------------------------------------------------------
 * It calls simulateActivation()/simulateDeactivation(), which rewrite one field
 * in local-review/dev-canonical.json. That module imports node:fs and nothing
 * else -- no Supabase client, no service key, no rpc. The 63 imported
 * production sets are not in that file, so a production set id resolves to
 * 'not-found'; there is no id for which this writes a database row, because
 * there is no code path from here to a database.
 *
 * AND IT ENFORCES PRODUCTION'S OWN ACTIVATION CONDITION. 20261002_005 refuses
 * an active set that is not verified with a source URL and a verified date. A
 * local preview of something production would refuse to publish would be a
 * preview of nothing, so the same three checks apply -- and a refusal names
 * which of them is missing rather than saying "it does not qualify".
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  // THE GATE FIRST, BEFORE AUTHENTICATION EVEN RUNS. In production this route
  // is indistinguishable from a path that was never written.
  if (!simulatedLiveEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const payload = body as Record<string, unknown>

  const action = payload.action
  if (action !== 'activate' && action !== 'deactivate' && action !== 'edit') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
  const local = await import('@/lib/statement/devMode/localCanonical')

  /*
   * EDITING AN ALREADY-PROMOTED ENTRY.
   *
   * ON THIS HANDLER RATHER THAN A FOURTH METHOD, because it is the same act:
   * change one row in local-review/dev-canonical.json. The dev gate above
   * already covers it, which is the property that matters -- there is no
   * version of this that exists in a deployed build.
   *
   * IT IS NOT POST. POST promotes: it CREATES catalog data from a submission
   * and is the path that would exist in production through the definer
   * function. This changes data that is already there, locally, and must not be
   * mistaken for a second promotion.
   *
   * NOTHING HERE CAN ACTIVATE. updateLocalCanonicalEntry() does not read
   * is_active from either payload; activation stays the separate button.
   */
  if (action === 'edit') {
    const requirementId = optionalId(payload.requirementId)
    if (!requirementId) {
      return NextResponse.json({ error: 'Invalid requirement id' }, { status: 400 })
    }
    const requirement = typeof payload.requirement === 'object' && payload.requirement !== null
      ? payload.requirement as Record<string, unknown>
      : null
    if (requirement === null) {
      return NextResponse.json({ error: 'The requirement fields are missing' }, { status: 400 })
    }
    const set = typeof payload.set === 'object' && payload.set !== null
      ? payload.set as Record<string, unknown>
      : {}

    const edited = local.updateLocalCanonicalEntry({ requirementId, set, requirement })
    if (!edited.ok) {
      if (edited.reason === 'not-found') {
        return NextResponse.json({
          error: 'That catalog entry was not created locally, so it cannot be edited here.',
          code: 'not-found',
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
        error: PROMOTION_MESSAGES[edited.reason] ?? 'Those edits could not be saved.',
        code: edited.reason,
      }, { status: 400 })
    }
    return NextResponse.json({
      setId: edited.setId,
      requirementId: edited.requirementId,
      // SAID PLAINLY: saving changed the entry and released nothing.
      isActive: local.localPreviewFor(edited.requirementId)?.isActive === true,
      localOnly: true,
    })
  }

  const setId = optionalId(payload.setId)
  if (!setId) return NextResponse.json({ error: 'Invalid set id' }, { status: 400 })
  const outcome = action === 'activate'
    ? local.simulateActivation(setId)
    : local.simulateDeactivation(setId)

  if (!outcome.ok) {
    if (outcome.reason === 'not-found') {
      // A PRODUCTION SET LANDS HERE, and the wording says why rather than
      // leaving a reviewer to wonder whether it half-worked.
      return NextResponse.json({
        error: 'That set was not created locally, so it cannot be previewed locally.',
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
