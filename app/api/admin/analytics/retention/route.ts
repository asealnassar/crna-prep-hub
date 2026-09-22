import { handleSection } from '@/lib/analytics/server/handler'
import { buildRetention } from '@/lib/analytics/server/sections/retention'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return handleSection(request, buildRetention)
}
