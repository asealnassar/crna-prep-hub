import { notFound, redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { statementStudioAccess, statementStudioMode } from '@/lib/statement/studioGate'
import { isDraftId } from '@/lib/statement/draft/http'
import { readDraft } from '@/lib/statement/draft/draftRepo'

/**
 * Personal Statement Studio: one draft, opened read-only.
 *
 * THIS IS A SHELL. It proves the route, the gate, the id check and the server
 * read, and it renders the draft as text. There is no editor, no autosave, no
 * upload and no analysis yet, and nothing here talks to the draft HTTP API from
 * the browser. Those arrive as their own steps; /personal-statement continues to
 * serve users in the meantime.
 *
 * A SERVER COMPONENT, with no client child. The gate runs before any markup
 * exists, so a blocked visitor is refused by the server rather than by code they
 * could have read: nothing about the Studio ships to someone who cannot use it.
 * Because the shell is not interactive, this step ships no client bundle at all.
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

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <p className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        Internal preview, read only. Editing, autosave, upload and “Analyze this
        Draft” are not wired up yet.
      </p>

      <h1 className="text-2xl font-bold text-slate-900">{draft.title}</h1>

      {/*
        The timestamp is printed as stored. Formatting it on the server picks the
        server's locale and timezone for someone else's clock, and formatting it
        on the client would need a client component this step does not have.
      */}
      <p className="mt-2 text-xs text-slate-500">
        Revision {draft.revision} · {draft.essay.length} characters · saved{' '}
        {draft.updatedAt}
      </p>

      {/*
        whitespace-pre-wrap, so the author's paragraphs survive. The text is
        interpolated, which React escapes; dangerouslySetInnerHTML has no place
        anywhere near a document somebody pasted in.
      */}
      {draft.essay.length > 0 ? (
        <article className="mt-6 whitespace-pre-wrap rounded-xl border border-gray-300 bg-white px-4 py-4 text-sm leading-relaxed text-gray-800">
          {draft.essay}
        </article>
      ) : (
        <p className="mt-6 rounded-xl border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-slate-500">
          This draft is empty.
        </p>
      )}
    </main>
  )
}
