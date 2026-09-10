'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import {
  DEFAULT_AUTOSAVE, hasUnsavedWork, initialState, nextAction, reduce,
} from '@/lib/resume/draft/autosave'
import type { AutosaveState } from '@/lib/resume/draft/autosave'
import { groupByStatus, nextStatus } from '@/lib/resume/draft/summary'
import type { ResumeSummary } from '@/lib/resume/draft/summary'
import ResumeCard from './ResumeCard'
import SaveIndicator from './SaveIndicator'

/**
 * The Resume Studio dashboard.
 *
 * This component is the DRIVER for lib/resume/draft/autosave.ts and holds no
 * save logic of its own: it asks `nextAction` what to do, performs it, and
 * feeds the real response back through `reduce`. Every rule worth testing --
 * when to save, what to do about a conflict, what the indicator may claim --
 * lives in that module and is unit-tested there.
 *
 * Titles are the only thing editable here. The section editor is Phase 5, so
 * cards deliberately do not link to /resume-studio/[id] yet: a link to a route
 * that does not exist is worse than no link.
 */

const ENDPOINT = '/api/resume-v2/draft'

export default function DashboardClient() {
  const { sidebarCollapsed } = useSidebarCollapsed()

  const [resumes, setResumes] = useState<ResumeSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // --- rename, driven by the autosave state machine -----------------------
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [save, setSave] = useState<AutosaveState>(() => initialState(1))
  const [wantsExit, setWantsExit] = useState(false)
  /** Bumped by a timer so the driver re-evaluates when a wait expires. */
  const [tick, setTick] = useState(0)

  const titleRef = useRef('')
  const activeRef = useRef<string | null>(null)
  const saveRef = useRef(save)
  const inFlight = useRef(false)

  useEffect(() => { saveRef.current = save }, [save])

  const load = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, { cache: 'no-store' })
      if (!res.ok) {
        setError(res.status === 401 ? 'Please sign in again.' : 'Could not load your resumes.')
        return
      }
      const body = await res.json()
      setResumes(Array.isArray(body.resumes) ? body.resumes : [])
      setError(null)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // --- the save itself ----------------------------------------------------

  const performRename = useCallback(async (expectedRevision: number) => {
    const id = activeRef.current
    if (!id) return
    inFlight.current = true
    setSave((s) => reduce(s, { type: 'save-started', at: Date.now() }))

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'rename', id, title: titleRef.current, expectedRevision,
        }),
      })
      const body = await res.json().catch(() => ({} as Record<string, unknown>))

      if (res.ok) {
        const revision = Number(body.revision)
        setSave((s) => reduce(s, { type: 'save-succeeded', at: Date.now(), revision }))
        setResumes((prev) =>
          prev.map((r) =>
            r.id === id
              ? { ...r, title: titleRef.current, revision, updatedAt: new Date().toISOString() }
              : r
          )
        )
        return
      }

      if (res.status === 409 && body.error === 'stale-revision') {
        setSave((s) =>
          reduce(s, {
            type: 'conflict',
            at: Date.now(),
            storedRevision: Number(body.storedRevision ?? 0),
          })
        )
        return
      }

      // 4xx means this request will never succeed as sent; only a server-side
      // or transport problem is worth repeating.
      setSave((s) =>
        reduce(s, {
          type: 'save-failed',
          at: Date.now(),
          reason: res.status === 404 ? 'This resume no longer exists.' : 'The server rejected the change.',
          retryable: res.status >= 500,
        })
      )
    } catch {
      setSave((s) =>
        reduce(s, { type: 'save-failed', at: Date.now(), reason: 'Network error', retryable: true })
      )
    } finally {
      inFlight.current = false
    }
  }, [])

  // --- the driver ---------------------------------------------------------

  useEffect(() => {
    const action = nextAction(save, Date.now(), DEFAULT_AUTOSAVE)
    if (action.kind === 'idle') return
    if (action.kind === 'wait') {
      const timer = setTimeout(() => setTick((n) => n + 1), Math.max(action.afterMs, 16))
      return () => clearTimeout(timer)
    }
    // `nextAction` returns idle while a save is in flight, but the state that
    // says so is set asynchronously; the ref closes that window.
    if (inFlight.current) return
    void performRename(save.revision)
  }, [save, tick, performRename])

  /** Leave edit mode only once there is genuinely nothing left to save. */
  useEffect(() => {
    if (wantsExit && !hasUnsavedWork(save)) {
      setActiveId(null)
      activeRef.current = null
      setWantsExit(false)
    }
  }, [wantsExit, save])

  // --- not losing work ----------------------------------------------------

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork(saveRef.current)) return
      event.preventDefault()
      event.returnValue = ''
    }
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') {
        setSave((s) => reduce(s, { type: 'flush', at: Date.now() }))
      }
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('visibilitychange', flushOnHide)
    return () => {
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('visibilitychange', flushOnHide)
    }
  }, [])

  // --- rename controls ----------------------------------------------------

  const startRename = (resume: ResumeSummary) => {
    if (activeRef.current === resume.id) return
    if (hasUnsavedWork(saveRef.current)) return // finish the one in progress first
    setActiveId(resume.id)
    activeRef.current = resume.id
    setDraftTitle(resume.title)
    titleRef.current = resume.title
    setSave(initialState(resume.revision))
    setWantsExit(false)
  }

  const changeTitle = (value: string) => {
    setDraftTitle(value)
    titleRef.current = value
    setSave((s) => reduce(s, { type: 'edited', at: Date.now() }))
  }

  const finishRename = () => {
    setSave((s) => reduce(s, { type: 'flush', at: Date.now() }))
    setWantsExit(true)
  }

  // --- one-shot commands --------------------------------------------------

  const command = async (payload: Record<string, unknown>, id: string | null) => {
    setBusyId(id)
    if (id === null) setCreating(true)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>))
        setError(
          res.status === 409 && body.error === 'stale-revision'
            ? 'That resume changed somewhere else. Refreshing.'
            : 'That did not work. Please try again.'
        )
      } else {
        setError(null)
      }
      await load()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusyId(null)
      setCreating(false)
    }
  }

  const { drafts, complete } = groupByStatus(resumes)

  const renderCard = (resume: ResumeSummary) => (
    <ResumeCard
      key={resume.id}
      resume={resume}
      isEditing={activeId === resume.id}
      draftTitle={activeId === resume.id ? draftTitle : resume.title}
      busy={busyId === resume.id}
      indicator={
        activeId === resume.id ? (
          <SaveIndicator
            state={save}
            onRetry={() => setSave((s) => reduce(s, { type: 'retry', at: Date.now() }))}
            onReload={() => {
              setSave((s) => reduce(s, { type: 'reloaded', at: Date.now(), revision: s.storedRevision ?? s.revision }))
              setActiveId(null)
              activeRef.current = null
              setWantsExit(false)
              void load()
            }}
          />
        ) : null
      }
      onStartRename={() => startRename(resume)}
      onTitleChange={changeTitle}
      onFinishRename={finishRename}
      onToggleStatus={() =>
        command(
          { action: 'set-status', id: resume.id, status: nextStatus(resume.status), expectedRevision: resume.revision },
          resume.id
        )
      }
      onDuplicate={() => command({ action: 'duplicate', sourceId: resume.id }, resume.id)}
      onDelete={() => {
        if (!confirm(`Delete "${resume.title}"? This cannot be undone.`)) return
        void command({ action: 'delete', id: resume.id }, resume.id)
      }}
    />
  )

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Resume Studio</h1>
              <p className="text-indigo-200">Your drafts, saved as you work.</p>
            </div>
            <button
              type="button"
              onClick={() => command({ action: 'create' }, null)}
              disabled={creating}
              className="px-5 py-2.5 bg-white text-indigo-900 font-semibold rounded-xl hover:bg-indigo-50 transition disabled:opacity-60"
            >
              {creating ? 'Creating…' : 'New resume'}
            </button>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-6 bg-amber-400/15 border border-amber-300/40 text-amber-100 rounded-xl px-4 py-3 text-sm"
            >
              {error}
            </div>
          )}

          {loading ? (
            <p className="text-indigo-200">Loading…</p>
          ) : resumes.length === 0 ? (
            <div className="bg-white/10 backdrop-blur-sm border-2 border-white/20 rounded-2xl p-8 text-center">
              <h2 className="text-xl font-bold text-white mb-2">Nothing here yet</h2>
              <p className="text-indigo-200 text-sm">
                Create your first resume and it will be saved as you go.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              <section>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-indigo-300 mb-3">
                  Drafts ({drafts.length})
                </h2>
                {drafts.length === 0 ? (
                  <p className="text-indigo-300 text-sm">No drafts.</p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">{drafts.map(renderCard)}</div>
                )}
              </section>

              <section>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-indigo-300 mb-3">
                  Complete ({complete.length})
                </h2>
                {complete.length === 0 ? (
                  <p className="text-indigo-300 text-sm">
                    Nothing marked complete yet — use “Mark as complete” when a resume is ready.
                  </p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">{complete.map(renderCard)}</div>
                )}
              </section>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
