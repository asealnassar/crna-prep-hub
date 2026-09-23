import { NextResponse } from 'next/server'
import { regimeFor } from '@/lib/consent/policy'

export const dynamic = 'force-dynamic'

/**
 * Which consent regime applies to this visitor.
 *
 * WHY AN ENDPOINT RATHER THAN THE LAYOUT. Reading headers() in app/layout.tsx
 * would make every page in the site dynamic and throw away the static and
 * SSG rendering the school and blog pages depend on. One tiny uncached request
 * from the banner costs far less than that.
 *
 * THE COUNTRY IS NEVER STORED. It is read from the edge header, turned into
 * one of two words, and forgotten. Phase 3 deliberately stores no IP address
 * and nothing derived from one; this endpoint does not change that.
 *
 * WHEN THE HEADER IS ABSENT — local development, or any host that does not set
 * it — the answer is opt_in, which is the cautious direction.
 */
export async function GET(request: Request) {
  const country =
    request.headers.get('x-vercel-ip-country') ??
    request.headers.get('cf-ipcountry') ??
    null

  return NextResponse.json(
    { regime: regimeFor(country) },
    { headers: { 'Cache-Control': 'private, no-store' } }
  )
}
