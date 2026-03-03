'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function Dashboard() {
  const [user, setUser] = useState<any>(null)
  const [profile, setProfile] = useState<any>(null)
  const [savedSchools, setSavedSchools] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        router.push('/login')
        return
      }

      setUser(user)

      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      setProfile(profileData)

      const { data: savedData } = await supabase
        .from('saved_schools')
        .select('*, schools(*)')
        .eq('user_id', user.id)

      if (savedData) {
        setSavedSchools(savedData.map(s => s.schools))
      }

      setLoading(false)
    }

    init()
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const removeSavedSchool = async (schoolId: string) => {
    if (!user) return

    await supabase
      .from('saved_schools')
      .delete()
      .eq('user_id', user.id)
      .eq('school_id', schoolId)

    setSavedSchools(savedSchools.filter(s => s.id !== schoolId))
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    )
  }

  const tier = profile?.subscription_tier || 'free'

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar 
        isLoggedIn={!!user} 
        userEmail={user?.email || ''} 
        isAdmin={user?.email === 'asealnassar@gmail.com'}
        onCollapsedChange={setSidebarCollapsed}
      />
      
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'ml-20' : 'ml-64'}`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-6 py-4 flex justify-end">
          <button onClick={handleSignOut} className="text-white/80 hover:text-white text-sm">Sign Out</button>
        </div>

        <div className="max-w-7xl mx-auto px-8 py-12">
          
          {/* Hero Welcome Section */}
          <div className="mb-12">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-5xl font-bold text-white mb-3">Welcome back! 👋</h1>
                <p className="text-xl text-indigo-200">{user?.email}</p>
              </div>
              <div className={`px-6 py-3 rounded-2xl font-bold text-lg shadow-xl ${
                tier === 'ultimate' ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white' :
                tier === 'premium' ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white' :
                'bg-white/20 backdrop-blur text-white border border-white/30'
              }`}>
                {tier === 'ultimate' ? '⭐ ULTIMATE' : tier === 'premium' ? '💎 PREMIUM' : '🆓 FREE'}
              </div>
            </div>
            
            {tier === 'free' && (
              <div className="bg-gradient-to-r from-purple-500/20 to-pink-500/20 backdrop-blur border border-purple-400/30 rounded-2xl p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-2xl font-bold text-white mb-2">🚀 Ready to level up?</h3>
                    <p className="text-indigo-200">Unlock all filters, unlimited interviews, and school-specific prep materials</p>
                  </div>
                  <Link href="/pricing" className="px-8 py-4 bg-white text-purple-600 font-bold rounded-xl hover:bg-gray-100 transition whitespace-nowrap shadow-lg">
                    View Plans
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* Quick Actions - 3 Cards */}
          <div className="mb-12">
            <h2 className="text-2xl font-bold text-white mb-6">Quick Actions</h2>
            <div className="grid md:grid-cols-3 gap-6">
              
              {/* Browse Schools */}
              <Link href="/schools" className="group relative overflow-hidden bg-white rounded-3xl p-8 shadow-2xl hover:shadow-purple-500/50 transition-all duration-300 hover:-translate-y-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-purple-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-16 h-16 bg-gradient-to-br from-purple-600 to-pink-500 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-3xl">🏫</span>
                  </div>
                  <h3 className="text-2xl font-bold text-gray-800 mb-3">Browse Schools</h3>
                  <p className="text-gray-600 mb-4">Search and filter through 149+ CRNA programs to find your perfect match</p>
                  <div className="flex items-center text-purple-600 font-semibold group-hover:gap-3 transition-all">
                    <span>Explore now</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

              {/* Mock Interview */}
              <Link href="/interview" className="group relative overflow-hidden bg-white rounded-3xl p-8 shadow-2xl hover:shadow-blue-500/50 transition-all duration-300 hover:-translate-y-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-blue-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-16 h-16 bg-gradient-to-br from-blue-600 to-purple-500 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-3xl">🎤</span>
                  </div>
                  <h3 className="text-2xl font-bold text-gray-800 mb-3">Practice Interview</h3>
                  <p className="text-gray-600 mb-4">AI-powered mock interviews with instant feedback and scoring</p>
                  <div className="flex items-center text-blue-600 font-semibold group-hover:gap-3 transition-all">
                    <span>Start practicing</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

              {/* School-Specific Prep */}
              <Link href="/interview-prep" className={`group relative overflow-hidden bg-white rounded-3xl p-8 shadow-2xl hover:shadow-pink-500/50 transition-all duration-300 hover:-translate-y-1 ${tier !== 'ultimate' ? 'opacity-90' : ''}`}>
                {tier !== 'ultimate' && (
                  <div className="absolute top-4 right-4 bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs font-bold px-3 py-1 rounded-full">
                    ULTIMATE
                  </div>
                )}
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-pink-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-16 h-16 bg-gradient-to-br from-pink-600 to-purple-500 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-3xl">📚</span>
                  </div>
                  <h3 className="text-2xl font-bold text-gray-800 mb-3">School Interview Styles</h3>
                  <p className="text-gray-600 mb-4">Real interview formats and insider tips for each program</p>
                  <div className="flex items-center text-pink-600 font-semibold group-hover:gap-3 transition-all">
                    <span>Learn more</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

            </div>
          </div>

          {/* Saved Schools */}
          <div className="bg-white/10 backdrop-blur-lg border border-white/20 rounded-3xl p-8 shadow-2xl">
            <div className="flex justify-between items-center mb-8">
              <div>
                <h2 className="text-3xl font-bold text-white mb-2">Your Saved Schools</h2>
                <p className="text-indigo-200">Keep track of programs you're interested in</p>
              </div>
              <Link href="/schools" className="px-6 py-3 bg-white/20 backdrop-blur border border-white/30 text-white font-semibold rounded-xl hover:bg-white/30 transition">
                Browse More →
              </Link>
            </div>

            {savedSchools.length === 0 ? (
              <div className="text-center py-16">
                <div className="w-24 h-24 bg-white/10 rounded-full flex items-center justify-center mx-auto mb-6">
                  <span className="text-5xl">🏫</span>
                </div>
                <h3 className="text-2xl font-bold text-white mb-3">No schools saved yet</h3>
                <p className="text-indigo-200 mb-6 max-w-md mx-auto">Start browsing schools and save the ones you're interested in to keep them organized</p>
                <Link href="/schools" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-bold rounded-xl hover:opacity-90 transition shadow-lg">
                  Explore Schools
                </Link>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-6">
                {savedSchools.map((school) => (
                  <div key={school.id} className="bg-white rounded-2xl p-6 shadow-lg hover:shadow-xl transition-all relative group">
                    <button
                      onClick={() => removeSavedSchool(school.id)}
                      className="absolute top-4 right-4 w-8 h-8 bg-red-50 text-red-500 rounded-full hover:bg-red-500 hover:text-white transition flex items-center justify-center opacity-0 group-hover:opacity-100"
                      title="Remove"
                    >
                      ✕
                    </button>
                    <div className="flex items-start gap-4">
                      <div className="w-14 h-14 bg-gradient-to-br from-purple-600 to-pink-500 rounded-xl flex items-center justify-center text-white font-bold text-xl flex-shrink-0">
                        {school.name?.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-gray-800 text-lg mb-2 truncate">{school.name}</h3>
                        <p className="text-gray-500 text-sm mb-3">📍 {school.location_city}, {school.location_state}</p>
                        <div className="flex flex-wrap gap-2">
                          {school.gpa_requirement && (
                            <span className="bg-purple-100 text-purple-700 px-3 py-1 rounded-full text-xs font-semibold">
                              GPA {school.gpa_requirement}
                            </span>
                          )}
                          {school.program_type && (
                            <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-semibold">
                              {school.program_type}
                            </span>
                          )}
                          {school.tuition_total && (
                            <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-semibold">
                              ${school.tuition_total?.toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
