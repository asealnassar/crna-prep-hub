/**
 * The offline V1 -> V2 migration writer.
 *
 * Phase 11 built the mapper: V1 rows in, a ResumeV2 out, pure and offline.
 * This is the part that decides what to WRITE, and it is split in two on
 * purpose:
 *
 *   planMigration()    pure. Produces one job per V1 resume and nothing else.
 *                      Given the same inputs it produces the same plan, so a
 *                      plan can be reviewed before anything is executed.
 *
 *   executeMigration() takes a PORT (MigrationTarget below), not a database
 *                      client. This module imports no Supabase, holds no
 *                      credentials and has no way to reach a network. The
 *                      privileged connection lives in scripts/, which the Next
 *                      build never reaches. See writer.test.ts, which asserts
 *                      that rather than trusting it.
 *
 * WHY NOT create_resume_v2. The obvious move is to reuse the atomic create RPC
 * the app uses, and it cannot work here. That function is SECURITY INVOKER and
 * takes ownership from auth.uid(); an offline process has no session, so
 * auth.uid() is null and every call returns 'not-authenticated'. Even under a
 * service-role connection it would be wrong rather than merely blocked: it can
 * only ever create resumes for the CALLER, and this writer has to create rows
 * for 17 different owners. Ownership therefore comes from the V1 source row and
 * from nowhere else -- assertOwnership() below refuses to build a job whose
 * user_id did not come from the row being migrated.
 *
 * ONLY INSERTS. There is no update, no delete and no upsert in this file, and a
 * test greps for all three. A V1 row is never modified: it is the rollback
 * record for the entire cutover, and a migration that can write to its own
 * source is a migration that can destroy what it was meant to preserve.
 *
 * NO TRANSACTION ENVELOPE, SO THE LEDGER CARRIES THE STATE. PostgREST gives
 * each HTTP call its own transaction, so the link, the parent and the sections
 * cannot be written atomically from outside the database. Rather than
 * compensate with a delete -- the one write this file must not contain -- the
 * order is chosen so that every interruption is recoverable:
 *
 *   1. insert the link          claims this V1 resume; the primary key on
 *                               v1_resume_id makes a second claim impossible
 *   2. insert the resume parent
 *   3. insert the sections
 *   4. stamp completed_at       the migration is now a finished fact
 *
 * A run that stops anywhere in 1-3 leaves a link with a null completed_at, and
 * the next run finishes exactly the part that is missing. Section ids are
 * derived deterministically from the V1 id, so a repair produces precisely the
 * rows the interrupted run intended.
 *
 * WHAT HAPPENS IF SOMEONE DELETES A MIGRATED RESUME. Nothing. A link whose
 * completed_at is set is a closed fact: the migration happened, and what the
 * applicant did afterwards is theirs to have done. The writer skips it and
 * reports it as deleted-by-owner. This is the reason completed_at exists --
 * without it, "the run stopped before writing the resume" and "the owner
 * deleted the resume afterwards" are the same observation, and the writer
 * would resurrect data somebody deliberately removed.
 */

import { createHash } from 'node:crypto'
import { mapV1Resume } from './mapV1.ts'
import type {
  MapOutcome, MigrationNote, ReviewReason, V1ResumeRow, V1SectionRow,
} from './mapV1.ts'
import { toSavePayload } from '../repo/rows.ts'
import { V2_SCHEMA_VERSION } from '../repo/rows.ts'
import type { ResumeV2 } from '../model/types.ts'

// ---------------------------------------------------------------------------
// What already exists on the target
// ---------------------------------------------------------------------------

/**
 * One row of public.resume_v1_migration_links, joined with what currently
 * exists for it.
 *
 * `completed` and `resumeExists` are read separately and mean different things:
 * completed is what the LEDGER says happened, resumeExists is what is true
 * NOW. Their disagreement is the deleted-by-owner case.
 */
export interface ExistingLink {
  readonly v1ResumeId: string
  readonly v2ResumeId: string
  readonly userId: string
  /** completed_at is not null: the migration is a closed fact. */
  readonly completed: boolean
  /** Whether the V2 resume row is present right now. */
  readonly resumeExists: boolean
  readonly sectionCount: number
}

/** The ledger row the writer claims before writing anything. */
export interface LinkRowValues {
  readonly v1_resume_id: string
  readonly v2_resume_id: string
  readonly user_id: string
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface ResumeRowValues {
  readonly id: string
  readonly user_id: string
  readonly title: string
  readonly template_id: string
  readonly status: string
  readonly schema_version: number
  readonly revision: number
  readonly created_at: string
  readonly updated_at: string
}

export type SectionRowValues = Record<string, unknown> & {
  readonly id: string
  readonly resume_id: string
  readonly section_type: string
}

export type MigrationJob =
  /** A V1 resume that maps cleanly and has never been claimed. */
  | {
      readonly kind: 'insert'
      readonly v1ResumeId: string
      readonly v2ResumeId: string
      readonly userId: string
      readonly link: LinkRowValues
      readonly resumeRow: ResumeRowValues
      readonly sectionRows: readonly SectionRowValues[]
      readonly notes: readonly MigrationNote[]
    }
  /**
   * Claimed by an earlier run that did not finish. Only the missing part is
   * written; `needsParent` and a possibly-empty sectionRows say which.
   */
  | {
      readonly kind: 'repair'
      readonly v1ResumeId: string
      readonly v2ResumeId: string
      readonly userId: string
      readonly needsParent: boolean
      readonly resumeRow: ResumeRowValues | null
      readonly sectionRows: readonly SectionRowValues[]
      readonly notes: readonly MigrationNote[]
    }
  /** A closed fact. Nothing is written, whatever the resume looks like now. */
  | {
      readonly kind: 'skip'
      readonly v1ResumeId: string
      readonly v2ResumeId: string
      readonly reason: 'already-migrated' | 'deleted-by-owner'
    }
  /** The mapper refused. A person resolves it; the writer never guesses. */
  | {
      readonly kind: 'refuse'
      readonly v1ResumeId: string
      readonly reasons: readonly ReviewReason[]
      readonly notes: readonly MigrationNote[]
    }
  /** Something about the ledger contradicts the source. Never written over. */
  | {
      readonly kind: 'conflict'
      readonly v1ResumeId: string
      readonly detail: string
    }

export interface MigrationPlan {
  readonly jobs: readonly MigrationJob[]
  readonly counts: {
    readonly total: number
    readonly insert: number
    readonly repair: number
    readonly skip: number
    readonly refuse: number
    readonly conflict: number
  }
  /**
   * True only when every V1 resume is either writable or already done. A plan
   * that is not clean may still be executed -- the refusals are simply not part
   * of it -- but the operator is told, and the go/no-go checklist requires
   * this to be true before the production run.
   */
  readonly clean: boolean
}

export interface PlanInput {
  readonly resumes: readonly V1ResumeRow[]
  readonly sections: readonly V1SectionRow[]
  /** Every row of resume_v1_migration_links, with its current state. */
  readonly existingLinks: readonly ExistingLink[]
  readonly now: string
  /** Deterministic. The same V1 id must always yield the same V2 ids. */
  readonly idFor: (v1ResumeId: string, index: number) => string
}

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

/**
 * A stable uuid derived from the V1 resume id and a position.
 *
 * Deterministic on purpose, and it is what makes both idempotency and repair
 * work: re-running produces the identical id for the identical input, so the
 * primary key on v1_resume_id rejects a duplicate claim and a repair rebuilds
 * the exact section ids the interrupted run intended.
 *
 * Shaped as a v5-style uuid (version nibble 5, RFC 4122 variant) so the value
 * is a legal uuid for the column. The namespace string is fixed and part of the
 * contract -- changing it would make every future run produce different ids.
 */
const ID_NAMESPACE = 'crnaprephub:resume-v1-migration'

export function deterministicId(v1ResumeId: string, index: number): string {
  const digest = createHash('sha1')
    .update(`${ID_NAMESPACE}:${v1ResumeId}:${index}`)
    .digest('hex')
  const v = `${digest.slice(0, 12)}5${digest.slice(13, 16)}`
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  const rest = `${variant}${digest.slice(17, 20)}${digest.slice(20, 32)}`
  const hex = `${v}${rest}`
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join('-')
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Ownership may come from exactly one place. */
function assertOwnership(resume: ResumeV2, row: V1ResumeRow): void {
  if (resume.userId !== row.user_id) {
    throw new Error(
      `refusing to build a job for V1 resume ${row.id}: mapped owner ` +
        `${resume.userId} is not the source owner ${row.user_id}`
    )
  }
}

/** Database rows for a mapped resume. Pure; nothing here touches a client. */
function rowsFor(
  resume: ResumeV2,
  row: V1ResumeRow,
  now: string
): { resumeRow: ResumeRowValues; sectionRows: SectionRowValues[] } {
  assertOwnership(resume, row)
  const payload = toSavePayload(resume)

  const sectionRows: SectionRowValues[] = payload.sections.map((section) => ({
    ...section,
    id: String(section.id),
    resume_id: resume.id,
    section_type: String(section.section_type),
    created_at: now,
    updated_at: now,
  }))

  return {
    resumeRow: {
      id: resume.id,
      // The source row, never the payload and never a session.
      user_id: row.user_id,
      title: resume.title,
      template_id: resume.template,
      // Locked: every migrated resume enters V2 as a draft.
      status: 'draft',
      schema_version: V2_SCHEMA_VERSION,
      revision: 1,
      // The applicant's own timestamps are preserved so their dashboard keeps
      // the order they remember. Only updated_at reflects the migration.
      created_at: resume.createdAt,
      updated_at: now,
    },
    sectionRows,
  }
}

export function planMigration(input: PlanInput): MigrationPlan {
  const byV1 = new Map<string, ExistingLink>()
  for (const link of input.existingLinks) byV1.set(link.v1ResumeId, link)

  const jobs: MigrationJob[] = []

  for (const row of input.resumes) {
    const link = byV1.get(row.id)

    // A ledger row naming a different owner than the source row is not evidence
    // that this resume was migrated. `authenticated` cannot write this table at
    // all, so reaching here means an earlier run or a bug produced it -- either
    // way it is a thing to report, never a reason to skip somebody's migration.
    if (link && link.userId !== row.user_id) {
      jobs.push({
        kind: 'conflict',
        v1ResumeId: row.id,
        detail:
          `the migration ledger links this V1 resume to ${link.v2ResumeId} for ` +
          `user ${link.userId}, but its owner is ${row.user_id}`,
      })
      continue
    }

    // A completed link is a closed fact. If the resume is gone now, its owner
    // deleted it after the migration, and recreating it would undo a decision
    // they made deliberately.
    if (link?.completed) {
      jobs.push({
        kind: 'skip',
        v1ResumeId: row.id,
        v2ResumeId: link.v2ResumeId,
        reason: link.resumeExists ? 'already-migrated' : 'deleted-by-owner',
      })
      continue
    }

    const mine = input.sections.filter((s) => s.resume_id === row.id)
    // `alreadyMigrated` is deliberately NOT passed: the skip decision is made
    // above, from the ledger, and letting the mapper decide it again from a
    // second source is how the two come to disagree.
    const outcome: MapOutcome = mapV1Resume(row, mine, {
      newResumeId: link ? link.v2ResumeId : input.idFor(row.id, 0),
      idPool: Array.from({ length: 400 }, (_, i) => input.idFor(row.id, i + 1)),
      now: input.now,
    })

    if (outcome.kind === 'already-migrated') {
      // Unreachable without alreadyMigrated, and stated rather than assumed.
      jobs.push({
        kind: 'skip', v1ResumeId: row.id,
        v2ResumeId: outcome.v2ResumeId, reason: 'already-migrated',
      })
      continue
    }

    if (outcome.kind === 'needs-review') {
      jobs.push({
        kind: 'refuse',
        v1ResumeId: row.id,
        reasons: outcome.reasons,
        notes: outcome.notes,
      })
      continue
    }

    const { resumeRow, sectionRows } = rowsFor(outcome.resume, row, input.now)

    if (link) {
      // Claimed but unfinished. Write only what is missing: re-inserting a row
      // that is already there would collide on its primary key and turn a
      // recoverable state into a failure.
      jobs.push({
        kind: 'repair',
        v1ResumeId: row.id,
        v2ResumeId: link.v2ResumeId,
        userId: row.user_id,
        needsParent: !link.resumeExists,
        resumeRow: link.resumeExists ? null : resumeRow,
        sectionRows: link.sectionCount > 0 ? [] : sectionRows,
        notes: outcome.notes,
      })
      continue
    }

    jobs.push({
      kind: 'insert',
      v1ResumeId: row.id,
      v2ResumeId: resumeRow.id,
      userId: row.user_id,
      link: {
        v1_resume_id: row.id,
        v2_resume_id: resumeRow.id,
        // From the V1 source row. The offline writer has no session to take it
        // from, and the payload is never allowed to name an owner.
        user_id: row.user_id,
      },
      resumeRow,
      sectionRows,
      notes: outcome.notes,
    })
  }

  const count = (kind: MigrationJob['kind']) => jobs.filter((j) => j.kind === kind).length
  const counts = {
    total: jobs.length,
    insert: count('insert'),
    repair: count('repair'),
    skip: count('skip'),
    refuse: count('refuse'),
    conflict: count('conflict'),
  }

  return { jobs, counts, clean: counts.refuse === 0 && counts.conflict === 0 }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * The only thing the writer may do to a database.
 *
 * Two methods, both inserts. There is no update, delete or query method, so an
 * implementation cannot be asked to modify anything -- the interface is the
 * enforcement, not a comment asking the implementer to behave.
 */
export interface MigrationTarget {
  /** Claims a V1 resume. The primary key makes a second claim impossible. */
  insertLink(row: LinkRowValues): Promise<{ ok: true } | { ok: false; detail: string }>
  insertResume(row: ResumeRowValues): Promise<{ ok: true } | { ok: false; detail: string }>
  insertSections(
    rows: readonly SectionRowValues[]
  ): Promise<{ ok: true } | { ok: false; detail: string }>
  /**
   * Stamps completed_at. The only write in the whole port that is not an
   * insert, and the grant behind it is column-scoped to completed_at alone, so
   * it cannot alter which resumes a ledger row names.
   */
  completeLink(v1ResumeId: string): Promise<{ ok: true } | { ok: false; detail: string }>
}

export type JobResult =
  | { readonly kind: 'written'; readonly v1ResumeId: string; readonly v2ResumeId: string; readonly sections: number }
  | { readonly kind: 'repaired'; readonly v1ResumeId: string; readonly v2ResumeId: string; readonly sections: number }
  | {
      readonly kind: 'skipped'; readonly v1ResumeId: string; readonly v2ResumeId: string
      readonly reason: 'already-migrated' | 'deleted-by-owner'
    }
  | { readonly kind: 'refused'; readonly v1ResumeId: string; readonly detail: string }
  /** Nothing was written for this resume. Re-running starts it cleanly. */
  | { readonly kind: 'failed'; readonly v1ResumeId: string; readonly stage: 'link'; readonly detail: string }
  /** Partly written and recorded. Re-running finishes it; never delete by hand. */
  | {
      readonly kind: 'incomplete'; readonly v1ResumeId: string; readonly v2ResumeId: string
      readonly stage: 'resume' | 'sections' | 'complete'; readonly detail: string
    }

export interface ExecutionResult {
  readonly results: readonly JobResult[]
  readonly counts: Record<JobResult['kind'], number>
  /** Every V1 id mapped to the V2 id it produced, for the audit record. */
  readonly links: readonly { readonly v1ResumeId: string; readonly v2ResumeId: string }[]
  readonly ok: boolean
}

export interface ExecuteOptions {
  /**
   * Nothing is written unless this is exactly true. The default is a rehearsal
   * that returns the results the run WOULD have produced, so the normal way to
   * invoke the writer is the safe way.
   */
  readonly apply?: boolean
  /** Stop at the first failure rather than continuing. Default true. */
  readonly stopOnError?: boolean
}

export async function executeMigration(
  target: MigrationTarget,
  plan: MigrationPlan,
  options: ExecuteOptions = {}
): Promise<ExecutionResult> {
  const apply = options.apply === true
  const stopOnError = options.stopOnError !== false
  const results: JobResult[] = []
  const links: { v1ResumeId: string; v2ResumeId: string }[] = []
  let halted = false

  for (const job of plan.jobs) {
    if (halted) break

    if (job.kind === 'skip') {
      results.push({
        kind: 'skipped', v1ResumeId: job.v1ResumeId,
        v2ResumeId: job.v2ResumeId, reason: job.reason,
      })
      links.push({ v1ResumeId: job.v1ResumeId, v2ResumeId: job.v2ResumeId })
      continue
    }

    if (job.kind === 'refuse' || job.kind === 'conflict') {
      const detail = job.kind === 'conflict'
        ? job.detail
        : job.reasons.map((r) => r.detail).join('; ')
      results.push({ kind: 'refused', v1ResumeId: job.v1ResumeId, detail })
      continue
    }

    const sectionCount = job.sectionRows.length
    const record = (kind: 'written' | 'repaired') => {
      results.push({
        kind, v1ResumeId: job.v1ResumeId, v2ResumeId: job.v2ResumeId, sections: sectionCount,
      })
      links.push({ v1ResumeId: job.v1ResumeId, v2ResumeId: job.v2ResumeId })
    }

    if (!apply) {
      record(job.kind === 'insert' ? 'written' : 'repaired')
      continue
    }

    // 1. Claim. Only an insert job claims; a repair already holds the link.
    if (job.kind === 'insert') {
      const claim = await target.insertLink(job.link)
      if (!claim.ok) {
        // Nothing has been written for this resume, so a failed claim is a
        // clean failure -- including the case where another run claimed it
        // first, which is exactly what the primary key is there to do.
        results.push({
          kind: 'failed', v1ResumeId: job.v1ResumeId, stage: 'link', detail: claim.detail,
        })
        if (stopOnError) halted = true
        continue
      }
    }

    // 2. The parent, unless a previous run already wrote it. An insert job
    //    always carries one; a repair carries null when the row is already there.
    if (job.resumeRow !== null) {
      const parent = await target.insertResume(job.resumeRow)
      if (!parent.ok) {
        results.push({
          kind: 'incomplete', v1ResumeId: job.v1ResumeId,
          v2ResumeId: job.v2ResumeId, stage: 'resume', detail: parent.detail,
        })
        if (stopOnError) halted = true
        continue
      }
    }

    // 3. The sections, in one statement so they land together or not at all.
    if (sectionCount > 0) {
      const sections = await target.insertSections(job.sectionRows)
      if (!sections.ok) {
        // The link is claimed and the parent may exist. Both stay: the ledger
        // records what was intended, so the next run finishes precisely the
        // part that is missing. Deleting them is the compensation this writer
        // must not perform, and does not need to.
        results.push({
          kind: 'incomplete', v1ResumeId: job.v1ResumeId,
          v2ResumeId: job.v2ResumeId, stage: 'sections', detail: sections.detail,
        })
        links.push({ v1ResumeId: job.v1ResumeId, v2ResumeId: job.v2ResumeId })
        if (stopOnError) halted = true
        continue
      }
    }

    // 4. Only now is the migration a finished fact.
    const done = await target.completeLink(job.v1ResumeId)
    if (!done.ok) {
      results.push({
        kind: 'incomplete', v1ResumeId: job.v1ResumeId,
        v2ResumeId: job.v2ResumeId, stage: 'complete', detail: done.detail,
      })
      links.push({ v1ResumeId: job.v1ResumeId, v2ResumeId: job.v2ResumeId })
      if (stopOnError) halted = true
      continue
    }

    record(job.kind === 'insert' ? 'written' : 'repaired')
  }

  const counts: Record<JobResult['kind'], number> = {
    written: 0, repaired: 0, skipped: 0, refused: 0, failed: 0, incomplete: 0,
  }
  for (const r of results) counts[r.kind] += 1

  return {
    results,
    counts,
    links,
    ok: counts.failed === 0 && counts.incomplete === 0 && !halted,
  }
}
