'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'

export default function InterviewPrep() {
  const [schools, setSchools] = useState<any[]>([])
  const [filteredSchools, setFilteredSchools] = useState<any[]>([])
  const [selectedSchool, setSelectedSchool] = useState<any>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [userTier, setUserTier] = useState('free')
  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const isUltimate = userTier === 'ultimate'

  const sampleSchools = [
    'Arkansas State University'
  ]

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setIsLoggedIn(true)
        setUserId(user.id)
        setUserEmail(user.email || '')
        const { data: profile } = await supabase.from('user_profiles').select('subscription_tier').eq('id', user.id).single()
        if (profile) {
          setUserTier(profile.subscription_tier || 'free')
        }
      }

      const { data: schoolsData } = await supabase
        .from('school_interview_info')
        .select('*')
        .order('school_name')

      if (schoolsData) {
        setSchools(schoolsData)
        setFilteredSchools(schoolsData)
      }
      setLoading(false)
    }
    init()
  }, [])

  useEffect(() => {
    if (searchQuery.trim() === '') {
      setFilteredSchools(schools)
    } else {
      const filtered = schools.filter(school =>
        school.school_name.toLowerCase().includes(searchQuery.toLowerCase())
      )
      setFilteredSchools(filtered)
    }
  }, [searchQuery, schools])

  const getAccessibleSchools = () => {
    if (isUltimate) {
      return filteredSchools
    }
    return filteredSchools.filter(school => sampleSchools.includes(school.school_name))
  }

  const accessibleSchools = getAccessibleSchools()

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className="bg-gradient-to-r from-yellow-500 to-orange-500 py-3 text-center">
        <a href="/interview-prep" className="text-black font-semibold hover:underline">🚀 NEW: School-Specific Interview Style is NOW LIVE for Ultimate members →</a>
      </div>

      <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Link href="/">
                <h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1>
              </Link>
              <Link href="/sponsors" className="text-yellow-400 hover:text-yellow-300 text-sm font-medium">
                Sponsors
              </Link>
            </div>
            <div className="flex gap-6">
              {isLoggedIn && (
                <Link href="/dashboard" className="text-white/80 hover:text-white transition">
                  Dashboard
                </Link>
              )}
              <Link href="/schools" className="text-white/80 hover:text-white transition">
                Schools
              </Link>
              <Link href="/interview" className="text-white/80 hover:text-white transition">
                Mock Interview
              </Link>
              <Link href="/interview-prep" className="text-white font-semibold">
                School-Specific Interview Style
              </Link>
              <Link href="/pricing" className="text-white/80 hover:text-white transition">
                Pricing
              </Link>
              {isLoggedIn && userEmail === 'asealnassar@gmail.com' && (
                <Link href="/admin/schools" className="text-yellow-400 hover:text-yellow-300 transition">
                  Admin
                </Link>
              )}
              {!isLoggedIn && (
                <Link href="/login" className="px-4 py-2 bg-white text-purple-600 font-semibold rounded-lg hover:bg-gray-100 transition">
                  Login
                </Link>
              )}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">School-Specific Interview Style</h1>
          <p className="text-indigo-200">Learn how each CRNA program conducts interviews</p>
          {!isUltimate && (
            <div className="mt-4 inline-block bg-yellow-500/20 border border-yellow-500/50 rounded-lg px-6 py-3">
              <p className="text-yellow-200 font-semibold">🔒 Upgrade to Ultimate to unlock all {schools.length}+ schools</p>
            </div>
          )}
        </div>

        {!selectedSchool ? (
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="mb-6">
              <input
                type="text"
                placeholder="Search schools..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            {!isUltimate && (
              <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-blue-800 text-sm">
                  <strong>Preview Mode:</strong> You're viewing {sampleSchools.length} sample school. Upgrade to Ultimate to unlock all {schools.length}+ schools with interview details.
                </p>
              </div>
            )}

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[600px] overflow-y-auto">
              {accessibleSchools.map((school) => (
                <button
                  key={school.id}
                  onClick={() => setSelectedSchool(school)}
                  className="p-4 border-2 border-gray-200 rounded-xl hover:border-purple-500 hover:bg-purple-50 transition text-left"
                >
                  <h3 className="font-semibold text-gray-800 text-sm">{school.school_name}</h3>
                  {school.interview_style && (
                    <p className="text-xs text-gray-600 mt-1">{school.interview_style}</p>
                  )}
                </button>
              ))}
            </div>

            {filteredSchools.length > accessibleSchools.length && !isUltimate && (
              <div className="mt-8 text-center">
                <div className="mb-4 p-6 bg-gradient-to-r from-purple-50 to-pink-50 rounded-xl border-2 border-purple-200">
                  <p className="text-gray-700 font-semibold mb-2">
                    🔒 {filteredSchools.length - accessibleSchools.length} more schools locked
                  </p>
                  <p className="text-gray-600 text-sm">
                    Upgrade to Ultimate to access all school-specific interview details
                  </p>
                </div>
                <Link
                  href="/pricing"
                  className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
                >
                  Upgrade to Ultimate
                </Link>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <button
              onClick={() => setSelectedSchool(null)}
              className="mb-6 text-purple-600 hover:text-purple-700 font-semibold"
            >
              ← Back to Schools
            </button>

            <h2 className="text-3xl font-bold text-gray-800 mb-6">{selectedSchool.school_name}</h2>

            <div className="space-y-6">
              {selectedSchool.interview_style && (
                <div>
                  <h3 className="text-xl font-semibold text-gray-800 mb-2">Interview Style</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{selectedSchool.interview_style}</p>
                </div>
              )}

              {selectedSchool.typical_questions && (
                <div>
                  <h3 className="text-xl font-semibold text-gray-800 mb-2">Typical Questions</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{selectedSchool.typical_questions}</p>
                </div>
              )}

              {selectedSchool.panel_composition && (
                <div>
                  <h3 className="text-xl font-semibold text-gray-800 mb-2">Panel Composition</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{selectedSchool.panel_composition}</p>
                </div>
              )}

              {selectedSchool.interview_length && (
                <div>
                  <h3 className="text-xl font-semibold text-gray-800 mb-2">Interview Length</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{selectedSchool.interview_length}</p>
                </div>
              )}

              {selectedSchool.preparation_tips && (
                <div>
                  <h3 className="text-xl font-semibold text-gray-800 mb-2">Preparation Tips</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{selectedSchool.preparation_tips}</p>
                </div>
              )}

              {selectedSchool.additional_notes && (
                <div>
                  <h3 className="text-xl font-semibold text-gray-800 mb-2">Additional Notes</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{selectedSchool.additional_notes}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

