'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import MessagesModal from './MessagesModal'
import Sidebar from './Sidebar'
import { SidebarProvider, useSidebarCollapsed } from '@/lib/SidebarContext'

// Pages that intentionally have no sidebar (landing/auth pages, and /admin/*
// which has its own separate top nav bar built earlier).
const HIDDEN_SIDEBAR_PATHS = ['/', '/login', '/signup', '/forgot-password', '/reset-password']

function ClientProvidersInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      console.log('ClientProviders - Current user:', user?.email)
      setUser(user)
      setLoading(false)
    }
    
    getUser()

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      console.log('Auth state changed:', session?.user?.email)
      setUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  const isAdmin = user?.email === 'asealnassar@gmail.com'
  const { setSidebarCollapsed } = useSidebarCollapsed()

  console.log('ClientProviders render - user:', user?.email, 'isAdmin:', isAdmin)

  if (loading) return <>{children}</>

  const showSidebar = pathname && !HIDDEN_SIDEBAR_PATHS.includes(pathname) && !pathname.startsWith('/admin')

  return (
    <>
      {showSidebar && (
        <Sidebar isLoggedIn={!!user} userEmail={user?.email || ''} isAdmin={isAdmin} onCollapsedChange={setSidebarCollapsed} />
      )}
      {children}
      {user && <MessagesModal userEmail={user.email || ''} isAdmin={isAdmin} />}
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
