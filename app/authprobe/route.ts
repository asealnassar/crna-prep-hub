import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { canViewDrafts } from '@/lib/lessonAccess'

export const dynamic = 'force-dynamic'

// Temporary diagnostic. Delete once draft access is confirmed working.
export async function GET() {
  const report: Record<string, unknown> = {}
  try {
    const jar = await cookies()
    const all = jar.getAll()
    report.cookieCount = all.length
    report.authCookies = all
      .map((c) => c.name)
      .filter((n) => /^sb-.*-auth-token(\.\d+)?$/.test(n))
    report.allCookieNames = all.map((c) => c.name)
  } catch (e) {
    report.cookieError = String(e)
  }
  report.canViewDrafts = await canViewDrafts()
  return NextResponse.json(report)
}
