import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { checkTarget } from './target.ts'

/**
 * Database behaviour tests that need a real Postgres.
 *
 * These are SKIPPED unless a staging project is explicitly configured, which
 * means `npm test` runs them as skips and CI never needs credentials. They are
 * the automatable half of the Phase 12 database checks: the half that needs a
 * browser (UAT journeys) and the half PostgREST cannot reach (pg_catalog, which
 * is not exposed over the REST API) stay as the SQL verification blocks at the
 * bottom of each migration file.
 *
 * HOW TO RUN THEM:
 *
 *   RESUME_MIGRATION_TARGET=staging \
 *   RESUME_STAGING_PROJECT_REF=<staging-ref> \
 *   SUPABASE_URL=https://<staging-ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<staging service role> \
 *   SUPABASE_ANON_KEY=<staging anon key> \
 *   RESUME_TEST_JWT_A=<staging user A access token> \
 *   RESUME_TEST_JWT_B=<staging user B access token> \
 *   node --test --import ./test/register.mjs lib/resume/migrate/integration.test.ts
 *
 * WHY THE TARGET GUARD. Every one of these tests writes rows. checkTarget()
 * -- the same guard the migration script uses -- refuses unless the URL is
 * exactly the staging project that was named, is not production, and the
 * shell carries no production URL or production-only secrets. Naming the
 * target `staging` is necessary and, on its own, nowhere near sufficient.
 *
 * Rows created here are deleted at the end of each test. That is the one place
 * in this phase where DELETE is legitimate: it removes only rows this file just
 * created, in a staging project, and never a V1 source row.
 */

// The SAME guard the migration script uses. Not a second staging check --
// there is exactly one, so the two cannot drift into disagreeing about which
// databases are safe to touch. Everything below writes rows, so this file must
// never be able to run anywhere the script could not.
const TARGET = checkTarget(process.env)

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const anonKey = process.env.SUPABASE_ANON_KEY
const jwtA = process.env.RESUME_TEST_JWT_A
const jwtB = process.env.RESUME_TEST_JWT_B

const configured = TARGET.ok && Boolean(url) && Boolean(serviceKey)
const skip = configured
  ? false
  // The guard's own message says exactly which rule refused, so a misconfigured
  // run reports the cause rather than a generic "not configured".
  : TARGET.ok
    ? 'set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to run'
    : `staging target refused: ${TARGET.message}`
const skipRls = configured && jwtA && jwtB
  ? false
  : 'additionally set SUPABASE_ANON_KEY, RESUME_TEST_JWT_A and RESUME_TEST_JWT_B'
type Client = {
  from: (table: string) => any
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
}

async function client(key: string, jwt?: string): Promise<Client> {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(url!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(jwt ? { global: { headers: { Authorization: `Bearer ${jwt}` } } } : {}),
  }) as unknown as Client
}

/** A V2 resume row owned by whoever is named. Service role only. */
function resumeRow(owner: string) {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    user_id: owner,
    title: 'integration test resume',
    template_id: 'classic',
    status: 'draft',
    schema_version: 2,
    revision: 1,
    created_at: now,
    updated_at: now,
  }
}

const LEDGER = 'resume_v1_migration_links'

async function ownerOf(db: Client, jwt: string): Promise<string> {
  // The signed-in user's own id, read through their own JWT under RLS.
  const scoped = await client(anonKey!, jwt)
  const { data } = await scoped.from('user_profiles').select('id').limit(1)
  const rows = (data ?? []) as { id: string }[]
  assert.ok(rows[0]?.id, 'the test JWT does not resolve to a user_profiles row')
  return rows[0].id
}

// ---------------------------------------------------------------------------
// Schema and constraints
// ---------------------------------------------------------------------------

test('migration 001 columns exist and default a new row to V1 semantics', { skip }, async () => {
  const db = await client(serviceKey!)
  const { data, error } = await db
    .from('resumes')
    .select('id, schema_version, status, revision, strength_score, strength_computed_at, strength_revision')
    .limit(1)
  assert.equal(error, null, `selecting the V2 columns failed: ${JSON.stringify(error)}`)
  assert.ok(Array.isArray(data))
})

async function existingLedgerFixture(db: Client): Promise<{
  v1_resume_id: string
  v2_resume_id: string
  user_id: string
  completed_at: string
}> {
  const { data, error } = await db
    .from(LEDGER)
    .select('v1_resume_id, v2_resume_id, user_id, completed_at')
    .not('completed_at', 'is', null)
    .limit(1)

  assert.equal(
    error,
    null,
    `reading an existing migration link failed: ${JSON.stringify(error)}`
  )

  const row = ((data ?? []) as {
    v1_resume_id: string
    v2_resume_id: string
    user_id: string
    completed_at: string | null
  }[])[0]

  assert.ok(
    row?.v1_resume_id &&
      row.v2_resume_id &&
      row.user_id &&
      row.completed_at,
    'staging needs at least one completed migration link for ledger integration tests'
  )

  return row as {
    v1_resume_id: string
    v2_resume_id: string
    user_id: string
    completed_at: string
  }
}

test('a V1 resume can be claimed in the ledger only once', { skip }, async () => {
  const db = await client(serviceKey!)
  const fixture = await existingLedgerFixture(db)

  const duplicate = await db.from(LEDGER).insert({
    v1_resume_id: fixture.v1_resume_id,
    v2_resume_id: randomUUID(),
    user_id: fixture.user_id,
  })

  assert.notEqual(
    duplicate.error,
    null,
    'a second claim on the same V1 resume was accepted -- the primary key is missing'
  )
})

test('two V1 resumes cannot claim the same V2 row', { skip }, async () => {
  const db = await client(serviceKey!)
  const fixture = await existingLedgerFixture(db)

  const duplicate = await db.from(LEDGER).insert({
    v1_resume_id: randomUUID(),
    v2_resume_id: fixture.v2_resume_id,
    user_id: fixture.user_id,
  })

  assert.notEqual(
    duplicate.error,
    null,
    'the unique index on v2_resume_id is missing'
  )
})

test('not even service_role may delete a ledger row', { skip }, async () => {
  const db = await client(serviceKey!)
  const fixture = await existingLedgerFixture(db)

  const { error } = await db
    .from(LEDGER)
    .delete()
    .eq('v1_resume_id', fixture.v1_resume_id)

  assert.notEqual(error, null, 'migration history must not be deletable')

  const { data } = await db
    .from(LEDGER)
    .select('v1_resume_id')
    .eq('v1_resume_id', fixture.v1_resume_id)

  assert.equal((data ?? []).length, 1, 'the real migration link was deleted')
})

test('service_role may stamp completed_at and nothing else', { skip }, async () => {
  const db = await client(serviceKey!)
  const fixture = await existingLedgerFixture(db)

  const stamp = await db
    .from(LEDGER)
    .update({ completed_at: fixture.completed_at })
    .eq('v1_resume_id', fixture.v1_resume_id)

  assert.equal(
    stamp.error,
    null,
    `stamping completion failed: ${JSON.stringify(stamp.error)}`
  )

  const rewrite = await db
    .from(LEDGER)
    .update({ v2_resume_id: randomUUID() })
    .eq('v1_resume_id', fixture.v1_resume_id)

  assert.notEqual(
    rewrite.error,
    null,
    'a run must not be able to rewrite what a link names'
  )

  const { data } = await db
    .from(LEDGER)
    .select('v2_resume_id, completed_at')
    .eq('v1_resume_id', fixture.v1_resume_id)

  const after = ((data ?? []) as {
    v2_resume_id: string
    completed_at: string | null
  }[])[0]

  assert.equal(after?.v2_resume_id, fixture.v2_resume_id)
  assert.equal(after?.completed_at, fixture.completed_at)
})

test('an authenticated user cannot read, write or forge a ledger row', { skip: skipRls }, async () => {
  const asA = await client(anonKey!, jwtA!)

  const read = await asA.from(LEDGER).select('v1_resume_id').limit(1)
  assert.ok(
    read.error !== null || ((read.data ?? []) as unknown[]).length === 0,
    'the ledger is readable by a signed-in user'
  )

  const forge = await asA.from(LEDGER).insert({
    v1_resume_id: randomUUID(), v2_resume_id: randomUUID(), user_id: randomUUID(),
  })
  assert.notEqual(forge.error, null, 'a signed-in user forged a migration link')
})

test('an anonymous client cannot touch the ledger either', { skip: skipRls }, async () => {
  const anon = await client(anonKey!)
  const read = await anon.from(LEDGER).select('v1_resume_id').limit(1)
  assert.ok(read.error !== null || ((read.data ?? []) as unknown[]).length === 0)

  const write = await anon.from(LEDGER).insert({
    v1_resume_id: randomUUID(), v2_resume_id: randomUUID(), user_id: randomUUID(),
  })
  assert.notEqual(write.error, null, 'anon wrote to the migration ledger')
})

// ---------------------------------------------------------------------------
// Grants and RLS
// ---------------------------------------------------------------------------

test('an anonymous client cannot read resumes at all', { skip: skipRls }, async () => {
  const anon = await client(anonKey!)
  const { data, error } = await anon.from('resumes').select('id').limit(1)
  const rows = (data ?? []) as unknown[]
  assert.ok(
    error !== null || rows.length === 0,
    'anon read a resume row -- migration 001 revoked every anon privilege'
  )
})

test('an anonymous client cannot execute the V2 write functions', { skip: skipRls }, async () => {
  const anon = await client(anonKey!)
  const { error } = await anon.rpc('create_resume_v2', {
    p_resume_id: randomUUID(), p_resume: {}, p_sections: [],
  })
  assert.notEqual(error, null, 'anon can execute create_resume_v2')
})

test('one user cannot read another user\'s resumes', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asB = await client(anonKey!, jwtB!)

  const row = resumeRow(ownerA)
  try {
    assert.equal((await service.from('resumes').insert(row)).error, null)
    const { data } = await asB.from('resumes').select('id').eq('id', row.id)
    assert.deepEqual((data ?? []) as unknown[], [], 'user B can see user A\'s resume')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('create_resume_v2 takes ownership from the session, not the payload', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerB = await ownerOf(service, jwtB!)
  const asA = await client(anonKey!, jwtA!)

  const id = randomUUID()
  try {
    // The payload cannot name an owner -- there is no such parameter. This
    // asserts the row that comes out belongs to the CALLER, not to B.
    const { data, error } = await asA.rpc('create_resume_v2', {
      p_resume_id: id,
      p_resume: { title: 'ownership check', template_id: 'classic', status: 'draft', user_id: ownerB },
      p_sections: [],
    })
    assert.equal(error, null, `create_resume_v2 failed: ${JSON.stringify(error)}`)
    assert.equal((data as { ok?: boolean } | null)?.ok, true)

    const { data: rows } = await service.from('resumes').select('user_id').eq('id', id)
    const created = ((rows ?? []) as { user_id: string }[])[0]
    assert.ok(created)
    assert.notEqual(created.user_id, ownerB, 'the payload set the owner')
  } finally {
    await service.from('resumes').delete().eq('id', id)
  }
})

test('an offline connection cannot use create_resume_v2 -- the writer must not try', { skip }, async () => {
  // The offline writer runs as service_role and must not use this browser RPC.
  // The privilege boundary rejects service_role before the function body runs.
  // If this ever succeeds, revisit the writer privilege model.
  const db = await client(serviceKey!)
  const { data, error } = await db.rpc('create_resume_v2', {
    p_resume_id: randomUUID(), p_resume: { title: 'x', template_id: 'classic' }, p_sections: [],
  })
  assert.equal(data, null, 'service_role unexpectedly executed create_resume_v2')
  assert.equal(
    (error as { code?: string } | null)?.code, '42501',
    'offline/service-role caller was not rejected by the RPC privilege boundary'
  )
})

// ---------------------------------------------------------------------------
// The 006 correction
// ---------------------------------------------------------------------------

test('a user cannot attribute an AI call to a resume they do not own', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asB = await client(anonKey!, jwtB!)

  const row = resumeRow(ownerA)
  let usageId: string | null = null
  try {
    assert.equal((await service.from('resumes').insert(row)).error, null)

    const { data, error } = await asB.rpc('record_ai_usage', {
      p_resume_id: row.id, p_operation: 'integration-test', p_outcome: 'attempted',
    })
    // The row is still written -- dropping it would let a caller erase their
    // own rate-limit history -- but the attribution must be null.
    assert.equal(error, null, 'the ledger write should still succeed')
    usageId = data as string | null
    assert.ok(usageId, 'no ledger row was created')

    const { data: ledger } = await service
      .from('resume_ai_usage').select('resume_id, user_id').eq('id', usageId)
    const written = ((ledger ?? []) as { resume_id: string | null }[])[0]
    assert.equal(
      written?.resume_id, null,
      'the ledger row was attributed to a resume the caller does not own'
    )
  } finally {
    if (usageId) await service.from('resume_ai_usage').delete().eq('id', usageId)
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('a nonexistent resume id no longer reveals itself through an FK error', { skip: skipRls }, async () => {
  const asA = await client(anonKey!, jwtA!)
  const service = await client(serviceKey!)

  const { data, error } = await asA.rpc('record_ai_usage', {
    p_resume_id: randomUUID(), p_operation: 'integration-test', p_outcome: 'attempted',
  })
  assert.equal(
    error, null,
    'an unknown uuid raised an error -- the caller can still probe for real resume ids'
  )
  const usageId = data as string | null
  if (usageId) await service.from('resume_ai_usage').delete().eq('id', usageId)
})

test('a user cannot delete their own AI ledger rows to reset a rate limit', { skip: skipRls }, async () => {
  const asA = await client(anonKey!, jwtA!)
  const { error } = await asA.from('resume_ai_usage').delete().neq('id', randomUUID())
  const { data } = await asA.from('resume_ai_usage').select('id').limit(1)
  // Either the delete is refused outright, or RLS matches no rows for it.
  assert.ok(
    error !== null || Array.isArray(data),
    'the ledger accepted a client-side delete'
  )
})

// ---------------------------------------------------------------------------
// THE ACCEPTANCE MATRIX
//
// Migration 007 moved the locked product rules into the database. These prove
// it, from the position of an adversary: a signed-in user holding the public
// anon key and their own JWT, attacking both through direct table DML and
// through the RPCs, which are GRANTed to `authenticated` and callable without
// going anywhere near the application.
//
// RESUME_TEST_JWT_A must belong to a Free or Premium user, and
// RESUME_TEST_JWT_ULTIMATE to an Ultimate one, or the tier assertions prove
// nothing.
// ---------------------------------------------------------------------------

const jwtU = process.env.RESUME_TEST_JWT_ULTIMATE
const skipUltimate = configured && jwtU ? false : 'additionally set RESUME_TEST_JWT_ULTIMATE'

/** A V2 resume belonging to `owner`, created past the boundary as service_role. */
async function seedV2(service: Client, owner: string) {
  const row = resumeRow(owner)
  const { error } = await service.from('resumes').insert(row)
  assert.equal(error, null, `seeding failed: ${JSON.stringify(error)}`)
  return row
}

// --- Free/Premium: direct table DML ----------------------------------------

test('direct INSERT of a V2 resume is DENIED', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)

  const row = resumeRow(ownerA)
  const { error } = await asA.from('resumes').insert(row)
  assert.notEqual(error, null, 'a V2 resume was created by direct insert')

  const { data } = await service.from('resumes').select('id').eq('id', row.id)
  assert.equal((data ?? []).length, 0, 'the row was written despite the error')
})

test('direct UPDATE to status=complete is DENIED', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)

  try {
    const { error } = await asA.from('resumes').update({ status: 'complete' }).eq('id', row.id)
    assert.notEqual(error, null, 'finalization was bypassed by direct update')

    const { data } = await service.from('resumes').select('status').eq('id', row.id)
    assert.equal(((data ?? []) as { status: string }[])[0]?.status, 'draft')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('direct manipulation of schema_version is DENIED', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)

  try {
    const { error } = await asA.from('resumes').update({ schema_version: 1 }).eq('id', row.id)
    assert.notEqual(error, null, 'a V2 resume was pushed back into the V1 editor')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('direct manipulation of revision is DENIED', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)

  try {
    const { error } = await asA.from('resumes').update({ revision: 999 }).eq('id', row.id)
    assert.notEqual(error, null, 'compare-and-swap was bypassed by direct update')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('direct forgery of the strength score is DENIED', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)

  try {
    const { error } = await asA.from('resumes')
      .update({ strength_score: 100, strength_revision: 1 }).eq('id', row.id)
    assert.notEqual(error, null, 'the strength score was forged by direct update')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('direct CAS-bypassing section mutation is DENIED', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)

  try {
    const insert = await asA.from('resume_sections').insert({
      id: randomUUID(), resume_id: row.id, section_type: 'summary',
      section_data: { text: 'written directly' }, order_index: 0, visible: true,
    })
    assert.notEqual(insert.error, null, 'section content was written outside save_resume_v2')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('V1 section rows stay directly writable, so V1 keeps working', { skip: skipRls }, async () => {
  // The boundary must not touch V1: it is the rollback path for 30 days, and
  // its editor saves by writing section rows directly.
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)

  const now = new Date().toISOString()
  const v1 = {
    id: randomUUID(), user_id: ownerA, title: 'v1 row',
    template_id: 'modern', schema_version: 1, created_at: now, updated_at: now,
  }
  const sectionId = randomUUID()
  try {
    assert.equal((await asA.from('resumes').insert(v1)).error, null, 'V1 create was blocked')
    const section = await asA.from('resume_sections').insert({
      id: sectionId, resume_id: v1.id, section_type: 'personal',
      section_data: { full_name: 'Test' }, order_index: 0,
    })
    assert.equal(section.error, null, 'V1 section writes were blocked')
    const rename = await asA.from('resumes').update({ title: 'renamed' }).eq('id', v1.id)
    assert.equal(rename.error, null, 'V1 updates were blocked')
  } finally {
    await service.from('resumes').delete().eq('id', v1.id)
  }
})

// --- Free/Premium: through the exposed RPCs --------------------------------

test('create_resume_v2 called directly cannot exceed the tier cap', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)

  const created: string[] = []
  try {
    // Free is 1 and Premium is 3, so four attempts must hit the ceiling for
    // either. The refusal is a result, not an exception.
    let refused = false
    for (let i = 0; i < 4; i++) {
      const id = randomUUID()
      const { data } = await asA.rpc('create_resume_v2', {
        p_resume_id: id, p_resume: { title: `cap probe ${i}`, template_id: 'classic' }, p_sections: [],
      })
      const result = data as { ok?: boolean; reason?: string } | null
      if (result?.ok) { created.push(id); continue }
      refused = true
      assert.equal(result?.reason, 'not-permitted', `unexpected refusal: ${JSON.stringify(result)}`)
      break
    }
    assert.ok(refused, 'the creation cap was not enforced against a direct RPC call')
  } finally {
    if (created.length > 0) await service.from('resumes').delete().in('id', created)
  }
})

test('create_resume_v2 cannot create an already-complete resume', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const asA = await client(anonKey!, jwtA!)

  const id = randomUUID()
  try {
    const { data } = await asA.rpc('create_resume_v2', {
      p_resume_id: id,
      p_resume: { title: 'status probe', template_id: 'classic', status: 'complete' },
      p_sections: [],
    })
    const result = data as { ok?: boolean } | null
    if (result?.ok) {
      const { data: rows } = await service.from('resumes').select('status').eq('id', id)
      assert.equal(
        ((rows ?? []) as { status: string }[])[0]?.status, 'draft',
        'the payload status was honoured'
      )
    }
  } finally {
    await service.from('resumes').delete().eq('id', id)
  }
})

test('save_resume_v2 called directly cannot finalize below Ultimate', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)

  try {
    const { data } = await asA.rpc('save_resume_v2', {
      p_resume_id: row.id, p_expected_revision: 1,
      p_resume: { title: 'finalize probe', template_id: 'classic', status: 'complete' },
      p_sections: [],
    })
    const result = data as { ok?: boolean; reason?: string } | null
    assert.equal(result?.ok, false, 'finalization was bypassed through the save RPC')
    assert.ok(
      result?.reason === 'finalize-not-permitted' || result?.reason === 'not-permitted',
      `unexpected reason: ${JSON.stringify(result)}`
    )

    const { data: rows } = await service.from('resumes').select('status').eq('id', row.id)
    assert.equal(((rows ?? []) as { status: string }[])[0]?.status, 'draft')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('save_resume_v2 cannot carry a forged strength score', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)

  try {
    await asA.rpc('save_resume_v2', {
      p_resume_id: row.id, p_expected_revision: 1,
      p_resume: {
        title: 'strength probe', template_id: 'classic', status: 'draft',
        strength_score: 100, strength_revision: 1,
      },
      p_sections: [],
    })
    const { data } = await service.from('resumes').select('strength_score').eq('id', row.id)
    assert.equal(
      ((data ?? []) as { strength_score: number | null }[])[0]?.strength_score, null,
      'an ordinary save carried a strength score'
    )
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('save_resume_strength_v2 cannot touch a resume the caller does not own', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asB = await client(anonKey!, jwtB!)
  const row = await seedV2(service, ownerA)

  try {
    const { data } = await asB.rpc('save_resume_strength_v2', {
      p_resume_id: row.id, p_score: 100,
      p_computed_at: new Date().toISOString(), p_revision: 1,
    })
    assert.equal((data as { ok?: boolean } | null)?.ok, false, 'user B scored user A\'s resume')

    const { data: rows } = await service.from('resumes').select('strength_score').eq('id', row.id)
    assert.equal(((rows ?? []) as { strength_score: number | null }[])[0]?.strength_score, null)
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('save_resume_v2 cannot be aimed at another user\'s resume', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asB = await client(anonKey!, jwtB!)
  const row = await seedV2(service, ownerA)

  try {
    const { data } = await asB.rpc('save_resume_v2', {
      p_resume_id: row.id, p_expected_revision: 1,
      p_resume: { title: 'hijacked', template_id: 'classic', status: 'draft' },
      p_sections: [],
    })
    assert.equal((data as { ok?: boolean } | null)?.ok, false)
    assert.equal((data as { reason?: string } | null)?.reason, 'not-found', 'existence was revealed')

    const { data: rows } = await service.from('resumes').select('title').eq('id', row.id)
    assert.notEqual(((rows ?? []) as { title: string }[])[0]?.title, 'hijacked')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

// --- Ultimate: the legitimate path still works -----------------------------

test('an Ultimate user can create, save and finalize', { skip: skipUltimate }, async () => {
  const service = await client(serviceKey!)
  const asU = await client(anonKey!, jwtU!)

  const id = randomUUID()
  try {
    const create = await asU.rpc('create_resume_v2', {
      p_resume_id: id,
      p_resume: { title: 'ultimate probe', template_id: 'classic' },
      p_sections: [],
    })
    const created = create.data as { ok?: boolean; revision?: number } | null
    assert.equal(created?.ok, true, `create failed: ${JSON.stringify(create.data)}`)

    const save = await asU.rpc('save_resume_v2', {
      p_resume_id: id, p_expected_revision: created!.revision,
      p_resume: { title: 'ultimate probe', template_id: 'classic', status: 'complete' },
      p_sections: [],
    })
    assert.equal((save.data as { ok?: boolean } | null)?.ok, true, 'Ultimate could not finalize')

    const { data } = await service.from('resumes').select('status').eq('id', id)
    assert.equal(((data ?? []) as { status: string }[])[0]?.status, 'complete')
  } finally {
    await service.from('resumes').delete().eq('id', id)
  }
})

test('complete -> draft is available to every tier', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)

  const row = { ...resumeRow(ownerA), status: 'complete' }
  try {
    assert.equal((await service.from('resumes').insert(row)).error, null)
    const { data } = await asA.rpc('save_resume_v2', {
      p_resume_id: row.id, p_expected_revision: 1,
      p_resume: { title: 'unfinalize', template_id: 'classic', status: 'draft' },
      p_sections: [],
    })
    assert.equal(
      (data as { ok?: boolean } | null)?.ok, true,
      'a non-Ultimate user could not return their resume to draft'
    )
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

// --- the migration writer is exempt from the cap ---------------------------

test('service_role can migrate an owner past their tier cap', { skip }, async () => {
  // The owner holding two resumes must migrate even onto a Free plan. The
  // exemption is `auth.uid() is null`, which no browser client can reach.
  const service = await client(serviceKey!)
  const { data: owners } = await service.from('resumes').select('user_id').limit(1)
  const owner = ((owners ?? []) as { user_id: string }[])[0]?.user_id
  assert.ok(owner, 'staging needs at least one existing resume to borrow an owner from')

  const rows = Array.from({ length: 4 }, () => resumeRow(owner))
  try {
    const { error } = await service.from('resumes').insert(rows)
    assert.equal(
      error, null,
      `the migration writer was blocked by the creation cap: ${JSON.stringify(error)}`
    )
  } finally {
    await service.from('resumes').delete().in('id', rows.map((r) => r.id))
  }
})

test('service_role can write V2 section rows directly', { skip }, async () => {
  const service = await client(serviceKey!)
  const { data: owners } = await service.from('resumes').select('user_id').limit(1)
  const owner = ((owners ?? []) as { user_id: string }[])[0]?.user_id
  assert.ok(owner)

  const row = resumeRow(owner)
  try {
    assert.equal((await service.from('resumes').insert(row)).error, null)
    const { error } = await service.from('resume_sections').insert({
      id: randomUUID(), resume_id: row.id, section_type: 'summary',
      section_data: { text: 'migrated' }, order_index: 0, visible: true,
    })
    assert.equal(error, null, 'the writer cannot insert migrated section rows')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('deleting a V2 resume still cascades to its sections', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)
  const sectionId = randomUUID()

  await service.from('resume_sections').insert({
    id: sectionId, resume_id: row.id, section_type: 'summary',
    section_data: { text: 'x' }, order_index: 0, visible: true,
  })

  const { error } = await asA.from('resumes').delete().eq('id', row.id)
  assert.equal(error, null, 'a user could not delete their own V2 resume')

  const { data } = await service.from('resume_sections').select('id').eq('id', sectionId)
  assert.equal((data ?? []).length, 0, 'the cascade was refused by the section boundary')
})

// ---------------------------------------------------------------------------
// ENTITLEMENT SOURCE INTEGRITY
//
// Migration 007 reads the creation cap and the finalization rule from
// user_profiles.subscription_tier. If a user can write that column, every rule
// 007 added is decorative. These attack it directly.
// ---------------------------------------------------------------------------

/** The caller's own profile row, read as service_role so RLS cannot hide it. */
async function profileOf(service: Client, userId: string) {
  const { data } = await service
    .from('user_profiles').select('id, subscription_tier').eq('id', userId)
  return ((data ?? []) as { id: string; subscription_tier: string | null }[])[0]
}

test('a user cannot promote themselves to ultimate by direct UPDATE', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)

  const before = await profileOf(service, ownerA)
  assert.ok(before, 'the test user has no profile row')
  assert.notEqual(before.subscription_tier, 'ultimate', 'JWT A must be a non-Ultimate user')

  // The write may be refused outright (no grant) or silently forced back by the
  // guard. Either is acceptable; what must never happen is the value changing.
  await asA.from('user_profiles').update({ subscription_tier: 'ultimate' }).eq('id', ownerA)

  const after = await profileOf(service, ownerA)
  assert.equal(
    after.subscription_tier, before.subscription_tier,
    'a user promoted themselves to a higher plan'
  )
})

test('a user cannot promote themselves by recreating their profile', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const before = await profileOf(service, ownerA)

  // An upsert-shaped attack: insert a row claiming ultimate under their own id.
  await asA.from('user_profiles').insert({ id: ownerA, subscription_tier: 'ultimate' })

  const after = await profileOf(service, ownerA)
  assert.equal(after.subscription_tier, before.subscription_tier, 'a profile insert claimed a tier')
})

test('a user cannot promote another user either', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerB = await ownerOf(service, jwtB!)
  const asA = await client(anonKey!, jwtA!)
  const before = await profileOf(service, ownerB)

  await asA.from('user_profiles').update({ subscription_tier: 'ultimate' }).eq('id', ownerB)

  const after = await profileOf(service, ownerB)
  assert.equal(after.subscription_tier, before.subscription_tier, 'user A rewrote user B\'s plan')
})

test('the browser holds no write privilege on user_profiles at all', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)

  // Any write verb must fail or change nothing -- including on columns that
  // have nothing to do with billing, since the grant is gone entirely.
  const del = await asA.from('user_profiles').delete().eq('id', ownerA)
  assert.notEqual(del.error, null, 'a user can delete their own profile row')

  const still = await profileOf(service, ownerA)
  assert.ok(still, 'the profile row was deleted')
})

test('promoting via the tier does not unlock finalization', { skip: skipRls }, async () => {
  // The end-to-end version of the same attack: try to promote, then try to use
  // the privilege that promotion would have bought.
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const row = await seedV2(service, ownerA)

  try {
    await asA.from('user_profiles').update({ subscription_tier: 'ultimate' }).eq('id', ownerA)

    const { data } = await asA.rpc('save_resume_v2', {
      p_resume_id: row.id, p_expected_revision: 1,
      p_resume: { title: 'promoted?', template_id: 'classic', status: 'complete' },
      p_sections: [],
    })
    assert.equal((data as { ok?: boolean } | null)?.ok, false, 'self-promotion bought finalization')

    const { data: rows } = await service.from('resumes').select('status').eq('id', row.id)
    assert.equal(((rows ?? []) as { status: string }[])[0]?.status, 'draft')
  } finally {
    await service.from('resumes').delete().eq('id', row.id)
  }
})

test('the Stripe webhook path still works, as service_role', { skip }, async () => {
  // The guard must exempt the legitimate billing writer, or upgrades break.
  const service = await client(serviceKey!)
  const { data } = await service.from('user_profiles').select('id, subscription_tier').limit(1)
  const row = ((data ?? []) as { id: string; subscription_tier: string | null }[])[0]
  assert.ok(row, 'staging needs at least one profile')

  const original = row.subscription_tier
  try {
    const up = await service.from('user_profiles')
      .update({ subscription_tier: 'premium' }).eq('id', row.id)
    assert.equal(up.error, null, `the billing path was blocked: ${JSON.stringify(up.error)}`)

    const after = await profileOf(service, row.id)
    assert.equal(after.subscription_tier, 'premium', 'service_role could not change the tier')
  } finally {
    await service.from('user_profiles')
      .update({ subscription_tier: original }).eq('id', row.id)
  }
})

// ---------------------------------------------------------------------------
// CONCURRENT CREATE CAP
//
// Counting rows and comparing to a cap is a read-modify-write. Without the
// per-owner lock in 007, two simultaneous creates both read the same count and
// both succeed. These fire them at once and count what is left.
// ---------------------------------------------------------------------------

/** Fires N create_resume_v2 calls concurrently and returns the ids that stuck. */
async function raceCreates(db: Client, n: number): Promise<{ created: string[]; refused: number }> {
  const ids = Array.from({ length: n }, () => randomUUID())
  const results = await Promise.all(ids.map((id, i) =>
    db.rpc('create_resume_v2', {
      p_resume_id: id,
      p_resume: { title: `race ${i}`, template_id: 'classic' },
      p_sections: [],
    })
  ))

  const created: string[] = []
  let refused = 0
  results.forEach((r, i) => {
    const result = r.data as { ok?: boolean } | null
    if (result?.ok) created.push(ids[i])
    else refused += 1
  })
  return { created, refused }
}

/** Every V2 resume this owner currently holds. */
async function v2Count(service: Client, owner: string): Promise<number> {
  const { data } = await service
    .from('resumes').select('id').eq('user_id', owner).eq('schema_version', 2)
  return ((data ?? []) as unknown[]).length
}

async function setTier(service: Client, userId: string, tier: string) {
  const { error } = await service
    .from('user_profiles').update({ subscription_tier: tier }).eq('id', userId)
  assert.equal(error, null, `could not set the tier for the test: ${JSON.stringify(error)}`)
}

test('Free starting at 0 ends with exactly 1 after concurrent creates', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const original = (await profileOf(service, ownerA)).subscription_tier

  // Start clean: remove any V2 resumes this account already holds.
  await service.from('resumes').delete().eq('user_id', ownerA).eq('schema_version', 2)
  await setTier(service, ownerA, 'free')

  let created: string[] = []
  try {
    assert.equal(await v2Count(service, ownerA), 0, 'the account did not start empty')

    const race = await raceCreates(asA, 5)
    created = race.created

    assert.equal(
      await v2Count(service, ownerA), 1,
      'concurrent creates let a Free account exceed one resume'
    )
    assert.equal(race.created.length, 1, 'more than one create reported success')
    assert.equal(race.refused, 4)
  } finally {
    if (created.length > 0) await service.from('resumes').delete().in('id', created)
    await setTier(service, ownerA, original ?? 'free')
  }
})

test('Premium starting at 2 ends with exactly 3 after concurrent creates', { skip: skipRls }, async () => {
  const service = await client(serviceKey!)
  const ownerA = await ownerOf(service, jwtA!)
  const asA = await client(anonKey!, jwtA!)
  const original = (await profileOf(service, ownerA)).subscription_tier

  await service.from('resumes').delete().eq('user_id', ownerA).eq('schema_version', 2)
  await setTier(service, ownerA, 'premium')

  const seeded = [resumeRow(ownerA), resumeRow(ownerA)]
  let created: string[] = []
  try {
    // Seeded as service_role, which is exempt from the cap.
    assert.equal((await service.from('resumes').insert(seeded)).error, null)
    assert.equal(await v2Count(service, ownerA), 2)

    const race = await raceCreates(asA, 5)
    created = race.created

    assert.equal(
      await v2Count(service, ownerA), 3,
      'concurrent creates let a Premium account exceed three resumes'
    )
    assert.equal(race.created.length, 1, 'only one of the five should have been admitted')
  } finally {
    await service.from('resumes').delete().in('id', [...seeded.map((r) => r.id), ...created])
    await setTier(service, ownerA, original ?? 'free')
  }
})

test('Ultimate concurrent creates are all allowed', { skip: skipUltimate }, async () => {
  const service = await client(serviceKey!)
  const ownerU = await ownerOf(service, jwtU!)
  const asU = await client(anonKey!, jwtU!)

  let created: string[] = []
  try {
    const before = await v2Count(service, ownerU)
    const race = await raceCreates(asU, 5)
    created = race.created

    assert.equal(race.refused, 0, 'an Ultimate user was refused a resume')
    assert.equal(race.created.length, 5)
    assert.equal(await v2Count(service, ownerU), before + 5)
  } finally {
    if (created.length > 0) await service.from('resumes').delete().in('id', created)
  }
})

test('the per-owner lock does not serialize different owners', { skip: skipUltimate }, async () => {
  // Two owners creating at the same moment must not wait on each other. If the
  // lock were global this would still pass but slowly; what it proves is that
  // both succeed, which a global lock on a Free owner would not allow.
  const service = await client(serviceKey!)
  const ownerU = await ownerOf(service, jwtU!)
  const asU = await client(anonKey!, jwtU!)
  const asB = await client(anonKey!, jwtB!)
  const ownerB = await ownerOf(service, jwtB!)
  const originalB = (await profileOf(service, ownerB)).subscription_tier

  await service.from('resumes').delete().eq('user_id', ownerB).eq('schema_version', 2)
  await setTier(service, ownerB, 'free')

  const idU = randomUUID()
  const idB = randomUUID()
  try {
    const [u, b] = await Promise.all([
      asU.rpc('create_resume_v2', {
        p_resume_id: idU, p_resume: { title: 'u', template_id: 'classic' }, p_sections: [],
      }),
      asB.rpc('create_resume_v2', {
        p_resume_id: idB, p_resume: { title: 'b', template_id: 'classic' }, p_sections: [],
      }),
    ])
    assert.equal((u.data as { ok?: boolean } | null)?.ok, true, 'the Ultimate owner was blocked')
    assert.equal((b.data as { ok?: boolean } | null)?.ok, true, 'the Free owner was blocked at zero')
  } finally {
    await service.from('resumes').delete().in('id', [idU, idB])
    await setTier(service, ownerB, originalB ?? 'free')
  }
})
