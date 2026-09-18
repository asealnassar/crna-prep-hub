/**
 * The one-off PRODUCTION V1 -> V2 resume migration runner.
 *
 *   node --env-file=.env.local scripts/migrate-v1-resumes-production.ts
 *       rehearsal. Reads production, writes absolutely nothing.
 *
 *   RESUME_PRODUCTION_MIGRATION_CONFIRM=<production ref> \
 *   node --env-file=.env.local scripts/migrate-v1-resumes-production.ts --apply
 *       writes.
 *
 * Both forms also require RESUME_MIGRATION_TARGET=production.
 *
 * WHY THIS FILE EXISTS SEPARATELY. scripts/migrate-v1-resumes.ts is
 * staging-only and stays that way: the guard behind it (lib/resume/migrate/
 * target.ts) refuses the production project by identity, and the integration
 * suite -- which deletes rows and rewrites subscription_tier -- depends on that
 * refusal being absolute rather than conditional. Teaching that script a
 * production mode would put the escape hatch inside the control. So the
 * staging runner is untouched, and this is its counterpart for one controlled
 * cutover, guarded by lib/resume/migrate/productionTarget.ts, which refuses
 * every project EXCEPT production.
 *
 * The duplication of readV1/readLinks/targetFor below is deliberate and is the
 * price of that separation: it means the staging runner is provably unmodified
 * rather than merely believed to be. All the logic that decides anything --
 * planMigration, executeMigration, deterministicId, the V1 mapper and the
 * audit formatting -- is imported from the tested modules and is identical for
 * both runners.
 *
 * WHAT THIS SCRIPT MAY DO. Four SELECTs, two INSERTs and one column-scoped
 * UPDATE of resume_v1_migration_links.completed_at. There is no update or
 * delete of any resume or section anywhere in it, and the port handed to the
 * writer cannot express one.
 *
 * WHAT IT WILL NOT TOUCH. Production holds three standalone V2 resumes that
 * belong to test accounts and are not migration output. They are excluded
 * three times over: the V1 read filters them out by schema_version, the two
 * sets are asserted disjoint, and every planned V2 id is checked against the
 * ids that already exist before anything is executed.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deterministicId, executeMigration, planMigration } from '../lib/resume/migrate/writer.ts'
import type {
  ExistingLink, LinkRowValues, MigrationPlan, MigrationTarget, ResumeRowValues, SectionRowValues,
} from '../lib/resume/migrate/writer.ts'
import type { V1ResumeRow, V1SectionRow } from '../lib/resume/migrate/mapV1.ts'
import { formatExecution, formatPlan } from '../lib/resume/migrate/audit.ts'
import { requireProductionTarget } from '../lib/resume/migrate/productionTarget.ts'

// ---------------------------------------------------------------------------
// Guards, before anything is connected
// ---------------------------------------------------------------------------

function requireEnv(...names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim() !== '') return value.trim()
  }
  console.error(`FATAL: none of ${names.join(', ')} is set.`)
  process.exit(1)
}

/**
 * WHICH DATABASE THIS MAY TOUCH is not decided here.
 *
 * requireProductionTarget() refuses unless the target is named `production`,
 * the shell carries no staging configuration, the URL parses, both URL names
 * agree if both are set, and the project is exactly the known production ref.
 * It also decides `apply`, which additionally needs --apply AND the confirm
 * variable set to that same ref. It exits before this returns if any of that
 * fails.
 *
 * It hands back only safe identifiers. The credentials are read here,
 * separately, and never leave this file.
 */
function guards(): { host: string; url: string; key: string; apply: boolean } {
  const { host, apply } = requireProductionTarget()

  // A production shell carries NEXT_PUBLIC_SUPABASE_URL; SUPABASE_URL is
  // accepted first for an operator who sets it explicitly. The guard above has
  // already proved whichever one is used names the production project.
  const url = requireEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  return { host, url, key, apply }
}

// ---------------------------------------------------------------------------
// Reading the source
// ---------------------------------------------------------------------------

const V1_RESUME_COLUMNS = 'id, user_id, title, template_id, created_at, updated_at, is_published, overall_score'
const V1_SECTION_COLUMNS = 'id, resume_id, section_type, section_data, order_index'

async function readV1(db: SupabaseClient): Promise<{ resumes: V1ResumeRow[]; sections: V1SectionRow[] }> {
  // Legacy rows only. This is the first of the three things that keep the
  // standalone V2 resumes out of the migration entirely.
  const { data: resumes, error: resumeError } = await db
    .from('resumes')
    .select(V1_RESUME_COLUMNS)
    .or('schema_version.is.null,schema_version.eq.1')
    .order('created_at')
  if (resumeError) throw new Error(`reading V1 resumes: ${resumeError.message}`)

  const ids = (resumes ?? []).map((r) => (r as { id: string }).id)
  if (ids.length === 0) return { resumes: [], sections: [] }

  const { data: sections, error: sectionError } = await db
    .from('resume_sections')
    .select(V1_SECTION_COLUMNS)
    .in('resume_id', ids)
    .order('order_index')
  if (sectionError) throw new Error(`reading V1 sections: ${sectionError.message}`)

  return {
    resumes: (resumes ?? []) as unknown as V1ResumeRow[],
    sections: (sections ?? []) as unknown as V1SectionRow[],
  }
}

/** The ids of every V2 resume that already exists, migration output or not. */
async function readExistingV2Ids(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from('resumes').select('id').eq('schema_version', 2)
  if (error) throw new Error(`reading existing V2 resumes: ${error.message}`)
  return ((data ?? []) as unknown as { id: string }[]).map((r) => r.id)
}

/**
 * The migration ledger, joined with what currently exists for each row.
 *
 * Three separate reads because they answer three different questions: what the
 * ledger says happened, whether the V2 resume is there now, and whether its
 * sections are. Only their combination distinguishes an interrupted run from a
 * resume its owner deleted afterwards.
 */
async function readLinks(db: SupabaseClient): Promise<ExistingLink[]> {
  const { data, error } = await db
    .from('resume_v1_migration_links')
    .select('v1_resume_id, v2_resume_id, user_id, completed_at')
  if (error) throw new Error(`reading the migration ledger: ${error.message}`)

  const rows = (data ?? []) as unknown as {
    v1_resume_id: string; v2_resume_id: string; user_id: string; completed_at: string | null
  }[]
  if (rows.length === 0) return []

  const v2Ids = rows.map((r) => r.v2_resume_id)

  const { data: present, error: presentError } = await db
    .from('resumes').select('id').in('id', v2Ids)
  if (presentError) throw new Error(`checking migrated resumes: ${presentError.message}`)
  const exists = new Set(((present ?? []) as unknown as { id: string }[]).map((r) => r.id))

  const { data: counts, error: countError } = await db
    .from('resume_sections').select('resume_id').in('resume_id', v2Ids)
  if (countError) throw new Error(`counting migrated sections: ${countError.message}`)
  const tally = new Map<string, number>()
  for (const row of (counts ?? []) as unknown as { resume_id: string }[]) {
    tally.set(row.resume_id, (tally.get(row.resume_id) ?? 0) + 1)
  }

  return rows.map((row) => ({
    v1ResumeId: row.v1_resume_id,
    v2ResumeId: row.v2_resume_id,
    userId: row.user_id,
    completed: row.completed_at !== null,
    resumeExists: exists.has(row.v2_resume_id),
    sectionCount: tally.get(row.v2_resume_id) ?? 0,
  }))
}

// ---------------------------------------------------------------------------
// The standalone V2 resumes stay standalone
// ---------------------------------------------------------------------------

/**
 * Refuses if the migration could reach a V2 row that is not its own output.
 *
 * Two disjointness checks, both cheap and both fatal:
 *
 *   1. nothing read as a V1 source is also a V2 row -- proves the
 *      schema_version filter did what it says;
 *   2. no id this plan intends to CREATE already exists -- deterministicId is
 *      derived from the V1 id, so a collision with one of the standalone test
 *      resumes is astronomically unlikely and would be catastrophic, which is
 *      exactly the ratio that deserves an assertion rather than a comment.
 *
 * Checked before execution even in a rehearsal, so the go/no-go decision is
 * made on a plan that has already been proved safe.
 */
function assertStandaloneV2Untouched(
  plan: MigrationPlan,
  v1Ids: readonly string[],
  existingV2Ids: readonly string[]
): void {
  const existing = new Set(existingV2Ids)

  const overlap = v1Ids.filter((id) => existing.has(id))
  if (overlap.length > 0) {
    throw new Error(
      `${overlap.length} row(s) were read as V1 sources but are V2 resumes. ` +
      'Refusing: the schema_version filter did not hold.'
    )
  }

  const planned: string[] = []
  for (const job of plan.jobs) {
    if (job.kind === 'insert') planned.push(job.v2ResumeId)
    else if (job.kind === 'repair' && job.needsParent) planned.push(job.v2ResumeId)
  }
  const collisions = planned.filter((id) => existing.has(id))
  if (collisions.length > 0) {
    throw new Error(
      `${collisions.length} planned V2 id(s) already exist: ${collisions.join(', ')}. ` +
      'Refusing: this run would write over a resume it did not create.'
    )
  }
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Two inserts and one column-scoped completion, and nothing else is reachable
 * through this object. The writer holds only this, so the writer cannot modify
 * a resume or a section even if it tried to.
 */
function targetFor(db: SupabaseClient): MigrationTarget {
  const outcome = (error: { code?: string; message?: string } | null) =>
    error ? { ok: false as const, detail: `${error.code ?? ''} ${error.message}`.trim() } : { ok: true as const }

  return {
    async insertLink(row: LinkRowValues) {
      const { error } = await db.from('resume_v1_migration_links').insert(row)
      return outcome(error)
    },
    async insertResume(row: ResumeRowValues) {
      const { error } = await db.from('resumes').insert(row)
      return outcome(error)
    },
    async insertSections(rows: readonly SectionRowValues[]) {
      if (rows.length === 0) return { ok: true as const }
      // One statement, so the sections of a resume land together or not at all.
      const { error } = await db.from('resume_sections').insert(rows as SectionRowValues[])
      return outcome(error)
    },
    async completeLink(v1ResumeId: string) {
      // The only non-insert write in the script. The grant behind it is scoped
      // to the completed_at column, so this cannot rewrite which resumes the
      // ledger row names even if this code tried to.
      const { error } = await db
        .from('resume_v1_migration_links')
        .update({ completed_at: new Date().toISOString() })
        .eq('v1_resume_id', v1ResumeId)
      return outcome(error)
    },
  }
}

// ---------------------------------------------------------------------------
// The rehearsal report
// ---------------------------------------------------------------------------

/**
 * What the plan intends to write, and everything the mapper wanted a person to
 * know. formatPlan() covers the counts and prints refusals in full; this adds
 * the two row totals the go/no-go needs and the per-resume notes, which are
 * reported and never acted on.
 */
function formatIntent(plan: MigrationPlan, existingV2Ids: readonly string[]): string {
  const out: string[] = []
  let parents = 0
  let sections = 0
  for (const job of plan.jobs) {
    if (job.kind === 'insert') { parents += 1; sections += job.sectionRows.length }
    else if (job.kind === 'repair') {
      if (job.needsParent) parents += 1
      sections += job.sectionRows.length
    }
  }

  out.push('='.repeat(78))
  out.push('WHAT WOULD BE WRITTEN')
  out.push('='.repeat(78))
  out.push('')
  out.push(`  V2 parent rows       ${parents}`)
  out.push(`  V2 section rows      ${sections}`)
  out.push(`  ledger rows          ${parents}`)
  out.push('')
  out.push(`  pre-existing V2 resumes left untouched   ${existingV2Ids.length}`)
  out.push('')

  const withNotes = plan.jobs.filter(
    (j) => (j.kind === 'insert' || j.kind === 'repair' || j.kind === 'refuse') && j.notes.length > 0
  )
  out.push('-'.repeat(78))
  out.push(`MAPPING NOTES -- reported, never acted on (${withNotes.length} of ${plan.counts.total} resumes)`)
  out.push('-'.repeat(78))
  if (withNotes.length === 0) {
    out.push('')
    out.push('  None. Every V1 resume mapped without a single note.')
  }
  for (const job of withNotes) {
    if (job.kind !== 'insert' && job.kind !== 'repair' && job.kind !== 'refuse') continue
    out.push('')
    out.push(`  V1 ${job.v1ResumeId}  (${job.kind})`)
    for (const note of job.notes) out.push(`    - ${note.kind} @ ${note.path}: ${note.detail}`)
  }
  out.push('')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { host, url, key, apply } = guards()
  const startedAt = new Date().toISOString()

  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log(`${apply ? 'APPLYING to' : 'Rehearsing against'} ${host}\n`)

  const { resumes, sections } = await readV1(db)
  const existingLinks = await readLinks(db)
  const existingV2Ids = await readExistingV2Ids(db)

  console.log('-'.repeat(78))
  console.log('SOURCE STATE')
  console.log('-'.repeat(78))
  console.log(`  V1 resumes discovered          ${resumes.length}`)
  console.log(`  V1 sections discovered         ${sections.length}`)
  console.log(`  existing migration links       ${existingLinks.length}`)
  console.log(`  of those, completed            ${existingLinks.filter((l) => l.completed).length}`)
  console.log(`  pre-existing V2 resumes        ${existingV2Ids.length}  (not migration output)`)
  console.log('')

  const plan = planMigration({
    resumes, sections, existingLinks, now: startedAt, idFor: deterministicId,
  })

  assertStandaloneV2Untouched(plan, resumes.map((r) => r.id), existingV2Ids)

  console.log(formatPlan(plan))
  console.log(formatIntent(plan, existingV2Ids))

  if (apply && !plan.clean) {
    console.error(
      'REFUSING TO APPLY: the plan is not clean.\n' +
      'Resolve every NEEDS REVIEW and CONFLICT entry above first. Nothing was written.'
    )
    process.exit(2)
  }

  const result = await executeMigration(targetFor(db), plan, { apply })
  console.log(formatExecution(result, { applied: apply, target: host, startedAt }))

  if (!apply) {
    console.log(
      'This was a REHEARSAL against production. Nothing was written.\n' +
      'To write: set RESUME_PRODUCTION_MIGRATION_CONFIRM to the production ' +
      'project ref and re-run with --apply.\n'
    )
  }
  process.exit(result.ok ? 0 : 3)
}

main().catch((error: unknown) => {
  console.error('FATAL:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
