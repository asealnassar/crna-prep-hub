/**
 * The imported requirement catalog, for DEVELOPMENT REVIEW ONLY.
 *
 * WHAT THIS IS FOR. Production holds 63 requirement sets and 80 documents, every
 * set `is_active = false`. That is deliberate -- they are not released -- but it
 * also means the real read cannot show them: the RLS policy and the catalog
 * reader both filter on `is_active`, so an owner reviewing the UI before
 * launch would see an empty catalog. The alternatives were to activate rows in
 * production to make a screen work, or to review the content somewhere other
 * than the interface that will render it. This is the third option.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A FILE READ ON THE SERVER AND NOT AN IMPORT
 * ---------------------------------------------------------------------------
 * A `import catalog from './catalog.json'` in a component would put the whole
 * inactive catalog into the JavaScript bundle every visitor downloads. The
 * preview gate would still hide the SCREEN, and the DATA would ship anyway --
 * which is the opposite of what the gate is for. So the payload lives outside
 * `public/` (Next serves `public/`; an inactive catalog behind a fetchable URL
 * is the same leak wearing a different hat), is read with `node:fs` at request
 * time, and reaches the browser only as props, only after the gate has passed.
 *
 * READING IT COSTS NOTHING IN PRODUCTION because nothing calls it there: the
 * only caller checks `NODE_ENV === 'development'` first. If the file is absent
 * -- which it is for anybody who has not run the generator -- this returns null
 * and the caller falls back. A missing development convenience is not an error.
 *
 * ---------------------------------------------------------------------------
 * IT PARSES THROUGH THE REAL READER
 * ---------------------------------------------------------------------------
 * The payload is shaped as DATABASE ROWS, not as domain objects, and is handed
 * to `requirementFromRow()` and `verificationFromRow()` -- the same functions
 * `listRequirementSets()` uses. So a value that the real read would drop, round
 * or refuse is dropped, rounded or refused here identically. A bespoke mapper
 * would be a second implementation of the thing being reviewed, and it would
 * drift in exactly the way that makes a review worthless.
 *
 * THERE IS NO WRITE PATH HERE. This module reads one file and returns objects.
 * It opens no connection, holds no key and exports nothing that mutates.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { RequirementSet, WritingRequirement } from './requirement.ts'
import { requirementFromRow, verificationFromRow } from './repo.ts'

/** Written by scripts/build_statement_requirements_import_sql.py. Untracked. */
const PAYLOAD = path.join(
  process.cwd(), 'local-review', 'statement_requirements_catalog.json')

export interface LocalReviewCatalog {
  readonly sets: readonly RequirementSet[]
  /** Straight from the payload, so a mismatch with `sets.length` is visible. */
  readonly declaredSetCount: number
  readonly declaredDocumentCount: number
  /** The count actually assembled, after the real parser had its say. */
  readonly parsedSetCount: number
  readonly parsedDocumentCount: number
  readonly setFingerprint: string
  readonly documentFingerprint: string
  readonly correspondsTo: string
}

type Row = Record<string, unknown>

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strings = (value: unknown): readonly string[] =>
  (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/**
 * Null rather than throw, in every failure case.
 *
 * The file is a development convenience. Absent, unreadable, or holding
 * something other than this payload, the answer is the same: there is no review
 * catalog, and the caller shows what it showed before. A page that 500s because
 * an optional local file is missing would be a worse failure than the one it
 * reports.
 */
export function loadLocalReviewCatalog(): LocalReviewCatalog | null {
  // A module that reads the filesystem has no business in a browser. Next would
  // refuse to bundle `node:fs` anyway; this makes the reason explicit rather
  // than leaving it to a build error somebody has to interpret.
  if (typeof window !== 'undefined') {
    throw new Error('loadLocalReviewCatalog is server-only')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(PAYLOAD, 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const root = parsed as Row
  const meta = (root.meta ?? {}) as Row
  const rawSets = Array.isArray(root.sets) ? (root.sets as Row[]) : []
  const rawDocs = Array.isArray(root.documents) ? (root.documents as Row[]) : []
  if (rawSets.length === 0) return null

  // Documents grouped by their set, exactly as listRequirementSets does it, and
  // ordered by display_order for the same reason: the order is the catalog's,
  // not the file's.
  const bySet = new Map<string, WritingRequirement[]>()
  let parsedDocumentCount = 0
  for (const raw of [...rawDocs].sort(
    (a, b) => Number(a.display_order ?? 0) - Number(b.display_order ?? 0))) {
    const requirement = requirementFromRow(raw)
    const setId = str(raw.set_id)
    // A row the real parser refuses is dropped here too. Showing a document the
    // production read would not show is the one thing this screen must not do.
    if (requirement === null || setId === null) continue
    parsedDocumentCount += 1
    const existing = bySet.get(setId)
    if (existing === undefined) bySet.set(setId, [requirement])
    else existing.push(requirement)
  }

  const sets: RequirementSet[] = []
  for (const row of rawSets) {
    const id = str(row.id)
    const schoolId = str(row.school_id)
    if (id === null || schoolId === null) continue
    const requirements = bySet.get(id) ?? []
    // Same rule as the real read: a set with no readable document is not a set.
    if (requirements.length === 0) continue
    sets.push({
      id,
      schoolId,
      // The real read takes this from the school the picker resolved; the
      // payload carries the name the reconciliation was approved against.
      schoolName: str(row.school_name) ?? '(school name missing)',
      applicationCycle: str(row.application_cycle),
      verification: verificationFromRow(row),
      originalText: str(row.original_text) ?? '',
      requirements,
      notes: strings(row.notes),
    })
  }

  sets.sort((a, b) => a.schoolName.localeCompare(b.schoolName))

  return {
    sets,
    declaredSetCount: Number(meta.set_count ?? 0),
    declaredDocumentCount: Number(meta.document_count ?? 0),
    parsedSetCount: sets.length,
    parsedDocumentCount,
    setFingerprint: str(meta.set_fingerprint) ?? '(none)',
    documentFingerprint: str(meta.document_fingerprint) ?? '(none)',
    correspondsTo: str(meta.corresponds_to) ?? '(unstated)',
  }
}
