/**
 * Where a visit came from.
 *
 * ONE RULE: a source is recorded only when something in the request says so.
 * A visit with no referrer and no UTM is Direct, which is an honest answer
 * meaning "we do not know" — it is never silently attributed to the last
 * campaign, and an unknown referrer is never folded into a channel it might
 * belong to.
 *
 * ORDER OF PRECEDENCE, highest first. Each step wins outright:
 *   1. utm_source        — someone tagged the link deliberately; believe them.
 *   2. an ad click id    — ttclid, gclid, wbraid, gbraid. Present only on a
 *                          real ad click, and proof of paid traffic even when
 *                          the marketer forgot the UTM.
 *   3. the referrer host — mapped to a channel it is known to be.
 *   4. nothing           — Direct.
 *
 * A REFERRER FROM OUR OWN SITE IS NOT A SOURCE. An in-app navigation carries
 * our own host as the referrer; treating that as a referral would credit the
 * site for its own traffic and make every session look like it came from us.
 */

export type Channel =
  | 'tiktok'
  | 'instagram'
  | 'google_ads'
  | 'google_organic'
  | 'other_search'
  | 'facebook'
  | 'youtube'
  | 'reddit'
  | 'email'
  | 'referral'
  | 'direct'

export type Touch = {
  readonly channel: Channel
  /** The raw source as recorded: a utm_source, a host, or 'direct'. */
  readonly source: string
  readonly medium: string | null
  readonly campaign: string | null
  readonly content: string | null
  readonly term: string | null
  readonly referrerHost: string | null
  /** Path only — never the query string. */
  readonly landingPath: string
}

/** Hosts that are us. A referrer from one of these is an internal navigation. */
export const OWN_HOSTS = ['crnaprephub.com', 'www.crnaprephub.com', 'localhost', '127.0.0.1']

export const CHANNEL_LABELS: Record<Channel, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  google_ads: 'Google Ads',
  google_organic: 'Google organic',
  other_search: 'Other search',
  facebook: 'Facebook',
  youtube: 'YouTube',
  reddit: 'Reddit',
  email: 'Email',
  referral: 'Other referral',
  direct: 'Direct',
}

/** The order the dashboard lists channels in: paid, then organic, then the rest. */
export const CHANNEL_ORDER: readonly Channel[] = [
  'tiktok', 'instagram', 'google_ads', 'google_organic', 'other_search',
  'facebook', 'youtube', 'reddit', 'email', 'referral', 'direct',
]

const AD_CLICK_IDS = ['ttclid', 'gclid', 'wbraid', 'gbraid', 'msclkid', 'fbclid'] as const

/** Referrer hosts we can name with confidence. Matched on the registrable part. */
const HOST_CHANNELS: readonly { match: RegExp; channel: Channel }[] = [
  { match: /(^|\.)tiktok\.com$/i, channel: 'tiktok' },
  { match: /(^|\.)instagram\.com$/i, channel: 'instagram' },
  { match: /(^|\.)(facebook|fb)\.com$/i, channel: 'facebook' },
  { match: /(^|\.)youtube\.com$/i, channel: 'youtube' },
  { match: /(^|\.)youtu\.be$/i, channel: 'youtube' },
  { match: /(^|\.)reddit\.com$/i, channel: 'reddit' },
  { match: /(^|\.)google\.[a-z.]+$/i, channel: 'google_organic' },
  { match: /(^|\.)(bing|duckduckgo|yahoo|ecosia|brave|startpage)\.[a-z.]+$/i, channel: 'other_search' },
  { match: /(^|\.)(mail\.google|outlook|mail\.yahoo)\.[a-z.]+$/i, channel: 'email' },
]

/** utm_source values that name a channel, whatever case or spelling is used. */
const SOURCE_CHANNELS: readonly { match: RegExp; channel: Channel }[] = [
  { match: /^tiktok/i, channel: 'tiktok' },
  { match: /^(ig|insta)/i, channel: 'instagram' },
  { match: /^(fb|facebook|meta)/i, channel: 'facebook' },
  { match: /^youtube/i, channel: 'youtube' },
  { match: /^reddit/i, channel: 'reddit' },
  { match: /^(email|newsletter|klaviyo|mailchimp|resend)/i, channel: 'email' },
  { match: /^(google|adwords|gads)/i, channel: 'google_organic' }, // upgraded to ads below if paid
]

/** Mediums that mean money changed hands. */
const PAID_MEDIUM = /^(cpc|ppc|paid|paidsocial|paid_social|paid-social|cpm|display|ads?)$/i

const trim = (value: string | null | undefined, max = 120): string | null => {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().slice(0, max)
  return cleaned.length > 0 ? cleaned.toLowerCase() : null
}

/**
 * The host of a web URL, lower-cased, or null.
 *
 * HTTP AND HTTPS ONLY. `new URL('android-app://com.something')` parses
 * perfectly well and hands back the hostname 'com.something', which would then
 * be filed as a referring website and appear in the sources breakdown as a
 * site nobody has ever visited. A referrer that is not a web page is not a
 * referrer.
 */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase()
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

export function isOwnHost(host: string | null): boolean {
  if (!host) return false
  const bare = host.replace(/^www\./, '')
  return OWN_HOSTS.some((own) => own.replace(/^www\./, '') === bare)
}

function channelForHost(host: string): Channel {
  for (const entry of HOST_CHANNELS) {
    if (entry.match.test(host)) return entry.channel
  }
  return 'referral'
}

function channelForSource(source: string, medium: string | null, hasAdClick: boolean): Channel {
  const paid = hasAdClick || (medium !== null && PAID_MEDIUM.test(medium))
  for (const entry of SOURCE_CHANNELS) {
    if (entry.match.test(source)) {
      // Google is the one source that splits by whether it was paid for.
      if (entry.channel === 'google_organic') return paid ? 'google_ads' : 'google_organic'
      return entry.channel
    }
  }
  return paid ? 'referral' : 'referral'
}

export type TouchInput = {
  /** The full URL of the landing page, query string included. */
  readonly url: string
  /** document.referrer, which is '' when there is none. */
  readonly referrer?: string | null
  readonly ownHosts?: readonly string[]
}

/**
 * Reads a landing URL and its referrer into one attribution touch.
 *
 * Pure: the same input always gives the same answer, which is what lets the
 * table of cases in classify.test.ts stand in for a browser.
 */
export function classifyTouch(input: TouchInput): Touch {
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    // An unparseable URL still produced a visit; record it as direct on '/'
    // rather than dropping the visit or inventing a source for it.
    return {
      channel: 'direct', source: 'direct', medium: null, campaign: null,
      content: null, term: null, referrerHost: null, landingPath: '/',
    }
  }

  const params = parsed.searchParams
  const landingPath = parsed.pathname || '/'

  const utmSource = trim(params.get('utm_source'))
  const utmMedium = trim(params.get('utm_medium'))
  const campaign = trim(params.get('utm_campaign'))
  const content = trim(params.get('utm_content'))
  const term = trim(params.get('utm_term'))

  const clickId = AD_CLICK_IDS.find((name) => (params.get(name) ?? '').trim().length > 0) ?? null

  const rawReferrerHost = hostOf(input.referrer)
  const ownHosts = input.ownHosts ?? OWN_HOSTS
  const internal =
    rawReferrerHost !== null &&
    ownHosts.some((own) => own.replace(/^www\./, '') === rawReferrerHost.replace(/^www\./, ''))
  const referrerHost = internal ? null : rawReferrerHost

  // 1. A deliberate tag wins.
  if (utmSource) {
    return {
      channel: channelForSource(utmSource, utmMedium, clickId !== null),
      source: utmSource,
      medium: utmMedium ?? (clickId !== null ? 'cpc' : null),
      campaign,
      content,
      term,
      referrerHost,
      landingPath,
    }
  }

  // 2. An ad click id proves paid traffic even with no UTM at all.
  if (clickId) {
    const channel: Channel =
      clickId === 'ttclid' ? 'tiktok'
      : clickId === 'fbclid' ? 'facebook'
      : clickId === 'msclkid' ? 'other_search'
      : 'google_ads'
    return {
      channel,
      source: clickId === 'ttclid' ? 'tiktok' : clickId === 'fbclid' ? 'facebook' : clickId === 'msclkid' ? 'bing' : 'google',
      medium: 'cpc',
      campaign,
      content,
      term,
      referrerHost,
      landingPath,
    }
  }

  // 3. The referrer, when it is somebody else's.
  if (referrerHost) {
    const channel = channelForHost(referrerHost)
    return {
      channel,
      source: referrerHost,
      medium: channel === 'google_organic' || channel === 'other_search' ? 'organic' : 'referral',
      campaign,
      content,
      term,
      referrerHost,
      landingPath,
    }
  }

  // 4. Nothing said anything.
  return {
    channel: 'direct',
    source: 'direct',
    medium: null,
    campaign,
    content,
    term,
    referrerHost: null,
    landingPath,
  }
}
