import { NextResponse } from 'next/server'
import { rangeFrom, requireAdminReader } from '@/lib/analytics/server/handler'
import { buildAcquisition } from '@/lib/analytics/server/sections/acquisition'

export const dynamic = 'force-dynamic'

/**
 * Acquisition reads Stripe as well as the traffic tables, so it takes the same
 * `refresh=1` parameter Revenue does: switching tabs reuses the payment history
 * already fetched, pressing Refresh goes back to Stripe.
 */
export async function GET(request: Request) {
  const guard = await requireAdminReader()
  if (!guard.ok) return guard.response

  const force = new URL(request.url).searchParams.get('refresh') === '1'

  try {
    const payload = await buildAcquisition(guard.reader, rangeFrom(request), force)
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error: any) {
    console.error('Analytics acquisition failed:', error?.message)
    return NextResponse.json(
      { error: 'Could not build this section' },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
    )
  }
}
