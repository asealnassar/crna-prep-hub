import { handleSection } from '@/lib/analytics/server/handler'
import { buildOperations } from '@/lib/analytics/server/sections/operations'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return handleSection(request, buildOperations)
}
