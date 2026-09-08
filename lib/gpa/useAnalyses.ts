'use client'

/**
 * D33-D36 — multiple named GPA analyses.
 *
 * Replaces useGpaDraft, which assumed one row per user and kept a single
 * global revision/baseline. Everything mutable is now keyed by analysis id:
 *
 *   - a save started for analysis A completes against A's id and A's revision,
 *     even if the user switched to B while it was in flight;
 *   - a late response only touches the UI when its analysis is still selected,
 *     so A's response can never repaint B or reset B's baseline;
 *   - switching analyses flushes A's pending debounce against A, never B.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { DEFAULT_POLICIES, type Course, type GpaPolicies, type Institution } from './types.ts'
import { fromStoredScale } from './gradingScale.ts'
import {
  mergeDrafts, resolveConflicts, snapshotsEqual,
  type DraftSnapshot, type MergeConflict,
} from './merge.ts'
import {
  resolveAnalysisName, nameCollides, canCreateAnalysis, sortAnalyses,
  nextSelectionAfterDelete, DEFAULT_NEW_ANALYSIS_NAME, MAX_ANALYSES_PER_USER,
  type GpaAnalysis,
} from './analyses.ts'

export type SaveState =
  | 'idle' | 'saving' | 'saved' | 'error' | 'merged' | 'needs-resolution'

const DEBOUNCE_MS = 1200
const LAST_ANALYSIS_KEY = 'crnaprephub.gpa.lastAnalysisId'

/** Everything mutable that belongs to ONE analysis. */
interface PerAnalysis {
  revision: number
  base: DraftSnapshot
  inFlight: boolean
  pending: DraftSnapshot | null
  timer: ReturnType<typeof setTimeout> | null
}

const emptyState = (): PerAnalysis => ({
  revision: 0, base: { courses: [], policies: DEFAULT_POLICIES },
  inFlight: false, pending: null, timer: null,
})

export function useGpaAnalyses(userId: string | null) {
  const supabase = createClient()

  const [loaded, setLoaded] = useState(false)
  const [analyses, setAnalyses] = useState<GpaAnalysis[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [policies, setPolicies] = useState<GpaPolicies>(DEFAULT_POLICIES)
  const [institutions, setInstitutions] = useState<Institution[]>([])
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflicts, setConflicts] = useState<MergeConflict[]>([])

  const alive = useRef(true)
  /** Per-analysis mutable state. Never a single global ref. */
  const perAnalysis = useRef<Map<string, PerAnalysis>>(new Map())
  /** Which analysis the UI is showing, readable from async callbacks. */
  const currentIdRef = useRef<string | null>(null)
  const pendingMerge = useRef<Map<string, DraftSnapshot>>(new Map())
  /**
   * selectAnalysis has empty deps so its identity stays stable, which means it
   * would otherwise close over the FIRST render's write() -- created while
   * userId was still null, so it returned immediately and silently dropped the
   * outgoing analysis's pending save. Routing through a ref keeps the flush
   * pointed at the live implementation.
   */
  const writeRef = useRef<(id: string, payload: DraftSnapshot) => Promise<void>>(
    async () => { /* replaced on first render */ })

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      for (const s of perAnalysis.current.values()) if (s.timer) clearTimeout(s.timer)
    }
  }, [])

  const stateFor = (id: string): PerAnalysis => {
    let s = perAnalysis.current.get(id)
    if (!s) { s = emptyState(); perAnalysis.current.set(id, s) }
    return s
  }

  // ------------------------------------------------------------------ load
  const loadAnalyses = useCallback(async (): Promise<GpaAnalysis[]> => {
    if (!userId) return []
    const { data } = await supabase
      .from('gpa_drafts')
      .select('id, user_id, name, courses, policies, revision, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
    const rows: GpaAnalysis[] = (data ?? []).map((r: any) => ({
      id: r.id, userId: r.user_id, name: r.name,
      courses: Array.isArray(r.courses) ? r.courses : [],
      policies: { ...DEFAULT_POLICIES, ...(r.policies ?? {}) },
      revision: Number(r.revision) || 1,
      updatedAt: r.updated_at,
    }))
    if (alive.current) setAnalyses(sortAnalyses(rows))
    return rows
  }, [userId])

  /**
   * Selects an analysis. D25: hydration records the baseline and never writes.
   *
   * Always re-reads the row by id rather than trusting the cached list. The
   * list is a snapshot from load time; after any edit it is stale, and
   * repainting from it showed an out-of-date course count AND installed a
   * stale baseline/revision, which then had to be recovered through the
   * conflict path on the next save.
   */
  const selectAnalysis = useCallback(async (a: GpaAnalysis) => {
    // Flush any debounce belonging to the analysis we are leaving, against ITS
    // id -- never against the one being opened.
    const leavingId = currentIdRef.current
    if (leavingId && leavingId !== a.id) {
      const s = perAnalysis.current.get(leavingId)
      if (s?.timer) {
        clearTimeout(s.timer); s.timer = null
        if (s.pending) void writeRef.current(leavingId, s.pending)
      }
    }
    // Authoritative read for the analysis being opened.
    let fresh = a
    const { data } = await supabase
      .from('gpa_drafts')
      .select('id, user_id, name, courses, policies, revision, updated_at')
      .eq('id', a.id).maybeSingle()
    if (data) {
      fresh = {
        id: data.id, userId: data.user_id, name: data.name,
        courses: Array.isArray(data.courses) ? data.courses : [],
        policies: { ...DEFAULT_POLICIES, ...(data.policies ?? {}) },
        revision: Number(data.revision) || 1, updatedAt: data.updated_at,
      }
      if (alive.current) {
        setAnalyses(prev => sortAnalyses(prev.map(x => x.id === fresh.id ? fresh : x)))
      }
    }
    if (!alive.current) return

    const st = stateFor(fresh.id)
    st.revision = fresh.revision
    st.base = { courses: fresh.courses, policies: fresh.policies }
    currentIdRef.current = fresh.id
    setCurrentId(fresh.id)
    setCourses(fresh.courses)
    setPolicies(fresh.policies)
    setConflicts([])
    setSaveState('idle')
    try { localStorage.setItem(LAST_ANALYSIS_KEY, fresh.id) } catch { /* private mode */ }
  }, [])

  useEffect(() => {
    if (!userId) { setLoaded(true); return }
    let cancelled = false
    ;(async () => {
      const [rows, instRes] = await Promise.all([
        loadAnalyses(),
        supabase.from('gpa_institutions').select('id, name, credit_system, grading_scale')
          .eq('user_id', userId).order('name'),
      ])
      if (cancelled || !alive.current) return
      if (instRes.data) {
        setInstitutions(instRes.data.map((r: any) =>
          ({ id: r.id, name: r.name, creditSystem: r.credit_system,
             // D39: a NULL column stays null. Hydrating it into a
             // source:'default' object would later be written back as an
             // established scale, which is a claim the user never made.
             gradingScale: fromStoredScale(r.grading_scale) })))
      }
      let remembered: string | null = null
      try { remembered = localStorage.getItem(LAST_ANALYSIS_KEY) } catch { /* ignore */ }
      const pick = rows.find(r => r.id === remembered) ?? rows[0]
      if (pick) selectAnalysis(pick)
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [userId, loadAnalyses, selectAnalysis])

  // ----------------------------------------------------------------- write
  const write = useCallback(async (analysisId: string, payload: DraftSnapshot): Promise<void> => {
    if (!userId) return
    const st = stateFor(analysisId)

    // Idempotence (D25): never write content identical to the baseline.
    if (st.revision !== 0 && snapshotsEqual(payload, st.base)) {
      if (alive.current && currentIdRef.current === analysisId) setSaveState('saved')
      return
    }
    if (st.inFlight) { st.pending = payload; return }
    st.inFlight = true
    // Only the ANALYSIS BEING VIEWED may drive the visible status.
    if (alive.current && currentIdRef.current === analysisId) setSaveState('saving')

    try {
      const next = st.revision + 1
      const { data, error } = await supabase
        .from('gpa_drafts')
        .update({ courses: payload.courses, policies: payload.policies, revision: next })
        .eq('id', analysisId)                    // keyed by ANALYSIS, not user
        .eq('revision', st.revision)             // stale-write guard
        .select('revision')
      if (error) throw error

      if (!data || data.length === 0) {
        // Conflict: merge against this analysis's own ancestor.
        const { data: fresh } = await supabase
          .from('gpa_drafts').select('courses, policies, revision')
          .eq('id', analysisId).maybeSingle()
        if (!fresh) {
          if (alive.current && currentIdRef.current === analysisId) setSaveState('error')
          st.pending = null
          return
        }
        const serverSnap: DraftSnapshot = {
          courses: Array.isArray(fresh.courses) ? (fresh.courses as Course[]) : [],
          policies: { ...DEFAULT_POLICIES, ...(fresh.policies as GpaPolicies | null) },
        }
        const result = mergeDrafts(st.base, payload, serverSnap)
        st.revision = Number(fresh.revision) || st.revision
        st.base = serverSnap
        st.pending = null

        if (result.conflicts.length > 0) {
          pendingMerge.current.set(analysisId, result.merged)
          if (alive.current && currentIdRef.current === analysisId) {
            setConflicts(result.conflicts)
            setCourses(result.merged.courses)
            setPolicies(result.merged.policies)
            setSaveState('needs-resolution')
          }
          return
        }
        if (alive.current && currentIdRef.current === analysisId) {
          setCourses(result.merged.courses)
          setPolicies(result.merged.policies)
          setSaveState('merged')
        }
        st.inFlight = false
        await write(analysisId, result.merged)
        return
      }

      st.revision = next
      st.base = payload
      if (alive.current) {
        // Keep the cached list in step so switcher labels and any later
        // selection reflect what was actually saved.
        setAnalyses(prev => prev.map(x => x.id === analysisId
          ? { ...x, courses: payload.courses, policies: payload.policies, revision: next }
          : x))
      }
      if (alive.current && currentIdRef.current === analysisId) setSaveState('saved')
    } catch {
      console.error('GPA analysis save failed')
      if (alive.current && currentIdRef.current === analysisId) setSaveState('error')
    } finally {
      st.inFlight = false
      const queued = st.pending
      st.pending = null
      if (queued) void write(analysisId, queued)
    }
  }, [userId])

  useEffect(() => { writeRef.current = write }, [write])

  const scheduleSave = useCallback((analysisId: string, payload: DraftSnapshot) => {
    const st = stateFor(analysisId)
    st.pending = payload
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => { st.timer = null; const p = st.pending; st.pending = null; if (p) void write(analysisId, p) }, DEBOUNCE_MS)
  }, [write])

  // Autosave the CURRENT analysis only, and never on hydration (D25).
  useEffect(() => {
    if (!loaded || !userId || !currentId) return
    if (conflicts.length > 0) return
    const st = stateFor(currentId)
    const next: DraftSnapshot = { courses, policies }
    if (snapshotsEqual(next, st.base)) return
    scheduleSave(currentId, next)
  }, [courses, policies, loaded, userId, currentId, conflicts.length, scheduleSave])

  useEffect(() => {
    if (!userId) return
    const onHide = () => {
      const id = currentIdRef.current
      if (!id) return
      const st = perAnalysis.current.get(id)
      if (st?.timer) { clearTimeout(st.timer); st.timer = null; void write(id, { courses, policies }) }
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [courses, policies, userId, write])

  // ------------------------------------------------------ CRUD on analyses
  const createAnalysis = useCallback(async (
    desiredName?: string, seed?: DraftSnapshot
  ): Promise<GpaAnalysis | null> => {
    if (!userId) return null
    const rows = await loadAnalyses()
    if (!canCreateAnalysis(rows)) {
      alert(`You can keep up to ${MAX_ANALYSES_PER_USER} analyses. Delete one before creating another.`)
      return null
    }
    const name = resolveAnalysisName(desiredName || DEFAULT_NEW_ANALYSIS_NAME, rows)
    const { data, error } = await supabase.from('gpa_drafts').insert({
      user_id: userId, name,
      courses: seed?.courses ?? [],
      policies: seed?.policies ?? DEFAULT_POLICIES,
    }).select('id, user_id, name, courses, policies, revision, updated_at').maybeSingle()
    if (error || !data) {
      alert(error?.message?.includes('at most 50')
        ? `You can keep up to ${MAX_ANALYSES_PER_USER} analyses.`
        : 'Could not create that analysis.')
      return null
    }
    const created: GpaAnalysis = {
      id: data.id, userId: data.user_id, name: data.name,
      courses: Array.isArray(data.courses) ? data.courses : [],
      policies: { ...DEFAULT_POLICIES, ...(data.policies ?? {}) },
      revision: Number(data.revision) || 1, updatedAt: data.updated_at,
    }
    await loadAnalyses()
    selectAnalysis(created)
    return created
  }, [userId, loadAnalyses, selectAnalysis])

  const renameAnalysis = useCallback(async (id: string, rawName: string): Promise<boolean> => {
    if (!userId) return false
    const name = String(rawName ?? '').trim()
    if (!name) { alert('An analysis needs a name.'); return false }
    if (nameCollides(name, [], id, analyses)) {
      alert(`You already have an analysis called "${name}". Names must be unique.`)
      return false
    }
    const st = stateFor(id)
    const { error } = await supabase.from('gpa_drafts')
      .update({ name, revision: st.revision + 1 })
      .eq('id', id).eq('user_id', userId).eq('revision', st.revision)
    if (error) {
      alert(error.code === '23505'
        ? `You already have an analysis called "${name}". Names must be unique.`
        : 'Could not rename that analysis.')
      await loadAnalyses()
      return false
    }
    st.revision = st.revision + 1
    await loadAnalyses()
    return true
  }, [userId, analyses, loadAnalyses])

  const deleteAnalysis = useCallback(async (id: string): Promise<void> => {
    if (!userId) return
    const target = analyses.find(a => a.id === id)
    if (target && target.courses.length > 0) {
      const ok = confirm(
        `Delete "${target.name}"?\n\nThis removes this analysis and its ${target.courses.length} ` +
        `course(s). Your schools and saved calculations are not affected.`
      )
      if (!ok) return
    }
    // Keyed by analysis id AND ownership -- never "delete where user_id = me".
    const { error } = await supabase.from('gpa_drafts')
      .delete().eq('id', id).eq('user_id', userId)
    if (error) { alert('Could not delete that analysis.'); return }

    const st = perAnalysis.current.get(id)
    if (st?.timer) clearTimeout(st.timer)
    perAnalysis.current.delete(id)
    pendingMerge.current.delete(id)

    const nextId = nextSelectionAfterDelete(analyses, id)
    const rows = await loadAnalyses()
    if (nextId) {
      const next = rows.find(a => a.id === nextId) ?? rows[0]
      if (next) selectAnalysis(next)
    } else {
      currentIdRef.current = null
      setCurrentId(null); setCourses([]); setPolicies(DEFAULT_POLICIES)
      await createAnalysis(DEFAULT_NEW_ANALYSIS_NAME)
    }
  }, [userId, analyses, loadAnalyses, selectAnalysis, createAnalysis])

  const resolve = useCallback((choices: Record<string, 'mine' | 'theirs'>) => {
    const id = currentIdRef.current
    if (!id) return
    const merged = pendingMerge.current.get(id) ?? { courses, policies }
    const resolved = resolveConflicts(merged, conflicts, choices)
    pendingMerge.current.delete(id)
    setConflicts([])
    setCourses(resolved.courses)
    setPolicies(resolved.policies)
    void write(id, resolved)
  }, [conflicts, courses, policies, write])

  const retry = useCallback(() => {
    const id = currentIdRef.current
    if (id) void write(id, { courses, policies })
  }, [courses, policies, write])

  const current = useMemo(
    () => analyses.find(a => a.id === currentId) ?? null, [analyses, currentId])

  return {
    loaded, analyses, current, currentId, selectAnalysis,
    createAnalysis, renameAnalysis, deleteAnalysis, reloadAnalyses: loadAnalyses,
    courses, setCourses, policies, setPolicies,
    institutions, setInstitutions,
    saveState, conflicts, resolve, retry,
  }
}
