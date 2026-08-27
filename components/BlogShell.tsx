'use client'

import { useSidebarCollapsed } from '@/lib/SidebarContext'

/**
 * Offsets blog content for the app sidebar. Kept as a thin client wrapper so
 * the article itself stays a server component and renders into the initial
 * HTML — which is what search crawlers read.
 */
export default function BlogShell({ children }: { children: React.ReactNode }) {
  const { sidebarCollapsed } = useSidebarCollapsed()
  return (
    <div className={`transition-all duration-300 ${sidebarCollapsed ? 'lg:pl-20' : 'lg:pl-64'} pt-16 lg:pt-0`}>
      {children}
    </div>
  )
}
