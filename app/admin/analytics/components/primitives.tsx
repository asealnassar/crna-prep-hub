'use client'

import { STATUS_LABELS, STATUS_STYLES } from '@/lib/analytics/format'
import type { MetricStatus } from '@/lib/analytics/types'

/**
 * The small pieces every panel is built from.
 *
 * One rule runs through all of them: a figure the dashboard cannot stand
 * behind is never drawn as if it could. A card with no value shows a dash and
 * says why, in the same place a number would have been.
 */

export const CHART_COLORS = {
  primary: '#7C3AED',
  primarySoft: '#C4B5FD',
  secondary: '#EC4899',
  grid: '#E2E8F0',
  axis: '#94A3B8',
} as const

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: React.ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white shadow-sm ${padded ? 'p-4 sm:p-5' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

export function PanelHeading({
  title,
  subtitle,
  status,
  right,
}: {
  title: string
  subtitle?: string
  status?: MetricStatus
  right?: React.ReactNode
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {status && status !== 'ok' && <StatusChip status={status} />}
        </div>
        {subtitle && <p className="mt-1 text-xs leading-relaxed text-slate-500">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function StatusChip({ status, className = '' }: { status: MetricStatus; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STATUS_STYLES[status]} ${className}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

/** A source label, so every number says where it came from. */
export function SourceNote({ label, detail }: { label?: string; detail?: string }) {
  if (!label) return null
  return (
    <p className="mt-2 text-[11px] text-slate-400" title={detail}>
      Source: {label}
    </p>
  )
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-6 text-center">
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {detail && <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">{detail}</p>}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-100 ${className}`} />
}

export function SectionTitle({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="mb-3 mt-2">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {detail && <p className="mt-0.5 text-xs text-slate-500">{detail}</p>}
    </div>
  )
}
