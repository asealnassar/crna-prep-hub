import { notFound, redirect } from 'next/navigation'
import { statementDbClient } from '@/lib/statement/devMode/guardedClient'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { statementStudioAccess, statementStudioMode } from '@/lib/statement/studioGate'
import { listDrafts } from '@/lib/statement/draft/draftRepo'
import { listSchoolPickerOptions } from '@/lib/statement/draft/schoolPicker'
import { promptSubmissionsEnabled } from '@/lib/statement/draft/rollout'
import {
  PASTE_PREVIEW_PARAM, fixturesPreviewRequested, pastePreviewAllowed,
  pastePreviewRequested, requirementsPreviewRequested,
} from '@/lib/statement/draft/pastePreview'
import { loadLocalReviewCatalog } from '@/lib/statement/requirements/localReviewCatalog'
import LibraryClient from './components/LibraryClient'

/**
 * Personal Statement Studio: the draft library.
 *
 * A SERVER COMPONENT, for the same reason /statement-studio/[id] is one -- the
 * gate runs before any Studio markup or client bundle exists, so a blocked
 * visitor is refused by the server rather than by code they could have read. It
 * also does the initial list, so the library opens with the drafts already in
 * hand rather than flashing an empty shell while a fetch resolves.
 *
 * SUMMARIES ONLY. listDrafts() returns StatementDraftSummary -- id, title,
 * revision and the two timestamps -- a distinct type from StatementDraft with no
 * essay field to forget to drop. No statement body is read here, sent to the
 * browser, or present in the RSC payload.
 *
 * The list is made with the caller's own JWT, so RLS decides whose drafts these
 * are. The explicit user_id filter inside the repository sits alongside that,
 * not instead of it.
 *
 * WHAT THIS STEP IS NOT. No editing, no autosave, no upload, no analysis, no
 * delete, no schools or prompts. Creating a draft is the one write, and the
 * browser makes it against the gated draft API like any other client.
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
 * What a reader is told when the library itself could not be read. A fixed
 * string: the repository's `detail` is a Postgres code and message about rows
 * that are somebody's statements, and it belongs in neither a page nor a log.
 */
const UNREADABLE = 'Your statement drafts could not be loaded.'

export default async function StatementStudioLibraryPage({
  searchParams,
}: {
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
  // to admit an unauthenticated visitor, this refuses to list drafts for one.
  if (!access.allowed || !auth) notFound()

  const token = await readAccessToken()
  if (!token) notFound()

  // The anon key plus the caller's bearer token: a caller-scoped client, so the
  // list below is subject to the same RLS the API is. The service role key is
  // deliberately absent -- a page has no business bypassing RLS.
  //
  // THE CALLER GOES WITH IT, for the reason the editor page gives at length:
  // simulated live has no auth.uid() and the local stores scope on this. The
  // list here passes auth.userId explicitly so it did not depend on it, but a
  // client that knows who is asking cannot quietly return nobody's rows.
  const db = statementDbClient(token, {
    userId: auth.userId,
    isAdmin: isAdminEmail(auth.email),
  })

  const listed = await listDrafts(db, auth.userId)
  // listDrafts has no 'not-found': an applicant with no drafts gets an empty
  // array, which is the empty state and not an error. So any refusal here is
  // this site failing, and it throws -- Next serves that as a generic 500 -- with
  // a fixed message that never carries `listed.detail`.
  if (!listed.ok) throw new Error(UNREADABLE)

  // THE SCHOOL DIRECTORY IS NOT LOAD-BEARING, and this is the one place that
  // can be decided. Three columns -- id, name, locationState -- read with the
  // same caller-scoped client, after the gate, so an unadmitted visitor never
  // reaches it.
  //
  // A FAILURE HERE DOES NOT TAKE THE LIBRARY DOWN. The drafts are already in
  // hand and starting a general statement needs no school at all, so a refusal
  // is passed along as a flag rather than thrown: the applicant loses the
  // school-specific path and keeps everything else.
  //
  // UNAVAILABLE IS NOT EMPTY, and the two are passed separately because they
  // read as the same thing and are not. Telling somebody "no schools are
  // listed" because a connection dropped would have them conclude this product
  // knows of no CRNA programmes. `detail` is a Postgres message and is not read.
  const schools = await listSchoolPickerOptions(db)

  // A DEVELOPMENT-ONLY VISUAL PREVIEW of the paste-a-prompt screens.
  //
  // READ AFTER THE GATE, deliberately: everything above has already refused a
  // visitor who is not an administrator, so this cannot be the thing that
  // admits anybody. It decides only whether some markup is drawn for somebody
  // the page has already admitted.
  //
  // NODE_ENV IS READ FROM THE PROCESS, so a deployed build cannot enter preview
  // however it is addressed; the query parameter is the only browser-controlled
  // input and is the one that is not sufficient on its own.
  //
  // IT IS NOT PASSED TO THE SUBMISSION PATH. `submissionsEnabled` below is
  // still the rollout flag and nothing else, so preview changes what is
  // visible and never what is possible.
  const params = await searchParams
  const pastePreview = pastePreviewAllowed({
    nodeEnv: process.env.NODE_ENV,
    isAdmin: isAdminEmail(auth.email),
    requested: pastePreviewRequested(params[PASTE_PREVIEW_PARAM]),
  })

  // A DEVELOPMENT-ONLY VISUAL PREVIEW of the school writing-requirement
  // checklists, decided exactly as the paste preview above is: after the gate,
  // NODE_ENV from the process, and an explicit query parameter that is not
  // sufficient on its own. It changes what is drawn and never what is possible
  // -- the fixtures are TypeScript constants, so there is nothing for it to
  // read, write or charge.
  const requirementsPreview = pastePreviewAllowed({
    nodeEnv: process.env.NODE_ENV,
    isAdmin: isAdminEmail(auth.email),
    requested: requirementsPreviewRequested(params[PASTE_PREVIEW_PARAM]),
  })

  // The eight hand-built SHAPE fixtures, at their own address now that
  // ?preview=requirements shows the real catalog. Same gate, same three
  // conditions; only the screen differs.
  const fixturesPreview = pastePreviewAllowed({
    nodeEnv: process.env.NODE_ENV,
    isAdmin: isAdminEmail(auth.email),
    requested: fixturesPreviewRequested(params[PASTE_PREVIEW_PARAM]),
  })

  // THE 63 IMPORTED SETS, READ FROM A LOCAL FILE ON THE SERVER.
  //
  // READ ONLY INSIDE THIS BRANCH, so the file is never touched -- and the
  // catalog never exists in a response -- unless all three preview conditions
  // have already passed. `requirementsPreview` is false in production by
  // construction (NODE_ENV), so this expression is `null` there whatever the
  // address says.
  //
  // IT IS NOT A FALLBACK FOR THE FIXTURES AND THE FIXTURES ARE NOT A FALLBACK
  // FOR IT. A missing payload yields null and the client says so plainly;
  // quietly showing eight worked examples to somebody who asked to review 63
  // real schools would be the worst outcome available, because it looks like
  // an answer.
  const reviewCatalog = requirementsPreview ? loadLocalReviewCatalog() : null

  // Newest edit first, exactly as the repository ordered it. The client does not
  // re-sort: one ordering, decided by the index that serves the query.
  return (
    <LibraryClient
      drafts={listed.value}
      schools={schools.ok ? schools.value : []}
      schoolsUnavailable={!schools.ok}
      submissionsEnabled={promptSubmissionsEnabled()}
      pastePreview={pastePreview}
      requirementsPreview={requirementsPreview}
      fixturesPreview={fixturesPreview}
      reviewCatalog={reviewCatalog}
    />
  )
}
