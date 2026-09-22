import type { Reader } from './reader'

/**
 * Membership tiers, as the product currently holds them.
 *
 * READ THIS BEFORE USING THESE NUMBERS AS SALES. `user_profiles.subscription_tier`
 * is an ENTITLEMENT, not a receipt. It is written by the Stripe webhook, and it
 * is also written by hand: feature-request winners are given Ultimate, testers
 * hold tiers nobody paid for, and the hidden 'security-test' tier exists purely
 * for the messaging suite. The column also has no history, so it can only ever
 * answer "who holds what now", never "who bought what when".
 *
 * Purchases come from Stripe. These counts describe access.
 */

export const PRODUCT_TIERS = ['free', 'premium', 'ultimate'] as const
export type ProductTier = (typeof PRODUCT_TIERS)[number]

export const TIER_LABELS: Record<string, string> = {
  free: 'Free',
  premium: 'Premium',
  ultimate: 'Ultimate',
  'security-test': 'Security test (internal)',
  '(not recorded)': 'No tier recorded',
}

export type ProfileRow = { id: string; subscription_tier: string | null }

export type ProfileSnapshot = {
  readonly available: boolean
  readonly reason?: string
  readonly truncated: boolean
  readonly rows: readonly ProfileRow[]
  /** user id -> tier, lower-cased, for joining activity to membership. */
  readonly tierById: Map<string, string>
  readonly counts: Map<string, number>
  readonly total: number
  /** Premium + Ultimate. Access held, not money taken. */
  readonly paidTierCount: number
}

export async function loadProfiles(reader: Reader): Promise<ProfileSnapshot> {
  const result = await reader.rows<ProfileRow>('user_profiles', 'id, subscription_tier', {
    dateColumn: undefined,
    tiebreak: 'id',
  })

  if (!result.ok) {
    return {
      available: false,
      reason: result.detail,
      truncated: false,
      rows: [],
      tierById: new Map(),
      counts: new Map(),
      total: 0,
      paidTierCount: 0,
    }
  }

  const tierById = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const row of result.rows) {
    const tier = (row.subscription_tier ?? '').trim().toLowerCase() || '(not recorded)'
    tierById.set(row.id, tier)
    counts.set(tier, (counts.get(tier) ?? 0) + 1)
  }

  return {
    available: true,
    truncated: result.truncated,
    rows: result.rows,
    tierById,
    counts,
    total: result.rows.length,
    paidTierCount: (counts.get('premium') ?? 0) + (counts.get('ultimate') ?? 0),
  }
}
