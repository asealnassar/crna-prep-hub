/**
 * The shapes every analytics section speaks in.
 *
 * ONE RULE ABOVE ALL: a number that is not known is null with a reason, never
 * zero. The old dashboard printed 0 interviews for every member whenever its
 * metrics call failed, and printed a question count that was really "the first
 * 1000 rows PostgREST would return". Both read as facts. Every value here
 * carries its own status, its source, and the date its source started
 * recording, so the page can say "not tracked yet" or "since 30 Aug" instead
 * of drawing a confident line through nothing.
 */

export type MetricStatus =
  /** A real figure, from data that covers the whole window. */
  | 'ok'
  /** Real, but the source began inside the window or undercounts by design. */
  | 'partial'
  /** Nothing records this yet. Needs instrumentation, not a query. */
  | 'not_tracked'
  /** The data exists but this server cannot read it without a migration. */
  | 'needs_migration'
  /** The query failed. Shown as a failure, never as an empty result. */
  | 'error'

/** Where a figure comes from, in the reader's terms rather than SQL. */
export type MetricSource = {
  /** e.g. "interview_grants" or "Stripe" */
  readonly label: string
  /** How it is counted, in one sentence. */
  readonly detail?: string
  /** ISO date of the earliest record this source holds, when known. */
  readonly coverageStart?: string | null
}

export type MetricUnit = 'count' | 'percent' | 'currency' | 'score'

export type Metric = {
  readonly id: string
  readonly label: string
  /** Which block of the section this belongs to, e.g. 'interviews'. */
  readonly group?: string
  readonly value: number | null
  /** The same measure over the preceding window, when a comparison applies. */
  readonly previous?: number | null
  readonly unit?: MetricUnit
  readonly status: MetricStatus
  /** Why it is partial, untracked or failed — shown to the reader verbatim. */
  readonly note?: string
  readonly source?: MetricSource
  /** Sparkline values, oldest first. */
  readonly spark?: readonly number[]
}

export type SeriesPoint = {
  readonly key: string
  readonly label: string
  readonly values: readonly number[]
  /** Drawn as a line rather than bars. */
  readonly kind?: 'bar' | 'line'
  /** Plotted against a second axis (cumulative totals, rates). */
  readonly axis?: 'left' | 'right'
}

export type Series = {
  readonly id: string
  readonly label: string
  readonly group?: string
  /** Bucket keys, oldest first: 'YYYY-MM-DD', 'YYYY-Www' or 'YYYY-MM'. */
  readonly buckets: readonly string[]
  readonly labels: readonly string[]
  readonly points: readonly SeriesPoint[]
  readonly status: MetricStatus
  readonly note?: string
  readonly source?: MetricSource
}

export type BreakdownRow = {
  readonly key: string
  readonly label: string
  readonly value: number | null
  readonly note?: string
}

export type Breakdown = {
  readonly id: string
  readonly label: string
  readonly group?: string
  readonly rows: readonly BreakdownRow[]
  readonly status: MetricStatus
  readonly note?: string
  readonly source?: MetricSource
}

export type FunnelStep = {
  readonly id: string
  readonly label: string
  readonly value: number | null
  readonly status: MetricStatus
  readonly note?: string
}

export type Funnel = {
  readonly id: string
  readonly label: string
  readonly steps: readonly FunnelStep[]
}

/**
 * What a section tells the page about its own limits: rows it could not read,
 * and reads that hit their ceiling. A truncated read is reported rather than
 * quietly producing a smaller number.
 */
export type SectionDiagnostics = {
  readonly truncated: readonly string[]
  readonly failed: readonly { readonly source: string; readonly reason: string }[]
  readonly durationMs: number
}

export type SectionPayload = {
  readonly section: string
  readonly generatedAt: string
  readonly range: {
    readonly preset: string
    readonly from: string | null
    readonly to: string
    readonly bucket: string
    readonly timezone: string
    readonly label: string
    readonly comparison: { readonly from: string; readonly to: string; readonly label: string } | null
  }
  readonly metrics: readonly Metric[]
  readonly series: readonly Series[]
  readonly breakdowns: readonly Breakdown[]
  readonly funnels: readonly Funnel[]
  readonly diagnostics: SectionDiagnostics
}

/** Marks a metric nothing records yet, with what it would take to record it. */
export function notTracked(
  id: string,
  label: string,
  note: string,
  unit: MetricUnit = 'count',
  group?: string
): Metric {
  return { id, label, value: null, unit, status: 'not_tracked', note, group }
}

/** Marks a metric whose data exists but is unreachable without a migration. */
export function needsMigration(
  id: string,
  label: string,
  note: string,
  unit: MetricUnit = 'count',
  group?: string
): Metric {
  return { id, label, value: null, unit, status: 'needs_migration', note, group }
}
