'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const supabase = createClient()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })

      if (error) throw error
      setSent(true)
    } catch (error: any) {
      setError(error.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-xl p-8">
        <div className="text-center mb-8">
          <Link href="/">
            <h1 className="text-3xl font-bold text-blue-600">CRNA Prep Hub</h1>
          </Link>
          <p className="text-gray-600 mt-2">Reset your password</p>
        </div>

        {sent ? (
          <div className="text-center py-6">
            <div className="text-5xl mb-4">📧</div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">Check your email</h2>
            <p className="text-gray-600 text-sm mb-6">
              We sent a password reset link to <strong>{email}</strong>. Click the link in that email to set a new password.
            </p>
            <Link href="/login" className="text-blue-600 hover:underline text-sm">
              ← Back to login
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <p className="text-gray-600 text-sm">
              Enter the email associated with your account and we'll send you a link to reset your password.
            </p>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>

            <p className="text-center text-gray-600">
              <Link href="/login" className="text-blue-600 hover:underline text-sm">
                ← Back to login
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
