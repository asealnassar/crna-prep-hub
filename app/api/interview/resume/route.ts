import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { serviceClient } from '@/lib/interviewUsage'
import { abandonGrant, findGrantBySession } from '@/lib/interviewSession'
import { blockerMessage, evaluateResume } from '@/lib/interview/resume'
import type { GrantRow, SessionRow } from '@/lib/interview/resume'

/**
 * Resuming an interview that is already in progress.
 *
 * Deliberately NOT part of /api/interview. That route charges entitlements,
 * reserves turns and calls the model; a read path living inside it would be one
 * careless edit away from doing all three. Nothing here charges, reserves or
 * generates — a resumed interview is rebuilt entirely from what was already
 * persisted and paid for.
 *
 *   GET    — is this session resumable? No mutation of any kind.
 *   POST   — resume it. Also no mutation: repeating it is safe under retry.
 *   DELETE — give it up. Marks the grant abandoned, never completed.
 */

const DENIED = 'This interview is no longer available to resume.'

/**
 * Reads both rows and applies every rule. Ownership is verified against the
 * session AND the grant, with the service role, because RLS protects the
 * browser's own queries but not an id it puts in a URL.
 */
async function load(sessionId: unknown, userId: string) {
  if (typeof sessionId !== 'string' || !sessionId) {
    return { error: { status: 400, message: 'A session id is required.' } }
  }
  const admin = serviceClient()
  if (!admin) return { error: { status: 500, message: 'Server configuration error' } }

  const { data: session, error } = await admin
    .from('interview_sessions')
    .select('id, user_id, conversation, engine_state, pending_turn')
    .eq('id', sessionId)
    .maybeSingle()

  // A malformed uuid makes Postgres reject the cast. Treated as "not found",
  // like every other failure to produce a row the caller owns.
  if (error && error.code !== 'PGRST116') {
    console.error('Resume: session lookup failed:', error.message)
    return { error: { status: 404, message: DENIED } }
  }

  const grant = session ? await findGrantBySession(admin, sessionId, userId) : null
  const verdict = evaluateResume(
    (session as SessionRow | null) ?? null,
    (grant as GrantRow | null) ?? null,
    userId
  )
  return { admin, grant, verdict }
}

export async function GET(request: Request) {
  try {
    const auth = await authenticateRequest()
    if (!auth) return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })

    const sessionId = new URL(request.url).searchParams.get('sessionId')
    const loaded = await load(sessionId, auth.userId)
    if (loaded.error) {
      return NextResponse.json({ error: loaded.error.message }, { status: loaded.error.status })
    }

    const { verdict } = loaded
    if (!verdict.resumable) {
      // 200 with resumable:false — "you cannot resume this" is a normal answer
      // to a normal question, not an error, and every blocker reads the same
      // from outside so session ids cannot be probed.
      return NextResponse.json({ resumable: false, reason: verdict.reason, message: blockerMessage(verdict.reason) })
    }

    // The summary is what the Resume card renders. No transcript, no state:
    // the applicant has not asked to resume yet.
    return NextResponse.json({
      resumable: true,
      summary: {
        mode: verdict.state.mode,
        type: verdict.state.type,
        customTopic: verdict.state.customTopic,
        primaryQuestionNumber: verdict.state.primaryQuestionNumber,
        maxPrimaryQuestions: verdict.state.maxPrimaryQuestions,
        atCheckpoint: verdict.pendingTurn !== null,
      },
    })
  } catch (error: any) {
    console.error('Resume status error:', error)
    return NextResponse.json({ error: 'Could not check this interview.' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateRequest()
    if (!auth) return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })

    const body = await request.json().catch(() => null)
    const loaded = await load(body?.sessionId, auth.userId)
    if (loaded.error) {
      return NextResponse.json({ error: loaded.error.message }, { status: loaded.error.status })
    }

    const { admin, grant, verdict } = loaded
    if (!verdict.resumable) {
      return NextResponse.json(
        { resumable: false, reason: verdict.reason, message: blockerMessage(verdict.reason) },
        { status: 409 }
      )
    }

    // Nothing is written. A POST that mutated a counter would not be safely
    // retryable, and the applicant's browser retries on any network hiccup --
    // so resuming twice has to be indistinguishable from resuming once.
    return NextResponse.json({
      resumable: true,
      sessionId: body.sessionId,
      // The browser gets its grant id back ONLY because the server has already
      // proved this session is theirs and this grant authorizes it.
      grantId: grant?.id ?? null,
      messages: verdict.messages,
      state: verdict.state,
      pendingTurn: verdict.pendingTurn,
    })
  } catch (error: any) {
    console.error('Resume error:', error)
    return NextResponse.json({ error: 'Could not resume this interview.' }, { status: 500 })
  }
}

/**
 * "Discard and start new".
 *
 * Sets abandoned_at rather than completed, so an interview the applicant walked
 * away from is never counted as a finished mock. No entitlement is refunded:
 * the model calls behind it have already been made.
 */
export async function DELETE(request: Request) {
  try {
    const auth = await authenticateRequest()
    if (!auth) return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })

    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (typeof sessionId !== 'string' || !sessionId) {
      return NextResponse.json({ error: 'A session id is required.' }, { status: 400 })
    }

    const admin = serviceClient()
    if (!admin) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })

    const grant = await findGrantBySession(admin, sessionId, auth.userId)
    // Nothing to abandon is success: the applicant asked for a state, and that
    // state already holds.
    if (!grant?.id) return NextResponse.json({ ok: true })

    await abandonGrant(admin, grant.id, auth.userId)
    return NextResponse.json({ ok: true })
  } catch (error: any) {
    console.error('Abandon error:', error)
    return NextResponse.json({ error: 'Could not end this interview.' }, { status: 500 })
  }
}
