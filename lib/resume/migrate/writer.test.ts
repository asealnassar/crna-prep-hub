import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  deterministicId, executeMigration, planMigration,
} from './writer.ts'
import type {
  ExistingLink, LinkRowValues, MigrationJob, MigrationTarget,
  ResumeRowValues, SectionRowValues,
} from './writer.ts'
import { duplicateSectionRow, v1Fixtures, RESUME_COUNT } from './fixtures.ts'

const NOW = '2026-09-11T12:00:00.000Z'
const plan = (over: Parameters<typeof v1Fixtures>[0] = {}, existingLinks: ExistingLink[] = []) => {
  const { resumes, sections } = v1Fixtures(over)
  return planMigration({ resumes, sections, existingLinks, now: NOW, idFor: deterministicId })
}

const jobsOf = <K extends MigrationJob['kind']>(p: ReturnType<typeof plan>, kind: K) =>
  p.jobs.filter((j): j is Extract<MigrationJob, { kind: K }> => j.kind === kind)

/** The ledger a completed run would have left behind. */
const ledgerAfter = (p: ReturnType<typeof plan>, over: Partial<ExistingLink> = {}): ExistingLink[] =>
  jobsOf(p, 'insert').map((job) => ({
    v1ResumeId: job.v1ResumeId,
    v2ResumeId: job.v2ResumeId,
    userId: job.userId,
    completed: true,
    resumeExists: true,
    sectionCount: job.sectionRows.length,
    ...over,
  }))

// ---------------------------------------------------------------------------
// A recording target. It cannot do anything but insert, because the port it
// implements has no other method.
// ---------------------------------------------------------------------------

function recorder(fail?: { on: 'link' | 'resume' | 'sections' | 'complete'; forV2Id?: string }) {
  const links: LinkRowValues[] = []
  const resumes: ResumeRowValues[] = []
  const sections: SectionRowValues[] = []
  const completed: string[] = []
  const target: MigrationTarget = {
    async insertLink(row) {
      if (fail?.on === 'link') return { ok: false, detail: 'simulated claim failure' }
      // The primary key on v1_resume_id, modelled.
      if (links.some((l) => l.v1_resume_id === row.v1_resume_id)) {
        return { ok: false, detail: '23505 duplicate key value violates unique constraint' }
      }
      links.push(row)
      return { ok: true }
    },
    async insertResume(row) {
      if (fail?.on === 'resume') return { ok: false, detail: 'simulated parent failure' }
      resumes.push(row)
      return { ok: true }
    },
    async insertSections(rows) {
      const hit = fail?.on === 'sections' &&
        (fail.forV2Id === undefined || rows.some((r) => r.resume_id === fail.forV2Id))
      if (hit) return { ok: false, detail: 'simulated sections failure' }
      sections.push(...rows)
      return { ok: true }
    },
    async completeLink(v1ResumeId) {
      if (fail?.on === 'complete') return { ok: false, detail: 'simulated stamp failure' }
      completed.push(v1ResumeId)
      return { ok: true }
    },
  }
  return { target, links, resumes, sections, completed }
}

// ---------------------------------------------------------------------------
// Ownership -- the rule the whole writer exists to keep
// ---------------------------------------------------------------------------

test('every planned row is owned by the user on its V1 source row', () => {
  const { resumes } = v1Fixtures()
  const byId = new Map(resumes.map((r) => [r.id, r.user_id]))
  const p = plan()

  for (const job of jobsOf(p, 'insert')) {
    assert.equal(
      job.resumeRow.user_id, byId.get(job.v1ResumeId),
      `resume ${job.v1ResumeId} would be written to the wrong owner`
    )
    assert.equal(job.userId, byId.get(job.v1ResumeId))
  }
})

test('the seventeen fixtures span sixteen owners, and each keeps their own', () => {
  const p = plan()
  const owners = new Set(jobsOf(p, 'insert').map((j) => j.userId))
  assert.equal(p.counts.insert, RESUME_COUNT)
  assert.equal(owners.size, 16, 'one owner holds two resumes; the rest hold one')
})

test('a mapped resume whose owner disagrees with its source is impossible to build', () => {
  // planMigration reads user_id from the source row and passes the same row to
  // the mapper, so this can only happen if the mapper is changed. The throw is
  // the tripwire for that change.
  const source = readFileSync(fileURLToPath(new URL('./writer.ts', import.meta.url)), 'utf8')
  assert.ok(source.includes('assertOwnership'), 'the ownership assertion was removed')
  assert.ok(
    /user_id:\s*row\.user_id/.test(source),
    'user_id must be read from the V1 source row'
  )
})

// ---------------------------------------------------------------------------
// Inserts only
// ---------------------------------------------------------------------------

function code(relative: string): string {
  const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  // Comments stripped first. This suite has caught itself matching its own
  // prose about the things it forbids more than once.
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('the writer contains no update, delete or upsert of any kind', () => {
  const source = code('./writer.ts')
  // The one legitimate `.update(` in this file feeds the SHA-1 hash in
  // deterministicId(). Remove that chain first, so this scan is about
  // databases rather than about crypto.
  const scanned = source.replace(/createHash\([\s\S]*?\.digest\('hex'\)/g, 'DIGEST')
  assert.notEqual(scanned, source, 'the hash builder moved; this exclusion needs revisiting')

  for (const forbidden of ['.update(', '.delete(', '.upsert(', '.rpc(', 'DELETE FROM', 'UPDATE ']) {
    assert.equal(
      scanned.includes(forbidden), false,
      `writer.ts contains "${forbidden}" -- it may only insert`
    )
  }
})

test('the port it writes through offers nothing but inserts', () => {
  const source = code('./writer.ts')
  const port = source.slice(
    source.indexOf('export interface MigrationTarget'),
    source.indexOf('export type JobResult')
  )
  assert.ok(port.includes('insertResume'), 'the port lost its resume insert')
  assert.ok(port.includes('insertSections'), 'the port lost its sections insert')
  for (const forbidden of ['update', 'delete', 'upsert', 'select', 'query']) {
    assert.equal(
      port.toLowerCase().includes(forbidden), false,
      `the port exposes "${forbidden}"`
    )
  }
})

test('nothing in the plan targets a V1 table or a V1 row id', () => {
  const { resumes, sections } = v1Fixtures()
  const v1ResumeIds = new Set(resumes.map((r) => r.id))
  const v1SectionIds = new Set(sections.map((s) => s.id))
  const p = plan()

  for (const job of jobsOf(p, 'insert')) {
    assert.equal(v1ResumeIds.has(job.resumeRow.id), false, 'a V1 resume id would be overwritten')
    for (const row of job.sectionRows) {
      assert.equal(v1SectionIds.has(row.id), false, 'a V1 section id would be overwritten')
    }
  }
})

// ---------------------------------------------------------------------------
// The privilege boundary
// ---------------------------------------------------------------------------

test('the writer holds no credentials and no database client', () => {
  const source = code('./writer.ts')
  for (const forbidden of [
    'SERVICE_ROLE', 'service_role', 'serviceRole', '@supabase/supabase-js',
    'createClient', 'SUPABASE_URL', 'ANON_KEY', 'fetch(', 'process.env',
  ]) {
    assert.equal(
      source.includes(forbidden), false,
      `writer.ts references "${forbidden}" -- the privileged connection belongs in scripts/`
    )
  }
})

test('no file the Next build can reach imports the writer', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const offenders: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) continue
      if (full.includes('/lib/resume/migrate/')) continue // the module and its tests
      const text = readFileSync(full, 'utf8')
      if (/from ['"].*migrate\/writer(\.ts)?['"]/.test(text)) offenders.push(full.slice(root.length))
    }
  }
  for (const dir of ['app', 'components', 'lib']) walk(join(root, dir))

  assert.deepEqual(
    offenders, [],
    'the migration writer must not be reachable from the application'
  )
})

test('the writer cannot be pulled into a browser bundle', () => {
  const source = readFileSync(fileURLToPath(new URL('./writer.ts', import.meta.url)), 'utf8')
  assert.ok(
    source.includes("from 'node:crypto'"),
    'the node:crypto import is a deliberate barrier: a client bundle cannot resolve it'
  )
  assert.equal(source.includes("'use client'"), false)
})

// ---------------------------------------------------------------------------
// Determinism, idempotency and repair
// ---------------------------------------------------------------------------

test('the same V1 id always produces the same V2 ids', () => {
  const a = plan()
  const b = plan()
  assert.deepEqual(
    jobsOf(a, 'insert').map((j) => [j.v1ResumeId, j.v2ResumeId, j.sectionRows.map((r) => r.id)]),
    jobsOf(b, 'insert').map((j) => [j.v1ResumeId, j.v2ResumeId, j.sectionRows.map((r) => r.id)])
  )
})

test('derived ids are well-formed v5-shaped uuids and never collide', () => {
  const seen = new Set<string>()
  for (let r = 0; r < 40; r++) {
    for (let i = 0; i < 40; i++) {
      const id = deterministicId(`v1-resume-${r}`, i)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, id)
      assert.equal(seen.has(id), false, `collision on ${id}`)
      seen.add(id)
    }
  }
})

test('a second run over a completed target writes nothing at all', () => {
  const second = plan({}, ledgerAfter(plan()))
  assert.equal(second.counts.skip, RESUME_COUNT)
  assert.equal(second.counts.insert, 0)
  assert.equal(second.counts.repair, 0)
  assert.equal(second.clean, true)
  for (const job of jobsOf(second, 'skip')) {
    assert.equal(job.reason, 'already-migrated')
  }
})

test('a parent left behind by an interrupted run is repaired, not duplicated', () => {
  const first = plan()
  const orphan = jobsOf(first, 'insert')[0]
  const second = plan({}, [{
    v1ResumeId: orphan.v1ResumeId, v2ResumeId: orphan.v2ResumeId, userId: orphan.userId,
    completed: false,      // the run stopped before stamping
    resumeExists: true,    // the parent landed
    sectionCount: 0,       // the sections did not
  }])

  const repairs = jobsOf(second, 'repair')
  assert.equal(repairs.length, 1)
  assert.equal(repairs[0].v2ResumeId, orphan.v2ResumeId, 'the repair must reuse the claimed id')
  assert.equal(repairs[0].needsParent, false, 'the parent is already there')
  assert.equal(repairs[0].resumeRow, null, 're-inserting the parent would collide on its key')
  assert.deepEqual(
    repairs[0].sectionRows.map((r) => r.id),
    orphan.sectionRows.map((r) => r.id),
    'a repair must produce exactly the rows the interrupted run intended'
  )
  assert.equal(second.counts.insert, RESUME_COUNT - 1, 'the other sixteen are untouched')
})

test('a claim with nothing behind it is repaired from the top', () => {
  const first = plan()
  const claimed = jobsOf(first, 'insert')[0]
  const second = plan({}, [{
    v1ResumeId: claimed.v1ResumeId, v2ResumeId: claimed.v2ResumeId, userId: claimed.userId,
    completed: false, resumeExists: false, sectionCount: 0,
  }])

  const repair = jobsOf(second, 'repair')[0]
  assert.ok(repair)
  assert.equal(repair.needsParent, true)
  assert.equal(repair.resumeRow?.id, claimed.v2ResumeId, 'the claimed id must be reused')
  assert.equal(repair.sectionRows.length, claimed.sectionRows.length)
})

test('a claim whose work is all present only needs stamping', () => {
  const first = plan()
  const done = jobsOf(first, 'insert')[0]
  const second = plan({}, [{
    v1ResumeId: done.v1ResumeId, v2ResumeId: done.v2ResumeId, userId: done.userId,
    completed: false, resumeExists: true, sectionCount: done.sectionRows.length,
  }])

  const repair = jobsOf(second, 'repair')[0]
  assert.ok(repair)
  assert.equal(repair.needsParent, false)
  assert.equal(repair.resumeRow, null)
  assert.deepEqual(repair.sectionRows, [], 'the sections are already there')
})

// --- the deletion decision -------------------------------------------------

test('a migrated resume the owner later deleted is NOT recreated', () => {
  // The whole reason completed_at exists. Without it this state is
  // indistinguishable from an interrupted run, and the writer would resurrect
  // a resume somebody deliberately removed.
  const second = plan({}, ledgerAfter(plan(), { resumeExists: false, sectionCount: 0 }))

  assert.equal(second.counts.insert, 0, 'a deleted resume must not be re-migrated')
  assert.equal(second.counts.repair, 0, 'a deleted resume must not be repaired')
  assert.equal(second.counts.skip, RESUME_COUNT)
  for (const job of jobsOf(second, 'skip')) {
    assert.equal(job.reason, 'deleted-by-owner')
  }
})

test('deleting only the sections of a completed migration is also left alone', () => {
  const second = plan({}, ledgerAfter(plan(), { sectionCount: 0 }))
  assert.equal(second.counts.repair, 0, 'a finished migration is never rewritten')
  assert.equal(second.counts.skip, RESUME_COUNT)
})

test('a deleted resume stays skipped however many times the writer runs', () => {
  const ledger = ledgerAfter(plan(), { resumeExists: false, sectionCount: 0 })
  for (let run = 0; run < 3; run++) {
    const p = plan({}, ledger)
    assert.equal(p.counts.insert, 0, `run ${run + 1} tried to recreate a deleted resume`)
  }
})

test('an interrupted sections insert is reported as recoverable, not as success', async () => {
  const p = plan()
  const target = jobsOf(p, 'insert')[0]
  const { target: db, resumes } = recorder({ on: 'sections', forV2Id: target.v2ResumeId })

  const result = await executeMigration(db, p, { apply: true })
  const incomplete = result.results.filter((r) => r.kind === 'incomplete')

  assert.equal(incomplete.length, 1)
  assert.equal(result.ok, false, 'an incomplete resume must not report success')
  assert.equal(resumes.length, 1, 'the parent was written and is deliberately left in place')
  assert.ok(
    result.links.some((l) => l.v1ResumeId === target.v1ResumeId),
    'the link must still be recorded, or the next run cannot repair it'
  )
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a resume with duplicate legacy sections is refused and produces no rows', () => {
  const { resumes } = v1Fixtures()
  const victim = resumes[0].id
  const p = plan({ extraSections: [duplicateSectionRow(victim, 'education')] })

  const refusals = jobsOf(p, 'refuse')
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].v1ResumeId, victim)
  assert.equal(p.clean, false, 'a plan with refusals is not clean')
  assert.equal(
    jobsOf(p, 'insert').some((j) => j.v1ResumeId === victim), false,
    'a refused resume must contribute no insert'
  )
})

test('a link claiming another user is a conflict, never evidence of migration', () => {
  const { resumes } = v1Fixtures()
  const victim = resumes[0]
  const links: ExistingLink[] = [{
    v1ResumeId: victim.id,
    v2ResumeId: 'someone-elses-v2-row',
    userId: 'attacker',
    completed: true,
    resumeExists: true,
    sectionCount: 9,
  }]

  const p = plan({}, links)
  const conflicts = jobsOf(p, 'conflict')
  assert.equal(conflicts.length, 1, 'a foreign claim must not silently skip the migration')
  assert.equal(conflicts[0].v1ResumeId, victim.id)
  assert.equal(p.clean, false)
  assert.equal(
    jobsOf(p, 'skip').some((j) => j.v1ResumeId === victim.id), false,
    'the resume must NOT be treated as already migrated'
  )
})

test('refusals and conflicts write nothing even when the run is applied', async () => {
  const { resumes } = v1Fixtures()
  const p = plan({ extraSections: [duplicateSectionRow(resumes[0].id, 'education')] })
  const { target, resumes: written } = recorder()

  await executeMigration(target, p, { apply: true })
  assert.equal(
    written.some((r) => r.migrated_from_v1 === resumes[0].id), false,
    'the refused resume reached the database'
  )
})

// ---------------------------------------------------------------------------
// Execution safety
// ---------------------------------------------------------------------------

test('nothing is written unless apply is exactly true', async () => {
  const p = plan()
  for (const options of [undefined, {}, { apply: false }, { apply: 'true' as unknown as boolean }, { apply: 1 as unknown as boolean }]) {
    const { target, resumes, sections } = recorder()
    const result = await executeMigration(target, p, options)
    assert.equal(resumes.length, 0, `apply=${JSON.stringify(options)} wrote resume rows`)
    assert.equal(sections.length, 0, `apply=${JSON.stringify(options)} wrote section rows`)
    assert.equal(result.counts.written, RESUME_COUNT, 'a rehearsal still reports what it would do')
  }
})

test('an applied run writes every mapped resume once, with its sections', async () => {
  const p = plan()
  const { target, resumes, sections } = recorder()
  const result = await executeMigration(target, p, { apply: true })

  assert.equal(result.ok, true)
  assert.equal(resumes.length, RESUME_COUNT)
  assert.equal(new Set(resumes.map((r) => r.id)).size, RESUME_COUNT, 'a resume was written twice')
  assert.equal(
    sections.length,
    jobsOf(p, 'insert').reduce((n, j) => n + j.sectionRows.length, 0)
  )
  for (const row of resumes) {
    assert.equal(row.schema_version, 2)
    assert.equal(row.revision, 1)
    assert.equal(row.status, 'draft', 'every migrated resume enters V2 as a draft')
  }
})

test('every written V2 id is recorded against the V1 id it came from', async () => {
  const p = plan()
  const { target } = recorder()
  const result = await executeMigration(target, p, { apply: true })

  assert.equal(result.links.length, RESUME_COUNT)
  const byV1 = new Map(result.links.map((l) => [l.v1ResumeId, l.v2ResumeId]))
  for (const job of jobsOf(p, 'insert')) {
    assert.equal(byV1.get(job.v1ResumeId), job.v2ResumeId, `unlogged write for ${job.v1ResumeId}`)
  }
})

test('a failure stops the run by default rather than continuing blindly', async () => {
  const p = plan()
  const { target } = recorder({ on: 'link' })
  const result = await executeMigration(target, p, { apply: true })

  assert.equal(result.counts.failed, 1, 'the run should stop at the first failure')
  assert.equal(result.ok, false)
})

// --- the ledger ordering ---------------------------------------------------

test('the link is claimed before the resume it names is written', async () => {
  const p = plan()
  const order: string[] = []
  const target: MigrationTarget = {
    async insertLink() { order.push('link'); return { ok: true } },
    async insertResume() { order.push('resume'); return { ok: true } },
    async insertSections() { order.push('sections'); return { ok: true } },
    async completeLink() { order.push('complete'); return { ok: true } },
  }
  await executeMigration(target, p, { apply: true })

  assert.deepEqual(
    order.slice(0, 4), ['link', 'resume', 'sections', 'complete'],
    'claim first, stamp last -- anything else leaves an unrecoverable state'
  )
})

test('completed_at is only stamped after the sections have landed', async () => {
  const p = plan()
  const { target, completed } = recorder({ on: 'sections' })
  const result = await executeMigration(target, p, { apply: true })

  assert.deepEqual(completed, [], 'an unfinished migration must not be stamped complete')
  assert.equal(result.counts.incomplete, 1)
  assert.equal(result.ok, false)
})

test('a failed stamp is incomplete, not success -- the next run would re-skip it', async () => {
  const p = plan()
  const { target, completed } = recorder({ on: 'complete' })
  const result = await executeMigration(target, p, { apply: true })

  assert.deepEqual(completed, [])
  assert.equal(result.counts.incomplete, 1)
  assert.equal(result.counts.written, 0, 'unstamped work must not be reported as written')
})

test('a failed claim writes nothing, so the resume is left clean for a re-run', async () => {
  const p = plan()
  const { target, resumes, sections, completed } = recorder({ on: 'link' })
  const result = await executeMigration(target, p, { apply: true })

  assert.deepEqual(resumes, [])
  assert.deepEqual(sections, [])
  assert.deepEqual(completed, [])
  assert.equal(result.counts.failed, 1)
  assert.equal(result.counts.incomplete, 0, 'nothing was written, so nothing is incomplete')
})

test('the ledger row takes its owner from the V1 source row', () => {
  const { resumes } = v1Fixtures()
  const byId = new Map(resumes.map((r) => [r.id, r.user_id]))
  for (const job of jobsOf(plan(), 'insert')) {
    assert.equal(job.link.user_id, byId.get(job.v1ResumeId))
    assert.equal(job.link.v1_resume_id, job.v1ResumeId)
    assert.equal(job.link.v2_resume_id, job.resumeRow.id)
  }
})

test('a duplicate claim is refused by the ledger, not worked around', async () => {
  const p = plan()
  const { target } = recorder()
  await executeMigration(target, p, { apply: true })
  // Running the same plan again against the same ledger: every claim collides.
  const again = await executeMigration(target, p, { apply: true })

  assert.equal(again.counts.written, 0)
  assert.equal(again.counts.failed, 1, 'the primary key must stop the second claim')
  assert.match(again.results[0].kind === 'failed' ? again.results[0].detail : '', /23505|duplicate/)
})

test('the applicant timestamps survive and only updated_at reflects the migration', () => {
  const { resumes } = v1Fixtures()
  const created = new Map(resumes.map((r) => [r.id, r.created_at]))
  for (const job of jobsOf(plan(), 'insert')) {
    assert.equal(job.resumeRow.created_at, created.get(job.v1ResumeId))
    assert.equal(job.resumeRow.updated_at, NOW)
  }
})
