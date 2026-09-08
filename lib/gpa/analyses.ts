/**
 * D33-D36 — multiple named GPA analyses.
 *
 * Pure naming/collision logic, kept out of the component so it is directly
 * testable and so the database and the UI agree on what "the same name" means.
 */

import type { Course, GpaPolicies, Institution } from './types.ts'

export interface GpaAnalysis {
  id: string
  userId: string
  name: string
  courses: Course[]
  policies: GpaPolicies
  revision: number
  updatedAt?: string
}

/** D34: names collide when they match case-insensitively after trimming. */
export function normalizeAnalysisName(name: unknown): string {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export const MAX_ANALYSES_PER_USER = 50
export const MAX_COURSES_PER_ANALYSIS = 500
export const DEFAULT_NEW_ANALYSIS_NAME = 'Untitled Analysis'
export const MIGRATED_ANALYSIS_NAME = 'My Analysis'

export function nameCollides(candidate: string, existing: readonly { name: string }[], ignoreId?: string, all?: readonly GpaAnalysis[]): boolean {
  const target = normalizeAnalysisName(candidate)
  if (all && ignoreId) {
    return all.some(a => a.id !== ignoreId && normalizeAnalysisName(a.name) === target)
  }
  return existing.some(a => normalizeAnalysisName(a.name) === target)
}

/**
 * D34/D36: returns `base`, or `base (2)`, `base (3)`... until free.
 * Deterministic — never AI-chosen, never random.
 */
export function resolveAnalysisName(
  base: string, existing: readonly { name: string }[]
): string {
  const trimmed = String(base ?? '').trim() || DEFAULT_NEW_ANALYSIS_NAME
  const taken = new Set(existing.map(a => normalizeAnalysisName(a.name)))
  if (!taken.has(normalizeAnalysisName(trimmed))) return trimmed
  for (let n = 2; n <= 999; n++) {
    const candidate = `${trimmed} (${n})`
    if (!taken.has(normalizeAnalysisName(candidate))) return candidate
  }
  return `${trimmed} (${Date.now()})`
}

/**
 * D36: derive an analysis name from the institutions a transcript revealed.
 * Concise by design -- never five full legal school names in one label.
 */
export function analysisNameFromInstitutions(names: readonly string[]): string {
  const clean = [...new Set(names.map(n => String(n ?? '').trim()).filter(Boolean))]
  if (clean.length === 0) return DEFAULT_NEW_ANALYSIS_NAME
  if (clean.length === 1) return clean[0]
  if (clean.length === 2) return `${shortLabel(clean[0])} + ${shortLabel(clean[1])}`
  return `${shortLabel(clean[0])} + ${clean.length - 1} others`
}

/** First distinctive word(s) of a school name, for combined labels. */
function shortLabel(full: string): string {
  const stop = /^(the|university|college|community|state|of|at|school)$/i
  const words = full.split(/\s+/).filter(Boolean)
  const lead = words.find(w => !stop.test(w))
  return lead ?? words[0] ?? full
}

/**
 * D36: a name the application generated for an analysis nobody has named.
 *
 * Only the exact strings a blank analysis is created with count. Anything else
 * is treated as the user's own choice, because smart naming must never
 * overwrite a name someone deliberately typed.
 */
export function isDefaultAnalysisName(name: unknown): boolean {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return true
  return new RegExp(`^${DEFAULT_NEW_ANALYSIS_NAME}(?: \\(\\d+\\))?$`, 'i').test(trimmed)
}

/**
 * D36: the name a transcript earns for the analysis it just filled.
 *
 * Returns null -- meaning leave the name alone -- whenever renaming would be
 * presumptuous or pointless: the analysis already carries a name its owner
 * chose, the transcript named no institution, or the derived name is what the
 * analysis is already called.
 *
 * Derived from institutions that have already been resolved to real rows, so
 * it costs nothing: no second analyzer pass, and no guessing from raw text.
 */
export function smartAnalysisName(input: {
  currentName: string | null | undefined
  institutionNames: readonly string[]
  /** Every OTHER analysis, so D34 uniqueness applies without self-collision. */
  otherAnalyses: readonly { name: string }[]
}): string | null {
  if (!isDefaultAnalysisName(input.currentName)) return null

  const clean = [...new Set(input.institutionNames.map(n => String(n ?? '').trim()).filter(Boolean))]
  if (clean.length === 0) return null

  const base = analysisNameFromInstitutions(clean)
  // The helper falls back to the default label when it has nothing to work
  // with; renaming "Untitled Analysis" to "Untitled Analysis" is not a rename.
  if (isDefaultAnalysisName(base)) return null

  const name = resolveAnalysisName(base, input.otherAnalyses)
  return normalizeAnalysisName(name) === normalizeAnalysisName(input.currentName) ? null : name
}

/** Whether a new analysis may be created (D35). */
export function canCreateAnalysis(existing: readonly unknown[]): boolean {
  return existing.length < MAX_ANALYSES_PER_USER
}

/** D33: after deleting `id`, which analysis should be selected? */
export function nextSelectionAfterDelete(
  all: readonly GpaAnalysis[], deletedId: string
): string | null {
  const remaining = all.filter(a => a.id !== deletedId)
  if (remaining.length === 0) return null
  const byRecency = [...remaining].sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return byRecency[0].id
}

/** Switcher ordering: most recently updated first. */
export function sortAnalyses(all: readonly GpaAnalysis[]): GpaAnalysis[] {
  return [...all].sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

/** Institutions are user-level: deleting an analysis must not remove any. */
export function institutionsStillReferenced(
  analyses: readonly GpaAnalysis[], institutions: readonly Institution[]
): Institution[] {
  const used = new Set<string>()
  for (const a of analyses) for (const c of a.courses) if (c.institutionId) used.add(c.institutionId)
  return institutions.filter(i => used.has(i.id))
}
