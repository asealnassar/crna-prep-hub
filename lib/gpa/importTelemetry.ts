/**
 * Private timing instrumentation for transcript imports.
 *
 * The point is to learn how long real analyses take, and how often the
 * automatic repair passes fire, without learning anything about the transcript
 * itself. So this records counts and durations only:
 *
 *   - never transcript text, course names, grades, institutions or file names
 *   - never a user id or anything else identifying
 *   - never an API key, model id or upstream fingerprint
 *
 * Token counts are numbers the analyzer already receives from the upstream
 * response, kept here so cost can be understood later. Nothing is sent
 * anywhere: records stay in memory for this page and are written to the
 * console as one structured line. Durable collection would be a storage
 * decision, and this task is not the place to make it.
 */

import type { FailureKind, ImportState } from './importProgress.ts'

export interface ImportMetrics {
  /** Wall-clock milliseconds from the start of analysis to success or failure. */
  durationMs: number
  /** Analyzer requests made, including the purposeful second pass. */
  attempts: number
  structuralRetry: boolean
  scaleRetry: boolean
  /** How far the pipeline got. */
  stage: ImportState['stage']
  outcome: 'success' | 'failure'
  failure: FailureKind | null
  destination: ImportState['destination']
  /** Courses imported, as a count. Never their content. */
  courses?: number
  /** Pages the document held, as a count. */
  pages?: number
  promptTokens?: number
  completionTokens?: number
}

export const TELEMETRY_PREFIX = 'gpa.import'

/** Builds the record. Pure, so what it contains is directly testable. */
export function importMetrics(
  state: ImportState,
  now: number,
  extra: { courses?: number; pages?: number; promptTokens?: number; completionTokens?: number } = {},
): ImportMetrics {
  const end = state.endedAt ?? now
  return {
    durationMs: state.startedAt === null ? 0 : Math.max(0, end - state.startedAt),
    attempts: state.attempts,
    structuralRetry: state.structuralRetry,
    scaleRetry: state.scaleRetry,
    stage: state.stage,
    outcome: state.phase === 'success' ? 'success' : 'failure',
    failure: state.phase === 'success' ? null : (state.failure ?? 'unknown'),
    destination: state.destination,
    ...(extra.courses !== undefined ? { courses: extra.courses } : {}),
    ...(extra.pages !== undefined ? { pages: extra.pages } : {}),
    ...(extra.promptTokens !== undefined ? { promptTokens: extra.promptTokens } : {}),
    ...(extra.completionTokens !== undefined ? { completionTokens: extra.completionTokens } : {}),
  }
}

/**
 * Every key this record is allowed to carry.
 *
 * Enforced by a test rather than by convention, so a later change that starts
 * attaching the file name or a course list fails loudly instead of quietly
 * shipping transcript content into a log line.
 */
export const ALLOWED_METRIC_KEYS = [
  'durationMs', 'attempts', 'structuralRetry', 'scaleRetry', 'stage', 'outcome',
  'failure', 'destination', 'courses', 'pages', 'promptTokens', 'completionTokens',
] as const

const recent: ImportMetrics[] = []
const KEEP = 20

/** Records one import. In-memory for this page, plus one structured log line. */
export function recordImport(metrics: ImportMetrics): ImportMetrics {
  recent.push(metrics)
  if (recent.length > KEEP) recent.shift()
  try {
    console.info(TELEMETRY_PREFIX, JSON.stringify(metrics))
  } catch {
    /* logging must never break an import */
  }
  return metrics
}

export function recentImports(): readonly ImportMetrics[] {
  return recent
}

export function clearImports(): void {
  recent.length = 0
}
