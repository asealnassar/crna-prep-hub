/**
 * D38-D41 Phase 2 - grading scales detected from transcript documents.
 *
 * The single hard rule in this file: a scale may ONLY come from an explicit
 * grading legend printed in the document. It is never inferred from the
 * institution's name, from a reported cumulative or term GPA, from the
 * distribution of grades, from the courses themselves, from common knowledge
 * about that school, or from anything the model happens to know. If the
 * document does not print a legend, there is no detected scale -- full stop.
 *
 * The second hard rule: a transcript may print SEVERAL grading systems (a law
 * school table, a business school table, a standard table). Those must not be
 * merged. Either the document states which one applies to the coursework, or
 * this module refuses to pick and the ambiguity is surfaced to the user.
 */

import type { GradingScale } from './types.ts'

/** A scale the model claims to have read out of the document. */
export interface DetectedGradingScale {
  points: Record<string, number>
  /** Verbatim text from the legend that gives the symbol/point pairs. */
  evidence: string
  /** Verbatim text establishing that THIS table governs THIS coursework. */
  applicability: string
}

export interface DetectedInstitutionScale {
  /** Present only when a legend was actually printed and resolved. */
  gradingScale?: DetectedGradingScale | null
  /** Set when several legends exist and none could be safely selected. */
  gradingScaleAmbiguity?: string | null
}

/** Grade points outside this range are a parsing error, not a real scale. */
const MIN_POINTS = 0
const MAX_POINTS = 5

/**
 * Grade symbols are compared case-insensitively with spaces removed, so a
 * legend printing "C -" resolves the same as a course row printing "C-".
 */
export function normalizeGradeSymbol(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/\s+/g, '').trim()
}

/**
 * Reads grade/point pairs out of the model's own verbatim quotation.
 *
 * This is deterministic reading, not assumption: `evidence` is text copied from
 * the document, so a pair found in it was printed on the transcript. It exists
 * because a model transcribing a dense legend row sometimes returns a point map
 * that is missing rows it nevertheless quoted correctly.
 */
export function parseScaleFromEvidence(evidence: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const text = String(evidence ?? '')
  // SYMBOL, then anything that is not another symbol or number, then the value.
  const re = /(^|[|\n\s])([A-F][+-]?)\s*\|?\s*(?:-\s*)?(?:[A-Za-z][A-Za-z ()/&.]*)?\|?\s*([0-5]\.\d{2})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const symbol = normalizeGradeSymbol(m[2])
    const value = Number(m[3])
    if (!symbol || !Number.isFinite(value)) continue
    // First reading wins; a symbol quoted twice with different values is
    // handled by the consistency gate in validateDetectedScale.
    if (!(symbol in out)) out[symbol] = value
  }
  return out
}

export interface ScaleValidation {
  ok: boolean
  scale?: DetectedGradingScale
  reason?: string
  /** Symbols restored from the quoted evidence because the map omitted them. */
  recovered?: string[]
}

/**
 * Validates one model-supplied scale. Rejects rather than repairs: a legend we
 * cannot read cleanly is worth less than no legend at all, because a wrong
 * scale silently mis-scores every course at that institution.
 */
export function validateDetectedScale(raw: unknown): ScaleValidation {
  if (raw == null) return { ok: false, reason: 'No grading legend was returned.' }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'The grading legend was not an object.' }
  }
  const o = raw as Record<string, unknown>

  const evidence = String(o.evidence ?? '').trim()
  const applicability = String(o.applicability ?? '').trim()
  // Without a quotation from the document there is nothing separating a read
  // legend from a remembered one, which is exactly what must not happen.
  if (!evidence) {
    return { ok: false, reason: 'The legend came with no quoted evidence from the document.' }
  }

  const rawPoints = o.points
  if (rawPoints == null || typeof rawPoints !== 'object' || Array.isArray(rawPoints)) {
    return { ok: false, reason: 'The legend contained no grade/point map.' }
  }

  const points: Record<string, number> = {}
  for (const [k, v] of Object.entries(rawPoints as Record<string, unknown>)) {
    const symbol = normalizeGradeSymbol(k)
    if (!symbol) return { ok: false, reason: 'The legend contained a blank grade symbol.' }
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) {
      return { ok: false, reason: `Grade "${symbol}" had a non-numeric point value.` }
    }
    if (n < MIN_POINTS || n > MAX_POINTS) {
      return { ok: false, reason: `Grade "${symbol}" had an out-of-range value (${n}).` }
    }
    if (symbol in points && points[symbol] !== n) {
      return { ok: false, reason: `Grade "${symbol}" was listed twice with different values.` }
    }
    points[symbol] = n
  }
  if (Object.keys(points).length === 0) {
    return { ok: false, reason: 'The legend contained no grades.' }
  }

  // Cross-check the point map against the quotation it came from. If every
  // symbol they share agrees, the quotation is from the same table, and any
  // symbol it carries that the map lacks was simply dropped in transcription --
  // so it is recovered from the document's own words rather than assumed.
  const quoted = parseScaleFromEvidence(evidence)
  const shared = Object.keys(quoted).filter(k => k in points)
  const conflicts = shared.filter(k => quoted[k] !== points[k])
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: `The quoted legend disagrees with the grades returned for ` +
        `${conflicts.join(', ')}, so the scale could not be read reliably.`,
    }
  }
  const recovered: string[] = []
  if (shared.length > 0) {
    for (const [symbol, value] of Object.entries(quoted)) {
      if (symbol in points) continue
      points[symbol] = value
      recovered.push(symbol)
    }
  }

  return { ok: true, scale: { points, evidence, applicability }, recovered }
}

/** True when two point maps are the same scale. Key order is irrelevant. */
export function sameScale(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k])
}

export type ScaleMergeAction =
  /** Write the detected scale onto the institution. */
  | 'set'
  /** Identical to what is already stored -- write nothing. */
  | 'noop'
  /** A different scale is already established; ask the user. Write nothing. */
  | 'conflict'
  /** The stored scale is user-confirmed and is never overwritten. */
  | 'blocked-user'
  /** Nothing usable was detected. */
  | 'none'

export interface ScaleMerge {
  action: ScaleMergeAction
  /** The scale to persist. Only set for action === 'set'. */
  next?: GradingScale
  /** The scale already stored, for a conflict prompt. */
  current?: GradingScale | null
  detected?: DetectedGradingScale
  message?: string
}

/**
 * Decides what a transcript-detected scale may do to an institution's stored
 * scale (D38 item 5).
 *
 *   stored NULL       -> take the transcript's
 *   stored 'default'  -> take the transcript's (the default was an assumption)
 *   stored 'transcript', identical  -> no-op, so re-uploading changes nothing
 *   stored 'transcript', different  -> CONFLICT, surfaced, nothing written
 *   stored 'user'     -> never overwritten, under any circumstances
 */
export function planScaleMerge(
  current: GradingScale | null | undefined,
  detected: DetectedGradingScale | null | undefined,
): ScaleMerge {
  if (!detected) return { action: 'none' }

  const next: GradingScale = { source: 'transcript', points: { ...detected.points } }

  if (current?.source === 'user') {
    return {
      action: 'blocked-user', current, detected,
      message: 'You have already confirmed this school’s grading scale, so the ' +
        'scale printed on this transcript was not applied. Edit the school if you want to change it.',
    }
  }
  if (!current || current.source === 'default') {
    return { action: 'set', next, current: current ?? null, detected }
  }
  // current.source === 'transcript'
  if (sameScale(current.points, next.points)) {
    return { action: 'noop', current, detected }
  }
  return {
    action: 'conflict', current, detected, next,
    message: 'This transcript prints a different grading scale than the one already ' +
      'detected for this school. Nothing was changed — choose which is correct.',
  }
}

/** Serializes a scale for `gpa_institutions.grading_scale`. */
export function toStoredScale(scale: GradingScale | null | undefined): unknown {
  if (!scale) return null
  return { source: scale.source, points: { ...scale.points } }
}

/**
 * Reads `gpa_institutions.grading_scale` back.
 *
 * D39: a NULL column stays NULL. It is NOT hydrated into a `source:"default"`
 * object, because writing that back would turn "we never established this" into
 * "the standard scale was established", which is a different claim.
 */
export function fromStoredScale(raw: unknown): GradingScale | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const source = o.source
  if (source !== 'default' && source !== 'transcript' && source !== 'user') return null
  const rawPoints = o.points
  if (rawPoints == null || typeof rawPoints !== 'object' || Array.isArray(rawPoints)) return null
  const points: Record<string, number> = {}
  for (const [k, v] of Object.entries(rawPoints as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : Number(v)
    const symbol = normalizeGradeSymbol(k)
    if (symbol && Number.isFinite(n)) points[symbol] = n
  }
  return { source, points }
}
