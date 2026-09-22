import { NextResponse } from 'next/server'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'
import { resolveRange, type ResolvedRange } from '../range'
import type { SectionPayload } from '../types'
import { createReader, serviceClient, type Reader } from './reader'

/**
 * The guard every analytics endpoint runs, and the range every one of them
 * parses.
 *
 * Authentication, then authorization, and only then a service-role client —
 * the same order the other admin routes use. A layout cannot protect a route
 * handler, so each of these carries its own check.
 *
 * Responses are aggregates. The only personal data any of them returns is the
 * email column of the member list, which is the admin page's existing
 * behaviour; no transcript, resume, statement, message or question text is
 * read by any section.
 */

export type SectionBuilder = (reader: Reader, range: ResolvedRange) => Promise<SectionPayload>

function deny(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function requireAdminReader(): Promise<{ ok: true; reader: Reader } | { ok: false; response: NextResponse }> {
  const auth = await authenticateRequest()
  if (!auth) return { ok: false, response: deny(401, 'Unauthorized') }
  if (!isAdminEmail(auth.email)) return { ok: false, response: deny(403, 'Forbidden') }

  const admin = serviceClient()
  if (!admin) {
    console.error('Analytics: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return { ok: false, response: deny(500, 'Server configuration error') }
  }
  return { ok: true, reader: createReader(admin) }
}

export function rangeFrom(request: Request): ResolvedRange {
  const params = new URL(request.url).searchParams
  return resolveRange({
    preset: params.get('range'),
    from: params.get('from'),
    to: params.get('to'),
  })
}

export async function handleSection(request: Request, build: SectionBuilder): Promise<NextResponse> {
  const guard = await requireAdminReader()
  if (!guard.ok) return guard.response

  try {
    const payload = await build(guard.reader, rangeFrom(request))
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error: any) {
    // The message, never the object: an error can carry query fragments.
    console.error('Analytics section failed:', error?.message)
    return deny(500, 'Could not build this section')
  }
}
