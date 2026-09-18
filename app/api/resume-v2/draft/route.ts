import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'
import { BLOCKED_BODY, UNAUTHORIZED_BODY, resumeV2Access } from '@/lib/resume/gate'
import { resumeBuilderMode } from '@/lib/resume/rollout'
import { MAX_BODY_BYTES, parseCommand, planDuplicate } from '@/lib/resume/draft/commands'
import type { DraftCommand } from '@/lib/resume/draft/commands'
import { decideCreateResume, decideFinalize } from '@/lib/resume/entitlement'
import { parsePatches } from '@/lib/resume/studio/parse'
import { applyPatches } from '@/lib/resume/studio/patch'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import {
  factSheetForEntryField, factSheetForPosition, factSheetForSummary,
} from '@/lib/resume/ai/factSheet'
import { narrativeTextOf } from '@/lib/resume/ai/request'
import { verifyGrounding } from '@/lib/resume/ai/verify'
import type { ResumeV2 } from '@/lib/resume/model/types'
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Caller = { userId: string; db: SupabaseClient; tier: string }

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
  // `auth` is non-null here -- the 401 above returns first -- so the gate's
  // sign-in branch is unreachable from a route handler. It is still handled
  // rather than asserted away, because an assertion here would be a 404 for a
  // signed-out caller in v2 mode, and that is the one refusal that should say
  // plainly that signing in would help.
  const access = resumeV2Access({
    isAdmin: isAdminEmail(auth.email),
    isAuthenticated: true,
    mode: resumeBuilderMode(),
  })
  if (!access.allowed) {
    return NextResponse.json(
      access.reason === 'sign-in' ? UNAUTHORIZED_BODY : BLOCKED_BODY,
      { status: access.status }
    )
  }

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
  return { userId: auth.userId, db, tier: auth.tier }
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

/** A tier refusal: seen, named, and actionable — unlike the V2 dev gate's 404. */
function refused(decision: { code: string; message: string }): NextResponse {
  return NextResponse.json({ error: decision.code, message: decision.message }, { status: 403 })
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

/**
 * GET ?id= returns ONE resume in full; GET with no id lists summaries.
 *
 * The full read exists so a dashboard card can draw the applicant's own resume
 * as its thumbnail, with the same renderer the export uses. It is the read the
 * Studio page already performs when that resume is opened -- same repository
 * function, same caller-scoped client, so RLS decides what may be read and
 * somebody else's resume is simply not found. Nothing about it is cached or
 * stored; a card asks when it is scrolled to.
 */
export async function GET(request: NextRequest) {
  const admitted = await admit()
  if (admitted instanceof NextResponse) return admitted
  const { db, userId } = admitted

  const id = request.nextUrl.searchParams.get('id')
  if (id !== null) {
    if (!UUID.test(id)) return NextResponse.json({ error: 'malformed-payload' }, { status: 400 })
    const read = await readResume(db, id)
    if (!read.ok) return failed(read)
    if (!read.value.resume) return NextResponse.json({ error: 'not-found' }, { status: 404 })
    return NextResponse.json({ resume: read.value.resume })
  }

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
  const { db, userId, tier } = caller

  switch (command.kind) {
    case 'create': {
      // V1's cap lived in a landing-page conditional, so navigating straight to
      // /create walked past it. Here the count is taken server-side and the UI
      // gate is a courtesy. Two simultaneous creates could both pass, costing
      // at worst one extra resume; this is a product limit, not a security
      // boundary, and the alternative is a count inside the create function
      // with the limit hard-coded in SQL as a second source of truth.
      const existing = await listResumes(db, userId)
      if (!existing.ok) return failed(existing)
      const room = decideCreateResume({ tier, currentCount: existing.value.length })
      if (!room.allowed) return refused(room)

      const resume = createResume({
        id: randomUUID(),
        userId,
        title: command.title,
        sectionIds: DEFAULT_SECTION_TYPES.map(() => randomUUID()),
        now: now(),
      })
      const created = await createResumeRows(db, resume)
      if (!created.ok) return failed(created)
      return NextResponse.json({ id: created.value.id, revision: created.value.revision }, { status: 201 })
    }

    case 'duplicate': {
      // A copy is a resume. Counting it is the difference between a limit and
      // a suggestion.
      const existing = await listResumes(db, userId)
      if (!existing.ok) return failed(existing)
      const room = decideCreateResume({ tier, currentCount: existing.value.length })
      if (!room.allowed) return refused(room)

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
      // Marking a resume complete is the other half of the monetisation gate.
      // Only the forward direction is gated: someone whose plan lapsed may
      // still move a finished resume back to draft, which costs nothing and
      // leaves them able to keep working.
      if (command.kind === 'set-status' && command.status === 'complete') {
        const entitled = decideFinalize(tier)
        if (!entitled.allowed) return refused(entitled)
      }

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

    case 'patch': {
      // Read first, then apply. The client's patches name fields and ids; the
      // document they are applied to is one the server read for itself, so
      // nothing the browser sent is ever stored verbatim.
      const read = await readResume(db, command.id)
      if (!read.ok) return failed(read)
      const current = read.value.resume
      if (!current) return NextResponse.json({ error: 'not-found' }, { status: 404 })

      // Field names mean different things in different sections, so the parser
      // needs to know each addressed section's type before it can check them.
      const typeOf = new Map(current.sections.map((s) => [s.id, s.type]))
      const parsed = parsePatches(command.patches, (sectionId) => typeOf.get(sectionId) ?? null)
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

      // "Unverified proposals never persist." A proposal was verified when it
      // was offered, but that was a different request against a resume that may
      // since have changed -- and a client can call this route directly with
      // any text it likes. So an accepted proposal is checked again, here,
      // against a fact sheet built from the row just read.
      const unverified = firstUnverifiedAccept(current, parsed.patches)
      if (unverified) {
        return NextResponse.json(
          { error: 'ungrounded-proposal', message: unverified },
          { status: 422 }
        )
      }

      const updated = applyPatches(current, parsed.patches, { now: now() })
      const saved = await saveResume(db, updated, command.expectedRevision, userId)
      if (!saved.ok) return failed(saved)
      return NextResponse.json({ revision: saved.value.revision, applied: parsed.patches.length })
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

/**
 * Re-verifies every accepted AI proposal in a batch.
 *
 * Returns the first refusal's message, or null when everything traces to a
 * supplied fact. The existing text is passed as already-present so rewriting a
 * bullet the applicant already has does not read as a fresh invention.
 */
function firstUnverifiedAccept(resume: ResumeV2, patches: readonly StudioPatch[]): string | null {
  for (const patch of patches) {
    if (patch.op === 'ai-accept-summary') {
      const section = resume.sections.find((s) => s.id === patch.sectionId)
      if (!section || section.type !== 'summary') continue
      const verdict = verifyGrounding(patch.text, factSheetForSummary(resume), {
        existingText: section.text.accepted,
      })
      if (!verdict.ok) return verdict.violations[0].message
      continue
    }

    if (patch.op === 'ai-accept-field') {
      const section = resume.sections.find((s) => s.id === patch.sectionId)
      if (!section) continue
      const sheet = factSheetForEntryField(section, patch.entryId, patch.field)
      // No sheet means the field is not one AI may write. Refusing is right:
      // the only way to reach here is a client bypassing the editor.
      if (!sheet) return 'That field cannot be written by the assistant.'
      const verdict = verifyGrounding(patch.text, sheet, {
        existingText: narrativeTextOf(section, patch.entryId, patch.field),
      })
      if (!verdict.ok) return verdict.violations[0].message
      continue
    }

    if (patch.op === 'ai-accept-bullet') {
      const section = resume.sections.find((s) => s.id === patch.sectionId)
      if (!section || (section.type !== 'critical_care' && section.type !== 'other_clinical')) continue
      const position = section.positions.find((p) => p.id === patch.positionId)
      if (!position) continue
      const verdict = verifyGrounding(patch.text, factSheetForPosition(position, section.type), {
        existingText: position.bullets[patch.index]?.accepted,
      })
      if (!verdict.ok) return verdict.violations[0].message
    }
  }
  return null
}
