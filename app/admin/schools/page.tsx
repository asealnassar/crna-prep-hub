'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function AdminSchools() {
  const [schools, setSchools] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editingSchool, setEditingSchool] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
const [stateFilter, setStateFilter] = useState('')
  const supabase = createClient()

  useEffect(() => {
    const fetchSchools = async () => {
      const { data } = await supabase
        .from('schools')
        .select('*')
        .order('name')
      
      setSchools(data || [])
      setLoading(false)
    }
    fetchSchools()
  }, [])

  const saveSchool = async () => {
    setSaving(true)
    
    const { error } = await supabase
      .from('schools')
      .update({
        name: editingSchool.name,
        location_city: editingSchool.location_city,
        location_state: editingSchool.location_state,
        gpa_requirement: editingSchool.gpa_requirement,
        program_type: editingSchool.program_type,
        program_length_months: editingSchool.program_length_months,
        icu_experience_months: editingSchool.icu_experience_months,
        tuition_total: editingSchool.tuition_total,
        format: editingSchool.format,
        application_opens_month: editingSchool.application_opens_month,
        application_deadline: editingSchool.application_deadline,
        gre_requirement: editingSchool.gre_requirement,
        application_method: editingSchool.application_method,
        prerequisites_required: editingSchool.prerequisites_required,
        prerequisites_not_required: editingSchool.prerequisites_not_required,
        website_url: editingSchool.website_url
      })
      .eq('id', editingSchool.id)

    if (!error) {
      setSchools(schools.map(s => s.id === editingSchool.id ? editingSchool : s))
      setEditingSchool(null)
      alert('School updated successfully!')
    } else {
      alert('Error saving: ' + error.message)
    }
    
    setSaving(false)
  }

  const deleteSchool = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete ${name}?`)) return
    
    await supabase.from('schools').delete().eq('id', id)
    setSchools(schools.filter(s => s.id !== id))
  }

  const states = [...new Set(schools.map(s => s.location_state))].sort()

  const filteredSchools = schools.filter(school => {
    const matchesSearch = school.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      school.location_city.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesState = !stateFilter || school.location_state === stateFilter
    return matchesSearch && matchesState
  })

  if (loading) {
    return <div className="min-h-screen bg-gray-100 flex items-center justify-center">Loading...</div>
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold text-purple-600">Admin - Edit Schools</h1>
            <div className="flex gap-4">
              <Link href="/admin/reports" className="text-gray-600 hover:text-purple-600">Error Reports</Link>
              <Link href="/schools" className="text-gray-600 hover:text-purple-600">View Schools</Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-6 flex gap-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by school name or city..."
            className="flex-1 px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            <option value="">All States</option>
            {states.map(state => (
              <option key={state} value={state}>{state}</option>
            ))}
          </select>
          {stateFilter && (
            <button
              onClick={() => setStateFilter('')}
              className="px-4 py-3 bg-gray-200 rounded-xl hover:bg-gray-300 transition"
            >
              Clear
            </button>
          )}
        </div>

        <div className="mb-4 text-gray-600">
          Showing {filteredSchools.length} of {schools.length} schools
        </div>

        <div className="space-y-4">
          {filteredSchools.map((school) => (
            <div key={school.id} className="bg-white rounded-xl shadow p-6">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-lg text-gray-800">{school.name}</h3>
                  <p className="text-sm text-gray-500">{school.location_city}, {school.location_state}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditingSchool({...school})}
                    className="px-4 py-2 bg-purple-500 text-white rounded-lg text-sm hover:bg-purple-600 transition"
                  >
                    ✏️ Edit
                  </button>
                  <button
                    onClick={() => deleteSchool(school.id, school.name)}
                    className="px-4 py-2 bg-red-500 text-white rounded-lg text-sm hover:bg-red-600 transition"
                  >
                    🗑 Delete
                  </button>
                </div>
              </div>
              
              <div className="mt-4 grid grid-cols-5 gap-2 text-sm">
                <div className="bg-gray-50 p-2 rounded">
                  <span className="text-gray-500 text-xs">GPA</span>
                  <p className="font-medium">{school.gpa_requirement}</p>
                </div>
                <div className="bg-gray-50 p-2 rounded">
                  <span className="text-gray-500 text-xs">Program</span>
                  <p className="font-medium">{school.program_type}</p>
                </div>
                <div className="bg-gray-50 p-2 rounded">
                  <span className="text-gray-500 text-xs">Length</span>
                  <p className="font-medium">{school.program_length_months} mo</p>
                </div>
                <div className="bg-gray-50 p-2 rounded">
                  <span className="text-gray-500 text-xs">ICU</span>
                  <p className="font-medium">{school.icu_experience_months} mo</p>
                </div>
                <div className="bg-gray-50 p-2 rounded">
                  <span className="text-gray-500 text-xs">Tuition</span>
                  <p className="font-medium">${school.tuition_total?.toLocaleString()}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {editingSchool && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-6 my-8">
            <h3 className="text-xl font-bold text-gray-800 mb-4">Edit School</h3>
            
            <div className="grid grid-cols-2 gap-4 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">School Name</label>
                <input
                  type="text"
                  value={editingSchool.name || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, name: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                <input
                  type="text"
                  value={editingSchool.location_city || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, location_city: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                <input
                  type="text"
                  value={editingSchool.location_state || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, location_state: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">GPA Requirement</label>
                <input
                  type="number"
                  step="0.01"
                  value={editingSchool.gpa_requirement || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, gpa_requirement: parseFloat(e.target.value)})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Program Type</label>
                <select
                  value={editingSchool.program_type || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, program_type: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="DNP">DNP</option>
                  <option value="DNAP">DNAP</option>
                  <option value="MSN">MSN</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Program Length (months)</label>
                <input
                  type="number"
                  value={editingSchool.program_length_months || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, program_length_months: parseInt(e.target.value)})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ICU Experience (months)</label>
                <input
                  type="number"
                  value={editingSchool.icu_experience_months || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, icu_experience_months: parseInt(e.target.value)})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tuition Total</label>
                <input
                  type="number"
                  value={editingSchool.tuition_total || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, tuition_total: parseInt(e.target.value)})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Format</label>
                <select
                  value={editingSchool.format || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, format: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="">Select...</option>
                  <option value="In-Person">In-Person</option>
                  <option value="Hybrid">Hybrid (blended/online)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Application Opens</label>
                <input
                  type="text"
                  value={editingSchool.application_opens_month || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, application_opens_month: e.target.value})}
                  placeholder="e.g., January"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Application Deadline</label>
                <input
                  type="text"
                  value={editingSchool.application_deadline || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, application_deadline: e.target.value})}
                  placeholder="e.g., June 1"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">GRE Requirement</label>
                <select
                  value={editingSchool.gre_requirement || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, gre_requirement: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="">Select...</option>
                  <option value="Required">Required</option>
                  <option value="Not Required">Not Required</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Application Method</label>
                <select
                  value={editingSchool.application_method || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, application_method: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="">Select...</option>
                  <option value="Direct">Direct</option>
                  <option value="NursingCAS">NursingCAS</option>
                  <option value="Both">Both</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
                <input
                  type="text"
                  value={editingSchool.website_url || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, website_url: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Prerequisites Required</label>
                <textarea
                  value={editingSchool.prerequisites_required || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, prerequisites_required: e.target.value})}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Prerequisites NOT Required</label>
                <textarea
                  value={editingSchool.prerequisites_not_required || ''}
                  onChange={(e) => setEditingSchool({...editingSchool, prerequisites_not_required: e.target.value})}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
            </div>
            
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setEditingSchool(null)}
                className="flex-1 py-3 border border-gray-300 rounded-xl text-gray-700 font-semibold hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={saveSchool}
                disabled={saving}
                className="flex-1 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
