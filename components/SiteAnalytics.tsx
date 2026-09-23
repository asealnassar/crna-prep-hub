'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { isTrackingEnabled, trackPageView } from '@/lib/analytics/tracking/client'

/**
 * One page view per page, including the ones Next.js renders without a reload.
 *
 * THE PROBLEM THIS SOLVES. The TikTok pixel in app/layout.tsx calls ttq.page()
 * once, when the document loads. Every navigation after that — every school
 * page, every lesson, the whole site once a visitor is inside it — happens in
 * the client router and is invisible to it. Watching `usePathname` sees all of
 * them.
 *
 * AND THE OPPOSITE PROBLEM. An effect that fires on every render, or twice
 * under Strict Mode, would count one page several times. The guard is in
 * trackPageView: it ignores a path identical to the one just recorded.
 *
 * This component renders nothing and never suspends. It is mounted beside
 * ClientProviders rather than inside it, so no existing component changes.
 */
export default function SiteAnalytics() {
  const pathname = usePathname()

  useEffect(() => {
    if (!isTrackingEnabled() || !pathname) return
    trackPageView(pathname)
  }, [pathname])

  return null
}
