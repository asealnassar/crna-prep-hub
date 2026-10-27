import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canAnalyzeStatement, V2_ANALYSIS_RATE_LIMITS } from '../draft/reviewAccess.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const stripTs = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const REPO = stripTs(read('./repo.ts'))
const ROUTE = stripTs(read('../../../app/api/statement/drafts/[id]/analyze/route.ts'))

/**
 * THE ROUTE WITH ITS IMPORTS REMOVED.
 *
 * Every order assertion below runs against this and not against ROUTE. The
 * first version of this file compared indexOf() positions on the whole file,
 * which matched the IMPORT LINES at the top: the comparisons were then about
 * the order the modules happen to be imported in, not the order the route does
 * things, and two of them passed or failed by coincidence.
 */
const ROUTE_BODY = ROUTE.replace(/^import[\s\S]*?from\s*'[^']*'$/gm, '')
  .replace(/^import \{[\s\S]*?\} from '[^']*'$/gm, '')
const EDITOR_PAGE = stripTs(read('../../../app/statement-studio/[id]/page.tsx'))
const LIBRARY_PAGE = stripTs(read('../../../app/statement-studio/page.tsx'))
const MIGRATION = read('../../../supabase/migrations/20261002_005_statement_requirements.sql')
  .replace(/^\s*--.*$/gm, '')

const NEW_MODULES = [
  'constraints.ts', 'constraintText.ts', 'requirement.ts', 'verification.ts', 'snapshot.ts',
  'eligibility.ts', 'checklistView.ts', 'fixtures.ts', 'repo.ts',
].map((name) => [name, stripTs(read(`./${name}`))] as const)

// ===================================================== owner isolation

test('NO NEW MODULE EVER REACHES FOR THE SERVICE ROLE', () => {
  // The one way to bypass RLS. Not one of these files may name it.
  for (const [name, source] of NEW_MODULES) {
    assert.doesNotMatch(source, /SERVICE_ROLE|service_role|serviceRole/, name)
    assert.doesNotMatch(source, /createClient\(/, `${name} creates no client of its own`)
  }
})

test('the catalog reader uses the CALLER’S client, handed in', () => {
  // db is a parameter. It is never constructed, so it carries whatever JWT the
  // caller had and RLS decides what is visible.
  assert.match(REPO, /db: SupabaseClient/)
  assert.doesNotMatch(REPO, /process\.env\.[A-Z_]*SUPABASE/)
})

test('THE CATALOG READER ISSUES NO WRITE OF ANY KIND', () => {
  for (const write of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']) {
    assert.ok(!REPO.includes(write), `${write} must not appear`)
  }
})

test('the migration grants no write privilege on the new tables', () => {
  const grants = (MIGRATION.match(/^\s*grant [\s\S]*?;/gm) ?? []).join('\n')
  assert.ok(grants.length > 0)
  for (const grant of grants.split(';').filter((g) => g.trim().length > 0)) {
    assert.doesNotMatch(grant, /insert|update|delete|all/i, grant)
  }
  assert.doesNotMatch(grants, /to service_role/)
})

test('OWNER ISOLATION ON DRAFTS IS UNCHANGED: no new policy touches them', () => {
  // The new columns live on statement_drafts, whose own-rows policies from
  // 20260928_000 continue to decide every statement. This migration adds no
  // policy to that table and no column-level grant.
  const draftPolicies = MIGRATION.match(/create policy[^;]*statement_drafts[^;]*;/gi) ?? []
  assert.deepEqual(draftPolicies, [])
  assert.doesNotMatch(MIGRATION, /grant[^;]*statement_drafts/i)
  assert.doesNotMatch(MIGRATION, /alter table public\.statement_drafts[^;]*enable row level/i)
})

test('a draft read is still scoped to its owner by the repository AND by RLS', () => {
  const repo = stripTs(read('../draft/draftRepo.ts'))
  // The gate only changes WHICH COLUMNS are asked for, never the predicate.
  assert.match(repo, /function draftColumns\(\)/)
  assert.match(repo, /requirementsEnabled\(\)/)
  // No filter was removed: the list read still names the user.
  assert.match(repo, /\.eq\('user_id'/)
})

// ===================================================== subscription access

test('THE TIER GATE IS UNCHANGED AND STILL ULTIMATE-ONLY', () => {
  assert.equal(canAnalyzeStatement('ultimate'), true)
  assert.equal(canAnalyzeStatement('premium'), false)
  assert.equal(canAnalyzeStatement('free'), false)
  assert.equal(canAnalyzeStatement(null), false)
  assert.equal(canAnalyzeStatement(undefined), false)
  assert.equal(canAnalyzeStatement('Ultimate'), true, 'case and spacing are normalised')
})

test('a requirement cannot widen who may analyse', () => {
  // The route's order is unchanged: the tier gate precedes everything the
  // requirement touches, so no requirement field is read before it.
  const tierAt = ROUTE_BODY.indexOf('canAnalyzeStatement(')
  const requirementAt = ROUTE_BODY.indexOf('parseRequirementSnapshot(')
  assert.ok(tierAt > 0 && requirementAt > 0)
  assert.ok(tierAt < requirementAt, 'the plan is checked before the requirement is parsed')
})

test('THE THROTTLE IS UNCHANGED: burst protection, no daily cap', () => {
  assert.deepEqual(V2_ANALYSIS_RATE_LIMITS.map((w) => [w.windowMs, w.max]),
    [[60_000, 5], [3_600_000, 20]])
  const day = 24 * 60 * 60 * 1000
  for (const window of V2_ANALYSIS_RATE_LIMITS) {
    assert.ok(window.windowMs < day, 'no window may be a day or longer')
  }
})

test('eligibility is still checked BEFORE any usage is recorded', () => {
  // Both branches of the new two-path eligibility check must precede the
  // ledger. Spending somebody's allowance to tell them their answer is too
  // short is the billing behaviour nobody forgives.
  const eligibilityAt = ROUTE_BODY.indexOf('eligibilityForRequirement({')
  const legacyEligibilityAt = ROUTE_BODY.indexOf('eligibilityFor({')
  const attemptAt = ROUTE_BODY.indexOf('recordStatementAttempt(')
  assert.ok(eligibilityAt > 0 && legacyEligibilityAt > 0 && attemptAt > 0)
  assert.ok(eligibilityAt < attemptAt)
  assert.ok(legacyEligibilityAt < attemptAt)
})

test('the fingerprint still precedes the claim, so the cache is consulted first', () => {
  const fingerprintAt = ROUTE_BODY.indexOf('analysisFingerprint({')
  const claimAt = ROUTE_BODY.indexOf('claimAnalysis(')
  assert.ok(fingerprintAt > 0 && claimAt > 0)
  assert.ok(fingerprintAt < claimAt)
})

// ===================================================== the gate, end to end

test('EVERY NEW DATABASE-DEPENDENT PATH IS GATED', () => {
  // Three places touch the unapplied schema, and each one asks the flag.
  const repo = stripTs(read('../draft/draftRepo.ts'))
  assert.match(REPO, /if \(!requirementsEnabled\(\)\)/, 'the catalog reader')
  assert.match(repo, /requirementsEnabled\(\)\s*\n?\s*\?/, 'the draft column list')
  assert.match(repo, /if \(!requirementsEnabled\(\)\) return badArgument\('requirement'\)/,
    'the create path')
})

test('the PREVIEW is not database-dependent and is not gated by the flag', () => {
  // The fixtures are TypeScript constants, so the preview needs no schema. It
  // is gated by development AND administrator instead, which is a different
  // and stricter condition.
  assert.match(LIBRARY_PAGE, /nodeEnv: process\.env\.NODE_ENV/)
  assert.doesNotMatch(LIBRARY_PAGE, /requirementsEnabled/)
  const fixtures = NEW_MODULES.find(([name]) => name === 'fixtures.ts')![1]
  assert.doesNotMatch(fixtures, /SupabaseClient|\.from\(|requirementsEnabled/)
})

test('the editor page reads the snapshot and queries no new table', () => {
  assert.match(EDITOR_PAGE, /parseRequirementSnapshot\(draft\.requirementSnapshot\)/)
  assert.doesNotMatch(EDITOR_PAGE, /statement_requirement/)
  assert.doesNotMatch(EDITOR_PAGE, /listRequirementSets|readActiveRequirement/)
})

test('NO FIXTURE CAN BE WRITTEN TO THE DATABASE', () => {
  const fixtures = NEW_MODULES.find(([name]) => name === 'fixtures.ts')![1]
  for (const write of ['insert', 'upsert', 'update', 'rpc', 'from(']) {
    assert.ok(!fixtures.includes(write), write)
  }
  // And no migration inserts them either.
  assert.doesNotMatch(MIGRATION, /\binsert into\b/i)
})

test('THE ORDER ASSERTIONS RUN AGAINST THE BODY, NOT THE IMPORTS', () => {
  // The bug this file shipped with for one run. Every needle the order tests
  // use must be ABSENT from the import block, or the comparison is about
  // import order rather than execution order.
  // ANCHORED ON THE LAST IMPORT, not on a declaration that may not exist. The
  // first version looked for `export const dynamic`, which this API route does
  // not have, so indexOf returned -1, slice(0, -1) kept the whole file and the
  // guard failed for a reason that had nothing to do with what it checks.
  const lastImport = ROUTE.lastIndexOf("from '@/lib/statement")
  assert.ok(lastImport > 200, 'precondition: the import block was found')
  const imports = ROUTE.slice(0, ROUTE.indexOf('\n', lastImport))
  assert.match(imports, /^import /m)
  assert.ok(!imports.includes('export '), 'the slice is imports only')
  for (const needle of ['canAnalyzeStatement(', 'parseRequirementSnapshot(',
    'eligibilityForRequirement({', 'eligibilityFor({', 'recordStatementAttempt(',
    'analysisFingerprint({', 'claimAnalysis(']) {
    assert.ok(ROUTE_BODY.includes(needle), `${needle} must survive in the body`)
    assert.ok(!imports.includes(needle), `${needle} must not match the import block`)
  }
  // And the body really is shorter than the file.
  assert.ok(ROUTE_BODY.length < ROUTE.length)
})

// ===================================================== snapshot authority
//
// THE CORRECTION THESE ASSERTIONS GUARD. public.statement_drafts grants
// `authenticated` table-level UPDATE with an own-rows policy, so an applicant
// can PATCH requirement_snapshot straight through PostgREST. Every decision
// that reads it must therefore read the AUTHENTICATED value, not the stored
// one, and these are the structural checks that it does.

test('THE ROUTE RESOLVES AUTHENTICITY BEFORE ANYTHING READS THE SNAPSHOT', () => {
  const verdictAt = ROUTE_BODY.indexOf('const verdict = await draftProvenance(')
  const authoritativeAt = ROUTE_BODY.indexOf('const authoritative = verdict.authentic')
  assert.ok(verdictAt > 0 && authoritativeAt > verdictAt)
  // Every later consumer comes after it.
  for (const consumer of ['eligibilityForRequirement({', 'wordFloorFits(', 'reviewSystemPrompt(']) {
    assert.ok(ROUTE_BODY.indexOf(consumer) > authoritativeAt, consumer)
  }
})

test('EVERY ANALYSIS DECISION READS `authoritative`, NEVER `requirement`', () => {
  // After the verdict, the only permitted reads of the raw snapshot are the
  // fingerprint's (deliberate -- a tampered draft must get its own cache row)
  // and the verdict call itself.
  const after = ROUTE_BODY.slice(ROUTE_BODY.indexOf('const authoritative = verdict.authentic'))
  const rawReads = [...after.matchAll(/\brequirement\.(\w+)/g)].map((m) => m[0])
  assert.deepEqual(rawReads, [], `the raw snapshot is read at: ${rawReads.join(', ')}`)
  // And the authenticated one is what the three consumers use.
  assert.match(after, /eligibilityForRequirement\(\{ constraints: authoritative\.constraints, words \}\)/)
  assert.match(after, /!wordFloorFits\(authoritative\.constraints\)/)
  assert.match(after, /authoritative\.components\.length/)
  assert.match(after, /requirement: authoritative,/)
})

test('THE FINGERPRINT KEYS ON THE STORED SNAPSHOT, so a tampered draft is its own row', () => {
  // Deliberately NOT the authenticated value: keying on that would collapse
  // every tampered variant onto one key and let the first one answer for all.
  const start = ROUTE_BODY.indexOf('const fingerprint = analysisFingerprint({')
  // THE BOUNDARY IS ASSERTED, not assumed. indexOf returns -1 for a marker that
  // has been renamed, and a slice to -1 silently runs to the end of the file --
  // which would make the doesNotMatch below pass on the whole route and prove
  // nothing. This caught exactly that when `claimId` became `claim`.
  const end = ROUTE_BODY.indexOf('let claim: HeldClaim | null')
  assert.ok(start !== -1, 'the fingerprint call was renamed')
  assert.ok(end > start, 'the claim declaration was renamed; fix this boundary')
  const call = ROUTE_BODY.slice(start, end)
  assert.match(call, /^\s*requirement,$/m)
  assert.doesNotMatch(call, /authoritative/)
})

test('THE EDITOR’S WARNING COMES FROM THE SERVER, not the snapshot', () => {
  const editor = stripTs(read('../../../app/statement-studio/components/StatementStudioClient.tsx'))
  // The snapshot's own verification object decides nothing in the editor.
  assert.doesNotMatch(editor, /requirement\.verification/)
  assert.doesNotMatch(editor, /needsVerificationWarning/)
  assert.match(editor, /requirement === null \|\| requirementAuthentic/)
  assert.match(editor, /requirementAuthentic = false/, 'and it defaults to the cautious answer')
})

test('the editor page computes the verdict server-side and passes it down', () => {
  const page = stripTs(read('../../../app/statement-studio/[id]/page.tsx'))
  assert.match(page, /await draftProvenance\(/)
  assert.match(page, /requirementAuthentic=\{requirementVerdict\?\.authentic === true\}/)
  // Skipped entirely for a draft with no requirement.
  assert.match(page, /requirement === null\s*\n?\s*\? null/)
})

test('THE SNAPSHOT IS NEVER DELETED OR REWRITTEN BY THE ANALYSER', () => {
  // Item 4: the historical copy survives so a draft keeps the instructions its
  // author started from. The route must not "repair" it.
  assert.doesNotMatch(ROUTE_BODY, /requirement_snapshot/)
  assert.doesNotMatch(ROUTE_BODY, /\.update\(|\.upsert\(/)
})

// ===========================================================================
// THE LENGTH REGISTER AND THE ROLLOUT GATE
// ===========================================================================

test('THE REGISTER COLUMNS ARE BEHIND THE SAME GATE AS THE REST', () => {
  // 20261002_006 adds them and is not applied, so the catalog read that names
  // them must not run until the flag is set. requirementProvenance() already
  // returns early on !requirementsEnabled(); this records that the register
  // bought no new way past it.
  assert.match(REPO, /if \(!requirementsEnabled\(\)\)/)
  const columnList = REPO.slice(REPO.indexOf('const REQUIREMENT_COLUMNS'))
    .slice(0, REPO.slice(REPO.indexOf('const REQUIREMENT_COLUMNS')).indexOf('\n\n'))
  for (const column of ['words_enforcement', 'characters_enforcement', 'pages_enforcement']) {
    assert.ok(columnList.includes(column), `${column} is not in the select list`)
  }
})

test('A HALF-APPLIED MIGRATION FAILS CLOSED, NOT OPEN', () => {
  // With 005 applied and 006 missing, the SELECT above errors. The reader turns
  // a read error into a refusal rather than a verification, so a database that
  // cannot show its register columns vouches for nothing.
  assert.match(REPO, /read-failed/)
  const provenance = read('./provenance.ts')
  assert.match(provenance, /if \(found\.error\) return UNVERIFIED_RESULT\('read-failed'\)/)
  assert.doesNotMatch(provenance, /found\.error[^\n]*origin: 'catalog'/)
})

test('NOTHING READS A REGISTER OFF THE DRAFT TO DECIDE ANYTHING', () => {
  // The snapshot's register is parsed and displayed, and is compared against
  // the catalog by the digest -- but the route acts only on `authoritative`,
  // which is null unless that comparison passed. No new field changed that.
  const route = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
  assert.match(route, /const authoritative = verdict\.authentic \? requirement : null/)
  assert.doesNotMatch(route, /requirement\.constraints\.words\?\.enforcement/)
  assert.doesNotMatch(route, /requirement\.constraints\.pages\?\.enforcement/)
})
