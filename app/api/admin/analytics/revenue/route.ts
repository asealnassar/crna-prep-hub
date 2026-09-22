import { handleSection } from '@/lib/analytics/server/handler'
import { buildRevenue } from '@/lib/analytics/server/sections/revenue'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return handleSection(request, buildRevenue)
}
