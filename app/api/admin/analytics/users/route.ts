import { NextResponse } from 'next/server'
import { requireAdminReader } from '@/lib/analytics/server/handler'
import { buildUserActivity, type UserActivitySort } from '@/lib/analytics/server/userActivity'

export const dynamic = 'force-dynamic'

const SORTS: readonly UserActivitySort[] = ['recent', 'signup', 'actions', 'interviews', 'email']

/**
 * One page of the member list, searched and sorted on the server.
 *
 * The page this replaces fetched every account and every question row into the
 * browser to build the same table. Here the browser asks for 25 rows and gets
 * 25 rows.
 */
export async function GET(request: Request) {
  const guard = await requireAdminReader()
  if (!guard.ok) return guard.response

  const params = new URL(request.url).searchParams
  const sortParam = params.get('sort') ?? ''
  const sort = (SORTS as readonly string[]).includes(sortParam) ? (sortParam as UserActivitySort) : 'recent'

  try {
    const result = await buildUserActivity(guard.reader, {
      search: params.get('search') ?? '',
      tier: params.get('tier') ?? '',
      sort,
      page: Number(params.get('page') ?? '1') || 1,
      pageSize: Number(params.get('pageSize') ?? '25') || 25,
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error: any) {
    console.error('Analytics member list failed:', error?.message)
    return NextResponse.json(
      { error: 'Could not build the member list' },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } }
    )
  }
}
