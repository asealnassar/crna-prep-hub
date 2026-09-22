'use client'

import { formatDelta, formatValue } from '@/lib/analytics/format'
import type { Metric } from '@/lib/analytics/types'
import { Card, SourceNote, StatusChip } from './primitives'

/**
 * One headline figure.
 *
 * When the value is null the card keeps its place in the grid and explains
 * itself: a dash, the status, and the sentence that says what is missing. The
 * old dashboard's worst habit was showing 0 in exactly this position.
 */
export function KpiCard({ metric, compact = false }: { metric: Metric; compact?: boolean }) {
  const delta = formatDelta(metric.value, metric.previous)
  const missing = metric.value === null || metric.value === undefined

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{metric.label}</p>
        {metric.status !== 'ok' && <StatusChip status={metric.status} />}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className={`font-semibold tracking-tight ${missing ? 'text-slate-300' : 'text-slate-900'} ${compact ? 'text-xl' : 'text-2xl sm:text-[26px]'}`}>
          {formatValue(metric.value, metric.unit)}
        </span>
        {delta && (
          <span
            className={`text-xs font-medium ${
              !delta.meaningful
                ? 'text-slate-400'
                : delta.direction === 'up'
                  ? 'text-emerald-600'
                  : delta.direction === 'down'
                    ? 'text-red-600'
                    : 'text-slate-400'
            }`}
            title="Compared with the previous window of the same length"
          >
            {delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : ''} {delta.label}
          </span>
        )}
      </div>

      {metric.spark && metric.spark.length > 1 && !missing && <Sparkline values={metric.spark} />}

      {metric.note && <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{metric.note}</p>}
      <div className="mt-auto">
        <SourceNote label={metric.source?.label} detail={metric.source?.detail} />
      </div>
    </Card>
  )
}

/** A shape, not a chart: no axis, no numbers, just the movement. */
function Sparkline({ values }: { values: readonly number[] }) {
  const max = Math.max(...values, 1)
  const width = 120
  const height = 24
  const step = values.length > 1 ? width / (values.length - 1) : width

  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`)
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="mt-3 h-6 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="Trend across the window"
    >
      <polyline points={points} fill="none" stroke="#7C3AED" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
