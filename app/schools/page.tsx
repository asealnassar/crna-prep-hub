'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'

export default function Schools() {
  const [schools, setSchools] = useState<any[]>([])
  const [filteredSchools, setFilteredSchools] = useState<any[]>([])
  const [savedSchools, setSavedSchools] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [userTier, setUserTier] = useState('free')
  const [userId, setUserId] = useState<string | null>(null)
  
  const [searchQuery, setSearchQuery] = useState('')
  const [gpaFilter, setGpaFilter] = useState('')
  const [minTuition, setMinTuition] = useState('')
  const [maxTuition, setMaxTuition] = useState('')
  const [frontLoadedFilter, setFrontLoadedFilter] = useState('')
  
  const [stateFilter, setStateFilter] = useState('')
  const [programTypeFilter, setProgramTypeFilter] = useState('')
  const [opensMonthFilter, setOpensMonthFilter] = useState('')
  const [deadlineMonthFilter, setDeadlineMonthFilter] = useState('')
  const [greFilter, setGreFilter] = useState('')
  const [methodFilter, setMethodFilter] = useState('')
  const [formatFilter, setFormatFilter] = useState('')
  const [prereqsRequired, setPrereqsRequired] = useState<string[]>([])
  const [prereqsNotRequired, setPrereqsNotRequired] = useState<string[]>([])

  const router = useRouter()
  const supabase = createClient()

  const isPremium = userTier === 'premium' || userTier === 'ultimate'

  const allPrereqs = ['Anatomy & Physiology', 'Microbiology', 'Chemistry', 'Organic Chemistry', 'Biochemistry', 'Statistics', 'Research', 'Pharmacology', 'Physics']

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user) {
        router.push('/login')
        return
      }

      setUserId(user.id)

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', user.id)
        .single()

      if (profile) {
        setUserTier(profile.subscription_tier || 'free')
      }

      const { data: schoolsData } = await supabase
        .from('schools')
        .select('*')
        .order('name')

      setSchools(schoolsData || [])
      setFilteredSchools(schoolsData || [])

      const { data: savedData } = await supabase
        .from('saved_schools')
        .select('school_id')
        .eq('user_id', user.id)

      if (savedData) {
        setSavedSchools(savedData.map(s => s.school_id))
      }

      setLoading(false)
    }

    init()
  }, [])

  const toggleSaveSchool = async (schoolId: string) => {
    if (!userId) return

    if (savedSchools.includes(schoolId)) {
      await supabase
        .from('saved_schools')
        .delete()
        .eq('user_id', userId)
        .eq('school_id', schoolId)
      
      setSavedSchools(savedSchools.filter(id => id !== schoolId))
    } else {
      await supabase
        .from('saved_schools')
        .insert({ user_id: userId, school_id: schoolId })
      
      setSavedSchools([...savedSchools, schoolId])
    }
  }

  useEffect(() => {
    let filtered = [...schools]

    if (searchQuery) {
      filtered = filtered.filter(school => 
        school.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
        school.location_city.toLowerCase().includes(searchQuery.toLowerCase()) || 
        school.location_state.toLowerCase().includes(searchQuery.toLowerCase())
      )
    }

    if (gpaFilter) {
      filtered = filtered.filter(school => school.gpa_requirement <= parseFloat(gpaFilter))
    }

    if (minTuition) {
      filtered = filtered.filter(school => school.tuition_total >= parseFloat(minTuition))
    }
    if (maxTuition) {
      filtered = filtered.filter(school => school.tuition_total <= parseFloat(maxTuition))
    }

    if (frontLoadedFilter) {
      filtered = filtered.filter(school => school.front_loaded === frontLoadedFilter)
    }

    if (isPremium) {
      if (stateFilter) {
        filtered = filtered.filter(school => school.location_state === stateFilter)
      }
      if (programTypeFilter) {
        filtered = filtered.filter(school => school.program_type === programTypeFilter)
      }
      if (opensMonthFilter) {
        filtered = filtered.filter(school => school.application_opens_month && school.application_opens_month.includes(opensMonthFilter))
      }
      if (deadlineMonthFilter) {
        filtered = filtered.filter(school => school.application_deadline && school.application_deadline.includes(deadlineMonthFilter))
      }
      if (greFilter) {
        filtered = filtered.filter(school => school.gre_requirement === greFilter)
      }
      if (methodFilter) {
        filtered = filtered.filter(school => school.application_method === methodFilter)
      }
      if (formatFilter) {
        if (formatFilter === 'In-Person') {
          filtered = filtered.filter(school => school.format && school.format.toLowerCase() === 'in-person')
        } else if (formatFilter === 'Hybrid') {
          filtered = filtered.filter(school => school.format && school.format.toLowerCase() !== 'in-person')
        }
      }
      if (prereqsRequired.length > 0) {
        filtered = filtered.filter(school => {
          if (!school.prerequisites_required) return false
          return prereqsRequired.every(prereq => 
            school.prerequisites_required.toLowerCase().includes(prereq.toLowerCase())
          )
        })
      }
      if (prereqsNotRequired.length > 0) {
        filtered = filtered.filter(school => {
          if (!school.prerequisites_not_required) return false
          return prereqsNotRequired.every(prereq => 
            school.prerequisites_not_required.toLowerCase().includes(prereq.toLowerCase())
          )
        })
      }
    }

    setFilteredSchools(filtered)
  }, [searchQuery, gpaFilter, minTuition, maxTuition, frontLoadedFilter, stateFilter, programTypeFilter, opensMonthFilter, deadlineMonthFilter, greFilter, methodFilter, formatFilter, prereqsRequired, prereqsNotRequired, schools, isPremium])

  const togglePrereqRequired = (prereq: string) => {
    if (prereqsRequired.includes(prereq)) {
      setPrereqsRequired(prereqsRequired.filter(p => p !== prereq))
    } else {
      setPrereqsRequired([...prereqsRequired, prereq])
    }
  }

  const togglePrereqNotRequired = (prereq: string) => {
    if (prereqsNotRequired.includes(prereq)) {
      setPrereqsNotRequired(prereqsNotRequired.filter(p => p !== prereq))
    } else {
      setPrereqsNotRequired([...prereqsNotRequired, prereq])
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    )
  }

  const states = [...new Set(schools.map(s => s.location_state))].sort()
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <Link href="/"><h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1></Link>
            <div className="flex gap-6">
              <Link href="/dashboard" className="text-white/80 hover:text-white transition">Dashboard</Link>
              <Link href="/schools" className="text-white font-semibold">Schools</Link>
              <Link href="/interview" className="text-white/80 hover:text-white transition">Mock Interview</Link>
              <Link href="/pricing" className="text-white/80 hover:text-white transition">Pricing</Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">CRNA School Database</h1>
          <p className="text-indigo-200">Browse and filter {schools.length} CRNA programs</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-800 mb-4">Filters</h2>
          
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-green-600 mb-3">✅ Free Filters</h3>
            
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Search Schools</label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="e.g., Duke, Chicago, CA..."
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            <div className="grid md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Max GPA Requirement</label>
                <input
                  type="number"
                  step="0.1"
                  min="2.0"
                  max="4.0"
                  value={gpaFilter}
                  onChange={(e) => setGpaFilter(e.target.value)}
                  placeholder="e.g., 3.5"
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Min Tuition</label>
                <input
                  type="number"
                  step="1000"
                  value={minTuition}
                  onChange={(e) => setMinTuition(e.target.value)}
                  placeholder="e.g., 80000"
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Max Tuition</label>
                <input
                  type="number"
                  step="1000"
                  value={maxTuition}
                  onChange={(e) => setMaxTuition(e.target.value)}
                  placeholder="e.g., 150000"
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Front Loaded</label>
                <select
                  value={frontLoadedFilter}
                  onChange={(e) => setFrontLoadedFilter(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="">All</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                  <option value="Integrated">Integrated</option>
                </select>
              </div>
            </div>
          </div>

          <div className="border-t pt-6">
            <h3 className="text-lg font-semibold text-purple-600 mb-3">
              {isPremium ? '✅ Premium Filters (Unlocked!)' : '🔒 Premium Filters'}
            </h3>
            
            <div className="grid md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">State</label>
                <select
                  value={stateFilter}
                  onChange={(e) => setStateFilter(e.target.value)}
                  disabled={!isPremium}
                  className={`w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${!isPremium ? 'bg-gray-100 opacity-60' : ''}`}
                >
                  <option value="">{isPremium ? 'All States' : 'Locked'}</option>
                  {isPremium && states.map(state => (
                    <option key={state} value={state}>{state}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Program Type</label>
                <select
                  value={programTypeFilter}
                  onChange={(e) => setProgramTypeFilter(e.target.value)}
                  disabled={!isPremium}
                  className={`w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${!isPremium ? 'bg-gray-100 opacity-60' : ''}`}
                >
                  <option value="">{isPremium ? 'All Types' : 'Locked'}</option>
                  {isPremium && (
                    <>
                      <option value="DNP">DNP</option>
                      <option value="MSN">MSN</option>
                    </>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Format</label>
                <select
                  value={formatFilter}
                  onChange={(e) => setFormatFilter(e.target.value)}
                  disabled={!isPremium}
                  className={`w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${!isPremium ? 'bg-gray-100 opacity-60' : ''}`}
                >
                  <option value="">{isPremium ? 'All Formats' : 'Locked'}</option>
                  {isPremium && (
                    <>
                      <option value="In-Person">In-Person</option>
                      <option value="Hybrid">Hybrid (mixed)</option>
                    </>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Application Opens</label>
                <select
                  value={opensMonthFilter}
                  onChange={(e) => setOpensMonthFilter(e.target.value)}
                  disabled={!isPremium}
                  className={`w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${!isPremium ? 'bg-gray-100 opacity-60' : ''}`}
                >
                  <option value="">{isPremium ? 'All Months' : 'Locked'}</option>
                  {isPremium && months.map(month => (
                    <option key={month} value={month}>{month}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Application Deadline</label>
                <select
                  value={deadlineMonthFilter}
                  onChange={(e) => setDeadlineMonthFilter(e.target.value)}
                  disabled={!isPremium}
                  className={`w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${!isPremium ? 'bg-gray-100 opacity-60' : ''}`}
                >
                  <option value="">{isPremium ? 'All Months' : 'Locked'}</option>
                  {isPremium && months.map(month => (
                    <option key={month} value={month}>{month}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">GRE Requirement</label>
                <select
                  value={greFilter}
                  onChange={(e) => setGreFilter(e.target.value)}
                  disabled={!isPremium}
                  className={`w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${!isPremium ? 'bg-gray-100 opacity-60' : ''}`}
                >
                  <option value="">{isPremium ? 'All' : 'Locked'}</option>
                  {isPremium && (
                    <>
                      <option value="Required">Required</option>
                      <option value="Not Required">Not Required</option>
                    </>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Application Method</label>
                <select
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value)}
                  disabled={!isPremium}
                  className={`w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 ${!isPremium ? 'bg-gray-100 opacity-60' : ''}`}
                >
                  <option value="">{isPremium ? 'All Methods' : 'Locked'}</option>
                  {isPremium && (
                    <>
                      <option value="Direct">Direct</option>
                      <option value="NursingCAS">NursingCAS</option>
                      <option value="Both">Both</option>
                    </>
                  )}
                </select>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4 mt-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">What is Required</label>
                <div className={`p-4 border rounded-xl ${!isPremium ? 'bg-gray-100 opacity-60' : 'bg-gray-50'}`}>
                  {!isPremium ? (
                    <p className="text-gray-500 text-sm">Locked - Upgrade to Premium</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allPrereqs.map(prereq => (
                        <button
                          key={prereq}
                          onClick={() => togglePrereqRequired(prereq)}
                          className={`px-3 py-1 rounded-full text-sm transition ${
                            prereqsRequired.includes(prereq)
                              ? 'bg-purple-600 text-white'
                              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                          }`}
                        >
                          {prereq}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">What is NOT Required</label>
                <div className={`p-4 border rounded-xl ${!isPremium ? 'bg-gray-100 opacity-60' : 'bg-gray-50'}`}>
                  {!isPremium ? (
                    <p className="text-gray-500 text-sm">Locked - Upgrade to Premium</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allPrereqs.map(prereq => (
                        <button
                          key={prereq}
                          onClick={() => togglePrereqNotRequired(prereq)}
                          className={`px-3 py-1 rounded-full text-sm transition ${
                            prereqsNotRequired.includes(prereq)
                              ? 'bg-green-600 text-white'
                              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                          }`}
                        >
                          {prereq}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {!isPremium && (
              <Link href="/pricing" className="block mt-4 p-4 bg-gradient-to-r from-purple-100 to-pink-100 border border-purple-300 rounded-xl hover:from-purple-200 hover:to-pink-200 transition">
                <p className="text-sm text-purple-800">
                  🔒 <strong>Unlock all premium filters for $29.99!</strong> Filter by application dates, GRE requirements, application methods, location, and more. <span className="underline">Click here to upgrade →</span>
                </p>
              </Link>
            )}
          </div>
        </div>

        <div className="flex justify-between items-center mb-6">
          <p className="text-indigo-200">
            Showing <strong className="text-white">{filteredSchools.length}</strong> of {schools.length} schools
          </p>
          <p className="text-pink-300 font-semibold">❤️ {savedSchools.length} schools saved</p>
        </div>

        <div className="flex flex-col gap-6">
          {filteredSchools.map((school) => (
            <div key={school.id} className="bg-white rounded-2xl shadow-xl p-6 hover:shadow-2xl transition relative border-l-4 border-purple-500">
              <button
                onClick={() => toggleSaveSchool(school.id)}
                className="absolute top-4 right-4 text-2xl hover:scale-125 transition"
              >
                {savedSchools.includes(school.id) ? '❤️' : '🤍'}
              </button>

              <div className="flex items-start gap-4">
                <div className="w-14 h-14 bg-gradient-to-br from-purple-600 to-pink-500 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-lg">
                  {school.name.charAt(0)}
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-bold text-gray-800 mb-1">{school.name}</h3>
                  <p className="text-gray-500">📍 {school.location_city}, {school.location_state}</p>
                </div>
              </div>
              
              <div className="grid grid-cols-4 gap-3 text-sm mt-5">
                <div className="bg-purple-50 rounded-lg p-3">
                  <span className="text-purple-600 text-xs font-medium">GPA</span>
                  <p className="text-gray-800 font-bold">{school.gpa_requirement}</p>
                </div>
                <div className="bg-blue-50 rounded-lg p-3">
                  <span className="text-blue-600 text-xs font-medium">Program</span>
                  <p className="text-gray-800 font-bold">{school.program_type}</p>
                </div>
                <div className="bg-green-50 rounded-lg p-3">
                  <span className="text-green-600 text-xs font-medium">Length</span>
                  <p className="text-gray-800 font-bold">{school.program_length_months} months</p>
                </div>
                <div className="bg-orange-50 rounded-lg p-3">
                  <span className="text-orange-600 text-xs font-medium">ICU</span>
                  <p className="text-gray-800 font-bold">{school.icu_experience_months} months</p>
                </div>
                <div className="bg-pink-50 rounded-lg p-3">
                  <span className="text-pink-600 text-xs font-medium">Tuition</span>
                  <p className="text-gray-800 font-bold">${school.tuition_total?.toLocaleString()}</p>
                </div>
                <div className="bg-indigo-50 rounded-lg p-3">
                  <span className="text-indigo-600 text-xs font-medium">Format</span>
                  <p className="text-gray-800 font-bold">{school.format || 'N/A'}</p>
                </div>
                <div className="bg-red-50 rounded-lg p-3">
                  <span className="text-red-600 text-xs font-medium">Deadline</span>
                  <p className="text-gray-800 font-bold">{school.application_deadline || 'N/A'}</p>
                </div>
                <div className="bg-teal-50 rounded-lg p-3">
                  <span className="text-teal-600 text-xs font-medium">GRE</span>
                  <p className="text-gray-800 font-bold">{school.gre_requirement || 'N/A'}</p>
                </div>
              </div>

              {(school.prerequisites_required || school.prerequisites_not_required) && (
                <div className="mt-4 pt-4 border-t border-gray-100">
                  {school.prerequisites_required && (
                    <p className="text-sm text-gray-600 mb-2"><span className="text-purple-600 font-semibold">Required:</span> {school.prerequisites_required}</p>
                  )}
                  {school.prerequisites_not_required && (
                    <p className="text-sm text-gray-600"><span className="text-green-600 font-semibold">NOT Required:</span> {school.prerequisites_not_required}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {filteredSchools.length === 0 && (
          <div className="text-center py-12">
            <p className="text-white text-lg">No schools match your filters. Try adjusting your criteria.</p>
          </div>
        )}
      </div>
    </div>
  )
}