'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface SidebarProps {
  isLoggedIn: boolean
  userEmail: string
  isAdmin: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

export default function Sidebar({ isLoggedIn, userEmail, isAdmin, onCollapsedChange }: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(false)
  const pathname = usePathname()

  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: '📊', requiresAuth: true },
    { href: '/schools', label: 'Schools', icon: '🏫', requiresAuth: false },
    { href: '/interview', label: 'Mock Interview', icon: '🎤', requiresAuth: false },
    { href: '/interview-prep', label: 'School Interview Styles', icon: '📚', requiresAuth: false },
{ href: '/gpa-calculator', label: 'GPA Calculator', icon: '🎓', requiresAuth: false },
    { href: '/pricing', label: 'Pricing', icon: '💎', requiresAuth: false },
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
    <div className={`${isCollapsed ? 'w-20' : 'w-64'} bg-gradient-to-b from-slate-900 to-slate-800 min-h-screen transition-all duration-300 flex flex-col fixed left-0 top-0 z-40`}>
      <div className="p-4 flex items-center justify-between border-b border-white/10">
        {!isCollapsed && (
          <Link href="/">
            <h1 className="text-xl font-bold text-white">CRNA Prep Hub</h1>
          </Link>
        )}
        <button
          onClick={toggleCollapse}
          className="text-white hover:bg-white/10 p-2 rounded-lg transition"
        >
          {isCollapsed ? '→' : '←'}
        </button>
      </div>

      <nav className="flex-1 p-4">
        <ul className="space-y-2">
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
      </nav>
    </div>
  )
}
