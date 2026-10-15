/**
 * A local stand-in for the production analysis cache, for simulated-live only.
 *
 * WHY IT EXISTS. The real analyser now runs on localhost, and every run is a
 * paid request. Production's protection against paying twice for the same essay
 * is the `statement_analyses` cache, reached through two RPCs -- and both are
 * forbidden here, because they would write to production. Without a substitute,
 * reopening a draft or clicking twice would be two charges for one answer, and
 * the saved-result behaviour could not be reviewed at all.
 *
 * SO IT IMITATES THE CACHE AND NOTHING ELSE. One JSON file, keyed exactly as
 * production keys its rows -- (draft_id, fingerprint) -- so the behaviour being
 * reviewed is the real one:
 *
 *   identical essay + identical requirement -> the stored result, no model call
 *   a changed essay                         -> a different fingerprint, so a
 *                                              fresh real call
 *
 * WHAT IT DELIBERATELY DOES NOT IMITATE. There is no claim, no `running` state
 * and no concurrency protection, because a single developer's machine has no
 * second caller to protect against and inventing one would be a second
 * implementation of the thing production already does correctly. Two
 * simultaneous local clicks would make two real calls; that is a limitation,
 * not a design.
 *
 * IT CANNOT BE REACHED FROM PRODUCTION. Nothing imports this module except the
 * analyze route's simulated-live branch and the editor page's, both behind
 * simulatedLiveEnabled(), which is false in every deployed build.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeJsonStore } from './jsonStore.ts'
import type { StatementReview } from '../draft/reviewSchema.ts'

/**
 * Where the local analyses live.
 *
 * SAME RULES AS THE DRAFT STORE: a fixed gitignored directory, and the file
 * name reduced to a basename so no value of the variable can relocate it. The
 * override exists so the test suite never deletes the results of a review
 * session done by hand in the browser.
 */
const STORE = path.join(
  process.cwd(),
  'local-review',
  path.basename(process.env.STATEMENT_LOCAL_ANALYSES_FILE ?? 'dev-analyses.json'),
)

/** How many results to keep. Enough for a review session; not unbounded. */
const KEEP = 50

export interface LocalAnalysis {
  readonly draftId: string
  readonly fingerprint: string
  readonly review: StatementReview
  readonly revision: number
  readonly words: number
  readonly overLimit: boolean
  readonly statedMaxWords: number | null
  readonly provenance: 'catalog' | 'user' | null
  readonly createdAt: string
}

function readAll(): LocalAnalysis[] {
  if (!existsSync(STORE)) return []
  try {
    const parsed = JSON.parse(readFileSync(STORE, 'utf8'))
    return Array.isArray(parsed) ? parsed as LocalAnalysis[] : []
  } catch {
    // A HALF-WRITTEN FILE IS NOT A FAILED ANALYSIS. Treating it as empty costs
    // one extra real call; raising would break the screen being reviewed.
    console.error('simulated live: dev-analyses.json is unreadable; treating it as empty')
    return []
  }
}

/**
 * ATOMIC, LIKE THE OTHERS, even though this store tolerates a bad read.
 *
 * The tolerance above is right for a CACHE -- a miss costs one extra call --
 * and it is right precisely because it loses nothing. Writing atomically means
 * the half-written file it forgives almost never occurs.
 */
function writeAll(rows: readonly LocalAnalysis[]): void {
  writeJsonStore(STORE, rows)
}

/**
 * The stored result for exactly these inputs, or null.
 *
 * BY FINGERPRINT, NOT BY DRAFT, which is production's rule and the reason undo
 * works: analyse A, edit to B, analyse B, undo back to A, and A's own result
 * comes back rather than B's.
 */
export function localAnalysisFor(draftId: string, fingerprint: string): LocalAnalysis | null {
  const found = readAll().find(
    (row) => row.draftId === draftId && row.fingerprint === fingerprint)
  return found ?? null
}

/**
 * Record a result that has already cleared parseReview.
 *
 * REPLACES THE ENTRY FOR ITS KEY rather than appending a second one, so the
 * file cannot grow a duplicate for the same (draft, fingerprint) and a re-run
 * after an edit-and-undo updates in place.
 */
export function saveLocalAnalysis(entry: Omit<LocalAnalysis, 'createdAt'>): LocalAnalysis {
  const stored: LocalAnalysis = { ...entry, createdAt: new Date().toISOString() }
  const rows = readAll().filter(
    (row) => !(row.draftId === entry.draftId && row.fingerprint === entry.fingerprint))
  rows.push(stored)
  writeAll(rows.slice(-KEEP))
  return stored
}

/** Used by tests and by hand; never by a request path. */
export function localAnalysisCount(): number {
  return readAll().length
}
