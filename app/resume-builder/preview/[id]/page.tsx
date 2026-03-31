'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import { generateResumePDF } from '@/lib/generateResumePDF'
import Sidebar from '@/components/Sidebar'
import Link from 'next/link'

export default function PreviewResume() {
  const [resume, setResume] = useState<any>(null)
  const [sections, setSections] = useState<any[]>([])
  const [score, setScore] = useState<any>(null)
  const [enhancedBullets, setEnhancedBullets] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [enhancing, setEnhancing] = useState(false)
  const [scoring, setScoring] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [userTier, setUserTier] = useState('free')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState('modern')
  const [showTemplateSelector, setShowTemplateSelector] = useState(false)
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
        setSelectedTemplate(resumeData.template_id || 'modern')
      }

      // Load sections
      const { data: sectionsData } = await supabase
        .from('resume_sections')
        .select('*')
        .eq('resume_id', resumeId)
        .order('order_index')

      if (sectionsData) {
        setSections(sectionsData)
      }

      // Load score
      const { data: scoreData } = await supabase
        .from('resume_scores')
        .select('*')
        .eq('resume_id', resumeId)
        .single()

      if (scoreData) {
        setScore(scoreData)
      }

      setLoading(false)
    }
    init()
  }, [resumeId])

  const enhancePosition = async (positionIndex: number) => {
    const icuData = sections.find(s => s.section_type === 'icu_experience')?.section_data
    if (!icuData?.positions?.[positionIndex]) return

    setEnhancing(true)
    try {
      const res = await fetch('/api/resume/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          icuPosition: icuData.positions[positionIndex],
          userTier
        })
      })

      const data = await res.json()
      if (data.bullets) {
        setEnhancedBullets(prev => ({
          ...prev,
          [positionIndex]: data.bullets
        }))

        // SAVE TO DATABASE
        const icuSection = sections.find(s => s.section_type === 'icu_experience')
        if (icuSection) {
          const newPositions = [...icuData.positions]
          newPositions[positionIndex].bullet_points = data.bullets

          await supabase
            .from('resume_sections')
            .update({ 
              section_data: { ...icuData, positions: newPositions } 
            })
            .eq('id', icuSection.id)

          // Reload sections
          const { data: sectionsData } = await supabase
            .from('resume_sections')
            .select('*')
            .eq('resume_id', resumeId)
            .order('order_index')

          if (sectionsData) {
            setSections(sectionsData)
          }
        }
      }
    } catch (error) {
      console.error('Enhancement error:', error)
      alert('Failed to enhance bullets. Please try again.')
    } finally {
      setEnhancing(false)
    }
  }

  const calculateScore = async () => {
    setScoring(true)
    try {
      const res = await fetch('/api/resume/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeId })
      })

      const data = await res.json()
      if (data.score) {
        setScore(data.score)
      }
    } catch (error) {
      console.error('Scoring error:', error)
      alert('Failed to calculate score. Please try again.')
    } finally {
      setScoring(false)
    }
  }

  const downloadPDF = () => {
    try {
      const pdfData = {
        personal: personalData,
        education: educationData,
        certifications: certificationsData,
        icu_experience: icuData,
        shadowing: shadowingData,
        leadership: leadershipData,
        research: researchData,
        enhancedBullets: enhancedBullets
      }

      const templateToUse = (resume && resume.template_id) ? resume.template_id : 'modern'
      console.log('Downloading with template:', templateToUse)
      
      const pdf = generateResumePDF(pdfData, templateToUse)
      pdf.save(`${personalData.full_name || 'Resume'}_CRNA_Resume.pdf`)
    } catch (error) {
      console.error('PDF Error:', error)
      alert('Failed to generate PDF. Please try again.')
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

  // Get section data
  const personalData = sections.find(s => s.section_type === 'personal')?.section_data || {}
  const educationData = sections.find(s => s.section_type === 'education')?.section_data || {}
  const certificationsData = sections.find(s => s.section_type === 'certifications')?.section_data || {}
  const icuData = sections.find(s => s.section_type === 'icu_experience')?.section_data || {}
  const shadowingData = sections.find(s => s.section_type === 'shadowing')?.section_data || {}
  const leadershipData = sections.find(s => s.section_type === 'leadership')?.section_data || {}
  const researchData = sections.find(s => s.section_type === 'research')?.section_data || {}

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
          <div className="mb-8">
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Resume Preview</h1>
            <p className="text-indigo-200">Review your resume, generate AI bullets, and download as PDF</p>
          </div>

          {/* Resume Score Card */}
          {score && (
            <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-bold text-gray-800">Resume Score</h3>
                <div className="text-4xl font-bold text-purple-600">{score.overall_score}/100</div>
              </div>
              <div className="mb-4">
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div 
                    className="bg-gradient-to-r from-purple-600 to-pink-500 h-3 rounded-full transition-all duration-500"
                    style={{ width: `${score.overall_score}%` }}
                  />
                </div>
              </div>
              <p className="text-sm text-gray-600 mb-4">{score.interpretation}</p>
              
              {score.suggestions?.length > 0 && (
                <div className="mt-4">
                  <h4 className="font-semibold text-gray-800 mb-2">Top Suggestions:</h4>
                  <ul className="space-y-1">
                    {score.suggestions.map((suggestion: string, idx: number) => (
                      <li key={idx} className="text-sm text-gray-700">• {suggestion}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Resume Preview */}
          <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-12">
            
            {/* Personal Info */}
            <div className="text-center mb-8 pb-6 border-b-2">
              <h2 className="text-3xl font-bold text-gray-800 mb-2">{personalData.full_name}</h2>
              <div className="flex flex-wrap justify-center gap-4 text-sm text-gray-600">
                {personalData.city && <span>{personalData.city}, {personalData.state}</span>}
                {personalData.phone && <span>•</span>}
                {personalData.phone && <span>{personalData.phone}</span>}
                {personalData.email && <span>•</span>}
                {personalData.email && <span>{personalData.email}</span>}
                {personalData.linkedin && <span>•</span>}
                {personalData.linkedin && <span className="text-purple-600">{personalData.linkedin}</span>}
              </div>

              {/* Professional Summary */}
              {personalData.professional_summary && (
                <div className="mt-6 max-w-3xl mx-auto">
                  <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">Professional Summary</h3>
                  <p className="text-sm text-gray-700 leading-relaxed">
                    {personalData.professional_summary}
                  </p>
                </div>
              )}
            </div>

            {/* Education */}
            {educationData.nursing_degree && (
              <div className="mb-8">
                <h3 className="text-xl font-bold text-gray-800 mb-4 uppercase border-b pb-2">Education</h3>
                <div className="mb-4">
                  <div className="font-semibold text-gray-800">{educationData.nursing_degree.degree} - Nursing</div>
                  <div className="text-gray-700">{educationData.nursing_degree.university}</div>
                  <div className="text-sm text-gray-600">
                    Graduated: {new Date(educationData.nursing_degree.graduation_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                  </div>
                  {(educationData.nursing_degree.overall_gpa || educationData.nursing_degree.science_gpa) && (
                    <div className="text-sm text-gray-600">
                      {educationData.nursing_degree.overall_gpa && `Overall GPA: ${educationData.nursing_degree.overall_gpa}`}
                      {educationData.nursing_degree.overall_gpa && educationData.nursing_degree.science_gpa && ' | '}
                      {educationData.nursing_degree.science_gpa && `Science GPA: ${educationData.nursing_degree.science_gpa}`}
                    </div>
                  )}
                </div>

                {educationData.other_degrees?.map((degree: any, idx: number) => (
                  <div key={idx} className="mb-4">
                    <div className="font-semibold text-gray-800">{degree.degree} - {degree.field}</div>
                    <div className="text-gray-700">{degree.university}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Certifications */}
            {(certificationsData.certifications?.length > 0 || certificationsData.custom_certifications?.length > 0) && (
              <div className="mb-8">
                <h3 className="text-xl font-bold text-gray-800 mb-4 uppercase border-b pb-2">Certifications</h3>
                <div className="flex flex-wrap gap-2">
                  {certificationsData.certifications?.map((cert: string) => (
                    <span key={cert} className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm font-medium">
                      {cert}
                    </span>
                  ))}
                  {certificationsData.custom_certifications?.map((cert: string, idx: number) => (
                    <span key={`custom-${idx}`} className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium">
                      {cert}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* ICU Experience */}
            {icuData.positions?.length > 0 && (
              <div className="mb-8">
                <h3 className="text-xl font-bold text-gray-800 mb-4 uppercase border-b pb-2">Critical Care Experience</h3>
                {icuData.positions.map((position: any, idx: number) => (
                  <div key={idx} className="mb-6 last:mb-0">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <div className="font-semibold text-gray-800">{position.position}</div>
                        <div className="text-gray-700">{position.hospital}, {position.location}</div>
                        <div className="text-sm text-gray-600">{position.unit_type}</div>
                      </div>
                      <div className="text-sm text-gray-600 text-right">
                        {new Date(position.start_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} - {position.is_current ? 'Present' : new Date(position.end_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                      </div>
                    </div>
                    
                    {position.bullet_points && position.bullet_points.length > 0 ? (
                      <ul className="mt-3 space-y-2">
                        {position.bullet_points.map((bullet: string, bIdx: number) => (
                          <li key={bIdx} className="text-gray-700 text-sm">• {bullet}</li>
                        ))}
                      </ul>
                    ) : (
                      <>
                        {position.devices?.length > 0 && (
                          <div className="mb-2">
                            <span className="text-sm font-medium text-gray-700">Skills: </span>
                            <span className="text-sm text-gray-600">{position.devices.join(', ')}</span>
                          </div>
                        )}
                        
                        {position.patient_population?.length > 0 && (
                          <div className="mb-3">
                            <span className="text-sm font-medium text-gray-700">Patient Population: </span>
                            <span className="text-sm text-gray-600">{position.patient_population.join(', ')}</span>
                          </div>
                        )}
                        
                        <button
                          onClick={() => enhancePosition(idx)}
                          disabled={enhancing}
                          className="mt-3 px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-500 text-white text-sm font-semibold rounded-lg hover:opacity-90 transition disabled:opacity-50"
                        >
                          {enhancing ? '✨ Enhancing...' : '✨ Generate AI Bullet Points'}
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Shadowing */}
            {shadowingData.experiences?.length > 0 && (
              <div className="mb-8">
                <h3 className="text-xl font-bold text-gray-800 mb-4 uppercase border-b pb-2">CRNA Shadowing Experience</h3>
                {shadowingData.experiences.map((experience: any, idx: number) => (
                  <div key={idx} className="mb-4 last:mb-0">
                    <div className="font-semibold text-gray-800">Shadowed {experience.crna_name}</div>
                    <div className="text-sm text-gray-600">{experience.hours} hours | {experience.setting}</div>
                    {experience.description && (
                      <div className="text-sm text-gray-700 mt-1">{experience.description}</div>
                    )}
                  </div>
                ))}
                <div className="mt-4 font-semibold text-gray-800">
                  Total Shadowing Hours: {shadowingData.experiences.reduce((sum: number, exp: any) => sum + (parseInt(exp.hours) || 0), 0)}
                </div>
              </div>
            )}

            {/* Leadership */}
            {leadershipData.roles?.length > 0 && (
              <div className="mb-8">
                <h3 className="text-xl font-bold text-gray-800 mb-4 uppercase border-b pb-2">Leadership & Professional Development</h3>
                <ul className="space-y-1">
                  {leadershipData.roles.map((role: string, idx: number) => (
                    <li key={idx} className="text-gray-700">• {role}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Research */}
            {researchData.projects?.filter((p: string) => p.trim()).length > 0 && (
              <div className="mb-8">
                <h3 className="text-xl font-bold text-gray-800 mb-4 uppercase border-b pb-2">Research & Quality Improvement</h3>
                <ul className="space-y-1">
                  {researchData.projects.filter((p: string) => p.trim()).map((project: string, idx: number) => (
                    <li key={idx} className="text-gray-700">• {project}</li>
                  ))}
                </ul>
              </div>
            )}

          </div>

{/* Action Buttons */}
          <div className="mt-8 flex flex-col sm:flex-row gap-4">
            <Link
              href="/resume-builder"
              className="flex-1 text-center px-6 py-3 border-2 border-white text-white font-semibold rounded-xl hover:bg-white/10 transition"
            >
              ← Back to My Resumes
            </Link>
            <button
              onClick={() => setShowTemplateSelector(!showTemplateSelector)}
              className="flex-1 px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
            >
              🎨 Change Template
            </button>
            <Link
              href={`/resume-builder/edit/${resumeId}`}
              className="flex-1 text-center px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
            >
              ✏️ Edit Resume
            </Link>
            <button
              onClick={downloadPDF}
              className="flex-1 px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
            >
              📥 Download PDF
            </button>
          </div>

          {/* ADD THIS FEEDBACK BUTTON */}
          <div className="mt-4">
            <Link
              href="/feedback?feature=resume-builder"
              className="block text-center px-6 py-3 bg-white/10 border-2 border-white/30 text-white font-medium rounded-xl hover:bg-white/20 transition"
            >
              💬 Submit Feedback or Request Features
            </Link>
          </div>
          {/* Template Selector Modal */}
          {showTemplateSelector && (
            <div className="mt-6 bg-white rounded-2xl shadow-xl p-6">
              <h3 className="text-xl font-bold text-gray-800 mb-4">Choose Resume Template</h3>
              <div className="grid md:grid-cols-5 gap-4">
                {[
                  { id: 'modern', name: 'Modern', desc: 'Clean, minimal design' },
                  { id: 'professional', name: 'Professional', desc: 'Traditional healthcare' },
                  { id: 'ats', name: 'ATS-Optimized', desc: 'Simple, keyword-focused' },
                  { id: 'compact', name: 'Compact', desc: 'Space-efficient layout' },
                  { id: 'creative', name: 'Creative', desc: 'Subtle design elements' }
                ].map(template => (
                  <button
                    key={template.id}
                    onClick={async () => {
                      setSelectedTemplate(template.id)
                      
                      await supabase
                        .from('resumes')
                        .update({ template_id: template.id })
                        .eq('id', resumeId)
                      
                      setResume((prev: any) => ({
                        ...prev,
                        template_id: template.id
                      }))
                      
                      setShowTemplateSelector(false)
                      alert(`✓ Template changed to ${template.name}! Download PDF to see the new style.`)
                    }}
                    className={`p-4 border-2 rounded-xl text-left transition ${
                      selectedTemplate === template.id
                        ? 'border-purple-500 bg-purple-50'
                        : 'border-gray-200 hover:border-purple-300'
                    }`}
                  >
                    <div className="font-semibold text-gray-800 mb-1">{template.name}</div>
                    <div className="text-xs text-gray-600">{template.desc}</div>
                    {selectedTemplate === template.id && (
                      <div className="mt-2 text-xs text-purple-600 font-medium">✓ Selected</div>
                    )}
                  </button>
                ))}
              </div>
              <p className="text-sm text-gray-600 mt-4">
                💡 Download the PDF to see your resume in the selected template
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
