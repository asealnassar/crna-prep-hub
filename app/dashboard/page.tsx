'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'

export default function Dashboard() {
  const [user, setUser] = useState<any>(null)
  const [profile, setProfile] = useState<any>(null)
  const [savedSchools, setSavedSchools] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
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
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className="bg-gradient-to-r from-yellow-500 to-orange-500 py-3 text-center">
        <a href="/interview-prep" className="text-black font-semibold hover:underline">🚀 NEW: School-Specific Interview Style is NOW LIVE for Ultimate members →</a>
      </div>
      <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Link href="/"><h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1></Link>
              <Link href="/sponsors" className="text-yellow-400 hover:text-yellow-300 text-sm font-medium">Sponsors</Link>
            </div>
            <div className="flex gap-6 items-center">
              <Link href="/dashboard" className="text-white font-semibold">Dashboard</Link>
              <Link href="/schools" className="text-white/80 hover:text-white transition">Schools</Link>
              <Link href="/interview" className="text-white/80 hover:text-white transition">Mock Interview</Link>
              <Link href="/interview-prep" className="text-white/80 hover:text-white transition">School-Specific Interview Style</Link>
              <Link href="/pricing" className="text-white/80 hover:text-white transition">Pricing</Link>
              <button onClick={handleSignOut} className="text-white/60 hover:text-white text-sm">Sign Out</button>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-8">
        
        {/* Welcome Header */}
        <div className="bg-white rounded-2xl shadow-xl p-8 mb-8">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-gray-800 mb-2">Welcome back! 👋</h1>
              <p className="text-gray-500">{user?.email}</p>
            </div>
            <div className={`px-4 py-2 rounded-full font-semibold text-sm ${
              tier === 'ultimate' ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white' :
              tier === 'premium' ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white' :
              'bg-gray-200 text-gray-700'
            }`}>
              {tier === 'ultimate' ? '⭐ ULTIMATE' : tier === 'premium' ? '💎 PREMIUM' : '🆓 FREE PLAN'}
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="text-3xl mb-2">🎓</div>
            <h3 className="text-3xl font-bold text-gray-800">129+</h3>
            <p className="text-gray-500">Schools Available</p>
          </div>
          
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="text-3xl mb-2">❤️</div>
            <h3 className="text-3xl font-bold text-gray-800">{savedSchools.length}</h3>
            <p className="text-gray-500">Schools Saved</p>
          </div>
          
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="text-3xl mb-2">🔍</div>
            <h3 className="text-3xl font-bold text-gray-800">{tier === 'free' ? '4' : '12'}</h3>
            <p className="text-gray-500">Filters Available</p>
          </div>
          
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="text-3xl mb-2">🎤</div>
            <h3 className="text-3xl font-bold text-gray-800">{tier === 'ultimate' ? '∞' : '7'}</h3>
            <p className="text-gray-500">Interview Questions</p>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          <Link href="/schools" className="bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition group">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-4xl mb-3">🏫</div>
                <h3 className="text-xl font-bold text-gray-800 mb-2">Browse Schools</h3>
                <p className="text-gray-500">Search and filter through 129+ CRNA programs</p>
              </div>
              <div className="text-3xl text-gray-300 group-hover:text-purple-500 transition">→</div>
            </div>
          </Link>

          <Link href="/interview" className="bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition group">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-4xl mb-3">🎯</div>
                <h3 className="text-xl font-bold text-gray-800 mb-2">Practice Interview</h3>
                <p className="text-gray-500">AI-powered mock interviews with voice support</p>
              </div>
              <div className="text-3xl text-gray-300 group-hover:text-purple-500 transition">→</div>
            </div>
          </Link>

          <Link href="/interview-prep" className={`bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition group relative ${tier !== 'ultimate' ? 'border-2 border-purple-500' : ''}`}>
            {tier !== 'ultimate' && (
              <div className="absolute top-2 right-2 bg-purple-500 text-white text-xs px-2 py-1 rounded-full">Ultimate Only</div>
            )}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-4xl mb-3">📋</div>
                <h3 className="text-xl font-bold text-gray-800 mb-2">School-Specific Interview Style</h3>
                <p className="text-gray-500">Real interview info & tips for each program</p>
              </div>
              <div className="text-3xl text-gray-300 group-hover:text-purple-500 transition">→</div>
            </div>
          </Link>
        </div>

        {/* Saved Schools Section */}
        <div className="bg-white rounded-2xl shadow-xl p-6 mb-8">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-gray-800">❤️ Your Saved Schools</h2>
            <Link href="/schools" className="text-purple-600 hover:text-purple-700 font-semibold text-sm">
              Browse more schools →
            </Link>
          </div>

          {savedSchools.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 rounded-xl">
              <div className="text-5xl mb-4">🏫</div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">No schools saved yet</h3>
              <p className="text-gray-500 mb-4">Start browsing and save schools you're interested in!</p>
              <Link href="/schools" className="inline-block bg-gradient-to-r from-purple-600 to-pink-600 text-white px-6 py-3 rounded-xl font-semibold hover:opacity-90 transition">
                Browse Schools
              </Link>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {savedSchools.map((school) => (
                <div key={school.id} className="border border-gray-200 rounded-xl p-4 hover:border-purple-300 transition relative">
                  <button
                    onClick={() => removeSavedSchool(school.id)}
                    className="absolute top-3 right-3 text-gray-400 hover:text-red-500 transition"
                    title="Remove from saved"
                  >
                    ✕
                  </button>
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 bg-gradient-to-br from-purple-600 to-pink-500 rounded-xl flex items-center justify-center text-white font-bold text-lg">
                      {school.name?.charAt(0)}
                    </div>
                    <div className="flex-1">
                      <h3 className="font-bold text-gray-800">{school.name}</h3>
                      <p className="text-gray-500 text-sm">📍 {school.location_city}, {school.location_state}</p>
                      <div className="flex gap-3 mt-2 text-xs">
                        <span className="bg-purple-100 text-purple-700 px-2 py-1 rounded-full">GPA: {school.gpa_requirement}</span>
                        <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded-full">{school.program_type}</span>
                        <span className="bg-green-100 text-green-700 px-2 py-1 rounded-full">${school.tuition_total?.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upgrade CTA for Free Users */}
        {tier === 'free' && (
          <div className="bg-gradient-to-r from-purple-600 to-pink-600 rounded-2xl p-8 text-white">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-bold mb-2">🚀 Upgrade Your Plan</h3>
                <p className="text-white/80 mb-4">Unlock all premium filters and unlimited mock interviews!</p>
                <div className="flex gap-4">
                  <span className="text-sm bg-white/20 px-3 py-1 rounded-full">✓ All filters</span>
                  <span className="text-sm bg-white/20 px-3 py-1 rounded-full">✓ Unlimited interviews</span>
                  <span className="text-sm bg-white/20 px-3 py-1 rounded-full">✓ Voice support</span>
                </div>
              </div>
              <Link href="/pricing" className="bg-white text-purple-600 px-6 py-3 rounded-xl font-semibold hover:bg-gray-100 transition whitespace-nowrap">
                View Plans →
              </Link>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
