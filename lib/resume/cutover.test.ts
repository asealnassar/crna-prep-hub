import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * The cutover claims, checked against the repository rather than remembered.
 *
 * Every assertion here corresponds to a sentence in the Phase 12 report. If one
 * of them stops being true, the report becomes wrong, and a wrong cutover
 * document is more dangerous than no document.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Source with comments removed. This suite keeps catching its own prose. */
function code(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', '.git'].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full, out); continue }
    if (/\.(ts|tsx)$/.test(entry) && !/\.(test)\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const V2_ROUTES = [
  'app/api/resume-v2/draft/route.ts',
  'app/api/resume-v2/score/route.ts',
  'app/api/resume-v2/ai/propose/route.ts',
  'app/api/resume-v2/export/pdf/route.ts',
  'app/api/resume-v2/export/docx/route.ts',
  'app/api/resume-v2/import/route.ts',
]
const V2_PAGES = [
  'app/resume-studio/page.tsx',
  'app/resume-studio/onboard/page.tsx',
  'app/resume-studio/[id]/page.tsx',
]
const V1_PAGES = [
  'app/resume-builder/page.tsx',
  'app/resume-builder/edit/[id]/page.tsx',
  'app/resume-builder/preview/[id]/page.tsx',
]

// ---------------------------------------------------------------------------
// The rollout gate reaches every V2 surface
// ---------------------------------------------------------------------------

test('every V2 route and page consults the gate with the rollout mode', () => {
  for (const file of [...V2_ROUTES, ...V2_PAGES]) {
    const source = code(file)
    assert.ok(source.includes('resumeV2Access'), `${file} does not call the gate`)
    assert.ok(source.includes('resumeBuilderMode()'), `${file} does not pass the rollout mode`)
    assert.ok(source.includes('isAuthenticated'), `${file} does not pass authentication state`)
  }
})

test('the gate still runs before any per-request work in every V2 route', () => {
  for (const file of V2_ROUTES) {
    // Import lines are stripped first. Without that, `import OpenAI from
    // 'openai'` on line 2 reads as "the model is called before the gate".
    // Module-level client construction is not per-request work either, so the
    // markers below are awaited CALL SITES rather than bare identifiers.
    const source = code(file).replace(/^import .*$/gm, '')
    const gate = source.indexOf('resumeV2Access({')
    assert.notEqual(gate, -1, `${file}: no gate call`)
    for (const later of [
      'await request.', 'await openai', 'buildImportPlan(', 'extractPdfText(',
    ]) {
      const at = source.indexOf(later)
      if (at === -1) continue
      assert.ok(at > gate, `${file}: "${later}" runs before the gate`)
    }
  }
})

test('authentication is still checked before the gate in every V2 route', () => {
  for (const file of V2_ROUTES) {
    const source = code(file)
    const auth = source.indexOf('authenticateRequest()')
    const gate = source.indexOf('resumeV2Access({')
    assert.ok(auth !== -1 && auth < gate, `${file}: the gate runs before authentication`)
  }
})

test('opening the gate did not open the entitlement checks', () => {
  // The mode decides which builder someone sees. Finalize and export stay
  // Ultimate-only, resolved from the database tier, in both modes.
  for (const file of ['app/api/resume-v2/export/pdf/route.ts', 'app/api/resume-v2/export/docx/route.ts']) {
    const source = code(file)
    assert.ok(source.includes('auth.tier'), `${file} no longer resolves the tier from the session`)
    assert.equal(
      source.includes('mode ==='), false,
      `${file} branches on the rollout mode; entitlements must not depend on it`
    )
  }
})

// ---------------------------------------------------------------------------
// One flag
// ---------------------------------------------------------------------------

test('exactly one file reads the rollout environment variable', () => {
  const readers = walk(join(ROOT, 'lib'))
    .concat(walk(join(ROOT, 'app')))
    .filter((file) => /process\.env\[?['"]?RESUME_BUILDER_MODE/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(ROOT.length))
  assert.deepEqual(readers, ['lib/resume/rollout.ts'], 'the flag must have one reader')
})

test('the rollout flag is never exposed to the browser', () => {
  for (const file of walk(join(ROOT, 'lib')).concat(walk(join(ROOT, 'app')), walk(join(ROOT, 'components')))) {
    const source = readFileSync(file, 'utf8')
    assert.equal(
      source.includes('NEXT_PUBLIC_RESUME_BUILDER_MODE'), false,
      `${file.slice(ROOT.length)} publishes the rollout flag to the client`
    )
  }
})

// ---------------------------------------------------------------------------
// V1 coexistence
// ---------------------------------------------------------------------------

test('the V1 layout is the single place V1 is switched off', () => {
  const layout = code('app/resume-builder/layout.tsx')
  assert.ok(layout.includes('legacyBuilderDisposition'), 'the layout does not consult the disposition')
  assert.ok(layout.includes('redirect('), 'the layout does not redirect')
  assert.ok(
    layout.includes("export const dynamic = 'force-dynamic'"),
    'without force-dynamic the mode is frozen at build time and the flag does nothing'
  )
  assert.equal(layout.includes("'use client'"), false, 'the layout must stay a server component')
})

test('every V1 query against resumes filters out V2 rows', () => {
  for (const file of V1_PAGES) {
    const source = code(file)
    const selects = [...source.matchAll(/\.from\('resumes'\)\s*\n\s*\.select\(/g)]
    assert.ok(selects.length > 0, `${file}: no resumes select found -- has the page changed?`)
    assert.ok(
      source.includes('LEGACY_SCHEMA_FILTER'),
      `${file} reads resumes without excluding V2 rows`
    )
    assert.equal(
      selects.length, [...source.matchAll(/\.or\(LEGACY_SCHEMA_FILTER\)/g)].length,
      `${file}: ${selects.length} selects but not that many legacy filters`
    )
  }
})

test('a V1 editor that finds no legacy row sends the user away rather than rendering', () => {
  for (const file of V1_PAGES.slice(1)) {
    const source = code(file)
    assert.ok(
      source.includes("router.replace('/resume-builder')"),
      `${file} does not redirect when the row is absent or is a V2 row`
    )
  }
})

test('V1 is not deleted -- it stays available for the rollback window', () => {
  for (const file of [...V1_PAGES, 'app/resume-builder/create/page.tsx', 'app/api/resume/enhance/route.ts']) {
    assert.ok(
      readFileSync(join(ROOT, file), 'utf8').length > 0,
      `${file} is missing; V1 must remain for emergency rollback`
    )
  }
})

// ---------------------------------------------------------------------------
// The privilege boundary
// ---------------------------------------------------------------------------

test('no V2 route or page holds a service-role client', () => {
  for (const file of [...V2_ROUTES, ...V2_PAGES]) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    for (const forbidden of ['SERVICE_ROLE', 'service_role', 'supabase-admin']) {
      assert.equal(source.includes(forbidden), false, `${file} references ${forbidden}`)
    }
  }
})

test('the migration script is the only migration code holding a service-role key', () => {
  const holders = walk(join(ROOT, 'lib', 'resume'))
    .concat(walk(join(ROOT, 'scripts')))
    .filter((file) => /SUPABASE_SERVICE_ROLE_KEY/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(ROOT.length))
  assert.deepEqual(holders, ['scripts/migrate-v1-resumes.ts'])
})

test('nothing the application can reach imports the migration script', () => {
  const offenders: string[] = []
  for (const dir of ['app', 'components', 'lib']) {
    for (const file of walk(join(ROOT, dir))) {
      if (/migrate-v1-resumes/.test(readFileSync(file, 'utf8'))) offenders.push(file.slice(ROOT.length))
    }
  }
  assert.deepEqual(offenders, [], 'the migration script must be unreachable from the app')
})

test('the script refuses to run through the shared target guard', () => {
  const script = code('scripts/migrate-v1-resumes.ts')
  assert.ok(script.includes('requireStagingTarget()'), 'the target guard is gone')
  assert.ok(
    script.includes("from '../lib/resume/migrate/target.ts'"),
    'the guard must be the shared module, not a local copy'
  )
})

test('the script has no second staging check that could drift', () => {
  // The guard lives in exactly one place. A local re-check here would be a
  // second opinion about which databases are safe, and the two would
  // eventually disagree.
  const script = code('scripts/migrate-v1-resumes.ts')
  for (const local of ['RESUME_MIGRATION_TARGET', 'ALLOWED_TARGETS', 'supabase.co', 'PRODUCTION_PROJECT_REFS']) {
    assert.equal(
      script.includes(local), false,
      `scripts/migrate-v1-resumes.ts re-implements "${local}" instead of using the shared guard`
    )
  }
})

test('the script writes nothing unless --apply is passed, and never over a dirty plan', () => {
  const script = code('scripts/migrate-v1-resumes.ts')
  assert.ok(script.includes("process.argv.includes('--apply')"))
  assert.ok(script.includes('!plan.clean'), 'the script must refuse to apply an unclean plan')
  assert.ok(script.includes('REFUSING TO APPLY'))
})

test('the script never deletes anything, and updates only completed_at', () => {
  const script = code('scripts/migrate-v1-resumes.ts')
  for (const forbidden of ['.delete(', '.upsert(', '.rpc(']) {
    assert.equal(script.includes(forbidden), false, `the script contains "${forbidden}"`)
  }

  // Three inserts: the ledger claim, the resume parent, the sections.
  assert.equal([...script.matchAll(/\.insert\(/g)].length, 3)

  // Exactly one update, and it writes exactly one column. The grant in 006 is
  // column-scoped to completed_at, so a wider update would be refused by the
  // database too -- this test is the earlier of the two warnings.
  const updates = [...script.matchAll(/\.update\(\{([^}]*)\}\)/g)]
  assert.equal(updates.length, 1, 'the script should make exactly one update')
  assert.match(updates[0][1], /^\s*completed_at:[^,]*$/, 'the update must touch only completed_at')
})

test('the script writes the ledger claim before the resume it names', () => {
  const script = code('scripts/migrate-v1-resumes.ts')
  const target = script.slice(script.indexOf('function targetFor'))
  const link = target.indexOf('insertLink')
  const resume = target.indexOf('insertResume')
  const complete = target.indexOf('completeLink')
  assert.ok(link !== -1 && resume !== -1 && complete !== -1, 'the port is incomplete')
  assert.ok(link < resume, 'insertLink must come first in the port')
  assert.ok(resume < complete, 'completeLink must come last')
})

test('the script never prints a credential', () => {
  const script = code('scripts/migrate-v1-resumes.ts')
  const logs = [...script.matchAll(/console\.(log|error)\(([\s\S]*?)\)\n/g)].map((m) => m[2])
  for (const line of logs) {
    for (const secret of ['key', 'SERVICE_ROLE', 'url']) {
      assert.equal(
        new RegExp(`\\b${secret}\\b`).test(line), false,
        `a console call interpolates "${secret}": ${line.trim().slice(0, 80)}`
      )
    }
  }
})

// ---------------------------------------------------------------------------
// Migration 006
// ---------------------------------------------------------------------------

const SQL = readFileSync(
  join(ROOT, 'supabase/migrations/20260911_006_resume_v2_migration_link.sql'), 'utf8'
)
/**
 * SQL with `--` comments AND `comment on ... is '...'` literals removed. The
 * literals are documentation too, and leaving them in made an earlier version
 * of this suite match its own prose.
 */
const SQL_CODE = SQL
  .replace(/^\s*--.*$/gm, '')
  .replace(/comment on [\s\S]*?;/g, '')

test('006 is transactional, additive and rerunnable', () => {
  assert.ok(/^begin;/m.test(SQL_CODE))
  assert.ok(/^commit;/m.test(SQL_CODE))
  assert.ok(SQL_CODE.includes('create table if not exists public.resume_v1_migration_links'))
  assert.ok(SQL_CODE.includes('create unique index if not exists'))
  for (const destructive of ['drop table', 'drop column', 'drop function', 'truncate', 'delete from']) {
    assert.equal(SQL_CODE.toLowerCase().includes(destructive), false, `006 contains "${destructive}"`)
  }
})

test('006 adds no column to public.resumes -- the ledger is a separate table', () => {
  // The rejected first draft put migrated_from_v1 on resumes, where every
  // authenticated user could write it. Nothing should reintroduce that.
  assert.equal(SQL_CODE.includes('migrated_from_v1'), false)
  assert.equal(/alter table public\.resumes/.test(SQL_CODE), false)
})

test('one V1 resume can be linked at most once, by primary key', () => {
  assert.ok(
    /v1_resume_id uuid primary key/.test(SQL_CODE),
    'the one-link guarantee must be a primary key, so it can never be null'
  )
  assert.ok(
    /create unique index[\s\S]*?resume_v1_migration_links \(v2_resume_id\)/.test(SQL_CODE),
    'two V1 resumes must not be able to claim the same V2 row'
  )
})

test('the ledger has RLS enabled and no policy at all', () => {
  assert.ok(SQL_CODE.includes('enable row level security'))
  assert.equal(
    /create policy[^;]*resume_v1_migration_links/.test(SQL_CODE), false,
    'a policy would be a way through; the ledger must have none'
  )
})

test('the browser is granted nothing on the ledger, and nobody may delete', () => {
  const ledgerGrants = [...SQL_CODE.matchAll(/^grant ([\s\S]*?) on table public\.resume_v1_migration_links to (\w+);/gm)]
  assert.ok(ledgerGrants.length > 0, 'no grants found -- has the table been renamed?')
  for (const [, privileges, role] of ledgerGrants) {
    assert.equal(role, 'service_role', `the ledger is granted to ${role}`)
    assert.equal(privileges.includes('delete'), false, 'migration history must not be deletable')
  }
  assert.ok(
    SQL_CODE.includes('revoke all privileges on table public.resume_v1_migration_links'),
    'the default Supabase grants must be revoked first -- GRANT is additive'
  )
})

test('service_role may stamp completion but may not rewrite what a link names', () => {
  assert.ok(
    /grant update \(completed_at\)\s+on table public\.resume_v1_migration_links to service_role;/.test(SQL_CODE),
    'the update grant must be column-scoped to completed_at'
  )
  const wideUpdate = /^grant [^(]*update[^(]* on table public\.resume_v1_migration_links/m.test(SQL_CODE)
  assert.equal(wideUpdate, false, 'a table-level UPDATE would let a run rewrite history')
})

test('006 keeps both hardened functions SECURITY DEFINER with a pinned search_path', () => {
  const definers = [...SQL_CODE.matchAll(/security definer\s*\nset search_path = ''/g)]
  assert.equal(definers.length, 2, 'both functions must stay definer with an empty search_path')
  assert.equal(
    [...SQL_CODE.matchAll(/create or replace function/g)].length, 2,
    'exactly two functions are replaced'
  )
})

test('006 resolves resume ownership before recording it', () => {
  // The correction: a caller may no longer attribute a ledger row to a resume
  // they do not own, and may no longer learn whether a uuid exists by trying.
  const owned = [...SQL_CODE.matchAll(/where r\.id = p_resume_id\s*\n\s*and r\.user_id = v_user/g)]
  assert.equal(owned.length, 2, 'both functions must scope p_resume_id to the caller')
  assert.equal(
    SQL_CODE.includes('values (\n    v_user,\n    p_resume_id,'), false,
    'record_ai_usage still inserts the unchecked parameter'
  )
})

test('006 grants execute to authenticated and nothing to anon', () => {
  assert.equal([...SQL_CODE.matchAll(/grant execute on function/g)].length, 2)
  assert.equal([...SQL_CODE.matchAll(/revoke all on function [\s\S]*? from anon;/g)].length, 2)
  // Matching `grant ... to anon` rather than the bare phrase: "to anon" also
  // appears in a COMMENT ON string literal, which is documentation, not a grant.
  const anonGrants = [...SQL_CODE.matchAll(/^grant [\s\S]*? to [^;]*\banon\b/gm)]
  assert.deepEqual(anonGrants.map((m) => m[0]), [], 'anon must be granted nothing')
  const publicGrants = [...SQL_CODE.matchAll(/^grant [\s\S]*? to [^;]*\bpublic\b/gm)]
  assert.deepEqual(publicGrants.map((m) => m[0]), [], 'PUBLIC must be granted nothing')
})

test('the writer, the script and 006 agree on the ledger shape', () => {
  const writer = code('lib/resume/migrate/writer.ts')
  const script = code('scripts/migrate-v1-resumes.ts')
  assert.ok(script.includes('resume_v1_migration_links'), 'the script names the ledger')
  assert.ok(SQL_CODE.includes('resume_v1_migration_links'))
  for (const column of ['v1_resume_id', 'v2_resume_id', 'user_id']) {
    assert.ok(writer.includes(column), `the writer does not build ${column}`)
    assert.ok(SQL_CODE.includes(column), `006 does not define ${column}`)
  }
  assert.ok(script.includes('completed_at'))
  assert.ok(SQL_CODE.includes('completed_at'))
})

test('nothing in the application reads or writes the ledger', () => {
  const offenders: string[] = []
  for (const dir of ['app', 'components']) {
    for (const file of walk(join(ROOT, dir))) {
      if (/resume_v1_migration_links/.test(readFileSync(file, 'utf8'))) {
        offenders.push(file.slice(ROOT.length))
      }
    }
  }
  assert.deepEqual(offenders, [], 'the migration ledger must be invisible to the app')
})

test('no migration has been applied -- all nine are still text in the repo', () => {
  const present = new Set(readdirSync(join(ROOT, 'supabase/migrations')))
  const expected = [
    '20260910_000_resume_schema_capture.sql',
    '20260910_001_resume_v2_foundation.sql',
    '20260910_002_resume_v2_save_rpc.sql',
    '20260910_003_resume_v2_create_rpc.sql',
    '20260910_004_resume_ai_usage.sql',
    '20260910_005_resume_imports.sql',
    '20260911_006_resume_v2_migration_link.sql',
    '20260912_007_resume_v2_write_boundary.sql',
    '20260912_008_user_profiles_entitlement_guard.sql',
  ]
  for (const file of expected) {
    assert.ok(present.has(file), `${file} is missing from the migration set`)
  }
  // Order is load-bearing, and filename order is apply order: 001 adds the
  // columns 002/003 need, 007 replaces the functions 002/003 create, and 008
  // secures the tier column 007 reads. Sorted, they must come out in this order.
  assert.deepEqual([...expected].sort(), expected, 'the intended apply order is not the sort order')
})

// ---------------------------------------------------------------------------
// The retained V1 API
// ---------------------------------------------------------------------------

test('the retired V1 scoring endpoint is still deleted', () => {
  assert.equal(
    existsSync(join(ROOT, 'app/api/resume/score/route.ts')), false,
    'the insecure service-role scoring route was restored'
  )
})

test('nothing in V1 calls the deleted scoring endpoint any more', () => {
  const offenders: string[] = []
  for (const file of walk(join(ROOT, 'app'))) {
    const text = readFileSync(file, 'utf8')
    // The explanatory comment in the preview page names the path; a real call
    // would be inside a fetch.
    if (/fetch\(\s*['"`]\/api\/resume\/score/.test(text)) offenders.push(file.slice(ROOT.length))
  }
  assert.deepEqual(offenders, [], 'V1 still calls a route that no longer exists')
})

test('the retained V1 enhance route is authenticated and rate limited', () => {
  const route = code('app/api/resume/enhance/route.ts')

  assert.ok(route.includes('authenticateRequest()'), 'the session check is gone')
  assert.ok(route.includes('checkAiRate'), 'the shared abuse ceiling is not applied')
  assert.ok(route.includes('AI_RATE_LIMITS'), 'it does not use the shared limits')
  assert.ok(route.includes('record_ai_usage'), 'usage is not recorded')
  assert.ok(route.includes('settle_ai_usage'), 'usage is not settled')
  assert.ok(route.includes('429'), 'there is no rate-limit response')

  for (const forbidden of ['SERVICE_ROLE', 'service_role', 'supabase-admin']) {
    assert.equal(route.includes(forbidden), false, `the route uses ${forbidden}`)
  }
})

test('the V1 enhance rate check runs before the model call', () => {
  const route = code('app/api/resume/enhance/route.ts').replace(/^import .*$/gm, '')
  const handler = route.slice(route.indexOf('export async function POST'))
  const auth = handler.indexOf('authenticateRequest()')
  const rate = handler.indexOf('rateDecision(')
  const model = handler.indexOf('openai.chat.completions.create')

  assert.ok(auth !== -1 && rate !== -1 && model !== -1, 'the handler lost a step')
  assert.ok(auth < rate, 'the rate check runs before the caller is known')
  assert.ok(rate < model, 'a refused request would still pay for a model call')
})

test('the V1 enhance 429 mentions no plan, quota or upgrade', () => {
  const route = code('app/api/resume/enhance/route.ts')
  const block = route.slice(route.indexOf('if (!rate.allowed)'), route.indexOf('const { icuPosition }'))
  for (const word of ['upgrade', 'plan', 'quota', 'remaining', 'ultimate', 'premium', 'free']) {
    assert.equal(
      block.toLowerCase().includes(word), false,
      `the rate-limit path mentions "${word}" -- there is no quota to describe`
    )
  }
})

test('a failed model call is settled rather than left counted as attempted', () => {
  const route = code('app/api/resume/enhance/route.ts')
  assert.ok(route.includes("settle(db, usageId, 'failed')"), 'a model failure is not settled')
  assert.ok(route.includes("settle(db, usageId, 'proposed')"), 'a success is not settled')
})

// ---------------------------------------------------------------------------
// The dashboard can reach the Studio
// ---------------------------------------------------------------------------

/**
 * The cards were a dead end: the title started an inline rename and nothing on
 * the dashboard linked to /resume-studio/[id], so a saved resume could be
 * renamed, duplicated and deleted but never reopened. The route existed by
 * then; only a stale comment explaining its absence did not.
 *
 * NOTE ON READERS. These two halves need opposite ones. The link assertion goes
 * through `code()`, or it matches the prose describing the link and passes with
 * the bug still live. The stale-comment assertion must read RAW, because
 * `code()` strips the very thing it is looking for and would always pass.
 */

const CARD = 'app/resume-studio/components/dashboard/ResumeCard.tsx'
const DASHBOARD = 'app/resume-studio/components/dashboard/DashboardClient.tsx'

function raw(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

test('a dashboard card links to the Studio, in code rather than in a comment', () => {
  const card = code(CARD)
  // The tripwire: if `code()` ever stops stripping, this test silently starts
  // reading comments again and the assertions below stop meaning anything.
  assert.notEqual(raw(CARD), card, 'ResumeCard has no comments left to strip -- check code()')

  assert.ok(card.includes('/resume-studio/${resume.id}'), 'the card does not link to the Studio')
})

/**
 * The card has always had a <Link> -- the "Upgrade to finalize" one -- so a bare
 * `/<Link/` here would pass against the very code this guards against. Pick out
 * the opening tag that carries the Studio href and assert on that alone.
 */
function titleLinkAttributes(card: string): string {
  const chunk = card.split('<Link').find((part) => part.includes('/resume-studio/${resume.id}'))
  assert.ok(chunk, 'no Link element points at the Studio')
  return chunk.slice(0, chunk.indexOf('>'))
}

test('the card title opens the resume and is not wired straight to rename', () => {
  const card = code(CARD)
  const attrs = titleLinkAttributes(card)

  assert.ok(attrs.includes('onOpen'), 'the title link does not hand the click upward')
  assert.ok(attrs.includes('prefetch={false}'), 'the title link prefetches, costing a read per card')
  assert.equal(
    attrs.includes('onStartRename'), false,
    'the title is still wired to rename -- that is the defect this fixes'
  )
  // Rename did not disappear, it moved to a control that says so.
  assert.ok(card.includes('onClick={onStartRename}'), 'nothing starts a rename any more')
  assert.ok(/>\s*Rename\s*<\/button>/.test(card), 'there is no Rename button')
})

test('the row actions name the resume they act on', () => {
  const card = code(CARD)
  for (const action of ['Rename', 'Duplicate', 'Delete']) {
    assert.ok(
      card.includes(`aria-label={\`${action} \${resume.title}\`}`),
      `${action} renders the same accessible name on every card`
    )
  }
})

test('the stale "cards deliberately do not link" comment is gone', () => {
  // RAW on purpose -- see the note above.
  const source = raw(DASHBOARD)
  assert.equal(
    /deliberately do not link/.test(source), false,
    'the comment still claims the Studio route does not exist'
  )
  assert.equal(
    /Phase 5/.test(source), false,
    'the card comment still defers the section editor to a finished phase'
  )
})

/**
 * `hasUnsavedWork(saveRef.current)` and `event.preventDefault()` both already
 * appear in this file -- in `startRename` and the beforeunload guard -- so
 * these have to be read inside `openResume` or they prove nothing. Sliced on
 * code landmarks, never on a comment banner: `code()` strips those first.
 */
function openResumeBody(dashboard: string): string {
  const start = dashboard.indexOf('const openResume')
  const end = dashboard.indexOf('const command = async')
  assert.ok(start > 0, 'openResume is gone -- the open path has no guard to check')
  assert.ok(end > start, 'the `command` landmark moved; this slice reads the wrong code')
  return dashboard.slice(start, end)
}

test('opening a card waits for an unsaved rename instead of racing the unmount', () => {
  const dashboard = code(DASHBOARD)
  const open = openResumeBody(dashboard)

  assert.ok(open.includes('hasUnsavedWork(saveRef.current)'), 'the open path checks nothing')
  assert.ok(open.includes('event.preventDefault()'), 'the navigation is never deferred')
  assert.ok(open.includes('setWantsOpen'), 'nothing records the resume to open afterwards')
  assert.ok(
    /router\.push\(`\/resume-studio\/\$\{wantsOpen\}`\)/.test(dashboard),
    'the deferred navigation never happens'
  )
  // A conflict and an exhausted failure are terminal until the applicant acts,
  // so waiting on them would leave the click permanently dead.
  assert.ok(
    /save\.status === 'conflict' \|\| save\.status === 'failed'/.test(dashboard),
    'a stuck save would block the click forever with no way out'
  )
})

test('a modified click is left to the browser', () => {
  const open = openResumeBody(code(DASHBOARD))
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.ok(open.includes(`event.${key}`), `${key} clicks are swallowed, breaking open-in-new-tab`)
  }
  assert.ok(open.includes('event.button !== 0'), 'non-primary clicks are swallowed')
})
