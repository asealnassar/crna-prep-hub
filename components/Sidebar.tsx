'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import {
  BarChart3,
  Calculator,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileUser,
  Gem,
  GraduationCap,
  Home,
  Mail,
  Megaphone,
  MessagesSquare,
  Mic,
  School,
  Settings,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react'

interface SidebarProps {
  isLoggedIn: boolean
  userEmail: string
  isAdmin: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  group: string
  requiresAuth: boolean
  adminOnly?: boolean
}

export default function Sidebar({ isLoggedIn, userEmail, isAdmin, onCollapsedChange }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [messagesUnreadCount, setMessagesUnreadCount] = useState(0)
  const { messagesUnreadCount: liveMessagesUnreadCount } = useSidebarCollapsed()
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

  // Same routes, order, and permissions as before — only the icons and the
  // group labels are new.
  const navItems: NavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: Home, group: 'Prepare', requiresAuth: true },
    { href: '/schools', label: 'Schools', icon: School, group: 'Prepare', requiresAuth: false },
    { href: '/interview', label: 'Mock Interview', icon: Mic, group: 'Prepare', requiresAuth: false },
    { href: '/interview-prep', label: 'School Interview Styles', icon: GraduationCap, group: 'Prepare', requiresAuth: false },
    { href: '/gpa-calculator', label: 'GPA Calculator', icon: Calculator, group: 'Build', requiresAuth: false },
    { href: '/personal-statement', label: 'Personal Statement', icon: FileText, group: 'Build', requiresAuth: false },
    { href: '/resume-builder', label: 'Resume Builder', icon: FileUser, group: 'Build', requiresAuth: false },
    { href: '/pricing', label: 'Pricing', icon: Gem, group: 'Account', requiresAuth: false },
    { href: '/admin/analytics', label: 'Analytics', icon: BarChart3, group: 'Account', requiresAuth: true, adminOnly: true },
    { href: '/admin/schools', label: 'Admin', icon: Settings, group: 'Account', requiresAuth: true, adminOnly: true },
  ]

  const visibleItems = navItems.filter(item => {
    if (item.adminOnly && !isAdmin) return false
    if (item.requiresAuth && !isLoggedIn) return false
    return true
  })

  // Groups render in first-seen order, so nav order is untouched.
  const groups: { name: string; items: NavItem[] }[] = []
  for (const item of visibleItems) {
    const existing = groups.find(g => g.name === item.group)
    if (existing) existing.items.push(item)
    else groups.push({ name: item.group, items: [item] })
  }

  const toggleCollapse = () => {
    const newState = !isCollapsed
    setIsCollapsed(newState)
    onCollapsedChange?.(newState)
  }

  const linkClass = (active: boolean) =>
    `group relative flex items-center ${isCollapsed ? 'justify-center' : ''} gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
      active
        ? 'bg-violet-500/15 font-semibold text-white'
        : 'text-slate-400 hover:bg-white/5 hover:text-white'
    }`

  const ActiveEdge = ({ active }: { active: boolean }) =>
    active ? (
      <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-violet-500" />
    ) : null

  return (
    <>
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
        className="lg:hidden fixed top-4 left-4 z-50 rounded-xl bg-[#0B1220] p-3 text-white shadow-lg ring-1 ring-white/10"
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-30"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div
        className={`
          ${isCollapsed ? 'w-20' : 'w-64'}
          bg-[#0B1220]
          min-h-screen transition-all duration-300 flex flex-col fixed left-0 top-0 z-40
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        <div className={`flex items-center ${isCollapsed ? 'justify-center' : 'justify-between'} gap-2 px-4 py-5`}>
          {!isCollapsed && (
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg shadow-violet-900/40">
                <GraduationCap className="h-5 w-5 text-white" />
              </span>
              <span className="leading-tight">
                <span className="block text-sm font-bold tracking-tight text-white">CRNA</span>
                <span className="block text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-400">
                  School Prep
                </span>
              </span>
            </Link>
          )}
          <button
            onClick={toggleCollapse}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden lg:flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        <nav className="flex flex-1 flex-col overflow-y-auto px-3 pb-4">
          <div className="flex-1 space-y-6">
            {groups.map((group) => (
              <div key={group.name}>
                {!isCollapsed && (
                  <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    {group.name}
                  </p>
                )}
                <ul className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon
                    const active = pathname === item.href
                    return (
                      <li key={item.href}>
                        <Link href={item.href} title={isCollapsed ? item.label : undefined} className={linkClass(active)}>
                          <ActiveEdge active={active} />
                          <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-violet-300' : ''}`} />
                          {!isCollapsed && <span className="truncate">{item.label}</span>}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>

          {/* Messages and Updates - Separated at bottom */}
          {isLoggedIn && (
            <div className="mt-6 border-t border-white/10 pt-4">
              {!isCollapsed && (
                <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Community
                </p>
              )}

              {/* Forum */}
              <Link
                href="/forum"
                title={isCollapsed ? 'Community Forum' : undefined}
                className={linkClass(pathname === '/forum')}
              >
                <ActiveEdge active={pathname === '/forum'} />
                <MessagesSquare className={`h-[18px] w-[18px] shrink-0 ${pathname === '/forum' ? 'text-violet-300' : ''}`} />
                {!isCollapsed && <span className="truncate">Community Forum</span>}
              </Link>

              {/* Messages button with unread count */}
              <button
                onClick={() => {
                  const event = new Event('openMessages')
                  window.dispatchEvent(event)
                }}
                title={isCollapsed ? 'Messages' : undefined}
                className={`${linkClass(false)} mt-1 w-full text-left`}
              >
                <Mail className="h-[18px] w-[18px] shrink-0" />
                {!isCollapsed && <span className="truncate">Messages</span>}
                {!isCollapsed && liveMessagesUnreadCount > 0 && (
                  <span className="ml-auto rounded-full bg-violet-500 px-2 py-0.5 text-[11px] font-bold text-white">
                    {liveMessagesUnreadCount}
                  </span>
                )}
                {isCollapsed && liveMessagesUnreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                    {liveMessagesUnreadCount}
                  </span>
                )}
              </button>

              {/* Updates */}
              <Link
                href="/updates"
                title={isCollapsed ? 'Updates' : undefined}
                className={`${linkClass(pathname === '/updates')} mt-1`}
              >
                <ActiveEdge active={pathname === '/updates'} />
                <Megaphone className={`h-[18px] w-[18px] shrink-0 ${pathname === '/updates' ? 'text-violet-300' : ''}`} />
                {!isCollapsed && (
                  <>
                    <span className="truncate">Updates</span>
                    {unreadCount > 0 && (
                      <span className="ml-auto rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">
                        {unreadCount}
                      </span>
                    )}
                  </>
                )}
                {isCollapsed && unreadCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                    {unreadCount}
                  </span>
                )}
              </Link>
            </div>
          )}
        </nav>
      </div>
    </>
  )
}
