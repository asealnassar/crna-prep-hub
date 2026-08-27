'use client'

import { useEffect, useState } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'
import MessagesModal from '@/components/MessagesModal' 

export default function Dashboard() {
  const [user, setUser] = useState<any>(null)
  const [profile, setProfile] = useState<any>(null)
  const [savedSchools, setSavedSchools] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [showFeatureForm, setShowFeatureForm] = useState(false)
 const [showMessages, setShowMessages] = useState(false)
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
const handleOpenMessages = () => {
      setShowMessages(true)
    }
    window.addEventListener('openMessages', handleOpenMessages)
    return () => {
      window.removeEventListener('openMessages', handleOpenMessages)
    }
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

      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-4 sm:px-6 py-4 flex justify-end">
          <button onClick={handleSignOut} className="text-white/80 hover:text-white text-sm">Sign Out</button>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 lg:py-12">

          {/* Hero Welcome Section */}
          <div className="mb-8 sm:mb-12">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
              <div>
                <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-2 sm:mb-3">Welcome back! 👋</h1>
                <p className="text-base sm:text-lg lg:text-xl text-indigo-200">{user?.email}</p>
              </div>
              <div className={`px-4 sm:px-6 py-2 sm:py-3 rounded-2xl font-bold text-sm sm:text-base lg:text-lg shadow-xl ${
                tier === 'ultimate' ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white' :
                tier === 'premium' ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white' :
                'bg-white/20 backdrop-blur text-white border border-white/30'
              }`}>
                {tier === 'ultimate' ? '⭐ ULTIMATE' : tier === 'premium' ? '💎 PREMIUM' : '🆓 FREE'}
              </div>
            </div>

            {tier === 'free' && (
              <div className="bg-gradient-to-r from-purple-500/20 to-pink-500/20 backdrop-blur border border-purple-400/30 rounded-2xl p-4 sm:p-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xl sm:text-2xl font-bold text-white mb-2">🚀 Ready to level up?</h3>
                    <p className="text-sm sm:text-base text-indigo-200">Unlock all filters, unlimited interviews, and school-specific prep materials</p>
                  </div>
                  <Link href="/pricing" className="w-full sm:w-auto text-center px-6 sm:px-8 py-3 sm:py-4 bg-white text-purple-600 font-bold rounded-xl hover:bg-gray-100 transition whitespace-nowrap shadow-lg">
                    View Plans
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* Quick Actions - 3 Cards */}
          <div className="mb-8 sm:mb-12">
            <h2 className="text-xl sm:text-2xl font-bold text-white mb-4 sm:mb-6">Quick Actions</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">

              {/* Browse Schools */}
              <Link href="/schools" className="group relative overflow-hidden bg-white rounded-3xl p-6 sm:p-8 shadow-2xl hover:shadow-purple-500/50 transition-all duration-300 hover:-translate-y-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-purple-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-purple-600 to-pink-500 rounded-2xl flex items-center justify-center mb-4 sm:mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-2xl sm:text-3xl">🏫</span>
                  </div>
                  <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2 sm:mb-3">Browse Schools</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-3 sm:mb-4">Search and filter through 149+ CRNA programs to find your perfect match</p>
                  <div className="flex items-center text-purple-600 font-semibold group-hover:gap-3 transition-all text-sm sm:text-base">
                    <span>Explore now</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

              {/* Mock Interview */}
              <Link href="/interview" className="group relative overflow-hidden bg-white rounded-3xl p-6 sm:p-8 shadow-2xl hover:shadow-blue-500/50 transition-all duration-300 hover:-translate-y-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-blue-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-blue-600 to-purple-500 rounded-2xl flex items-center justify-center mb-4 sm:mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-2xl sm:text-3xl">🎤</span>
                  </div>
                  <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2 sm:mb-3">Practice Interview</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-3 sm:mb-4">AI-powered mock interviews with instant feedback and scoring</p>
                  <div className="flex items-center text-blue-600 font-semibold group-hover:gap-3 transition-all text-sm sm:text-base">
                    <span>Start practicing</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

              {/* School-Specific Prep */}
              <Link href="/interview-prep" className={`group relative overflow-hidden bg-white rounded-3xl p-6 sm:p-8 shadow-2xl hover:shadow-pink-500/50 transition-all duration-300 hover:-translate-y-1 ${tier !== 'ultimate' ? 'opacity-90' : ''}`}>
                {tier !== 'ultimate' && (
                  <div className="absolute top-4 right-4 bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs font-bold px-3 py-1 rounded-full">
                    ULTIMATE
                  </div>
                )}
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-pink-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-pink-600 to-purple-500 rounded-2xl flex items-center justify-center mb-4 sm:mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-2xl sm:text-3xl">📚</span>
                  </div>
                  <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2 sm:mb-3">School Interview Styles</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-3 sm:mb-4">Real interview formats and insider tips for each program</p>
                  <div className="flex items-center text-pink-600 font-semibold group-hover:gap-3 transition-all text-sm sm:text-base">
                    <span>Learn more</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

              {/* GPA Calculator */}
              <Link href="/gpa-calculator" className="group relative overflow-hidden bg-white rounded-3xl p-6 sm:p-8 shadow-2xl hover:shadow-green-500/50 transition-all duration-300 hover:-translate-y-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-green-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-green-600 to-emerald-500 rounded-2xl flex items-center justify-center mb-4 sm:mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-2xl sm:text-3xl">🎓</span>
                  </div>
                  <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2 sm:mb-3">GPA Calculator</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-3 sm:mb-4">Check which programs you qualify for based on your GPA</p>
                  <div className="flex items-center text-green-600 font-semibold group-hover:gap-3 transition-all text-sm sm:text-base">
                    <span>Calculate now</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

              {/* Personal Statement */}
              <Link href="/personal-statement" className="group relative overflow-hidden bg-white rounded-3xl p-6 sm:p-8 shadow-2xl hover:shadow-orange-500/50 transition-all duration-300 hover:-translate-y-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-orange-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-orange-600 to-amber-500 rounded-2xl flex items-center justify-center mb-4 sm:mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-2xl sm:text-3xl">📝</span>
                  </div>
                  <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2 sm:mb-3">Personal Statement</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-3 sm:mb-4">Build a compelling statement with guided prompts</p>
                  <div className="flex items-center text-orange-600 font-semibold group-hover:gap-3 transition-all text-sm sm:text-base">
                    <span>Start writing</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

              {/* Resume Builder */}
              <Link href="/resume-builder" className="group relative overflow-hidden bg-white rounded-3xl p-6 sm:p-8 shadow-2xl hover:shadow-indigo-500/50 transition-all duration-300 hover:-translate-y-1">
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-indigo-500/20 to-transparent rounded-full -mr-16 -mt-16"></div>
                <div className="relative">
                  <div className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-indigo-600 to-blue-500 rounded-2xl flex items-center justify-center mb-4 sm:mb-6 group-hover:scale-110 transition-transform">
                    <span className="text-2xl sm:text-3xl">📄</span>
                  </div>
                  <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2 sm:mb-3">Resume Builder</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-3 sm:mb-4">Create a polished, ATS-friendly resume in minutes</p>
                  <div className="flex items-center text-indigo-600 font-semibold group-hover:gap-3 transition-all text-sm sm:text-base">
                    <span>Build resume</span>
                    <span className="ml-2 group-hover:ml-0 transition-all">→</span>
                  </div>
                </div>
              </Link>

            </div>
          </div>

          {/* Feature Request - Compact Banner */}
          <div className="mb-8 sm:mb-12">
            <div className="bg-gradient-to-r from-red-600 via-orange-600 to-pink-600 rounded-2xl p-4 sm:p-5 shadow-lg">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className="text-2xl sm:text-3xl">💡</span>
                  <div>
                    <p className="text-white font-bold text-sm sm:text-base">Got a feature idea?</p>
                    <p className="text-white/80 text-xs sm:text-sm">Best ideas get a free Ultimate upgrade 🎁</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowFeatureForm(!showFeatureForm)}
                  className="px-4 sm:px-5 py-2 sm:py-2.5 bg-white text-red-600 font-bold rounded-xl hover:bg-gray-100 transition text-sm sm:text-base whitespace-nowrap"
                >
                  {showFeatureForm ? 'Close' : 'Share an Idea →'}
                </button>
              </div>

              {showFeatureForm && (
                <div className="bg-white/95 backdrop-blur rounded-2xl p-4 sm:p-6 shadow-xl mt-4">
                  <form onSubmit={async (e) => {
                    e.preventDefault()
                    const formData = new FormData(e.currentTarget)
                    const idea = formData.get('idea') as string

                    if (!idea.trim() || idea.length < 20) {
                      alert('Please share more details! The more specific your idea, the better we can build it.')
                      return
                    }

                    await supabase.from('feature_requests').insert({
                      user_email: user?.email,
                      user_id: user?.id,
                      idea: idea,
                      status: 'pending'
                    })

                    alert('🎉 Amazing! Your idea has been submitted. We review every submission and will reach out if yours is selected for a free Ultimate upgrade!')
                    e.currentTarget.reset()
                    setShowFeatureForm(false)
                  }}>
                    <label className="block text-gray-800 font-bold text-sm sm:text-base mb-2">
                      What feature would help you most?
                    </label>
                    <textarea
                      name="idea"
                      rows={3}
                      placeholder="Be specific! Examples:&#10;• Track application deadlines for each school&#10;• Compare schools side-by-side&#10;• Mobile app for on-the-go prep"
                      className="w-full px-3 sm:px-4 py-2 sm:py-3 rounded-xl border-2 border-orange-300 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-400 resize-none text-gray-800 placeholder-gray-500 text-sm sm:text-base"
                      required
                    />
                    <div className="flex justify-end mt-3">
                      <button
                        type="submit"
                        className="px-6 py-2.5 bg-gradient-to-r from-red-600 to-orange-600 text-white font-bold rounded-xl hover:shadow-lg transition text-sm sm:text-base"
                      >
                        Submit My Idea
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          </div>

          {/* Saved Schools */}
          <div className="bg-white/10 backdrop-blur-lg border border-white/20 rounded-3xl p-6 sm:p-8 shadow-2xl">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 sm:mb-8">
              <div>
                <h2 className="text-2xl sm:text-3xl font-bold text-white mb-2">Your Saved Schools</h2>
                <p className="text-sm sm:text-base text-indigo-200">Keep track of programs you're interested in</p>
              </div>
              <Link href="/schools" className="w-full sm:w-auto text-center px-4 sm:px-6 py-2 sm:py-3 bg-white/20 backdrop-blur border border-white/30 text-white font-semibold rounded-xl hover:bg-white/30 transition text-sm sm:text-base">
                Browse More →
              </Link>
            </div>

            {savedSchools.length === 0 ? (
              <div className="text-center py-12 sm:py-16">
                <div className="w-20 h-20 sm:w-24 sm:h-24 bg-white/10 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6">
                  <span className="text-4xl sm:text-5xl">🏫</span>
                </div>
                <h3 className="text-xl sm:text-2xl font-bold text-white mb-2 sm:mb-3">No schools saved yet</h3>
                <p className="text-sm sm:text-base text-indigo-200 mb-4 sm:mb-6 max-w-md mx-auto px-4">Start browsing schools and save the ones you're interested in to keep them organized</p>
                <Link href="/schools" className="inline-block px-6 sm:px-8 py-3 sm:py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-bold rounded-xl hover:opacity-90 transition shadow-lg text-sm sm:text-base">
                  Explore Schools
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                {savedSchools.map((school) => (
                  <div key={school.id} className="bg-white rounded-2xl p-4 sm:p-6 shadow-lg hover:shadow-xl transition-all relative group">
                    <button
                      onClick={() => removeSavedSchool(school.id)}
                      className="absolute top-3 sm:top-4 right-3 sm:right-4 w-8 h-8 bg-red-50 text-red-500 rounded-full hover:bg-red-500 hover:text-white transition flex items-center justify-center opacity-0 group-hover:opacity-100"
                      title="Remove"
                    >
                      ✕
                    </button>
                    <div className="flex items-start gap-3 sm:gap-4">
                      <div className="w-12 h-12 sm:w-14 sm:h-14 bg-gradient-to-br from-purple-600 to-pink-500 rounded-xl flex items-center justify-center text-white font-bold text-lg sm:text-xl flex-shrink-0">
                        {school.name?.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-gray-800 text-base sm:text-lg mb-1 sm:mb-2 truncate">{school.name}</h3>
                        <p className="text-gray-500 text-xs sm:text-sm mb-2 sm:mb-3">📍 {school.location_city}, {school.location_state}</p>
                        <div className="flex flex-wrap gap-1 sm:gap-2">
                          {school.gpa_requirement && (
                            <span className="bg-purple-100 text-purple-700 px-2 sm:px-3 py-1 rounded-full text-xs font-semibold">
                              GPA {school.gpa_requirement}
                            </span>
                          )}
                          {school.program_type && (
                            <span className="bg-blue-100 text-blue-700 px-2 sm:px-3 py-1 rounded-full text-xs font-semibold">
                              {school.program_type}
                            </span>
                          )}
                          {school.tuition_total && (
                            <span className="bg-green-100 text-green-700 px-2 sm:px-3 py-1 rounded-full text-xs font-semibold">
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

{showMessages && (
        <MessagesModal
          userEmail={user?.email || ''}
          isAdmin={user?.email === 'asealnassar@gmail.com'}
        />
      )}
    </div>
  )
}
