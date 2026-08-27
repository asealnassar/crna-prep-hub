'use client'

import { useState, useEffect } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { MODULES_ENABLED } from '@/lib/featureFlags'
import Sidebar from '@/components/Sidebar'

export default function ModuleDetailPage() {
  const params = useParams()
  const moduleId = params?.id as string

  const [module, setModule] = useState<any>(null)
  const [lessons, setLessons] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userTier, setUserTier] = useState('free')
  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [completedLessonIds, setCompletedLessonIds] = useState<Set<string>>(new Set())
  const supabase = createClient()

  if (!MODULES_ENABLED && typeof window !== 'undefined') {
    window.location.href = '/dashboard'
  }

  const isUltimate = userTier === 'ultimate'

  useEffect(() => {
    const init = async () => {
      const { data: moduleData } = await supabase
        .from('modules')
        .select('*')
        .eq('id', moduleId)
        .single()
      setModule(moduleData)

      const { data: lessonsData } = await supabase
        .from('lessons')
        .select('*')
        .eq('module_id', moduleId)
        .order('order_index')
      setLessons(lessonsData || [])

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

        if (lessonsData && lessonsData.length > 0) {
          const lessonIds = lessonsData.map((l: any) => l.id)
          const { data: progressData } = await supabase
            .from('user_lesson_progress')
            .select('lesson_id, passed')
            .eq('user_id', user.id)
            .in('lesson_id', lessonIds)

          setCompletedLessonIds(new Set(
            (progressData || []).filter((p: any) => p.passed).map((p: any) => p.lesson_id)
          ))
        }
      }
      setLoading(false)
    }
    if (moduleId) init()
  }, [moduleId])

  if (loading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="max-w-md mx-auto px-4 text-center">
          <h1 className="text-3xl font-bold text-white mb-4">Learning Modules</h1>
          <p className="text-indigo-200 mb-6">Please log in to access this module.</p>
          <Link href="/login" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Log In</Link>
        </div>
      </div>
    )
  }

  if (!module) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-center">
          <p className="text-white text-lg mb-4">Module not found</p>
          <Link href="/modules" className="text-indigo-300 hover:text-white transition">← Back to Modules</Link>
        </div>
      </div>
    )
  }

  const hasAccess = isAdmin || isUltimate || module.tier_required === 'free'

  if (!hasAccess) {
    return (
      <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
        <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
          <div className="max-w-2xl mx-auto px-4 py-16 text-center">
            <div className="text-5xl mb-4">🔒</div>
            <h1 className="text-2xl font-bold text-white mb-3">{module.title} is an Ultimate module</h1>
            <p className="text-indigo-200 mb-6">Upgrade to Ultimate to unlock this and every other learning module.</p>
            <Link href="/pricing" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Upgrade to Ultimate</Link>
          </div>
        </div>
      </div>
    )
  }

  const completedCount = lessons.filter(l => completedLessonIds.has(l.id)).length
  const progressPct = lessons.length > 0 ? Math.round((completedCount / lessons.length) * 100) : 0

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <Link href="/modules" className="inline-flex items-center gap-2 text-indigo-300 hover:text-white transition mb-6 text-sm">
            ← Back to Modules
          </Link>

          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-2">🫀 {module.title}</h1>
            <p className="text-sm sm:text-base text-indigo-200 mb-4">{module.description}</p>

            <div className="flex items-center justify-between text-xs sm:text-sm text-indigo-300 mb-2">
              <span>{completedCount} / {lessons.length} lessons complete</span>
              <span>{progressPct}%</span>
            </div>
            <div className="w-full bg-white/10 rounded-full h-2.5">
              <div className="bg-gradient-to-r from-purple-500 to-pink-400 h-2.5 rounded-full transition-all" style={{ width: `${progressPct}%` }}></div>
            </div>
          </div>

          <div className="space-y-3">
            {lessons.map((lesson, index) => {
              const isCompleted = completedLessonIds.has(lesson.id)
              return (
                <Link key={lesson.id} href={`/modules/${moduleId}/lessons/${lesson.id}`}>
                  <div className="bg-white rounded-xl shadow-lg p-4 sm:p-5 hover:shadow-xl transition-all duration-200 hover:-translate-y-0.5 flex items-center gap-4">
                    <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-full flex items-center justify-center flex-shrink-0 font-bold text-sm sm:text-base ${isCompleted ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'}`}>
                      {isCompleted ? '✓' : index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-gray-800 text-sm sm:text-base">
                        {index === lessons.length - 1 ? 'Case Study: ' : `Lesson ${index + 1}: `}
                        {lesson.title}
                      </h3>
                      {isCompleted && <p className="text-xs text-green-600 font-semibold mt-0.5">Completed</p>}
                    </div>
                    <div className="text-gray-300 flex-shrink-0">→</div>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
