'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'
import Link from 'next/link'

export default function EditResume() {
  const [resume, setResume] = useState<any>(null)
  const [formData, setFormData] = useState<any>({
    personal: {},
    education: {},
    certifications: { certifications: [], custom_certifications: [] },
    icu_experience: { positions: [] },
    shadowing: { experiences: [] },
    leadership: { roles: [] },
    research: { projects: [] }
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [userTier, setUserTier] = useState('free')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const router = useRouter()
  const params = useParams()
  const supabase = createClient()
  const resumeId = params?.id as string

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }

      setIsLoggedIn(true)
      setUserEmail(user.email || '')

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', user.id)
        .single()

      if (profile) {
        setUserTier(profile.subscription_tier || 'free')
      }

      // Load resume
      const { data: resumeData } = await supabase
        .from('resumes')
        .select('*')
        .eq('id', resumeId)
        .single()

      if (resumeData) {
        setResume(resumeData)
      }

      // Load sections
      const { data: sectionsData } = await supabase
        .from('resume_sections')
        .select('*')
        .eq('resume_id', resumeId)
        .order('order_index')

      if (sectionsData) {
        const data: any = {
          personal: {},
          education: {},
          certifications: { certifications: [], custom_certifications: [] },
          icu_experience: { positions: [] },
          shadowing: { experiences: [] },
          leadership: { roles: [] },
          research: { projects: [] }
        }

        sectionsData.forEach(section => {
          data[section.section_type] = section.section_data
        })

        setFormData(data)
      }

      setLoading(false)
    }
    init()
  }, [resumeId])

  const saveAllChanges = async () => {
    setSaving(true)
    try {
      // Get all section IDs first
      const { data: sectionsData } = await supabase
        .from('resume_sections')
        .select('id, section_type')
        .eq('resume_id', resumeId)

      if (!sectionsData) throw new Error('Failed to load sections')

      // Update each section
      for (const section of sectionsData) {
        await supabase
          .from('resume_sections')
          .update({ section_data: formData[section.section_type] })
          .eq('id', section.id)
      }

      alert('Resume saved successfully! ✓')
      // Redirect to preview
      router.push(`/resume-builder/preview/${resumeId}`)
    } catch (error) {
      console.error('Save error:', error)
      alert('Failed to save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const enhancePosition = async (positionIndex: number) => {
    setEnhancing(true)
    try {
      const res = await fetch('/api/resume/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          icuPosition: formData.icu_experience.positions[positionIndex],
          userTier
        })
      })

      const data = await res.json()
      if (data.bullets) {
        const newPositions = [...formData.icu_experience.positions]
        newPositions[positionIndex].bullet_points = data.bullets
        setFormData((prev: any) => ({
          ...prev,
          icu_experience: { ...prev.icu_experience, positions: newPositions }
        }))
      }
    } catch (error) {
      console.error('Enhancement error:', error)
      alert('Failed to enhance bullets. Please try again.')
    } finally {
      setEnhancing(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading resume...</div>
      </div>
    )
  }

  if (!resume) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-center">
          <div className="text-white text-xl mb-4">Resume not found</div>
          <Link href="/resume-builder" className="text-indigo-200 hover:text-white underline">
            ← Back to Resume Builder
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar
        isLoggedIn={isLoggedIn}
        userEmail={userEmail}
        isAdmin={userEmail === 'asealnassar@gmail.com'}
        onCollapsedChange={setSidebarCollapsed}
      />

      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          
          {/* Header */}
          <div className="mb-8 flex justify-between items-start">
            <div>
              <Link href={`/resume-builder/preview/${resumeId}`} className="text-indigo-200 hover:text-white mb-4 inline-flex items-center gap-2">
                ← Back to Preview
              </Link>
              <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Edit Resume</h1>
              <p className="text-indigo-200">Edit any field below. Click "Save All Changes" when done.</p>
            </div>
            <button
              onClick={saveAllChanges}
              disabled={saving}
              className="px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50 whitespace-nowrap"
            >
              {saving ? 'Saving...' : '💾 Save All Changes'}
            </button>
          </div>

          {/* Editable Form */}
          <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-12 space-y-8">
            
            {/* Personal Info */}
            <div className="border-b pb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-4">Personal Information</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Full Name</label>
                  <input
                    type="text"
                    value={formData.personal.full_name || ''}
                    onChange={(e) => setFormData((prev: any) => ({
                      ...prev,
                      personal: { ...prev.personal, full_name: e.target.value }
                    }))}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                    <input
                      type="email"
                      value={formData.personal.email || ''}
                      onChange={(e) => setFormData((prev: any) => ({
                        ...prev,
                        personal: { ...prev.personal, email: e.target.value }
                      }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Phone</label>
                    <input
                      type="tel"
                      value={formData.personal.phone || ''}
                      onChange={(e) => setFormData((prev: any) => ({
                        ...prev,
                        personal: { ...prev.personal, phone: e.target.value }
                      }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">City</label>
                    <input
                      type="text"
                      value={formData.personal.city || ''}
                      onChange={(e) => setFormData((prev: any) => ({
                        ...prev,
                        personal: { ...prev.personal, city: e.target.value }
                      }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">State</label>
                    <input
                      type="text"
                      value={formData.personal.state || ''}
                      onChange={(e) => setFormData((prev: any) => ({
                        ...prev,
                        personal: { ...prev.personal, state: e.target.value }
                      }))}
                      maxLength={2}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                </div>
<div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">LinkedIn (Optional)</label>
                  <input
                    type="url"
                    value={formData.personal.linkedin || ''}
                    onChange={(e) => setFormData((prev: any) => ({
                      ...prev,
                      personal: { ...prev.personal, linkedin: e.target.value }
                    }))}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                {/* ADD THIS */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Professional Summary</label>
                  <p className="text-xs text-gray-600 mb-2">
                    Brief 2-3 sentence summary highlighting your ICU experience and CRNA goals
                  </p>
                  <textarea
                    value={formData.personal.professional_summary || ''}
                    onChange={(e) => setFormData((prev: any) => ({
                      ...prev,
                      personal: { ...prev.personal, professional_summary: e.target.value }
                    }))}
                    rows={4}
                    placeholder="Critical care nurse with X years of experience..."
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>
              </div>
            </div>

            {/* Education */}
            <div className="border-b pb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-4">Education</h2>
              {formData.education.nursing_degree && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Nursing Degree</label>
                    <select
                      value={formData.education.nursing_degree.degree || 'BSN'}
                      onChange={(e) => setFormData((prev: any) => ({
                        ...prev,
                        education: {
                          ...prev.education,
                          nursing_degree: { ...prev.education.nursing_degree, degree: e.target.value }
                        }
                      }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    >
                      <option value="ADN">ADN</option>
                      <option value="BSN">BSN</option>
                      <option value="MSN">MSN</option>
                      <option value="DNP">DNP</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">University</label>
                    <input
                      type="text"
                      value={formData.education.nursing_degree.university || ''}
                      onChange={(e) => setFormData((prev: any) => ({
                        ...prev,
                        education: {
                          ...prev.education,
                          nursing_degree: { ...prev.education.nursing_degree, university: e.target.value }
                        }
                      }))}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div className="grid md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Graduation Date</label>
                      <input
                        type="month"
                        value={formData.education.nursing_degree.graduation_date || ''}
                        onChange={(e) => setFormData((prev: any) => ({
                          ...prev,
                          education: {
                            ...prev.education,
                            nursing_degree: { ...prev.education.nursing_degree, graduation_date: e.target.value }
                          }
                        }))}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Overall GPA</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="4.0"
                        value={formData.education.nursing_degree.overall_gpa || ''}
                        onChange={(e) => setFormData((prev: any) => ({
                          ...prev,
                          education: {
                            ...prev.education,
                            nursing_degree: { ...prev.education.nursing_degree, overall_gpa: e.target.value }
                          }
                        }))}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Science GPA</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="4.0"
                        value={formData.education.nursing_degree.science_gpa || ''}
                        onChange={(e) => setFormData((prev: any) => ({
                          ...prev,
                          education: {
                            ...prev.education,
                            nursing_degree: { ...prev.education.nursing_degree, science_gpa: e.target.value }
                          }
                        }))}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Certifications - FULLY EDITABLE */}
            <div className="border-b pb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-4">Certifications</h2>
              
              {/* Standard Certifications */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-3">Standard Certifications</label>
                <div className="grid md:grid-cols-2 gap-3">
                  {['CCRN', 'CMC', 'CSC', 'ACLS', 'BLS', 'PALS', 'TNCC', 'NIHSS', 'CNOR', 'CEN'].map(cert => (
                    <label key={cert} className="flex items-center p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={formData.certifications.certifications?.includes(cert) || false}
                        onChange={(e) => {
                          const certs = formData.certifications.certifications || []
                          setFormData((prev: any) => ({
                            ...prev,
                            certifications: {
                              ...prev.certifications,
                              certifications: e.target.checked 
                                ? [...certs, cert]
                                : certs.filter((c: string) => c !== cert)
                            }
                          }))
                        }}
                        className="mr-2 h-4 w-4 text-purple-600"
                      />
                      <span className="text-sm text-gray-700">{cert}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Custom Certifications */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">Other Certifications</label>
                {(formData.certifications.custom_certifications || []).map((cert: string, idx: number) => (
                  <div key={idx} className="flex gap-2 mb-3">
                    <input
                      type="text"
                      value={cert}
                      onChange={(e) => {
                        const certs = [...(formData.certifications.custom_certifications || [])]
                        certs[idx] = e.target.value
                        setFormData((prev: any) => ({
                          ...prev,
                          certifications: { ...prev.certifications, custom_certifications: certs }
                        }))
                      }}
                      placeholder="Certification name"
                      className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <button
                      onClick={() => {
                        const certs = (formData.certifications.custom_certifications || []).filter((_: any, i: number) => i !== idx)
                        setFormData((prev: any) => ({
                          ...prev,
                          certifications: { ...prev.certifications, custom_certifications: certs }
                        }))
                      }}
                      className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const certs = [...(formData.certifications.custom_certifications || []), '']
                    setFormData((prev: any) => ({
                      ...prev,
                      certifications: { ...prev.certifications, custom_certifications: certs }
                    }))
                  }}
                  className="text-sm text-purple-600 hover:text-purple-700 font-medium"
                >
                  + Add Certification
                </button>
              </div>
            </div>

{/* ICU Experience - FULLY EDITABLE WITH SKILLS DISPLAY */}
            <div className="border-b pb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-4">Critical Care Experience</h2>
              {(formData.icu_experience.positions || []).map((position: any, idx: number) => (
                <div key={idx} className="mb-6 p-4 border rounded-lg">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="font-semibold text-gray-800">Position {idx + 1}</h3>
                    {formData.icu_experience.positions.length > 1 && (
                      <button
                        onClick={() => {
                          const positions = formData.icu_experience.positions.filter((_: any, i: number) => i !== idx)
                          setFormData((prev: any) => ({
                            ...prev,
                            icu_experience: { ...prev.icu_experience, positions }
                          }))
                        }}
                        className="text-red-600 hover:text-red-700 text-sm"
                      >
                        Remove Position
                      </button>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Position Title</label>
                      <input
                        type="text"
                        value={position.position || ''}
                        onChange={(e) => {
                          const positions = [...formData.icu_experience.positions]
                          positions[idx].position = e.target.value
                          setFormData((prev: any) => ({
                            ...prev,
                            icu_experience: { ...prev.icu_experience, positions }
                          }))
                        }}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>

                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Hospital</label>
                        <input
                          type="text"
                          value={position.hospital || ''}
                          onChange={(e) => {
                            const positions = [...formData.icu_experience.positions]
                            positions[idx].hospital = e.target.value
                            setFormData((prev: any) => ({
                              ...prev,
                              icu_experience: { ...prev.icu_experience, positions }
                            }))
                          }}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Location</label>
                        <input
                          type="text"
                          value={position.location || ''}
                          onChange={(e) => {
                            const positions = [...formData.icu_experience.positions]
                            positions[idx].location = e.target.value
                            setFormData((prev: any) => ({
                              ...prev,
                              icu_experience: { ...prev.icu_experience, positions }
                            }))
                          }}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Unit Type</label>
                      <select
                        value={position.unit_type || ''}
                        onChange={(e) => {
                          const positions = [...formData.icu_experience.positions]
                          positions[idx].unit_type = e.target.value
                          setFormData((prev: any) => ({
                            ...prev,
                            icu_experience: { ...prev.icu_experience, positions }
                          }))
                        }}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      >
                        <option value="">Select unit type...</option>
                        <option value="MICU">MICU (Medical ICU)</option>
                        <option value="SICU">SICU (Surgical ICU)</option>
                        <option value="CVICU">CVICU (Cardiovascular ICU)</option>
                        <option value="Neuro ICU">Neuro ICU</option>
                        <option value="Trauma ICU">Trauma ICU</option>
                        <option value="Cardiac ICU">Cardiac ICU</option>
                        <option value="Mixed ICU">Mixed ICU</option>
                        <option value="CTICU">CTICU (Cardiothoracic ICU)</option>
                      </select>
                    </div>

                    <div className="grid md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Start Date</label>
                        <input
                          type="month"
                          value={position.start_date || ''}
                          onChange={(e) => {
                            const positions = [...formData.icu_experience.positions]
                            positions[idx].start_date = e.target.value
                            setFormData((prev: any) => ({
                              ...prev,
                              icu_experience: { ...prev.icu_experience, positions }
                            }))
                          }}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">End Date</label>
                        <input
                          type="month"
                          value={position.end_date || ''}
                          onChange={(e) => {
                            const positions = [...formData.icu_experience.positions]
                            positions[idx].end_date = e.target.value
                            positions[idx].is_current = false
                            setFormData((prev: any) => ({
                              ...prev,
                              icu_experience: { ...prev.icu_experience, positions }
                            }))
                          }}
                          disabled={position.is_current}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:bg-gray-100"
                        />
                      </div>
                      <div className="flex items-end">
                        <label className="flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={position.is_current || false}
                            onChange={(e) => {
                              const positions = [...formData.icu_experience.positions]
                              positions[idx].is_current = e.target.checked
                              if (e.target.checked) positions[idx].end_date = ''
                              setFormData((prev: any) => ({
                                ...prev,
                                icu_experience: { ...prev.icu_experience, positions }
                              }))
                            }}
                            className="mr-2 h-4 w-4 text-purple-600"
                          />
                          <span className="text-sm text-gray-700">Current Position</span>
                        </label>
                      </div>
                    </div>

                    {/* Display Skills/Devices */}
                    {position.devices && position.devices.length > 0 && (
                      <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                        <p className="text-sm font-medium text-gray-700 mb-2">Skills & Devices:</p>
                        <p className="text-sm text-gray-600">{position.devices.join(', ')}</p>
                      </div>
                    )}

                    {/* Display Patient Population */}
                    {position.patient_population && position.patient_population.length > 0 && (
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                        <p className="text-sm font-medium text-gray-700 mb-2">Patient Population:</p>
                        <p className="text-sm text-gray-600">{position.patient_population.join(', ')}</p>
                      </div>
                    )}

                    {/* Bullet Points */}
                    <div>
                      <div className="flex justify-between items-center mb-2">
                        <label className="block text-sm font-medium text-gray-700">Bullet Points</label>
                        {(!position.bullet_points || position.bullet_points.length === 0) && (
                          <button
                            onClick={() => enhancePosition(idx)}
                            disabled={enhancing}
                            className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-500 text-white text-sm font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-50"
                          >
                            {enhancing ? '✨ Generating...' : '✨ Generate AI Bullet Points'}
                          </button>
                        )}
                      </div>

                      {position.bullet_points && position.bullet_points.length > 0 ? (
                        <>
                          {position.bullet_points.map((bullet: string, bIdx: number) => (
                            <div key={bIdx} className="flex gap-2 mb-2">
                              <textarea
                                value={bullet}
                                onChange={(e) => {
                                  const positions = [...formData.icu_experience.positions]
                                  if (!positions[idx].bullet_points) positions[idx].bullet_points = []
                                  positions[idx].bullet_points[bIdx] = e.target.value
                                  setFormData((prev: any) => ({
                                    ...prev,
                                    icu_experience: { ...prev.icu_experience, positions }
                                  }))
                                }}
                                rows={2}
                                placeholder="Click to edit bullet point"
                                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                              />
                              <button
                                onClick={() => {
                                  const positions = [...formData.icu_experience.positions]
                                  positions[idx].bullet_points = positions[idx].bullet_points.filter((_: any, i: number) => i !== bIdx)
                                  setFormData((prev: any) => ({
                                    ...prev,
                                    icu_experience: { ...prev.icu_experience, positions }
                                  }))
                                }}
                                className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                          <div className="flex gap-2 mt-2">
                            <button
                              onClick={() => {
                                const positions = [...formData.icu_experience.positions]
                                if (!positions[idx].bullet_points) positions[idx].bullet_points = []
                                positions[idx].bullet_points.push('')
                                setFormData((prev: any) => ({
                                  ...prev,
                                  icu_experience: { ...prev.icu_experience, positions }
                                }))
                              }}
                              className="text-sm text-purple-600 hover:text-purple-700 font-medium"
                            >
                              + Add Bullet Point
                            </button>
                            <button
                              onClick={() => enhancePosition(idx)}
                              disabled={enhancing}
                              className="text-sm text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50"
                            >
                              {enhancing ? '✨ Regenerating...' : '✨ Regenerate with AI'}
                            </button>
                          </div>
                        </>
                      ) : (
                        <p className="text-sm text-gray-500 italic">No bullet points yet. Click "Generate AI Bullet Points" above to create them.</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* Leadership - FULLY EDITABLE */}
            <div className="border-b pb-6">
              <h2 className="text-2xl font-bold text-gray-800 mb-4">Leadership & Professional Development</h2>
              {(formData.leadership.roles || []).map((role: string, idx: number) => (
                <div key={idx} className="flex gap-2 mb-3">
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => {
                      const roles = [...(formData.leadership.roles || [])]
                      roles[idx] = e.target.value
                      setFormData((prev: any) => ({
                        ...prev,
                        leadership: { ...prev.leadership, roles }
                      }))
                    }}
                    placeholder="Leadership role"
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <button
                    onClick={() => {
                      const roles = (formData.leadership.roles || []).filter((_: any, i: number) => i !== idx)
                      setFormData((prev: any) => ({
                        ...prev,
                        leadership: { ...prev.leadership, roles }
                      }))
                    }}
                    className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                onClick={() => {
                  const roles = [...(formData.leadership.roles || []), '']
                  setFormData((prev: any) => ({
                    ...prev,
                    leadership: { ...prev.leadership, roles }
                  }))
                }}
                className="text-sm text-purple-600 hover:text-purple-700 font-medium"
              >
                + Add Leadership Role
              </button>
            </div>


{/* Research - FULLY EDITABLE - FIXED */}
            <div>
              <h2 className="text-2xl font-bold text-gray-800 mb-4">Research & Quality Improvement</h2>
              {(formData.research.projects || []).map((project: string, idx: number) => (
                <div key={idx} className="flex gap-2 mb-3">
                  <textarea
                    value={project}
                    onChange={(e) => {
                      const projects = [...(formData.research.projects || [])]
                      projects[idx] = e.target.value
                      setFormData((prev: any) => ({
                        ...prev,
                        research: { ...prev.research, projects }
                      }))
                    }}
                    placeholder="Research or QI project"
                    rows={2}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <button
                    onClick={() => {
                      const projects = (formData.research.projects || []).filter((_: any, i: number) => i !== idx)
                      setFormData((prev: any) => ({
                        ...prev,
                        research: { ...prev.research, projects }
                      }))
                    }}
                    className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                onClick={() => {
                  const projects = [...(formData.research.projects || []), '']
                  setFormData((prev: any) => ({
                    ...prev,
                    research: { ...prev.research, projects }
                  }))
                }}
                className="text-sm text-purple-600 hover:text-purple-700 font-medium"
              >
                + Add Project
              </button>
            </div>
          </div>

          {/* Save Button */}
          <div className="mt-8">
            <button
              onClick={saveAllChanges}
              disabled={saving}
              className="w-full px-6 py-4 bg-gradient-to-r from-green-600 to-emerald-500 text-white text-lg font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50"
            >
              {saving ? 'Saving Changes...' : '💾 Save All Changes & Return to Preview'}
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}
