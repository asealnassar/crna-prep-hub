import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The migrations, asserted as text.
 *
 * There is no local Postgres in this environment -- no DATABASE_URL, no linked
 * Supabase CLI -- so these files cannot be executed here. What CAN be pinned
 * is that they say what Phase 2 requires them to say, and that no later edit
 * quietly removes a safety property.
 */

const dir = new URL('../../../supabase/migrations/', import.meta.url)
const capture = readFileSync(new URL('20260910_000_resume_schema_capture.sql', dir), 'utf8')
const foundation = readFileSync(new URL('20260910_001_resume_v2_foundation.sql', dir), 'utf8')
const rpc = readFileSync(new URL('20260910_002_resume_v2_save_rpc.sql', dir), 'utf8')
const createRpc = readFileSync(new URL('20260910_003_resume_v2_create_rpc.sql', dir), 'utf8')
/** Executable SQL only, so a comment cannot satisfy an assertion. */
const sql = (s: string) => s.replace(/^\s*--.*$/gm, ' ')
const captureSql = sql(capture)
const foundationSql = sql(foundation)
const rpcSql = sql(rpc)
const createSql = sql(createRpc)

// ---------------------------------------------------------- data safety

test('neither migration destroys or rewrites data', () => {
  for (const [name, body] of [['capture', captureSql], ['foundation', foundationSql], ['rpc', rpcSql], ['create-rpc', createSql]] as const) {
    assert.doesNotMatch(body, /\bdrop table\b/i, `${name}: no drop table`)
    assert.doesNotMatch(body, /\bdrop column\b/i, `${name}: no drop column`)
    assert.doesNotMatch(body, /\btruncate\b/i, `${name}: no truncate`)
    if (name !== 'rpc') {
      assert.doesNotMatch(body, /\bdelete from\b/i, `${name}: no delete`)
    }
    // The RPC contains DML by design; it is a function body, not a data change
    // performed by the migration itself.
    if (name !== 'rpc') {
      assert.doesNotMatch(body, /^\s*update\s+public\./im, `${name}: no data rewrite`)
    }
  }
})

test('both migrations are wrapped in a single transaction', () => {
  for (const [name, body] of [['capture', captureSql], ['foundation', foundationSql], ['rpc', rpcSql], ['create-rpc', createSql]] as const) {
    assert.equal((body.match(/^begin;/gim) ?? []).length, 1, `${name}: one begin`)
    assert.equal((body.match(/^commit;/gim) ?? []).length, 1, `${name}: one commit`)
  }
})

test('every table and index creation is idempotent', () => {
  const creates = captureSql.match(/create table[^(]*/gi) ?? []
  assert.equal(creates.length, 3)
  for (const c of creates) assert.match(c, /if not exists/i, c)
  for (const c of captureSql.match(/create index[^(]*/gi) ?? []) {
    assert.match(c, /if not exists/i, c)
  }
})

test('every added column is idempotent and cannot break V1', () => {
  const adds = foundationSql.match(/add column[^;]+/gi) ?? []
  assert.equal(adds.length, 8, 'six on resumes, two on resume_sections')
  for (const a of adds) {
    assert.match(a, /if not exists/i, a)
    // A NOT NULL column with no default would fail against existing rows.
    if (/not null/i.test(a)) assert.match(a, /default/i, `NOT NULL needs a default: ${a}`)
  }
})

// ------------------------------------------------- captured schema fidelity

test('the capture reproduces all three tables with cascading foreign keys', () => {
  for (const table of ['resumes', 'resume_sections', 'resume_scores']) {
    assert.match(captureSql, new RegExp(`create table if not exists public\\.${table}`), table)
  }
  const cascades = captureSql.match(/on delete cascade/gi) ?? []
  assert.equal(cascades.length, 3, 'user_id, and both resume_id foreign keys')
  assert.match(captureSql, /references auth\.users\(id\) on delete cascade/i)
})

test('the capture never drops a policy', () => {
  // An earlier draft dropped and recreated each one, which re-asserts every
  // security predicate from a transcription instead of leaving production's
  // own policies alone.
  assert.doesNotMatch(captureSql, /drop policy/i)
  assert.doesNotMatch(captureSql, /alter policy/i)
})

test('every policy creation is guarded by a catalog check', () => {
  const creates = captureSql.match(/create policy "([^"]+)"/gi) ?? []
  assert.equal(creates.length, 11, '4 resumes + 4 sections + 3 scores')
  for (const create of creates) {
    const name = /create policy "([^"]+)"/i.exec(create)![1]
    assert.match(
      captureSql,
      new RegExp(`policyname = '${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `${name} must be guarded by a pg_policies check`
    )
  }
  // Every create sits inside an EXECUTE within a guard block.
  for (const create of creates) {
    assert.match(captureSql, new RegExp(`execute '${create.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), create)
  }
})

test('the captured resume_scores gap is preserved, not quietly closed', () => {
  assert.doesNotMatch(captureSql, /on public\.resume_scores for delete/i)
})

test('RLS enablement is guarded too, so no needless exclusive lock is taken', () => {
  assert.equal((captureSql.match(/enable row level security/gi) ?? []).length, 3)
  const guards = captureSql.slice(0, captureSql.lastIndexOf('commit;'))
  assert.equal((guards.match(/relrowsecurity/gi) ?? []).length, 3, 'one guard per table')
  for (const table of ['resumes', 'resume_sections', 'resume_scores']) {
    assert.match(captureSql, new RegExp(`c\\.relname = '${table}'`), table)
  }
})

test('the capture is create-only: every statement is conditional', () => {
  const unguarded = captureSql
    .split(/\n/)
    .filter((line) => /^\s*(alter table|create policy|create table|create index)/i.test(line))
    .filter((line) => !/if not exists/i.test(line))
  assert.deepEqual(unguarded, [], `unguarded statements: ${unguarded.join(' | ')}`)
})

test('the capture does not enshrine the broken grants', () => {
  assert.doesNotMatch(captureSql, /^\s*grant /im, 'grants belong in the hardening migration')
})

// ----------------------------------------------------- grant hardening

test('the hardening revokes before it grants', () => {
  const firstRevoke = foundationSql.search(/revoke all privileges/i)
  const firstGrant = foundationSql.search(/^\s*grant /im)
  assert.ok(firstRevoke > -1 && firstGrant > -1)
  assert.ok(firstRevoke < firstGrant, 'GRANT is additive; revoke must come first')
})

test('all three tables are revoked from all three roles', () => {
  for (const table of ['resumes', 'resume_sections', 'resume_scores']) {
    assert.match(
      foundationSql,
      new RegExp(`revoke all privileges on table public\\.${table}\\s+from anon, authenticated, service_role`, 'i'),
      table
    )
  }
})

test('anon is granted nothing at all', () => {
  const grants = foundationSql.match(/^\s*grant [^;]+;/gim) ?? []
  assert.ok(grants.length > 0)
  for (const g of grants) assert.doesNotMatch(g, /\bto anon\b/i, g)
})

test('TRUNCATE, REFERENCES and TRIGGER are granted to nobody', () => {
  for (const g of foundationSql.match(/^\s*grant [^;]+;/gim) ?? []) {
    assert.doesNotMatch(g, /\btruncate\b/i, g)
    assert.doesNotMatch(g, /\breferences\b/i, g)
    assert.doesNotMatch(g, /\btrigger\b/i, g)
  }
})

test('authenticated keeps exactly what both builders use', () => {
  for (const table of ['resumes', 'resume_sections', 'resume_scores']) {
    assert.match(
      foundationSql,
      new RegExp(`grant select, insert, update, delete on table public\\.${table}\\s+to authenticated`, 'i'),
      `${table}: V1 runs as authenticated and must keep working`
    )
  }
})

// ------------------------------------------------------ V1 coexistence

test('schema_version defaults to 1, so existing rows stay V1', () => {
  assert.match(foundationSql, /add column if not exists schema_version integer not null default 1/i)
})

test('visible defaults to true, so no existing section is hidden', () => {
  assert.match(foundationSql, /add column if not exists visible boolean not null default true/i)
})

test('status and revision are constrained rather than free text', () => {
  assert.match(foundationSql, /check \(status in \('draft', 'complete'\)\)/i)
  assert.match(foundationSql, /check \(revision >= 1\)/i)
  assert.match(foundationSql, /check \(schema_version in \(1, 2\)\)/i)
})

test('the strength score is nullable and range-checked', () => {
  assert.match(foundationSql, /strength_score is null or \(strength_score between 0 and 100\)/i)
  assert.doesNotMatch(foundationSql, /add column if not exists strength_score integer not null/i)
})

test('constraints are dropped before being added, so a re-run is safe', () => {
  const added = (foundationSql.match(/add constraint (\w+)/gi) ?? [])
    .map((m) => m.replace(/add constraint /i, ''))
  assert.ok(added.length >= 4)
  for (const name of added) {
    assert.match(foundationSql, new RegExp(`drop constraint if exists ${name}`, 'i'), name)
  }
})

test('no trigger is created, and the reason is recorded', () => {
  assert.doesNotMatch(foundationSql, /create trigger/i)
  assert.doesNotMatch(captureSql, /create trigger/i)
  assert.match(foundation, /V2 sets updated_at explicitly/i, 'the choice is documented')
})

test('no table is created by the foundation migration', () => {
  assert.doesNotMatch(foundationSql, /create table/i)
  assert.match(foundation, /WHY NO NEW TABLES/i, 'and the omission is explained')
})

test('both migrations end with read-only verification', () => {
  for (const [name, body] of [['capture', capture], ['foundation', foundation]] as const) {
    const after = body.slice(body.lastIndexOf('commit;'))
    assert.match(after, /VERIFICATION \(read-only\)/i, name)
    assert.match(after, /^select /im, `${name}: has verification queries`)
    assert.doesNotMatch(after, /^\s*(update|delete|insert|alter|drop)\b/im, `${name}: verification is read-only`)
  }
})

// ===========================================================================
// The atomic save RPC.
//
// Its atomicity can only be proved against a real database. What is pinned
// here is every property that a later edit could silently remove: the security
// mode, the ordering of the compare-and-swap against the first write, and the
// two reparenting guards.
// ===========================================================================

test('the function is SECURITY INVOKER, so RLS stays the authority', () => {
  assert.match(rpcSql, /security invoker/i)
  assert.doesNotMatch(rpcSql, /security definer/i)
  assert.match(rpcSql, /set search_path = ''/)
})

test('the function creates no service-role client and needs no elevated role', () => {
  assert.doesNotMatch(rpcSql, /service_role/i)
  assert.doesNotMatch(rpcSql, /bypassrls/i)
})

test('execute is revoked from public and anon, granted only to authenticated', () => {
  assert.match(rpcSql, /revoke all on function public\.save_resume_v2\([^)]*\) from public/i)
  assert.match(rpcSql, /revoke all on function public\.save_resume_v2\([^)]*\) from anon/i)
  assert.match(rpcSql, /grant execute on function public\.save_resume_v2\([^)]*\) to authenticated/i)
  assert.doesNotMatch(rpcSql, /grant execute[^;]*to anon/i)
})

test('the compare-and-swap gates the update and is the FIRST write', () => {
  const body = rpcSql.slice(rpcSql.indexOf('$fn$'))
  const cas = body.search(/update public\.resumes/i)
  assert.ok(cas > -1, 'the CAS exists')
  assert.match(body.slice(cas, cas + 900), /where id = p_resume_id\s+and revision = p_expected_revision\s+and schema_version = 2/i)

  // Nothing that writes may appear before it. A plpgsql `return` does not roll
  // back — the function runs inside the caller's transaction — so an early
  // write would commit even on a refusal.
  const before = body.slice(0, cas)
  assert.doesNotMatch(before, /\binsert\s+into\b/i, 'no insert before the CAS')
  assert.doesNotMatch(before, /\bdelete\s+from\b/i, 'no delete before the CAS')
  assert.doesNotMatch(before, /\bupdate\s+public\./i, 'no other update before the CAS')
})

test('a failed CAS returns without touching sections', () => {
  const body = rpcSql.slice(rpcSql.indexOf('$fn$'))
  const notFound = body.indexOf('if not found then')
  const sectionWrite = body.search(/delete from public\.resume_sections/i)
  assert.ok(notFound > -1 && sectionWrite > notFound, 'the refusal branch precedes any section write')
  const branch = body.slice(notFound, sectionWrite)
  assert.match(branch, /'stale-revision'/)
  assert.match(branch, /'not-found'/)
  assert.match(branch, /'wrong-schema-version'/)
})

test('every refusal reason the repo understands is produced by the function', () => {
  for (const reason of ['stale-revision', 'not-found', 'wrong-schema-version',
                        'section-conflict', 'malformed-payload']) {
    assert.match(rpcSql, new RegExp(`'${reason}'`), reason)
  }
})

test('a section cannot be reparented between the caller’s own resumes', () => {
  // RLS cannot catch this: both rows legitimately belong to the caller.
  assert.match(rpcSql, /where s\.resume_id <> p_resume_id/i, 'the pre-flight guard')
  assert.match(rpcSql, /'section-conflict'/)
  // And the insert forces resume_id rather than trusting the payload.
  const insert = rpcSql.slice(rpcSql.search(/insert into\s+public\.resume_sections/i))
  assert.match(insert, /select \(e->>'id'\)::uuid,\s*p_resume_id/i, 'resume_id is forced, not read')
  assert.doesNotMatch(insert.slice(0, 400), /e->>'resume_id'/, 'never taken from the payload')
})

test('timestamps come from the database clock, not the client', () => {
  assert.match(rpcSql, /v_now\s+timestamptz := now\(\)/i)
  assert.doesNotMatch(rpcSql, /e->>'updated_at'/, 'a client cannot backdate a save')
  assert.doesNotMatch(rpcSql, /p_resume->>'updated_at'/)
})

test('the revision is set by the function, never accepted from the client', () => {
  assert.match(rpcSql, /revision\s+= p_expected_revision \+ 1/i)
  assert.doesNotMatch(rpcSql, /p_resume->>'revision'/, 'the payload cannot set a revision')
})

test('orphan removal is scoped to this resume and driven by the payload', () => {
  const del = rpcSql.slice(rpcSql.search(/delete from public\.resume_sections/i))
  assert.match(del.slice(0, 400), /where s\.resume_id = p_resume_id/i, 'never deletes another resume’s rows')
  assert.match(del.slice(0, 400), /not exists/i)
})

test('the result is returned as jsonb rather than raised', () => {
  assert.match(rpcSql, /returns jsonb/i)
  assert.doesNotMatch(rpcSql, /raise exception/i, 'a raise would be an opaque 500 to the client')
  assert.match(rpcSql, /jsonb_build_object\('ok', true/i)
  assert.match(rpcSql, /jsonb_build_object\('ok', false/i)
})

test('a malformed sections payload is refused before any write', () => {
  const body = rpcSql.slice(rpcSql.indexOf('$fn$'))
  const check = body.search(/jsonb_typeof\(p_sections\)/i)
  const firstWrite = body.search(/update public\.resumes/i)
  assert.ok(check > -1 && check < firstWrite, 'checked before the CAS')
})

test('the RPC migration verifies its own security mode after applying', () => {
  const after = rpc.slice(rpc.lastIndexOf('commit;'))
  assert.match(after, /prosecdef/i, 'confirms SECURITY INVOKER against the catalog')
  assert.match(after, /routine_privileges/i, 'confirms who may execute it')
  assert.doesNotMatch(after, /^\s*(update|delete|insert|alter|drop)\b/im, 'verification is read-only')
})

// ===========================================================================
// The atomic create RPC. Closes the last non-atomic write path: two inserts
// with a compensating delete, which left an orphaned parent -- a resume that
// renders as an empty document -- whenever that delete also failed.
// ===========================================================================

test('create is SECURITY INVOKER with a pinned search_path', () => {
  assert.match(createSql, /security invoker/i)
  assert.doesNotMatch(createSql, /security definer/i)
  assert.match(createSql, /set search_path = ''/)
  assert.doesNotMatch(createSql, /service_role/i)
})

test('create execute is revoked from public and anon, granted to authenticated', () => {
  assert.match(createSql, /revoke all on function public\.create_resume_v2\([^)]*\) from public/i)
  assert.match(createSql, /revoke all on function public\.create_resume_v2\([^)]*\) from anon/i)
  assert.match(createSql, /grant execute on function public\.create_resume_v2\([^)]*\) to authenticated/i)
  assert.doesNotMatch(createSql, /grant execute[^;]*to anon/i)
})

test('ownership is read from auth.uid(), never from the payload', () => {
  // This is what stops a client creating a resume for somebody else -- and,
  // because sections are inserted against that same parent in the same
  // transaction, attaching sections to another user's resume too.
  assert.match(createSql, /v_user uuid := auth\.uid\(\)/i)
  const insert = createSql.slice(createSql.search(/insert into\s+public\.resumes/i))
  assert.match(insert.slice(0, 500), /\bv_user\b/, 'user_id comes from the session')
  assert.doesNotMatch(createSql, /p_resume->>'user_id'/, 'never from the payload')
})

test('an unauthenticated call is refused before any write', () => {
  const body = createSql.slice(createSql.indexOf('$fn$'))
  const guard = body.search(/if v_user is null/i)
  const firstWrite = body.search(/insert into public\.resumes/i)
  assert.ok(guard > -1 && guard < firstWrite)
  assert.match(createSql, /'not-authenticated'/)
})

test('both inserts sit in one transaction with no compensating delete', () => {
  const body = createSql.slice(createSql.indexOf('$fn$'))
  assert.match(body, /insert into\s+public\.resumes/i)
  assert.match(body, /insert into\s+public\.resume_sections/i)
  // The old shape: insert, insert, and delete the parent if the second failed.
  assert.doesNotMatch(body, /delete from public\.resumes/i, 'no compensation needed')
})

test('the server sets schema_version, revision and both timestamps', () => {
  const insert = createSql.slice(createSql.search(/insert into\s+public\.resumes/i))
  assert.match(insert.slice(0, 700), /2, 1, v_now, v_now/, 'schema_version 2, revision 1, now(), now()')
  assert.match(createSql, /v_now\s+timestamptz := now\(\)/i)
  for (const forbidden of ['schema_version', 'revision', 'created_at', 'updated_at']) {
    assert.doesNotMatch(createSql, new RegExp(`p_resume->>'${forbidden}'`), `${forbidden} is not client-supplied`)
  }
})

test('sections are forced under the new resume id', () => {
  const insert = createSql.slice(createSql.search(/insert into\s+public\.resume_sections/i))
  assert.match(insert, /select \(e->>'id'\)::uuid,\s*p_resume_id/i)
  assert.doesNotMatch(insert.slice(0, 500), /e->>'resume_id'/)
})

test('an id collision is refused cleanly rather than raising', () => {
  assert.match(createSql, /'already-exists'/)
  // Visible collisions are caught by the pre-check; a collision with a row the
  // caller cannot see reaches the handler, which rolls the block back.
  assert.match(createSql, /exception\s+when unique_violation then/i)
  assert.match(createSql, /if exists \(select 1 from public\.resumes where id = p_resume_id\)/i)
})

test('reused section ids are refused before anything is written', () => {
  const body = createSql.slice(createSql.indexOf('$fn$'))
  const guard = body.search(/'section-conflict'/)
  const firstWrite = body.search(/insert into public\.resumes/i)
  assert.ok(guard > -1 && guard < firstWrite, 'checked before the parent insert')
})

test('create returns a structured result rather than raising', () => {
  assert.match(createSql, /returns jsonb/i)
  assert.match(createSql, /jsonb_build_object\('ok', true, 'id', p_resume_id, 'revision', 1\)/i)
  assert.match(createSql, /jsonb_build_object\('ok', false/i)
  for (const reason of ['not-authenticated', 'malformed-payload', 'already-exists', 'section-conflict']) {
    assert.match(createSql, new RegExp(`'${reason}'`), reason)
  }
})

test('both write RPCs are verified for security mode after applying', () => {
  const after = createRpc.slice(createRpc.lastIndexOf('commit;'))
  assert.match(after, /prosecdef/i)
  assert.match(after, /create_resume_v2', 'save_resume_v2'/)
  assert.doesNotMatch(after, /^\s*(update|delete|insert|alter|drop)\b/im, 'verification is read-only')
})
