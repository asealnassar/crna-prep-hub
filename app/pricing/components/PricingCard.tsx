'use client'

import { Check } from 'lucide-react'
import Link from 'next/link'

export interface PricingCardBadge {
  label: string
  className: string
}

interface PricingCardProps {
  name: string
  originalPrice?: string
  price: string
  subtitle: string
  features: string[]
  badges?: PricingCardBadge[]
  ctaLabel: string
  onCtaClick?: () => void
  ctaHref?: string
  loading?: boolean
  /** The signed-in user already owns this exact plan. */
  isCurrentPlan: boolean
  /** Signed in with a different plan that this card's action cannot act on (e.g. Free card for a paying user). */
  isLocked?: boolean
  footnote?: string
  variant: 'free' | 'premium' | 'ultimate'
}

const VARIANT_STYLES: Record<PricingCardProps['variant'], string> = {
  free: 'bg-white border border-gray-200 shadow-sm',
  premium: 'bg-white border border-blue-200 shadow-lg',
  ultimate: 'bg-gradient-to-b from-purple-50/60 to-white shadow-2xl',
}

const CTA_STYLES: Record<PricingCardProps['variant'], string> = {
  free: 'bg-gray-900 text-white hover:bg-gray-800',
  premium: 'bg-gradient-to-r from-blue-600 to-purple-600 text-white hover:opacity-90',
  ultimate: 'bg-gradient-to-r from-purple-600 to-pink-500 text-white hover:opacity-90 shadow-lg shadow-purple-500/30',
}

export default function PricingCard({
  name,
  originalPrice,
  price,
  subtitle,
  features,
  badges,
  ctaLabel,
  onCtaClick,
  ctaHref,
  loading,
  isCurrentPlan,
  isLocked,
  footnote,
  variant,
}: PricingCardProps) {
  const card = (
    <div className={`relative flex flex-col h-full rounded-2xl p-6 sm:p-8 transition-shadow motion-safe:transition-transform duration-300 hover:shadow-2xl ${VARIANT_STYLES[variant]}`}>
      {badges && badges.length > 0 && (
        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 flex gap-2 flex-wrap justify-center px-2">
          {badges.map((badge) => (
            <span
              key={badge.label}
              className={`px-3 py-1 rounded-full text-[11px] sm:text-xs font-semibold tracking-wide whitespace-nowrap shadow-sm ${badge.className}`}
            >
              {badge.label}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 mb-1">
        <h3 className="text-lg sm:text-xl font-bold text-gray-900">{name}</h3>
        {isCurrentPlan && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700 ring-1 ring-inset ring-green-200">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Your current plan
          </span>
        )}
      </div>

      <div className="mb-2 flex items-baseline gap-2">
        {originalPrice && <span className="text-lg text-gray-400 line-through">{originalPrice}</span>}
        <span className="text-4xl font-extrabold text-gray-900 tracking-tight">{price}</span>
      </div>
      <p className="text-sm text-gray-500 mb-6">{subtitle}</p>

      <ul className="space-y-3 mb-8 text-sm text-gray-700 flex-1">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5">
            <Check className="h-4 w-4 mt-0.5 text-purple-600 shrink-0" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {isCurrentPlan ? (
        <button
          type="button"
          disabled
          className="w-full py-3 rounded-xl border border-gray-200 text-gray-400 font-semibold text-sm cursor-default"
        >
          You&apos;re all set
        </button>
      ) : isLocked ? (
        <button
          type="button"
          disabled
          className="w-full py-3 rounded-xl border border-gray-200 text-gray-300 font-semibold text-sm cursor-not-allowed"
        >
          Included in your plan
        </button>
      ) : ctaHref ? (
        <Link
          href={ctaHref}
          className={`w-full inline-flex items-center justify-center py-3 rounded-xl font-semibold text-sm transition motion-safe:hover:scale-[1.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 ${CTA_STYLES[variant]}`}
        >
          {ctaLabel}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onCtaClick}
          disabled={loading}
          className={`w-full py-3 rounded-xl font-semibold text-sm transition motion-safe:hover:scale-[1.02] disabled:opacity-60 disabled:cursor-wait focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 ${CTA_STYLES[variant]}`}
        >
          {loading ? 'Loading…' : ctaLabel}
        </button>
      )}

      {footnote && <p className="text-xs text-gray-400 text-center mt-3">{footnote}</p>}
    </div>
  )

  if (variant === 'ultimate') {
    return (
      <div className="h-full rounded-2xl p-[2px] bg-gradient-to-br from-purple-500 to-pink-500 shadow-xl lg:-translate-y-3">
        {card}
      </div>
    )
  }

  return <div className={variant === 'premium' ? 'h-full lg:-translate-y-1' : 'h-full'}>{card}</div>
}
