import { handleSection } from '@/lib/analytics/server/handler'
import { buildOverview } from '@/lib/analytics/server/sections/overview'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return handleSection(request, buildOverview)
}
