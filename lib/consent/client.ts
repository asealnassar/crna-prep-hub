'use client'

import {
  ACCEPT_ALL,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_DAYS,
  REJECT_ALL,
  defaultState,
  googleConsentSignals,
  parse,
  serialize,
  type ConsentState,
  type Regime,
} from './policy'

/**
 * Carrying a consent decision to the three things that depend on it.
 *
 * EACH PLATFORM IS TOLD IN ITS OWN LANGUAGE, which is what keeps campaigns
 * intact and conversions single:
 *
 *   Google   Consent Mode v2. The tag always loads and always has the same id;
 *            consent decides whether it may use storage. Google's own modelling
 *            covers the gap, which is why this is better for the campaigns than
 *            refusing to load the tag at all.
 *
 *   TikTok   holdConsent() before the pixel is allowed to do anything, then
 *            grantConsent(). The queued page event fires ONCE, on grant. It is
 *            not re-sent, so no conversion is duplicated.
 *
 *   Ours     the Phase 3 tracker simply does not run.
 *
 * THE HEAD SNIPPET DOES THE FIRST HALF. app/layout.tsx sets Consent Mode
 * defaults and calls holdConsent before either tag loads, reading the same
 * cookie this module writes. This module handles everything after that.
 */

declare global {
  interface Window {
    dataLayer?: unknown[]
    ttq?: { grantConsent?: () => void; revokeConsent?: () => void; page?: () => void }
    __cphConsent?: ConsentState | null
  }
}

export { ACCEPT_ALL, REJECT_ALL }

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

export function storedConsent(): ConsentState | null {
  return parse(readCookie(CONSENT_COOKIE))
}

/** Listeners that want to know the moment a decision changes. */
const listeners = new Set<(state: ConsentState) => void>()

export function onConsentChange(listener: (state: ConsentState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Tells Google and TikTok what was decided.
 *
 * Safe to call more than once and safe to call before either tag has loaded:
 * dataLayer is an array the tag drains when it arrives, and ttq queues its
 * methods the same way.
 */
export function applyConsent(state: ConsentState): void {
  if (typeof window === 'undefined') return

  window.__cphConsent = state

  // --- Google: update the four Consent Mode v2 signals ---------------------
  window.dataLayer = window.dataLayer || []
  window.dataLayer.push(['consent', 'update', googleConsentSignals(state)])

  // --- TikTok: grant or revoke -------------------------------------------
  const ttq = window.ttq
  if (ttq) {
    if (state.advertising === 'granted') {
      // Releases the page event the head snippet held back. It fires once.
      ttq.grantConsent?.()
    } else {
      ttq.revokeConsent?.()
    }
  }

  for (const listener of listeners) listener(state)
}

/** Writes the decision and applies it. */
export function saveConsent(state: ConsentState): void {
  if (typeof document === 'undefined') return

  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie =
    `${CONSENT_COOKIE}=${encodeURIComponent(serialize(state))}; Path=/; ` +
    `Max-Age=${CONSENT_MAX_AGE_DAYS * 24 * 60 * 60}; SameSite=Lax${secure}`

  applyConsent(state)
}

/**
 * The regime for this visitor, asked for once per page and no more.
 *
 * MEMOISED because it was not: Strict Mode's double effect plus the banner
 * re-rendering sent four identical requests on every page load. The answer
 * cannot change while the page is open, so the first request is the only one.
 *
 * A failure answers opt_in: if we cannot tell where somebody is, we ask them.
 */
let regimeRequest: Promise<Regime> | null = null

export function fetchRegime(): Promise<Regime> {
  if (regimeRequest) return regimeRequest

  regimeRequest = (async () => {
    try {
      const response = await fetch('/api/consent-region', { cache: 'no-store' })
      if (!response.ok) return 'opt_in'
      const body = (await response.json()) as { regime?: string }
      return body.regime === 'opt_out' ? 'opt_out' : 'opt_in'
    } catch {
      return 'opt_in'
    }
  })()

  return regimeRequest
}

/** What is in force right now, for anything that needs to check before acting. */
export function currentConsent(regime: Regime = 'opt_in'): ConsentState {
  return storedConsent() ?? window.__cphConsent ?? defaultState(regime)
}

/** Whether first-party analytics may record anything. */
export function analyticsAllowed(): boolean {
  if (typeof window === 'undefined') return false
  const state = storedConsent() ?? window.__cphConsent ?? null
  return state?.analytics === 'granted'
}

/** Whether the advertising pixels may act. Used by the signup conversion. */
export function advertisingAllowed(): boolean {
  if (typeof window === 'undefined') return false
  const state = storedConsent() ?? window.__cphConsent ?? null
  return state?.advertising === 'granted'
}
