/**
 * Safe PostgREST list reads.
 *
 * Two independent limits break large inboxes, and fixing one does not fix the
 * other.
 *
 * 1. ROW CAP. An unbounded `select()` returns at most 1000 rows, silently.
 *    `pageAll` walks `.range()` windows until a short page ends the read.
 *
 * 2. URL LENGTH. `.in('id', ids)` is serialised into the query string, so a
 *    long id list overruns the request-line limit. Measured live against this
 *    project's Supabase instance: 396 UUIDs succeed, 400 fail. The failure is
 *    an HTTP-layer rejection -- `Bad Request`, or a bare `TypeError: fetch
 *    failed` -- NOT a Postgres or RLS error, so it carries no error code and
 *    is invisible to any caller that only destructures `data`.
 *
 *    Paging does not help here: `.range()` re-sends the whole id list on every
 *    page. Only `fetchByIdChunks`, which splits the ids themselves, does.
 *
 * This is what emptied the admin inbox: 1097 thread ids in one `.in()`,
 * rejected, the error discarded, and `null` read as "no conversations".
 */

/** Ids per request. 200 of 396 measured -- half the observed ceiling, so a
 *  longer id format or a stricter proxy still has room. */
export const ID_CHUNK = 200

/** Rows per `.range()` window, under the 1000-row cap. */
export const PAGE_SIZE = 900

type Result<T> = { data: T[] | null; error: any }
type Build<T> = (from: number, to: number) => PromiseLike<Result<T>>
type ChunkBuild<T> = (ids: string[], from: number, to: number) => PromiseLike<Result<T>>

/** Split ids into batches small enough to survive the query string. Empty in,
 *  empty out -- callers must not issue a request for no ids. */
export function chunkIds(ids: string[], size: number = ID_CHUNK): string[][] {
  if (size < 1) throw new Error('chunk size must be >= 1')
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * Read every row of a list query, past the 1000-row cap.
 *
 * Throws on error rather than returning a partial list: a caller that cannot
 * tell a complete read from a truncated one is exactly the defect this file
 * exists to fix.
 */
export async function pageAll<T>(build: Build<T>, pageSize: number = PAGE_SIZE): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) throw new Error(error.message || error.code || 'query failed')
    const rows = data ?? []
    out.push(...rows)
    // A short page is the last page. A full page may or may not be, so ask again.
    if (rows.length < pageSize) return out
  }
}

/**
 * Read every row matching a long id list, past BOTH limits: the ids are split
 * into chunks, and each chunk is itself paged in case one chunk's rows exceed
 * the row cap (200 threads can hold far more than 200 messages).
 *
 * Chunks are disjoint, so concatenation cannot duplicate a row unless the
 * caller passed a duplicate id -- de-duplicate ids before calling.
 */
export async function fetchByIdChunks<T>(
  ids: string[],
  build: ChunkBuild<T>,
  opts: { chunkSize?: number; pageSize?: number } = {}
): Promise<T[]> {
  const chunkSize = opts.chunkSize ?? ID_CHUNK
  const pageSize = opts.pageSize ?? PAGE_SIZE
  const out: T[] = []
  for (const chunk of chunkIds(ids, chunkSize)) {
    const rows = await pageAll<T>((from, to) => build(chunk, from, to), pageSize)
    out.push(...rows)
  }
  return out
}

/** Distinct ids, order preserved. */
export function uniqueIds(ids: (string | null | undefined)[]): string[] {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))))
}
