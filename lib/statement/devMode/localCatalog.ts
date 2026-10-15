/**
 * The requirement catalog, served as database rows from the local payload.
 *
 * WHY THIS AND NOT A BRANCH IN repo.ts. The catalog reader is reachable from a
 * CLIENT component (NewDraftDialog -> newDraftFlow -> repo.ts). A branch there
 * -- even behind `await import()` -- makes webpack build the imported chunk for
 * the browser too, and this payload is read with node:fs, so the bundle fails.
 * Serving it as a query builder keeps every simulated-live concern inside
 * lib/statement/devMode/, which no client component imports, and leaves
 * repo.ts byte-identical to what production runs.
 *
 * WHAT IT SIMULATES. Production holds 63 sets, all `is_active = false`. This
 * returns only the sets 005 would ALLOW to be activated -- verified, with a
 * source URL and a checked-on date -- which is 62 of them. University of South
 * Dakota is `needs-review` and is therefore not returned, exactly as the
 * database would withhold it. The activation is simulated by this filter; no
 * `is_active` value is changed anywhere.
 *
 * ROWS, NOT OBJECTS. repo.ts parses what it gets with its own row parsers, so
 * what it gets must be shaped like a row. The payload already is: it was
 * generated from the same import package, with the same column names.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { SimulatedLiveWriteBlocked } from './gate.ts'
import {
  activeLocalCanonical, localCanonical, supersededRequirementIds,
} from './localCanonical.ts'

const PAYLOAD = path.join(
  process.cwd(), 'local-review', 'statement_requirements_catalog.json')

type Row = Record<string, unknown>
type Result = { data: unknown; error: { code: string; message: string } | null }

interface Payload { sets: Row[]; documents: Row[] }

let cache: Payload | null = null

/** Verified, sourced and dated: the rule 005's activation constraint applies. */
function activatable(set: Row): boolean {
  return set.verification_status === 'verified'
    && typeof set.source_url === 'string' && set.source_url.length > 0
    && typeof set.verified_on === 'string' && set.verified_on.length > 0
}

/**
 * The imported payload, cached.
 *
 * SAFE TO CACHE, AND ONLY THIS HALF IS. local-review/statement_requirements_
 * catalog.json is a copy of production taken at import time: it does not change
 * while the dev server runs, and re-parsing 180KB on every query would be
 * waste.
 */
function loadPayload(): Payload {
  if (cache !== null) return cache
  try {
    const parsed = JSON.parse(readFileSync(PAYLOAD, 'utf8')) as Payload
    const sets = (Array.isArray(parsed.sets) ? parsed.sets : []).filter(activatable)
    const ids = new Set(sets.map((set) => set.id))
    const documents = (Array.isArray(parsed.documents) ? parsed.documents : [])
      .filter((doc) => ids.has(doc.set_id))
    cache = { sets, documents }
  } catch {
    cache = { sets: [], documents: [] }
  }
  return cache
}

function load(): Payload {
  const payload = loadPayload()
  /*
   * THE LOCAL HALF IS READ FRESH, EVERY TIME, AND THAT IS NOT AN OPTIMISATION
   * QUESTION.
   *
   * The union used to be computed inside the cached branch, so the first
   * catalog query of a process fixed the answer for the life of that process.
   * An administrator could press "Activate for Local Preview", get a 200, go to
   * the applicant flow in the same dev server, and still see nothing -- the
   * activation had happened and the reader was answering from a snapshot taken
   * before it. Nothing errored; the feature simply appeared not to work.
   *
   * dev-canonical.json changes DURING a review session, by design: that is what
   * the preview toggle is. So it is re-read per query, which costs a few
   * kilobytes of JSON on a developer's machine and makes the toggle mean what
   * it says.
   *
   * THE UNION IS HOW "NOTHING BECOMES VISIBLE BY SAVING" IS OBSERVABLE. A
   * promotion writes an INACTIVE set, so activeLocalCanonical() returns nothing
   * for it and an applicant sees exactly what they saw before. After a
   * deliberate activation it appears here, beside production's, and the
   * ordinary applicant screens render it.
   *
   * THE PRODUCTION PAYLOAD IS NEVER WRITTEN. These rows live in their own file;
   * this only reads both.
   */
  const local = activeLocalCanonical()
  const superseded = supersededRequirementIds()
  if (local.sets.length === 0 && local.documents.length === 0 && superseded.size === 0) {
    return payload
  }
  const documents = [...payload.documents, ...local.documents]
  return {
    sets: [...payload.sets, ...local.sets],
    /*
     * A REPLACED PROMPT IS NO LONGER OFFERED.
     *
     * THIS IS THE LOCAL STAND-IN FOR DEACTIVATING THE OLD ROW. In production,
     * 20261008_012's replace path sets the superseded requirement inactive and
     * records supersedes_requirement_id on its replacement. The superseded row
     * usually lives in the production payload copy, which this file must never
     * write -- so the removal is applied as a filter over the union instead,
     * and the record of what replaced what lives in the local store.
     *
     * NOT DELETED, NOT HIDDEN FROM THE ADMINISTRATOR. localSupersessions()
     * still reports every replacement, and the replaced wording is still in
     * the payload. What changes is only what an applicant is offered as
     * current, which is exactly the observable effect of deactivation.
     */
    documents: superseded.size === 0
      ? documents
      : documents.filter((doc) => !superseded.has(String(doc.id))),
  }
}

class LocalCatalogQuery implements PromiseLike<Result> {
  private readonly rows: Row[]
  private readonly table: string
  private filters: [string, unknown][] = []
  private membership: [string, readonly unknown[]] | null = null
  private ordering: { column: string; ascending: boolean } | null = null
  private singleRow = false

  constructor(rows: Row[], table: string) { this.rows = rows; this.table = table }

  select(_columns?: string): this { return this }
  eq(column: string, value: unknown): this { this.filters.push([column, value]); return this }
  in(column: string, values: readonly unknown[]): this {
    this.membership = [column, values]
    return this
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering = { column, ascending: options?.ascending !== false }
    return this
  }
  maybeSingle(): this { this.singleRow = true; return this }
  single(): this { this.singleRow = true; return this }

  // THE CATALOG IS READ-ONLY HERE, and says so with the same error the guarded
  // client raises. Without these a write attempt would die on "insert is not a
  // function", which is true but explains nothing.
  insert(): never { throw new SimulatedLiveWriteBlocked('insert', this.table) }
  update(): never { throw new SimulatedLiveWriteBlocked('update', this.table) }
  upsert(): never { throw new SimulatedLiveWriteBlocked('upsert', this.table) }
  delete(): never { throw new SimulatedLiveWriteBlocked('delete', this.table) }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }

  private run(): Result {
    let found = this.rows.filter(
      (row) => this.filters.every(([column, value]) => row[column] === value))
    if (this.membership !== null) {
      const [column, values] = this.membership
      const wanted = new Set(values)
      found = found.filter((row) => wanted.has(row[column]))
    }
    if (this.ordering !== null) {
      const { column, ascending } = this.ordering
      found = [...found].sort((a, b) => {
        const left = Number(a[column] ?? 0)
        const right = Number(b[column] ?? 0)
        if (Number.isNaN(left) || Number.isNaN(right)) {
          return ascending
            ? String(a[column] ?? '').localeCompare(String(b[column] ?? ''))
            : String(b[column] ?? '').localeCompare(String(a[column] ?? ''))
        }
        return ascending ? left - right : right - left
      })
    }
    if (this.singleRow) return { data: found[0] ?? null, error: null }
    return { data: found, error: null }
  }
}

/** The builder for one of the two catalog tables, or null for anything else. */
/**
 * The imported catalog, UNFILTERED, for the admin catalog manager.
 *
 * NOT WHAT THE APPLICANT READER USES. load() above filters the payload by
 * activatable() -- verified, with a source and a date -- because that is the
 * condition 20261002_005 puts on ever activating a set, and an applicant must
 * never be shown a set production would refuse to publish. The result is 62 of
 * the 63 imported sets.
 *
 * AN ADMINISTRATOR NEEDS THE OTHER ONE. South Dakota is withheld from the
 * applicant view precisely because its verification is 'needs-review', and a
 * catalog manager whose job includes finding exactly those rows cannot be shown
 * a list with them silently removed. So this returns all 63, with their real
 * verification status, and the screen filters.
 *
 * STILL READ-ONLY. This is the same file, read the same way; nothing here
 * writes, and the manager marks every row it returns as production-backed.
 */
let importedCache: Payload | null = null

export function importedCatalog(): Payload {
  if (importedCache !== null) return importedCache
  try {
    const parsed = JSON.parse(readFileSync(PAYLOAD, 'utf8')) as Payload
    importedCache = {
      sets: Array.isArray(parsed.sets) ? parsed.sets : [],
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
    }
  } catch {
    importedCache = { sets: [], documents: [] }
  }
  return importedCache
}

export function localCatalogBuilder(table: string): LocalCatalogQuery | null {
  const payload = load()
  if (table === 'statement_requirement_sets') return new LocalCatalogQuery(payload.sets, table)
  if (table === 'statement_requirements') return new LocalCatalogQuery(payload.documents, table)
  return null
}

/**
 * One requirement row by id, WHETHER OR NOT IT IS STILL OFFERED.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ADMIN QUEUE NEEDS A READER THAT IGNORES THE FILTERS
 * ---------------------------------------------------------------------------
 * A "this prompt has changed" report is reviewed by reading the row it
 * contradicts beside the wording the applicant sent. load() answers what an
 * APPLICANT is offered, and after a replacement the superseded row is
 * deliberately no longer in that answer -- so the queue would lose the left
 * half of the comparison for exactly the decisions already taken, which is
 * when the history matters most.
 *
 * READ-ONLY, AND IT SAYS WHICH HALF IT CAME FROM. `source` lets the screen
 * distinguish a production row from one promoted locally, and `offered` says
 * whether an applicant would currently see it -- neither is inferred by the
 * caller.
 */
export function localRequirementRow(requirementId: string): {
  readonly row: Row
  readonly source: 'imported' | 'local'
  readonly offered: boolean
} | null {
  const offered = new Set(load().documents.map((doc) => String(doc.id)))
  const imported = importedCatalog().documents.find((doc) => String(doc.id) === requirementId)
  if (imported !== undefined) {
    return { row: imported, source: 'imported', offered: offered.has(requirementId) }
  }
  const local = localCanonical().documents.find((doc) => String(doc.id) === requirementId)
  if (local !== undefined) {
    return { row: local, source: 'local', offered: offered.has(requirementId) }
  }
  return null
}

/** For the banner and for tests: what the simulated catalog actually serves. */
export function localCatalogCounts(): {
  readonly sets: number; readonly documents: number
} {
  const payload = load()
  return { sets: payload.sets.length, documents: payload.documents.length }
}
