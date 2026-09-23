'use client'

import { openPrivacyChoices } from '@/components/ConsentBanner'

/**
 * Reopens the consent banner.
 *
 * This button is the reason the policy page is not just words: an opt-out that
 * exists only on a visitor's first ever page load is not an opt-out, and every
 * US state privacy law that matters here expects a standing way to withdraw.
 */
export default function PrivacyChoicesButton() {
  return (
    <button
      type="button"
      onClick={openPrivacyChoices}
      className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
    >
      Change your privacy choices
    </button>
  )
}
