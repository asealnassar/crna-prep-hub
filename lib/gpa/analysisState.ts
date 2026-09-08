/**
 * Pure model of the per-analysis autosave bookkeeping in useAnalyses.
 *
 * Extracted so the rules that matter most -- a save started for analysis A can
 * never write into B, and a late response for A can never repaint B -- are
 * testable without a browser or a database.
 */

import type { DraftSnapshot } from './merge.ts'

export interface AnalysisSlot {
  revision: number
  base: DraftSnapshot
  inFlight: boolean
  pending: DraftSnapshot | null
}

export class AnalysisBook {
  private slots = new Map<string, AnalysisSlot>()
  /** The analysis the UI is showing. Async callbacks compare against this. */
  currentId: string | null = null
  /** Recorded UI effects, so tests can assert what the user would have seen. */
  applied: { analysisId: string; kind: string }[] = []

  slot(id: string): AnalysisSlot {
    let s = this.slots.get(id)
    if (!s) { s = { revision: 0, base: { courses: [], policies: {} as any }, inFlight: false, pending: null }; this.slots.set(id, s) }
    return s
  }

  select(id: string, snapshot: DraftSnapshot, revision: number) {
    const s = this.slot(id)
    s.revision = revision
    s.base = snapshot          // D25: hydration records the baseline, no write
    this.currentId = id
  }

  /** Mirrors write(): only the VIEWED analysis may drive visible state. */
  applyUi(analysisId: string, kind: string) {
    if (this.currentId !== analysisId) return false
    this.applied.push({ analysisId, kind })
    return true
  }

  /** Mirrors a completed save landing against its own analysis. */
  completeSave(analysisId: string, payload: DraftSnapshot) {
    const s = this.slot(analysisId)
    s.revision = s.revision + 1
    s.base = payload
    s.inFlight = false
    return s.revision
  }

  revisionOf(id: string) { return this.slot(id).revision }
  baseOf(id: string) { return this.slot(id).base }
  forget(id: string) { this.slots.delete(id) }
}
