import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildUserActivity } from './userActivity.ts'
import type { AuthUserRow, Reader, ReadResult } from './reader.ts'

/**
 * The member list, run for real against a fake database.
 *
 * The first test is the whole reason this module exists: a ten-question
 * interview writes ten `user_asked_questions` rows and ONE grant, and the old
 * dashboard reported ten interviews.
 */

type Tables = Record<string, Record<string, unknown>[]>

function fakeReader(users: AuthUserRow[], tables: Tables, denied: string[] = []): Reader {
  return {
    async rows<T>(table: string): Promise<ReadResult<T>> {
      if (denied.includes(table)) {
        return { ok: false, reason: 'denied', detail: `permission denied for table ${table}` }
      }
      return { ok: true, rows: (tables[table] ?? []) as T[], truncated: false }
    },
    async count(table: string) {
      if (denied.includes(table)) return { ok: false, reason: 'denied', detail: 'denied' }
      return { ok: true, count: (tables[table] ?? []).length }
    },
    async earliest() {
      return null
    },
    async authUsers() {
      return { ok: true, rows: users, truncated: false }
    },
  }
}

const account = (id: string, email: string, createdAt = '2026-09-01T10:00:00.000Z'): AuthUserRow => ({
  id,
  email,
  created_at: createdAt,
  email_confirmed_at: '2026-09-01T10:05:00.000Z',
  last_sign_in_at: null,
})

test('a ten-question interview counts as one interview, not ten', async () => {
  const reader = fakeReader([account('u1', 'one@example.com')], {
    interview_grants: [
      { user_id: 'u1', completed: true, created_at: '2026-09-20T10:00:00.000Z', session_id: 's1', abandoned_at: null },
    ],
    user_asked_questions: Array.from({ length: 10 }, () => ({
      user_id: 'u1',
      asked_at: '2026-09-20T10:05:00.000Z',
    })),
  })

  const result = await buildUserActivity(reader)

  assert.equal(result.rows[0].interviewsStarted, 1, 'ten question rows are one interview')
  assert.equal(result.rows[0].interviewsCompleted, 1)
})

test('a grant voided by a failed charge is not counted as an interview', async () => {
  const reader = fakeReader([account('u1', 'one@example.com')], {
    interview_grants: [
      { user_id: 'u1', completed: false, created_at: '2026-09-20T10:00:00.000Z', session_id: 's1', abandoned_at: null },
      // Voided: abandoned before it was ever bound to a session.
      { user_id: 'u1', completed: false, created_at: '2026-09-20T11:00:00.000Z', session_id: null, abandoned_at: '2026-09-20T11:00:01.000Z' },
    ],
  })

  const result = await buildUserActivity(reader)

  assert.equal(result.rows[0].interviewsStarted, 1)
})

test('last active comes from the most recent action of any kind', async () => {
  const reader = fakeReader([account('u1', 'one@example.com')], {
    interview_grants: [
      { user_id: 'u1', completed: true, created_at: '2026-09-10T10:00:00.000Z', session_id: 's1', abandoned_at: null },
    ],
    resume_ai_usage: [{ user_id: 'u1', created_at: '2026-09-21T09:00:00.000Z' }],
    saved_schools: [{ user_id: 'u1', created_at: '2026-09-15T09:00:00.000Z' }],
  })

  const result = await buildUserActivity(reader)

  assert.equal(result.rows[0].lastActiveAt, '2026-09-21T09:00:00.000Z')
  assert.equal(result.rows[0].actions, 3, 'each recorded action counts once')
  assert.deepEqual(result.rows[0].features, ['interview', 'resume', 'schools'])
})

test('a member who has done nothing is listed, with nothing invented', async () => {
  const reader = fakeReader([account('u1', 'quiet@example.com')], {})

  const result = await buildUserActivity(reader)

  assert.equal(result.rows[0].lastActiveAt, null, 'never active is null, not a date')
  assert.equal(result.rows[0].actions, 0)
  assert.equal(result.rows[0].interviewsStarted, 0)
})

test('tier comes from the profile, and a missing profile says so', async () => {
  const reader = fakeReader([account('u1', 'one@example.com'), account('u2', 'two@example.com')], {
    user_profiles: [{ id: 'u1', subscription_tier: 'Ultimate' }],
  })

  const result = await buildUserActivity(reader, { sort: 'email' })

  assert.equal(result.rows[0].tier, 'ultimate', 'normalised')
  assert.equal(result.rows[1].tier, '(no profile)', 'an orphaned account is visible, not hidden')
})

test('search narrows by email and the total follows the filter', async () => {
  const reader = fakeReader(
    [account('u1', 'alice@example.com'), account('u2', 'bob@example.com'), account('u3', 'carol@test.com')],
    {}
  )

  const result = await buildUserActivity(reader, { search: 'example.com' })

  assert.equal(result.total, 2)
  assert.deepEqual(result.rows.map((row) => row.email).sort(), ['alice@example.com', 'bob@example.com'])
})

test('the tier filter only returns that tier', async () => {
  const reader = fakeReader([account('u1', 'a@x.com'), account('u2', 'b@x.com')], {
    user_profiles: [
      { id: 'u1', subscription_tier: 'ultimate' },
      { id: 'u2', subscription_tier: 'free' },
    ],
  })

  const result = await buildUserActivity(reader, { tier: 'ultimate' })

  assert.equal(result.total, 1)
  assert.equal(result.rows[0].email, 'a@x.com')
})

test('sorting by interviews puts the busiest member first', async () => {
  const reader = fakeReader([account('u1', 'one@x.com'), account('u2', 'two@x.com')], {
    interview_grants: [
      { user_id: 'u2', completed: true, created_at: '2026-09-10T10:00:00.000Z', session_id: 's1', abandoned_at: null },
      { user_id: 'u2', completed: true, created_at: '2026-09-11T10:00:00.000Z', session_id: 's2', abandoned_at: null },
      { user_id: 'u1', completed: true, created_at: '2026-09-12T10:00:00.000Z', session_id: 's3', abandoned_at: null },
    ],
  })

  const result = await buildUserActivity(reader, { sort: 'interviews' })

  assert.equal(result.rows[0].email, 'two@x.com')
})

test('members who never acted sort last when sorting by last active', async () => {
  const reader = fakeReader([account('u1', 'quiet@x.com'), account('u2', 'busy@x.com')], {
    resume_ai_usage: [{ user_id: 'u2', created_at: '2026-09-21T09:00:00.000Z' }],
  })

  const result = await buildUserActivity(reader, { sort: 'recent' })

  assert.deepEqual(result.rows.map((row) => row.email), ['busy@x.com', 'quiet@x.com'])
})

test('paging returns one page and the full total', async () => {
  const users = Array.from({ length: 30 }, (_, index) =>
    account(`u${index}`, `member${String(index).padStart(2, '0')}@x.com`)
  )
  const reader = fakeReader(users, {})

  const first = await buildUserActivity(reader, { sort: 'email', page: 1, pageSize: 25 })
  const second = await buildUserActivity(reader, { sort: 'email', page: 2, pageSize: 25 })

  assert.equal(first.rows.length, 25)
  assert.equal(first.total, 30)
  assert.equal(second.rows.length, 5)
  assert.equal(second.rows[0].email, 'member25@x.com', 'the second page continues where the first stopped')
})

test('a page size beyond the ceiling is clamped rather than honoured', async () => {
  const users = Array.from({ length: 200 }, (_, index) => account(`u${index}`, `m${index}@x.com`))
  const result = await buildUserActivity(fakeReader(users, {}), { pageSize: 5000 })

  assert.equal(result.rows.length, 100)
})

test('an unreadable table is reported and does not empty the list', async () => {
  const reader = fakeReader(
    [account('u1', 'one@x.com')],
    { resume_ai_usage: [{ user_id: 'u1', created_at: '2026-09-21T09:00:00.000Z' }] },
    ['gpa_calculations']
  )

  const result = await buildUserActivity(reader)

  assert.equal(result.rows.length, 1, 'the rest of the list still builds')
  assert.equal(result.rows[0].actions, 1)
  assert.ok(
    result.diagnostics.failed.some((failure) => failure.source === 'gpa_calculations'),
    'and the gap is declared rather than hidden'
  )
})
