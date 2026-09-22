'use client'

import { formatNumber, formatPercent, formatValue } from '@/lib/analytics/format'
import type { Breakdown as BreakdownData, Funnel } from '@/lib/analytics/types'
import { CHART_COLORS, Card, EmptyState, PanelHeading, SourceNote } from './primitives'

/** A ranked list with a bar behind each row, sized against the largest. */
export function BreakdownPanel({ breakdown }: { breakdown: BreakdownData }) {
  const values = breakdown.rows.map((row) => row.value ?? 0)
  const max = Math.max(1, ...values)
  const total = values.reduce((sum, value) => sum + value, 0)

  return (
    <Card>
      <PanelHeading title={breakdown.label} subtitle={breakdown.note} status={breakdown.status} />

      {breakdown.rows.length === 0 ? (
        <EmptyState title="Nothing recorded in this window." />
      ) : (
        <ul className="space-y-2.5">
          {breakdown.rows.map((row) => {
            const value = row.value ?? 0
            return (
              <li key={row.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm text-slate-700" title={row.label}>
                    {row.label}
                  </span>
                  <span className="shrink-0 text-sm font-medium text-slate-900">
                    {formatValue(row.value, breakdown.unit)}
                    {total > 0 && (
                      <span className="ml-1.5 text-xs font-normal text-slate-400">
                        {formatPercent((value / total) * 100, 0)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(value / max) * 100}%`, background: CHART_COLORS.primary }}
                  />
                </div>
                {row.note && <p className="mt-1 text-[11px] text-slate-500">{row.note}</p>}
              </li>
            )
          })}
        </ul>
      )}

      <SourceNote label={breakdown.source?.label} detail={breakdown.source?.detail} />
    </Card>
  )
}

/**
 * The funnel, including the steps that cannot be measured yet.
 *
 * Those are drawn as an outline rather than a bar, so the gap in the funnel is
 * visible as a gap. Filling them with zero would read as "nobody visits".
 */
export function FunnelPanel({ funnel }: { funnel: Funnel }) {
  const known = funnel.steps.filter((step) => typeof step.value === 'number').map((step) => step.value as number)
  const max = Math.max(1, ...known)

  return (
    <Card>
      <PanelHeading title={funnel.label} />
      <ol className="space-y-3">
        {funnel.steps.map((step, index) => {
          const previous = funnel.steps[index - 1]
          const rate =
            typeof step.value === 'number' && typeof previous?.value === 'number' && previous.value > 0
              ? (step.value / previous.value) * 100
              : null

          return (
            <li key={step.id}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-slate-700">{step.label}</span>
                <span className="text-sm font-medium text-slate-900">
                  {typeof step.value === 'number' ? formatNumber(step.value) : <span className="text-slate-300">—</span>}
                  {rate !== null && (
                    <span className="ml-1.5 text-xs font-normal text-slate-400">{formatPercent(rate, 0)}</span>
                  )}
                </span>
              </div>
              <div className="mt-1 h-2.5 w-full overflow-hidden rounded-md bg-slate-100">
                {typeof step.value === 'number' ? (
                  <div
                    className="h-full rounded-md"
                    style={{
                      width: `${Math.max((step.value / max) * 100, step.value > 0 ? 2 : 0)}%`,
                      background: CHART_COLORS.primary,
                      opacity: 1 - index * 0.12,
                    }}
                  />
                ) : (
                  <div className="h-full w-full rounded-md border border-dashed border-slate-300 bg-[repeating-linear-gradient(45deg,#F8FAFC,#F8FAFC_6px,#EEF2F7_6px,#EEF2F7_12px)]" />
                )}
              </div>
              {step.note && <p className="mt-1 text-[11px] text-slate-500">{step.note}</p>}
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
