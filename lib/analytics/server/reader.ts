import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Reading the database for the dashboard, honestly.
 *
 * THREE THINGS THIS EXISTS TO PREVENT, all of them mistakes the old analytics
 * page actually made:
 *
 *   1. SILENT TRUNCATION. PostgREST caps an unbounded select at 1000 rows for
 *      every role, service_role included. The old page read `select('*')` and
 *      displayed the result as a total, so "Questions Asked" said 1000 against
 *      a real 3,842. Every read here pages to the end, and if it reaches its
 *      ceiling it says so rather than returning a smaller number.
 *
 *   2. UNORDERED PAGING. Range paging with no ORDER BY can skip or repeat rows
 *      between pages, because nothing obliges Postgres to return them in the
 *      same order twice. Every paged read is ordered.
 *
 *   3. A FAILURE THAT LOOKS LIKE ZERO. A table this server cannot read -- the
 *      GPA tables deliberately grant service_role nothing -- must reach the
 *      page as "needs a migration", not as a confident 0.
 */

/** Rows per request. Below PostgREST's 1000 ceiling, with room to spare. */
const PAGE_SIZE = 900

/** A single read will not pull more than this. Reaching it is reported. */
const DEFAULT_MAX_ROWS = 60_000

export type ReadFailure = 'missing' | 'denied' | 'failed'

export type ReadResult<T> =
  | { readonly ok: true; readonly rows: T[]; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: ReadFailure; readonly detail: string }

export type CountResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: ReadFailure; readonly detail: string }

/**
 * What a Postgres error means for the dashboard.
 *
 * 42501 is the one that matters most: it is what a table whose privileges were
 * deliberately revoked from service_role returns, and it deserves a different
 * message from a table that is simply broken.
 */
export function classifyError(
  error: { code?: string | null; message?: string | null } | null,
  status?: number | null
): { reason: ReadFailure; detail: string } {
  // THE HTTP STATUS IS THE RELIABLE SIGNAL. A table whose privileges were
  // revoked from the server role answers 403 with an EMPTY error body — no
  // code, no message — which was reaching the dashboard as "Reading gpa_drafts
  // failed:" with nothing after the colon. Observed against the live database:
  // gpa_drafts returns 403 Forbidden, gpa_calculations returns 200.
  if (status === 401 || status === 403) {
    return { reason: 'denied', detail: error?.message || `HTTP ${status}` }
  }
  if (status === 404) return { reason: 'missing', detail: error?.message || 'HTTP 404' }

  const code = error?.code ?? ''
  const message = error?.message || 'no error message was returned'
  if (code === '42P01' || code === '42703' || code === 'PGRST205') return { reason: 'missing', detail: message }
  if (code === '42501' || code === 'PGRST301') return { reason: 'denied', detail: message }
  return { reason: 'failed', detail: message }
}

export type PageFetcher<T> = (
  from: number,
  to: number
) => Promise<{ ok: true; rows: T[] } | { ok: false; reason: ReadFailure; detail: string }>

/**
 * Pages until a short page arrives or the ceiling is hit.
 *
 * Separated from Supabase so the loop itself is testable: the paging bug it
 * replaces was invisible precisely because nothing could exercise it.
 */
export async function pageAll<T>(
  fetchPage: PageFetcher<T>,
  options: { pageSize?: number; maxRows?: number } = {}
): Promise<ReadResult<T>> {
  const pageSize = options.pageSize ?? PAGE_SIZE
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const rows: T[] = []

  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1)
    if (!page.ok) return { ok: false, reason: page.reason, detail: page.detail }

    rows.push(...page.rows)

    if (page.rows.length < pageSize) return { ok: true, rows, truncated: false }
    if (rows.length >= maxRows) return { ok: true, rows: rows.slice(0, maxRows), truncated: true }
  }
}

export type RowQuery = {
  /** The column a window filters on, and the order rows are paged in. */
  readonly dateColumn?: string
  readonly from?: string | null
  readonly to?: string | null
  /** Tie-break column, so paging is deterministic even on equal timestamps. */
  readonly tiebreak?: string
  readonly equals?: Readonly<Record<string, string | number | boolean>>
  readonly maxRows?: number
}

export type Reader = {
  /** Every matching row, paged and ordered. */
  rows<T>(table: string, columns: string, query?: RowQuery): Promise<ReadResult<T>>
  /** An exact count with no rows transferred. */
  count(table: string, query?: Omit<RowQuery, 'tiebreak' | 'maxRows'>): Promise<CountResult>
  /** The oldest timestamp a table holds, so coverage is observed, not assumed. */
  earliest(table: string, dateColumn: string): Promise<string | null>
  /** Every account, from the auth schema. */
  authUsers(): Promise<ReadResult<AuthUserRow>>
}

export type AuthUserRow = {
  id: string
  email: string | null
  created_at: string
  email_confirmed_at: string | null
  last_sign_in_at: string | null
}

export function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

export function createReader(admin: SupabaseClient): Reader {
  const applyFilters = (builder: any, query: RowQuery) => {
    if (query.dateColumn && query.from) builder = builder.gte(query.dateColumn, query.from)
    if (query.dateColumn && query.to) builder = builder.lt(query.dateColumn, query.to)
    for (const [column, value] of Object.entries(query.equals ?? {})) {
      builder = builder.eq(column, value)
    }
    return builder
  }

  return {
    async rows<T>(table: string, columns: string, query: RowQuery = {}): Promise<ReadResult<T>> {
      const order = query.dateColumn
      return pageAll<T>(
        async (from, to) => {
          let builder: any = admin.from(table).select(columns)
          builder = applyFilters(builder, query)
          if (order) builder = builder.order(order, { ascending: true })
          if (query.tiebreak) builder = builder.order(query.tiebreak, { ascending: true })
          const { data, error, status } = await builder.range(from, to)
          if (error) {
            const { reason, detail } = classifyError(error, status)
            return { ok: false, reason, detail }
          }
          return { ok: true, rows: (data ?? []) as T[] }
        },
        { maxRows: query.maxRows }
      )
    },

    async count(table: string, query: Omit<RowQuery, 'tiebreak' | 'maxRows'> = {}): Promise<CountResult> {
      let builder: any = admin.from(table).select('*', { count: 'exact', head: true })
      builder = applyFilters(builder, query)
      const { count, error, status } = await builder
      if (error) {
        const { reason, detail } = classifyError(error, status)
        return { ok: false, reason, detail }
      }
      return { ok: true, count: count ?? 0 }
    },

    async earliest(table: string, dateColumn: string): Promise<string | null> {
      const { data, error } = await admin
        .from(table)
        .select(dateColumn)
        .order(dateColumn, { ascending: true })
        .limit(1)
      if (error || !data || data.length === 0) return null
      // PostgREST types a dynamic column selection loosely; the value is read
      // back defensively rather than asserted into a shape.
      const value = (data[0] as unknown as Record<string, unknown>)[dateColumn]
      return typeof value === 'string' ? value : null
    },

    async authUsers(): Promise<ReadResult<AuthUserRow>> {
      const rows: AuthUserRow[] = []
      for (let page = 1; page <= 50; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
        if (error) return { ok: false, reason: 'failed', detail: error.message }
        const batch = data?.users ?? []
        for (const user of batch) {
          rows.push({
            id: user.id,
            email: user.email ?? null,
            created_at: user.created_at,
            email_confirmed_at: (user as any).email_confirmed_at ?? null,
            last_sign_in_at: user.last_sign_in_at ?? null,
          })
        }
        if (batch.length < 1000) return { ok: true, rows, truncated: false }
      }
      return { ok: true, rows, truncated: true }
    },
  }
}
