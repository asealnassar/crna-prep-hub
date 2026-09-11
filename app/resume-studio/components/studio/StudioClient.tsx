'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import {
  DEFAULT_AUTOSAVE, hasUnsavedWork, initialState, nextAction, reduce,
} from '@/lib/resume/draft/autosave'
import type { AutosaveState } from '@/lib/resume/draft/autosave'
import { applyPatches } from '@/lib/resume/studio/patch'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import {
  initialPaneState, setViewport, viewportFor, visiblePanes,
} from '@/lib/resume/studio/panes'
import type { PaneState } from '@/lib/resume/studio/panes'
import type { ResumeSectionType, ResumeV2 } from '@/lib/resume/model/types'
import SaveIndicator from '../../components/dashboard/SaveIndicator'
import EditorPane from './EditorPane'
import MobileToggle from './MobileToggle'
import PreviewPane from './PreviewPane'

/**
 * The Studio.
 *
 * Every rule worth testing lives in lib/resume/studio and lib/resume/draft:
 * what an edit does (`applyPatches`), when to save (`nextAction`), what the
 * indicator may claim (`describe`), which pane shows (`visiblePanes`). What is
 * here is the wiring between them.
 *
 * HOW AN EDIT TRAVELS. A keystroke produces a patch. The patch is applied
 * locally at once -- that is what makes the preview live -- and pushed onto a
 * queue. When the debounce expires the whole queue goes in one request; the
 * server applies the same patches to a row it read itself and saves atomically.
 * Nothing the browser holds is ever sent as a document.
 *
 * WHY `save.revision` AND NOT `resume.revision`. The local resume's revision is
 * a content counter and climbs with every edit. The compare-and-swap needs the
 * revision the server last confirmed, which is what the autosave state carries.
 */

const ENDPOINT = '/api/resume-v2/draft'

export default function StudioClient({ initialResume }: { initialResume: ResumeV2 }) {
  const { sidebarCollapsed } = useSidebarCollapsed()

  const [resume, setResume] = useState<ResumeV2>(initialResume)
  const [save, setSave] = useState<AutosaveState>(() => initialState(initialResume.revision))
  const [panes, setPanes] = useState<PaneState>(() => initialPaneState(1280))
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(
    () => new Set(initialResume.sections.slice(0, 1).map((s) => s.id))
  )
  const [pendingType, setPendingType] = useState<ResumeSectionType | ''>('')
  const [tick, setTick] = useState(0)

  const queue = useRef<StudioPatch[]>([])
  const inFlight = useRef(false)
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save }, [save])

  const newId = useCallback(() => globalThis.crypto.randomUUID(), [])

  // --- an edit ------------------------------------------------------------

  const emit = useCallback((patch: StudioPatch) => {
    setResume((current) => applyPatches(current, [patch], { now: new Date().toISOString() }))
    queue.current.push(patch)
    setSave((s) => reduce(s, { type: 'edited', at: Date.now() }))
  }, [])

  // --- the save -----------------------------------------------------------

  const performSave = useCallback(async (expectedRevision: number) => {
    const batch = queue.current
    if (batch.length === 0) return
    queue.current = []
    inFlight.current = true
    setSave((s) => reduce(s, { type: 'save-started', at: Date.now() }))

    /** A rejected batch is still unsaved work, and goes back at the front. */
    const requeue = () => { queue.current = [...batch, ...queue.current] }

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'patch', id: initialResume.id, expectedRevision, patches: batch }),
      })
      const body = await res.json().catch(() => ({} as Record<string, unknown>))

      if (res.ok) {
        setSave((s) => reduce(s, { type: 'save-succeeded', at: Date.now(), revision: Number(body.revision) }))
        return
      }
      if (res.status === 409 && body.error === 'stale-revision') {
        requeue()
        setSave((s) => reduce(s, {
          type: 'conflict', at: Date.now(), storedRevision: Number(body.storedRevision ?? 0),
        }))
        return
      }
      requeue()
      setSave((s) => reduce(s, {
        type: 'save-failed',
        at: Date.now(),
        reason: res.status === 404 ? 'This resume no longer exists.' : 'The server rejected the change.',
        retryable: res.status >= 500,
      }))
    } catch {
      requeue()
      setSave((s) => reduce(s, { type: 'save-failed', at: Date.now(), reason: 'Network error', retryable: true }))
    } finally {
      inFlight.current = false
    }
  }, [initialResume.id])

  useEffect(() => {
    const action = nextAction(save, Date.now(), DEFAULT_AUTOSAVE)
    if (action.kind === 'idle') return
    if (action.kind === 'wait') {
      const timer = setTimeout(() => setTick((n) => n + 1), Math.max(action.afterMs, 16))
      return () => clearTimeout(timer)
    }
    if (inFlight.current) return
    void performSave(save.revision)
  }, [save, tick, performSave])

  // --- viewport and leaving -----------------------------------------------

  useEffect(() => {
    const onResize = () => setPanes((p) => setViewport(p, viewportFor(window.innerWidth)))
    onResize()
    const warn = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork(saveRef.current)) return
      event.preventDefault()
      event.returnValue = ''
    }
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') setSave((s) => reduce(s, { type: 'flush', at: Date.now() }))
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('beforeunload', warn)
    document.addEventListener('visibilitychange', flushOnHide)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('beforeunload', warn)
      document.removeEventListener('visibilitychange', flushOnHide)
    }
  }, [])

  const toggleSection = (id: string) =>
    setOpenSections((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const visible = visiblePanes(panes)

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-indigo-800">
      <div className={`flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <div className="max-w-[110rem] mx-auto px-4 sm:px-6 lg:px-8 py-6">

          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <Link href="/resume-studio" className="text-xs text-indigo-300 hover:underline">
                ← All resumes
              </Link>
              <label className="sr-only" htmlFor="resume-title">Resume title</label>
              <input
                id="resume-title"
                value={resume.title}
                onChange={(e) => emit({ op: 'title', value: e.target.value })}
                className="block w-full bg-transparent text-2xl sm:text-3xl font-bold text-white focus:outline-none focus:ring-2 focus:ring-indigo-300 rounded-lg px-1"
              />
              <SaveIndicator
                state={save}
                onRetry={() => setSave((s) => reduce(s, { type: 'retry', at: Date.now() }))}
                onReload={() => window.location.reload()}
              />
            </div>
            {visible.toggleable && <MobileToggle state={panes} onChange={setPanes} />}
          </div>

          <div className={visible.edit && visible.preview ? 'grid grid-cols-2 gap-6 items-start' : ''}>
            {visible.edit && (
              <div className="min-w-0">
                <EditorPane
                  resume={resume}
                  openSections={openSections}
                  pendingType={pendingType}
                  newId={newId}
                  emit={emit}
                  onToggleSection={toggleSection}
                  onPendingTypeChange={setPendingType}
                />
              </div>
            )}
            {visible.preview && (
              <div className="min-w-0 lg:sticky lg:top-6">
                <PreviewPane resume={resume} />
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
