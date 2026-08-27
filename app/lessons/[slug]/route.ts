import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import path from 'path'
import { canViewDrafts, isDraftSlug } from '@/lib/lessonAccess'

export const dynamic = 'force-dynamic'

/**
 * Serves a draft lesson document. The files sit in content/lessons/ rather than
 * public/ precisely so this check cannot be bypassed by requesting the asset.
 * Unauthorised requests get a 404 rather than a 403 — no reason to confirm the
 * lesson exists to someone who cannot read it.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params

  if (!isDraftSlug(slug) || !(await canViewDrafts())) {
    return new NextResponse('Not found', { status: 404 })
  }

  try {
    const file = path.join(process.cwd(), 'content', 'lessons', `${slug}.html`)
    const html = await readFile(file, 'utf-8')
    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    })
  } catch (error) {
    console.error('Draft lesson read failed:', error)
    return new NextResponse('Not found', { status: 404 })
  }
}
