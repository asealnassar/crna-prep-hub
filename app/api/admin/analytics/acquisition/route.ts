import { handleSection } from '@/lib/analytics/server/handler'
import { buildAcquisition } from '@/lib/analytics/server/sections/acquisition'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return handleSection(request, buildAcquisition)
}
