import { handleSection } from '@/lib/analytics/server/handler'
import { buildProduct } from '@/lib/analytics/server/sections/product'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return handleSection(request, buildProduct)
}
