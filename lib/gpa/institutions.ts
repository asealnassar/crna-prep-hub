/**
 * D27 — resolving AI-detected institution NAMES into the user's institutions.
 *
 * The model returns names as printed on the transcript. This module decides
 * whether each name is an existing institution, a genuinely new one, or too
 * ambiguous to decide. It never merges aggressively: two real campuses must not
 * collapse into one because their names share a prefix.
 */

import type { Institution, CreditSystem } from './types.ts'

export type ResolutionKind = 'matched' | 'create' | 'ambiguous'

export interface NameResolution {
  detectedName: string
  kind: ResolutionKind
  /** Set when kind === 'matched'. */
  institutionId?: string
  /** Candidates that made it ambiguous. */
  candidates?: Institution[]
  reason?: string
}

/** Case-, whitespace- and punctuation-insensitive comparison key. */
export function normalizeName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[.,‘’'ʼ]/g, '')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Common suffixes that carry no identity on their own. */
const NOISE = /\b(university|college|community college|school of nursing|state|the|of|at)\b/g

function coreTokens(raw: string): string[] {
  return normalizeName(raw).replace(NOISE, ' ').split(/\s+/).filter(Boolean)
}

/**
 * Decides how one detected name relates to the user's existing institutions.
 *
 * Exact (normalized) equality is a confident match. Anything else that merely
 * *overlaps* -- "Rutgers University" vs "Rutgers University - New Brunswick" --
 * is deliberately reported as ambiguous rather than merged, because those may
 * be different campuses with different coursework.
 */
export function resolveInstitutionName(
  detectedName: string,
  existing: readonly Institution[]
): NameResolution {
  const name = String(detectedName ?? '').trim()
  if (!name) {
    return { detectedName: name, kind: 'ambiguous', reason: 'No institution name was detected.' }
  }

  const key = normalizeName(name)
  const exact = existing.filter(i => normalizeName(i.name) === key)
  if (exact.length === 1) {
    return { detectedName: name, kind: 'matched', institutionId: exact[0].id }
  }
  if (exact.length > 1) {
    return {
      detectedName: name, kind: 'ambiguous', candidates: exact,
      reason: 'More than one of your schools has this name.',
    }
  }

  // Substantive-difference check: same core identity, extra qualifier.
  const mine = coreTokens(name)
  const near = existing.filter(i => {
    const theirs = coreTokens(i.name)
    if (!mine.length || !theirs.length) return false
    const shared = mine.filter(t => theirs.includes(t))
    // Require the shorter name to be fully contained in the longer one.
    const shorter = Math.min(mine.length, theirs.length)
    return shared.length === shorter
  })

  if (near.length > 0) {
    return {
      detectedName: name, kind: 'ambiguous', candidates: near,
      reason: `"${name}" looks related to ${near.map(c => `"${c.name}"`).join(', ')}, but may be a different campus. Confirm which.`,
    }
  }

  return { detectedName: name, kind: 'create' }
}

export interface DetectedInstitution {
  name: string
  creditSystem?: string
  confidence?: string
}

/** Normalizes a model-supplied credit system. Unknown unless clearly stated. */
export function normalizeCreditSystem(raw: unknown): CreditSystem {
  const v = String(raw ?? '').toLowerCase().trim()
  return v === 'semester' || v === 'quarter' ? v : 'unknown'
}

export interface ImportPlan {
  /** Names that resolved to an existing institution. */
  matched: NameResolution[]
  /** Names that should be created. */
  toCreate: { name: string; creditSystem: CreditSystem }[]
  /** Names requiring the user to decide. Their courses stay unassigned. */
  ambiguous: NameResolution[]
}

/** Plans institution resolution for a whole import, before any writes. */
export function planInstitutionImport(
  detected: readonly DetectedInstitution[],
  existing: readonly Institution[]
): ImportPlan {
  const matched: NameResolution[] = []
  const toCreate: { name: string; creditSystem: CreditSystem }[] = []
  const ambiguous: NameResolution[] = []
  const seen = new Set<string>()

  for (const d of detected) {
    const key = normalizeName(d.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const r = resolveInstitutionName(d.name, existing)
    if (r.kind === 'matched') matched.push(r)
    else if (r.kind === 'create') {
      // D15: detection does NOT imply semester. Only an explicit, confident
      // statement on the transcript sets the credit system.
      const system = d.confidence === 'high'
        ? normalizeCreditSystem(d.creditSystem)
        : 'unknown'
      toCreate.push({ name: d.name.trim(), creditSystem: system })
    }
    else ambiguous.push(r)
  }
  return { matched, toCreate, ambiguous }
}
