import { notFound, redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { statementStudioAccess, statementStudioMode } from '@/lib/statement/studioGate'
import { listDrafts } from '@/lib/statement/draft/draftRepo'
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

export default async function StatementStudioLibraryPage() {
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
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  const listed = await listDrafts(db, auth.userId)
  // listDrafts has no 'not-found': an applicant with no drafts gets an empty
  // array, which is the empty state and not an error. So any refusal here is
  // this site failing, and it throws -- Next serves that as a generic 500 -- with
  // a fixed message that never carries `listed.detail`.
  if (!listed.ok) throw new Error(UNREADABLE)

  // Newest edit first, exactly as the repository ordered it. The client does not
  // re-sort: one ordering, decided by the index that serves the query.
  return <LibraryClient drafts={listed.value} />
}
