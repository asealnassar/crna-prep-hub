/**
 * What may run before someone has said yes.
 *
 * THE REVIEW THIS ENCODES. Three things run on this site that are not strictly
 * necessary to deliver it: the Google Ads tag, the TikTok pixel, and the
 * first-party analytics tracker added in Phase 3. A privacy policy alone does
 * not make any of them lawful everywhere:
 *
 *   - In the EEA, the UK and Switzerland, ePrivacy requires PRIOR consent
 *     before a non-essential cookie is set or read. Notice is not consent, and
 *     "by continuing you agree" is not consent. Nothing may fire first.
 *
 *   - In the United States, the state privacy laws are opt-OUT: disclosure
 *     plus a working way to turn advertising off. California's CalOPPA also
 *     requires the policy itself, which is why the policy page ships with
 *     this. Advertising may run until someone objects.
 *
 * So the regime is chosen by where the visitor is, and the difference is only
 * ever about WHEN consent is assumed, never about what the controls do:
 *
 *   OPT_IN   nothing non-essential runs until the visitor chooses.
 *   OPT_OUT  advertising and analytics run, with a standing way to withdraw.
 *
 * UNKNOWN LOCATION IS TREATED AS OPT_IN. Guessing wrong in that direction
 * costs a measurement; guessing wrong in the other direction is the breach.
 *
 * NOTHING HERE CHANGES AN AD CAMPAIGN. The Google tag id, the TikTok pixel id
 * and the events they send are untouched. Consent decides whether they may
 * fire, using each platform's own mechanism — Google Consent Mode v2 and
 * TikTok's holdConsent/grantConsent — so a page view or a conversion is still
 * sent exactly once, never twice.
 */

export const CONSENT_COOKIE = 'cph_consent'
export const CONSENT_VERSION = 1

/** Re-asking everyone is a cost; it happens only when this number changes. */
export const CONSENT_MAX_AGE_DAYS = 180

export type Decision = 'granted' | 'denied'

export type ConsentState = {
  readonly version: number
  /** First-party traffic measurement. */
  readonly analytics: Decision
  /** Google Ads and TikTok. */
  readonly advertising: Decision
}

export type Regime = 'opt_in' | 'opt_out'

/**
 * The EEA, the UK and Switzerland. Listed rather than inferred so that adding
 * or removing one is a visible edit.
 */
export const PRIOR_CONSENT_COUNTRIES: readonly string[] = [
  // EU
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
  // EEA beyond the EU
  'IS', 'LI', 'NO',
  // United Kingdom and Switzerland
  'GB', 'CH',
]

/**
 * Which regime applies to a country code.
 *
 * `null` or an unrecognised value means we do not know where the visitor is,
 * and an unknown visitor is treated as though they were in Berlin.
 */
export function regimeFor(country: string | null | undefined): Regime {
  if (!country) return 'opt_in'
  const code = country.trim().toUpperCase()
  if (code.length !== 2) return 'opt_in'
  return PRIOR_CONSENT_COUNTRIES.includes(code) ? 'opt_in' : 'opt_out'
}

/** What runs before the visitor has decided anything. */
export function defaultState(regime: Regime): ConsentState {
  return regime === 'opt_out'
    ? { version: CONSENT_VERSION, analytics: 'granted', advertising: 'granted' }
    : { version: CONSENT_VERSION, analytics: 'denied', advertising: 'denied' }
}

export const ACCEPT_ALL: ConsentState = {
  version: CONSENT_VERSION,
  analytics: 'granted',
  advertising: 'granted',
}

export const REJECT_ALL: ConsentState = {
  version: CONSENT_VERSION,
  analytics: 'denied',
  advertising: 'denied',
}

/**
 * The stored form: `v1:1:0` — version, analytics, advertising.
 *
 * Deliberately tiny and positional, because the snippet in the document head
 * has to parse it with a regex before any tag loads. JSON in a cookie would
 * need unescaping there, and a parse failure would be indistinguishable from
 * "not asked yet".
 */
export function serialize(state: ConsentState): string {
  const bit = (decision: Decision) => (decision === 'granted' ? '1' : '0')
  return `v${state.version}:${bit(state.analytics)}:${bit(state.advertising)}`
}

/** Returns null for anything unparseable or from an older consent version. */
export function parse(value: string | null | undefined): ConsentState | null {
  if (!value) return null
  const match = /^v(\d+):([01]):([01])$/.exec(value.trim())
  if (!match) return null

  const version = Number(match[1])
  // An older version means the question has changed since they answered it.
  if (version !== CONSENT_VERSION) return null

  return {
    version,
    analytics: match[2] === '1' ? 'granted' : 'denied',
    advertising: match[3] === '1' ? 'granted' : 'denied',
  }
}

/**
 * Whether the visitor still has something to be shown.
 *
 * The regime changes the WORDING and what is already running, not whether
 * anybody is told: an opt-out visitor is informed and offered the controls,
 * an opt-in visitor is asked and nothing runs until they answer. Either way,
 * somebody with no stored decision has not been spoken to yet.
 */
export function needsDecision(stored: ConsentState | null): boolean {
  return stored === null
}

/** What is actually in force right now. */
export function effective(stored: ConsentState | null, regime: Regime): ConsentState {
  return stored ?? defaultState(regime)
}

/**
 * Google Consent Mode v2 signals.
 *
 * Analytics and advertising are kept separate here because they are separate
 * choices: someone may be happy to be counted and unhappy to be advertised to.
 */
export function googleConsentSignals(state: ConsentState): Record<string, 'granted' | 'denied'> {
  return {
    ad_storage: state.advertising,
    ad_user_data: state.advertising,
    ad_personalization: state.advertising,
    analytics_storage: state.analytics,
  }
}
