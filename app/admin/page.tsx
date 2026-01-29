'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function Admin() {
  const [schools, setSchools] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [newSchool, setNewSchool] = useState({
    name: '',
    location_city: '',
    location_state: '',
    program_type: 'DNP',
    program_length_months: 36,
    format: '',
    front_loaded: '',
    tuition_total: 0,
    tuition_yearly: 0,
    gpa_requirement: 3.0,
    icu_experience_months: 12,
    gre_requirement: 'Not Required',
    gre_preferred_scores: '',
    application_opens_month: '',
    application_deadline: '',
    application_method: 'NursingCAS',
    prerequisites_required: '',
    prerequisites_not_required: '',
    nclex_pass_rate: 90,
    website_url: ''
  })

  const supabase = createClient()

  useEffect(() => {
    loadSchools()
  }, [])

  const loadSchools = async () => {
    const { data } = await supabase.from('schools').select('*').order('name')
    setSchools(data || [])
    setLoading(false)
  }

  const deleteSchool = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete "${name}"?`)) return
    
    await supabase.from('schools').delete().eq('id', id)
    setSchools(schools.filter(s => s.id !== id))
  }

  const addSchool = async () => {
    if (!newSchool.name || !newSchool.location_city || !newSchool.location_state) {
      alert('Please fill in at least: Name, City, and State')
      return
    }

    const { data, error } = await supabase.from('schools').insert([newSchool]).select()
    
    if (error) {
      alert('Error adding school: ' + error.message)
      return
    }

    setSchools([...schools, data[0]].sort((a, b) => a.name.localeCompare(b.name)))
    setShowAddForm(false)
    setNewSchool({
      name: '',
      location_city: '',
      location_state: '',
      program_type: 'DNP',
      program_length_months: 36,
      format: '',
      front_loaded: '',
      tuition_total: 0,
      tuition_yearly: 0,
      gpa_requirement: 3.0,
      icu_experience_months: 12,
      gre_requirement: 'Not Required',
      gre_preferred_scores: '',
      application_opens_month: '',
      application_deadline: '',
      application_method: 'NursingCAS',
      prerequisites_required: '',
      prerequisites_not_required: '',
      nclex_pass_rate: 90,
      website_url: ''
    })
    alert('School added successfully!')
  }

  const states = [...new Set(schools.map(s => s.location_state))].sort()

  const filteredSchools = schools.filter(s => {
    const matchesSearch = s.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesState = stateFilter === '' || s.location_state === stateFilter
    return matchesSearch && matchesState
  })

  if (loading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <Link href="/"><h1 className="text-2xl font-bold text-blue-600">CRNA Prep Hub</h1></Link>
            <div className="flex gap-4">
              <Link href="/dashboard" className="text-gray-700 hover:text-blue-600">Dashboard</Link>
              <Link href="/schools" className="text-gray-700 hover:text-blue-600">Schools</Link>
              <Link href="/admin" className="text-red-600 font-semibold">Admin</Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold">Admin: Manage Schools</h1>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700"
          >
            {showAddForm ? 'Cancel' : '+ Add New School'}
          </button>
        </div>

        {showAddForm && (
          <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
            <h2 className="text-xl font-bold mb-4">Add New School</h2>
            
            <h3 className="font-semibold text-blue-600 mt-4 mb-2">Basic Info</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">School Name *</label>
                <input
                  type="text"
                  value={newSchool.name}
                  onChange={(e) => setNewSchool({...newSchool, name: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="Samford University"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">City *</label>
                <input
                  type="text"
                  value={newSchool.location_city}
                  onChange={(e) => setNewSchool({...newSchool, location_city: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="Birmingham"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">State *</label>
                <input
                  type="text"
                  value={newSchool.location_state}
                  onChange={(e) => setNewSchool({...newSchool, location_state: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="AL"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Website URL</label>
                <input
                  type="text"
                  value={newSchool.website_url}
                  onChange={(e) => setNewSchool({...newSchool, website_url: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="https://..."
                />
              </div>
            </div>

            <h3 className="font-semibold text-blue-600 mt-6 mb-2">Program Details</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Program Type</label>
                <select
                  value={newSchool.program_type}
                  onChange={(e) => setNewSchool({...newSchool, program_type: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="DNP">DNP</option>
                  <option value="DNAP">DNAP</option>
                  <option value="MSN">MSN</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Program Length (months)</label>
                <input
                  type="number"
                  value={newSchool.program_length_months}
                  onChange={(e) => setNewSchool({...newSchool, program_length_months: parseInt(e.target.value)})}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Format</label>
                <select
                  value={newSchool.format}
                  onChange={(e) => setNewSchool({...newSchool, format: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="">Select...</option>
<option value="In-Person">In-Person</option>
<option value="Hybrid">Hybrid (mixed)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Front Loaded?</label>
                <select
                  value={newSchool.front_loaded}
                  onChange={(e) => setNewSchool({...newSchool, front_loaded: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="">Select...</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                  <option value="Integrated">Integrated</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">NCLEX Pass Rate (%)</label>
                <input
                  type="number"
                  value={newSchool.nclex_pass_rate}
                  onChange={(e) => setNewSchool({...newSchool, nclex_pass_rate: parseFloat(e.target.value)})}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
            </div>

            <h3 className="font-semibold text-blue-600 mt-6 mb-2">Tuition</h3>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Yearly Tuition ($)</label>
                <input
                  type="number"
                  value={newSchool.tuition_yearly}
                  onChange={(e) => setNewSchool({...newSchool, tuition_yearly: parseFloat(e.target.value)})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="35235"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Total Tuition ($)</label>
                <input
                  type="number"
                  value={newSchool.tuition_total}
                  onChange={(e) => setNewSchool({...newSchool, tuition_total: parseFloat(e.target.value)})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="105705"
                />
              </div>
            </div>

            <h3 className="font-semibold text-blue-600 mt-6 mb-2">Requirements</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Minimum GPA</label>
                <input
                  type="number"
                  step="0.1"
                  value={newSchool.gpa_requirement}
                  onChange={(e) => setNewSchool({...newSchool, gpa_requirement: parseFloat(e.target.value)})}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">ICU Experience (months)</label>
                <input
                  type="number"
                  value={newSchool.icu_experience_months}
                  onChange={(e) => setNewSchool({...newSchool, icu_experience_months: parseInt(e.target.value)})}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">GRE Required?</label>
                <select
                  value={newSchool.gre_requirement}
                  onChange={(e) => setNewSchool({...newSchool, gre_requirement: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="Not Required">Not Required</option>
                  <option value="Required">Required</option>
                  <option value="Waived">Waived</option>
                  <option value="Optional">Optional</option>
                </select>
              </div>
              <div className="md:col-span-3">
                <label className="block text-sm font-medium mb-1">GRE Preferred Scores (if applicable)</label>
                <input
                  type="text"
                  value={newSchool.gre_preferred_scores}
                  onChange={(e) => setNewSchool({...newSchool, gre_preferred_scores: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="Verbal 150+, Quantitative 150+, Writing 4.0+"
                />
              </div>
            </div>

            <h3 className="font-semibold text-blue-600 mt-6 mb-2">Prerequisites</h3>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Required Prerequisites</label>
                <textarea
                  value={newSchool.prerequisites_required}
                  onChange={(e) => setNewSchool({...newSchool, prerequisites_required: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg h-24"
                  placeholder="General Chemistry (B or higher), Research course"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">NOT Required</label>
                <textarea
                  value={newSchool.prerequisites_not_required}
                  onChange={(e) => setNewSchool({...newSchool, prerequisites_not_required: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg h-24"
                  placeholder="Organic Chemistry"
                />
              </div>
            </div>

            <h3 className="font-semibold text-blue-600 mt-6 mb-2">Application Info</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Application Opens</label>
                <input
                  type="text"
                  value={newSchool.application_opens_month}
                  onChange={(e) => setNewSchool({...newSchool, application_opens_month: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="December 1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Application Deadline</label>
                <input
                  type="text"
                  value={newSchool.application_deadline}
                  onChange={(e) => setNewSchool({...newSchool, application_deadline: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="May 1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Apply Through</label>
                <select
                  value={newSchool.application_method}
                  onChange={(e) => setNewSchool({...newSchool, application_method: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="NursingCAS">NursingCAS</option>
                  <option value="Direct">Direct (School Website)</option>
                  <option value="Both">Both</option>
                </select>
              </div>
            </div>

            <button
              onClick={addSchool}
              className="mt-6 bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 font-semibold"
            >
              Add School
            </button>
          </div>
        )}

        <div className="mb-4 flex gap-4">
          <div className="flex-1">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by school name..."
              className="w-full px-4 py-2 border rounded-lg"
            />
          </div>
          <div className="w-48">
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg"
            >
              <option value="">All States</option>
              {states.map(state => (
                <option key={state} value={state}>{state}</option>
              ))}
            </select>
          </div>
        </div>

        <p className="text-gray-600 mb-4">Showing {filteredSchools.length} of {schools.length} schools</p>

        <div className="space-y-2">
          {filteredSchools.map((school) => (
            <div key={school.id} className="bg-white rounded-lg shadow-sm p-4 flex justify-between items-center">
              <div>
                <h3 className="font-bold">{school.name}</h3>
                <p className="text-sm text-gray-600">
                  {school.location_city}, {school.location_state} | 
                  GPA: {school.gpa_requirement} | 
                  GRE: {school.gre_requirement || 'N/A'} |
                  ICU: {school.icu_experience_months} mo
                </p>
              </div>
              <button
                onClick={() => deleteSchool(school.id, school.name)}
                className="bg-red-500 text-white px-4 py-2 rounded-lg hover:bg-red-600 text-sm"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}