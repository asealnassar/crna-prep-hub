'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { trackSignup } from '@/lib/analytics/tracking/client'
import { advertisingAllowed } from '@/lib/consent/client'

export default function SignUp() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const supabase = createClient()

const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      })

      if (error) throw error

      if (data.user) {
        // The profile row is created by the handle_new_user() trigger on
        // auth.users (SECURITY DEFINER), which sets subscription_tier='free'
        // and interview_count=0. The browser used to insert it as well, which
        // was redundant and required the authenticated role to hold INSERT on
        // user_profiles — a privilege that also let it write usage fields.

        // Link this browser's anonymous visit history to the account it just
        // became, so the acquisition funnel has an end. Fire-and-forget: it
        // does not block the redirect and cannot fail the signup. This is a
        // first-party record only -- the TikTok conversion below is untouched
        // and is still the single signal that platform receives.
        trackSignup(data.user.id)

        // Track signup with TikTok — ONLY with advertising consent.
        //
        // This is the one advertising behaviour this release changes, and it
        // is deliberate: this request sends the registrant's EMAIL ADDRESS to
        // TikTok. Holding the pixel back while letting this through would make
        // the consent banner decorative for the most sensitive flow on the
        // site. The event, the endpoint and the payload are otherwise
        // untouched, so a consenting visitor produces exactly the same single
        // conversion TikTok has always received.
        if (advertisingAllowed()) {
        try {
          await fetch('/api/tiktok-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              eventName: 'CompleteRegistration',
              email: email,
            }),
          })
        } catch (err) {
          console.error('TikTok tracking error:', err)
        }
        }

        alert('Account created! You can now log in.')
        router.push('/login')
      }
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
          <p className="text-gray-600 mt-2">Create your account</p>
        </div>

        <form onSubmit={handleSignUp} className="space-y-6">
          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Creating account...' : 'Sign Up'}
          </button>
        </form>

        <p className="text-center text-gray-600 mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-blue-600 hover:underline">
            Log in
          </Link>
        </p>
      </div>
    </div>
  )
}
