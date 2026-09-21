import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/apiAuth'
import { serviceClient } from '@/lib/interviewUsage'
import { bindGrantToSession } from '@/lib/interviewSession'

/**
 * Links a freshly started interview to the session row that holds it.
 *
 * Called once, immediately after the browser has persisted the opening turn.
 * From then on the grant id never has to leave the server again: resume takes
 * a session id the applicant owns and looks the grant up from it.
 *
 * This is the ONLY endpoint that accepts a grant id from the client, and it can
 * only ever point one at a session both rows already belong to. It charges
 * nothing, reserves no turn, and calls no model.
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequest()
    if (!auth) {
      return NextResponse.json({ error: 'You must be signed in.' }, { status: 401 })
    }

    const admin = serviceClient()
    if (!admin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const body = await request.json().catch(() => null)
    const grantId = body?.grantId
    const sessionId = body?.sessionId
    if (typeof grantId !== 'string' || typeof sessionId !== 'string' || !grantId || !sessionId) {
      return NextResponse.json({ error: 'A grant id and a session id are required.' }, { status: 400 })
    }

    const result = await bindGrantToSession(admin, grantId, sessionId, auth.userId)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json({ ok: true, alreadyBound: result.alreadyBound })
  } catch (error: any) {
    console.error('Interview bind error:', error)
    return NextResponse.json({ error: 'Could not link this interview.' }, { status: 500 })
  }
}
