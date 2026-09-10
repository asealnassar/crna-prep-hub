import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { BLOCKED_BODY, resumeV2Access } from '@/lib/resume/gate'
import { MAX_BODY_BYTES, parseCommand, planDuplicate } from '@/lib/resume/draft/commands'
import type { DraftCommand } from '@/lib/resume/draft/commands'
import { DEFAULT_SECTION_TYPES, createResume, setStatus, setTitle } from '@/lib/resume/model/resume'
import {
  createResumeRows, deleteResume, listResumes, readResume, saveResume,
} from '@/lib/resume/repo/resumeRepo'
import type { RepoResult } from '@/lib/resume/repo/resumeRepo'

/**
 * The Resume V2 dashboard's only server surface.
 *
 * GET lists the caller's V2 resumes. POST carries every mutation as an
 * `action`, matching how the rest of this codebase's routes are shaped.
 *
 * THREE THINGS THIS ROUTE IS RESPONSIBLE FOR, and nothing else:
 *
 * 1. The gate. V2 is unreleased. Every response below the gate is a 404 for
 *    anyone who is not an admin — see lib/resume/gate.ts for why 404 and not
 *    403. This check is not a formality the page already did: the page is a
 *    different request and could be bypassed entirely.
 *
 * 2. A caller-scoped database client. The anon key plus the caller's own JWT,
 *    so RLS and the SECURITY INVOKER functions see the real user. There is
 *    deliberately no service-role client anywhere in this file — the one resume
 *    route that had one was retired in 123981b for exactly that reason.
 *
 * 3. Translating repository outcomes into status codes. Every decision that is
 *    not an HTTP concern lives in lib/resume and is unit-tested there.
 */

/** Ids and timestamps are generated here so the pure planners stay deterministic. */
const now = () => new Date().toISOString()

type Caller = { userId: string; db: SupabaseClient }

/**
 * Authenticates, applies the gate, and builds the caller-scoped client.
 * Returns a NextResponse when the request must not proceed.
 */
async function admit(): Promise<Caller | NextResponse> {
  const auth = await authenticateRequest()
  // No session at all is an ordinary 401: every route in the app reveals that
  // much, and an admin whose session expired should be told to sign in again.
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // A signed-in non-admin learns nothing: as far as they can tell, no such
  // route exists.
  const access = resumeV2Access({ isAdmin: isAdminEmail(auth.email) })
  if (!access.allowed) return NextResponse.json(BLOCKED_BODY, { status: access.status })

  const token = await readAccessToken()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )
  return { userId: auth.userId, db }
}

/** Repository reasons that mean "the caller is out of date", not "we broke". */
function statusForReason(reason: string): number {
  switch (reason) {
    case 'stale-revision': return 409
    case 'not-found':
    case 'wrong-schema-version': return 404
    case 'already-exists': return 409
    case 'section-conflict':
    case 'malformed-payload': return 400
    case 'not-authenticated': return 401
    default: return 500
  }
}

function failed(result: Extract<RepoResult<unknown>, { ok: false }>): NextResponse {
  const status = statusForReason(result.reason)
  // `detail` carries a Postgres code and message only — never row content —
  // and is logged rather than returned so nothing about the row can leak.
  if (status >= 500) console.error('resume-v2 draft route:', result.reason, result.detail)
  return NextResponse.json(
    {
      error: result.reason,
      ...(typeof result.storedRevision === 'number' ? { storedRevision: result.storedRevision } : {}),
    },
    { status }
  )
}

export async function GET() {
  const admitted = await admit()
  if (admitted instanceof NextResponse) return admitted
  const { db, userId } = admitted

  const list = await listResumes(db, userId)
  if (!list.ok) return failed(list)

  // Only the columns the dashboard renders. The section bodies — where the
  // applicant's actual history lives — are never part of a list response.
  return NextResponse.json({
    resumes: list.value.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      template: row.template_id,
      revision: Number(row.revision),
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    })),
  })
}

export async function POST(request: NextRequest) {
  const admitted = await admit()
  if (admitted instanceof NextResponse) return admitted

  // The cap is applied to the raw text, before any parsing: an oversized body
  // costs one length check rather than a JSON parse.
  const raw = await request.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request too large.' }, { status: 413 })
  }

  let body: unknown
  try {
    body = raw === '' ? null : JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Malformed JSON.' }, { status: 400 })
  }

  const parsed = parseCommand(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  return runCommand(admitted, parsed.command)
}

async function runCommand(caller: Caller, command: DraftCommand): Promise<NextResponse> {
  const { db, userId } = caller

  switch (command.kind) {
    case 'create': {
      const resume = createResume({
        id: randomUUID(),
        userId,
        title: command.title,
        sectionIds: DEFAULT_SECTION_TYPES.map(() => randomUUID()),
        now: now(),
      })
      // NOTE: no resume-count limit is applied. Blueprint decision 1 (the Free
      // limit) is undecided and its enforcement is Phase 8's job; this is the
      // seam it will use.
      const created = await createResumeRows(db, resume)
      if (!created.ok) return failed(created)
      return NextResponse.json({ id: created.value.id, revision: created.value.revision }, { status: 201 })
    }

    case 'duplicate': {
      const read = await readResume(db, command.sourceId)
      if (!read.ok) return failed(read)
      const source = read.value.resume
      // RLS already scoped the read, so a missing row and someone else's row
      // are the same answer here — and both must stay the same answer.
      if (!source) return NextResponse.json({ error: 'not-found' }, { status: 404 })

      const plan = planDuplicate({
        source,
        actingUserId: userId,
        newId: randomUUID(),
        sectionIds: source.sections.map(() => randomUUID()),
        now: now(),
      })
      if (!plan.ok) {
        // 'not-owner' should be unreachable behind RLS; if it ever fires,
        // something upstream is wrong and the caller still learns nothing.
        if (plan.reason === 'not-owner') console.error('resume-v2 duplicate: ownership mismatch below RLS')
        return NextResponse.json({ error: 'not-found' }, { status: 404 })
      }

      const created = await createResumeRows(db, plan.resume)
      if (!created.ok) return failed(created)
      return NextResponse.json({ id: created.value.id, revision: created.value.revision }, { status: 201 })
    }

    case 'rename':
    case 'set-status': {
      const read = await readResume(db, command.id)
      if (!read.ok) return failed(read)
      const current = read.value.resume
      if (!current) return NextResponse.json({ error: 'not-found' }, { status: 404 })

      const at = now()
      const updated =
        command.kind === 'rename'
          ? setTitle(current, command.title, at)
          : setStatus(current, command.status, at)

      // `expectedRevision` is the client's, not the row we just read: the point
      // of the compare-and-swap is to refuse a client that is behind, and
      // passing what we just read would defeat it every time.
      const saved = await saveResume(db, updated, command.expectedRevision, userId)
      if (!saved.ok) return failed(saved)
      return NextResponse.json({ revision: saved.value.revision })
    }

    case 'delete': {
      // No pre-read: RLS makes a delete of someone else's resume affect zero
      // rows, and reading first would only add a way to probe for existence.
      const removed = await deleteResume(db, command.id)
      if (!removed.ok) return failed(removed)
      return NextResponse.json({ ok: true })
    }
  }
}
