'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'
import Link from 'next/link'

function FeedbackContent() {
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const feature = searchParams?.get('feature') || 'general'
  const featureName = feature === 'mock-interview' 
    ? 'Mock Interview' 
    : feature === 'resume-builder'
    ? 'Resume Builder'
    : 'General'

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }
      setIsLoggedIn(true)
      setUserEmail(user.email || '')
    }
    init()
  }, [])

const submitFeedback = async () => {
    if (!message.trim()) {
      alert('Please enter your feedback')
      return
    }

    setSubmitting(true)
    try {
      const { error } = await supabase.from('interview_feedback').insert({
        user_email: userEmail,
        message: `[${featureName}] ${message}`
      })

      if (error) {
        console.error('Insert error:', error)
        alert(`Error: ${error.message}`)
        throw error
      }

      setSubmitted(true)
    } catch (error: any) {
      console.error('Feedback error:', error)
      alert(`Failed to submit: ${error.message}`)
    } finally {
      setSubmitting(false)
    }
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
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          
          {submitted ? (
            <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
              <div className="text-6xl mb-4">✅</div>
              <h2 className="text-3xl font-bold text-gray-800 mb-4">Feedback Submitted!</h2>
              <p className="text-gray-600 mb-6">
                Thank you for your feedback. We'll review it and message you once we implement your suggestion.
              </p>
              <Link
                href={feature === 'resume-builder' ? '/resume-builder' : '/interview'}
                className="inline-block px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition"
              >
                ← Back to {featureName}
              </Link>
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-xl p-8">
              <h1 className="text-3xl font-bold text-gray-800 mb-2">Submit Feedback</h1>
              <p className="text-gray-600 mb-6">Feature: <strong>{featureName}</strong></p>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your Feedback *
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Found a bug? Want a new feature? Request a new template? Let us know!"
                  rows={8}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <p className="text-xs text-gray-500 mt-2">
                  Be as detailed as possible. We'll message you once we implement your suggestion!
                </p>
              </div>

              <div className="flex gap-4">
                <Link
                  href={feature === 'resume-builder' ? '/resume-builder' : '/interview'}
                  className="flex-1 text-center px-6 py-3 border-2 border-gray-300 text-gray-700 font-semibold rounded-xl hover:bg-gray-50 transition"
                >
                  Cancel
                </Link>
                <button
                  onClick={submitFeedback}
                  disabled={submitting || !message.trim()}
                  className="flex-1 px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold rounded-xl hover:opacity-90 transition disabled:opacity-50"
                >
                  {submitting ? 'Submitting...' : 'Submit Feedback'}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

export default function FeedbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    }>
      <FeedbackContent />
    </Suspense>
  )
}
