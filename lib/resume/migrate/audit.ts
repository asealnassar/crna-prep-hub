/**
 * The written record of a migration run.
 *
 * A migration that cannot be audited afterwards is a migration nobody can
 * defend. The locked decisions require that every inserted V2 id is logged
 * against its V1 id, that refusals name every duplicate row, and that the V1
 * source rows are demonstrably untouched. This module turns a plan and an
 * execution result into text that shows all three.
 *
 * Pure. It formats what it is given and reads nothing, so an audit record can
 * be produced from a rehearsal exactly as it is from a real run -- which is
 * what makes the rehearsal's output reviewable in advance.
 */

import type { ExecutionResult, MigrationPlan } from './writer.ts'

function rule(char = '-'): string {
  return char.repeat(78)
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width)
}

/**
 * The plan, before anything is written.
 *
 * Refusals come first and are printed in full. A plan is normally read by
 * somebody deciding whether to run it, and the resumes that will NOT migrate
 * are the only part of it that needs a decision.
 */
export function formatPlan(plan: MigrationPlan): string {
  const out: string[] = []
  out.push(rule('='))
  out.push('V1 -> V2 MIGRATION PLAN')
  out.push(rule('='))
  out.push('')
  out.push(`  source resumes      ${plan.counts.total}`)
  out.push(`  to insert           ${plan.counts.insert}`)
  out.push(`  to repair           ${plan.counts.repair}`)
  out.push(`  already migrated    ${plan.counts.skip}`)
  out.push(`  needs review        ${plan.counts.refuse}`)
  out.push(`  conflicts           ${plan.counts.conflict}`)
  out.push('')
  out.push(plan.clean
    ? '  CLEAN -- every source resume is writable or already done.'
    : '  NOT CLEAN -- resolve the entries below before the production run.')
  out.push('')

  const refusals = plan.jobs.filter((j) => j.kind === 'refuse')
  if (refusals.length > 0) {
    out.push(rule())
    out.push('NEEDS REVIEW -- no output is produced for these, by design')
    out.push(rule())
    for (const job of refusals) {
      if (job.kind !== 'refuse') continue
      out.push('')
      out.push(`  V1 resume ${job.v1ResumeId}`)
      for (const reason of job.reasons) {
        out.push(`    - ${reason.kind}: ${reason.detail}`)
        if (reason.kind === 'duplicate-section') {
          // Every row id, so a person can look at all of them and decide.
          for (const rowId of reason.rowIds) out.push(`        row ${rowId}`)
        }
      }
    }
    out.push('')
  }

  const conflicts = plan.jobs.filter((j) => j.kind === 'conflict')
  if (conflicts.length > 0) {
    out.push(rule())
    out.push('CONFLICTS -- the target contradicts the source; nothing was assumed')
    out.push(rule())
    for (const job of conflicts) {
      if (job.kind !== 'conflict') continue
      out.push(`  V1 resume ${job.v1ResumeId}`)
      out.push(`    ${job.detail}`)
    }
    out.push('')
  }

  const repairs = plan.jobs.filter((j) => j.kind === 'repair')
  if (repairs.length > 0) {
    out.push(rule())
    out.push('REPAIRS -- a previous run left these parents without sections')
    out.push(rule())
    for (const job of repairs) {
      if (job.kind !== 'repair') continue
      out.push(`  ${job.v1ResumeId} -> ${job.v2ResumeId}  (${job.sectionRows.length} sections)`)
    }
    out.push('')
  }

  const notes = plan.jobs.flatMap((j) =>
    j.kind === 'insert' || j.kind === 'repair' || j.kind === 'refuse'
      ? j.notes.map((n) => ({ v1: j.v1ResumeId, ...n }))
      : []
  )
  if (notes.length > 0) {
    out.push(rule())
    out.push(`NOTES (${notes.length}) -- legacy data reported, never corrected`)
    out.push(rule())
    const byKind = new Map<string, number>()
    for (const note of notes) byKind.set(note.kind, (byKind.get(note.kind) ?? 0) + 1)
    for (const [kind, count] of [...byKind.entries()].sort()) {
      out.push(`  ${pad(kind, 28)} ${count}`)
    }
    out.push('')
  }

  return out.join('\n')
}

/**
 * The result, after a run -- rehearsal or real.
 *
 * The id table is the point of this document. It is what lets someone a month
 * later answer "where did this resume come from" and "what did the migration
 * create", and it is what a rollback would be driven from.
 */
export function formatExecution(
  result: ExecutionResult,
  meta: { readonly applied: boolean; readonly target: string; readonly startedAt: string }
): string {
  const out: string[] = []
  out.push(rule('='))
  out.push(meta.applied ? 'V1 -> V2 MIGRATION RUN' : 'V1 -> V2 MIGRATION REHEARSAL (nothing written)')
  out.push(rule('='))
  out.push('')
  out.push(`  target              ${meta.target}`)
  out.push(`  started             ${meta.startedAt}`)
  out.push(`  applied             ${meta.applied ? 'YES' : 'no -- rehearsal only'}`)
  out.push('')
  const deleted = result.results.filter(
    (r) => r.kind === 'skipped' && r.reason === 'deleted-by-owner'
  ).length
  out.push(`  written             ${result.counts.written}`)
  out.push(`  repaired            ${result.counts.repaired}`)
  out.push(`  skipped             ${result.counts.skipped}`)
  if (deleted > 0) {
    out.push(`    of which deleted  ${deleted}  (migrated once, then deleted by the owner)`)
  }
  out.push(`  refused             ${result.counts.refused}`)
  out.push(`  failed              ${result.counts.failed}`)
  out.push(`  incomplete          ${result.counts.incomplete}`)
  out.push('')
  out.push(`  RESULT: ${result.ok ? 'OK' : 'NOT OK -- see below before doing anything else'}`)
  out.push('')

  const bad = result.results.filter((r) => r.kind === 'failed' || r.kind === 'incomplete')
  if (bad.length > 0) {
    out.push(rule())
    out.push('PROBLEMS')
    out.push(rule())
    for (const entry of bad) {
      if (entry.kind === 'failed') {
        // A failed claim wrote nothing at all, so there is nothing to clean up.
        out.push(`  FAILED     ${entry.v1ResumeId}  at ${entry.stage}: ${entry.detail}`)
        out.push('             Nothing was written for this resume. Re-running starts it cleanly.')
      } else if (entry.kind === 'incomplete') {
        out.push(`  INCOMPLETE ${entry.v1ResumeId} -> ${entry.v2ResumeId}  (stopped at ${entry.stage})`)
        out.push(`             ${entry.detail}`)
        out.push('             The ledger holds an unfinished claim. Re-run to finish it; do NOT')
        out.push('             delete the link or the resume by hand -- the claim is what makes')
        out.push('             the repair land on the same ids.')
      }
    }
    out.push('')
  }

  out.push(rule())
  out.push(`ID MAP (${result.links.length}) -- every V2 row and the V1 row it came from`)
  out.push(rule())
  out.push(`  ${pad('V1 RESUME', 38)}${pad('V2 RESUME', 38)}`)
  for (const link of result.links) {
    out.push(`  ${pad(link.v1ResumeId, 38)}${pad(link.v2ResumeId, 38)}`)
  }
  out.push('')
  out.push('  V1 source rows were not read for update, modified or deleted by this run.')

  const deletedRows = result.results.filter(
    (r) => r.kind === 'skipped' && r.reason === 'deleted-by-owner'
  )
  if (deletedRows.length > 0) {
    out.push('')
    out.push(rule())
    out.push('DELETED BY OWNER -- migrated once, removed since. Not recreated.')
    out.push(rule())
    for (const entry of deletedRows) {
      if (entry.kind !== 'skipped') continue
      out.push(`  ${pad(entry.v1ResumeId, 38)}${pad(entry.v2ResumeId, 38)}`)
    }
    out.push('')
    out.push('  These are not errors. The ledger records the migration as finished, so the')
    out.push('  absence of the resume is the applicant\'s own deletion, and re-running must')
    out.push('  not undo it.')
  }
  out.push('')

  return out.join('\n')
}
