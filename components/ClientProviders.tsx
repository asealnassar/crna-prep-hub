'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import MessagesModal from './MessagesModal'

export default function ClientProviders({ children }: { children: React.ReactNode }) {
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

  console.log('ClientProviders render - user:', user?.email, 'isAdmin:', isAdmin)

  if (loading) return <>{children}</>

  return (
    <>
      {children}
      {user && <MessagesModal userEmail={user.email || ''} isAdmin={isAdmin} />}
    </>
  )
}
