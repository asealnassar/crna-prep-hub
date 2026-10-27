/**
 * The promise that local review cannot write to production.
 *
 * This is the file to read first when deciding whether simulated-live mode is
 * safe. Everything else is convenience; this is the boundary.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { simulatedLiveEnabled } from './gate.ts'
import { SimulatedLiveWriteBlocked, statementDbClient } from './guardedClient.ts'
import { localDraftsBuilder } from './localDrafts.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
/** Comments out, code in -- the same stripper reviewPrompt.test.ts uses. */
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// ------------------------------------------------------------------ the gate

test('the mode is OFF in every environment that is not development', () => {
  for (const NODE_ENV of ['production', 'test', undefined, '', 'Development', 'dev']) {
    assert.equal(simulatedLiveEnabled({ NODE_ENV } as NodeJS.ProcessEnv), false, String(NODE_ENV))
  }
})

test('the mode is ON in development, and can be turned off but never on', () => {
  assert.equal(simulatedLiveEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), true)
  assert.equal(simulatedLiveEnabled({
    NODE_ENV: 'development', STATEMENT_SIMULATED_LIVE: 'off' } as NodeJS.ProcessEnv), false)
  // NO VALUE OF THE OPT-OUT TURNS IT ON OUTSIDE DEVELOPMENT. NODE_ENV is checked
  // first and independently, so a deployed build cannot be talked into it.
  for (const value of ['on', 'true', '1', 'yes', 'ON']) {
    assert.equal(simulatedLiveEnabled({
      NODE_ENV: 'production', STATEMENT_SIMULATED_LIVE: value } as NodeJS.ProcessEnv), false, value)
  }
})

test('THE BOUNDARY IS NOT A CLIENT-VISIBLE VARIABLE', () => {
  // EXECUTABLE CODE ONLY. gate.ts explains in prose why a NEXT_PUBLIC_* value
  // is not a boundary, and scanning raw text would fail on the explanation.
  const code = read('./gate.ts')
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')
      && !line.trim().startsWith('/*'))
    .join('\n')
  assert.doesNotMatch(code, /NEXT_PUBLIC_/)
  assert.match(code, /env\.NODE_ENV !== 'development'/)
})

// -------------------------------------------------------- the write guard

test('EVERY MUTATION THROWS in simulated-live mode', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon'
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  try {
    const db = statementDbClient('token')
    // every table except statement_drafts, which is served locally
    for (const table of ['statement_requirement_sets', 'statement_requirements',
      'statement_prompts', 'statement_analyses', 'resume_ai_usage', 'schools',
      'user_profiles']) {
      for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
        assert.throws(
          () => (db.from(table) as unknown as Record<string, () => unknown>)[operation]!(),
          SimulatedLiveWriteBlocked,
          `${operation} on ${table}`)
      }
    }
    // and every RPC, which is how usage accounting and the analysis cache write
    for (const fn of ['record_ai_usage', 'settle_ai_usage',
      'claim_statement_analysis', 'settle_statement_analysis']) {
      assert.throws(() => db.rpc(fn), SimulatedLiveWriteBlocked, fn)
    }
  } finally {
    process.env.NODE_ENV = previous
  }
})

test('reads are NOT blocked — the guard refuses writes only', () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  try {
    const db = statementDbClient('token')
    // building a read must not throw (it is not awaited, so nothing is sent)
    assert.doesNotThrow(() => db.from('statement_requirement_sets').select('id'))
  } finally {
    process.env.NODE_ENV = previous
  }
})

test('OUTSIDE development the client is the real one, unguarded and unchanged', () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const db = statementDbClient('token')
    // A production build must behave exactly as it did before this file existed:
    // building an insert is allowed here, because this is the real client.
    assert.doesNotThrow(() => db.from('statement_drafts').insert({ title: 'x' }))
  } finally {
    process.env.NODE_ENV = previous
  }
})

test('every statement server path goes through the one guarded helper', () => {
  const sites = [
    '../../../app/api/statement/drafts/route.ts',
    '../../../app/api/statement/drafts/[id]/route.ts',
    '../../../app/api/statement/drafts/[id]/analyze/route.ts',
    '../../../app/api/statement/extract/route.ts',
    '../../../app/api/statement/requirements/route.ts',
    '../../../app/api/statement/prompts/route.ts',
    '../../../app/api/statement/prompt-submissions/route.ts',
    '../../../app/statement-studio/page.tsx',
    '../../../app/statement-studio/[id]/page.tsx',
  ]
  for (const rel of sites) {
    const src = read(rel)
    // A path that built its own client would bypass the guard entirely, which
    // is the one regression that would make this whole mode unsafe.
    assert.doesNotMatch(src, /createClient\(/, `${rel} must not build its own client`)
  }
})

// ------------------------------------------------------------ local drafts

/**
 * This suite's own rows, and the only ones it may ever touch.
 *
 * ---------------------------------------------------------------------------
 * IT USED TO EMPTY THE DEVELOPER'S STORE INSTEAD
 * ---------------------------------------------------------------------------
 * The round-trip test opened and closed with resetLocalDrafts(), which writes
 * `[]`. The sibling end-to-end suites each point STATEMENT_LOCAL_DRAFTS_FILE
 * at a file of their own, but this one could not: it imports guardedClient.ts
 * statically, guardedClient imports localDrafts.ts, and localDrafts resolves
 * its path once at load -- so by the time any statement in this file runs the
 * store is already the default one, local-review/dev-drafts.json. That is the
 * file the browser session reads and writes, so a full test run deleted every
 * draft a developer had made by hand.
 *
 * SCOPED, NOT GLOBAL. The test never needed an empty store, only an empty
 * slice of one: it already inserts and deletes under a user id of its own.
 * Clearing just that id leaves everything else alone and asserts exactly what
 * it asserted before.
 */
const TEST_USER = 'u1'
const clearTestRows = async () => {
  await localDraftsBuilder().delete().eq('user_id', TEST_USER).select('id')
}

test('drafts round-trip through the local store, not the database', async () => {
  await clearTestRows()
  const created = await localDraftsBuilder()
    .insert({ user_id: 'u1', title: 'Local test', essay: 'hello' })
    .select('*').maybeSingle()
  assert.equal(created.error, null)
  const row = created.data as Record<string, unknown>
  assert.equal(row.title, 'Local test')
  assert.equal(row.revision, 1)
  assert.ok(typeof row.id === 'string' && row.id.length > 0)
  // absent columns are null, never undefined -- the row parsers distinguish them
  assert.equal(row.school_id, null)
  assert.equal(row.requirement_id, null)

  const listed = await localDraftsBuilder()
    .select('*').eq('user_id', 'u1').order('updated_at', { ascending: false })
  assert.equal((listed.data as unknown[]).length, 1)

  const updated = await localDraftsBuilder()
    .update({ essay: 'edited', revision: 2 })
    .eq('id', row.id).eq('revision', 1).select('*').maybeSingle()
  assert.equal((updated.data as Record<string, unknown>).essay, 'edited')

  // THE REVISION CONFLICT PATH IS REACHABLE, which is the behaviour draftRepo's
  // optimistic concurrency is built on -- a stale write must find no row.
  const stale = await localDraftsBuilder()
    .update({ essay: 'stale' }).eq('id', row.id).eq('revision', 1)
    .select('*').maybeSingle()
  assert.equal(stale.data, null)
  assert.equal(stale.error, null)

  const deleted = await localDraftsBuilder()
    .delete().eq('id', row.id).select('id').maybeSingle()
  assert.ok(deleted.data)
  assert.equal((await localDraftsBuilder().select('*').eq('user_id', 'u1')).data
    ? ((await localDraftsBuilder().select('*').eq('user_id', 'u1')).data as unknown[]).length
    : -1, 0)
  await clearTestRows()
})

/**
 * NO SUITE MAY EMPTY A STORE THE BROWSER SESSION USES.
 *
 * ---------------------------------------------------------------------------
 * THE REGRESSION THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * The three reset helpers write `[]` over a whole store. Pointed at a default
 * file they delete a developer's own drafts, submissions or catalog entries,
 * and a test suite is the last place anybody looks for that. It happened: this
 * very file called resetLocalDrafts() with no override, so running the suite
 * emptied local-review/dev-drafts.json.
 *
 * SO THE RULE IS CHECKED, NOT REMEMBERED. A suite that clears a store must
 * first have pointed that store somewhere of its own, and the override has to
 * be one that can take effect -- which, because every store module resolves
 * its path once at load, means the file must reach the module through a
 * dynamic import rather than a static one.
 *
 * SCANNED OVER THE SOURCE, so a new suite is covered the moment it is written
 * and nobody has to add it to a list here.
 */
test('no test suite clears a store without first pointing it somewhere of its own', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const suites = readdirSync(dir).filter((name) => name.endsWith('.test.ts'))
  const stores = [
    { reset: 'resetLocalDrafts', env: 'STATEMENT_LOCAL_DRAFTS_FILE' },
    { reset: 'resetLocalSubmissions', env: 'STATEMENT_LOCAL_SUBMISSIONS_FILE' },
    { reset: 'resetLocalCanonical', env: 'STATEMENT_LOCAL_CANONICAL_FILE' },
  ] as const

  for (const suite of suites) {
    const src = stripTs(readFileSync(join(dir, suite), 'utf8'))
    for (const store of stores) {
      // A CALL, NOT A MENTION: `resetLocalDrafts(` and not the name in an
      // import list or an assertion about the source.
      if (!new RegExp(`${store.reset}\\s*\\(`).test(src)) continue
      assert.match(src, new RegExp(`process\\.env\\.${store.env}\\s*=`),
        `${suite} clears ${store.reset} without setting ${store.env}`)
      // AND THE OVERRIDE MUST BE REACHABLE. A static import of the store
      // module -- directly, or through guardedClient, localSubmissions or
      // localCatalog, which import the store modules themselves -- is
      // evaluated before any statement in the file runs, so the assignment
      // lands too late to move anything.
      assert.doesNotMatch(src,
        /^import\s[\s\S]*?from\s+'\.\/(localDrafts|localSubmissions|localCanonical|localCatalog|guardedClient)\.ts'/m,
        `${suite} sets ${store.env}, but a static import freezes the path first`)
    }
  }
})

test('the local store writes only inside local-review/, which is gitignored', () => {
  const src = read('./localDrafts.ts')
  // THE DIRECTORY IS A LITERAL and the file name is reduced to a basename, so
  // the store cannot be relocated by configuration. The default is still the
  // file the browser session uses.
  assert.match(src, /'local-review',/)
  assert.match(src, /path\.basename\(process\.env\.STATEMENT_LOCAL_DRAFTS_FILE \?\? 'dev-drafts\.json'\)/)
  // basename() IS THE PROOF, so there is nothing to assert about the value: no
  // string it is given can carry a directory part through.
  const ignore = read('../../../.gitignore')
  assert.match(ignore, /local-review\//)
})

test('THE HELPER HOLDS THE ANON KEY AND NEVER THE SERVICE ROLE', () => {
  // The property the per-route source assertions used to prove inline. It moved
  // here when every path started taking its client from one helper, and this is
  // now the single place it is checked -- which is better, not weaker: there is
  // one line of code that could ever hold a service role key.
  const src = read('./guardedClient.ts')
  // JUDGED ON CODE, NOT ON WORDS. The comments in this module necessarily
  // discuss service_role -- they explain why the admin review path is the only
  // thing that ever holds one and why this client never does. Stripping them
  // makes the assertion about the one thing that matters: no line of code names
  // a service-role key.
  const code = stripTs(src)
  assert.doesNotMatch(code, /SERVICE_ROLE/i)
  assert.doesNotMatch(code, /service_role/)
  assert.ok(code.includes('createClient('), 'the stripper removed the code too')
  assert.match(src, /NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  assert.match(src, /Authorization: `Bearer \$\{token\}`/)
  assert.match(src, /autoRefreshToken: false, persistSession: false/)
})
