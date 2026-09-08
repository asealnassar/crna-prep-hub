import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  transcriptAllowanceFor, documentFingerprint, decideAccess, decideReservation,
  TRANSCRIPT_ALLOWANCE_CODE, ANALYSIS_LIMIT_CODE, MAX_ANALYSES_PER_USER,
} from './transcriptEntitlement.ts'
import { canCreateAnalysis } from './analyses.ts'
import { classifyFailure, failureCopy, isRetryable } from './importProgress.ts'
import { copyCoursesFrom, planCombine, type CombineSource } from './combine.ts'
import { DEFAULT_POLICIES, type Course, type Institution } from './types.ts'

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
/** Executable text only. A comment explaining a rule is not the rule. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ')
     .replace(/^\s*\/\/.*$/gm, ' ')
     .replace(/^\s*--.*$/gm, ' ')
     .replace(/\s--\s.*$/gm, ' ')

/** What a reader actually sees. A comment explaining a rule is not the copy. */
const visible = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const MIGRATION = read('supabase/migrations/20260905_000_gpa_transcript_sources.sql')
const ANALYZE = read('app/api/analyze-transcript/route.ts')
const PARSE = read('app/api/parse-pdf/route.ts')
const PAGE = read('app/gpa-calculator/page.tsx')
const MODAL = read('app/gpa-calculator/components/TranscriptLimitModal.tsx')

// ---------------------------------------------------------------- allowance
test('Free and Premium get one transcript; Ultimate is unlimited', () => {
  assert.equal(transcriptAllowanceFor('free'), 1)
  assert.equal(transcriptAllowanceFor('premium'), 1)
  assert.equal(transcriptAllowanceFor('ULTIMATE'), null)
  // An unknown or empty tier is never treated as Ultimate.
  assert.equal(transcriptAllowanceFor(''), 1)
  assert.equal(transcriptAllowanceFor('lifetime-vip'), 1)
})

// -------------------------------------------------------------- fingerprint
test('the fingerprint identifies a document without storing one', () => {
  const text = 'RUTGERS UNIVERSITY\nNURS 310 Pathophysiology  A  3.0\nJane Q. Student'
  const hash = documentFingerprint(text)
  assert.match(hash, /^[0-9a-f]{64}$/)
  // Same document, same source -- this is what makes the D44 second pass and a
  // retry after a failure cost one allowance between them, not one each.
  assert.equal(documentFingerprint(text), hash)
  assert.notEqual(documentFingerprint(text + ' '), hash)
  // Nothing recoverable: no name, school, course or grade survives into it.
  for (const fragment of ['RUTGERS', 'NURS', 'Pathophysiology', 'Jane', 'Student']) {
    assert.equal(hash.toLowerCase().includes(fragment.toLowerCase()), false)
  }
})

// ------------------------------------------------------------- fail closed
test('an unreadable answer is a refusal, never permission', () => {
  for (const bad of [null, undefined, '', 0, 'ok', {}, { allowed: 'true' }, { ok: 'true' }]) {
    assert.equal(decideAccess(bad).allowed, false, `access: ${JSON.stringify(bad)}`)
    assert.equal(decideReservation(bad).ok, false, `reserve: ${JSON.stringify(bad)}`)
  }
  // Only an explicit spent allowance is reported as one; everything else is a
  // service problem, so a database outage never reads as "upgrade to continue".
  assert.equal((decideAccess({}) as any).reason, 'unavailable')
  assert.equal((decideAccess({ allowed: false, reason: 'allowance-used' }) as any).reason, 'allowance-used')
  assert.equal((decideReservation({ ok: false, reason: 'allowance-used' }) as any).reason, 'allowance-used')
})

test('a reservation is only accepted with a server-issued id', () => {
  assert.deepEqual(
    decideReservation({ ok: true, source_id: 'src-1', status: 'pending', reused: false }),
    { ok: true, sourceId: 'src-1', reused: false, alreadyConsumed: false })
  assert.deepEqual(
    decideReservation({ ok: true, source_id: 'src-1', status: 'consumed', reused: true }),
    { ok: true, sourceId: 'src-1', reused: true, alreadyConsumed: true })
  // ok without an id is not a reservation.
  assert.equal(decideReservation({ ok: true }).ok, false)
  assert.equal(decideReservation({ ok: true, source_id: '' }).ok, false)
})

// ------------------------------------------------- 8: concurrency, in the DB
test('the reservation takes the user lock before it counts', () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('function public.gpa_reserve_transcript_source'),
    MIGRATION.indexOf('function public.gpa_consume_transcript_source'))
  const lock = fn.indexOf('pg_advisory_xact_lock')
  const count = fn.indexOf('select count(*) into v_used')
  const insert = fn.indexOf('insert into public.gpa_transcript_sources')
  assert.ok(lock > 0, 'no advisory lock in the reservation')
  assert.ok(lock < count && count < insert,
    'the lock must be held before the count, and the count before the insert')
})

test('the tier is read in the database, never accepted as an argument', () => {
  // A caller cannot raise its own limit: no signature takes a tier or a limit.
  assert.ok(!/p_tier|p_limit|p_allowance/.test(MIGRATION))
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('function public.gpa_reserve_transcript_source'),
    MIGRATION.indexOf('function public.gpa_consume_transcript_source'))
  assert.ok(/from public\.user_profiles/.test(fn))
  // An unreadable profile is 'free', not Ultimate.
  assert.ok(/coalesce\(nullif\(v_tier, ''\), 'free'\)/.test(fn))
})

// ------------------------------------- 6, 7: a failed analysis costs nothing
test('only a pending reservation can be released', () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('function public.gpa_release_transcript_source'),
    MIGRATION.indexOf('function public.gpa_transcript_access'))
  assert.ok(/delete from public\.gpa_transcript_sources/.test(fn))
  assert.ok(/status = 'pending'/.test(fn), 'release must be limited to pending rows')
  // 9, 10: nothing anywhere can un-consume, so deleting an analysis or its
  // courses can never give the allowance back.
  assert.ok(!/status\s*=\s*'pending'\s*where[\s\S]*consumed/.test(MIGRATION))
  assert.ok(!/set consumed_at\s*=\s*null/.test(MIGRATION))
})

test('the ledger is independent of what the user currently holds', () => {
  // Eligibility must never be derived from analyses, courses or snapshots --
  // deleting those does not restore the allowance.
  for (const table of ['gpa_drafts', 'gpa_calculations', 'gpa_institutions']) {
    const body = MIGRATION.split('-- VERIFICATION')[0]
    assert.ok(!new RegExp(`(from|join|into|update)\\s+public\\.${table}`).test(body),
      `${table} must not take part in the entitlement decision`)
  }
})

// ---------------------------------------------- 19: the client cannot reset
test('the ledger is read-only to the user and untouchable outside the functions', () => {
  assert.ok(/alter table public\.gpa_transcript_sources enable row level security/.test(MIGRATION))
  const policies = MIGRATION.match(/create policy "[^"]+" on public\.gpa_transcript_sources\s+for (\w+)/g) ?? []
  assert.deepEqual(policies.map(p => p.split('for ')[1]), ['select'],
    'the only policy on the ledger may be SELECT')
  assert.ok(/revoke all on public\.gpa_transcript_sources from anon, authenticated, service_role/.test(MIGRATION))
  const grants = MIGRATION.match(/^grant [^;]+on public\.gpa_transcript_sources[^;]*;/gm) ?? []
  assert.deepEqual(grants, ['grant select on public.gpa_transcript_sources to authenticated;'])
})

test('the entitlement functions are callable by the server alone', () => {
  for (const fn of ['gpa_reserve_transcript_source', 'gpa_consume_transcript_source',
                    'gpa_release_transcript_source', 'gpa_transcript_access']) {
    assert.ok(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s+from public, anon, authenticated, service_role`).test(MIGRATION), `${fn} not revoked`)
    assert.ok(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s+to service_role`).test(MIGRATION), `${fn} not granted to service_role only`)
    assert.ok(new RegExp(`create or replace function public\\.${fn}[\\s\\S]{0,600}?security definer`).test(MIGRATION), `${fn} is not security definer`)
  }
})

// ------------------------------ 20, 21: the API is the enforcement point
test('neither transcript route is Ultimate-only any more', () => {
  for (const [name, src] of [['analyze', ANALYZE], ['parse', PARSE]] as const) {
    assert.ok(!/auth\.isUltimate/.test(src), `${name} still gates on isUltimate`)
    assert.ok(!/available on the Ultimate plan/.test(src), `${name} still refuses Free/Premium`)
    assert.ok(/authenticateRequest\(\)/.test(src), `${name} lost its authentication`)
  }
})

test('the analysis reserves before it runs, consumes on success, releases on failure', () => {
  const reserve = ANALYZE.indexOf('await reserveTranscriptSource(')
  const openai = ANALYZE.indexOf('https://api.openai.com')
  const consume = ANALYZE.indexOf('await consumeTranscriptSource(')
  assert.ok(reserve > 0 && openai > reserve, 'the allowance must be taken before the AI call')
  assert.ok(consume > openai, 'the allowance must be consumed only after a result')
  // Every failure path gives the reservation back, so a parser, upstream or
  // timeout failure never costs the user their one transcript.
  const body = ANALYZE.slice(reserve)
  assert.equal((body.match(/await releaseOnFailure\(\)/g) ?? []).length, 3)
  for (const branch of ['{ status: 502 }', '{ status: 422 }', 'aborted ? 504 : 500']) {
    assert.ok(body.includes(branch), `missing failure branch ${branch}`)
  }
  // A reused, already-consumed source is not released by a later failure.
  assert.ok(/if \(!reservation\.alreadyConsumed\)/.test(ANALYZE))
})

test('the source id is issued by the server and returned to the client', () => {
  assert.ok(/transcriptSourceId: reservation\.sourceId/.test(ANALYZE))
  // 15: the browser never mints one.
  const importBlock = PAGE.slice(PAGE.indexOf('const runImport ='), PAGE.indexOf('const saveCalculation'))
  assert.ok(/let transcriptSourceId: string \| null = null/.test(importBlock))
  assert.ok(/body\.transcriptSourceId/.test(importBlock))
  assert.ok(/\n\s+transcriptSourceId,\n/.test(importBlock), 'imported rows must carry the source id')
  assert.ok(!/transcriptSourceId\s*=\s*(`|'|"|crypto|Math|Date)/.test(importBlock),
    'the client must never generate a transcript source id')
})

test('the pre-check runs on the exact text the parse response returns', () => {
  const parseCheck = PARSE.indexOf('transcriptAccess(auth.userId, documentFingerprint(text))')
  assert.ok(parseCheck > 0)
  assert.ok(PARSE.indexOf('const text = result.text.slice(0, MAX_TEXT_CHARS)') < parseCheck)
  // Reading a PDF is not analyzing a transcript: nothing is reserved here.
  assert.ok(!/reserveTranscriptSource/.test(PARSE))
})

// --------------------------------- 11, 12: manual entry is never charged
test('manual course entry issues no source and stays available', () => {
  const addCourse = PAGE.slice(PAGE.indexOf('const addCourse = ()'), PAGE.indexOf('const replaceCourse'))
  assert.ok(!/transcriptSourceId/.test(addCourse), 'a hand-typed course must carry no source')
  assert.ok(!/canUploadTranscript|transcriptUsed|limitModal/.test(addCourse),
    'adding a course by hand must not consult the transcript allowance')
  // The upgrade prompt says so, rather than leaving the page looking dead.
  assert.ok(/add and edit courses by hand/i.test(MODAL))
})

// ---------------------------- 13, 14, 16, 17, 18: provenance survives copies
const INSTITUTIONS: Institution[] = [
  { id: 'i1', name: 'Ridgeview State University', creditSystem: 'semester', gradingScale: null },
  { id: 'i2', name: 'Harbor Medical University', creditSystem: 'semester', gradingScale: null },
]
let n = 0
const C = (o: Partial<Course> & { institutionId: string }): Course => ({
  id: o.id ?? 'c' + (++n), institutionId: o.institutionId, courseCode: o.courseCode ?? 'BIO 101',
  name: o.name ?? 'Course', grade: 'A', credits: 3, term: 'Fall', year: '2020',
  categories: ['general'], categorySource: 'ai', level: 'undergraduate', levelSource: 'ai',
  recordType: 'coursework', transferredIn: false, needsReview: false, reviewReasons: [],
  transcriptSourceId: o.transcriptSourceId,
})

test('an editable copy carries the same source, not a new one', () => {
  const source: CombineSource = {
    id: 'a1', name: 'Ridgeview', policies: DEFAULT_POLICIES,
    courses: [C({ institutionId: 'i1', transcriptSourceId: 'src-A' }),
              C({ institutionId: 'i1', transcriptSourceId: 'src-A' })],
  }
  const copies = copyCoursesFrom(source, i => 'new-' + i)
  assert.deepEqual([...new Set(copies.map(c => c.transcriptSourceId))], ['src-A'])
  // The rows are genuinely new rows; only the provenance is shared.
  assert.equal(copies.filter(c => c.id.startsWith('new-')).length, 2)
})

test('a combined analysis holds every source it actually contains', () => {
  const a: CombineSource = {
    id: 'a1', name: 'Ridgeview', policies: DEFAULT_POLICIES,
    courses: [C({ institutionId: 'i1', transcriptSourceId: 'src-A' })],
  }
  const b: CombineSource = {
    id: 'a2', name: 'Harbor', policies: DEFAULT_POLICIES,
    courses: [C({ institutionId: 'i2', transcriptSourceId: 'src-B' }),
              C({ institutionId: 'i2' })],   // typed by hand: no source at all
  }
  const plan = planCombine({
    sources: [a, b], institutions: INSTITUTIONS, existingAnalyses: [], canCreate: true,
  })
  assert.equal(plan.ok, true)
  const ids = plan.courses!.map(c => c.transcriptSourceId)
  assert.deepEqual([...new Set(ids)].sort(), [undefined, 'src-A', 'src-B'].sort() as any)
})

// ------------------------------------------- 22: the block is an upgrade
test('a spent allowance is told apart from an expired session', () => {
  assert.equal(classifyFailure({ status: 403, code: TRANSCRIPT_ALLOWANCE_CODE }), 'allowance-used')
  assert.equal(classifyFailure({ status: 403 }), 'not-allowed')
  assert.equal(classifyFailure({ status: 401 }), 'not-allowed')
  // Sending the same file again cannot help, so it is not offered.
  assert.equal(isRetryable('allowance-used'), false)
  assert.equal(failureCopy('allowance-used').canRetry, false)
})

test('the copy never claims they still have the transcript', () => {
  const copy = failureCopy('allowance-used')
  const texts = [copy.title, copy.message, visible(MODAL)]
  for (const t of texts) {
    assert.ok(!/already have (one|a) transcript/i.test(t))
    assert.ok(!/delete/i.test(t), 'deleting does not restore the allowance and must never be suggested')
  }
  assert.match(copy.title, /Ultimate/)
  assert.match(copy.message, /already used your transcript analysis/i)
  // The existing billing flow, not a new one.
  assert.match(MODAL, /href="\/pricing"/)
  assert.match(MODAL, /Upgrade to Ultimate/)
  assert.match(MODAL, /Not now/)
})

test('the workspace opens the upgrade prompt from both entry points', () => {
  // Before a file is chosen...
  assert.ok(/if \(!canUploadTranscript\) \{ setLimitModal\(true\); return \}/.test(PAGE))
  // ...and after the server refuses one that was.
  assert.ok(/kind === 'allowance-used'.*setLimitModal\(true\)/.test(PAGE))
  // The local flag is advisory: unknown must not block a first transcript.
  assert.ok(/const canUploadTranscript = isUltimate \|\| transcriptUsed !== true/.test(PAGE))
})

// ==========================================================================
// D60 pre-flight: D35's analysis cap, applied before anything is spent
// ==========================================================================
const RUN_IMPORT = PAGE.slice(PAGE.indexOf('const runImport ='), PAGE.indexOf('const saveCalculation'))
const PREFLIGHT = ANALYZE.slice(
  ANALYZE.indexOf('// D60 pre-flight'), ANALYZE.indexOf('// D60: take the allowance'))

test('1: an account below the cap may still analyze a transcript', () => {
  const analyses = Array.from({ length: MAX_ANALYSES_PER_USER - 1 }, (_, i) => ({ id: 'a' + i }))
  assert.equal(analyses.length, 49)
  assert.equal(canCreateAnalysis(analyses), true)
})

test('2, 3: an account at the cap cannot, whatever its plan', () => {
  const analyses = Array.from({ length: MAX_ANALYSES_PER_USER }, (_, i) => ({ id: 'a' + i }))
  assert.equal(analyses.length, 50)
  assert.equal(canCreateAnalysis(analyses), false)
  // There is ONE cap and it is D35's. This file defines no second number.
  assert.equal(MAX_ANALYSES_PER_USER, 50)
  assert.ok(!/\b50\b/.test(codeOnly(PREFLIGHT)), 'the route must not restate the limit')
  assert.ok(!/\b50\b/.test(codeOnly(RUN_IMPORT.slice(0, RUN_IMPORT.indexOf('try {')))))
})

test('2, 3: the block happens before the transcript is sent anywhere', () => {
  // Client: the guard sits ahead of the very first request.
  const guard = RUN_IMPORT.indexOf("destination !== 'fill' && !canCreateAnalysis(analyses)")
  const parseCall = RUN_IMPORT.indexOf("fetch('/api/parse-pdf'")
  const analyzeCall = RUN_IMPORT.indexOf("fetch('/api/analyze-transcript'")
  assert.ok(guard > 0, 'no client pre-flight')
  assert.ok(guard < parseCall && guard < analyzeCall,
    'the cap must be checked before any request is made')

  // Server: and ahead of the AI call, for a caller that skipped the page.
  const routeGuard = ANALYZE.indexOf('if (willCreateAnalysis)')
  const openai = ANALYZE.indexOf('https://api.openai.com')
  assert.ok(routeGuard > 0 && routeGuard < openai)
})

test('4, 5: a capped account reserves nothing and consumes nothing', () => {
  const routeGuard = ANALYZE.indexOf('if (willCreateAnalysis)')
  const reserve = ANALYZE.indexOf('await reserveTranscriptSource(')
  assert.ok(routeGuard < reserve, 'the cap must be checked before the reservation')
  // The refusal path itself touches neither the ledger nor the AI.
  assert.ok(!/reserveTranscriptSource|consumeTranscriptSource|api\.openai/.test(PREFLIGHT))
  // And the client's refusal path makes no request at all.
  const clientGuard = RUN_IMPORT.slice(
    RUN_IMPORT.indexOf("destination !== 'fill' && !canCreateAnalysis(analyses)"),
    RUN_IMPORT.indexOf('let numPages'))
  assert.ok(!/fetch\(/.test(clientGuard))
  assert.ok(/fail\(st, 'analysis-limit'/.test(clientGuard))
})

test('5: the copy tells the user their transcript was not used up', () => {
  const copy = failureCopy('analysis-limit')
  assert.match(copy.message, /Nothing was analyzed and nothing was used up/)
  assert.equal(copy.canRetry, false)
  // Distinct from the post-analysis case, which really did spend the transcript.
  assert.notEqual(copy.title, failureCopy('limit').title)
  assert.match(failureCopy('limit').message, /read successfully/)
  assert.ok(!/nothing was used up/i.test(failureCopy('limit').message))
  assert.equal(classifyFailure({ status: 409, code: ANALYSIS_LIMIT_CODE }), 'analysis-limit')
  // A cap refusal is never mistaken for a spent allowance, or the reverse.
  assert.notEqual(classifyFailure({ status: 409, code: ANALYSIS_LIMIT_CODE }), 'allowance-used')
  assert.notEqual(classifyFailure({ status: 403, code: TRANSCRIPT_ALLOWANCE_CODE }), 'analysis-limit')
})

test('6: the cap applies to every plan, exactly as D35 already does', () => {
  // No tier appears anywhere in the pre-flight: Ultimate is not exempt from
  // D35, and being Ultimate does not change what this check does.
  assert.ok(!/isUltimate|ultimate|tier/i.test(PREFLIGHT))
  const clientGuard = RUN_IMPORT.slice(
    RUN_IMPORT.indexOf("destination !== 'fill'"), RUN_IMPORT.indexOf('let numPages'))
  assert.ok(!/isUltimate|transcriptUsed|canUploadTranscript/.test(clientGuard))
})

test('6: filling an existing analysis is never capped', () => {
  // 'fill' adds coursework to an analysis that already exists, so it cannot be
  // refused by a limit on how many analyses exist.
  assert.ok(/destination !== 'fill' && !canCreateAnalysis\(analyses\)/.test(RUN_IMPORT))
  assert.ok(/willCreateAnalysis: destination !== 'fill'/.test(RUN_IMPORT))
  assert.ok(/willCreateAnalysis = body\?\.willCreateAnalysis === true/.test(ANALYZE))
})

test('6: an unreadable analysis count does not refuse a legitimate import', () => {
  // The database trigger is what enforces D35. This check only spares the user
  // a wasted transcript, so "unknown" must leave the old behaviour alone.
  const fn = read('lib/gpa/transcriptEntitlement.ts')
  const capacity = fn.slice(fn.indexOf('export async function canCreateAnotherAnalysis'))
  // Both unreadable paths -- a query error and a thrown one -- answer "unknown".
  assert.equal((capacity.match(/return null/g) ?? []).length, 2)
  assert.ok(capacity.includes('return count < MAX_ANALYSES_PER_USER'))
  assert.ok(/if \(room === false\)/.test(ANALYZE), 'only a definite false may block')
})

test('7: the same transcript stays recoverable for a bounded window', () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('function public.gpa_reserve_transcript_source'),
    MIGRATION.indexOf('function public.gpa_consume_transcript_source'))
  assert.ok(/document_hash = p_document_hash/.test(fn))
  assert.ok(/status = 'pending' or consumed_at > now\(\) - interval '30 minutes'/.test(fn))
  // Recovery is keyed on the document. It is not a reset: it can only ever
  // return the source that this exact transcript already has.
  const reuse = fn.slice(fn.indexOf('select id, status into'), fn.indexOf('select lower(btrim'))
  assert.ok(!/delete|update/.test(reuse))
})

test('8: a DIFFERENT transcript after consumption is still refused', () => {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('function public.gpa_reserve_transcript_source'),
    MIGRATION.indexOf('function public.gpa_consume_transcript_source'))
  // The allowance count is over ALL of the user's sources -- it is not
  // narrowed by document_hash, so a second document meets a used allowance.
  const count = fn.slice(fn.indexOf('select count(*) into v_used'), fn.indexOf("'allowance-used'"))
  assert.ok(/where user_id = p_user_id/.test(count))
  assert.ok(!/document_hash/.test(count), 'the allowance count must not be per-document')
  assert.ok(/if v_used >= 1 then/.test(fn))
})

test('9: deleting the analysis leaves the ledger untouched', () => {
  // Nothing in the app deletes a consumed source, and the only DELETE anywhere
  // in the migration is the pending-reservation cleanup.
  const body = MIGRATION.split('-- VERIFICATION')[0]
  const deletes = body.match(/delete from public\.gpa_transcript_sources[\s\S]*?;/g) ?? []
  assert.equal(deletes.length, 2, 'expected exactly the expiry sweep and the release')
  for (const d of deletes) assert.ok(/status = 'pending'/.test(d), d)
  // And the app never issues its own DELETE against the ledger.
  for (const src of [read('lib/gpa/transcriptEntitlement.ts'), PAGE, ANALYZE, PARSE]) {
    assert.ok(!/from\('gpa_transcript_sources'\)[\s\S]{0,80}\.delete\(/.test(src))
  }
})

test('10: nothing infers historical transcript usage', () => {
  // The ledger begins empty at rollout. No backfill, and above all no guess
  // from fields that were already proven unreliable.
  const body = MIGRATION.split('-- VERIFICATION')[0]
  const inserts = body.match(/insert into public\.gpa_transcript_sources/g) ?? []
  assert.equal(inserts.length, 1, 'the reservation is the only thing that creates a source')
  assert.ok(!/^\s*insert into public\.gpa_transcript_sources/m.test(
    body.replace(/create or replace function[\s\S]*?\$\$;/g, '')),
    'no top-level backfill statement')
  for (const src of [MIGRATION, read('lib/gpa/transcriptEntitlement.ts'), ANALYZE, PARSE]) {
    for (const field of ['levelSource', 'categorySource', 'provenance', 'copiedFrom']) {
      assert.ok(!codeOnly(src).includes(field), `${field} must play no part in entitlement`)
    }
  }
})
