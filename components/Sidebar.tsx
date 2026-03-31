'use client'
      
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
          
interface SidebarProps {
  isLoggedIn: boolean
  userEmail: string
  isAdmin: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}
              
export default function Sidebar({ isLoggedIn, userEmail, isAdmin, onCollapsedChange }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [messagesUnreadCount, setMessagesUnreadCount] = useState(0)
  const pathname = usePathname()
  const supabase = createClient()
            
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  useEffect(() => {
    if (isLoggedIn && userEmail) {
      loadUnreadCount()
      loadMessagesUnreadCount()
    }
  }, [isLoggedIn, userEmail])

  const loadUnreadCount = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: allUpdates } = await supabase
      .from('site_updates')
      .select('id')
    
    const { data: readUpdates } = await supabase
      .from('user_read_updates')
      .select('update_id')
      .eq('user_id', user.id)

    const readIds = new Set(readUpdates?.map(r => r.update_id) || [])
    const unread = allUpdates?.filter(u => !readIds.has(u.id)).length || 0
    setUnreadCount(unread)
  }

  const loadMessagesUnreadCount = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    // Get user's subscription tier
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', user.id)
      .single()

    const userTier = profile?.subscription_tier || 'free'

    // Get messages for this user's tier or 'all'
    const { data: allMessages } = await supabase
      .from('admin_messages')
      .select('id')
      .in('send_to', ['all', userTier])
    
    const { data: readMessages } = await supabase
      .from('message_reads')
      .select('message_id')
      .eq('user_id', user.id)

    const readIds = new Set(readMessages?.map(r => r.message_id) || [])
    const unread = allMessages?.filter(m => !readIds.has(m.id)).length || 0
    setMessagesUnreadCount(unread)
  }

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '📊', requiresAuth: true },
  { href: '/schools', label: 'Schools', icon: '🏫', requiresAuth: false },
  { href: '/interview', label: 'Mock Interview', icon: '🎤', requiresAuth: false },
  { href: '/interview-prep', label: 'School Interview Styles', icon: '📚', requiresAuth: false },
  { href: '/gpa-calculator', label: 'GPA Calculator', icon: '🎓', requiresAuth: false },
  { href: '/personal-statement', label: 'Personal Statement', icon: '📝', requiresAuth: false },
  { href: '/resume-builder', label: 'Resume Builder', icon: '📄', requiresAuth: false },
  { href: '/pricing', label: 'Pricing', icon: '💎', requiresAuth: false },
  { href: '/sponsors', label: 'Sponsors', icon: '🤝', requiresAuth: false },
  { href: '/admin/analytics', label: 'Analytics', icon: '📈', requiresAuth: true, adminOnly: true },
  { href: '/admin/schools', label: 'Admin', icon: '⚙️', requiresAuth: true, adminOnly: true },
]  
  const visibleItems = navItems.filter(item => {
    if (item.adminOnly && !isAdmin) return false
    if (item.requiresAuth && !isLoggedIn) return false
    return true
  })
               
  const toggleCollapse = () => {
    const newState = !isCollapsed
    setIsCollapsed(newState)
    onCollapsedChange?.(newState)
  }
 
  return (
    <>
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="lg:hidden fixed top-4 left-4 z-50 p-3 bg-slate-800 text-white rounded-lg shadow-lg"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {mobileOpen ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
      </button>

      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-30"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div
        className={`
          ${isCollapsed ? 'w-20' : 'w-64'}
          bg-gradient-to-b from-slate-900 to-slate-800
          min-h-screen transition-all duration-300 flex flex-col fixed left-0 top-0 z-40
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        <div className="p-4 flex items-center justify-between border-b border-white/10">
          {!isCollapsed && (
            <Link href="/">
              <h1 className="text-xl font-bold text-white">CRNA Prep Hub</h1>
            </Link>
          )}
          <button
            onClick={toggleCollapse}
            className="hidden lg:block text-white hover:bg-white/10 p-2 rounded-lg transition"
          >
            {isCollapsed ? '→' : '←'}
          </button>
        </div>

        <nav className="flex-1 flex flex-col p-4">
          <ul className="space-y-2 flex-1">
            {visibleItems.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg transition ${
                    pathname === item.href
                      ? 'bg-white/20 text-white font-semibold'
                      : 'text-white/80 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <span className="text-xl">{item.icon}</span>
                  {!isCollapsed && <span className="text-sm">{item.label}</span>}
                </Link>
              </li>
            ))}
          </ul>

          {/* Messages and Updates - Separated at bottom */}
          {isLoggedIn && (
            <>
              <div className="border-t border-white/10 my-4"></div>
              
{/* Messages button with unread count */}
<button
  onClick={() => {
    const event = new Event('openMessages')
    window.dispatchEvent(event)
  }}
  className="flex items-center gap-3 px-4 py-3 rounded-lg transition text-white/80 hover:bg-white/10 hover:text-white w-full text-left"
>
  <span className="text-xl">💬</span>
  <span className="font-medium">Messages</span>
  <span id="messages-unread-badge" className="ml-auto bg-white text-purple-600 text-xs font-bold px-2 py-1 rounded-full hidden">
    0
  </span>
</button>
              {/* Updates */}
              <Link
                href="/updates"
                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition relative ${
                  pathname === '/updates'
                    ? 'bg-white/20 text-white font-semibold'
                    : 'text-white/80 hover:bg-white/10 hover:text-white'
                }`}
              >
                <span className="text-xl">📣</span>
                {!isCollapsed && (
                  <>
                    <span className="text-sm">Updates</span>
                    {unreadCount > 0 && (
                      <span className="ml-auto bg-red-500 text-white text-xs font-bold px-2 py-1 rounded-full">
                        {unreadCount}
                      </span>
                    )}
                  </>
                )}
                {isCollapsed && unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                    {unreadCount}
                  </span>
                )}
              </Link>
            </>
          )}
        </nav>
      </div>
    </>
  )
}
