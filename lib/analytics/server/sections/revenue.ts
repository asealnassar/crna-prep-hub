import type { ResolvedRange } from '../../range'
import { percent } from '../../aggregate'
import { notTracked, type Breakdown, type Metric, type SectionPayload } from '../../types'
import { TIER_LABELS, loadProfiles } from '../profiles'
import { Diagnostics } from '../failures'
import type { Reader } from '../reader'

/**
 * Revenue: what this database can and cannot say about money.
 *
 * IT CANNOT SAY ANYTHING ABOUT MONEY. The Stripe webhook records no purchase —
 * it sets `user_profiles.subscription_tier` and nothing else. There is no
 * amount, no discount, no refund, no checkout session and no purchase date
 * anywhere in this database. Every figure with a currency on it is therefore
 * marked as needing the Stripe integration.
 *
 * What IS here is access: how many members hold each tier right now. That is a
 * real, useful number and it is labelled for what it is. It is NOT a sales
 * count: tiers are also granted by hand (feature-request winners, testers), and
 * the column has no history, so it cannot even say when access was granted.
 *
 * CRNA Prep Hub sells one-time lifetime access. There is deliberately no MRR
 * and no churn here: neither exists for this product, and showing them would
 * be inventing a subscription business.
 */
export async function buildRevenue(reader: Reader, range: ResolvedRange): Promise<SectionPayload> {
  const diagnostics = new Diagnostics()
  const profiles = await loadProfiles(reader)
  if (!profiles.available) diagnostics.note('user_profiles', 'failed', profiles.reason ?? 'unavailable')
  if (profiles.truncated) diagnostics.cut('user_profiles')

  const premium = profiles.counts.get('premium') ?? 0
  const ultimate = profiles.counts.get('ultimate') ?? 0

  const stripeNote =
    'Stripe holds every payment, discount and refund. Nothing is mirrored into this database yet, so this cannot be shown without the Stripe integration.'

  const metrics: Metric[] = [
    notTracked('gross_revenue', 'Gross revenue', stripeNote, 'currency'),
    notTracked('net_revenue', 'Net revenue after refunds', stripeNote, 'currency'),
    notTracked('refunds', 'Refunds', stripeNote, 'currency'),
    notTracked('orders', 'Purchases', `${stripeNote} Tier counts cannot substitute: they include plans granted by hand.`),
    notTracked('aov', 'Average order value', stripeNote, 'currency'),
    notTracked('discounts', 'Discounts given', `${stripeNote} Promotion codes are enforced entirely by Stripe.`, 'currency'),
    notTracked(
      'checkout_started',
      'Checkouts started',
      'A checkout session is created in Stripe and never recorded here, so an abandoned checkout leaves no trace on this side.'
    ),
    notTracked('checkout_conversion', 'Checkout completion rate', stripeNote, 'percent'),
    notTracked(
      'free_to_paid',
      'Free to paid conversion',
      'Needs purchases from Stripe matched to accounts. Until then the closest honest figure is the share of members holding a paid tier, below.',
      'percent'
    ),
    {
      id: 'premium_members',
      label: 'Premium access held',
      value: profiles.available ? premium : null,
      status: profiles.available ? 'ok' : 'error',
      note: 'Members on Premium right now. Includes any granted by hand, and says nothing about when or whether it was bought.',
      source: { label: 'user_profiles.subscription_tier' },
    },
    {
      id: 'ultimate_members',
      label: 'Ultimate access held',
      value: profiles.available ? ultimate : null,
      status: profiles.available ? 'ok' : 'error',
      note: 'Members on Ultimate right now, on the same terms.',
      source: { label: 'user_profiles.subscription_tier' },
    },
    {
      id: 'paid_share',
      label: 'Share of members on a paid tier',
      value: profiles.available ? percent(premium + ultimate, profiles.total) : null,
      unit: 'percent',
      status: profiles.available ? 'ok' : 'error',
      note: 'Access, not conversion. The purchase rate needs Stripe.',
      source: { label: 'user_profiles.subscription_tier' },
    },
  ]

  const breakdowns: Breakdown[] = [
    {
      id: 'tier_mix',
      label: 'Membership mix today',
      status: profiles.available ? 'ok' : 'error',
      note: 'Every profile by the tier it currently holds.',
      source: { label: 'user_profiles' },
      rows: [...profiles.counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([tier, count]) => ({
          key: tier,
          label: TIER_LABELS[tier] ?? tier,
          value: count,
          note:
            tier === 'security-test'
              ? 'Internal test cohort — exclude from any commercial reading.'
              : undefined,
        })),
    },
  ]

  return {
    section: 'revenue',
    generatedAt: new Date().toISOString(),
    range: {
      preset: range.preset,
      from: range.from,
      to: range.to,
      bucket: range.bucket,
      timezone: range.timezone,
      label: range.label,
      comparison: range.comparison,
    },
    metrics,
    series: [],
    breakdowns,
    funnels: [],
    diagnostics: diagnostics.finish(),
  }
}
