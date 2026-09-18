'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
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
import type { StrengthResult } from '@/lib/resume/score/types'
import type { PageSpan } from '@/lib/resume/document/pages'
import { isOutputLocked, protectComposedOutput } from '@/lib/resume/studio/outputLock'
import SaveIndicator from '../../components/dashboard/SaveIndicator'
import ExportMenu from '../export/ExportMenu'
import FeedbackButton from '../feedback/FeedbackButton'
import StrengthPanel from '../strength/StrengthPanel'
import { buttonClass, cx, field, iconButtonClass } from '../ui'
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

/**
 * How long "Upgrade to Ultimate" waits for its answer to be stored before it
 * gives up and says so. Long enough to cover a slow save and a retry, short
 * enough that nobody is held in a modal wondering. It never navigates on
 * expiry -- a lock that did not save must not become a resume that reads clean.
 */
const LOCK_SAVE_TIMEOUT_MS = 8_000

export default function StudioClient({
  initialResume,
  tier,
}: {
  initialResume: ResumeV2
  /** Presentation only. Every gate it drives is enforced again server-side. */
  tier: string
}) {
  const { sidebarCollapsed } = useSidebarCollapsed()

  const [resume, setResume] = useState<ResumeV2>(initialResume)
  const [save, setSave] = useState<AutosaveState>(() => initialState(initialResume.revision))
  const [panes, setPanes] = useState<PaneState>(() => initialPaneState(1280))
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(
    () => new Set(initialResume.sections.slice(0, 1).map((s) => s.id))
  )
  const [pendingType, setPendingType] = useState<ResumeSectionType | ''>('')
  /** One page or more, measured by the preview from the real page box. See lib/resume/document/pages.ts. */
  const [pageSpan, setPageSpan] = useState<PageSpan | null>(null)

  // Resume Strength is on demand. `scoredAtRevision` is the document revision
  // the visible result describes, so staleness is "you have edited since this
  // was checked" rather than a comparison between two different counters.
  // The database stores the headline score only, so a previously computed score
  // is shown as a number with its staleness until the applicant asks again --
  // the per-category reasoning is recomputed, not persisted.
  const [strength, setStrength] = useState<StrengthResult | null>(null)
  const [scoredAtRevision, setScoredAtRevision] = useState<number | null>(null)
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

  // Saves what is queued now instead of at the end of the debounce. An AI route
  // grounds a proposal in the STORED resume, so facts the applicant selected a
  // moment ago have to have landed before the request goes -- otherwise they
  // tick twelve things and the model is handed the four that were already there.
  const flush = useCallback(() => setSave((s) => reduce(s, { type: 'flush', at: Date.now() })), [])

  // --- knowing when the queue has landed ----------------------------------

  /**
   * Autosave is fire-and-forget by design: an edit applies locally and the save
   * catches up. Exactly one caller cannot live with that. "Upgrade to Ultimate"
   * leaves this page for /pricing, and if the output lock is still queued when
   * the browser navigates, the applicant returns to a fully readable resume.
   *
   * This is NOT a second persistence path. It is the same queue, the same
   * flush and the same performSave, with a way to be told when they finished.
   */
  const settleWaiters = useRef<Array<(saved: boolean) => void>>([])

  useEffect(() => {
    if (settleWaiters.current.length === 0) return
    // `retrying` is still trying, so it is not yet an answer either way.
    const saved =
      !hasUnsavedWork(save) ? true
      : save.status === 'failed' || save.status === 'conflict' ? false
      : null
    if (saved === null) return
    const waiting = settleWaiters.current
    settleWaiters.current = []
    for (const resolve of waiting) resolve(saved)
  }, [save])

  /**
   * Resolves once everything queued has reached the server, false if it could
   * not. Deliberately does NOT short-circuit on the state it can see: a caller
   * has just queued a patch whose setSave has not been applied yet, so reading
   * `saveRef` here would report the CLEAN state from before that edit and wave
   * the caller off the page with an unsaved lock -- the bug this closes.
   */
  const whenSettled = useCallback(
    () => new Promise<boolean>((resolve) => { settleWaiters.current.push(resolve) }),
    []
  )

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
  const unsaved = hasUnsavedWork(save)
  const phone = visible.toggleable

  const saveIndicator = (size: 'sm' | 'xs') => (
    <SaveIndicator
      state={save}
      size={size}
      onRetry={() => setSave((s) => reduce(s, { type: 'retry', at: Date.now() }))}
      onReload={() => window.location.reload()}
    />
  )

  const titleInput = (className: string) => (
    <>
      <label className="sr-only" htmlFor="resume-title">Resume title</label>
      <input
        id="resume-title"
        value={resume.title}
        title={resume.title}
        onChange={(e) => emit({ op: 'title', value: e.target.value })}
        className={cx(field.inlineTitle, className)}
      />
    </>
  )

  const strengthControl = (presentation: 'popover' | 'sheet') => (
    <StrengthPanel
      resumeId={initialResume.id}
      currentRevision={resume.revision}
      result={strength}
      scoredAtRevision={scoredAtRevision}
      storedScore={initialResume.strength}
      hasUnsavedWork={unsaved}
      presentation={presentation}
      onResult={(result, revision) => {
        setStrength(result)
        setScoredAtRevision(revision)
      }}
    />
  )

  /**
   * The applicant answered the download modal. BOTH answers lock the finished
   * output -- the decision is having been shown the price and responded, not
   * which way they went. See lib/resume/studio/outputLock.ts.
   */
  const lockOutput = useCallback(() => {
    emit({ op: 'output-lock' })
    flush()
  }, [emit, flush])

  /**
   * The same answer, for the one button that leaves the page. It waits for the
   * lock to be stored and reports whether it was, so the dialog can keep the
   * applicant here rather than navigate away from work that never saved. The
   * bound is not a policy, only a refusal to hang on a request that never
   * answers: an unbounded wait would strand them in the modal.
   */
  const lockOutputAndWait = useCallback(
    () => Promise.race([
      (() => { lockOutput(); return whenSettled() })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), LOCK_SAVE_TIMEOUT_MS)),
    ]),
    [lockOutput, whenSettled]
  )

  // Exports the STORED resume, so an edit still in flight would not be in the
  // file. The control is disabled until the document is settled.
  const exportControl = (compact: boolean) => (
    <ExportMenu
      resumeId={initialResume.id}
      tier={tier}
      disabled={unsaved}
      pageSpan={pageSpan}
      compact={compact}
      onNotNow={lockOutput}
      onUpgrade={lockOutputAndWait}
    />
  )

  /** Quiet, beside the real actions. Carries the template on screen, never the document. */
  const feedbackControl = (compact: boolean) => (
    <FeedbackButton surface="studio" tier={tier} template={resume.template} compact={compact} />
  )

  const editor = (
    <EditorPane
      resume={resume}
      openSections={openSections}
      pendingType={pendingType}
      newId={newId}
      emit={emit}
      unsaved={unsaved}
      onFlush={flush}
      onToggleSection={toggleSection}
      onPendingTypeChange={setPendingType}
      compact={phone}
    />
  )

  // Complete and clean for every tier while it is being built. It blurs only
  // after a download attempt was answered with "Not now".
  const preview = (
    <PreviewPane
      resume={resume}
      locked={isOutputLocked(resume, tier)}
      protectCopy={protectComposedOutput(tier)}
      onTemplateChange={(template) => emit({ op: 'template', template })}
      onPageSpanChange={setPageSpan}
      compact={phone}
    />
  )

  return (
    <div className="flex min-h-screen bg-[#F7F8FC]">
      <div className={`min-w-0 flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>

        {phone ? (
          <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
            {/* pl-16 keeps clear of the app's own fixed menu button once this sticks to the top. */}
            <div className="flex h-14 items-center gap-0.5 pl-16 pr-1.5">
              <Link href="/resume-studio" aria-label="Back to resumes" className={iconButtonClass('touch')}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              </Link>
              <div className="min-w-0 flex-1 leading-tight">
                {titleInput('w-full px-1 py-0')}
                <div className="px-1">{saveIndicator('xs')}</div>
              </div>
              {exportControl(true)}
            </div>
            <div className="flex items-center gap-2 px-3 pb-2.5">
              <MobileToggle state={panes} onChange={setPanes} className="flex-1" />
              {strengthControl('sheet')}
              {feedbackControl(true)}
            </div>
          </header>
        ) : (
          <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-slate-200 bg-white px-3">
            {/* The title side gives way first: a long title truncates and the actions never move. */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Link href="/resume-studio" aria-label="Back to resumes" className={buttonClass('tertiary', 'sm')}>
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Resumes
              </Link>
              <span className="h-5 w-px shrink-0 bg-slate-200" aria-hidden="true" />
              {titleInput('w-full max-w-[26rem] flex-1')}
              <div className="shrink-0">{saveIndicator('sm')}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {feedbackControl(false)}
              {strengthControl('popover')}
              {exportControl(false)}
            </div>
          </header>
        )}

        {visible.edit && visible.preview ? (
          <div className="grid grid-cols-[minmax(26rem,38rem)_minmax(0,1fr)]">
            <main className="min-w-0 px-6 pb-24 pt-6">{editor}</main>
            {/* A hairline and a faint inner shade: the editor ends here and the document begins. */}
            <aside className="sticky top-14 h-[calc(100vh-3.5rem)] min-w-0 border-l border-slate-200">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 z-10 w-3 bg-gradient-to-r from-slate-900/[0.04] to-transparent"
              />
              {preview}
            </aside>
          </div>
        ) : visible.edit ? (
          <main className="px-3 pb-16 pt-3">{editor}</main>
        ) : (
          <main>{preview}</main>
        )}

      </div>
    </div>
  )
}
