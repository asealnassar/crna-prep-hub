import { NextResponse } from 'next/server'
import { rangeFrom, requireAdminReader } from '@/lib/analytics/server/handler'
import { buildRevenue } from '@/lib/analytics/server/sections/revenue'

export const dynamic = 'force-dynamic'

/**
 * Revenue reads Stripe, so it takes one extra parameter the other sections do
 * not: `refresh=1` bypasses the five-minute cache. Switching tabs or changing
 * the window reuses the history already fetched; pressing Refresh goes back to
 * Stripe.
 */
export async function GET(request: Request) {
  const guard = await requireAdminReader()
  if (!guard.ok) return guard.response

  const force = new URL(request.url).searchParams.get('refresh') === '1'

  try {
    const payload = await buildRevenue(guard.reader, rangeFrom(request), force)
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error: any) {
    console.error('Analytics revenue failed:', error?.message)
    return NextResponse.json(
      { error: 'Could not build this section' },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
    )
  }
}
