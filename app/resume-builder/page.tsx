'use client'

import { useState, useEffect } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'
import Link from 'next/link'

export default function ResumeBuilder() {
  const [resumes, setResumes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [userTier, setUserTier] = useState('free')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const { sidebarCollapsed } = useSidebarCollapsed()
  const [deleting, setDeleting] = useState<string | null>(null)
  const router = useRouter()
  const supabase = createClient()

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

      const { data: resumesData } = await supabase
        .from('resumes')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })

      if (resumesData) {
        setResumes(resumesData)
      }

      setLoading(false)
    }
    init()
  }, [])

  const deleteResume = async (resumeId: string) => {
    if (!confirm('Are you sure you want to delete this resume?')) return

    setDeleting(resumeId)
    try {
      await supabase.from('resume_sections').delete().eq('resume_id', resumeId)
      await supabase.from('resume_scores').delete().eq('resume_id', resumeId)
      await supabase.from('resumes').delete().eq('id', resumeId)
      setResumes(prev => prev.filter(r => r.id !== resumeId))
    } catch (error) {
      console.error('Delete error:', error)
      alert('Failed to delete resume.')
    } finally {
      setDeleting(null)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    )
  }

// Free and Premium tiers - limited to 1 resume
  if ((userTier === 'free' || userTier === 'premium') && resumes.length >= 1) {
    return (
      <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
        <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
            <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
              <div className="text-6xl mb-4">⬆️</div>
              <h2 className="text-3xl font-bold text-gray-800 mb-4">Upgrade for Unlimited Resumes</h2>
              <p className="text-gray-600 mb-4">Free and Premium users can create 1 resume. You've reached your limit.</p>
              <p className="text-gray-700 font-semibold mb-6">Upgrade to Ultimate for unlimited resumes!</p>
              
              <div className="bg-purple-50 border-2 border-purple-200 rounded-xl p-6 mb-6 max-w-md mx-auto">
                <h3 className="font-bold text-gray-800 mb-3">Ultimate Features:</h3>
                <ul className="text-left text-gray-700 space-y-2">
                  <li>✅ Unlimited resumes</li>
                  <li>✅ All 5 professional templates</li>
                  <li>✅ Unlimited AI enhancements</li>
                  <li>✅ Resume scoring</li>
                  <li>✅ Full editing capabilities</li>
                </ul>
              </div>

              <Link href="/pricing" className="inline-block px-8 py-4 bg-gradient-to-r from-purple-600 to-pink-500 text-white text-lg font-semibold rounded-xl hover:opacity-90 transition">
                Upgrade to Ultimate - $49.99
              </Link>
              
<div className="mt-6">
                <Link href={`/resume-builder/preview/${resumes[0].id}`} className="text-purple-600 hover:text-purple-700 font-medium">
                  ← View Your Existing Resume
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">CRNA Resume Builder</h1>
            <p className="text-indigo-200">Build a competitive CRNA application resume in minutes</p>
          </div>

          {/* How It Works - Info Boxes */}
          <div className="grid md:grid-cols-3 gap-6 mb-8">
            <div className="bg-white/10 backdrop-blur-sm border-2 border-white/20 rounded-2xl p-6">
              <div className="text-4xl mb-3">📝</div>
              <h3 className="text-lg font-bold text-white mb-2">1. Enter Your Info</h3>
              <p className="text-indigo-100 text-sm">
                Fill out a simple 6-step form with your education, ICU experience, certifications, and shadowing hours.
              </p>
            </div>

            <div className="bg-white/10 backdrop-blur-sm border-2 border-white/20 rounded-2xl p-6">
              <div className="text-4xl mb-3">✨</div>
              <h3 className="text-lg font-bold text-white mb-2">2. AI Enhancement</h3>
              <p className="text-indigo-100 text-sm">
                Our AI generates professional bullet points that highlight patient acuity, clinical decision-making, and measurable outcomes.
              </p>
            </div>

            <div className="bg-white/10 backdrop-blur-sm border-2 border-white/20 rounded-2xl p-6">
              <div className="text-4xl mb-3">📥</div>
              <h3 className="text-lg font-bold text-white mb-2">3. Download & Apply</h3>
              <p className="text-indigo-100 text-sm">
                Choose from 5 professional templates, get your resume scored (0-100), and download as PDF.
              </p>
            </div>
          </div>

          {/* Tier Access Note */}
          <div className="bg-indigo-500/20 border border-indigo-400/50 rounded-xl p-3 sm:p-4 mb-8 flex items-center gap-3">
            <span className="text-xl flex-shrink-0">💎</span>
            {userTier === 'ultimate' ? (
              <p className="text-indigo-200 text-xs sm:text-sm">You're on the <strong>Ultimate</strong> plan — build unlimited resumes!</p>
            ) : (
              <p className="text-indigo-200 text-xs sm:text-sm">Free and Premium members can create <strong>1 resume</strong>. Upgrade to <strong>Ultimate</strong> for unlimited resumes.</p>
            )}
          </div>

          {/* Template Options */}
          <div className="bg-white/10 backdrop-blur-sm border-2 border-white/20 rounded-2xl p-6 mb-8">
            <h3 className="text-lg font-bold text-white mb-4">🎨 Choose From 5 Template Styles</h3>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4">
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="h-16 bg-gray-100 rounded mb-2 flex flex-col gap-1 p-2">
                  <div className="h-1.5 bg-gray-800 rounded w-3/4 mx-auto"></div>
                  <div className="h-1 bg-gray-300 rounded w-full mt-1"></div>
                  <div className="h-1 bg-gray-300 rounded w-full"></div>
                  <div className="h-1 bg-gray-300 rounded w-2/3"></div>
                </div>
                <p className="text-xs font-semibold text-gray-800">Modern</p>
                <p className="text-[10px] text-gray-400">Clean & minimal</p>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="h-16 bg-gray-100 rounded mb-2 flex flex-col gap-1 p-2 border-l-2 border-purple-500">
                  <div className="h-1.5 bg-purple-700 rounded w-3/4"></div>
                  <div className="h-1 bg-gray-300 rounded w-full mt-1"></div>
                  <div className="h-1 bg-gray-300 rounded w-full"></div>
                  <div className="h-1 bg-gray-300 rounded w-2/3"></div>
                </div>
                <p className="text-xs font-semibold text-gray-800">Professional</p>
                <p className="text-[10px] text-gray-400">Traditional healthcare</p>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="h-16 bg-gray-100 rounded mb-2 flex flex-col gap-1 p-2">
                  <div className="h-1.5 bg-gray-800 rounded w-1/2"></div>
                  <div className="h-1 bg-gray-400 rounded w-full mt-1"></div>
                  <div className="h-1 bg-gray-400 rounded w-full"></div>
                  <div className="h-1 bg-gray-400 rounded w-full"></div>
                </div>
                <p className="text-xs font-semibold text-gray-800">ATS-Optimized</p>
                <p className="text-[10px] text-gray-400">Keyword-focused</p>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="h-16 bg-gray-100 rounded mb-2 flex flex-col gap-0.5 p-1.5">
                  <div className="h-1 bg-gray-800 rounded w-3/4 mx-auto"></div>
                  <div className="h-0.5 bg-gray-300 rounded w-full mt-1"></div>
                  <div className="h-0.5 bg-gray-300 rounded w-full"></div>
                  <div className="h-0.5 bg-gray-300 rounded w-full"></div>
                  <div className="h-0.5 bg-gray-300 rounded w-full"></div>
                </div>
                <p className="text-xs font-semibold text-gray-800">Compact</p>
                <p className="text-[10px] text-gray-400">Space-efficient</p>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="h-16 bg-gradient-to-br from-purple-50 to-pink-50 rounded mb-2 flex flex-col gap-1 p-2">
                  <div className="h-1.5 bg-gradient-to-r from-purple-600 to-pink-500 rounded w-3/4 mx-auto"></div>
                  <div className="h-1 bg-gray-300 rounded w-full mt-1"></div>
                  <div className="h-1 bg-gray-300 rounded w-full"></div>
                  <div className="h-1 bg-gray-300 rounded w-2/3"></div>
                </div>
                <p className="text-xs font-semibold text-gray-800">Creative</p>
                <p className="text-[10px] text-gray-400">Subtle design</p>
              </div>
            </div>
          </div>

          {/* Sample Resume Preview */}
          <div className="bg-white rounded-2xl p-6 sm:p-8 mb-8 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900">📄 See a Sample Resume</h3>
              <span className="px-3 py-1 bg-gray-100 text-gray-500 text-xs font-semibold rounded-full">SAMPLE — NOT A REAL RESUME</span>
            </div>
            <div className="border border-gray-200 rounded-xl p-5 sm:p-6 bg-gray-50">
              <div className="text-center mb-4 pb-4 border-b border-gray-200">
                <p className="font-black text-gray-900 text-lg">Jordan Reyes, BSN, RN, CCRN</p>
                <p className="text-gray-500 text-xs mt-1">jordan.reyes@email.com &nbsp;•&nbsp; (555) 123-4567 &nbsp;•&nbsp; Atlanta, GA</p>
              </div>
              <div className="mb-4">
                <p className="text-purple-600 font-bold text-xs uppercase tracking-wide mb-2">Professional Summary</p>
                <p className="text-gray-700 text-sm">ICU nurse with 4+ years of critical care experience seeking a CRNA program to advance into nurse anesthesia practice. Skilled in hemodynamic monitoring, vasoactive titration, and multi-organ critical care.</p>
              </div>
              <div className="mb-4">
                <p className="text-purple-600 font-bold text-xs uppercase tracking-wide mb-2">Experience</p>
                <p className="font-semibold text-gray-800 text-sm">ICU Registered Nurse — Emory University Hospital</p>
                <p className="text-gray-400 text-xs mb-2">June 2021 – Present</p>
                <ul className="text-gray-700 text-sm space-y-1.5 list-disc pl-5">
                  <li>Managed continuous renal replacement therapy for critically ill patients with acute kidney injury and multi-organ dysfunction, optimizing fluid balance and electrolyte management</li>
                  <li>Titrated vasoactive drips and sedation for hemodynamically unstable patients, collaborating with intensivists to achieve target MAP and RASS goals</li>
                  <li>Served as charge nurse for a 24-bed ICU, coordinating staffing and triaging critical admissions during high-acuity shifts</li>
                </ul>
              </div>
              <div className="mb-4">
                <p className="text-purple-600 font-bold text-xs uppercase tracking-wide mb-2">Education</p>
                <p className="font-semibold text-gray-800 text-sm">Bachelor of Science in Nursing — University of Georgia</p>
                <p className="text-gray-400 text-xs">Graduated May 2020</p>
              </div>
              <div className="mb-4">
                <p className="text-purple-600 font-bold text-xs uppercase tracking-wide mb-2">Certifications</p>
                <p className="text-gray-700 text-sm">CCRN &nbsp;•&nbsp; ACLS &nbsp;•&nbsp; PALS &nbsp;•&nbsp; BLS</p>
              </div>
              <div className="mb-4">
                <p className="text-purple-600 font-bold text-xs uppercase tracking-wide mb-2">CRNA Shadowing Experience</p>
                <p className="text-gray-700 text-sm">40 hours shadowing CRNAs across cardiac, orthopedic, and general surgery cases — Emory University Hospital, 2023</p>
              </div>
              <div>
                <p className="text-purple-600 font-bold text-xs uppercase tracking-wide mb-2">Leadership & Involvement</p>
                <p className="text-gray-700 text-sm">Preceptor for new ICU graduate nurses &nbsp;•&nbsp; Unit-based shared governance committee member</p>
              </div>
            </div>
            <p className="text-gray-400 text-xs text-center mt-4">This is just one of 5 available template styles — yours will be built entirely from your own experience.</p>
          </div>

          {/* AI Example */}
          <div className="bg-gradient-to-r from-purple-600/20 to-pink-500/20 backdrop-blur-sm border-2 border-purple-400/30 rounded-2xl p-6 mb-8">
            <h3 className="text-lg font-bold text-white mb-4">✨ See AI in Action</h3>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-red-300 font-semibold mb-1">❌ BEFORE AI:</p>
                <p className="text-sm text-white/80 italic">"Managed CRRT for patients with kidney failure"</p>
              </div>
              <div>
                <p className="text-xs text-green-300 font-semibold mb-1">✅ AFTER AI:</p>
                <p className="text-sm text-white">"Managed continuous renal replacement therapy for critically ill patients with acute kidney injury and multi-organ dysfunction, optimizing fluid balance and electrolyte management while collaborating with nephrology to prevent complications during prolonged ICU stays"</p>
              </div>
            </div>
          </div>

          {/* Create New Resume */}
          <Link href="/resume-builder/create" className="block mb-8 p-6 bg-gradient-to-r from-purple-600 to-pink-500 rounded-2xl shadow-xl hover:opacity-90 transition text-center">
            <div className="text-4xl mb-2">📝</div>
            <h3 className="text-xl font-bold text-white mb-2">Create New Resume</h3>
            <p className="text-white/90 text-sm">Start building your CRNA application resume now</p>
          </Link>

          {/* Saved Resumes */}
          {resumes.length > 0 && (
            <div>
              <h2 className="text-2xl font-bold text-white mb-4">My Resumes</h2>
              <div className="grid md:grid-cols-2 gap-6">
                {resumes.map((resume) => (
                  <div key={resume.id} className="bg-white rounded-2xl shadow-xl p-6">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="text-xl font-bold text-gray-800">{resume.title || 'Untitled Resume'}</h3>
                        <p className="text-sm text-gray-600">Updated: {new Date(resume.updated_at).toLocaleDateString()}</p>
                      </div>
                      {resume.overall_score && (
                        <div className="text-right">
                          <div className="text-2xl font-bold text-purple-600">{resume.overall_score}/100</div>
                          <div className="text-xs text-gray-600">Score</div>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <Link href={`/resume-builder/preview/${resume.id}`} className="flex-1 text-center px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-lg hover:opacity-90 transition">
                        View
                      </Link>
                      <Link href={`/resume-builder/edit/${resume.id}`} className="flex-1 text-center px-4 py-2 border-2 border-purple-600 text-purple-600 font-semibold rounded-lg hover:bg-purple-50 transition">
                        Edit
                      </Link>
                      <button onClick={() => deleteResume(resume.id)} disabled={deleting === resume.id} className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition disabled:opacity-50">
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Feedback Section */}
          <div className="mt-8">
            <Link
              href="/feedback?feature=resume-builder"
              className="block text-center px-6 py-3 bg-white/10 border-2 border-white/30 text-white font-medium rounded-xl hover:bg-white/20 transition max-w-md mx-auto"
            >
              💬 Submit Feedback or Request Templates
            </Link>
            <p className="text-center text-indigo-200 text-sm mt-3">
              Found an issue? Want a new template? We'll message you once we implement your suggestion!
            </p>
          </div>

        </div>
      </div>
    </div>
  )
}
