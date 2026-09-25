'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import MessagesModal from './MessagesModal'
import Sidebar from './Sidebar'
import { SidebarProvider, useSidebarCollapsed } from '@/lib/SidebarContext'

// Pages that intentionally have no sidebar (landing/auth pages, and /admin/*
// which has its own separate top nav bar built earlier).
const HIDDEN_SIDEBAR_PATHS = ['/', '/login', '/signup', '/forgot-password', '/reset-password', '/privacy']

function ClientProvidersInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)
      setLoading(false)
    }
    
    getUser()

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  const isAdmin = user?.email === 'asealnassar@gmail.com'
  const { setSidebarCollapsed } = useSidebarCollapsed()

  const showSidebar = pathname && !HIDDEN_SIDEBAR_PATHS.includes(pathname) && !pathname.startsWith('/admin')

  // The sidebar renders immediately in its logged-out state rather than waiting
  // on the auth check. That puts the public nav links into the server-rendered
  // HTML, where crawlers can follow them — previously the whole nav only
  // appeared after JavaScript ran, so those internal links carried no SEO
  // weight. Auth-only items appear once `user` resolves.
  return (
    <>
      {showSidebar && (
        <Sidebar isLoggedIn={!!user} userEmail={user?.email || ''} isAdmin={isAdmin} onCollapsedChange={setSidebarCollapsed} />
      )}
      {children}
      {/* KEYED BY ACCOUNT, deliberately.

          Signing in as a second account without signing out first replaces the
          session and emits SIGNED_IN with no SIGNED_OUT, so `user` goes from A
          to B without ever being null and React would otherwise KEEP the same
          modal instance -- leaving A's conversations on screen, A's unread
          count in the badge, and A's Realtime channel subscribed under A's
          token, all under B's session.

          Keying on the id makes React tear the instance down and build a new
          one: A's state is discarded, A's refresh scheduler is cancelled, A's
          channel is removed, and B's inbox loads on a fresh subscription.

          user.id, never `user`. onAuthStateChange fires on TOKEN_REFRESHED and
          hands back a NEW user object with the SAME id; keying on the object
          would remount roughly hourly and refetch the whole inbox each time. */}
      {!loading && user && <MessagesModal key={user.id} userEmail={user.email || ''} isAdmin={isAdmin} />}
    </>
  )
}

export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <ClientProvidersInner>{children}</ClientProvidersInner>
    </SidebarProvider>
  )
}
