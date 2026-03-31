'use client'

import { useState, useEffect } from 'react'
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
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
        <Sidebar isLoggedIn={isLoggedIn} userEmail={userEmail} isAdmin={userEmail === 'asealnassar@gmail.com'} onCollapsedChange={setSidebarCollapsed} />
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
                Upgrade to Ultimate - $34.99
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
      <Sidebar isLoggedIn={isLoggedIn} userEmail={userEmail} isAdmin={userEmail === 'asealnassar@gmail.com'} onCollapsedChange={setSidebarCollapsed} />
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
