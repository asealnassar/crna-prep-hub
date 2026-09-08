/**
 * D24 — three-way merge for concurrent GPA draft edits.
 *
 * When a stale tab's write is rejected, we do NOT discard its work and we do
 * NOT overwrite the newer server draft. Instead we do a proper three-way
 * merge against the common ancestor:
 *
 *   base   = the draft as it stood at the revision this tab last synced to
 *   local  = what this tab currently has
 *   server = the newer draft another tab/device saved
 *
 * A change made on only one side is applied automatically. A change made on
 * BOTH sides to the same logical thing is a true conflict and is never
 * resolved silently -- it is returned for the user to decide.
 *
 * Courses are matched by their stable `id`, never by name: two different
 * courses can share a name, and a renamed course is still the same course.
 */

import type { Course, GpaPolicies } from './types.ts'

export interface DraftSnapshot {
  courses: Course[]
  policies: GpaPolicies
}

export type ConflictKind =
  | 'course-both-edited'
  | 'course-deleted-vs-edited'
  | 'policy-both-changed'

export interface MergeConflict {
  kind: ConflictKind
  /** Course id, or the policy field name. */
  id: string
  label: string
  /** This tab's value. `null` means "deleted on this side". */
  mine: Course | string | null
  /** The newer server value. `null` means "deleted on that side". */
  theirs: Course | string | null
}

export interface MergeResult {
  merged: DraftSnapshot
  conflicts: MergeConflict[]
  /** Local changes carried across automatically. */
  autoMerged: number
}

/** Key-order-independent structural equality. */
function stable(v: unknown): string {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') {
      return Object.keys(x).sort().reduce((o: any, k) => { o[k] = walk(x[k]); return o }, {})
    }
    return x
  }
  return JSON.stringify(walk(v))
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b)
const byId = (list: readonly Course[]) => new Map(list.map(c => [c.id, c]))

export function mergeDrafts(
  base: DraftSnapshot,
  local: DraftSnapshot,
  server: DraftSnapshot
): MergeResult {
  const B = byId(base.courses)
  const L = byId(local.courses)
  const S = byId(server.courses)

  const conflicts: MergeConflict[] = []
  let autoMerged = 0

  // Start from the server's ordering so the newer draft's shape is preserved,
  // then apply local-only changes on top.
  const mergedCourses: Course[] = []
  const handled = new Set<string>()

  for (const [id, sc] of S) {
    handled.add(id)
    const bc = B.get(id)
    const lc = L.get(id)

    if (!bc) {
      // New on the server (this tab never saw it). Keep it.
      mergedCourses.push(sc)
      continue
    }
    const serverChanged = !same(bc, sc)

    if (!lc) {
      // Deleted locally.
      if (serverChanged) {
        conflicts.push({
          kind: 'course-deleted-vs-edited', id,
          label: sc.name || sc.courseCode || 'Untitled course',
          mine: null, theirs: sc,
        })
        mergedCourses.push(sc)   // hold the server value until the user decides
      } else {
        autoMerged++             // clean delete: honour it
      }
      continue
    }

    const localChanged = !same(bc, lc)
    if (localChanged && serverChanged) {
      if (same(lc, sc)) { mergedCourses.push(sc); continue }   // same edit both sides
      conflicts.push({
        kind: 'course-both-edited', id,
        label: sc.name || lc.name || sc.courseCode || 'Untitled course',
        mine: lc, theirs: sc,
      })
      mergedCourses.push(sc)     // hold the server value until the user decides
    } else if (localChanged) {
      mergedCourses.push(lc); autoMerged++
    } else {
      mergedCourses.push(sc)
    }
  }

  // Courses this tab knows about that the server's list does not mention.
  for (const [id, lc] of L) {
    if (handled.has(id)) continue
    const bc = B.get(id)
    if (!bc) {
      mergedCourses.push(lc); autoMerged++          // added locally -> keep
      continue
    }
    // Deleted on the server.
    if (!same(bc, lc)) {
      conflicts.push({
        kind: 'course-deleted-vs-edited', id,
        label: lc.name || lc.courseCode || 'Untitled course',
        mine: lc, theirs: null,
      })
      mergedCourses.push(lc)     // hold this tab's value until the user decides
    }
    // else: unchanged locally and deleted on the server -> accept the delete
  }

  // ---- policies, field by field ------------------------------------------
  const policies: GpaPolicies = { ...server.policies }
  for (const field of ['transfer', 'retake'] as const) {
    const b = base.policies?.[field] ?? null
    const l = local.policies?.[field] ?? null
    const s = server.policies?.[field] ?? null
    const localChanged = l !== b
    const serverChanged = s !== b
    if (localChanged && serverChanged && l !== s) {
      conflicts.push({
        kind: 'policy-both-changed', id: field,
        label: field === 'transfer' ? 'Transferred coursework' : 'Repeated coursework',
        mine: l, theirs: s,
      })
      policies[field] = s as any   // hold the server value until resolved
    } else if (localChanged) {
      policies[field] = l as any; autoMerged++
    }
  }

  return { merged: { courses: mergedCourses, policies }, conflicts, autoMerged }
}

/**
 * Applies the user's per-conflict decisions to a merged snapshot.
 * `choices` maps a conflict id to 'mine' or 'theirs'.
 */
export function resolveConflicts(
  merged: DraftSnapshot,
  conflicts: readonly MergeConflict[],
  choices: Record<string, 'mine' | 'theirs'>
): DraftSnapshot {
  let courses = [...merged.courses]
  const policies: GpaPolicies = { ...merged.policies }

  for (const c of conflicts) {
    const pick = choices[c.id]
    if (!pick) continue

    if (c.kind === 'policy-both-changed') {
      ;(policies as any)[c.id] = (pick === 'mine' ? c.mine : c.theirs)
      continue
    }
    const chosen = (pick === 'mine' ? c.mine : c.theirs) as Course | null
    courses = courses.filter(x => x.id !== c.id)
    if (chosen) courses.push(chosen)
  }
  return { courses, policies }
}

/** True when two snapshots are identical -- used to suppress no-op writes (D25). */
export function snapshotsEqual(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return same(a, b)
}
