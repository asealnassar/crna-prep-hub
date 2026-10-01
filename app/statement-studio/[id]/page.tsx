import { notFound, redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { statementStudioAccess, statementStudioMode } from '@/lib/statement/studioGate'
import { isDraftId } from '@/lib/statement/draft/http'
import { readDraft } from '@/lib/statement/draft/draftRepo'
import { listSchoolPickerOptions } from '@/lib/statement/draft/schoolPicker'
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
}: {
  params: Promise<{ id: string }>
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

  // The persisted draft, in full, straight into the editor. Its `revision` is
  // what seeds autosave -- the client never invents one.
  return (
    <StatementStudioClient
      draft={draft}
      schools={schools.ok ? schools.value : []}
      schoolsUnavailable={!schools.ok}
    />
  )
}
