import { within, type ResolvedRange } from '../../range'
import { countBy, rank } from '../../aggregate'
import type { Breakdown, Metric, SectionPayload } from '../../types'
import { Diagnostics, noteFromFailure, statusFromFailure } from '../failures'
import type { Reader } from '../reader'

/**
 * Feedback and operations: the queues, and whether the machinery behind them
 * is healthy.
 *
 * The lists themselves — feedback, feature requests, school unlock requests —
 * stay exactly where they were, read and acted on by the admin page. This
 * section counts them and adds the operational signals that were never
 * surfaced anywhere: failed notification emails, broadcasts that did not
 * finish, and interviews whose entitlement charge failed.
 */

type FeedbackRow = { created_at: string; message: string | null }
type FeatureRow = { created_at: string; status: string | null }
type UnlockRow = { requested_at: string; status: string | null; approved_at: string | null }
type JobRow = { created_at: string; status: string | null }
type ReportRow = { created_at: string; status: string | null }

/** Which product a feedback message came from, from the tag it carries. */
export function feedbackSource(message: string | null | undefined): string {
  const text = String(message ?? '')
  if (text.startsWith('[Resume Builder V2]')) return 'Resume Builder V2'
  if (text.startsWith('[Resume Builder]')) return 'Resume Builder V1'
  if (text.startsWith('[Mock Interview]')) return 'Mock interview'
  if (text.startsWith('[General]')) return 'General'
  return 'Untagged (interview page)'
}

export async function buildOperations(reader: Reader, range: ResolvedRange): Promise<SectionPayload> {
  const diagnostics = new Diagnostics()
  const window = { from: range.from, to: range.to }

  const [feedback, features, unlocks, reports, jobs, broadcasts, grants] = await Promise.all([
    reader.rows<FeedbackRow>('interview_feedback', 'created_at, message', {
      dateColumn: 'created_at',
      ...window,
      tiebreak: 'id',
    }),
    reader.rows<FeatureRow>('feature_requests', 'created_at, status', {
      dateColumn: 'created_at',
      ...window,
      tiebreak: 'id',
    }),
    reader.rows<UnlockRow>('school_unlock_requests', 'requested_at, status, approved_at', {
      dateColumn: 'requested_at',
      tiebreak: 'id',
    }),
    reader.rows<ReportRow>('school_reports', 'created_at, status', {
      dateColumn: 'created_at',
      tiebreak: 'id',
    }),
    reader.rows<JobRow>('email_notification_jobs', 'created_at, status', {
      dateColumn: 'created_at',
      tiebreak: 'message_id',
    }),
    reader.rows<JobRow>('email_broadcasts', 'created_at, status', {
      dateColumn: 'created_at',
      tiebreak: 'id',
    }),
    reader.rows<{ created_at: string; abandoned_at: string | null; session_id: string | null }>(
      'interview_grants',
      'created_at, abandoned_at, session_id',
      { dateColumn: 'created_at', ...window, tiebreak: 'id' }
    ),
  ])

  const metrics: Metric[] = []
  const breakdowns: Breakdown[] = []

  // ------------------------------------------------------------------ queues
  if (feedback.ok) {
    if (feedback.truncated) diagnostics.cut('interview_feedback')
    metrics.push({
      id: 'feedback_received',
      label: 'Feedback received',
      group: 'queues',
      value: feedback.rows.length,
      status: 'ok',
      source: { label: 'interview_feedback' },
    })
    if (feedback.rows.length > 0) {
      breakdowns.push({
        id: 'feedback_by_source',
        label: 'Feedback by product',
        group: 'queues',
        status: 'ok',
        note: 'Taken from the tag each message carries. Messages sent from the interview page carry none.',
        source: { label: 'interview_feedback.message' },
        rows: rank(countBy(feedback.rows, (row) => feedbackSource(row.message))).map((row) => ({
          key: row.key,
          label: row.key,
          value: row.value,
        })),
      })
    }
  } else {
    diagnostics.note('interview_feedback', feedback.reason, feedback.detail)
    metrics.push({
      id: 'feedback_received',
      label: 'Feedback received',
      group: 'queues',
      value: null,
      status: statusFromFailure(feedback.reason),
      note: noteFromFailure('interview_feedback', feedback.reason, feedback.detail),
    })
  }

  if (features.ok) {
    const pending = features.rows.filter((row) => (row.status ?? 'pending') === 'pending').length
    metrics.push({
      id: 'feature_requests',
      label: 'Feature requests',
      group: 'queues',
      value: features.rows.length,
      status: 'ok',
      note: `${pending} still pending.`,
      source: { label: 'feature_requests' },
    })
    if (features.rows.length > 0) {
      breakdowns.push({
        id: 'feature_status',
        label: 'Feature requests by status',
        group: 'queues',
        status: 'ok',
        source: { label: 'feature_requests.status' },
        rows: rank(countBy(features.rows, (row) => row.status ?? 'pending')).map((row) => ({
          key: row.key,
          label: row.key,
          value: row.value,
        })),
      })
    }
  } else {
    diagnostics.note('feature_requests', features.reason, features.detail)
  }

  if (unlocks.ok) {
    if (unlocks.truncated) diagnostics.cut('school_unlock_requests')
    const pending = unlocks.rows.filter((row) => (row.status ?? '') !== 'approved')
    const inWindow = unlocks.rows.filter((row) => within(row.requested_at, range.from, range.to))
    const approvedWithTimes = unlocks.rows.filter((row) => row.approved_at && row.requested_at)
    const waits = approvedWithTimes
      .map((row) => Date.parse(row.approved_at!) - Date.parse(row.requested_at))
      .filter((ms) => Number.isFinite(ms) && ms >= 0)
      .sort((a, b) => a - b)
    const medianWaitHours = waits.length > 0 ? waits[Math.floor(waits.length / 2)] / (60 * 60 * 1000) : null

    metrics.push(
      {
        id: 'unlock_pending',
        label: 'School requests awaiting approval',
        group: 'queues',
        value: pending.length,
        status: 'ok',
        note: 'Across all time, not just this window — a queue is only useful in full.',
        source: { label: 'school_unlock_requests' },
      },
      {
        id: 'unlock_window',
        label: 'School requests made',
        group: 'queues',
        value: inWindow.length,
        status: 'ok',
        source: { label: 'school_unlock_requests.requested_at' },
      },
      {
        id: 'unlock_median_wait',
        label: 'Median time to approve',
        group: 'queues',
        value: medianWaitHours,
        unit: 'score',
        status: medianWaitHours === null ? 'partial' : 'ok',
        note:
          medianWaitHours === null
            ? 'No approved request carries both timestamps yet.'
            : 'Hours between the request and its approval, across all approved requests.',
        source: { label: 'school_unlock_requests' },
      }
    )
  } else {
    diagnostics.note('school_unlock_requests', unlocks.reason, unlocks.detail)
  }

  if (reports.ok) {
    const open = reports.rows.filter((row) => (row.status ?? 'pending') !== 'resolved').length
    metrics.push({
      id: 'school_reports_open',
      label: 'School error reports open',
      group: 'queues',
      value: open,
      status: 'ok',
      note: 'Members reporting wrong directory data. Across all time.',
      source: { label: 'school_reports' },
    })
  } else {
    diagnostics.note('school_reports', reports.reason, reports.detail)
  }

  // ------------------------------------------------------------------- health
  if (jobs.ok) {
    if (jobs.truncated) diagnostics.cut('email_notification_jobs')
    const counts = countBy(jobs.rows, (row) => row.status ?? 'unknown')
    const failed = (counts.get('failed') ?? 0) + (counts.get('uncertain') ?? 0)
    const pending = counts.get('pending') ?? 0
    metrics.push({
      id: 'email_jobs_failed',
      label: 'Notification emails failed',
      group: 'health',
      value: failed,
      status: 'ok',
      note: '"uncertain" means the provider may have accepted it before the worker crashed; those are never retried automatically.',
      source: { label: 'email_notification_jobs' },
    })
    metrics.push({
      id: 'email_jobs_pending',
      label: 'Notification emails waiting',
      group: 'health',
      value: pending,
      status: 'ok',
      note: 'A number that keeps climbing means the worker is not running.',
      source: { label: 'email_notification_jobs' },
    })
    if (jobs.rows.length > 0) {
      breakdowns.push({
        id: 'email_job_status',
        label: 'Notification email jobs by status',
        group: 'health',
        status: 'ok',
        source: { label: 'email_notification_jobs.status' },
        rows: rank(counts).map((row) => ({ key: row.key, label: row.key, value: row.value })),
      })
    }
  } else {
    diagnostics.note('email_notification_jobs', jobs.reason, jobs.detail)
  }

  if (broadcasts.ok && broadcasts.rows.length > 0) {
    const counts = countBy(broadcasts.rows, (row) => row.status ?? 'unknown')
    breakdowns.push({
      id: 'broadcast_status',
      label: 'Email broadcasts by status',
      group: 'health',
      status: 'ok',
      source: { label: 'email_broadcasts.status' },
      rows: rank(counts).map((row) => ({ key: row.key, label: row.key, value: row.value })),
    })
  } else if (!broadcasts.ok) {
    diagnostics.note('email_broadcasts', broadcasts.reason, broadcasts.detail)
  }

  if (grants.ok) {
    const voided = grants.rows.filter((row) => row.abandoned_at && !row.session_id).length
    metrics.push({
      id: 'voided_grants',
      label: 'Interviews voided by a failed charge',
      group: 'health',
      value: voided,
      status: 'ok',
      note: 'The interview was authorised but the entitlement charge failed, so it was voided and never started. Each one is a member who tried and could not.',
      source: { label: 'interview_grants' },
    })
  }

  return {
    section: 'operations',
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
