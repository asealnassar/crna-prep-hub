'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function InterviewPrep() {
  const [schools, setSchools] = useState<any[]>([])
  const [interviewInfo, setInterviewInfo] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userTier, setUserTier] = useState('free')
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSchool, setSelectedSchool] = useState<any>(null)
  const [showRequestModal, setShowRequestModal] = useState(false)
  const [requestSchool, setRequestSchool] = useState('')
  const [requestNotes, setRequestNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [editingSchool, setEditingSchool] = useState<any>(null)
  const supabase = createClient()

  const isUltimate = userTier === 'ultimate'

  useEffect(() => {
    const init = async () => {
      // Get all schools
      const { data: schoolsData } = await supabase.from('schools').select('*').order('name')
      setSchools(schoolsData || [])

      // Get interview info
      const { data: infoData } = await supabase.from('school_interview_info').select('*')
      setInterviewInfo(infoData || [])

      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        setIsLoggedIn(true)
        setUserEmail(user.email || '')
        setIsAdmin(user.email === 'asealnassar@gmail.com')
        const { data: profile } = await supabase.from('user_profiles').select('subscription_tier').eq('id', user.id).single()
        if (profile) { setUserTier(profile.subscription_tier || 'free') }
      }
      setLoading(false)
    }
    init()
  }, [])

  const getSchoolInfo = (schoolName: string) => {
    return interviewInfo.find(info => 
      info.school_name?.toLowerCase().trim() === schoolName?.toLowerCase().trim()
    )
  }

  const submitRequest = async () => {
    if (!requestSchool.trim()) { alert('Please enter a school name'); return }
    setSubmitting(true)
    await supabase.from('expedited_requests').insert({
      user_email: userEmail,
      school_name: requestSchool,
      notes: requestNotes
    })
    setSubmitting(false)
    setSubmitted(true)
    setRequestSchool('')
    setRequestNotes('')
  }

  const saveSchoolEdit = async () => {
    if (!editingSchool) return
    setSubmitting(true)
    
    // Check if info already exists for this school
    const existing = interviewInfo.find(i => i.school_name?.toLowerCase() === editingSchool.school_name?.toLowerCase())
    
    if (existing) {
      await supabase.from('school_interview_info').update({
        interview_style: editingSchool.interview_style,
        clinical_focus: editingSchool.clinical_focus,
        emotional_focus: editingSchool.emotional_focus,
        additional_notes: editingSchool.additional_notes,
        last_updated: new Date().toISOString()
      }).eq('id', existing.id)
    } else {
      await supabase.from('school_interview_info').insert({
        school_name: editingSchool.school_name,
        interview_style: editingSchool.interview_style,
        clinical_focus: editingSchool.clinical_focus,
        emotional_focus: editingSchool.emotional_focus,
        additional_notes: editingSchool.additional_notes
      })
    }
    
    const { data: infoData } = await supabase.from('school_interview_info').select('*')
    setInterviewInfo(infoData || [])
    setEditingSchool(null)
    setSubmitting(false)
  }

  const filteredSchools = schools.filter(school => 
    school.name?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  if (loading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
        <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
          <div className="max-w-7xl mx-auto px-4 py-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-4">
                <Link href="/"><h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1></Link>
                <Link href="/sponsors" className="text-yellow-400 hover:text-yellow-300 text-sm font-medium">Sponsors</Link>
              </div>
              <div className="flex gap-6">
                <Link href="/schools" className="text-white/80 hover:text-white transition">Schools</Link>
                <Link href="/interview" className="text-white/80 hover:text-white transition">Mock Interview</Link>
                <Link href="/interview-prep" className="text-white font-semibold">School-Specific Interview Style</Link>
                <Link href="/pricing" className="text-white/80 hover:text-white transition">Pricing</Link>
                <Link href="/login" className="px-4 py-2 bg-white text-purple-600 font-semibold rounded-lg hover:bg-gray-100 transition">Login</Link>
              </div>
            </div>
          </div>
        </nav>
        <div className="max-w-4xl mx-auto px-4 py-16 text-center">
          <h1 className="text-4xl font-bold text-white mb-6">School-Specific Interview Style</h1>
          <p className="text-xl text-indigo-200 mb-8">Please log in to access interview prep materials.</p>
          <Link href="/login" className="px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Log In</Link>
        </div>
      </div>
    )
  }

  if (!isUltimate && !isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
        <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
          <div className="max-w-7xl mx-auto px-4 py-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-4">
                <Link href="/"><h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1></Link>
                <Link href="/sponsors" className="text-yellow-400 hover:text-yellow-300 text-sm font-medium">Sponsors</Link>
              </div>
              <div className="flex gap-6">
                <Link href="/dashboard" className="text-white/80 hover:text-white transition">Dashboard</Link>
                <Link href="/schools" className="text-white/80 hover:text-white transition">Schools</Link>
                <Link href="/interview" className="text-white/80 hover:text-white transition">Mock Interview</Link>
                <Link href="/interview-prep" className="text-white font-semibold">School-Specific Interview Style</Link>
                <Link href="/pricing" className="text-white/80 hover:text-white transition">Pricing</Link>
              </div>
            </div>
          </div>
        </nav>
        <div className="max-w-4xl mx-auto px-4 py-16 text-center">
          <div className="text-6xl mb-6">🔒</div>
          <h1 className="text-4xl font-bold text-white mb-6">Ultimate Feature</h1>
          <p className="text-xl text-indigo-200 mb-4">School-Specific Interview Style is exclusively available for Ultimate members.</p>
          <p className="text-indigo-300 mb-8">Get real interview questions, tips from current students, and insider info for every CRNA program.</p>
          <Link href="/pricing" className="px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition">Upgrade to Ultimate - $49.99</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Link href="/"><h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1></Link>
              <Link href="/sponsors" className="text-yellow-400 hover:text-yellow-300 text-sm font-medium">Sponsors</Link>
            </div>
            <div className="flex gap-6">
              <Link href="/dashboard" className="text-white/80 hover:text-white transition">Dashboard</Link>
              <Link href="/schools" className="text-white/80 hover:text-white transition">Schools</Link>
              <Link href="/interview" className="text-white/80 hover:text-white transition">Mock Interview</Link>
              <Link href="/interview-prep" className="text-white font-semibold">School-Specific Interview Style</Link>
              <Link href="/pricing" className="text-white/80 hover:text-white transition">Pricing</Link>
              {isAdmin && <Link href="/admin/schools" className="text-yellow-400 hover:text-yellow-300 transition">Admin</Link>}
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">School-Specific Interview Style</h1>
          <p className="text-indigo-200">Real interview info, tips, and insider knowledge for {schools.length} CRNA programs</p>
        </div>

        {/* Notice Banner */}
        <div className="bg-yellow-500/20 border border-yellow-500/50 rounded-xl p-4 mb-8">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🚧</span>
            <div>
              <h3 className="text-yellow-300 font-semibold">We're Building This Database</h3>
              <p className="text-yellow-200/80 text-sm">This list is growing daily as we gather information from students and programs. Don't see info for your school? Request expedited info below!</p>
            </div>
          </div>
        </div>

        {/* Search and Request */}
        <div className="bg-white rounded-2xl shadow-xl p-6 mb-8">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex-1 w-full">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search schools..."
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
            <div className="flex gap-2">
              {isAdmin && (
                <button
                  onClick={() => setEditingSchool({ school_name: '', interview_style: '', clinical_focus: '', emotional_focus: '', additional_notes: '' })}
                  className="px-6 py-3 bg-green-500 text-white font-semibold rounded-xl hover:bg-green-600 transition whitespace-nowrap"
                >
                  ➕ Add Info
                </button>
              )}
              <button
                onClick={() => setShowRequestModal(true)}
                className="px-6 py-3 bg-gradient-to-r from-yellow-500 to-orange-500 text-white font-semibold rounded-xl hover:opacity-90 transition whitespace-nowrap"
              >
                🚀 Request Expedited Info
              </button>
            </div>
          </div>
        </div>

        {/* Schools List */}
        <div className="space-y-4">
          {filteredSchools.map((school) => {
            const info = getSchoolInfo(school.name)
            const hasInfo = info && info.interview_style && info.interview_style !== 'No information found'
            return (
              <div
                key={school.id}
                className="bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <h3 className="font-bold text-xl text-gray-800">{school.name}</h3>
                      <span className="text-gray-500 text-sm">📍 {school.location_city}, {school.location_state}</span>
                      {hasInfo ? (
                        <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full">Info Available</span>
                      ) : (
                        <span className="px-2 py-1 bg-gray-100 text-gray-500 text-xs font-semibold rounded-full">Coming Soon</span>
                      )}
                    </div>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => setEditingSchool({
                        school_name: school.name,
                        interview_style: info?.interview_style || '',
                        clinical_focus: info?.clinical_focus || '',
                        emotional_focus: info?.emotional_focus || '',
                        additional_notes: info?.additional_notes || ''
                      })}
                      className="px-3 py-1 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600"
                    >
                      {hasInfo ? 'Edit' : 'Add Info'}
                    </button>
                  )}
                </div>

                {hasInfo ? (
                  <div className="space-y-3">
                    <div>
                      <span className="text-purple-600 font-semibold">🎯 Interview Style: </span>
                      <span className="text-gray-700">{info.interview_style}</span>
                    </div>
                    {info.clinical_focus && (
                      <div>
                        <span className="text-blue-600 font-semibold">🏥 Clinical Focus: </span>
                        <span className="text-gray-700">{info.clinical_focus}</span>
                      </div>
                    )}
                    {info.emotional_focus && (
                      <div>
                        <span className="text-pink-600 font-semibold">💭 Emotional/EI Focus: </span>
                        <span className="text-gray-700">{info.emotional_focus}</span>
                      </div>
                    )}
                    {info.additional_notes && (
                      <div>
                        <span className="text-orange-600 font-semibold">📝 Additional Notes: </span>
                        <span className="text-gray-700">{info.additional_notes}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-500 italic">No information available yet. Click "Request Expedited Info" if you need this school prioritized!</p>
                )}
              </div>
            )
          })}
        </div>

        {filteredSchools.length === 0 && (
          <div className="text-center py-12">
            <p className="text-white text-lg">No schools match your search.</p>
          </div>
        )}
      </div>

      {/* Request Modal */}
      {showRequestModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            {submitted ? (
              <div className="text-center py-6">
                <div className="text-5xl mb-4">🎉</div>
                <h3 className="text-2xl font-bold text-gray-800 mb-2">Request Submitted!</h3>
                <p className="text-gray-600 mb-6">We'll prioritize gathering info for your school and notify you when it's ready.</p>
                <button onClick={() => { setShowRequestModal(false); setSubmitted(false) }} className="px-6 py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 transition">Close</button>
              </div>
            ) : (
              <>
                <h3 className="text-2xl font-bold text-gray-800 mb-2">Request Expedited Info</h3>
                <p className="text-gray-600 mb-6">Tell us which school you need interview info for and we'll prioritize it!</p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">School Name *</label>
                    <input
                      type="text"
                      value={requestSchool}
                      onChange={(e) => setRequestSchool(e.target.value)}
                      placeholder="e.g., Duke University"
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes (optional)</label>
                    <textarea
                      value={requestNotes}
                      onChange={(e) => setRequestNotes(e.target.value)}
                      placeholder="Any specific info you're looking for?"
                      rows={3}
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                </div>
                <div className="flex gap-3 mt-6">
                  <button onClick={() => setShowRequestModal(false)} className="flex-1 py-3 border border-gray-300 rounded-xl text-gray-700 font-semibold hover:bg-gray-50 transition">Cancel</button>
                  <button onClick={submitRequest} disabled={submitting} className="flex-1 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50">{submitting ? 'Submitting...' : 'Submit Request'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Admin Edit Modal */}
      {editingSchool && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-2xl font-bold text-gray-800 mb-4">Edit Interview Info: {editingSchool.school_name}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">School Name</label>
                <input
                  type="text"
                  value={editingSchool.school_name}
                  onChange={(e) => setEditingSchool({ ...editingSchool, school_name: e.target.value })}
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Interview Style</label>
                <textarea
                  value={editingSchool.interview_style || ''}
                  onChange={(e) => setEditingSchool({ ...editingSchool, interview_style: e.target.value })}
                  rows={2}
                  placeholder="e.g., Heavily Clinical Based, Mostly EI, Mixed..."
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Clinical Focus</label>
                <textarea
                  value={editingSchool.clinical_focus || ''}
                  onChange={(e) => setEditingSchool({ ...editingSchool, clinical_focus: e.target.value })}
                  rows={2}
                  placeholder="Clinical questions, scenarios, topics covered..."
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Emotional/EI Focus</label>
                <textarea
                  value={editingSchool.emotional_focus || ''}
                  onChange={(e) => setEditingSchool({ ...editingSchool, emotional_focus: e.target.value })}
                  rows={2}
                  placeholder="EI questions, personality assessment..."
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
                <textarea
                  value={editingSchool.additional_notes || ''}
                  onChange={(e) => setEditingSchool({ ...editingSchool, additional_notes: e.target.value })}
                  rows={3}
                  placeholder="Panel size, special requirements, tips..."
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setEditingSchool(null)} className="flex-1 py-3 border border-gray-300 rounded-xl text-gray-700 font-semibold hover:bg-gray-50 transition">Cancel</button>
              <button onClick={saveSchoolEdit} disabled={submitting || !editingSchool.school_name} className="flex-1 py-3 bg-green-500 text-white font-semibold rounded-xl hover:bg-green-600 transition disabled:opacity-50">{submitting ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
