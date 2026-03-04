'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'

export default function Pricing() {
  const [loading, setLoading] = useState('')
  const [user, setUser] = useState<any>(null)
  const [userTier, setUserTier] = useState('free')
  const [promoCode, setPromoCode] = useState('')
  const [promoValid, setPromoValid] = useState<boolean | null>(null)
  const [promoData, setPromoData] = useState<any>(null)
  const [checkingPromo, setCheckingPromo] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)
      
      if (user) {
        const { data: profile } = await supabase.from('user_profiles').select('subscription_tier').eq('id', user.id).single()
        if (profile) {
          setUserTier(profile.subscription_tier || 'free')
        }
      }
    }
    getUser()
  }, [])

  const checkPromoCode = async () => {
    if (!promoCode.trim()) return
    setCheckingPromo(true)
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('code', promoCode.toUpperCase().trim())
      .eq('is_active', true)
      .single()

    if (data && !error) {
      setPromoValid(true)
      setPromoData(data)
    } else {
      setPromoValid(false)
      setPromoData(null)
    }
    setCheckingPromo(false)
  }

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
        body: JSON.stringify({
          priceId,
          userEmail: user.email,
          promoCode: promoValid ? promoCode.toUpperCase().trim() : null,
          plan
        }),
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

  const discountAmount = promoData?.discount_amount ? promoData.discount_amount / 100 : 0
  const premiumPrice = promoValid ? (29.99 - discountAmount).toFixed(2) : '29.99'
  const ultimatePrice = promoValid ? (49.99 - discountAmount).toFixed(2) : '49.99'

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar 
        isLoggedIn={!!user} 
        userEmail={user?.email || ''} 
        isAdmin={user?.email === 'asealnassar@gmail.com'}
        onCollapsedChange={setSidebarCollapsed}
      />
      
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="bg-white/10 backdrop-blur-md border-b border-white/10 px-4 sm:px-6 py-4 flex justify-end">
          {!user && (
            <Link href="/login" className="px-4 py-2 bg-white text-purple-600 font-semibold rounded-lg hover:bg-gray-100 transition text-sm">
              Login
            </Link>
          )}
        </div>
        
        <div className="bg-gradient-to-r from-yellow-500 to-orange-500 py-2 sm:py-3 px-4 text-center">
          <a href="/interview-prep" className="text-black text-xs sm:text-sm font-semibold hover:underline">🚀 NEW: School-Specific Interview Prep is NOW LIVE for Ultimate members →</a>
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
          <div className="text-center mb-6 sm:mb-8">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white mb-3 sm:mb-4">Choose Your Plan</h1>
            <p className="text-base sm:text-lg lg:text-xl text-indigo-200">One-time payment. Lifetime access. No subscriptions.</p>
          </div>

          <div className="max-w-md mx-auto mb-6 sm:mb-8">
            <div className="bg-white/10 backdrop-blur-md rounded-xl p-4">
              <label className="block text-white text-sm font-medium mb-2">Have a promo code?</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={promoCode}
                  onChange={(e) => { setPromoCode(e.target.value); setPromoValid(null); setPromoData(null); }}
                  placeholder="Enter code"
                  className="flex-1 px-3 sm:px-4 py-2 rounded-lg bg-white/20 text-white placeholder-white/50 border border-white/30 focus:outline-none focus:ring-2 focus:ring-purple-400 text-sm sm:text-base"
                />
                <button
                  onClick={checkPromoCode}
                  disabled={checkingPromo || !promoCode.trim()}
                  className="px-3 sm:px-4 py-2 bg-purple-500 text-white rounded-lg font-semibold hover:bg-purple-600 disabled:opacity-50 transition text-sm sm:text-base"
                >
                  {checkingPromo ? '...' : 'Apply'}
                </button>
              </div>
              {promoValid === true && (
                <p className="text-green-400 text-sm mt-2">✓ Code applied! ${discountAmount} off your purchase</p>
              )}
              {promoValid === false && (
                <p className="text-red-400 text-sm mt-2">✗ Invalid or expired code</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8">

            {/* FREE PLAN */}
            <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 border-2 border-gray-200">
              <h2 className="text-xl sm:text-2xl font-bold mb-2 text-gray-800">Free</h2>
              <p className="text-3xl sm:text-4xl font-bold mb-3 sm:mb-4 text-gray-800">$0</p>
              <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">Get started with basic features</p>

              <ul className="space-y-2 sm:space-y-3 mb-6 sm:mb-8 text-sm sm:text-base">
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> View all 149+ CRNA schools</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Search schools</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> GPA filter</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Tuition filter</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> <strong>1 free AI mock interview</strong></li>
                <li className="flex items-center text-gray-400"><span className="mr-2">✗</span> Advanced filters</li>
                <li className="flex items-center text-gray-400"><span className="mr-2">✗</span> Unlimited interviews</li>
              </ul>

              {user && userTier === 'free' ? (
                <button className="w-full py-2 sm:py-3 rounded-xl border-2 border-gray-300 text-gray-600 font-semibold cursor-default text-sm sm:text-base">
                  Current Plan
                </button>
              ) : (
                <button disabled className="w-full py-2 sm:py-3 rounded-xl border-2 border-gray-300 text-gray-400 font-semibold opacity-50 cursor-not-allowed text-sm sm:text-base">
                  —
                </button>
              )}
            </div>

            {/* PREMIUM PLAN */}
            <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 border-2 border-blue-500 relative">
              <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-blue-500 text-white px-3 sm:px-4 py-1 rounded-full text-xs sm:text-sm font-semibold">
                POPULAR
              </div>
              <h2 className="text-xl sm:text-2xl font-bold mb-2 text-gray-800">Premium</h2>
              <div className="mb-3 sm:mb-4">
                {promoValid ? (
                  <>
                    <span className="text-xl sm:text-2xl text-gray-400 line-through">${'29.99'}</span>
                    <span className="text-3xl sm:text-4xl font-bold text-gray-800 ml-2">${premiumPrice}</span>
                  </>
                ) : (
                  <span className="text-3xl sm:text-4xl font-bold text-gray-800">$29.99</span>
                )}
              </div>
              <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">All filters to find your perfect school</p>

              <ul className="space-y-2 sm:space-y-3 mb-6 sm:mb-8 text-sm sm:text-base">
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Everything in Free</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by state</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by application dates</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by prerequisites</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Filter by GRE, interview method</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Save favorite schools</li>
                <li className="flex items-center text-gray-400"><span className="mr-2">✗</span> Unlimited interviews</li>
              </ul>

              {user && userTier === 'premium' ? (
                <button className="w-full py-2 sm:py-3 rounded-xl bg-blue-600 text-white font-semibold cursor-default text-sm sm:text-base">
                  Current Plan
                </button>
              ) : (
                <button onClick={() => handleCheckout('premium')} disabled={loading === 'premium'} className="w-full py-2 sm:py-3 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold hover:opacity-90 transition disabled:opacity-50 text-sm sm:text-base">
                  {loading === 'premium' ? 'Loading...' : 'Upgrade to Premium'}
                </button>
              )}
            </div>

            {/* ULTIMATE PLAN */}
            <div className="bg-white rounded-2xl shadow-xl p-6 sm:p-8 border-2 border-purple-500 relative">
              <div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-gradient-to-r from-purple-600 to-pink-500 text-white px-3 sm:px-4 py-1 rounded-full text-xs sm:text-sm font-semibold">
                BEST VALUE
              </div>
              <h2 className="text-xl sm:text-2xl font-bold mb-2 text-gray-800">Ultimate</h2>
              <div className="mb-3 sm:mb-4">
                {promoValid ? (
                  <>
                    <span className="text-xl sm:text-2xl text-gray-400 line-through">${'49.99'}</span>
                    <span className="text-3xl sm:text-4xl font-bold text-gray-800 ml-2">${ultimatePrice}</span>
                  </>
                ) : (
                  <span className="text-3xl sm:text-4xl font-bold text-gray-800">$49.99</span>
                )}
              </div>
              <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">Everything you need to succeed</p>

              <ul className="space-y-2 sm:space-y-3 mb-6 sm:mb-8 text-sm sm:text-base">
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Everything in Premium</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> <strong>Unlimited AI mock interviews</strong></li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Voice-powered interviews</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Detailed performance feedback</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> <strong>School-specific interview styles</strong></li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Priority support</li>
                <li className="flex items-center"><span className="text-green-500 mr-2">✓</span> Future updates included</li>
              </ul>

              {user && userTier === 'ultimate' ? (
                <button className="w-full py-2 sm:py-3 rounded-xl bg-purple-600 text-white font-semibold cursor-default text-sm sm:text-base">
                  ⭐ Current Plan
                </button>
              ) : (
                <button onClick={() => handleCheckout('ultimate')} disabled={loading === 'ultimate'} className="w-full py-2 sm:py-3 rounded-xl bg-gradient-to-r from-purple-600 to-pink-500 text-white font-semibold hover:opacity-90 transition disabled:opacity-50 text-sm sm:text-base">
                  {loading === 'ultimate' ? 'Loading...' : 'Upgrade to Ultimate'}
                </button>
              )}
            </div>

          </div>
          
          <div className="text-center mt-8 sm:mt-12 text-indigo-200 text-sm sm:text-base">
            <p>🔒 Secure payment powered by Stripe</p>
            <p className="mt-2">Questions? Contact support@crnaprephub.com</p>
          </div>
        </div>
      </div>
    </div>
  )
}
