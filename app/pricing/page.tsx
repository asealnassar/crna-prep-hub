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
  
  // Banner states
  const [banner, setBanner] = useState<any>(null)
  const [showBannerEditor, setShowBannerEditor] = useState(false)
  const [editingBanner, setEditingBanner] = useState<any>(null)
  const [savingBanner, setSavingBanner] = useState(false)
  
  const supabase = createClient()
  const isAdmin = user?.email === 'asealnassar@gmail.com'

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
    loadBanner()
  }, [])

  const loadBanner = async () => {
    const { data } = await supabase
      .from('promo_banner')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    
    if (data) setBanner(data)
  }

  const toggleBannerActive = async () => {
    if (!banner) return
    await supabase
      .from('promo_banner')
      .update({ is_active: !banner.is_active })
      .eq('id', banner.id)
    loadBanner()
  }

  const openBannerEditor = () => {
    setEditingBanner({
      banner_text: banner?.banner_text || '',
      promo_code: banner?.promo_code || '',
      expiry_date: banner?.expiry_date || '',
      background_color: banner?.background_color || 'from-red-600 via-orange-500 to-red-600',
    })
    setShowBannerEditor(true)
  }

  const saveBanner = async () => {
    setSavingBanner(true)
    if (banner) {
      await supabase
        .from('promo_banner')
        .update({
          ...editingBanner,
          updated_at: new Date().toISOString()
        })
        .eq('id', banner.id)
    } else {
      await supabase
        .from('promo_banner')
        .insert({
          ...editingBanner,
          is_active: true
        })
    }
    setSavingBanner(false)
    setShowBannerEditor(false)
    loadBanner()
  }

  const deleteBanner = async () => {
    if (!confirm('Delete this banner?')) return
    await supabase.from('promo_banner').delete().eq('id', banner.id)
    setBanner(null)
    setShowBannerEditor(false)
  }

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

  const renderBannerText = (text: string, code: string) => {
    return text.split('{CODE}').map((part, idx, arr) => (
      idx < arr.length - 1 ? (
        <span key={idx}>
          {part}
          <span className="bg-yellow-300 text-red-600 px-2 sm:px-3 py-1 rounded-lg mx-1 sm:mx-2 font-mono text-base sm:text-xl">
            {code}
          </span>
        </span>
      ) : part
    ))
  }

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <Sidebar
        isLoggedIn={!!user}
        userEmail={user?.email || ''}
        isAdmin={isAdmin}
        onCollapsedChange={setSidebarCollapsed}
      />

      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        
        {/* Promo Banner */}
        {banner && banner.is_active && (
          <div className={`bg-gradient-to-r ${banner.background_color} py-3 sm:py-4 overflow-hidden relative`}>
            <div className="absolute inset-0 bg-[length:200%_100%] bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
            <div className="relative">
              <div className="flex items-center justify-center gap-2 sm:gap-3 px-4 animate-pulse">
                <span className="text-2xl sm:text-3xl">🎉</span>
                <div className="text-center">
                  <p className="text-white font-black text-sm sm:text-base md:text-lg">
                    {renderBannerText(banner.banner_text, banner.promo_code)}
                  </p>
                  {banner.expiry_date && (
                    <p className="text-white/90 text-xs sm:text-sm font-semibold">
                      Expires {new Date(banner.expiry_date).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <span className="text-2xl sm:text-3xl">🎉</span>
              </div>
            </div>
            
            {/* Admin Controls Overlay */}
            {isAdmin && (
              <div className="absolute top-2 right-2 flex gap-2">
                <button
                  onClick={toggleBannerActive}
                  className="px-2 py-1 bg-white/90 text-xs font-semibold rounded shadow hover:bg-white"
                >
                  Hide
                </button>
                <button
                  onClick={openBannerEditor}
                  className="px-2 py-1 bg-blue-500 text-white text-xs font-semibold rounded shadow hover:bg-blue-600"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
        )}

        {/* Admin: No Banner / Inactive Banner */}
        {isAdmin && (!banner || !banner.is_active) && (
          <div className="bg-yellow-500 py-3 px-4 text-center">
            <button
              onClick={() => banner ? toggleBannerActive() : openBannerEditor()}
              className="text-black text-sm font-semibold underline hover:no-underline"
            >
              {banner ? '👁️ Show Banner' : '➕ Create Promo Banner'}
            </button>
          </div>
        )}

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
              <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">Get Started With The Basics</p>
                  
              <ul className="space-y-2 sm:space-y-3 mb-6 sm:mb-8 text-sm sm:text-base">
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Browse 130+ CRNA programs</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Basic filters (GPA, tuition, program type, format, application opening)</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Save favorite schools</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Basic GPA calculator</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Basic personal statement analyzer</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span><strong>1 free mock interview</strong></span></li>
                <li className="flex items-start gap-2 text-gray-400"><span>✗</span><span>Advanced filters (state, deadline, GRE, prerequisites)</span></li>
                <li className="flex items-start gap-2 text-gray-400"><span>✗</span><span>Unlimited mock interviews</span></li>
                <li className="flex items-start gap-2 text-gray-400"><span>✗</span><span>Premium GPA analytics</span></li>
                <li className="flex items-start gap-2 text-gray-400"><span>✗</span><span>AI essay rewrites</span></li>
                <li className="flex items-start gap-2 text-gray-400"><span>✗</span><span>School-specific interview prep</span></li>
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
              <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">Find Schools with a few clicks!</p>

              <ul className="space-y-2 sm:space-y-3 mb-6 sm:mb-8 text-sm sm:text-base">
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Everything in Free</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Advanced school filters</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Filter by state, GRE, prerequisites</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Filter by application deadlines</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Application method filters</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Direct school website links</span></li>
                <li className="flex items-start gap-2 text-gray-400"><span>✗</span><span>Advanced GPA analytics</span></li>
                <li className="flex items-start gap-2 text-gray-400"><span>✗</span><span>AI personal statement rewrites</span></li>
                <li className="flex items-start gap-2 text-gray-400"><span>✗</span><span>School-specific interview styles</span></li>
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
              <p className="text-sm sm:text-base text-gray-600 mb-4 sm:mb-6">Everything You Need To Get In</p>

              <ul className="space-y-2 sm:space-y-3 mb-6 sm:mb-8 text-sm sm:text-base">
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Everything in Premium</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Advanced GPA calculator with trends</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Semester-by-semester GPA analysis</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Advanced personal statement analyzer</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span><strong>AI-powered essay rewrites</strong></span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Sentence-level feedback & improvements</span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span><strong>School-specific interview styles</strong></span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span><strong>Unlimited mock interviews</strong></span></li>
                <li className="flex items-start gap-2"><span className="text-green-500">✓</span><span>Priority support</span></li>
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

      {/* Banner Editor Modal */}
      {showBannerEditor && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold mb-4">Edit Promo Banner</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Banner Text (use {'{CODE}'} for promo code)</label>
                <input
                  type="text"
                  value={editingBanner?.banner_text || ''}
                  onChange={(e) => setEditingBanner({...editingBanner, banner_text: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="LIMITED TIME: Use code {CODE} for $15 OFF!"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Promo Code</label>
                <input
                  type="text"
                  value={editingBanner?.promo_code || ''}
                  onChange={(e) => setEditingBanner({...editingBanner, promo_code: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="MARCH15"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Expiry Date</label>
                <input
                  type="date"
                  value={editingBanner?.expiry_date || ''}
                  onChange={(e) => setEditingBanner({...editingBanner, expiry_date: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Background Color (Tailwind classes)</label>
                <select
                  value={editingBanner?.background_color || ''}
                  onChange={(e) => setEditingBanner({...editingBanner, background_color: e.target.value})}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="from-red-600 via-orange-500 to-red-600">Red to Orange</option>
                  <option value="from-blue-600 via-purple-500 to-blue-600">Blue to Purple</option>
                  <option value="from-green-600 via-teal-500 to-green-600">Green to Teal</option>
                  <option value="from-purple-600 via-pink-500 to-purple-600">Purple to Pink</option>
                  <option value="from-yellow-500 via-orange-500 to-yellow-500">Yellow to Orange</option>
                </select>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={saveBanner}
                disabled={savingBanner}
                className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 disabled:opacity-50"
              >
                {savingBanner ? 'Saving...' : 'Save Banner'}
              </button>
              {banner && (
                <button
                  onClick={deleteBanner}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                >
                  Delete
                </button>
              )}
              <button
                onClick={() => setShowBannerEditor(false)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg font-semibold hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .animate-shimmer {
          animation: shimmer 3s linear infinite;
        }
      `}</style>
    </div>
  )
}
