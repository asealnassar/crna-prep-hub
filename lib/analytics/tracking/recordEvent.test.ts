import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The idempotency barrier in analytics_record_event.
 *
 * WHAT THIS GUARDS. A replayed event_id must change NOTHING. An earlier
 * version only protected the event row and the page-view counter with ON
 * CONFLICT, and left every statement above them running — so a replay still
 * bumped the visitor's last_seen_at, could still attach an account to an
 * unlinked visitor, and, when the replay carried a DIFFERENT session_id,
 * created an entire extra session that no event would ever belong to.
 *
 * These assertions are on the migration's text because the function lives in
 * SQL and the repository's tests run without a database. The behaviour itself
 * was verified against PostgreSQL 16: a replay with a different session_id
 * returned false and created no session, and two concurrent requests for the
 * same event id produced exactly one write, the second blocking on the lock
 * until the first committed.
 */

const SQL = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/20260922_001_analytics_traffic.sql', import.meta.url)),
  'utf8'
)

/** The body of analytics_record_event, from `begin` to its `end`. */
function recordEventBody(): string {
  const start = SQL.indexOf('create function public.analytics_record_event')
  assert.ok(start > 0, 'the function must exist in the migration')
  const end = SQL.indexOf('comment on function public.analytics_record_event', start)
  assert.ok(end > start)
  return SQL.slice(start, end)
}

test('the event id is checked BEFORE anything is written', () => {
  const body = recordEventBody()

  const guard = body.indexOf('if exists (select 1 from public.analytics_events where event_id = p_event_id)')
  const firstWrite = body.indexOf('insert into public.analytics_visitors')

  assert.ok(guard > 0, 'a duplicate must be detected explicitly, not merely absorbed by ON CONFLICT')
  assert.ok(firstWrite > 0)
  assert.ok(guard < firstWrite, 'the check has to come before the first write, or a replay still mutates')
})

test('a duplicate returns immediately, so nothing below it can run', () => {
  const body = recordEventBody()
  const guard = body.indexOf('if exists (select 1 from public.analytics_events where event_id = p_event_id)')
  const afterGuard = body.slice(guard, guard + 200)

  assert.match(afterGuard, /return false;/, 'the guard must return, not merely skip a statement')
})

test('the duplicate check is serialised, because "if exists" alone is a race', () => {
  const body = recordEventBody()

  const lock = body.indexOf('pg_advisory_xact_lock')
  const guard = body.indexOf('if exists (select 1 from public.analytics_events where event_id = p_event_id)')

  assert.ok(lock > 0, 'two identical requests arriving together would both see nothing and both proceed')
  assert.ok(lock < guard, 'the lock is taken before the look')
  assert.match(body, /pg_advisory_xact_lock\(hashtextextended\(p_event_id::text, 0\)\)/,
    'keyed on the event id, so unrelated events never wait on each other')
  assert.match(body, /_xact_/, 'transaction-scoped, so it releases on commit AND on rollback')
})

test('the three things a replay must never do are all below the barrier', () => {
  const body = recordEventBody()
  const guard = body.indexOf('return false;')

  for (const [statement, what] of [
    ['update public.analytics_visitors\n  set    last_seen_at', 'bump last_seen_at'],
    ['set    user_id = p_user_id', 'link an account'],
    ['insert into public.analytics_sessions', 'create a session'],
  ] as const) {
    const at = body.indexOf(statement)
    assert.ok(at > 0, `expected to find the statement that would ${what}`)
    assert.ok(at > guard, `a replay must not be able to ${what}`)
  }
})

test('the unique index is still the real guarantee, not the lock', () => {
  // A lock protects concurrent callers. The constraint protects everything
  // else — a second application, a direct call, a future refactor.
  assert.match(SQL, /event_id\s+uuid\s+not null unique/)
  assert.match(recordEventBody(), /on conflict \(event_id\) do nothing/)
})

test('a genuine event still increments the page-view counter exactly once', () => {
  const body = recordEventBody()

  assert.match(body, /get diagnostics inserted = row_count/)
  assert.match(body, /if inserted > 0 then/)
  assert.match(body, /page_view_count \+ \(case when p_kind = 'page_view' then 1 else 0 end\)/)
})

test('first touch is still written once and never rewritten', () => {
  const body = recordEventBody()

  assert.match(body, /insert into public\.analytics_visitors[\s\S]*?on conflict \(visitor_id\) do nothing/)
  assert.match(body, /and  user_id is null/, 'and an account link is only ever set when still null')
})
