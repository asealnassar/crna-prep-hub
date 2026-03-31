'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function InterviewPrep() {
  const [schools, setSchools] = useState<any[]>([])
  const [interviewInfo, setInterviewInfo] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userTier, setUserTier] = useState('free')
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showRequestModal, setShowRequestModal] = useState(false)
  const [requestSchool, setRequestSchool] = useState('')
  const [requestNotes, setRequestNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false) 
  const [editingSchool, setEditingSchool] = useState<any>(null)
  const supabase = createClient()

  const isUltimate = userTier === 'ultimate'
  const previewSchools = ['AdventHealth University', 'Arkansas State University', 'Clarkson College']

  useEffect(() => {
    const init = async () => {
      const { data: schoolsData } = await supabase.from('schools').select('*').order('name')
      setSchools(schoolsData || [])

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

  const displaySchools = (isUltimate || isAdmin) ? filteredSchools : filteredSchools.filter(s => previewSchools.includes(s.name))
  const lockedSchools = (isUltimate || isAdmin) ? [] : filteredSchools.filter(s => !previewSchools.includes(s.name))

  if (loading) {
    return (<div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center"><div className="text-white text-xl">Loading...</div></div>)
  }

  if (!isLoggedIn) {
    return (
      <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
        <Sidebar isLoggedIn={false} userEmail="" isAdmin={false} onCollapsedChange={setSidebarCollapsed} />
        <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
          <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-4 sm:px-6 py-4 flex justify-end">
            <Link href="/login" className="px-4 py-2 bg-white text-purple-600 font-semibold rounded-lg hover:bg-gray-100 transition text-sm">Login</Link>
          </div>
          <div className="max-w-4xl mx-auto px-4 py-12 sm:py-16 text-center">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-4 sm:mb-6">School-Specific Interview Style</h1>
            <p className="text-base sm:text-lg lg:text-xl text-indigo-200 mb-6 sm:mb-8">Please log in to access interview prep materials.</p>
            <Link href="/login" className="inline-block px-6 sm:px-8 py-3 sm:py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition text-sm sm:text-base">Log In</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar isLoggedIn={isLoggedIn} userEmail={userEmail} isAdmin={isAdmin} onCollapsedChange={setSidebarCollapsed} />
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-4 sm:px-6 py-4 flex justify-end" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          <div className="mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-2">School-Specific Interview Style</h1>
            <p className="text-sm sm:text-base text-indigo-200">Real interview info, tips, and insider knowledge for {schools.length} CRNA programs</p>
          </div>

          {/* Notice Banner */}
          <div className="bg-yellow-500/20 border border-yellow-500/50 rounded-xl p-3 sm:p-4 mb-6 sm:mb-8">
            <div className="flex items-start gap-2 sm:gap-3">
              <span className="text-xl sm:text-2xl">🚧</span>
              <div>
                <h3 className="text-yellow-300 font-semibold text-sm sm:text-base">We're Building This Database</h3>
                <p className="text-yellow-200/80 text-xs sm:text-sm">This list is growing daily as we gather information from students and programs. Don't see info for your school? Request expedited info below!</p>
              </div>
            </div>
          </div>

          {/* Preview Banner for non-Ultimate users */}
          {!isUltimate && !isAdmin && (
            <div className="bg-purple-500/20 border border-purple-500/50 rounded-xl p-4 sm:p-6 mb-6 sm:mb-8">
              <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                <div>
                  <h3 className="text-purple-300 font-semibold text-base sm:text-lg">🔓 Preview Mode</h3>
                  <p className="text-purple-200/80 text-xs sm:text-sm">You're viewing 3 sample schools. Upgrade to Ultimate to unlock all {schools.length} schools!</p>
                </div>
                <Link href="/pricing" className="w-full md:w-auto text-center px-4 sm:px-6 py-2 sm:py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition whitespace-nowrap text-sm sm:text-base">
                  Upgrade to Ultimate
                </Link>
              </div>
            </div>
          )}

          {/* Search and Request */}
          <div className="bg-white rounded-2xl shadow-xl p-4 sm:p-6 mb-6 sm:mb-8">
            <div className="flex flex-col md:flex-row gap-3 sm:gap-4 items-stretch md:items-center">
              <div className="flex-1">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search schools..."
                  className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                />
              </div>
              <div className="flex gap-2">
                {isAdmin && (
                  <button
                    onClick={() => setEditingSchool({ school_name: '', interview_style: '', clinical_focus: '', emotional_focus: '', additional_notes: '' })}
                    className="flex-1 md:flex-none px-4 sm:px-6 py-2 sm:py-3 bg-green-500 text-white font-semibold rounded-xl hover:bg-green-600 transition whitespace-nowrap text-sm sm:text-base"
                  >
                    ➕ Add Info
                  </button>
                )}
                {(isUltimate || isAdmin) && (
                  <button
                    onClick={() => setShowRequestModal(true)}
                    className="flex-1 md:flex-none px-4 sm:px-6 py-2 sm:py-3 bg-gradient-to-r from-yellow-500 to-orange-500 text-white font-semibold rounded-xl hover:opacity-90 transition whitespace-nowrap text-sm sm:text-base"
                  >
                    🚀 Request Info
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Preview Schools Section Label */}
          {!isUltimate && !isAdmin && displaySchools.length > 0 && (
            <h2 className="text-lg sm:text-xl font-semibold text-white mb-4">📖 Sample Schools (3 of {schools.length})</h2>
          )}

          {/* Schools List - Unlocked */}
          <div className="space-y-4">
            {displaySchools.map((school) => {
              const info = getSchoolInfo(school.name)
              const hasInfo = info && info.interview_style && info.interview_style !== 'No information found'
              return (
                <div
                  key={school.id}
                  className="bg-white rounded-xl shadow-lg p-4 sm:p-6 hover:shadow-xl transition"
                >
                  <div className="flex flex-col sm:flex-row items-start justify-between gap-3 mb-3">
                    <div className="flex-1 w-full">
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 flex-wrap">
                        <h3 className="font-bold text-lg sm:text-xl text-gray-800">{school.name}</h3>
                        <span className="text-gray-500 text-xs sm:text-sm">📍 {school.location_city}, {school.location_state}</span>
                        {hasInfo ? (
                          <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full w-fit">Info Available</span>
                        ) : (
                          <span className="px-2 py-1 bg-gray-100 text-gray-500 text-xs font-semibold rounded-full w-fit">Coming Soon</span>
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
                        className="w-full sm:w-auto px-3 py-1 bg-blue-500 text-white text-xs sm:text-sm rounded-lg hover:bg-blue-600"
                      >
                        {hasInfo ? 'Edit' : 'Add Info'}
                      </button>
                    )}
                  </div>

                  {hasInfo ? (
                    <div className="space-y-2 sm:space-y-3 text-sm sm:text-base">
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
                    <p className="text-gray-500 italic text-sm sm:text-base">No information available yet.</p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Locked Schools Section for non-Ultimate */}
          {!isUltimate && !isAdmin && lockedSchools.length > 0 && (
            <div className="mt-6 sm:mt-8">
              <h2 className="text-lg sm:text-xl font-semibold text-white mb-4">🔒 Locked Schools ({lockedSchools.length} more)</h2>
              <div className="space-y-4">
                {lockedSchools.slice(0, 10).map((school) => (
                  <div
                    key={school.id}
                    className="bg-white/50 rounded-xl shadow-lg p-4 sm:p-6 relative overflow-hidden"
                  >
                    <div className="absolute inset-0 bg-white/70 backdrop-blur-sm flex items-center justify-center z-10">
                      <div className="text-center px-4">
                        <div className="text-3xl sm:text-4xl mb-2">🔒</div>
                        <p className="text-gray-700 font-semibold text-sm sm:text-base">Upgrade to Ultimate to unlock</p>
                      </div>
                    </div>
                    <div className="blur-sm">
                      <h3 className="font-bold text-lg sm:text-xl text-gray-800">{school.name}</h3>
                      <p className="text-sm sm:text-base text-gray-500">{school.location_city}, {school.location_state}</p>
                    </div>
                  </div>
                ))}
                {lockedSchools.length > 10 && (
                  <div className="text-center py-4">
                    <p className="text-sm sm:text-base text-indigo-200">...and {lockedSchools.length - 10} more schools</p>
                  </div>
                )}
              </div>
              
              {/* Upgrade CTA */}
              <div className="mt-6 sm:mt-8 bg-gradient-to-r from-purple-600 to-pink-600 rounded-2xl p-6 sm:p-8 text-center">
                <h3 className="text-xl sm:text-2xl font-bold text-white mb-2">Unlock All {schools.length} Schools</h3>
                <p className="text-sm sm:text-base text-white/80 mb-4 sm:mb-6">Get insider interview info for every CRNA program</p>
                <Link href="/pricing" className="inline-block bg-white text-purple-600 px-6 sm:px-8 py-3 sm:py-4 rounded-xl font-semibold hover:bg-gray-100 transition text-sm sm:text-base">
                  Upgrade to Ultimate - $49.99
                </Link>
              </div>
            </div>
          )}

          {filteredSchools.length === 0 && (
            <div className="text-center py-12">
              <p className="text-white text-base sm:text-lg">No schools match your search.</p>
            </div>
          )}
        </div>

        {/* Request Modal */}
        {showRequestModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-4 sm:p-6 max-h-[90vh] overflow-y-auto">
              {submitted ? (
                <div className="text-center py-4 sm:py-6">
                  <div className="text-4xl sm:text-5xl mb-4">🎉</div>
                  <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2">Request Submitted!</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">We'll prioritize gathering info for your school and notify you when it's ready.</p>
                  <button onClick={() => { setShowRequestModal(false); setSubmitted(false) }} className="px-4 sm:px-6 py-2 sm:py-3 bg-purple-600 text-white font-semibold rounded-xl hover:bg-purple-700 transition text-sm sm:text-base">Close</button>
                </div>
              ) : (
                <>
                  <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-2">Request Expedited Info</h3>
                  <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">Tell us which school you need interview info for and we'll prioritize it!</p>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">School Name *</label>
                      <input
                        type="text"
                        value={requestSchool}
                        onChange={(e) => setRequestSchool(e.target.value)}
                        placeholder="e.g., Duke University"
                        className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes (optional)</label>
                      <textarea
                        value={requestNotes}
                        onChange={(e) => setRequestNotes(e.target.value)}
                        placeholder="Any specific info you're looking for?"
                        rows={3}
                        className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                      />
                    </div>
                  </div>
                  <div className="flex gap-3 mt-4 sm:mt-6">
                    <button onClick={() => setShowRequestModal(false)} className="flex-1 py-2 sm:py-3 border border-gray-300 rounded-xl text-gray-700 font-semibold hover:bg-gray-50 transition text-sm sm:text-base">Cancel</button>
                    <button onClick={submitRequest} disabled={submitting} className="flex-1 py-2 sm:py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50 text-sm sm:text-base">{submitting ? 'Submitting...' : 'Submit Request'}</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Admin Edit Modal */}
        {editingSchool && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-4 sm:p-6 max-h-[90vh] overflow-y-auto">
              <h3 className="text-xl sm:text-2xl font-bold text-gray-800 mb-4">Edit Interview Info: {editingSchool.school_name}</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">School Name</label>
                  <input
                    type="text"
                    value={editingSchool.school_name}
                    onChange={(e) => setEditingSchool({ ...editingSchool, school_name: e.target.value })}
                    className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Interview Style</label>
                  <textarea
                    value={editingSchool.interview_style || ''}
                    onChange={(e) => setEditingSchool({ ...editingSchool, interview_style: e.target.value })}
                    rows={2}
                    placeholder="e.g., Heavily Clinical Based, Mostly EI, Mixed..."
                    className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Clinical Focus</label>
                  <textarea
                    value={editingSchool.clinical_focus || ''}
                    onChange={(e) => setEditingSchool({ ...editingSchool, clinical_focus: e.target.value })}
                    rows={2}
                    placeholder="Clinical questions, scenarios, topics covered..."
                    className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Emotional/EI Focus</label>
                  <textarea
                    value={editingSchool.emotional_focus || ''}
                    onChange={(e) => setEditingSchool({ ...editingSchool, emotional_focus: e.target.value })}
                    rows={2}
                    placeholder="EI questions, personality assessment..."
                    className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
                  <textarea
                    value={editingSchool.additional_notes || ''}
                    onChange={(e) => setEditingSchool({ ...editingSchool, additional_notes: e.target.value })}
                    rows={3}
                    placeholder="Panel size, special requirements, tips..."
                    className="w-full px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm sm:text-base"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-4 sm:mt-6">
                <button onClick={() => setEditingSchool(null)} className="flex-1 py-2 sm:py-3 border border-gray-300 rounded-xl text-gray-700 font-semibold hover:bg-gray-50 transition text-sm sm:text-base">Cancel</button>
                <button onClick={saveSchoolEdit} disabled={submitting || !editingSchool.school_name} className="flex-1 py-2 sm:py-3 bg-green-500 text-white font-semibold rounded-xl hover:bg-green-600 transition disabled:opacity-50 text-sm sm:text-base">{submitting ? 'Saving...' : 'Save'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
