'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function Updates() {
  const [updates, setUpdates] = useState<any[]>([])
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [filterCategory, setFilterCategory] = useState('all')
  const supabase = createClient()

  const isAdmin = user?.email === 'asealnassar@gmail.com'

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)
      await loadUpdates(user)
      setLoading(false)
    }
    init()
  }, [])

  const loadUpdates = async (currentUser: any) => {
    const { data: allUpdates } = await supabase
      .from('site_updates')
      .select('*')
      .order('created_at', { ascending: false })

    if (!currentUser) {
      setUpdates(allUpdates || [])
      return
    }

    const { data: readUpdates } = await supabase
      .from('user_read_updates')
      .select('update_id')
      .eq('user_id', currentUser.id)

    const readIds = new Set(readUpdates?.map(r => r.update_id) || [])
    const updatesWithReadStatus = (allUpdates || []).map(update => ({
      ...update,
      isRead: readIds.has(update.id)
    }))

    setUpdates(updatesWithReadStatus)
  }

  const markAsRead = async (updateId: string) => {
    if (!user) return

    await supabase.from('user_read_updates').upsert({
      user_id: user.id,
      update_id: updateId,
    })

    setUpdates(updates.map(u => 
      u.id === updateId ? { ...u, isRead: true } : u
    ))
  }

  const markAllAsRead = async () => {
    if (!user) return

    const unreadUpdates = updates.filter(u => !u.isRead)
    for (const update of unreadUpdates) {
      await supabase.from('user_read_updates').upsert({
        user_id: user.id,
        update_id: update.id,
      })
    }

    setUpdates(updates.map(u => ({ ...u, isRead: true })))
  }

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'new_feature': return '✨'
      case 'bug_fix': return '🐛'
      case 'improvement': return '⚡'
      case 'coming_soon': return '🔮'
      default: return '📢'
    }
  }

  const getCategoryName = (category: string) => {
    switch (category) {
      case 'new_feature': return 'New Feature'
      case 'bug_fix': return 'Bug Fix'
      case 'improvement': return 'Improvement'
      case 'coming_soon': return 'Coming Soon'
      default: return category
    }
  }

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'new_feature': return 'bg-green-100 text-green-700 border-green-200'
      case 'bug_fix': return 'bg-red-100 text-red-700 border-red-200'
      case 'improvement': return 'bg-blue-100 text-blue-700 border-blue-200'
      case 'coming_soon': return 'bg-purple-100 text-purple-700 border-purple-200'
      default: return 'bg-gray-100 text-gray-700 border-gray-200'
    }
  }

  const filteredUpdates = filterCategory === 'all' 
    ? updates 
    : updates.filter(u => u.category === filterCategory)

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar
        isLoggedIn={!!user}
        userEmail={user?.email || ''}
        isAdmin={isAdmin}
        onCollapsedChange={setSidebarCollapsed}
      />

      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-4 sm:px-6 py-4 flex justify-between items-center">
          <h1 className="text-xl sm:text-2xl font-bold text-white">📣 Updates</h1>
          {isAdmin && (
            <Link
              href="/admin/updates"
              className="px-4 py-2 bg-purple-600 text-white font-semibold rounded-lg hover:bg-purple-700 transition text-sm"
            >
              Manage Updates
            </Link>
          )}
        </div>

        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
            <p className="text-indigo-200 text-sm sm:text-base">
              Stay up to date with the latest features and improvements
            </p>
            
            {user && updates.some(u => !u.isRead) && (
              <button
                onClick={markAllAsRead}
                className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 transition text-sm font-semibold"
              >
                Mark All as Read
              </button>
            )}
          </div>

          {/* Filter */}
          <div className="mb-6">
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="px-4 py-2 bg-white/10 text-white rounded-lg border border-white/20 focus:outline-none focus:ring-2 focus:ring-purple-400"
            >
              <option value="all">All Updates</option>
              <option value="new_feature">New Features</option>
              <option value="improvement">Improvements</option>
              <option value="bug_fix">Bug Fixes</option>
              <option value="coming_soon">Coming Soon</option>
            </select>
          </div>

          {/* Updates List */}
          <div className="space-y-4">
            {filteredUpdates.length === 0 ? (
              <div className="bg-white/10 rounded-xl p-8 text-center">
                <p className="text-white/60">No updates to show</p>
              </div>
            ) : (
              filteredUpdates.map((update) => (
                <div
                  key={update.id}
                  className={`bg-white rounded-xl p-4 sm:p-6 shadow-lg transition ${
                    !update.isRead && user ? 'border-2 border-purple-500' : ''
                  }`}
                  onClick={() => !update.isRead && user && markAsRead(update.id)}
                >
                  <div className="flex justify-between items-start gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-semibold border ${getCategoryColor(update.category)}`}
                        >
                          {getCategoryIcon(update.category)} {getCategoryName(update.category)}
                        </span>
                        {!update.isRead && user && (
                          <span className="px-2 py-1 bg-purple-100 text-purple-700 text-xs font-bold rounded-full">
                            NEW
                          </span>
                        )}
                      </div>
                      <h3 className="text-lg sm:text-xl font-bold text-gray-800 mb-2">
                        {update.title}
                      </h3>
                      <p className="text-gray-600 text-sm sm:text-base whitespace-pre-line">
                        {update.description}
                      </p>
                      <p className="text-gray-400 text-xs sm:text-sm mt-3">
                        {new Date(update.created_at).toLocaleDateString('en-US', {
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
