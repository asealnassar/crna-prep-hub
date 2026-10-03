import { notFound, redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { statementStudioAccess, statementStudioMode } from '@/lib/statement/studioGate'
import { isDraftId } from '@/lib/statement/draft/http'
import { readDraft } from '@/lib/statement/draft/draftRepo'
import { listSchoolPickerOptions } from '@/lib/statement/draft/schoolPicker'
import { readDraftPromptStatus } from '@/lib/statement/draft/submissionRepo'
import { originOf, promptStatusLabel } from '@/lib/statement/draft/promptSubmission'
import { promptSubmissionsEnabled } from '@/lib/statement/draft/rollout'
import {
  PASTE_PREVIEW_PARAM, pastePreviewAllowed, reviewPreviewRequested,
} from '@/lib/statement/draft/pastePreview'
import { generalSample, schoolSample } from '@/lib/statement/draft/reviewSample'
import {
  analysisActionFor, analysisAvailability, canAnalyzeStatement,
} from '@/lib/statement/draft/reviewAccess'
// SERVER ONLY: this module imports node:crypto. A server component may use it;
// nothing a client component imports may.
import { analysisFingerprint } from '@/lib/statement/draft/analysisFingerprint'
import { analysisFor } from '@/lib/statement/draft/analysisRepo'
import { parseRequirementSnapshot } from '@/lib/statement/requirements/snapshot'
import { draftProvenance } from '@/lib/statement/requirements/provenance'
import { verifiedProvenance } from '@/lib/statement/draft/submissionRepo'
import { analysisCacheEnabled } from '@/lib/statement/draft/rollout'
import StatementStudioClient from '../components/StatementStudioClient'

/**
 * Personal Statement Studio: one draft, open for editing.
 *
 * EVERY GATE BELOW IS UNCHANGED from the read-only shell this replaced -- the
 * Studio gate, the session, the caller-scoped client, the id check, the
 * indistinguishable 404 and the generic failure. What changed is only the last
 * line: the persisted draft is handed to a client editor instead of being
 * printed as text.
 *
 * A SERVER COMPONENT STILL. The gate runs before any markup or client bundle
 * exists, so a blocked visitor is refused by the server rather than by code they
 * could have read. The editor is a client child and receives the draft as a
 * prop: THE BROWSER NEVER RE-FETCHES IT. The initial read already happened here,
 * with the caller's own JWT, and asking for it again from the browser would be a
 * second answer to a question already settled.
 *
 * Upload, analysis, version history, delete and navigation guards are still
 * absent; /personal-statement continues to serve users in the meantime.
 *
 * THE SCHOOL OPTIONS ARE LOADED HERE, NOT IN THE BROWSER, for the same reason
 * the draft is: the gate runs on the server, so a browser-side directory fetch
 * would be the one Studio data path not behind it. The editor receives them as
 * a prop and renders no control for them yet.
 *
 * The read is made with the caller's own JWT, so RLS decides what they may open.
 * A draft that belongs to someone else is not "forbidden" here; it simply does
 * not exist, which is the same answer as a draft id that was never issued.
 */

/**
 * Per-request by construction: the gate reads the session cookie, so there is
 * nothing to prerender. Declared rather than inferred, because inferring it
 * means Next attempts a static render first, and that attempt surfaces in every
 * build as an "API authentication failed" line from the gate refusing a request
 * that has no cookies.
 */
export const dynamic = 'force-dynamic'

/**
 * What a reader is told when the draft could not be read for any reason other
 * than absence. A fixed string: the repository's `detail` describes PostgREST or
 * a malformed stored row, and neither belongs in front of a person.
 */
const UNREADABLE = 'This draft could not be opened.'

export default async function StatementStudioPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const auth = await authenticateRequest()
  const access = statementStudioAccess({
    isAdmin: isAdminEmail(auth?.email),
    isAuthenticated: auth !== null,
    mode: statementStudioMode(),
  })
  if (!access.allowed && access.reason === 'sign-in') redirect('/login')
  // `|| !auth` is not only for the type narrowing. If the gate is ever changed
  // to admit an unauthenticated visitor, this refuses to render a draft for one.
  if (!access.allowed || !auth) notFound()

  const token = await readAccessToken()
  if (!token) notFound()

  // The anon key plus the caller's bearer token: a caller-scoped client, so
  // every statement below is subject to the same RLS the API is. The service
  // role key is deliberately absent -- a page has no business bypassing RLS.
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  // BEFORE THE QUERY. Postgres casts this value to uuid, so a malformed segment
  // reaching the database is a 22P02 cast error -- a 500 for what is plainly a
  // bad URL. The same predicate the draft API uses, so the two cannot drift.
  const { id } = await params
  if (!isDraftId(id)) notFound()

  const read = await readDraft(db, id)
  if (!read.ok) {
    // Absent and invisible are one answer, which is the whole point of reading
    // through RLS. Anything else is this site failing, not the draft missing:
    // reporting a database outage as "your draft does not exist" would invite a
    // reader to conclude they had lost work. It throws instead, which Next
    // serves as a generic 500. That is a deliberate difference from
    // app/resume-studio/[id]/page.tsx, which collapses both into notFound().
    if (read.reason === 'not-found') notFound()
    throw new Error(UNREADABLE)
  }
  const draft = read.value

  /**
   * THE SCHOOL OPTIONS, READ LAST AND ON PURPOSE.
   *
   * AFTER EVERY ACCESS CHECK. The gate, the session, the token, the id check
   * and the draft read have all already succeeded above, so a blocked visitor
   * and a caller asking after somebody else's draft never reach this line --
   * this query cannot be used to probe the directory from behind the Studio
   * gate. It uses the SAME caller-scoped client the draft was read with; there
   * is no service-role client on this page.
   *
   * THREE COLUMNS, NEVER A SCHOOL ROW. listSchoolPickerOptions returns
   * { id, name, locationState } and nothing else -- see schoolPicker.ts for why
   * getPublicSchools() is deliberately not reused here.
   *
   * A FAILURE DOES NOT COST THE APPLICANT THEIR ESSAY. The draft is already in
   * hand, so a directory that cannot be read becomes an EXPLICIT flag rather
   * than an exception or a silent empty list: the editor opens, the essay is
   * editable and autosave works, and the picker that will eventually render
   * these knows the difference between "no schools exist" and "we could not
   * ask". Collapsing those two would show an applicant an empty dropdown and
   * let them conclude their programme is not supported.
   */
  const schools = await listSchoolPickerOptions(db)

  // WHERE THIS DRAFT'S QUESTION CAME FROM, worded on the server.
  //
  // GATED, AND SKIPPED ENTIRELY WHEN OFF: until the submission migrations are
  // applied there is no prompt_submission_id column to select, so with the flag
  // unset not one extra query is issued and the editor receives null -- exactly
  // the behaviour it had before this prop existed.
  //
  // A FAILED READ IS NOT AN ERROR PAGE. The draft is already in hand and its
  // snapshot is what the editor renders; losing the badge costs a label, not
  // the applicant's work, so a refusal degrades to null rather than throwing.
  let promptNotice: string | null = null
  if (promptSubmissionsEnabled()) {
    const status = await readDraftPromptStatus(db, draft.id)
    if (status.ok) {
      promptNotice = promptStatusLabel({
        origin: originOf({
          promptId: draft.promptId,
          promptSubmissionId: status.value === null ? null : status.value.submissionId,
        }),
        status: status.value === null ? null : status.value.status,
      })
    }
  }

  // A DEVELOPMENT-ONLY VISUAL PREVIEW of the analyser's results.
  //
  // READ AFTER THE GATE, exactly as the paste preview is: everything above has
  // already refused a visitor who is not an administrator, and NODE_ENV comes
  // from the process, so a deployed build cannot be addressed into it.
  //
  // THE SAMPLES ARE BUILT HERE AND ONLY HERE. With the flag off nothing is
  // constructed and nothing is sent to the browser -- and either way no model
  // is called, no draft is written and the usage ledger is never touched,
  // because building a sample is three constants and a validator.
  const params_ = await searchParams
  const analysisPreview = pastePreviewAllowed({
    nodeEnv: process.env.NODE_ENV,
    isAdmin: isAdminEmail(auth.email),
    requested: reviewPreviewRequested(params_[PASTE_PREVIEW_PARAM]),
  })

  // ---- the draft's structured requirement, if it has one -----------------
  //
  // PARSED HERE, ON THE SERVER, and handed down as plain data. The STORED
  // snapshot only: effectiveSnapshot() would also project an old draft's prompt
  // columns into this shape, and passing that would give drafts created before
  // this feature a document header and a question count their authors never
  // chose. null is the right answer for them, and null is what the editor's
  // single-prompt panel has always rendered.
  //
  // null ON EVERY UNMIGRATED DEPLOYMENT: draftRepo does not select the column
  // unless STATEMENT_REQUIREMENTS is on, so there is nothing to parse.
  const requirement = parseRequirementSnapshot(draft.requirementSnapshot)

  // ---- does the saved copy still match what the school publishes? ---------
  //
  // ASKED ON THE SERVER, AND NOT OF THE SNAPSHOT. The snapshot carries its own
  // `verification` object, and statement_drafts grants the owner UPDATE on
  // their own row -- so an applicant can write `status: 'verified'` into it and
  // suppress any warning keyed on it. The verdict below is computed by reading
  // the catalog with the caller's own client and comparing every attributed
  // field, so it cannot be set from the browser.
  //
  // THE SNAPSHOT IS STILL DISPLAYED EITHER WAY. It is the historical record of
  // what this applicant started from, and losing it would be worse than
  // labelling it. What changes is only whether the panel presents it as the
  // school's current requirement or as a saved copy that no longer matches.
  //
  // ONE EXTRA READ, ONLY FOR A DRAFT THAT HAS A REQUIREMENT, and skipped
  // entirely while the rollout flag is off -- requirementProvenance returns
  // without querying in that case, because the tables do not exist.
  const requirementVerdict = requirement === null
    ? null
    : await draftProvenance(
      db,
      { promptId: draft.promptId, promptText: draft.promptText },
      requirement,
      verifiedProvenance,
    )

  // ---- what the analyser may offer, decided on the server -----------------
  //
  // THE PLAN IS CHECKED HERE ONLY TO DECIDE WHAT TO SHOW. The endpoint checks it
  // again and is the actual control; this exists so a Free member sees why the
  // button is unavailable instead of a button that fails.
  const analysisAllowed = canAnalyzeStatement(auth.tier)

  // WHAT CAN HONESTLY BE OFFERED. Without storage there is no deduplication,
  // so outside development the analyser is refused rather than silently
  // charging again for identical work.
  const analysisAvailable = analysisAvailability({
    cacheEnabled: analysisCacheEnabled(),
    nodeEnv: process.env.NODE_ENV,
  })

  // AND WHETHER THIS EXACT WORK IS ALREADY DONE. Content-addressed: the
  // fingerprint covers the essay and the saved prompt snapshot and not the
  // title, so a rename offers "View previous analysis" and an edit offers
  // "Analyze updated draft".
  //
  // GATED. With the cache off nothing queries statement_analyses -- the table
  // does not exist until 20261002_004 is applied -- and the editor offers a
  // fresh analysis, which is exactly today's behaviour.
  //
  // THE SAME INPUTS THE ROUTE USES, AND THAT IS NOT OPTIONAL. This key is what
  // the editor looks a stored analysis up by; the route is what stored it. An
  // earlier version of this call omitted `requirement` entirely, so for a
  // requirement-backed draft the two computed different keys and the editor
  // could never find its own analysis -- "View previous analysis" would have
  // been permanently absent for exactly the drafts this feature adds.
  const currentFingerprint = analysisFingerprint({
    essay: draft.essay,
    promptText: draft.promptText,
    schoolId: draft.schoolId,
    promptId: draft.promptId,
    statedMaxWords: draft.statedMaxWords,
    requirement,
    requirementAuthentic: requirementVerdict?.authentic === true,
  })
  let priorAnalysis = null
  if (analysisAllowed && analysisCacheEnabled()) {
    // ASKED FOR BY FINGERPRINT, so restoring previously analysed content finds
    // its own result rather than the most recent one. Analyse A, edit to B,
    // analyse B, undo back to A: this returns A's analysis, which was paid for
    // and is still stored.
    const stored = await analysisFor(db, draft.id, currentFingerprint)
    if (stored.ok && stored.value !== null) {
      priorAnalysis = {
        result: {
          review: stored.value.review,
          revision: stored.value.revision,
          words: stored.value.words,
          overLimit: stored.value.overLimit,
          statedMaxWords: stored.value.statedMaxWords,
          provenance: stored.value.provenance,
        },
        // 'view' when the stored work is about exactly what is on screen.
        action: analysisActionFor({
          storedFingerprint: stored.value.fingerprint,
          currentFingerprint,
        }),
      }
    }
  }

  // The persisted draft, in full, straight into the editor. Its `revision` is
  // what seeds autosave -- the client never invents one.
  return (
    <StatementStudioClient
      draft={draft}
      schools={schools.ok ? schools.value : []}
      schoolsUnavailable={!schools.ok}
      promptNotice={promptNotice}
      analysisAllowed={analysisAllowed}
      analysisAvailable={analysisAvailable}
      priorAnalysis={priorAnalysis}
      sampleReviews={analysisPreview
        ? { general: generalSample(), school: schoolSample() }
        : null}
      requirement={requirement}
      requirementAuthentic={requirementVerdict?.authentic === true}
    />
  )
}
