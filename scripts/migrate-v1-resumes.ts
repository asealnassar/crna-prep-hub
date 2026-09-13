/**
 * The offline V1 -> V2 resume migration runner.
 *
 *   node scripts/migrate-v1-resumes.ts            # rehearsal, writes nothing
 *   node scripts/migrate-v1-resumes.ts --apply    # writes
 *
 * THIS FILE IS NOT PART OF THE APPLICATION. Nothing under app/ or components/
 * imports it, the Next build never reaches it, and lib/resume/migrate/writer.ts
 * -- which holds all the logic -- has no database client of its own. This is
 * the only file in the repository that combines migration code with a
 * privileged connection, which is why the connection is built here, once,
 * behind the guards below, and passed in as a two-method port.
 *
 * WHY A PRIVILEGED CONNECTION IS GENUINELY REQUIRED, rather than convenient.
 * The writer has to create resumes for sixteen different owners. Every ordinary
 * path is scoped to one caller:
 *
 *   create_resume_v2   SECURITY INVOKER, ownership from auth.uid(). An offline
 *                      process has no session, so auth.uid() is null and the
 *                      function returns 'not-authenticated'. Even with a
 *                      session it could only ever create resumes for that one
 *                      user.
 *   the anon key + a user JWT
 *                      would need a valid access token per owner. Minting
 *                      sixteen would mean handling other people's sessions,
 *                      which is exactly what staging is not allowed to hold.
 *   RLS relaxation     would weaken the running application to serve a
 *                      one-off script. Explicitly ruled out.
 *
 * So: the service role, used by one script, for INSERTs only. The app's RLS is
 * untouched, and none of the six V2 routes contains a service-role client.
 *
 * WHAT THIS SCRIPT MAY DO. Two INSERTs and two SELECTs -- the selects read the
 * V1 rows to migrate and the existing migration links. There is no update, no
 * delete and no upsert anywhere in it, and the port it hands the writer cannot
 * express one.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deterministicId, executeMigration, planMigration } from '../lib/resume/migrate/writer.ts'
import type {
  ExistingLink, LinkRowValues, MigrationTarget, ResumeRowValues, SectionRowValues,
} from '../lib/resume/migrate/writer.ts'
import type { V1ResumeRow, V1SectionRow } from '../lib/resume/migrate/mapV1.ts'
import { formatExecution, formatPlan } from '../lib/resume/migrate/audit.ts'
import { requireStagingTarget } from '../lib/resume/migrate/target.ts'

// ---------------------------------------------------------------------------
// Guards, before anything is connected
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    console.error(`FATAL: ${name} is not set.`)
    process.exit(1)
  }
  return value.trim()
}

/**
 * WHICH DATABASE THIS MAY TOUCH is not decided here.
 *
 * requireStagingTarget() is the single shared guard, used identically by
 * lib/resume/migrate/integration.test.ts. It refuses unless the target is named
 * `staging`, the staging project is named explicitly, the URL is exactly that
 * project, the project is not production, and the shell carries no production
 * URL or production-only secrets. It exits before this function returns if any
 * of that fails.
 *
 * It hands back only safe identifiers -- the ref and the host. The credentials
 * are read here, separately, and never leave this file.
 */
function guards(): { target: string; url: string; key: string; apply: boolean } {
  const { host } = requireStagingTarget()

  const url = requireEnv('SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')

  const apply = process.argv.includes('--apply')
  return { target: host, url, key, apply }
}

// ---------------------------------------------------------------------------
// Reading the source
// ---------------------------------------------------------------------------

const V1_RESUME_COLUMNS = 'id, user_id, title, template_id, created_at, updated_at, is_published, overall_score'
const V1_SECTION_COLUMNS = 'id, resume_id, section_type, section_data, order_index'

async function readV1(db: SupabaseClient): Promise<{ resumes: V1ResumeRow[]; sections: V1SectionRow[] }> {
  // Legacy rows only. Without this the script would try to migrate the rows it
  // created on a previous run.
  const { data: resumes, error: resumeError } = await db
    .from('resumes')
    .select(V1_RESUME_COLUMNS)
    .or('schema_version.is.null,schema_version.eq.1')
    .order('created_at')
  if (resumeError) throw new Error(`reading V1 resumes: ${resumeError.message}`)

  const ids = (resumes ?? []).map((r) => (r as { id: string }).id)
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
// The port
// ---------------------------------------------------------------------------

/**
 * Two inserts, and nothing else is reachable through this object. The writer
 * holds only this, so the writer cannot modify a row even if it tried to.
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
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { target, url, key, apply } = guards()
  const startedAt = new Date().toISOString()

  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  console.log(`Reading V1 data from ${target} ...`)
  const { resumes, sections } = await readV1(db)
  const existingLinks = await readLinks(db)
  console.log(`  ${resumes.length} V1 resumes, ${sections.length} sections, ${existingLinks.length} existing links\n`)

  const plan = planMigration({
    resumes, sections, existingLinks, now: startedAt, idFor: deterministicId,
  })
  console.log(formatPlan(plan))

  if (apply && !plan.clean) {
    console.error(
      'REFUSING TO APPLY: the plan is not clean.\n' +
      'Resolve every NEEDS REVIEW and CONFLICT entry above first. Nothing was written.'
    )
    process.exit(2)
  }

  const result = await executeMigration(targetFor(db), plan, { apply })
  console.log(formatExecution(result, { applied: apply, target, startedAt }))

  if (!apply) {
    console.log('This was a rehearsal. Re-run with --apply to write.\n')
  }
  process.exit(result.ok ? 0 : 3)
}

main().catch((error: unknown) => {
  console.error('FATAL:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
