/**
 * Local test drafts, shaped as a Supabase query builder.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IMPERSONATES THE DATABASE RATHER THAN REPLACING THE REPOSITORY
 * ---------------------------------------------------------------------------
 * The obvious design is a branch at the top of each draftRepo function:
 * `if (simulatedLive()) return localCreate(...)`. That works and it is wrong
 * here, because the thing under review IS draftRepo -- its optimistic
 * concurrency, its refusal codes, its row parsing, its integrity checks. A
 * branch would route the reviewer around the code they are trying to review and
 * leave five production functions carrying a development concern.
 *
 * So this is a query builder instead. draftRepo is not modified, not imported
 * here, and does not know it exists; it issues exactly the chains it always
 * issues and gets rows back. Every refusal path, every revision conflict and
 * every parse is the real one. The storage underneath is a JSON file.
 *
 * THE CHAINS IT HAS TO SERVE, which are all draftRepo issues:
 *
 *   .insert(row).select(cols).maybeSingle()
 *   .select(cols).eq('id', x).maybeSingle()
 *   .select(cols).eq('user_id', x).order('updated_at', {ascending:false})
 *   .update(patch).eq('id', x).eq('revision', r).select(cols).maybeSingle()
 *   .delete().eq('id', x).select('id').maybeSingle()
 *
 * Anything else throws rather than returning a plausible empty result, because
 * a silently wrong answer here would look like an application bug and be
 * debugged as one.
 *
 * COLUMNS ARE NOT PROJECTED. `select(...)` records that rows should come back
 * and ignores the column list: returning a superset is harmless -- the row
 * parsers read the fields they want -- while returning a subset would break
 * them. The one place it matters, `delete().select('id')`, is satisfied by a
 * full row too.
 *
 * NOTHING HERE IS PRODUCTION DATA. The file sits in local-review/, which is
 * gitignored, and is only ever reached in simulated-live mode.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { readJsonStore, writeJsonStore } from './jsonStore.ts'
import { randomUUID } from 'node:crypto'
import { maxSavedChars } from '../extract/limits.ts'

/**
 * Where the local drafts live.
 *
 * OVERRIDABLE SO TESTS DO NOT EAT THE OWNER'S REVIEW DRAFTS. The suites that
 * exercise this store rewrite and delete it, and `node --test` runs files
 * concurrently -- so two of them sharing one path raced, and whichever ran
 * second found the other's rows. Each suite now points at its own file, and
 * nothing a test does can reach the drafts created by hand in the browser.
 *
 * Read once, at load: a request must never be able to move the store.
 */
const STORE = path.join(
  process.cwd(),
  'local-review',
  // A FILE NAME, NEVER A PATH. basename() drops any directory part, so no value
  // of the variable can move the store out of the one gitignored directory this
  // module is allowed to write in -- '../../something' included.
  path.basename(process.env.STATEMENT_LOCAL_DRAFTS_FILE ?? 'dev-drafts.json'),
)

type Row = Record<string, unknown>
type Result = { data: unknown; error: { code: string; message: string } | null }

/** Every column the draft parsers read, so a stored row is never short one. */
const COLUMNS = [
  'id', 'user_id', 'title', 'essay', 'revision', 'created_at', 'updated_at',
  'school_id', 'prompt_id', 'prompt_text', 'stated_max_words',
  'requirement_id', 'requirement_snapshot',
  // 20261002_001. A draft started from a prompt the applicant pasted points at
  // their submission; readDraftPromptStatus selects exactly this column, so a
  // row without it reads as "no submission" and the editor would stop saying
  // the prompt is awaiting review.
  'prompt_submission_id',
  // 20261011_013: the constrained editor document, beside the plain essay.
  'editor_document', 'editor_document_version',
  // 20261013_015: the bundled face this draft is laid out in.
  'document_font',
] as const

/**
 * Every stored draft.
 *
 * AN UNREADABLE STORE THROWS; IT DOES NOT READ AS EMPTY. This used to be
 * `catch { return [] }`, with no check for whether the file existed -- so a
 * read that landed inside a write saw a truncated file, reported no drafts,
 * and the caller then wrote that empty view back. A saved draft disappeared,
 * permanently, from a fault that lasted microseconds.
 */
function readAll(): Row[] {
  const parsed = readJsonStore<unknown>(STORE, [])
  return Array.isArray(parsed) ? (parsed as Row[]) : []
}

/** Written beside the store and renamed over it, so no reader sees a partial file. */
function writeAll(rows: Row[]): void {
  writeJsonStore(STORE, rows)
}

/** Absent keys become null, never undefined: the row parsers distinguish them. */
function complete(row: Row): Row {
  const out: Row = {}
  for (const column of COLUMNS) out[column] = row[column] ?? null
  return out
}

/**
 * The column CHECK this store stands in for.
 *
 * ---------------------------------------------------------------------------
 * A STAND-IN THAT ACCEPTS WHAT THE TABLE WOULD REFUSE IS NOT A REHEARSAL
 * ---------------------------------------------------------------------------
 * `statement_drafts` carries statement_drafts_essay_length. This store carried
 * nothing, so every length was saveable locally -- which meant a local pass
 * proved only that the ROUTE's own validation had refused first, and would
 * have said nothing at all about a path that reached the table another way.
 *
 * SO THE CHECK IS EMULATED, at whatever ceiling maxSavedChars() reports. In
 * simulated live that is the post-016 figure, which is the point: the
 * rehearsal is of the schema we are about to have, and 30,001 characters are
 * refused here exactly as the migrated column would refuse them.
 *
 * THE ERROR IS POSTGRES-SHAPED. 23514 is check_violation and the constraint
 * is named, because that is what draftRepo would receive from PostgREST and
 * anything else would rehearse the wrong failure.
 *
 * TITLE AND ESSAY BOTH, since the same migration's CHECK covers the title
 * bounds that validate.ts mirrors.
 */
const ESSAY_CONSTRAINT = 'statement_drafts_essay_length'

function checkViolation(row: Row): Result | null {
  const essay = row.essay
  if (typeof essay !== 'string') return null
  const ceiling = maxSavedChars()
  if (essay.length <= ceiling) return null
  return {
    data: null,
    error: {
      code: '23514',
      message: 'new row for relation "statement_drafts" violates check constraint '
        + `"${ESSAY_CONSTRAINT}"`,
    },
  }
}

/** A private sentinel, so `is(column, null)` cannot collide with a stored value. */
const NULL_MATCH = Symbol('is-null')

class LocalDraftQuery implements PromiseLike<Result> {
  private operation: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private payload: Row = {}
  private filters: [string, unknown][] = []
  private ordering: { column: string; ascending: boolean } | null = null
  private wantsRows = false
  private singleRow = false

  insert(values: Row): this {
    this.operation = 'insert'
    this.payload = values
    return this
  }

  update(values: Row): this {
    this.operation = 'update'
    this.payload = values
    return this
  }

  delete(): this {
    this.operation = 'delete'
    return this
  }

  select(_columns?: string): this {
    if (this.operation === 'select') this.wantsRows = true
    else this.wantsRows = true
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value])
    return this
  }

  /**
   * `.is(column, null)` -- the only form PostgREST's `is` is used in here.
   *
   * ADDED FOR THE CONTENT INVARIANT. draftRepo's update requires
   * `editor_document is null` when a body carries no document, so that an
   * essay-only save cannot rewind a formatted draft's text (AI-QA-001). Without
   * this method the local store threw `write.is is not a function`, which would
   * have left the guard unexercised in exactly the environment the mocked QA
   * runs in -- and a guard nobody can reach locally is a guard nobody tests.
   *
   * SQL NULL SEMANTICS, DELIBERATELY: a column that was never written is
   * `undefined` on a local row and NULL in the database, and both must match
   * `is null`. That is why this is not simply `eq(column, null)`.
   */
  is(column: string, value: null): this {
    this.filters.push([column, value === null ? NULL_MATCH : value])
    return this
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering = { column, ascending: options?.ascending !== false }
    return this
  }

  maybeSingle(): this {
    this.singleRow = true
    return this
  }

  single(): this {
    this.singleRow = true
    return this
  }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }

  private matches(row: Row): boolean {
    // eq on a stored string compares as the database would after its own
    // coercion; revision arrives as a number from draftRepo and is stored as one.
    return this.filters.every(([column, value]) => (
      value === NULL_MATCH
        // `is null` matches a stored NULL and a column never written.
        ? row[column] === null || row[column] === undefined
        : row[column] === value))
  }

  private run(): Result {
    const rows = readAll()

    if (this.operation === 'insert') {
      const now = new Date().toISOString()
      const created = complete({
        ...this.payload,
        id: this.payload.id ?? randomUUID(),
        revision: this.payload.revision ?? 1,
        created_at: now,
        updated_at: now,
      })
      // THE CHECK, BEFORE THE WRITE. See checkViolation.
      const refused = checkViolation(created)
      if (refused !== null) return refused
      writeAll([...rows, created])
      return { data: this.wantsRows ? created : null, error: null }
    }

    if (this.operation === 'update') {
      const index = rows.findIndex((row) => this.matches(row))
      // NO MATCH IS NOT AN ERROR. draftRepo reads this as a revision conflict
      // and goes on to re-read the row -- which is the behaviour under review,
      // so it must be reachable here.
      if (index < 0) return { data: null, error: null }
      const updated = complete({ ...rows[index], ...this.payload })
      // THE CHECK APPLIES TO AN UPDATE TOO, which is the path an applicant
      // writing past the ceiling actually takes.
      const refused = checkViolation(updated)
      if (refused !== null) return refused
      const next = [...rows]
      next[index] = updated
      writeAll(next)
      return { data: this.wantsRows ? updated : null, error: null }
    }

    if (this.operation === 'delete') {
      const index = rows.findIndex((row) => this.matches(row))
      if (index < 0) return { data: null, error: null }
      const [removed] = rows.splice(index, 1)
      writeAll(rows)
      return { data: this.wantsRows ? (removed ?? null) : null, error: null }
    }

    let found = rows.filter((row) => this.matches(row))
    if (this.ordering !== null) {
      const { column, ascending } = this.ordering
      found = [...found].sort((a, b) => {
        const left = String(a[column] ?? '')
        const right = String(b[column] ?? '')
        return ascending ? left.localeCompare(right) : right.localeCompare(left)
      })
    }
    if (this.singleRow) return { data: found[0] ?? null, error: null }
    return { data: found, error: null }
  }
}

/** The builder `.from('statement_drafts')` returns in simulated-live mode. */
export function localDraftsBuilder(): LocalDraftQuery {
  return new LocalDraftQuery()
}

/** Used by tests and by the reset control; never by a request path. */
export function resetLocalDrafts(): void {
  writeAll([])
}

/** How many local drafts exist. For the banner, and for tests. */
/**
 * Write one draft row directly.
 *
 * FOR THE ATOMIC CREATE ONLY. create_statement_draft_with_prompt_submission
 * writes a draft and a submission in one transaction, and the local stand-in
 * for it needs to do both; going through the query builder twice would be two
 * writes that can half-succeed, which is the thing that function exists to
 * prevent. Nothing else may use this: every ordinary path goes through
 * localDraftsBuilder() so the repository's own code runs.
 */
export function insertLocalDraftRow(row: Row): Row {
  const now = new Date().toISOString()
  const created = complete({
    ...row,
    id: row.id ?? randomUUID(),
    revision: row.revision ?? 1,
    created_at: now,
    updated_at: now,
  })
  writeAll([...readAll(), created])
  return created
}

export function localDraftCount(): number {
  return existsSync(STORE) ? readAll().length : 0
}
