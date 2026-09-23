'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ACCEPT_ALL,
  REJECT_ALL,
  applyConsent,
  fetchRegime,
  saveConsent,
  storedConsent,
} from '@/lib/consent/client'
import { defaultState, needsDecision, type ConsentState, type Regime } from '@/lib/consent/policy'

/**
 * The consent notice.
 *
 * IT SAYS TWO DIFFERENT THINGS, because two different things are true:
 *
 *   Where prior consent is required (EEA, UK, Switzerland) it ASKS, and
 *   nothing non-essential has run when it appears. There is a Reject button
 *   with the same weight as Accept — a notice with only an "OK" is not a
 *   choice, and a reject buried one level down is the pattern regulators
 *   single out.
 *
 *   Everywhere else it TELLS, advertising is already running as it always has,
 *   and the same controls are offered. Nobody's campaign changes.
 *
 * IT CAN ALWAYS BE REOPENED, from the Privacy Policy page and from the footer,
 * because an opt-out that only exists on first visit is not an opt-out.
 *
 * It is rendered from the root layout and returns null on the admin section,
 * which is not public and is never tracked.
 */

const HIDDEN_ON = [/^\/admin(\/|$)/]

export default function ConsentBanner() {
  const [regime, setRegime] = useState<Regime | null>(null)
  const [visible, setVisible] = useState(false)
  const [showChoices, setShowChoices] = useState(false)
  const [analytics, setAnalytics] = useState(true)
  const [advertising, setAdvertising] = useState(true)

  const decide = useCallback((state: ConsentState) => {
    saveConsent(state)
    setVisible(false)
    setShowChoices(false)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (HIDDEN_ON.some((pattern) => pattern.test(window.location.pathname))) return

    let cancelled = false

    const start = async () => {
      const stored = storedConsent()

      if (!needsDecision(stored)) {
        // Already decided. Re-assert it on every page load so a tag that
        // loaded late still hears the answer.
        if (stored) applyConsent(stored)
        return
      }

      const found = await fetchRegime()
      if (cancelled) return

      setRegime(found)
      // Where consent is not required first, the regional default is applied
      // immediately so advertising keeps behaving exactly as it did before.
      // Where it is required, this applies "denied" and nothing starts.
      applyConsent(defaultState(found))
      setVisible(true)
    }

    void start()

    const reopen = () => {
      setShowChoices(true)
      setVisible(true)
      const current = storedConsent()
      setAnalytics(current ? current.analytics === 'granted' : true)
      setAdvertising(current ? current.advertising === 'granted' : true)
      if (regime === null) void fetchRegime().then((found) => !cancelled && setRegime(found))
    }
    window.addEventListener('cph:open-privacy-choices', reopen)

    return () => {
      cancelled = true
      window.removeEventListener('cph:open-privacy-choices', reopen)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!visible) return null

  const asking = regime === 'opt_in'

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Privacy choices"
      className="fixed inset-x-0 bottom-0 z-[100] border-t border-slate-200 bg-white/95 p-4 shadow-[0_-4px_24px_rgba(15,23,42,0.08)] backdrop-blur sm:p-5"
    >
      <div className="mx-auto max-w-5xl">
        {!showChoices ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="text-sm leading-relaxed text-slate-700">
              {asking ? (
                <>
                  We&rsquo;d like to use cookies to measure how the site is used and to
                  advertise on TikTok and Google. Nothing has been set yet.{' '}
                </>
              ) : (
                <>
                  We use cookies to measure how the site is used and to advertise on TikTok
                  and Google. You can turn this off at any time.{' '}
                </>
              )}
              <Link href="/privacy" className="font-medium text-violet-700 underline hover:text-violet-800">
                Read our Privacy Policy
              </Link>
              .
            </p>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => decide(REJECT_ALL)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                {asking ? 'Reject all' : 'Turn off'}
              </button>
              <button
                type="button"
                onClick={() => setShowChoices(true)}
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 underline transition hover:text-slate-900"
              >
                Choose
              </button>
              <button
                type="button"
                onClick={() => decide(ACCEPT_ALL)}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                {asking ? 'Accept all' : 'Got it'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Your privacy choices</h2>
              <p className="mt-1 text-sm text-slate-600">
                Signing in and taking payments need cookies that cannot be turned off. These
                two can.
              </p>
            </div>

            <div className="space-y-2">
              <Choice
                checked={analytics}
                onChange={setAnalytics}
                title="Usage measurement"
                detail="Our own count of which pages are visited and where visitors arrive from. We do not store your IP address, and this is never shared with anyone."
              />
              <Choice
                checked={advertising}
                onChange={setAdvertising}
                title="Advertising"
                detail="The TikTok and Google Ads tags, which tell those platforms that you visited so we can measure our advertising."
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => decide(REJECT_ALL)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Reject all
              </button>
              <button
                type="button"
                onClick={() =>
                  decide({
                    version: 1,
                    analytics: analytics ? 'granted' : 'denied',
                    advertising: advertising ? 'granted' : 'denied',
                  })
                }
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Save choices
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Choice({
  checked,
  onChange,
  title,
  detail,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  detail: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 transition hover:bg-slate-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-slate-600">{detail}</span>
      </span>
    </label>
  )
}

/** Reopens the banner from anywhere. Used by the Privacy Policy page. */
export function openPrivacyChoices(): void {
  window.dispatchEvent(new Event('cph:open-privacy-choices'))
}
