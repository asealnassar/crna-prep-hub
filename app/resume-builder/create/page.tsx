'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function CreateResume() {
  const [currentStep, setCurrentStep] = useState(1)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [userTier, setUserTier] = useState('free')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const isPremium = userTier === 'premium' || userTier === 'ultimate'
  const isUltimate = userTier === 'ultimate'

  // Form data state
const [formData, setFormData] = useState({
    // Personal Info
    full_name: '',
    email: '',
    phone: '',
    city: '',
    state: '',
    linkedin: '',
    professional_summary: '',  // ADD THIS LINE
    
// Education - ONE NURSING DEGREE + OPTIONAL OTHER DEGREES
    nursing_degree: {
      degree: 'BSN',
      university: '',
      graduation_date: '',
      overall_gpa: '',
      science_gpa: ''
    },
    other_degrees: [] as any[],    
    // ICU Experience
    icu_positions: [{
      position: 'ICU Registered Nurse',
      unit_type: '',
      hospital: '',
      location: '',
      start_date: '',
      end_date: '',
      is_current: false,
      acuity: 'high',
      devices: [] as string[],
      patient_population: [] as string[],
      bullet_points: ['']
    }],
    
// Certifications
    certifications: [] as string[],
    custom_certifications: [] as string[],
    
// Shadowing - MULTIPLE EXPERIENCES
    shadowing_experiences: [] as any[],    
    // Leadership
    leadership_roles: [] as string[],
    
    // Research/QI
    research_projects: [''],
    
    // Volunteer
    volunteer_work: ''
  })

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

      // Pre-fill email
      setFormData(prev => ({ ...prev, email: user.email || '' }))
    }
    init()
  }, [])

  const updateFormData = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const nextStep = () => {
    setCurrentStep(prev => Math.min(prev + 1, 6))
    window.scrollTo(0, 0)
  }

  const prevStep = () => {
    setCurrentStep(prev => Math.max(prev - 1, 1))
    window.scrollTo(0, 0)
  }

  const saveResume = async () => {
    setSaving(true)
    
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Create resume
      const { data: resume, error: resumeError } = await supabase
        .from('resumes')
        .insert({
          user_id: user.id,
          title: `${formData.full_name}'s CRNA Resume`,
          template_id: 'modern'
        })
        .select()
        .single()

      if (resumeError) throw resumeError

      // Save sections
      const sections = [
{
          resume_id: resume.id,
          section_type: 'personal',
          section_data: {
            full_name: formData.full_name,
            email: formData.email,
            phone: formData.phone,
            city: formData.city,
            state: formData.state,
            linkedin: formData.linkedin,
            professional_summary: formData.professional_summary  // ADD THIS LINE
          },
          order_index: 1
        },
{
          resume_id: resume.id,
          section_type: 'education',
          section_data: {
            nursing_degree: formData.nursing_degree,
            other_degrees: formData.other_degrees
          },
          order_index: 2
        },
{
          resume_id: resume.id,
          section_type: 'certifications',
          section_data: {
            certifications: formData.certifications,
            custom_certifications: formData.custom_certifications.filter(c => c.trim())
          },
          order_index: 3
        },
        {
          resume_id: resume.id,
          section_type: 'icu_experience',
          section_data: {
            positions: formData.icu_positions
          },
          order_index: 4
        },
{
          resume_id: resume.id,
          section_type: 'shadowing',
          section_data: {
            experiences: formData.shadowing_experiences
          },
          order_index: 5
        },
        {
          resume_id: resume.id,
          section_type: 'leadership',
          section_data: {
            roles: formData.leadership_roles
          },
          order_index: 6
        },
        {
          resume_id: resume.id,
          section_type: 'research',
          section_data: {
            projects: formData.research_projects.filter(p => p.trim())
          },
          order_index: 7
        }
      ]

      const { error: sectionsError } = await supabase
        .from('resume_sections')
        .insert(sections)

      if (sectionsError) throw sectionsError

      // Redirect to preview
      router.push(`/resume-builder/preview/${resume.id}`)
    } catch (error) {
      console.error('Error saving resume:', error)
      alert('Failed to save resume. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const totalSteps = 6
  const progressPercent = (currentStep / totalSteps) * 100

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar
        isLoggedIn={isLoggedIn}
        userEmail={userEmail}
        isAdmin={userEmail === 'asealnassar@gmail.com'}
        onCollapsedChange={setSidebarCollapsed}
      />

      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          
          {/* Progress Bar */}
          <div className="mb-8">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-white font-semibold">Step {currentStep} of {totalSteps}</h2>
              <span className="text-white text-sm">{Math.round(progressPercent)}% Complete</span>
            </div>
            <div className="w-full bg-white/20 rounded-full h-3">
              <div
                className="bg-gradient-to-r from-purple-500 to-pink-500 h-3 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Form Steps */}
          <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8">
            
{/* Step 1: Personal Info */}
            {currentStep === 1 && (
              <div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">Personal Information</h2>
                <p className="text-gray-600 mb-6">Let's start with the basics</p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Full Name *</label>
                    <input
                      type="text"
                      value={formData.full_name}
                      onChange={(e) => updateFormData('full_name', e.target.value)}
                      placeholder="Sarah Johnson"
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Email *</label>
                      <input
                        type="email"
                        value={formData.email}
                        onChange={(e) => updateFormData('email', e.target.value)}
                        placeholder="sarah@email.com"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Phone *</label>
                      <input
                        type="tel"
                        value={formData.phone}
                        onChange={(e) => updateFormData('phone', e.target.value)}
                        placeholder="(555) 123-4567"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">City *</label>
                      <input
                        type="text"
                        value={formData.city}
                        onChange={(e) => updateFormData('city', e.target.value)}
                        placeholder="Chicago"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">State *</label>
                      <input
                        type="text"
                        value={formData.state}
                        onChange={(e) => updateFormData('state', e.target.value)}
                        placeholder="IL"
                        maxLength={2}
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">LinkedIn URL (Optional)</label>
                    <input
                      type="url"
                      value={formData.linkedin}
                      onChange={(e) => updateFormData('linkedin', e.target.value)}
                      placeholder="linkedin.com/in/yourname"
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>

                  {/* Professional Summary */}
                  <div className="border-t pt-4 mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Professional Summary *</label>
                    <p className="text-xs text-gray-600 mb-2">
                      A brief 2-3 sentence summary highlighting your ICU experience, key skills, and CRNA career goals
                    </p>
                    <textarea
                      value={formData.professional_summary}
                      onChange={(e) => updateFormData('professional_summary', e.target.value)}
                      placeholder="Example: Critical care nurse with 3 years of experience in a high-acuity Medical ICU managing ventilated and hemodynamically unstable patients. Proficient in vasoactive infusions, advanced monitoring, and rapid clinical decision-making. Seeking to advance into nurse anesthesia with a strong foundation in patient safety and critical care excellence."
                      rows={4}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                    <p className="text-xs text-gray-500 mt-2 italic">
                      💡 Tip: Mention years of ICU experience, key technical skills, and your CRNA aspirations
                    </p>
                  </div>
                </div>
              </div>
            )}
{/* Step 2: Education */}
            {currentStep === 2 && (
              <div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">Education</h2>
                <p className="text-gray-600 mb-6">Start with your nursing degree, then add any additional degrees</p>

                {/* NURSING DEGREE (Required) */}
                <div className="mb-8 pb-8 border-b">
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">Nursing Degree (Required)</h3>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Nursing Degree *</label>
                      <select
                        value={formData.nursing_degree.degree}
                        onChange={(e) => {
                          setFormData(prev => ({
                            ...prev,
                            nursing_degree: { ...prev.nursing_degree, degree: e.target.value }
                          }))
                        }}
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      >
                        <option value="ADN">ADN (Associate Degree in Nursing)</option>
                        <option value="BSN">BSN (Bachelor of Science in Nursing)</option>
                        <option value="MSN">MSN (Master of Science in Nursing)</option>
                        <option value="DNP">DNP (Doctor of Nursing Practice)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">University *</label>
                      <input
                        type="text"
                        value={formData.nursing_degree.university}
                        onChange={(e) => {
                          setFormData(prev => ({
                            ...prev,
                            nursing_degree: { ...prev.nursing_degree, university: e.target.value }
                          }))
                        }}
                        placeholder="University of Illinois at Chicago"
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Graduation Date *</label>
                      <input
                        type="month"
                        value={formData.nursing_degree.graduation_date}
                        onChange={(e) => {
                          setFormData(prev => ({
                            ...prev,
                            nursing_degree: { ...prev.nursing_degree, graduation_date: e.target.value }
                          }))
                        }}
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                    </div>

                    <div className="grid md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Overall GPA (Optional)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="4.0"
                          value={formData.nursing_degree.overall_gpa}
                          onChange={(e) => {
                            setFormData(prev => ({
                              ...prev,
                              nursing_degree: { ...prev.nursing_degree, overall_gpa: e.target.value }
                            }))
                          }}
                          placeholder="3.7"
                          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Science GPA (Optional)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          max="4.0"
                          value={formData.nursing_degree.science_gpa}
                          onChange={(e) => {
                            setFormData(prev => ({
                              ...prev,
                              nursing_degree: { ...prev.nursing_degree, science_gpa: e.target.value }
                            }))
                          }}
                          placeholder="3.8"
                          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* OTHER DEGREES (Optional) */}
                <div>
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">Additional Degrees (Optional)</h3>

                  {formData.other_degrees.map((degree, idx) => (
                    <div key={idx} className="mb-6 pb-6 border-b last:border-b-0">
                      <div className="flex justify-between items-center mb-4">
                        <h4 className="text-md font-medium text-gray-700">Additional Degree {idx + 1}</h4>
                        <button
                          onClick={() => {
                            const newDegrees = formData.other_degrees.filter((_, i) => i !== idx)
                            setFormData(prev => ({ ...prev, other_degrees: newDegrees }))
                          }}
                          className="text-red-600 hover:text-red-700 text-sm"
                        >
                          Remove
                        </button>
                      </div>

                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Degree Type *</label>
                          <select
                            value={degree.degree}
                            onChange={(e) => {
                              const newDegrees = [...formData.other_degrees]
                              newDegrees[idx].degree = e.target.value
                              setFormData(prev => ({ ...prev, other_degrees: newDegrees }))
                            }}
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          >
                            <option value="">Select degree...</option>
                            <option value="AA">AA (Associate of Arts)</option>
                            <option value="AS">AS (Associate of Science)</option>
                            <option value="BA">BA (Bachelor of Arts)</option>
                            <option value="BS">BS (Bachelor of Science)</option>
                            <option value="BBA">BBA (Bachelor of Business Administration)</option>
                            <option value="MA">MA (Master of Arts)</option>
                            <option value="MS">MS (Master of Science)</option>
                            <option value="MBA">MBA (Master of Business Administration)</option>
                            <option value="MPH">MPH (Master of Public Health)</option>
                            <option value="MHA">MHA (Master of Health Administration)</option>
                            <option value="PhD">PhD (Doctor of Philosophy)</option>
                            <option value="EdD">EdD (Doctor of Education)</option>
                            <option value="Other">Other</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Field of Study *</label>
                          <input
                            type="text"
                            value={degree.field}
                            onChange={(e) => {
                              const newDegrees = [...formData.other_degrees]
                              newDegrees[idx].field = e.target.value
                              setFormData(prev => ({ ...prev, other_degrees: newDegrees }))
                            }}
                            placeholder="e.g., Biology, Psychology, Business"
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">University *</label>
                          <input
                            type="text"
                            value={degree.university}
                            onChange={(e) => {
                              const newDegrees = [...formData.other_degrees]
                              newDegrees[idx].university = e.target.value
                              setFormData(prev => ({ ...prev, other_degrees: newDegrees }))
                            }}
                            placeholder="University Name"
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Graduation Date *</label>
                          <input
                            type="month"
                            value={degree.graduation_date}
                            onChange={(e) => {
                              const newDegrees = [...formData.other_degrees]
                              newDegrees[idx].graduation_date = e.target.value
                              setFormData(prev => ({ ...prev, other_degrees: newDegrees }))
                            }}
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">GPA (Optional)</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max="4.0"
                            value={degree.gpa}
                            onChange={(e) => {
                              const newDegrees = [...formData.other_degrees]
                              newDegrees[idx].gpa = e.target.value
                              setFormData(prev => ({ ...prev, other_degrees: newDegrees }))
                            }}
                            placeholder="3.7"
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          />
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Add Another Degree Button */}
                  <button
                    onClick={() => {
                      const newDegree = {
                        degree: '',
                        field: '',
                        university: '',
                        graduation_date: '',
                        gpa: ''
                      }
                      setFormData(prev => ({
                        ...prev,
                        other_degrees: [...prev.other_degrees, newDegree]
                      }))
                    }}
                    className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-purple-500 hover:text-purple-600 transition"
                  >
                    + Add Another Degree
                  </button>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-6">
                  <p className="text-sm text-blue-800">
                    💡 <strong>Tip:</strong> Most CRNA programs prefer a GPA of 3.0 or higher. Include your GPA if it's 3.5+
                  </p>
                </div>
              </div>
            )}
            {/* Step 3: ICU Experience - UPDATED DEVICES & POPULATIONS */}
            {currentStep === 3 && (
              <div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">ICU Experience</h2>
                <p className="text-gray-600 mb-6">This is the most important section - take your time!</p>

                {formData.icu_positions.map((position, idx) => (
                  <div key={idx} className="mb-8 pb-8 border-b last:border-b-0">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-semibold text-gray-800">ICU Position {idx + 1}</h3>
                      {formData.icu_positions.length > 1 && (
                        <button
                          onClick={() => {
                            const newPositions = formData.icu_positions.filter((_, i) => i !== idx)
                            setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                          }}
                          className="text-red-600 hover:text-red-700 text-sm"
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    <div className="space-y-4">
                      {/* Position Title */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Position Title *</label>
                        <input
                          type="text"
                          value={position.position}
                          onChange={(e) => {
                            const newPositions = [...formData.icu_positions]
                            newPositions[idx].position = e.target.value
                            setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                          }}
                          placeholder="ICU Registered Nurse"
                          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                      </div>

                      {/* Unit Type */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">ICU Unit Type *</label>
                        <select
                          value={position.unit_type}
                          onChange={(e) => {
                            const newPositions = [...formData.icu_positions]
                            newPositions[idx].unit_type = e.target.value
                            setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                          }}
                          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
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

                      {/* Hospital & Location */}
                      <div className="grid md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Hospital *</label>
                          <input
                            type="text"
                            value={position.hospital}
                            onChange={(e) => {
                              const newPositions = [...formData.icu_positions]
                              newPositions[idx].hospital = e.target.value
                              setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                            }}
                            placeholder="Northwestern Memorial Hospital"
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Location *</label>
                          <input
                            type="text"
                            value={position.location}
                            onChange={(e) => {
                              const newPositions = [...formData.icu_positions]
                              newPositions[idx].location = e.target.value
                              setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                            }}
                            placeholder="Chicago, IL"
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          />
                        </div>
                      </div>

                      {/* Dates */}
                      <div className="grid md:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Start Date *</label>
                          <input
                            type="month"
                            value={position.start_date}
                            onChange={(e) => {
                              const newPositions = [...formData.icu_positions]
                              newPositions[idx].start_date = e.target.value
                              setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                            }}
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">End Date</label>
                          <input
                            type="month"
                            value={position.end_date}
                            onChange={(e) => {
                              const newPositions = [...formData.icu_positions]
                              newPositions[idx].end_date = e.target.value
                              newPositions[idx].is_current = false
                              setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                            }}
                            disabled={position.is_current}
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:bg-gray-100"
                          />
                        </div>
                        <div className="flex items-end">
                          <label className="flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={position.is_current}
                              onChange={(e) => {
                                const newPositions = [...formData.icu_positions]
                                newPositions[idx].is_current = e.target.checked
                                if (e.target.checked) {
                                  newPositions[idx].end_date = ''
                                }
                                setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                              }}
                              className="mr-2 h-4 w-4 text-purple-600"
                            />
                            <span className="text-sm text-gray-700">Current Position</span>
                          </label>
                        </div>
                      </div>

                      {/* Acuity Level */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Acuity Level *</label>
                        <div className="flex gap-4">
                          {['high', 'medium', 'low'].map(level => (
                            <label key={level} className="flex items-center cursor-pointer">
                              <input
                                type="radio"
                                name={`acuity-${idx}`}
                                value={level}
                                checked={position.acuity === level}
                                onChange={(e) => {
                                  const newPositions = [...formData.icu_positions]
                                  newPositions[idx].acuity = e.target.value
                                  setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                                }}
                                className="mr-2"
                              />
                              <span className="text-sm text-gray-700 capitalize">{level}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      {/* Devices/Skills - EXPANDED LIST */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Devices & Skills (Check all that apply) *
                        </label>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4 bg-gray-50 rounded-lg max-h-96 overflow-y-auto">
                          {[
                            'Mechanical Ventilation',
                            'Advanced Ventilator Modes (APRV, PRVC, etc.)',
                            'CRRT (Dialysis)',
                            'ECMO',
                            'IABP',
                            'Impella',
                            'Pulmonary Artery Catheter (Swan-Ganz)',
                            'Continuous Cardiac Output Monitoring (FloTrac, Vigileo)',
                            'Arterial Lines',
                            'Central Lines',
                            'Vasopressors (Levo, Vaso, Epi)',
                            'Inotropes (Dobutamine, Milrinone)',
                            'Sedation/Paralytics (Propofol, Versed, Nimbex)',
                            'Hemodynamic Monitoring',
                            'Blood Product Administration / Massive Transfusion Protocol',
                            'Chest Tubes',
                            'Temporary Pacemakers',
                            'Code Blue / ACLS Leadership',
                            'Rapid Sequence Intubation (Assist/Manage)',
                            'Bedside Ultrasound'
                          ].map(device => (
                            <label key={device} className="flex items-start cursor-pointer">
                              <input
                                type="checkbox"
                                checked={position.devices.includes(device)}
                                onChange={(e) => {
                                  const newPositions = [...formData.icu_positions]
                                  if (e.target.checked) {
                                    newPositions[idx].devices.push(device)
                                  } else {
                                    newPositions[idx].devices = newPositions[idx].devices.filter(d => d !== device)
                                  }
                                  setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                                }}
                                className="mr-2 h-4 w-4 text-purple-600 mt-0.5 flex-shrink-0"
                              />
                              <span className="text-sm text-gray-700">{device}</span>
                            </label>
                          ))}
                        </div>
                        <p className="text-xs text-gray-500 mt-2 italic">
                          💡 Only select skills you can confidently discuss in an interview
                        </p>
                      </div>

                      {/* Patient Population - EXPANDED LIST */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Patient Population (Check all that apply)
                        </label>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4 bg-gray-50 rounded-lg">
                          {[
                            'Post-op Cardiac Surgery',
                            'Trauma',
                            'Sepsis/Septic Shock',
                            'Respiratory Failure',
                            'COVID / ARDS',
                            'Neurological Emergencies',
                            'Transplant',
                            'Burns',
                            'Multi-organ Failure',
                            'DKA / Endocrine Emergencies',
                            'GI Bleeds',
                            'Liver Failure',
                            'Renal Failure',
                            'Oncology / Immunocompromised'
                          ].map(population => (
                            <label key={population} className="flex items-start cursor-pointer">
                              <input
                                type="checkbox"
                                checked={position.patient_population.includes(population)}
                                onChange={(e) => {
                                  const newPositions = [...formData.icu_positions]
                                  if (e.target.checked) {
                                    newPositions[idx].patient_population.push(population)
                                  } else {
                                    newPositions[idx].patient_population = newPositions[idx].patient_population.filter(p => p !== population)
                                  }
                                  setFormData(prev => ({ ...prev, icu_positions: newPositions }))
                                }}
                                className="mr-2 h-4 w-4 text-purple-600 mt-0.5 flex-shrink-0"
                              />
                              <span className="text-sm text-gray-700">{population}</span>
                            </label>
                          ))}
                        </div>
                        <p className="text-xs text-gray-500 mt-2 italic">
                          💡 Only select skills you can confidently discuss in an interview
                        </p>
                      </div>

                      {/* Bullet Points Preview */}
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <p className="text-sm text-blue-800">
                          💡 <strong>Next step:</strong> We'll use AI to transform your experience into powerful bullet points!
                        </p>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Add Another Position */}
                <button
                  onClick={() => {
                    const newPosition = {
                      position: 'ICU Registered Nurse',
                      unit_type: '',
                      hospital: '',
                      location: '',
                      start_date: '',
                      end_date: '',
                      is_current: false,
                      acuity: 'high',
                      devices: [],
                      patient_population: [],
                      bullet_points: ['']
                    }
                    setFormData(prev => ({
                      ...prev,
                      icu_positions: [...prev.icu_positions, newPosition]
                    }))
                  }}
                  className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-purple-500 hover:text-purple-600 transition"
                >
                  + Add Another ICU Position
                </button>
              </div>
            )}

{/* Step 4: Certifications - WITH CUSTOM INPUT */}
            {currentStep === 4 && (
              <div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">Certifications</h2>
                <p className="text-gray-600 mb-6">Check all certifications you currently hold</p>

                <div className="space-y-4">
                  <div className="grid md:grid-cols-2 gap-4">
                    {[
                      { value: 'CCRN', label: 'CCRN (Critical Care Registered Nurse)', required: true },
                      { value: 'CMC', label: 'CMC (Cardiac Medicine Certification)', required: false },
                      { value: 'CSC', label: 'CSC (Cardiac Surgery Certification)', required: false },
                      { value: 'ACLS', label: 'ACLS (Advanced Cardiac Life Support)', required: false },
                      { value: 'BLS', label: 'BLS (Basic Life Support)', required: false },
                      { value: 'PALS', label: 'PALS (Pediatric Advanced Life Support)', required: false },
                      { value: 'TNCC', label: 'TNCC (Trauma Nursing Core Course)', required: false },
                      { value: 'NIHSS', label: 'NIHSS (Stroke Certification)', required: false },
                      { value: 'CNOR', label: 'CNOR (Perioperative Nursing)', required: false },
                      { value: 'CEN', label: 'CEN (Emergency Nursing)', required: false }
                    ].map(cert => (
                      <label
                        key={cert.value}
                        className={`flex items-start p-4 border-2 rounded-lg cursor-pointer transition ${
                          formData.certifications.includes(cert.value)
                            ? 'border-purple-500 bg-purple-50'
                            : 'border-gray-200 hover:border-purple-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={formData.certifications.includes(cert.value)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setFormData(prev => ({
                                ...prev,
                                certifications: [...prev.certifications, cert.value]
                              }))
                            } else {
                              setFormData(prev => ({
                                ...prev,
                                certifications: prev.certifications.filter(c => c !== cert.value)
                              }))
                            }
                          }}
                          className="mr-3 h-5 w-5 text-purple-600 mt-0.5"
                        />
                        <div>
                          <div className="font-medium text-gray-800">
                            {cert.label}
                            {cert.required && <span className="ml-2 text-xs bg-red-100 text-red-600 px-2 py-1 rounded">Required by most programs</span>}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* Custom Certifications */}
                  <div className="border-t pt-6 mt-6">
                    <h3 className="text-lg font-semibold text-gray-800 mb-3">Other Certifications</h3>
                    <p className="text-sm text-gray-600 mb-4">Add any additional certifications not listed above</p>

                    {formData.custom_certifications.map((cert, idx) => (
                      <div key={idx} className="flex gap-2 mb-3">
                        <input
                          type="text"
                          value={cert}
                          onChange={(e) => {
                            const newCerts = [...formData.custom_certifications]
                            newCerts[idx] = e.target.value
                            setFormData(prev => ({ ...prev, custom_certifications: newCerts }))
                          }}
                          placeholder="e.g., CFRN, TCRN, Specialty Certification"
                          className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                        <button
                          onClick={() => {
                            const newCerts = formData.custom_certifications.filter((_, i) => i !== idx)
                            setFormData(prev => ({ ...prev, custom_certifications: newCerts }))
                          }}
                          className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                        >
                          Remove
                        </button>
                      </div>
                    ))}

                    <button
                      onClick={() => {
                        setFormData(prev => ({
                          ...prev,
                          custom_certifications: [...prev.custom_certifications, '']
                        }))
                      }}
                      className="text-sm text-purple-600 hover:text-purple-700 font-medium"
                    >
                      + Add Another Certification
                    </button>
                  </div>

                  {/* Warning if CCRN not selected */}
                  {!formData.certifications.includes('CCRN') && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                      <p className="text-sm text-red-800">
                        ⚠️ <strong>Warning:</strong> Most CRNA programs require or strongly prefer CCRN certification. Consider obtaining this certification before applying.
                      </p>
                    </div>
                  )}

                  {/* Success message if CCRN selected */}
                  {formData.certifications.includes('CCRN') && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <p className="text-sm text-green-800">
                        ✓ <strong>Excellent!</strong> CCRN certification significantly strengthens your application.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

{/* Step 5: Shadowing Experience - MULTIPLE EXPERIENCES */}
            {currentStep === 5 && (
              <div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">Shadowing Experience</h2>
                <p className="text-gray-600 mb-6">Add all your CRNA/anesthesiologist shadowing experiences</p>

                {formData.shadowing_experiences.length === 0 ? (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 mb-6">
                    <div className="flex items-start gap-4">
                      <span className="text-3xl">⚠️</span>
                      <div>
                        <h3 className="font-semibold text-yellow-900 mb-2">No Shadowing Experience Yet?</h3>
                        <p className="text-sm text-yellow-800 mb-3">
                          Most CRNA programs expect applicants to have shadowed a CRNA. This demonstrates your understanding of the role and commitment to the profession.
                        </p>
                        <button
                          onClick={() => {
                            const newExperience = {
                              crna_name: '',
                              hours: '',
                              setting: '',
                              description: ''
                            }
                            setFormData(prev => ({
                              ...prev,
                              shadowing_experiences: [newExperience]
                            }))
                          }}
                          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition text-sm"
                        >
                          + Add Shadowing Experience
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {formData.shadowing_experiences.map((experience, idx) => (
                      <div key={idx} className="mb-6 pb-6 border-b last:border-b-0">
                        <div className="flex justify-between items-center mb-4">
                          <h3 className="text-lg font-semibold text-gray-800">Shadowing Experience {idx + 1}</h3>
                          <button
                            onClick={() => {
                              const newExperiences = formData.shadowing_experiences.filter((_, i) => i !== idx)
                              setFormData(prev => ({ ...prev, shadowing_experiences: newExperiences }))
                            }}
                            className="text-red-600 hover:text-red-700 text-sm"
                          >
                            Remove
                          </button>
                        </div>

                        <div className="space-y-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">CRNA/Anesthesiologist Name *</label>
                            <input
                              type="text"
                              value={experience.crna_name}
                              onChange={(e) => {
                                const newExperiences = [...formData.shadowing_experiences]
                                newExperiences[idx].crna_name = e.target.value
                                setFormData(prev => ({ ...prev, shadowing_experiences: newExperiences }))
                              }}
                              placeholder="Dr. Michael Chen, CRNA"
                              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                            />
                          </div>

                          <div className="grid md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Total Hours *</label>
                              <input
                                type="number"
                                value={experience.hours}
                                onChange={(e) => {
                                  const newExperiences = [...formData.shadowing_experiences]
                                  newExperiences[idx].hours = e.target.value
                                  setFormData(prev => ({ ...prev, shadowing_experiences: newExperiences }))
                                }}
                                placeholder="40"
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                              />
                            </div>

                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">Setting *</label>
                              <select
                                value={experience.setting}
                                onChange={(e) => {
                                  const newExperiences = [...formData.shadowing_experiences]
                                  newExperiences[idx].setting = e.target.value
                                  setFormData(prev => ({ ...prev, shadowing_experiences: newExperiences }))
                                }}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                              >
                                <option value="">Select setting...</option>
                                <option value="Hospital-based">Hospital-based</option>
                                <option value="ASC (Ambulatory Surgery Center)">ASC (Ambulatory Surgery Center)</option>
                                <option value="Office-based">Office-based</option>
                                <option value="Multiple settings">Multiple settings</option>
                              </select>
                            </div>
                          </div>

                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Description (Optional)</label>
                            <textarea
                              value={experience.description}
                              onChange={(e) => {
                                const newExperiences = [...formData.shadowing_experiences]
                                newExperiences[idx].description = e.target.value
                                setFormData(prev => ({ ...prev, shadowing_experiences: newExperiences }))
                              }}
                              placeholder="Describe what you observed and learned..."
                              rows={3}
                              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                            />
                          </div>

                          {/* Hours feedback */}
                          {experience.hours && parseInt(experience.hours) >= 20 && (
                            <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                              <p className="text-sm text-green-800">
                                ✓ <strong>Great!</strong> {experience.hours} hours shows genuine interest.
                              </p>
                            </div>
                          )}

                          {experience.hours && parseInt(experience.hours) < 20 && (
                            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                              <p className="text-sm text-yellow-800">
                                💡 Consider shadowing for 20+ hours total to strengthen your application.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    {/* Total Hours Summary */}
                    {formData.shadowing_experiences.length > 0 && (
                      <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-4">
                        <p className="text-sm text-purple-800">
                          <strong>Total Shadowing Hours:</strong> {formData.shadowing_experiences.reduce((sum, exp) => sum + (parseInt(exp.hours) || 0), 0)} hours across {formData.shadowing_experiences.length} experience{formData.shadowing_experiences.length > 1 ? 's' : ''}
                        </p>
                      </div>
                    )}

                    {/* Add Another Experience */}
                    <button
                      onClick={() => {
                        const newExperience = {
                          crna_name: '',
                          hours: '',
                          setting: '',
                          description: ''
                        }
                        setFormData(prev => ({
                          ...prev,
                          shadowing_experiences: [...prev.shadowing_experiences, newExperience]
                        }))
                      }}
                      className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:border-purple-500 hover:text-purple-600 transition"
                    >
                      + Add Another Shadowing Experience
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Step 6: Leadership & Extras */}
            {currentStep === 6 && (
              <div>
                <h2 className="text-2xl font-bold text-gray-800 mb-2">Leadership & Extras</h2>
                <p className="text-gray-600 mb-6">Stand out with leadership roles and additional experiences</p>

                <div className="space-y-6">
                  {/* Leadership Roles */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-3">Leadership Roles (Check all that apply)</label>
                    <div className="grid md:grid-cols-2 gap-3">
                      {[
                        'Charge Nurse',
                        'Preceptor/Mentor',
                        'Unit Practice Council',
                        'Committee Member',
                        'Clinical Educator',
                        'Team Lead',
                        'Rapid Response Team',
                        'Code Team Member'
                      ].map(role => (
                        <label key={role} className="flex items-center p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={formData.leadership_roles.includes(role)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setFormData(prev => ({
                                  ...prev,
                                  leadership_roles: [...prev.leadership_roles, role]
                                }))
                              } else {
                                setFormData(prev => ({
                                  ...prev,
                                  leadership_roles: prev.leadership_roles.filter(r => r !== role)
                                }))
                              }
                            }}
                            className="mr-2 h-4 w-4 text-purple-600"
                          />
                          <span className="text-sm text-gray-700">{role}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Research/QI Projects */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Research or Quality Improvement Projects
                    </label>
                    <p className="text-sm text-gray-600 mb-3">Add any research studies or QI projects you've participated in</p>
                    
                    {formData.research_projects.map((project, idx) => (
                      <div key={idx} className="mb-3 flex gap-2">
                        <input
                          type="text"
                          value={project}
                          onChange={(e) => {
                            const newProjects = [...formData.research_projects]
                            newProjects[idx] = e.target.value
                            setFormData(prev => ({ ...prev, research_projects: newProjects }))
                          }}
                          placeholder="e.g., Reducing central line infections through evidence-based protocols"
                          className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                        />
                        {formData.research_projects.length > 1 && (
                          <button
                            onClick={() => {
                              const newProjects = formData.research_projects.filter((_, i) => i !== idx)
                              setFormData(prev => ({ ...prev, research_projects: newProjects }))
                            }}
                            className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}

                    <button
                      onClick={() => {
                        setFormData(prev => ({
                          ...prev,
                          research_projects: [...prev.research_projects, '']
                        }))
                      }}
                      className="text-sm text-purple-600 hover:text-purple-700 font-medium"
                    >
                      + Add Another Project
                    </button>
                  </div>

                  {/* Volunteer Work */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Volunteer Work (Optional)</label>
                    <textarea
                      value={formData.volunteer_work}
                      onChange={(e) => updateFormData('volunteer_work', e.target.value)}
                      placeholder="Describe any volunteer experience (medical missions, community health fairs, CPR instruction, etc.)"
                      rows={4}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>

                  {/* Summary */}
                  <div className="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 rounded-lg p-6">
                    <h3 className="font-semibold text-purple-800 mb-3">🎉 Almost Done!</h3>
                    <p className="text-sm text-purple-700 mb-2">
                      You've completed all sections. Click "Save Resume" to:
                    </p>
                    <ul className="text-sm text-purple-700 space-y-1 ml-4">
                      <li>✓ Generate AI-powered bullet points</li>
                      <li>✓ Get your resume score (0-100)</li>
                      <li>✓ Receive personalized improvement suggestions</li>
                      <li>✓ Preview and download your resume</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* Navigation Buttons */}
            <div className="flex justify-between mt-8 pt-6 border-t">
              <button
                onClick={prevStep}
                disabled={currentStep === 1}
                className="px-6 py-3 border border-gray-300 rounded-lg text-gray-700 font-semibold hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                ← Previous
              </button>

              {currentStep < totalSteps ? (
                <button
                  onClick={nextStep}
                  className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-lg hover:opacity-90 transition"
                >
                  Next →
                </button>
              ) : (
                <button
                  onClick={saveResume}
                  disabled={saving}
                  className="px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-500 text-white font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-50"
                >
                  {saving ? 'Saving...' : '✓ Save Resume'}
                </button>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
