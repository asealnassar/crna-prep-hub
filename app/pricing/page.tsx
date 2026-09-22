'use client'

import { useState, useEffect } from 'react'
import { FREE_INTERVIEW_ALLOWANCE } from '@/lib/plans'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import {
  Lock,
  Receipt,
  Infinity as InfinityIcon,
  Mic,
  BarChart3,
  FileText,
  GraduationCap,
} from 'lucide-react'
import PricingCard from './components/PricingCard'
import ComparisonTable from './components/ComparisonTable'
import FaqAccordion from './components/FaqAccordion'
import PromoBannerEditor from './components/PromoBannerEditor'

const VALUE_PROPS = [
  {
    icon: Mic,
    title: 'AI Mock Interviews',
    description: 'Practice with realistic, AI-powered interviews and get instant feedback.',
  },
  {
    icon: BarChart3,
    title: 'GPA Intelligence',
    description: 'Calculate, analyze, and understand your GPA before you apply.',
  },
  {
    icon: FileText,
    title: 'Resume + Personal Statement',
    description: 'Build stronger application materials with AI-powered tools.',
  },
  {
    icon: GraduationCap,
    title: '130+ CRNA Programs',
    description: 'Explore programs, compare requirements, and find your best fit.',
  },
]

export default function Pricing() {
  const [loading, setLoading] = useState('')
  const [user, setUser] = useState<any>(null)
  const [userTier, setUserTier] = useState('free')
  const { sidebarCollapsed } = useSidebarCollapsed()

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

  const handleCheckout = async (plan: string) => {
    if (!user) {
      alert('Please log in first to upgrade!')
      return
    }

    setLoading(plan)

    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
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

  const isLoggedInPaidTier = !!user && (userTier === 'premium' || userTier === 'ultimate')

  return (
    <div className="min-h-screen bg-gray-50">
      <div className={`transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>

        {/* Site-wide promo banner (admin-managed marketing banner, unrelated to plan pricing) */}
        {banner && banner.is_active && (
          <div className={`bg-gradient-to-r ${banner.background_color} py-3 sm:py-4 overflow-hidden relative`}>
            <div className="absolute inset-0 bg-[length:200%_100%] bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
            <div className="relative">
              <div className="flex items-center justify-center gap-2 sm:gap-3 px-4 animate-pulse motion-reduce:animate-none">
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

            {isAdmin && (
              <div className="absolute top-2 right-2 flex gap-2">
                <button onClick={toggleBannerActive} className="px-2 py-1 bg-white/90 text-xs font-semibold rounded shadow hover:bg-white">
                  Hide
                </button>
                <button onClick={openBannerEditor} className="px-2 py-1 bg-blue-500 text-white text-xs font-semibold rounded shadow hover:bg-blue-600">
                  Edit
                </button>
              </div>
            )}
          </div>
        )}

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

        {/* ================= HERO ================= */}
        <section className="relative bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800 pt-10 sm:pt-14 pb-32 sm:pb-40 px-4 sm:px-6 lg:px-8 overflow-hidden">
          {!user && (
            <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
              <Link href="/login" className="px-4 py-2 bg-white text-purple-700 font-semibold rounded-lg hover:bg-gray-100 transition text-sm shadow-sm">
                Login
              </Link>
            </div>
          )}

          <div className="max-w-3xl mx-auto text-center">
            <span className="inline-block text-xs sm:text-sm font-semibold tracking-[0.2em] text-purple-200 mb-4">
              PRICING
            </span>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4 leading-tight">
              Choose the plan that gets you interview-ready
            </h1>
            <p className="text-base sm:text-lg text-indigo-200">
              One-time payment. Lifetime access. No subscriptions.
            </p>
          </div>
        </section>

        {/* Pricing cards overlap the hero's bottom edge */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 -mt-24 sm:-mt-28">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8 items-stretch">
            <PricingCard
              variant="free"
              name="Free"
              price="$0"
              subtitle="Explore the platform"
              features={[
                '130+ CRNA school directory',
                'Basic GPA calculator',
                'Personal statement analyzer',
                'Resume Builder (1 resume)',
                `${FREE_INTERVIEW_ALLOWANCE} mock interviews`,
              ]}
              ctaLabel="Get Started Free"
              ctaHref={!user ? '/signup' : undefined}
              isCurrentPlan={!!user && userTier === 'free'}
              isLocked={isLoggedInPaidTier}
            />

            <PricingCard
              variant="premium"
              name="Premium"
              price="$14.99"
              badges={[
                { label: 'POPULAR', className: 'bg-blue-500 text-white' },
              ]}
              subtitle="Application essentials"
              features={[
                'Everything in Free',
                'Advanced school filters',
                'State, GRE, and prerequisite filters',
                'Deadline & application method filters',
                'Direct school website links',
              ]}
              ctaLabel="Unlock Premium"
              onCtaClick={() => handleCheckout('premium')}
              loading={loading === 'premium'}
              isCurrentPlan={!!user && userTier === 'premium'}
            />

            <PricingCard
              variant="ultimate"
              name="Ultimate"
              price="$39.99"
              badges={[{ label: 'BEST VALUE', className: 'bg-gradient-to-r from-purple-600 to-pink-500 text-white' }]}
              subtitle="Complete CRNA prep"
              features={[
                'Everything in Premium',
                'Unlimited AI mock interviews',
                'School-specific interview prep',
                'Advanced GPA analytics',
                'AI personal statement rewrites',
                'Sentence-level essay feedback & improvements',
                'Unlimited resumes',
                'Finalize professional resumes',
                'PDF & DOCX resume export',
                'Priority support',
              ]}
              ctaLabel="Get Ultimate — Lifetime Access"
              onCtaClick={() => handleCheckout('ultimate')}
              loading={loading === 'ultimate'}
              isCurrentPlan={!!user && userTier === 'ultimate'}
              footnote={!(user && userTier === 'ultimate') ? "Have a promo code? You'll be able to enter it at checkout." : undefined}
            />
          </div>

          {/* Trust strip */}
          <div className="mt-10 sm:mt-14 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-gray-500">
            <span className="inline-flex items-center gap-2">
              <Lock className="h-4 w-4 text-gray-400" aria-hidden="true" />
              Secure checkout
            </span>
            <span className="inline-flex items-center gap-2">
              <Receipt className="h-4 w-4 text-gray-400" aria-hidden="true" />
              One-time payment
            </span>
            <span className="inline-flex items-center gap-2">
              <InfinityIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
              Lifetime access
            </span>
          </div>
        </section>

        {/* ================= VALUE PROPOSITION ================= */}
        <section className="mt-20 sm:mt-28 bg-gray-50 py-16 sm:py-20 px-4 sm:px-6 lg:px-8">
          <div className="max-w-6xl mx-auto">
            <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
              <span className="inline-block text-xs sm:text-sm font-semibold tracking-[0.2em] text-purple-600 mb-3">
                MORE THAN A TOOLKIT
              </span>
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
                Everything you need to get into CRNA school
              </h2>
              <p className="text-base sm:text-lg text-gray-500">
                Powerful tools, real insights, and everything in one place.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {VALUE_PROPS.map((item) => (
                <div
                  key={item.title}
                  className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="h-11 w-11 rounded-xl bg-purple-50 flex items-center justify-center mb-4">
                    <item.icon className="h-5 w-5 text-purple-600" aria-hidden="true" />
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-1.5">{item.title}</h3>
                  <p className="text-sm text-gray-500 leading-relaxed">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ================= PLAN COMPARISON ================= */}
        <section className="bg-white py-16 sm:py-20 px-4 sm:px-6 lg:px-8">
          <div className="max-w-5xl mx-auto">
            <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
              <span className="inline-block text-xs sm:text-sm font-semibold tracking-[0.2em] text-purple-600 mb-3">
                PLAN COMPARISON
              </span>
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900">
                Compare plans side by side
              </h2>
            </div>

            <ComparisonTable />
          </div>
        </section>

        {/* ================= FAQ ================= */}
        <section className="bg-gray-50 py-16 sm:py-20 px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto">
            <div className="text-center mb-10 sm:mb-14">
              <span className="inline-block text-xs sm:text-sm font-semibold tracking-[0.2em] text-purple-600 mb-3">
                FREQUENTLY ASKED QUESTIONS
              </span>
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900">
                Common questions
              </h2>
            </div>

            <FaqAccordion />

            <p className="text-center text-sm text-gray-400 mt-10">
              Questions? Contact support@crnaprephub.com
            </p>
          </div>
        </section>
      </div>

      {showBannerEditor && editingBanner && (
        <PromoBannerEditor
          editingBanner={editingBanner}
          setEditingBanner={setEditingBanner}
          onSave={saveBanner}
          onDelete={deleteBanner}
          onClose={() => setShowBannerEditor(false)}
          saving={savingBanner}
          hasExistingBanner={!!banner}
        />
      )}

      <style jsx global>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .animate-shimmer {
          animation: shimmer 3s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .animate-shimmer {
            animation: none;
          }
        }
      `}</style>
    </div>
  )
}
