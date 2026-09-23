'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import Sidebar from '@/components/Sidebar'
import { REPORTING_TIMEZONE } from '@/lib/analytics/range'
import type { Metric, SectionPayload } from '@/lib/analytics/types'
import { BreakdownPanel, FunnelPanel } from './components/Breakdown'
import { Controls, TABS, type RangeState, type TabId } from './components/Controls'
import { DiagnosticsPanel } from './components/Diagnostics'
import { KpiCard } from './components/KpiCard'
import { MemberTable } from './components/MemberTable'
import { Queues } from './components/Queues'
import { TimeSeriesChart } from './components/TimeSeriesChart'
import { Card, EmptyState, SectionTitle, Skeleton } from './components/primitives'

/**
 * The analytics dashboard.
 *
 * Every figure is aggregated on the server and arrives as a value with a
 * status: real, partial, not tracked yet, or unavailable. The page draws what
 * it is given and never fills a gap with a zero — the section that replaced
 * this one showed 0 interviews for every member whenever one call failed, and
 * a question total that was really the first 1000 rows of a much larger table.
 *
 * The admin check here is the same one this page has always used. Page-level
 * protection is presentation: every endpoint behind it authenticates and
 * authorises on its own.
 */

const ADMIN_EMAIL = 'asealnassar@gmail.com'

const GROUP_TITLES: Record<string, { title: string; detail?: string }> = {
  traffic: { title: 'Website traffic', detail: 'First-party, from this site only. A visit ends after 30 minutes of inactivity.' },
  sources: { title: 'Where traffic comes from', detail: 'First touch is what introduced someone; last touch is what was in front of them at the end. They disagree on purpose.' },
  pages: { title: 'Pages', detail: 'Landing pages are where visits begin; most-visited counts every view.' },
  funnel: { title: 'Visitor to customer', detail: 'One cohort — visitors whose first visit falls in this window — narrowed step by step, so every rate is a real rate.' },
  money: { title: 'Revenue by source', detail: 'Stripe revenue credited to the traffic that produced it.' },
  ads: { title: 'Advertising', detail: 'Spend is imported by hand. Nothing here is estimated.' },
  headline: { title: 'Revenue', detail: 'From Stripe payments, not membership counts. One-time purchases, so there is no recurring revenue.' },
  todate: { title: 'Today, this week, this month' },
  lifetime: { title: 'All time' },
  conversion: { title: 'Free to paid' },
  discounts: { title: 'Discounts and refunds' },
  membership: { title: 'Membership access' },
  interviews: { title: 'Mock interviews', detail: 'One interview is one authorised mock, whatever its length.' },
  gpa: { title: 'GPA Analyzer' },
  resume: { title: 'Resume Builder' },
  statement: { title: 'Personal Statement Analyzer' },
  schools: { title: 'School directory and school-specific prep' },
  queues: { title: 'Queues' },
  health: { title: 'Operational health' },
}

const GROUP_ORDER = [
  'traffic', 'sources', 'pages', 'funnel', 'money', 'ads',
  'headline', 'todate', 'lifetime', 'conversion', 'discounts', 'membership',
  'interviews', 'gpa', 'resume', 'statement', 'schools', 'queues', 'health',
]

export default function AnalyticsPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [ready, setReady] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const [tab, setTab] = useState<TabId>('overview')
  const [range, setRange] = useState<RangeState>({ preset: '30d', from: '', to: '' })
  const [payloads, setPayloads] = useState<Record<string, SectionPayload>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // --- the gate this page has always had ------------------------------------
  useEffect(() => {
    const check = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user || user.email !== ADMIN_EMAIL) {
        router.push('/dashboard')
        return
      }
      setUserEmail(user.email)
      setReady(true)
    }
    check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- the window and the tab live in the URL -------------------------------
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlTab = params.get('tab')
    if (urlTab && TABS.some((item) => item.id === urlTab)) setTab(urlTab as TabId)
    const preset = params.get('range')
    if (preset) {
      setRange({ preset, from: params.get('from') ?? '', to: params.get('to') ?? '' })
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    const params = new URLSearchParams()
    params.set('tab', tab)
    params.set('range', range.preset)
    if (range.preset === 'custom' && range.from && range.to) {
      params.set('from', range.from)
      params.set('to', range.to)
    }
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
  }, [ready, tab, range])

  const cacheKey = `${tab}:${range.preset}:${range.from}:${range.to}`

  const load = useCallback(
    async (force = false) => {
      if (!ready) return
      if (!force && payloads[cacheKey]) return
      if (range.preset === 'custom' && (!range.from || !range.to)) return

      setLoading(true)
      setError(null)

      const params = new URLSearchParams({ range: range.preset })
      if (range.preset === 'custom') {
        params.set('from', range.from)
        params.set('to', range.to)
      }
      // Revenue caches Stripe for a few minutes; Refresh means go and look again.
      if (force) params.set('refresh', '1')

      try {
        const response = await fetch(`/api/admin/analytics/${tab}?${params.toString()}`)
        if (!response.ok) {
          throw new Error(
            response.status === 403
              ? 'This account is not an administrator.'
              : `That section could not be loaded (${response.status}).`
          )
        }
        const payload = (await response.json()) as SectionPayload
        setPayloads((current) => ({ ...current, [cacheKey]: payload }))
      } catch (problem: any) {
        setError(problem?.message ?? 'That section could not be loaded.')
      } finally {
        setLoading(false)
      }
    },
    [ready, tab, range, cacheKey, payloads]
  )

  useEffect(() => {
    load()
  }, [load])

  const payload = payloads[cacheKey]

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F7F8FC]">
        <p className="text-sm text-slate-500">Checking access…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F7F8FC]">
      <Sidebar isLoggedIn userEmail={userEmail} isAdmin onCollapsedChange={setSidebarCollapsed} />

      <div
        className={`transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}
      >
        <Controls
          tab={tab}
          onTab={setTab}
          range={range}
          onRange={setRange}
          generatedAt={payload?.generatedAt ?? null}
          comparisonLabel={payload?.range.comparison?.label ?? null}
          timezone={payload?.range.timezone ?? REPORTING_TIMEZONE}
          loading={loading}
          onRefresh={() => load(true)}
        />

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          {error && (
            <Card className="mb-4 border-red-200 bg-red-50">
              <p className="text-sm text-red-800">{error}</p>
              <button
                type="button"
                onClick={() => load(true)}
                className="mt-2 rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100"
              >
                Try again
              </button>
            </Card>
          )}

          {!payload && loading && <LoadingSection />}

          {!payload && !loading && !error && range.preset === 'custom' && (
            <EmptyState title="Choose both dates to load this window." />
          )}

          {payload && (
            <>
              <SectionBody payload={payload} timezone={payload.range.timezone} tab={tab} />
              <div className="mt-6">
                <DiagnosticsPanel payload={payload} />
              </div>
            </>
          )}

          <p className="mt-8 text-center text-[11px] text-slate-400">
            <Link href="/admin/schools" className="hover:text-slate-600">
              Back to admin
            </Link>
          </p>
        </main>
      </div>
    </div>
  )
}

function SectionBody({ payload, timezone, tab }: { payload: SectionPayload; timezone: string; tab: TabId }) {
  const groups = useMemo(() => {
    const map = new Map<string, Metric[]>()
    for (const metric of payload.metrics) {
      const key = metric.group ?? 'default'
      map.set(key, [...(map.get(key) ?? []), metric])
    }
    // A group can be made of charts or breakdowns alone — the Revenue tab's
    // membership panel has no cards of its own — so the list of groups is the
    // union of all three, not just the ones that happen to have metrics.
    for (const item of [...payload.series, ...payload.breakdowns]) {
      const key = item.group ?? 'default'
      if (!map.has(key)) map.set(key, [])
    }
    return [...map.entries()].sort(
      (a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0])
    )
  }, [payload])

  return (
    <div className="space-y-6">
      {groups.map(([group, metrics]) => {
        const heading = GROUP_TITLES[group]
        const groupSeries = payload.series.filter((item) => (item.group ?? 'default') === group)
        const groupBreakdowns = payload.breakdowns.filter((item) => (item.group ?? 'default') === group)

        return (
          <section key={group}>
            {heading && <SectionTitle title={heading.title} detail={heading.detail} />}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {metrics.map((metric) => (
                <KpiCard key={metric.id} metric={metric} />
              ))}
            </div>

            {groupSeries.length > 0 && (
              <div className={`mt-4 grid gap-4 ${groupSeries.length > 1 ? 'xl:grid-cols-2' : ''}`}>
                {groupSeries.map((series) => (
                  <TimeSeriesChart key={series.id} series={series} />
                ))}
              </div>
            )}

            {groupBreakdowns.length > 0 && (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {groupBreakdowns.map((breakdown) => (
                  <BreakdownPanel key={breakdown.id} breakdown={breakdown} />
                ))}
              </div>
            )}
          </section>
        )
      })}

      {/* Funnels belong to the section, not to one group: tying them to the
          'default' group hid the checkout funnel on every tab whose metrics
          are all grouped. */}
      {payload.funnels.length > 0 && (
        <section>
          <div className="grid gap-4 lg:grid-cols-2">
            {payload.funnels.map((funnel) => (
              <FunnelPanel key={funnel.id} funnel={funnel} />
            ))}
          </div>
        </section>
      )}

      {tab === 'operations' && (
        <>
          <section>
            <SectionTitle
              title="Member activity"
              detail="Searchable, sorted and paged on the server."
            />
            <MemberTable timezone={timezone} />
          </section>
          <section>
            <SectionTitle title="Queues" detail="Feedback, feature requests and school unlock requests." />
            <Queues timezone={timezone} />
          </section>
        </>
      )}
    </div>
  )
}

function LoadingSection() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Card key={index}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-20" />
            <Skeleton className="mt-3 h-6 w-full" />
          </Card>
        ))}
      </div>
      <Card>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-4 h-[180px] w-full" />
      </Card>
    </div>
  )
}
