import { bucketKeys, bucketLabel, within, type ResolvedRange } from '../../range'
import { countBy, countByBucket, mean, percent, rank } from '../../aggregate'
import {
  completionRate,
  followUpLabel,
  grantState,
  lengthLabel,
  modeLabel,
  totalGrants,
  typeLabel,
  type GrantRow,
} from '../../interviews'
import { isStatementOperation } from '../../../statement/usage'
import {
  notTracked,
  type Breakdown,
  type Metric,
  type SectionPayload,
  type Series,
} from '../../types'
import { Diagnostics, statusFromFailure, noteFromFailure } from '../failures'
import type { Reader, ReadResult } from '../reader'

/**
 * Product usage: what members actually do.
 *
 * The interview figures are the strongest data this project has — they come
 * from `interview_grants`, which only the server writes. The GPA figures are
 * the weakest: two of its three tables grant the server role nothing at all,
 * by a deliberate decision recorded in the migrations, so they are reported as
 * needing a database function rather than counted as zero.
 */

const GRANT_COLUMNS_FULL =
  'id, user_id, mode, interview_type, completed, created_at, follow_ups_enabled, session_id, abandoned_at, max_primary_questions'
const GRANT_COLUMNS_BASE = 'id, user_id, mode, interview_type, completed, created_at'

type SessionRow = { created_at: string; overall_score: number | null; school_type: string | null }
type ResumeRow = { created_at: string; schema_version: number | null; status: string | null }
type AiUsageRow = { created_at: string; operation: string | null; outcome: string | null }
type ImportRow = { created_at: string; source_format: string | null; outcome: string | null }
type CalculationRow = { created_at: string; engine_version: number | null }
type UnlockRow = { requested_at: string; status: string | null; approved_at: string | null; school_name: string | null }

/**
 * Grants, with the columns added by later migrations if this database has
 * them. The fallback matters: without it a dashboard pointed at a database
 * that has not had the Quick/Full migration applied would show nothing about
 * interviews at all, rather than everything except length.
 */
async function readGrants(
  reader: Reader,
  window: { from: string | null; to: string }
): Promise<{ result: ReadResult<GrantRow>; extended: boolean }> {
  const query = { dateColumn: 'created_at', from: window.from, to: window.to, tiebreak: 'id' }
  const full = await reader.rows<GrantRow>('interview_grants', GRANT_COLUMNS_FULL, query)
  if (full.ok) return { result: full, extended: true }
  if (full.reason !== 'missing') return { result: full, extended: false }

  const base = await reader.rows<GrantRow>('interview_grants', GRANT_COLUMNS_BASE, query)
  return { result: base, extended: false }
}

export async function buildProduct(reader: Reader, range: ResolvedRange): Promise<SectionPayload> {
  const diagnostics = new Diagnostics()
  const now = new Date()
  const window = { from: range.from, to: range.to }
  const comparison = range.comparison

  const [
    grants,
    questions,
    questionsBefore,
    sessions,
    resumes,
    aiUsage,
    imports,
    calculations,
    gpaDrafts,
    transcripts,
    savedSchools,
    unlocks,
    expedited,
  ] = await Promise.all([
    readGrants(reader, window),
    reader.count('user_asked_questions', { dateColumn: 'asked_at', ...window }),
    comparison
      ? reader.count('user_asked_questions', { dateColumn: 'asked_at', from: comparison.from, to: comparison.to })
      : Promise.resolve(null),
    reader.rows<SessionRow>('interview_sessions', 'created_at, overall_score, school_type', {
      dateColumn: 'created_at',
      ...window,
      tiebreak: 'id',
    }),
    reader.rows<ResumeRow>('resumes', 'created_at, schema_version, status', {
      dateColumn: 'created_at',
      tiebreak: 'id',
    }),
    reader.rows<AiUsageRow>('resume_ai_usage', 'created_at, operation, outcome', {
      dateColumn: 'created_at',
      ...window,
      tiebreak: 'id',
    }),
    reader.rows<ImportRow>('resume_imports', 'created_at, source_format, outcome', {
      dateColumn: 'created_at',
      ...window,
      tiebreak: 'id',
    }),
    reader.rows<CalculationRow>('gpa_calculations', 'created_at, engine_version', {
      dateColumn: 'created_at',
      ...window,
      tiebreak: 'id',
    }),
    reader.count('gpa_drafts'),
    reader.count('gpa_transcript_sources'),
    reader.count('saved_schools', { dateColumn: 'created_at', ...window }),
    reader.rows<UnlockRow>('school_unlock_requests', 'requested_at, status, approved_at, school_name', {
      dateColumn: 'requested_at',
      ...window,
      tiebreak: 'id',
    }),
    reader.count('expedited_requests', { dateColumn: 'created_at', ...window }),
  ])

  const metrics: Metric[] = []
  const breakdowns: Breakdown[] = []
  const series: Series[] = []

  const keys = bucketKeys(range.from ?? range.to, range.to, range.bucket, range.timezone)
  const labels = keys.map((key) => bucketLabel(key, range.bucket))

  // ---------------------------------------------------------------- interviews
  if (!grants.result.ok) {
    diagnostics.note('interview_grants', grants.result.reason, grants.result.detail)
    metrics.push({
      id: 'interview_starts',
      label: 'Interviews started',
      group: 'interviews',
      value: null,
      status: statusFromFailure(grants.result.reason),
      note: noteFromFailure('interview_grants', grants.result.reason, grants.result.detail),
    })
  } else {
    if (grants.result.truncated) diagnostics.cut('interview_grants')
    const rows = grants.result.rows
    const totals = totalGrants(rows, now)
    const started = rows.filter((row) => grantState(row, now) !== 'voided')

    metrics.push(
      {
        id: 'interview_starts',
        label: 'Interviews started',
        group: 'interviews',
        value: totals.started,
        status: 'ok',
        note: 'One authorised interview, however many questions it asked. Grants voided by a failed charge are excluded.',
        source: { label: 'interview_grants', detail: 'written by the server only' },
        spark: countByBucket(started, (row) => row.created_at, keys, range.bucket, range.timezone),
      },
      {
        id: 'interviews_completed',
        label: 'Interviews completed',
        group: 'interviews',
        value: totals.completed,
        status: 'ok',
        note: 'Reached a final report.',
        source: { label: 'interview_grants.completed' },
      },
      {
        id: 'interview_completion_rate',
        label: 'Completion rate',
        group: 'interviews',
        value: completionRate(totals),
        unit: 'percent',
        status: 'ok',
        note: 'Of interviews that have had their chance to finish. Ones still inside the 24-hour resume window are excluded.',
        source: { label: 'interview_grants' },
      },
      {
        id: 'interviews_abandoned',
        label: 'Given up by the applicant',
        group: 'interviews',
        value: grants.extended ? totals.abandoned : null,
        status: grants.extended ? 'partial' : 'needs_migration',
        note: grants.extended
          ? 'Recorded only since the resume feature shipped on 21 September 2026.'
          : 'interview_grants.abandoned_at does not exist in this database.',
        source: { label: 'interview_grants.abandoned_at' },
      },
      {
        id: 'interviews_unfinished',
        label: 'Left unfinished',
        group: 'interviews',
        value: totals.unfinished,
        status: 'ok',
        note: 'Never completed, never given up, and past the point they could be resumed.',
        source: { label: 'interview_grants' },
      },
      {
        id: 'interviews_in_progress',
        label: 'Still resumable',
        group: 'interviews',
        value: totals.inProgress,
        status: 'ok',
        note: 'Started within the last 24 hours and could still be continued.',
        source: { label: 'interview_grants' },
      }
    )

    if (totals.voided > 0) {
      metrics.push({
        id: 'interviews_voided',
        label: 'Voided before starting',
        group: 'interviews',
        value: totals.voided,
        status: 'ok',
        note: 'The interview was authorised but its entitlement charge failed, so it never reached the applicant. Not counted as a start.',
        source: { label: 'interview_grants' },
      })
    }

    series.push({
      id: 'interview_activity',
      label: 'Interviews started and completed',
      group: 'interviews',
      buckets: keys,
      labels,
      status: 'ok',
      source: { label: 'interview_grants' },
      points: [
        {
          key: 'started',
          label: 'Started',
          values: countByBucket(started, (row) => row.created_at, keys, range.bucket, range.timezone),
          kind: 'bar',
        },
        {
          key: 'completed',
          label: 'Completed',
          values: countByBucket(
            rows.filter((row) => row.completed === true),
            (row) => row.created_at,
            keys,
            range.bucket,
            range.timezone
          ),
          kind: 'line',
        },
      ],
    })

    breakdowns.push(
      {
        id: 'interview_type',
        label: 'Interview type',
        group: 'interviews',
        status: 'ok',
        source: { label: 'interview_grants.interview_type' },
        rows: rank(countBy(started, (row) => row.interview_type ?? null)).map((row) => ({
          key: row.key,
          label: typeLabel(row.key === '(not recorded)' ? null : row.key),
          value: row.value,
        })),
      },
      {
        id: 'interview_mode',
        label: 'Practice or real interview',
        group: 'interviews',
        status: 'ok',
        source: { label: 'interview_grants.mode' },
        rows: rank(countBy(started, (row) => row.mode ?? null)).map((row) => ({
          key: row.key,
          label: modeLabel(row.key === '(not recorded)' ? null : row.key),
          value: row.value,
        })),
      }
    )

    if (grants.extended) {
      breakdowns.push(
        {
          id: 'interview_length',
          label: 'Quick or Full',
          group: 'interviews',
          status: 'partial',
          note: 'The choice shipped on 22 September 2026. Interviews started before that were ten questions and are shown separately.',
          source: { label: 'interview_grants.max_primary_questions' },
          rows: rank(
            countBy(started, (row) =>
              row.max_primary_questions === null || row.max_primary_questions === undefined
                ? 'legacy'
                : String(row.max_primary_questions)
            )
          ).map((row) => ({
            key: row.key,
            label: lengthLabel(row.key === 'legacy' ? null : Number(row.key)),
            value: row.value,
          })),
        },
        {
          id: 'interview_follow_ups',
          label: 'Follow-up questions',
          group: 'interviews',
          status: 'partial',
          note: 'The choice shipped on 9 September 2026; earlier interviews always had follow-ups.',
          source: { label: 'interview_grants.follow_ups_enabled' },
          rows: rank(
            countBy(started, (row) =>
              row.follow_ups_enabled === null || row.follow_ups_enabled === undefined
                ? 'legacy'
                : String(row.follow_ups_enabled)
            )
          ).map((row) => ({
            key: row.key,
            label: followUpLabel(row.key === 'legacy' ? null : row.key === 'true'),
            value: row.value,
          })),
        }
      )
    }
  }

  // Questions are a volume measure, not an interview count.
  if (questions.ok) {
    metrics.push({
      id: 'questions_asked',
      label: 'Questions asked',
      group: 'interviews',
      value: questions.count,
      previous: questionsBefore && questionsBefore.ok ? questionsBefore.count : null,
      status: 'partial',
      note: 'Primary questions only — follow-ups are never logged. Written by the browser, so a member could add rows of their own.',
      source: { label: 'user_asked_questions' },
    })
  } else {
    diagnostics.note('user_asked_questions', questions.reason, questions.detail)
    metrics.push({
      id: 'questions_asked',
      label: 'Questions asked',
      group: 'interviews',
      value: null,
      status: statusFromFailure(questions.reason),
      note: noteFromFailure('user_asked_questions', questions.reason, questions.detail),
    })
  }

  if (sessions.ok) {
    if (sessions.truncated) diagnostics.cut('interview_sessions')
    const scored = sessions.rows.filter((row) => typeof row.overall_score === 'number')
    metrics.push(
      {
        id: 'interview_transcripts',
        label: 'Transcripts saved',
        group: 'interviews',
        value: sessions.rows.length,
        status: 'partial',
        note: 'Written by the browser as an interview runs, so this is not an authorisation count.',
        source: { label: 'interview_sessions' },
      },
      {
        id: 'interview_avg_score',
        label: 'Average final score',
        group: 'interviews',
        value: mean(scored.map((row) => row.overall_score)),
        unit: 'score',
        status: scored.length > 0 ? 'partial' : 'partial',
        note:
          scored.length > 0
            ? `From the ${scored.length} transcript(s) that carry a final report score. Browser-written.`
            : 'No transcript in this window carries a final score.',
        source: { label: 'interview_sessions.overall_score' },
      }
    )
  } else {
    diagnostics.note('interview_sessions', sessions.reason, sessions.detail)
  }

  // ---------------------------------------------------------------------- GPA
  if (calculations.ok) {
    if (calculations.truncated) diagnostics.cut('gpa_calculations')
    metrics.push({
      id: 'gpa_calculations',
      label: 'GPA calculations saved',
      group: 'gpa',
      value: calculations.rows.length,
      status: 'ok',
      note: 'Saved calculations, not visits to the analyzer.',
      source: { label: 'gpa_calculations' },
      spark: countByBucket(calculations.rows, (row) => row.created_at, keys, range.bucket, range.timezone),
    })
    const byEngine = countBy(calculations.rows, (row) =>
      row.engine_version === null || row.engine_version === undefined ? 'v1' : `v${row.engine_version}`
    )
    if (calculations.rows.length > 0) {
      breakdowns.push({
        id: 'gpa_engine',
        label: 'GPA engine version',
        group: 'gpa',
        status: 'ok',
        source: { label: 'gpa_calculations.engine_version' },
        rows: rank(byEngine).map((row) => ({
          key: row.key,
          label: row.key === 'v1' ? 'Engine V1 (not recalculated)' : 'Engine V2',
          value: row.value,
        })),
      })
    }
  } else {
    diagnostics.note('gpa_calculations', calculations.reason, calculations.detail)
    metrics.push({
      id: 'gpa_calculations',
      label: 'GPA calculations saved',
      group: 'gpa',
      value: null,
      status: statusFromFailure(calculations.reason),
      note: noteFromFailure('gpa_calculations', calculations.reason, calculations.detail),
    })
  }

  metrics.push(
    gpaDrafts.ok
      ? {
          id: 'gpa_analyses',
          label: 'GPA analyses held',
          group: 'gpa',
          value: gpaDrafts.count,
          status: 'partial',
          note: 'Analyses that exist right now. Deleted ones leave no trace, so this is not a count of analyses created.',
          source: { label: 'gpa_drafts' },
        }
      : {
          id: 'gpa_analyses',
          label: 'GPA analyses held',
          group: 'gpa',
          value: null,
          status: statusFromFailure(gpaDrafts.reason),
          note: noteFromFailure('gpa_drafts', gpaDrafts.reason, gpaDrafts.detail),
        },
    transcripts.ok
      ? {
          id: 'transcript_imports',
          label: 'Transcript imports',
          group: 'gpa',
          value: transcripts.count,
          status: 'partial',
          note: 'Successful imports only: a failed analysis releases its record. Recorded since 5 September 2026.',
          source: { label: 'gpa_transcript_sources' },
        }
      : {
          id: 'transcript_imports',
          label: 'Transcript imports',
          group: 'gpa',
          value: null,
          status: statusFromFailure(transcripts.reason),
          note: noteFromFailure('gpa_transcript_sources', transcripts.reason, transcripts.detail),
        }
  )
  if (!gpaDrafts.ok) diagnostics.note('gpa_drafts', gpaDrafts.reason, gpaDrafts.detail)
  if (!transcripts.ok) diagnostics.note('gpa_transcript_sources', transcripts.reason, transcripts.detail)

  // ------------------------------------------------------------------- resumes
  if (resumes.ok) {
    if (resumes.truncated) diagnostics.cut('resumes')
    const createdInWindow = resumes.rows.filter((row) => within(row.created_at, range.from, range.to))
    const completeNow = resumes.rows.filter((row) => (row.status ?? '') === 'complete').length

    metrics.push(
      {
        id: 'resumes_created',
        label: 'Resumes created',
        group: 'resume',
        value: createdInWindow.length,
        status: 'ok',
        source: { label: 'resumes.created_at' },
        spark: countByBucket(createdInWindow, (row) => row.created_at, keys, range.bucket, range.timezone),
      },
      {
        id: 'resumes_complete',
        label: 'Resumes marked complete',
        group: 'resume',
        value: completeNow,
        status: 'partial',
        note: 'How many are complete right now, across all time: nothing records WHEN a resume was finalised.',
        source: { label: 'resumes.status' },
      }
    )

    breakdowns.push({
      id: 'resume_generation',
      label: 'Resumes created by builder version',
      group: 'resume',
      status: 'ok',
      note: 'V2 is still admin-only in production, so V2 rows are test and migrated data rather than member activity.',
      source: { label: 'resumes.schema_version' },
      rows: rank(
        countBy(createdInWindow, (row) => (row.schema_version === 2 ? 'v2' : 'v1'))
      ).map((row) => ({
        key: row.key,
        label: row.key === 'v2' ? 'Resume Studio (V2)' : 'Resume Builder (V1)',
        value: row.value,
      })),
    })
  } else {
    diagnostics.note('resumes', resumes.reason, resumes.detail)
    metrics.push({
      id: 'resumes_created',
      label: 'Resumes created',
      group: 'resume',
      value: null,
      status: statusFromFailure(resumes.reason),
      note: noteFromFailure('resumes', resumes.reason, resumes.detail),
    })
  }

  if (aiUsage.ok) {
    if (aiUsage.truncated) diagnostics.cut('resume_ai_usage')
    // The Personal Statement Analyzer's abuse ledger shares this table --
    // `resume_id` is nullable and `operation` is free text, so Phase 0 of that
    // feature's hardening could add a rate limit without a migration. Its rows
    // carry a `statement-` prefix and are excluded here, so "Resume AI actions"
    // keeps meaning resume AI actions. One predicate, shared with the rate
    // check, so the two can never disagree about which rows are whose.
    // See lib/statement/usage.ts for why this arrangement is temporary.
    const resumeAiRows = aiUsage.rows.filter((row) => !isStatementOperation(row.operation))
    metrics.push({
      id: 'resume_ai_actions',
      label: 'Resume AI actions',
      group: 'resume',
      value: resumeAiRows.length,
      status: 'partial',
      note: 'Every attempt, including refusals. Recorded since 10 September 2026.',
      source: { label: 'resume_ai_usage' },
    })
    if (resumeAiRows.length > 0) {
      breakdowns.push(
        {
          id: 'resume_ai_operation',
          label: 'Resume AI by operation',
          group: 'resume',
          status: 'ok',
          source: { label: 'resume_ai_usage.operation' },
          rows: rank(countBy(resumeAiRows, (row) => row.operation)).map((row) => ({
            key: row.key,
            label: row.key,
            value: row.value,
          })),
        },
        {
          id: 'resume_ai_outcome',
          label: 'Resume AI by outcome',
          group: 'resume',
          status: 'ok',
          source: { label: 'resume_ai_usage.outcome' },
          rows: rank(countBy(resumeAiRows, (row) => row.outcome)).map((row) => ({
            key: row.key,
            label: row.key,
            value: row.value,
          })),
        }
      )
    }
  } else {
    diagnostics.note('resume_ai_usage', aiUsage.reason, aiUsage.detail)
  }

  if (imports.ok) {
    metrics.push({
      id: 'resume_imports',
      label: 'Resume imports',
      group: 'resume',
      value: imports.rows.length,
      status: 'partial',
      note: 'Recorded since 10 September 2026, and only for the V2 Studio.',
      source: { label: 'resume_imports' },
    })
    if (imports.rows.length > 0) {
      breakdowns.push({
        id: 'resume_import_outcome',
        label: 'Resume imports by outcome',
        group: 'resume',
        status: 'ok',
        source: { label: 'resume_imports.outcome' },
        rows: rank(countBy(imports.rows, (row) => row.outcome)).map((row) => ({
          key: row.key,
          label: row.key,
          value: row.value,
        })),
      })
    }
  } else {
    diagnostics.note('resume_imports', imports.reason, imports.detail)
  }

  metrics.push(
    notTracked(
      'resume_exports',
      'Resume exports (PDF/DOCX)',
      'Neither export route records anything. Needs a server-side event on each export.',
      'count',
      'resume'
    ),
    notTracked(
      'resume_export_blocked',
      'Export blocked by the paywall',
      'A Free or Premium member hitting the Ultimate export gate is refused without a record. Needs a server-side event.',
      'count',
      'resume'
    )
  )

  // -------------------------------------------------------- personal statement
  metrics.push(
    notTracked(
      'statement_analyses',
      'Personal statements analysed',
      'The analyzer persists nothing at all — no row, no counter. Needs a server-side event recording the outcome and tier, never the text.',
      'count',
      'statement'
    ),
    notTracked(
      'statement_rewrites',
      'AI rewrites generated',
      'Ultimate-only rewrites are not recorded either. Needs the same event.',
      'count',
      'statement'
    )
  )

  // ------------------------------------------------------------------- schools
  metrics.push(
    savedSchools.ok
      ? {
          id: 'schools_saved',
          label: 'Schools saved',
          group: 'schools',
          value: savedSchools.count,
          status: 'ok',
          note: 'Saves made in this window. Un-saving deletes the row, so the all-time view only shows what is still saved.',
          source: { label: 'saved_schools' },
        }
      : {
          id: 'schools_saved',
          label: 'Schools saved',
          group: 'schools',
          value: null,
          status: statusFromFailure(savedSchools.reason),
          note: noteFromFailure('saved_schools', savedSchools.reason, savedSchools.detail),
        },
    expedited.ok
      ? {
          id: 'expedited_requests',
          label: 'Expedited school requests',
          group: 'schools',
          value: expedited.count,
          status: 'ok',
          source: { label: 'expedited_requests' },
        }
      : {
          id: 'expedited_requests',
          label: 'Expedited school requests',
          group: 'schools',
          value: null,
          status: statusFromFailure(expedited.reason),
          note: noteFromFailure('expedited_requests', expedited.reason, expedited.detail),
        },
    notTracked(
      'directory_searches',
      'Directory searches and filters',
      'Search and filtering happen entirely in the browser and are never sent anywhere. Needs client events.',
      'count',
      'schools'
    ),
    notTracked(
      'school_page_views',
      'School pages viewed',
      'No page views are recorded anywhere on the site.',
      'count',
      'schools'
    )
  )
  if (!savedSchools.ok) diagnostics.note('saved_schools', savedSchools.reason, savedSchools.detail)
  if (!expedited.ok) diagnostics.note('expedited_requests', expedited.reason, expedited.detail)

  if (unlocks.ok) {
    const approved = unlocks.rows.filter((row) => (row.status ?? '') === 'approved')
    metrics.push(
      {
        id: 'unlock_requests',
        label: 'School unlock requests',
        group: 'schools',
        value: unlocks.rows.length,
        status: 'ok',
        source: { label: 'school_unlock_requests' },
        spark: countByBucket(unlocks.rows, (row) => row.requested_at, keys, range.bucket, range.timezone),
      },
      {
        id: 'unlock_approval_rate',
        label: 'Unlock requests approved',
        group: 'schools',
        value: percent(approved.length, unlocks.rows.length),
        unit: 'percent',
        status: 'ok',
        note: 'Of the requests made in this window, the share approved so far.',
        source: { label: 'school_unlock_requests.status' },
      }
    )

    const topSchools = rank(countBy(unlocks.rows, (row) => row.school_name)).slice(0, 8)
    if (topSchools.length > 0) {
      breakdowns.push({
        id: 'unlock_schools',
        label: 'Most requested schools',
        group: 'schools',
        status: 'ok',
        source: { label: 'school_unlock_requests.school_name' },
        rows: topSchools.map((row) => ({ key: row.key, label: row.key, value: row.value })),
      })
    }
  } else {
    diagnostics.note('school_unlock_requests', unlocks.reason, unlocks.detail)
  }

  return {
    section: 'product',
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
    series,
    breakdowns,
    funnels: [],
    diagnostics: diagnostics.finish(),
  }
}
