'use client'

import { useState, useEffect } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { MODULES_ENABLED } from '@/lib/featureFlags'
import Sidebar from '@/components/Sidebar'

export default function ModulesPage() {
  const [modules, setModules] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userTier, setUserTier] = useState('free')
  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [progressMap, setProgressMap] = useState<{[moduleId: string]: {completed: number, total: number}}>({})
  const supabase = createClient()

  if (!MODULES_ENABLED && typeof window !== 'undefined') {
    window.location.href = '/dashboard'
  }

  const isUltimate = userTier === 'ultimate'

  useEffect(() => {
    const init = async () => {
      const { data: modulesData } = await supabase
        .from('modules')
        .select('*, lessons(id)')
        .order('order_index')

      setModules(modulesData || [])

      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setIsLoggedIn(true)
        setUserId(user.id)
        setUserEmail(user.email || '')
        setIsAdmin(user.email === 'asealnassar@gmail.com')

        const { data: profile } = await supabase
          .from('user_profiles')
          .select('subscription_tier')
          .eq('id', user.id)
          .single()
        if (profile) setUserTier(profile.subscription_tier || 'free')

        if (modulesData && modulesData.length > 0) {
          const allLessonIds = modulesData.flatMap((m: any) => m.lessons.map((l: any) => l.id))
          const { data: progressData } = await supabase
            .from('user_lesson_progress')
            .select('lesson_id, passed')
            .eq('user_id', user.id)
            .in('lesson_id', allLessonIds)

          const completedLessonIds = new Set(
            (progressData || []).filter((p: any) => p.passed).map((p: any) => p.lesson_id)
          )

          const map: {[moduleId: string]: {completed: number, total: number}} = {}
          modulesData.forEach((m: any) => {
            const total = m.lessons.length
            const completed = m.lessons.filter((l: any) => completedLessonIds.has(l.id)).length
            map[m.id] = { completed, total }
          })
          setProgressMap(map)
        }
      }
      setLoading(false)
    }
    init()
  }, [])

  if (loading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="max-w-md mx-auto px-4 text-center">
          <h1 className="text-3xl font-bold text-white mb-4">Learning Modules</h1>
          <p className="text-indigo-200 mb-6">Please log in to access learning modules.</p>
          <Link href="/login" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Log In</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-2">📚 Learning Modules</h1>
            <p className="text-sm sm:text-base text-indigo-200">Deep-dive clinical content to strengthen your CRNA interview knowledge</p>
          </div>

          {!isUltimate && !isAdmin && (
            <div className="bg-purple-500/20 border border-purple-500/50 rounded-xl p-4 sm:p-6 mb-6 sm:mb-8">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                <div>
                  <h3 className="text-purple-300 font-semibold text-base sm:text-lg">🔓 Full Library with Ultimate</h3>
                  <p className="text-purple-200/80 text-xs sm:text-sm">Free members get access to select modules. Upgrade to Ultimate to unlock the full learning library.</p>
                </div>
                <Link href="/pricing" className="w-full md:w-auto text-center px-4 sm:px-6 py-2 sm:py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition whitespace-nowrap text-sm sm:text-base">
                  Upgrade to Ultimate
                </Link>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6">
            {modules.map((module) => {
              const hasAccess = isAdmin || isUltimate || module.tier_required === 'free'
              const progress = progressMap[module.id] || { completed: 0, total: module.lessons?.length || 0 }
              const progressPct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0

              if (!hasAccess) {
                return (
                  <div key={module.id} className="bg-white rounded-2xl shadow-lg p-6 sm:p-8 relative overflow-hidden opacity-90">
                    <div className="absolute top-4 right-4 bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs font-bold px-3 py-1 rounded-full">
                      ULTIMATE
                    </div>
                    <div className="text-3xl sm:text-4xl mb-3">🔒</div>
                    <h3 className="text-lg sm:text-xl font-bold text-gray-800 mb-2">{module.title}</h3>
                    <p className="text-sm sm:text-base text-gray-500">{module.description}</p>
                    <p className="text-xs text-gray-400 mt-3">{module.lessons?.length || 0} lessons</p>
                  </div>
                )
              }

              return (
                <Link key={module.id} href={`/modules/${module.id}`}>
                  <div className="bg-white rounded-2xl shadow-lg p-6 sm:p-8 hover:shadow-xl transition-all duration-200 hover:-translate-y-1 h-full">
                    <div className="text-3xl sm:text-4xl mb-3">🫀</div>
                    <h3 className="text-lg sm:text-xl font-bold text-gray-800 mb-2">{module.title}</h3>
                    <p className="text-sm sm:text-base text-gray-500 mb-4">{module.description}</p>

                    <div className="flex items-center justify-between text-xs sm:text-sm text-gray-400 mb-2">
                      <span>{progress.completed} / {progress.total} lessons complete</span>
                      <span>{progressPct}%</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div className="bg-gradient-to-r from-purple-600 to-pink-500 h-2 rounded-full transition-all" style={{ width: `${progressPct}%` }}></div>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>

          {modules.length === 0 && (
            <div className="text-center py-20 bg-white/5 border border-white/10 rounded-3xl">
              <p className="text-indigo-200 text-lg">No modules available yet. Check back soon!</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
