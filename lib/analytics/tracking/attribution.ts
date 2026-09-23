import { CHANNEL_LABELS, CHANNEL_ORDER, type Channel } from './classify'

/**
 * Which source gets the credit, and for what.
 *
 * TWO MODELS, BOTH STATED ON THE PAGE. They disagree, and that is the point:
 * when they disagree, the difference is the gap between what brings people to
 * the site and what is there at the moment they decide.
 *
 *   FIRST TOUCH  — the source recorded on the visitor's very first visit,
 *                  frozen at that moment and never rewritten. Answers "what
 *                  introduced this person to us".
 *
 *   LAST TOUCH   — the source of the most recent visit, at or before the
 *                  conversion, that HAS a source. A visit with no referrer and
 *                  no UTM is Direct, which means "we do not know"; skipping
 *                  over it to the last visit that does know is the standard
 *                  last-non-direct-click model, and it stops a campaign losing
 *                  its credit merely because the buyer came back by typing the
 *                  address in. If every visit was Direct, the answer is Direct.
 *
 * THE POPULATION RULE, which is the one the Phase 2 checkout funnel got wrong
 * before it was fixed: a conversion rate is only a rate when its numerator is
 * a subset of its denominator. Every funnel here is therefore a COHORT —
 * visitors whose FIRST visit falls in the window — narrowed step by step.
 * Dividing "signups this month" by "visitors this month" would divide two
 * populations that overlap only by accident and can exceed 100%.
 */

export type SessionRow = {
  readonly session_id: string
  readonly visitor_id: string
  readonly started_at: string
  readonly channel: string | null
  readonly source: string | null
  readonly medium: string | null
  readonly campaign: string | null
  readonly referrer_host: string | null
  readonly landing_path: string | null
  readonly device: string | null
  readonly browser: string | null
  readonly is_first_visit: boolean | null
  readonly page_view_count: number | null
}

export type VisitorRow = {
  readonly visitor_id: string
  readonly first_seen_at: string
  readonly last_seen_at: string
  readonly first_channel: string | null
  readonly first_source: string | null
  readonly first_campaign: string | null
  readonly first_landing_path: string | null
  readonly user_id: string | null
  readonly linked_at: string | null
}

/** A stored channel string, narrowed back to a known channel or 'direct'. */
export function channelOf(value: string | null | undefined): Channel {
  if (!value) return 'direct'
  return (CHANNEL_ORDER as readonly string[]).includes(value) ? (value as Channel) : 'referral'
}

export function channelLabel(value: string | null | undefined): string {
  return CHANNEL_LABELS[channelOf(value)]
}

/** Sessions for one visitor, oldest first. */
export function sessionsByVisitor(sessions: readonly SessionRow[]): Map<string, SessionRow[]> {
  const byVisitor = new Map<string, SessionRow[]>()
  for (const session of sessions) {
    const list = byVisitor.get(session.visitor_id)
    if (list) list.push(session)
    else byVisitor.set(session.visitor_id, [session])
  }
  for (const list of byVisitor.values()) {
    list.sort((a, b) => a.started_at.localeCompare(b.started_at))
  }
  return byVisitor
}

/**
 * The last touch before an instant: the most recent session at or before `at`
 * whose channel is something other than Direct. Falls back to the most recent
 * session of any kind, and finally to Direct when the visitor has no sessions
 * at all (which happens when retention has pruned them).
 */
export function lastTouch(sessions: readonly SessionRow[], at: string): Channel {
  const eligible = sessions.filter((session) => session.started_at <= at)
  const pool = eligible.length > 0 ? eligible : []

  for (let index = pool.length - 1; index >= 0; index--) {
    const channel = channelOf(pool[index].channel)
    if (channel !== 'direct') return channel
  }
  return 'direct'
}

/** The first touch: whatever was frozen on the visitor row. */
export function firstTouch(visitor: VisitorRow): Channel {
  return channelOf(visitor.first_channel)
}

// ---------------------------------------------------------------------------
// The cohort funnel
// ---------------------------------------------------------------------------

export type CohortInput = {
  /** Visitors whose FIRST visit falls in the window. The denominator. */
  readonly visitors: readonly VisitorRow[]
  /** Every session belonging to those visitors, for last-touch resolution. */
  readonly sessions: readonly SessionRow[]
  /** Account ids that exist and have confirmed their email. */
  readonly confirmedUserIds: ReadonlySet<string>
  /** Account ids that have ever paid, from Stripe. */
  readonly payingUserIds: ReadonlySet<string>
}

export type CohortCounts = {
  readonly visitors: number
  readonly signedUp: number
  readonly confirmed: number
  readonly paid: number
}

/**
 * One cohort, narrowed four times. Each number is a subset of the one above
 * it, so every ratio between them is a real conversion rate.
 */
export function cohortFunnel(input: CohortInput): CohortCounts {
  const signedUp = input.visitors.filter((visitor) => visitor.user_id !== null)
  const confirmed = signedUp.filter((visitor) => input.confirmedUserIds.has(visitor.user_id as string))
  const paid = signedUp.filter((visitor) => input.payingUserIds.has(visitor.user_id as string))

  return {
    visitors: input.visitors.length,
    signedUp: signedUp.length,
    confirmed: confirmed.length,
    paid: paid.length,
  }
}

/** A rate, or null when the denominator is zero — never 0%, which reads as a fact. */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return (numerator / denominator) * 100
}

// ---------------------------------------------------------------------------
// Per-channel performance
// ---------------------------------------------------------------------------

export type ChannelPerformance = {
  readonly channel: Channel
  readonly label: string
  readonly visitors: number
  readonly sessions: number
  readonly pageViews: number
  readonly signups: number
  readonly customers: number
  readonly purchases: number
  readonly grossCents: number
  readonly netCents: number
}

export type RevenueByUser = {
  /** Account id -> what that account has paid, in cents. */
  readonly grossByUser: ReadonlyMap<string, number>
  readonly netByUser: ReadonlyMap<string, number>
  readonly purchasesByUser: ReadonlyMap<string, number>
}

export type PerformanceInput = {
  readonly visitors: readonly VisitorRow[]
  readonly sessions: readonly SessionRow[]
  readonly revenue: RevenueByUser
  /** 'first' credits the visitor's first touch; 'last' the touch before payment. */
  readonly model: 'first' | 'last'
  /**
   * When each account FIRST paid. Under last touch, a buyer is credited to the
   * source in front of them at the moment they bought, which is usually a
   * later visit than the one they registered on. Without this the credit would
   * freeze at signup and a campaign that closed the sale would never show.
   */
  readonly paidAtByUser?: ReadonlyMap<string, string>
}

/**
 * Traffic, signups and money per channel, under one attribution model.
 *
 * Sessions and page views are counted by the SESSION's own channel, because a
 * visit came from where it came from. Visitors, signups and revenue are
 * counted by the chosen MODEL, because a person is credited once.
 */
export function performanceByChannel(input: PerformanceInput): ChannelPerformance[] {
  const totals = new Map<Channel, {
    visitors: Set<string>; sessions: number; pageViews: number
    signups: number; customers: number; purchases: number; gross: number; net: number
  }>()

  const bucket = (channel: Channel) => {
    let entry = totals.get(channel)
    if (!entry) {
      entry = { visitors: new Set(), sessions: 0, pageViews: 0, signups: 0, customers: 0, purchases: 0, gross: 0, net: 0 }
      totals.set(channel, entry)
    }
    return entry
  }

  for (const session of input.sessions) {
    const entry = bucket(channelOf(session.channel))
    entry.sessions += 1
    entry.pageViews += session.page_view_count ?? 0
  }

  const byVisitor = sessionsByVisitor(input.sessions)

  for (const visitor of input.visitors) {
    // ONE INSTANT PER VISITOR, so a person and their money always land on the
    // same row: the moment of their LAST conversion — the purchase if they
    // bought, otherwise the registration, otherwise their last visit.
    const convertedAt =
      (visitor.user_id ? input.paidAtByUser?.get(visitor.user_id) : null) ??
      visitor.linked_at ??
      visitor.last_seen_at

    const credited =
      input.model === 'first'
        ? firstTouch(visitor)
        : lastTouch(byVisitor.get(visitor.visitor_id) ?? [], convertedAt)

    const entry = bucket(credited)
    entry.visitors.add(visitor.visitor_id)

    if (visitor.user_id) {
      entry.signups += 1
      const gross = input.revenue.grossByUser.get(visitor.user_id) ?? 0
      const net = input.revenue.netByUser.get(visitor.user_id) ?? 0
      const purchases = input.revenue.purchasesByUser.get(visitor.user_id) ?? 0
      if (purchases > 0) {
        entry.customers += 1
        entry.purchases += purchases
        entry.gross += gross
        entry.net += net
      }
    }
  }

  return CHANNEL_ORDER.filter((channel) => totals.has(channel)).map((channel) => {
    const entry = totals.get(channel)!
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      visitors: entry.visitors.size,
      sessions: entry.sessions,
      pageViews: entry.pageViews,
      signups: entry.signups,
      customers: entry.customers,
      purchases: entry.purchases,
      grossCents: entry.gross,
      netCents: entry.net,
    }
  })
}

// ---------------------------------------------------------------------------
// Attributed against unattributed money
// ---------------------------------------------------------------------------

/** The little of a Stripe payment this calculation needs. */
export type PaymentLite = {
  readonly email: string | null
  readonly amount: number
  readonly createdAt: string
  readonly succeeded: boolean
}

export type RevenueSplit = {
  readonly attributedCents: number
  readonly unattributedCents: number
  /** Paid by somebody whose email matches no account at all. */
  readonly noAccountMatch: number
  /** Paid by an account whose first visit was never tracked, or was Direct. */
  readonly noTrackedVisit: number
}

/**
 * How much of the money taken in a window can be traced to a traffic source.
 *
 * DELIBERATELY WINDOW-BASED, unlike the per-channel panels, which follow a
 * cohort of visitors and everything they have ever paid. This one answers
 * "of the money that arrived this month, how much do we know the origin of",
 * and its two halves add up to the window's gross revenue exactly.
 *
 * DIRECT COUNTS AS UNATTRIBUTED. Direct is not a marketing channel, it is the
 * absence of information, and counting it as attributed would flatter the
 * number every time.
 */
export function splitAttributedRevenue(input: {
  readonly payments: readonly PaymentLite[]
  readonly from: string | null
  readonly to: string
  readonly emailToUser: ReadonlyMap<string, string>
  readonly visitorByUser: ReadonlyMap<string, VisitorRow>
}): RevenueSplit {
  let attributedCents = 0
  let unattributedCents = 0
  let noAccountMatch = 0
  let noTrackedVisit = 0

  for (const payment of input.payments) {
    if (!payment.succeeded) continue
    const at = Date.parse(payment.createdAt)
    if (Number.isNaN(at)) continue
    if (input.from !== null && at < Date.parse(input.from)) continue
    if (at >= Date.parse(input.to)) continue

    const userId = payment.email ? input.emailToUser.get(payment.email.trim().toLowerCase()) : undefined
    if (!userId) {
      unattributedCents += payment.amount
      noAccountMatch += 1
      continue
    }

    const visitor = input.visitorByUser.get(userId)
    if (!visitor || channelOf(visitor.first_channel) === 'direct') {
      unattributedCents += payment.amount
      noTrackedVisit += 1
      continue
    }

    attributedCents += payment.amount
  }

  return { attributedCents, unattributedCents, noAccountMatch, noTrackedVisit }
}
