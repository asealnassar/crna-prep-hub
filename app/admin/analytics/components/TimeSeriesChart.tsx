'use client'

import { useState } from 'react'
import { formatNumber } from '@/lib/analytics/format'
import type { Series } from '@/lib/analytics/types'
import { CHART_COLORS, Card, EmptyState, PanelHeading, SourceNote } from './primitives'

/**
 * Bars and lines over time, drawn as SVG.
 *
 * Hand-drawn rather than pulled from a charting library: the whole chart is
 * about forty lines, it inherits the page's own colours, and it adds nothing
 * to the bundle every member of the site downloads. Hovering a bucket reveals
 * every series at that point.
 *
 * A series with a right-hand axis (a cumulative total beside daily bars) is
 * scaled separately, so a total in the hundreds does not flatten counts in the
 * single digits.
 */
export function TimeSeriesChart({ series }: { series: Series }) {
  const [hovered, setHovered] = useState<number | null>(null)

  const width = 640
  const height = 200
  const padding = { top: 12, right: 8, bottom: 22, left: 8 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom

  const count = series.buckets.length
  const bars = series.points.filter((point) => point.kind !== 'line')
  const lines = series.points.filter((point) => point.kind === 'line')

  const leftMax = Math.max(
    1,
    ...series.points.filter((point) => point.axis !== 'right').flatMap((point) => [...point.values])
  )
  const rightMax = Math.max(1, ...series.points.filter((point) => point.axis === 'right').flatMap((point) => [...point.values]))

  const scale = (value: number, axis: 'left' | 'right' | undefined) =>
    plotHeight - (value / (axis === 'right' ? rightMax : leftMax)) * plotHeight

  const slot = count > 0 ? plotWidth / count : plotWidth
  const barWidth = bars.length > 0 ? Math.max(1.5, (slot * 0.62) / bars.length) : 0

  const everythingZero = series.points.every((point) => point.values.every((value) => value === 0))

  return (
    <Card>
      <PanelHeading
        title={series.label}
        subtitle={series.note}
        status={series.status}
        right={
          <div className="hidden shrink-0 gap-3 sm:flex">
            {series.points.map((point, index) => (
              <span key={point.key} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: seriesColor(index, point.kind) }}
                />
                {point.label}
              </span>
            ))}
          </div>
        }
      />

      {count === 0 ? (
        <EmptyState title="Nothing to draw for this window." />
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${width} ${height}`} className="h-[200px] w-full" role="img" aria-label={series.label}>
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
              <line
                key={fraction}
                x1={padding.left}
                x2={width - padding.right}
                y1={padding.top + plotHeight * fraction}
                y2={padding.top + plotHeight * fraction}
                stroke={CHART_COLORS.grid}
                strokeWidth={1}
              />
            ))}

            {bars.map((point, pointIndex) =>
              point.values.map((value, index) => {
                const x =
                  padding.left + index * slot + (slot - barWidth * bars.length) / 2 + pointIndex * barWidth
                const y = padding.top + scale(value, point.axis)
                return (
                  <rect
                    key={`${point.key}-${index}`}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(0, plotHeight - scale(value, point.axis))}
                    rx={1.5}
                    fill={seriesColor(series.points.indexOf(point), point.kind)}
                    opacity={hovered === null || hovered === index ? 1 : 0.35}
                  />
                )
              })
            )}

            {lines.map((point) => {
              const path = point.values
                .map((value, index) => {
                  const x = padding.left + index * slot + slot / 2
                  const y = padding.top + scale(value, point.axis)
                  return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
                })
                .join(' ')
              return (
                <path
                  key={point.key}
                  d={path}
                  fill="none"
                  stroke={seriesColor(series.points.indexOf(point), 'line')}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )
            })}

            {hovered !== null && (
              <line
                x1={padding.left + hovered * slot + slot / 2}
                x2={padding.left + hovered * slot + slot / 2}
                y1={padding.top}
                y2={padding.top + plotHeight}
                stroke={CHART_COLORS.axis}
                strokeDasharray="3 3"
                strokeWidth={1}
              />
            )}

            {series.buckets.map((bucket, index) => (
              <rect
                key={bucket}
                x={padding.left + index * slot}
                y={padding.top}
                width={slot}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
              />
            ))}

            {tickIndexes(count).map((index) => (
              <text
                key={index}
                x={padding.left + index * slot + slot / 2}
                y={height - 6}
                textAnchor="middle"
                fontSize="10"
                fill={CHART_COLORS.axis}
              >
                {series.labels[index]}
              </text>
            ))}
          </svg>

          {everythingZero && series.status === 'ok' && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-400">
              No activity recorded in this window.
            </p>
          )}

          {hovered !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"
              style={{ left: `${((hovered + 0.5) / Math.max(count, 1)) * 100}%` }}
            >
              <p className="font-medium text-slate-900">{series.labels[hovered]}</p>
              {series.points.map((point, index) => (
                <p key={point.key} className="mt-1 flex items-center gap-1.5 text-slate-600">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: seriesColor(index, point.kind) }}
                  />
                  {point.label}: <span className="font-medium text-slate-900">{formatNumber(point.values[hovered])}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <SourceNote label={series.source?.label} detail={series.source?.detail} />
    </Card>
  )
}

function seriesColor(index: number, kind?: 'bar' | 'line'): string {
  if (kind === 'line') return CHART_COLORS.secondary
  return index === 0 ? CHART_COLORS.primary : CHART_COLORS.primarySoft
}

/** At most eight labels, so the axis stays readable at any window length. */
function tickIndexes(count: number): number[] {
  if (count === 0) return []
  const step = Math.max(1, Math.ceil(count / 8))
  const indexes: number[] = []
  for (let index = 0; index < count; index += step) indexes.push(index)
  if (indexes[indexes.length - 1] !== count - 1) indexes.push(count - 1)
  return indexes
}
