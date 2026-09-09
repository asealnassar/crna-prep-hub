import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chunkIds, pageAll, fetchByIdChunks, uniqueIds, ID_CHUNK, PAGE_SIZE } from './pagination.ts'

/**
 * Inbox restore at 1000+ threads.
 *
 * The admin inbox rendered "No messages yet" while holding 1097 live
 * conversations and 1305 messages. Two PostgREST limits, both silent:
 *
 *   - an unbounded select returned 1000 of 1097 participant rows
 *   - `.in('id', <1097 ids>)` overran the query string and was rejected at
 *     the HTTP layer -- measured live: 396 ids succeed, 400 fail
 *
 * The rejection carries no Postgres error code, and the caller destructured
 * only `data`, so `null` was read as "this user has no conversations". The
 * admin crossed the threshold mid-broadcast on 2026-08-31 and the inbox had
 * been empty ever since.
 *
 * No DOM harness here, as elsewhere in this repo: the helpers are executed
 * directly, the component's loader is modelled exactly, and source assertions
 * pin both files to the fixed shape.
 */

const MODAL = readFileSync(new URL('../../components/MessagesModal.tsx', import.meta.url), 'utf8')
const ROUTE = readFileSync(
  new URL('../../app/api/messages/participants/route.ts', import.meta.url),
  'utf8'
)
/** Executable text only, so a comment describing the old rule cannot pass. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
const modal = strip(MODAL)
const route = strip(ROUTE)

/** The live ceiling, so a fixture that would pass in production also fails here. */
const URL_LIMIT = 396
const ACTIVE = 1097
const HIDDEN = 158

const uuid = (n: number) => `t-${String(n).padStart(6, '0')}`

/**
 * A PostgREST stand-in with both real limits.
 *
 * Over the id ceiling it rejects the way the live server does -- an error with
 * no `code`, exactly what made this invisible.
 */
function fakeTable(rows: Record<string, any>[], idCol = 'id') {
  const calls: { ids: number; from: number; to: number }[] = []
  const query = (ids: string[], from: number, to: number) => {
    calls.push({ ids: ids.length, from, to })
    if (ids.length > URL_LIMIT) {
      return Promise.resolve({ data: null, error: { message: 'Bad Request' } })
    }
    const set = new Set(ids)
    const hit = rows.filter((r) => set.has(r[idCol]))
    const page = hit.slice(from, to + 1)
    // The row cap applies to every response, filtered or not.
    return Promise.resolve({ data: page.slice(0, PAGE_SIZE), error: null })
  }
  return { query, calls }
}

// ---------------------------------------------------------------- helpers

test('chunkIds splits 1097 ids into batches of at most 200', () => {
  const ids = Array.from({ length: ACTIVE }, (_, i) => uuid(i))
  const chunks = chunkIds(ids)
  assert.equal(ID_CHUNK, 200)
  assert.ok(chunks.every((c) => c.length <= 200), 'every chunk within the batch size')
  assert.equal(chunks.length, 6)
  assert.deepEqual(chunks.flat(), ids, 'no id dropped or reordered')
})

test('the batch size stays under the measured URL ceiling', () => {
  assert.ok(ID_CHUNK <= URL_LIMIT, `${ID_CHUNK} must not exceed the observed ${URL_LIMIT}`)
})

test('chunkIds of an empty list issues no request', () => {
  assert.deepEqual(chunkIds([]), [])
})

test('uniqueIds de-duplicates and drops empties, preserving order', () => {
  assert.deepEqual(uniqueIds(['b', 'a', 'b', null, 'a', undefined, 'c']), ['b', 'a', 'c'])
})

// ------------------------------------------------- 1. participant paging

test('1097 active participant rows are fully paged, not capped at 1000', async () => {
  const rows = Array.from({ length: ACTIVE }, (_, i) => ({ thread_id: uuid(i) }))
  let requests = 0
  const got = await pageAll<{ thread_id: string }>((from, to) => {
    requests++
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
  })
  assert.equal(got.length, ACTIVE, 'all 1097 rows, not 1000')
  assert.equal(requests, 2, 'paged rather than truncated')
})

test('paging stops when the final page is short', async () => {
  let requests = 0
  const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ thread_id: uuid(i) }))
  const got = await pageAll<{ thread_id: string }>((from, to) => {
    requests++
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
  })
  // An exactly-full page is ambiguous, so it asks once more and gets nothing.
  assert.equal(got.length, PAGE_SIZE)
  assert.equal(requests, 2)
})

test('hidden participant rows remain excluded', () => {
  assert.match(modal, /\.is\('deleted_at', null\)/, 'the deleted_at filter survives the rewrite')
  const total = ACTIVE + HIDDEN
  assert.equal(total, 1255, 'fixture matches the live split of 1097 active / 158 hidden')
})

// ------------------------------------------- 2-5. chunked message_threads

/** loadThreads(), as the component now writes it. */
async function loadInbox(threadIds: string[], table: ReturnType<typeof fakeTable>) {
  const ids = uniqueIds(threadIds)
  const rows = await fetchByIdChunks<any>(ids, (chunk, from, to) => table.query(chunk, from, to))
  return rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}

const threadRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: uuid(i),
    // Interleaved so a chunk-ordered result is visibly not a sorted one.
    updated_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  }))

test('1097 thread ids are split into chunks <= 200', async () => {
  const rows = threadRows(ACTIVE)
  const table = fakeTable(rows)
  await loadInbox(rows.map((r) => r.id), table)
  assert.ok(table.calls.length >= 6, 'chunked, not one oversized request')
  assert.ok(table.calls.every((c) => c.ids <= 200), 'no request exceeds the batch size')
})

test('the unchunked query this replaced would have failed', async () => {
  const rows = threadRows(ACTIVE)
  const table = fakeTable(rows)
  const { error } = await table.query(rows.map((r) => r.id), 0, PAGE_SIZE - 1)
  assert.ok(error, 'the old shape is rejected by the fixture, as in production')
  assert.equal((error as any).code, undefined, 'and carries no code to notice it by')
})

test('message_threads results from every chunk are concatenated', async () => {
  const rows = threadRows(ACTIVE)
  const got = await loadInbox(rows.map((r) => r.id), fakeTable(rows))
  assert.equal(got.length, ACTIVE, 'every thread survives')
})

test('no thread is lost at chunk boundaries', async () => {
  const rows = threadRows(ACTIVE)
  const got = await loadInbox(rows.map((r) => r.id), fakeTable(rows))
  const seen = new Set(got.map((r) => r.id))
  for (let i = 0; i < ACTIVE; i++) {
    assert.ok(seen.has(uuid(i)), `thread ${i} present`)
  }
  // The first id of each chunk after the first is the boundary case.
  for (const boundary of [0, 200, 400, 600, 800, 1000, ACTIVE - 1]) {
    assert.ok(seen.has(uuid(boundary)), `boundary thread ${boundary} present`)
  }
})

test('final inbox order is updated_at descending', async () => {
  const rows = threadRows(ACTIVE)
  const got = await loadInbox(rows.map((r) => r.id), fakeTable(rows))
  for (let i = 1; i < got.length; i++) {
    assert.ok(
      String(got[i - 1].updated_at) >= String(got[i].updated_at),
      `out of order at ${i}`
    )
  }
  assert.equal(got[0].updated_at, '2026-09-28T00:00:00.000Z', 'newest first')
})

test('duplicate thread ids do not duplicate inbox rows', async () => {
  const rows = threadRows(10)
  const dupes = [...rows.map((r) => r.id), ...rows.map((r) => r.id)]
  const table = fakeTable(rows)
  const got = await loadInbox(dupes, table)
  assert.equal(got.length, 10, 'de-duplicated before the request, not after')
  assert.equal(table.calls[0].ids, 10, 'the duplicate ids are never sent')
})

test('a chunk exceeding the row cap is itself paged', async () => {
  // 200 threads can hold far more than 200 messages.
  const msgs = Array.from({ length: 2000 }, (_, i) => ({ id: `m${i}`, thread_id: uuid(i % 200) }))
  const table = fakeTable(msgs, 'thread_id')
  const got = await fetchByIdChunks<any>(
    Array.from({ length: 200 }, (_, i) => uuid(i)),
    (chunk, from, to) => table.query(chunk, from, to)
  )
  assert.equal(got.length, 2000, 'all rows, past the 1000-row cap')
})

test('small inbox behavior remains unchanged', async () => {
  const rows = threadRows(3)
  const table = fakeTable(rows)
  const got = await loadInbox(rows.map((r) => r.id), table)
  assert.equal(table.calls.length, 1, 'one chunk, one request -- a short page ends it')
  assert.equal(got.length, 3)
  assert.equal(got[0].updated_at, '2026-09-03T00:00:00.000Z', 'newest first, as before')
})

// -------------------------------------------------- 10-11. failure modes

test('a chunk failure is surfaced as a load error, NOT "No messages yet"', async () => {
  const rows = threadRows(ACTIVE)
  const table = fakeTable(rows)
  let threw = false
  try {
    // The pre-fix call shape: every id in one request.
    await pageAll<any>((from, to) => table.query(rows.map((r) => r.id), from, to))
  } catch {
    threw = true
  }
  assert.ok(threw, 'the helper throws instead of returning null for the caller to misread')

  // And the component turns that throw into a load-failure state, never an
  // empty inbox.
  const loader = modal.slice(modal.indexOf('const loadThreads'), modal.indexOf('const loadThread ='))
  const catchAt = loader.indexOf('catch')
  assert.ok(catchAt > -1, 'the reads are wrapped in try/catch')
  const handler = loader.slice(catchAt, loader.indexOf('const meta = await fetchInboxMeta'))
  assert.match(handler, /setLoadFailed\(true\)/, 'the failure is recorded')
  assert.doesNotMatch(handler, /setThreads\(\[\]\)/, 'and never blanks the list')
})

test('the load-failure state renders its own message, not the empty state', () => {
  assert.match(modal, /if \(loadFailed\)/, 'checked before the empty/no-results branches')
  assert.ok(
    modal.indexOf('if (loadFailed)') < modal.indexOf('if (filteredThreads.length === 0)'),
    'the failure branch is reached first'
  )
  assert.match(MODAL, /Messages couldn&apos;t be loaded/)
  assert.match(MODAL, /Try again/)
})

test('the load error exposes no query, id or auth detail', () => {
  const loader = modal.slice(modal.indexOf('const loadThreads'), modal.indexOf('const loadThread ='))
  const logs = loader.match(/console\.(error|warn)\([\s\S]*?\)\n/g) ?? []
  assert.ok(logs.length > 0, 'the failure is logged')
  for (const line of logs) {
    assert.doesNotMatch(line, /threadIds|token|access_token|user\.id|message_text/)
    assert.match(line, /\?\.code|\?\.message|\?\.name|res\.status/, 'safe fields only')
  }
})

test('metadata failure does NOT erase otherwise loaded inbox threads', () => {
  const loader = modal.slice(modal.indexOf('const loadThreads'), modal.indexOf('const loadThread ='))
  const after = loader.slice(loader.indexOf('const meta = await fetchInboxMeta'))
  assert.match(after, /setMetaDegraded\(!meta\.ok\)/, 'the degradation is recorded')
  assert.doesNotMatch(
    after.slice(0, after.indexOf('processedThreads')),
    /setThreads\(\[\]\)/,
    'a metadata failure never empties the list'
  )
  // The list still renders; only the details degrade.
  assert.match(modal, /metaDegraded &&/, 'a notice is shown alongside the threads')
  assert.match(MODAL, /Some conversation details couldn&apos;t be loaded/)
})

test('fetchInboxMeta reports failure instead of returning valid-looking empty metadata', () => {
  const meta = modal.slice(modal.indexOf('const fetchInboxMeta'), modal.indexOf('const loadThreads'))
  assert.match(meta, /ok: false/, 'failure is distinguishable from genuinely empty metadata')
  assert.match(meta, /ok: true/)
  assert.match(meta, /console\.error/, 'and is not swallowed silently')
})

// ------------------------------------------------- 7-9. metadata route

test('participants metadata query chunks ids', () => {
  const step = route.slice(route.indexOf('const participants ='), route.indexOf('const messages ='))
  assert.match(step, /fetchByIdChunks/, 'chunked')
  assert.match(step, /\.in\('thread_id', chunk\)/, 'sends a chunk, never the whole list')
  assert.doesNotMatch(step, /\.in\('thread_id', threadIds\)/)
})

test('thread_messages metadata query chunks ids', () => {
  const step = route.slice(route.indexOf('const messages ='), route.indexOf('const authorized'))
  assert.match(step, /fetchByIdChunks/)
  assert.match(step, /\.in\('thread_id', chunk\)/)
  assert.doesNotMatch(step, /\.in\('thread_id', threadIds\)/)
})

test('every .in() in the metadata route sends a chunk, not a full id list', () => {
  const sites = route.match(/\.in\([^)]*\)/g) ?? []
  assert.equal(sites.length, 5, 'all five id filters accounted for')
  for (const site of sites) {
    assert.match(site, /chunk/, `unchunked id filter: ${site}`)
  }
})

test('metadata remains correct across multiple chunks', async () => {
  // Read state for 1305 messages spread over 1097 threads: the join the route
  // builds must not lose a row to chunking.
  const messages = Array.from({ length: 1305 }, (_, i) => ({
    id: `m${i}`,
    thread_id: uuid(i % ACTIVE),
  }))
  const reads = messages.map((m) => ({ message_id: m.id, user_id: 'u1', read_at: null }))
  const table = fakeTable(reads, 'message_id')
  const got = await fetchByIdChunks<any>(
    messages.map((m) => m.id),
    (chunk, from, to) => table.query(chunk, from, to)
  )
  assert.equal(got.length, 1305, 'every read-status row present')
  const byMessage = new Map(got.map((r) => [r.message_id, r]))
  assert.equal(byMessage.size, 1305, 'and none duplicated across chunks')
})

test('the browser never receives the service role key', () => {
  assert.doesNotMatch(modal, /SERVICE_ROLE/, 'service_role stays server-side')
  assert.match(route, /SUPABASE_SERVICE_ROLE_KEY/, 'and remains where it was')
})

// ------------------------------------- 14. product semantics unchanged

test('All / Unread / Read semantics remain unchanged', () => {
  assert.match(modal, /if \(messageFilter === 'unread'\) return !thread\.recipientHasRead/)
  assert.match(modal, /if \(messageFilter === 'read'\) return thread\.recipientHasRead/)
  assert.match(modal, /return true/)
})

test('grouped broadcast read progress is untouched', () => {
  assert.match(modal, /const readCount = members\.filter\(m => m\.recipientHasRead\)\.length/)
  assert.match(modal, /recipientHasRead: readCount === recipientCount/)
})

test('the unread badge still counts individual threads only', () => {
  assert.match(modal, /setGlobalMessagesUnreadCount\(individual\.filter\(t => t\.unreadCount > 0\)\.length\)/)
})
