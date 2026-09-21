// Persists one interview's transcript and engine state to `interview_sessions`.
// Framework-free: the page supplies a writer backed by its Supabase client, and
// the tests supply a scripted one.
import type { ChatMessage, InterviewMode, InterviewState } from './types.ts'

export type RowId = string | number

export interface WriteError {
  code?: string | null
  message?: string | null
  details?: string | null
  status?: number
}

/** Exactly the columns the page has always written, so stored rows keep their shape. */
export interface SessionRow {
  user_id: string
  school_type: string
  interview_type: string
  conversation: ChatMessage[]
  question_count: number
  reviewed: boolean
  mode?: InterviewMode
  engine_state?: InterviewState | null
  overall_score?: number | null
  readiness?: string | null
  /**
   * The deferred half of an open Practice checkpoint: the already-generated
   * next question and the post-turn state, held back until the applicant clicks
   * Continue.
   *
   * Persisted because that turn has ALREADY been spent. Without it, refreshing
   * while a review is on screen loses a question the interview has paid for,
   * and the only way to rebuild it is another model call. Null clears a
   * checkpoint that has been consumed.
   */
  pending_turn?: PendingTurnPayload | null
}

/** Mirrors the page's `pendingNext`, which is what it is rebuilt into. */
export interface PendingTurnPayload {
  message: ChatMessage
  state: InterviewState
  questionAsked: string
  isFinal: boolean
}

export interface SessionWriter {
  insert(row: SessionRow): Promise<{ id: RowId | null; error: WriteError | null }>
  update(id: RowId, row: SessionRow): Promise<{ error: WriteError | null }>
  /**
   * Finds the row an earlier INSERT of this interview may already have
   * created, when that INSERT's outcome is unknown (e.g. the response was lost
   * after the database committed it).
   */
  findExisting(match: { firstMessage: string; since: string }): Promise<{ id: RowId | null; error: WriteError | null }>
}

export interface SessionMeta {
  userId: string
  /** The type id: clinical, emotional, mixed or custom. Stored as `school_type`. */
  interviewType: string
  customTopic: string
  mode: InterviewMode
}

export interface SessionSnapshot {
  conversation: ChatMessage[]
  state: InterviewState | null
  /**
   * Present only while a Practice checkpoint is open. Explicitly null on every
   * other save, so consuming a checkpoint clears the stored one rather than
   * leaving a stale question behind for the next resume to find.
   */
  pendingTurn?: PendingTurnPayload | null
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface SaveResult {
  ok: boolean
  rowId: RowId | null
  error?: WriteError
}

/**
 * Whether the database has the engine columns (`mode`, `engine_state`,
 * `overall_score`, `readiness`). A missing column is a fact about the
 * deployment, so it is remembered for the page's life -- but ONLY a genuine
 * missing-column error can set it. The previous flag flipped on ANY failed
 * write, so one network blip or expired session permanently stopped the
 * engine state being saved for every later turn and every later interview in
 * that tab.
 */
export interface SchemaSupport {
  extendedColumns: boolean
  /**
   * Whether `pending_turn` exists yet. Stepped down on its own, BEFORE
   * extendedColumns, so a deployment that has the engine-state columns but not
   * this one keeps saving engine_state. Collapsing straight to the base row
   * would re-open the very defect Phase 0 closed.
   */
  pendingTurnColumn: boolean
}
export const schemaSupport: SchemaSupport = { extendedColumns: true, pendingTurnColumn: true }

/** Postgres "undefined column" and PostgREST's schema-cache equivalent. */
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204'])

export function isMissingColumnError(error: WriteError | null | undefined): boolean {
  if (!error) return false
  if (error.code && MISSING_COLUMN_CODES.has(error.code)) return true
  return /column .* does not exist|could not find the '.+' column/i.test(error.message || '')
}

/** Mirrors the page's previous base and extended payloads field for field. */
export function buildSessionRow(
  meta: SessionMeta,
  snapshot: SessionSnapshot,
  extended: boolean,
  pendingTurnColumn: boolean = true
): SessionRow {
  const { state } = snapshot
  const base: SessionRow = {
    user_id: meta.userId,
    school_type: meta.interviewType,
    interview_type: meta.customTopic || meta.interviewType,
    conversation: snapshot.conversation,
    question_count: state?.primaryQuestionNumber ?? 0,
    reviewed: false,
  }
  if (!extended) return base
  const row: SessionRow = {
    ...base,
    mode: state?.mode ?? meta.mode,
    engine_state: state,
    overall_score: state?.finalReport?.overall_score ?? null,
    readiness: state?.finalReport?.readiness ?? null,
  }
  // Always written when the column exists, never merely omitted: a checkpoint
  // that has been consumed has to be erased, and leaving the column untouched
  // would resume an applicant into a review they already moved past.
  if (pendingTurnColumn) row.pending_turn = snapshot.pendingTurn ?? null
  return row
}

export interface SessionSaverOptions {
  writer: SessionWriter
  meta: SessionMeta
  /** When the interview started; bounds the duplicate-row lookup. */
  startedAt: Date
  /**
   * The row a RESUMED interview is already stored in.
   *
   * Supplying it makes the first write an UPDATE instead of an INSERT, which
   * is what stops resuming from forking one interview into two rows -- and
   * skips the duplicate-row reconciliation entirely, because there is nothing
   * unknown about where this interview lives.
   */
  existingRowId?: RowId | null
  /** Waits between attempts on a transient failure. */
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
  onStatus?: (status: SaveStatus, error?: WriteError) => void
  schema?: SchemaSupport
}

export interface SessionSaver {
  /** Saves the newest snapshot. Resolves once it (or a newer one) is stored, or retries are exhausted. */
  save(snapshot: SessionSnapshot): Promise<SaveResult>
  /** Retries the newest unsaved snapshot, if any. */
  retry(): Promise<SaveResult>
  readonly rowId: RowId | null
  readonly status: SaveStatus
}

/** How far back the duplicate-row lookup looks; generous so clock skew cannot defeat it. */
const LOOKUP_WINDOW_MS = 6 * 60 * 60 * 1000
const DEFAULT_RETRY_DELAYS_MS = [500, 2000]

/**
 * One saver per interview.
 *
 * - Writes are serialized: at most one is in flight, and a save requested
 *   meanwhile is written after it. Every write is a full snapshot, so the
 *   newest snapshot always wins and a retry cannot duplicate a turn.
 * - The saver owns the row id. The page used to pass it in from React state,
 *   which a save could read before the first INSERT had resolved and then
 *   INSERT a second row for the same interview.
 * - A transient failure is retried, never treated as a schema fact.
 * - An INSERT whose outcome is unknown is reconciled before inserting again,
 *   so a lost response cannot create a second row.
 * - A failure is reported (status 'error' and `ok: false`), never swallowed.
 */
export function createSessionSaver(opts: SessionSaverOptions): SessionSaver {
  const { writer, meta } = opts
  const schema = opts.schema ?? schemaSupport
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const since = new Date(opts.startedAt.getTime() - LOOKUP_WINDOW_MS).toISOString()

  let rowId: RowId | null = opts.existingRowId ?? null
  let insertOutcomeUnknown = false
  let latest: SessionSnapshot | null = null
  let written: SessionSnapshot | null = null
  let status: SaveStatus = 'idle'
  let tail: Promise<unknown> = Promise.resolve()

  const setStatus = (next: SaveStatus, error?: WriteError) => {
    status = next
    opts.onStatus?.(next, error)
  }

  async function writeOnce(target: SessionSnapshot): Promise<{ ok: boolean; error?: WriteError }> {
    const extended = schema.extendedColumns
    const pendingTurnColumn = schema.pendingTurnColumn
    const row = buildSessionRow(meta, target, extended, pendingTurnColumn)

    if (rowId === null && insertOutcomeUnknown) {
      const first = target.conversation[0]?.content
      if (typeof first === 'string' && first) {
        const found = await writer.findExisting({ firstMessage: first, since })
        if (found.error) return { ok: false, error: found.error }
        if (found.id !== null && found.id !== undefined) rowId = found.id
      }
      insertOutcomeUnknown = false
    }

    if (rowId === null) {
      const inserted = await writer.insert(row)
      if (inserted.error) {
        if (isMissingColumnError(inserted.error)) {
          // Narrowest step first: drop only pending_turn, keep engine_state.
          if (pendingTurnColumn) {
            schema.pendingTurnColumn = false
            return writeOnce(target)
          }
          if (extended) {
            schema.extendedColumns = false
            return writeOnce(target)
          }
        }
        insertOutcomeUnknown = true
        return { ok: false, error: inserted.error }
      }
      if (inserted.id === null || inserted.id === undefined) {
        insertOutcomeUnknown = true
        return { ok: false, error: { code: 'NO_ROW_RETURNED', message: 'The session insert returned no row.' } }
      }
      rowId = inserted.id
      return { ok: true }
    }

    const updated = await writer.update(rowId, row)
    if (updated.error) {
      if (isMissingColumnError(updated.error)) {
        if (pendingTurnColumn) {
          schema.pendingTurnColumn = false
          return writeOnce(target)
        }
        if (extended) {
          schema.extendedColumns = false
          return writeOnce(target)
        }
      }
      // Includes NO_ROW: an update that matched nothing did not save anything,
      // and saying so beats a silent success. The row id is kept -- inserting
      // a replacement could duplicate the interview if the row still exists
      // but is momentarily invisible (e.g. the browser lost its session).
      return { ok: false, error: updated.error }
    }
    return { ok: true }
  }

  /** A writer that throws is reported like one that returns an error. */
  async function attemptWrite(target: SessionSnapshot): Promise<{ ok: boolean; error?: WriteError }> {
    try {
      return await writeOnce(target)
    } catch (thrown: any) {
      // An INSERT may have reached the database before the throw.
      if (rowId === null) insertOutcomeUnknown = true
      return { ok: false, error: { code: 'THROWN', message: String(thrown?.message ?? thrown) } }
    }
  }

  async function flushLatest(): Promise<SaveResult> {
    const target = latest
    if (!target || target === written) return { ok: true, rowId }
    let lastError: WriteError | undefined
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1])
      setStatus('saving')
      const result = await attemptWrite(target)
      if (result.ok) {
        written = target
        setStatus('saved')
        return { ok: true, rowId }
      }
      lastError = result.error
    }
    setStatus('error', lastError)
    return { ok: false, rowId, error: lastError }
  }

  function enqueue(): Promise<SaveResult> {
    const job = tail.then(flushLatest)
    tail = job.catch(() => undefined)
    return job
  }

  return {
    save(snapshot) {
      latest = snapshot
      return enqueue()
    },
    retry() {
      return enqueue()
    },
    get rowId() {
      return rowId
    },
    get status() {
      return status
    },
  }
}

/**
 * The production writer, over the page's Supabase client. Typed loosely so
 * this module needs no Supabase import; every call stays inside the signed-in
 * user's row-level security, exactly as the page's writes always have.
 */
export function supabaseSessionWriter(client: any, userId: string): SessionWriter {
  return {
    async insert(row) {
      const { data, error } = await client.from('interview_sessions').insert(row).select('id').single()
      return { id: data?.id ?? null, error: error ?? null }
    },
    async update(id, row) {
      const { data, error } = await client.from('interview_sessions').update(row).eq('id', id).select('id')
      if (error) return { error }
      if (!Array.isArray(data) || data.length === 0) {
        return { error: { code: 'NO_ROW', message: 'The interview session row was not found.' } }
      }
      return { error: null }
    },
    async findExisting({ firstMessage, since }) {
      const { data, error } = await client
        .from('interview_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('conversation->0->>content', firstMessage)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1)
      if (error) return { id: null, error }
      return { id: Array.isArray(data) && data[0] ? data[0].id : null, error: null }
    },
  }
}
