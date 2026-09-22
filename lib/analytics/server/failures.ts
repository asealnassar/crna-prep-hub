import type { MetricStatus } from '../types'
import type { ReadFailure } from './reader'

/**
 * Turning a failed read into something the page can say out loud.
 *
 * The distinction that matters: a table this server is FORBIDDEN to read needs
 * a migration, while a table that does not exist needs instrumentation. Both
 * are different from a query that broke. None of them is zero.
 */

export function statusFromFailure(reason: ReadFailure): MetricStatus {
  if (reason === 'denied') return 'needs_migration'
  if (reason === 'missing') return 'not_tracked'
  return 'error'
}

export function noteFromFailure(table: string, reason: ReadFailure, detail: string): string {
  if (reason === 'denied') {
    return `The dashboard cannot read ${table}: its privileges were deliberately revoked from the server role. Reading it needs a small read-only database function.`
  }
  if (reason === 'missing') {
    return `${table} does not exist in this database, or lacks the column this counts.`
  }
  return `Reading ${table} failed: ${detail}`
}

/** Collects what a section could not read, for the panel at the foot of it. */
export class Diagnostics {
  private readonly startedAt = Date.now()
  readonly truncated: string[] = []
  readonly failed: { source: string; reason: string }[] = []

  note(source: string, reason: ReadFailure, detail: string): void {
    this.failed.push({ source, reason: noteFromFailure(source, reason, detail) })
  }

  cut(source: string): void {
    this.truncated.push(source)
  }

  finish() {
    return { truncated: this.truncated, failed: this.failed, durationMs: Date.now() - this.startedAt }
  }
}
