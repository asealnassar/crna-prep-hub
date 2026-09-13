import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatExecution, formatPlan } from './audit.ts'
import { deterministicId, executeMigration, planMigration } from './writer.ts'
import type { ExistingLink, MigrationTarget } from './writer.ts'
import { duplicateSectionRow, v1Fixtures, RESUME_COUNT } from './fixtures.ts'

const NOW = '2026-09-12T09:00:00.000Z'
const build = (over: Parameters<typeof v1Fixtures>[0] = {}, existingLinks: ExistingLink[] = []) => {
  const { resumes, sections } = v1Fixtures(over)
  return planMigration({ resumes, sections, existingLinks, now: NOW, idFor: deterministicId })
}
const noop: MigrationTarget = {
  async insertLink() { return { ok: true } },
  async insertResume() { return { ok: true } },
  async insertSections() { return { ok: true } },
  async completeLink() { return { ok: true } },
}

test('the plan report states every count', () => {
  const text = formatPlan(build())
  for (const label of ['source resumes', 'to insert', 'already migrated', 'needs review', 'conflicts']) {
    assert.ok(text.includes(label), `the report omits "${label}"`)
  }
  assert.ok(text.includes(`source resumes      ${RESUME_COUNT}`))
  assert.ok(text.includes('CLEAN'))
})

test('a refusal is printed with every duplicate row id, not a summary', () => {
  const { resumes } = v1Fixtures()
  const victim = resumes[0].id
  const extra = duplicateSectionRow(victim, 'education')
  const plan = build({ extraSections: [extra] })
  const text = formatPlan(plan)

  assert.ok(text.includes('NEEDS REVIEW'), 'refusals must have their own section')
  assert.ok(text.includes(victim), 'the refused resume must be named')
  assert.ok(text.includes(extra.id), 'the duplicate row id must be printed')
  assert.ok(text.includes('NOT CLEAN'))

  // The ORIGINAL row is listed too. Naming only the newcomer would tell a
  // reviewer which row to delete, which is precisely the choice the mapper
  // refused to make on their behalf.
  const original = v1Fixtures().sections.find(
    (s) => s.resume_id === victim && s.section_type === 'education'
  )
  assert.ok(original, 'the fixture should have an education section')
  assert.ok(text.includes(original.id), 'every duplicate row must be listed, not just the last')
})

test('a conflict is printed with the owner it claims', () => {
  const { resumes } = v1Fixtures()
  const text = formatPlan(build({}, [{
    v1ResumeId: resumes[0].id, v2ResumeId: 'v2-row', userId: 'attacker',
    completed: true, resumeExists: true, sectionCount: 4,
  }]))
  assert.ok(text.includes('CONFLICTS'))
  assert.ok(text.includes('attacker'))
  assert.ok(text.includes(resumes[0].id))
})

test('legacy notes are counted by kind rather than buried', () => {
  const text = formatPlan(build())
  assert.ok(text.includes('NOTES'), 'the notes summary is missing')
  // The fixtures carry unparseable dates and blank bullet arrays; both are
  // reported, and neither is corrected.
  assert.ok(/blank-bullets-dropped\s+\d+/.test(text) || /unparsed-date\s+\d+/.test(text))
})

test('a rehearsal says so on its first line and never claims to have written', async () => {
  const plan = build()
  const result = await executeMigration(noop, plan)
  const text = formatExecution(result, { applied: false, target: 'db.example.supabase.co', startedAt: NOW })

  assert.ok(text.includes('REHEARSAL'), 'a rehearsal must be labelled as one')
  assert.ok(text.includes('nothing written'))
  assert.ok(text.includes('applied             no'))
})

test('the id map lists every V1 resume against the V2 row it produced', async () => {
  const plan = build()
  const result = await executeMigration(noop, plan, { apply: true })
  const text = formatExecution(result, { applied: true, target: 'db.example.supabase.co', startedAt: NOW })

  assert.ok(text.includes('ID MAP'))
  for (const link of result.links) {
    const line = text.split('\n').find((l) => l.includes(link.v1ResumeId))
    assert.ok(line, `no line for V1 resume ${link.v1ResumeId}`)
    assert.ok(line.includes(link.v2ResumeId), `the V2 id is missing for ${link.v1ResumeId}`)
  }
  assert.ok(text.includes('V1 source rows were not read for update, modified or deleted'))
})

test('an incomplete resume is reported with instructions, not as a success', async () => {
  const plan = build()
  const failing: MigrationTarget = {
    async insertLink() { return { ok: true } },
    async insertResume() { return { ok: true } },
    async insertSections() { return { ok: false, detail: 'connection reset' } },
    async completeLink() { return { ok: true } },
  }
  const result = await executeMigration(failing, plan, { apply: true })
  const text = formatExecution(result, { applied: true, target: 'db.example.supabase.co', startedAt: NOW })

  assert.ok(text.includes('NOT OK'), 'the headline verdict must be negative')
  assert.ok(text.includes('INCOMPLETE'))
  assert.ok(text.includes('Re-run to finish it'), 'the operator must be told what to do')
  assert.ok(text.includes('do NOT'))
  assert.ok(text.includes('stopped at sections'), 'the stage it stopped at must be named')
})

test('a resume deleted after migration is reported as a decision, not a failure', async () => {
  const first = build()
  const ledger = first.jobs.flatMap((j) => j.kind === 'insert' ? [{
    v1ResumeId: j.v1ResumeId, v2ResumeId: j.v2ResumeId, userId: j.userId,
    completed: true, resumeExists: false, sectionCount: 0,
  }] : [])
  const plan = build({}, ledger)
  const result = await executeMigration(noop, plan, { apply: true })
  const text = formatExecution(result, { applied: true, target: 'db.example.supabase.co', startedAt: NOW })

  assert.ok(text.includes('DELETED BY OWNER'), 'the deletion must be surfaced explicitly')
  assert.ok(text.includes('re-running must'), 'the report must say it will not be undone')
  assert.ok(text.includes('These are not errors.'))
  assert.equal(text.includes('NOT OK'), false, 'a deliberate deletion is not a failed run')
})

test('the audit record never contains a credential', async () => {
  const plan = build()
  const result = await executeMigration(noop, plan, { apply: true })
  const text = formatPlan(plan) + formatExecution(result, {
    applied: true, target: 'db.example.supabase.co', startedAt: NOW,
  })
  for (const secret of ['service_role', 'SERVICE_ROLE', 'eyJ', 'apikey', 'Bearer']) {
    assert.equal(text.includes(secret), false, `the audit record leaked "${secret}"`)
  }
})
