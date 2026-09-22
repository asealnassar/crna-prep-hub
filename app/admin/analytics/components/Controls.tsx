'use client'

import { useEffect, useRef } from 'react'

import { formatDateTime } from '@/lib/analytics/format'

/**
 * The tabs and the window, which every section obeys.
 *
 * The range lives in the URL as well as in state, so a view can be sent to
 * somebody or reopened tomorrow and still mean the same thing. The reporting
 * timezone is printed next to it, because "today" is otherwise whatever the
 * reader's browser believes.
 */

export type TabId = 'overview' | 'acquisition' | 'revenue' | 'product' | 'retention' | 'operations'

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'acquisition', label: 'Acquisition' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'product', label: 'Product usage' },
  { id: 'retention', label: 'Retention' },
  { id: 'operations', label: 'Feedback and ops' },
]

export type RangeState = { preset: string; from: string; to: string }

const PRESETS: readonly { id: string; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'custom', label: 'Custom' },
  { id: 'all', label: 'All time' },
]

export function Controls({
  tab,
  onTab,
  range,
  onRange,
  generatedAt,
  comparisonLabel,
  timezone,
  loading,
  onRefresh,
}: {
  tab: TabId
  onTab: (tab: TabId) => void
  range: RangeState
  onRange: (range: RangeState) => void
  generatedAt: string | null
  comparisonLabel: string | null
  timezone: string
  loading: boolean
  onRefresh: () => void
}) {
  const tabStrip = useRef<HTMLElement>(null)
  const activeTab = useRef<HTMLButtonElement>(null)

  // On a phone the strip is wider than the screen, so arriving on a later tab
  // showed only the first few and no sign of which one was open. Scroll the
  // strip itself rather than the page.
  useEffect(() => {
    const strip = tabStrip.current
    const button = activeTab.current
    if (!strip || !button) return
    const offset = button.offsetLeft - (strip.clientWidth - button.clientWidth) / 2
    strip.scrollTo({ left: Math.max(0, offset), behavior: 'smooth' })
  }, [tab])

  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Analytics</h1>
            <p className="text-xs text-slate-500">
              {generatedAt ? `Data as of ${formatDateTime(generatedAt, timezone)}` : 'Loading…'} · all dates in{' '}
              {timezone.replace('_', ' ')}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        <nav
          ref={tabStrip}
          className="-mb-px mt-4 flex gap-1 overflow-x-auto"
          aria-label="Analytics sections"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              ref={tab === item.id ? activeTab : undefined}
              type="button"
              onClick={() => onTab(item.id)}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${
                tab === item.id
                  ? 'border-violet-600 font-medium text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
              aria-current={tab === item.id ? 'page' : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="border-t border-slate-100 bg-slate-50/70">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onRange({ ...range, preset: preset.id })}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                range.preset === preset.id
                  ? 'border-violet-300 bg-violet-50 text-violet-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              {preset.label}
            </button>
          ))}

          {range.preset === 'custom' && (
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
              <input
                type="date"
                value={range.from}
                max={range.to || undefined}
                onChange={(event) => onRange({ ...range, from: event.target.value })}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                aria-label="From date"
              />
              <span className="text-slate-400">to</span>
              <input
                type="date"
                value={range.to}
                min={range.from || undefined}
                onChange={(event) => onRange({ ...range, to: event.target.value })}
                className="rounded-lg border border-slate-200 px-2 py-1 text-xs"
                aria-label="To date"
              />
            </span>
          )}

          <span className="ml-auto text-[11px] text-slate-500">
            {comparisonLabel ? `Compared with the ${comparisonLabel}` : 'No comparison for this window'}
          </span>
        </div>
      </div>
    </div>
  )
}
