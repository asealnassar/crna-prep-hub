'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'

export default function Pricing() {
  const [loading, setLoading] = useState('')
  const [user, setUser] = useState<any>(null)
  const supabase = createClient()

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)
    }
    getUser()
  }, [])

  const handleCheckout = async (plan: string) => {
    if (!user) {
      alert('Please log in first to upgrade!')
      return
    }

    setLoading(plan)

    const priceId = plan === 'premium' 
      ? process.env.NEXT_PUBLIC_PREMIUM_PRICE_ID 
      : process.env.NEXT_PUBLIC_ULTIMATE_PRICE_ID

    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, userEmail: user.email }),
      })

      const data = await response.json()
      
      if (data.url) {
        window.location.href = data.url
      }
    } catch (error) {
      alert('Something went wrong. Please try again.')
    }

    setLoading('')
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <nav className="bg-white/10 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <Link href="/"><h1 className="text-2xl font-bold text-white">CRNA Prep Hub</h1></Link>
            <div className="flex gap-6">
              <Link href="/dashboard" className="text-white/80 hover:text-white transition">Dashboard</Link>
              <Link href="/schools" className="text-white/80 hover:text-white transition">Schools</Link>
              <Link href="/interview" className="text-white/80 hover:text-white transition">Mock Interview</Link>
              <Link href="/pricing" className="text-white font-semibold">Pricing</Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-4 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-white mb-4">Choose Your Plan</h1>
          <p className="text-xl text-indigo-200">One-time payment. Lifetime access. No subscriptions.</p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          
          <div className="bg-white rounded-2xl shadow-xl p-8 border-2 border-gray-200">
            <h2 className="text-2xl font-bold mb-2 text-gray-800">Free</h2>
            <p className="text-4xl font-bold mb-4 text-gray-800">$0</p>
            <p className="text-gray-600 mb-6">Get started with basic features</p>
            
            <ul className="space-y-3 mb-8">
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> View all 149+ CRNA schools</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Search schools</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> GPA filter</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Tuition filter</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> <strong>1 free AI mock interview</strong></li>
              <li className="flex items-center text-gray-400"><span className="mr-2">✗</span> Advanced filters</li>
              <li className="flex items-center text-gray-400"><span className="mr-2">✗</span> Unlimited interviews</li>
            </ul>
            
            <button className="w-full py-3 rounded-xl border-2 border-gray-300 text-gray-600 font-semibold cursor-default">
              Current Plan
            </button>
          </div>

          <div className="bg-white rounded-2xl shadow-xl p-8 border-2 border-blue-500 relative">
            <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-blue-500 text-white px-4 py-1 rounded-full text-sm font-semibold">
              POPULAR
            </div>
            <h2 className="text-2xl font-bold mb-2 text-gray-800">Premium</h2>
            <p className="text-4xl font-bold mb-4 text-gray-800">$29.99</p>
            <p className="text-gray-600 mb-6">All filters to find your perfect school</p>
            
            <ul className="space-y-3 mb-8">
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Everything in Free</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by state</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by application dates</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by GRE requirements</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by prerequisites</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by application method</li>
              <li className="flex items-center text-gray-400"><span className="mr-2">✗</span> Unlimited interviews</li>
            </ul>
            
            <button
              onClick={() => handleCheckout('premium')}
              disabled={loading === 'premium'}
              className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {loading === 'premium' ? 'Loading...' : 'Upgrade to Premium'}
            </button>
          </div>

          <div className="bg-white rounded-2xl shadow-xl p-8 border-2 border-purple-500 relative">
            <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-purple-500 text-white px-4 py-1 rounded-full text-sm font-semibold">
              BEST VALUE
            </div>
            <h2 className="text-2xl font-bold mb-2 text-gray-800">Ultimate</h2>
            <p className="text-4xl font-bold mb-4 text-gray-800">$49.99</p>
            <p className="text-gray-600 mb-6">Everything you need to get accepted</p>
            
            <ul className="space-y-3 mb-8">
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Everything in Premium</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> <strong>Unlimited AI mock interviews</strong></li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Behavioral interviews</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Clinical interviews</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Custom topic interviews</li>
              <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Priority support</li>
            </ul>
            
            <button
              onClick={() => handleCheckout('ultimate')}
              disabled={loading === 'ultimate'}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold hover:opacity-90 disabled:opacity-50 transition"
            >
              {loading === 'ultimate' ? 'Loading...' : 'Upgrade to Ultimate'}
            </button>
          </div>

        </div>

        <div className="text-center mt-12 text-indigo-200">
          <p>🔒 Secure payment powered by Stripe</p>
          <p className="mt-2">Questions? Contact support@crnaprephub.com</p>
        </div>
      </div>
    </div>
  )
}