'use client'

import type { Metric, SectionPayload } from '@/lib/analytics/types'
import { Card, StatusChip } from './primitives'

/**
 * What this section could not answer, and why — at the foot of every tab.
 *
 * A dashboard that hides its gaps is worse than one with fewer numbers: the
 * reader cannot tell a quiet week from a broken query. Truncated reads,
 * unreadable tables and untracked metrics are all listed here in plain words.
 */
export function DiagnosticsPanel({ payload }: { payload: SectionPayload }) {
  const gaps = payload.metrics.filter(
    (metric) => metric.status === 'not_tracked' || metric.status === 'needs_migration' || metric.status === 'error'
  )
  const { truncated, failed } = payload.diagnostics

  if (gaps.length === 0 && truncated.length === 0 && failed.length === 0) {
    return (
      <Card className="border-emerald-100 bg-emerald-50/40">
        <p className="text-xs text-emerald-800">
          Every figure in this section came from complete data. Nothing was truncated and nothing was estimated.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-slate-900">What this section cannot show yet</h3>
      <p className="mt-1 text-xs text-slate-500">
        Listed so a blank space is never mistaken for a zero. Everything above this line came from real data.
      </p>

      {gaps.length > 0 && (
        <ul className="mt-3 space-y-2">
          {gaps.map((metric) => (
            <GapRow key={metric.id} metric={metric} />
          ))}
        </ul>
      )}

      {truncated.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-800">Reads that hit their ceiling</p>
          <p className="mt-0.5 text-[11px] text-amber-700">
            {truncated.join(', ')} returned more rows than one request allows, so the figures drawn from them are
            lower bounds. Raise the ceiling or aggregate in the database.
          </p>
        </div>
      )}

      {failed.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {failed.map((failure) => (
            <p key={failure.source} className="text-[11px] text-slate-600">
              <span className="font-medium text-slate-800">{failure.source}</span>: {failure.reason}
            </p>
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] text-slate-400">Section built in {payload.diagnostics.durationMs} ms.</p>
    </Card>
  )
}

function GapRow({ metric }: { metric: Metric }) {
  return (
    <li className="flex flex-wrap items-start gap-2">
      <StatusChip status={metric.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-800">{metric.label}</p>
        {metric.note && <p className="text-[11px] leading-relaxed text-slate-500">{metric.note}</p>}
      </div>
    </li>
  )
}
