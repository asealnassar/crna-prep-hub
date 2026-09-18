'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleCheck, FileText, Plus, TriangleAlert } from 'lucide-react'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import {
  DEFAULT_AUTOSAVE, hasUnsavedWork, initialState, nextAction, reduce,
} from '@/lib/resume/draft/autosave'
import type { AutosaveState } from '@/lib/resume/draft/autosave'
import { canFinalize } from '@/lib/resume/entitlement'
import { RESUME_SORTS, groupByStatus, nextStatus } from '@/lib/resume/draft/summary'
import type { ResumeSort, ResumeSummary } from '@/lib/resume/draft/summary'
import { Badge, Button, Card, cx, focusRing, text } from '../ui'
import ResumeCard from './ResumeCard'
import { DocumentStyles } from './ResumePreview'
import FeedbackButton from '../feedback/FeedbackButton'
import NewResumeDialog from './NewResumeDialog'
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
 * Titles are the only thing editable here; a card's title opens the Studio at
 * /resume-studio/[id]. That navigation is deferred while a rename is still
 * settling -- see `openResume` -- because a soft navigation does not fire
 * `beforeunload` and unmounting cancels the pending save.
 */

const ENDPOINT = '/api/resume-v2/draft'

export default function DashboardClient({ tier }: { tier: string }) {
  const { sidebarCollapsed } = useSidebarCollapsed()
  const router = useRouter()

  const [resumes, setResumes] = useState<ResumeSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** The one entry point: blank or imported is chosen inside it, not on the page. */
  const [choosing, setChoosing] = useState(false)
  /** Ordering is the applicant's, and it is done here: the list is already loaded. */
  const [sort, setSort] = useState<ResumeSort>('edited')

  // --- rename, driven by the autosave state machine -----------------------
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [save, setSave] = useState<AutosaveState>(() => initialState(1))
  const [wantsExit, setWantsExit] = useState(false)
  /** A resume to open once the rename in progress has landed. Same shape as
   *  `wantsExit`: state the intent, let the save decide when it happens. */
  const [wantsOpen, setWantsOpen] = useState<string | null>(null)
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

  /** Open a resume only once the rename it interrupted has landed. */
  useEffect(() => {
    if (wantsOpen === null) return
    // `nextAction` treats both of these as idle: they are terminal until the
    // applicant acts, so waiting for them would leave the click dead forever.
    // Say so and let go of the navigation rather than discarding the title.
    if (save.status === 'conflict' || save.status === 'failed') {
      setWantsOpen(null)
      setError('That title has not been saved yet. Sort that out first, then open the resume.')
      return
    }
    if (hasUnsavedWork(save)) return
    setWantsOpen(null)
    router.push(`/resume-studio/${wantsOpen}`)
  }, [wantsOpen, save, router])

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

  /**
   * Opening a card. The plain link handles the ordinary case; this only steps
   * in while a rename is still settling, and then it forces the save and waits
   * for the server rather than trusting that blur-then-click got the request
   * away before the unmount cancelled it.
   */
  const openResume = (resume: ResumeSummary, event: React.MouseEvent<HTMLAnchorElement>) => {
    // Never swallow a modified click: those are the browser's own "open in a
    // new tab/window", and this component is not the one unmounting for them.
    if (
      event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    ) return
    if (!hasUnsavedWork(saveRef.current)) return
    event.preventDefault()
    finishRename()
    setWantsOpen(resume.id)
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

  const { drafts, complete } = groupByStatus(resumes, sort)

  const renderCard = (resume: ResumeSummary) => (
    <ResumeCard
      key={resume.id}
      resume={resume}
      tier={tier}
      isEditing={activeId === resume.id}
      draftTitle={activeId === resume.id ? draftTitle : resume.title}
      busy={busyId === resume.id}
      canFinalize={canFinalize(tier)}
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
      onOpen={(event) => openResume(resume, event)}
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
    // Off-white rather than the blue-grey wash: the cards are the white here.
    <div className="flex min-h-screen bg-[#FAFAFB]">
      {/* The document stylesheet, once for every card's miniature. */}
      <DocumentStyles />
      <div className={`min-w-0 flex-1 transition-all duration-300 ${sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'} pt-16 lg:pt-0`}>
        <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6 lg:px-10 lg:pt-12">

          <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <div className="min-w-0">
              <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.02em] text-slate-900">Resume Studio</h1>
              <p className={cx('mt-1.5 text-[15px]', text.secondary)}>Build, improve, and export your CRNA resume.</p>
            </div>
            <div className="flex items-center gap-2">
              {/* Secondary, and deliberately not purple: the page's action is New resume. */}
              <FeedbackButton surface="dashboard" tier={tier} />
              <Button variant="primary" icon={Plus} className="h-10 rounded-xl px-4" onClick={() => setChoosing(true)}>
                New resume
              </Button>
            </div>
          </header>

          <IntroStrip />

          {error && (
            <div
              role="alert"
              className="mt-6 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          )}

          {/* Resumes are the page. Starting one -- blank or from a file someone
              already has -- is one control in the header, and the choice between
              the two is made inside it. */}
          <div className="mt-9 min-w-0">
            {loading ? (
              <p className={cx('text-sm', text.muted)}>Loading…</p>
            ) : resumes.length === 0 ? (
              <EmptyGroup
                icon={FileText}
                title="Nothing here yet"
                body="Start from scratch, or upload a resume you already have."
                /* The purple one lives in the header, and there is only ever one
                   of those on screen: this repeats the action quietly. */
                action={
                  <Button icon={Plus} className="mt-4" onClick={() => setChoosing(true)}>
                    New resume
                  </Button>
                }
              />
            ) : (
              <div className="space-y-10">
                <section aria-labelledby="drafts-heading">
                  <GroupHeading
                    id="drafts-heading"
                    title="Drafts"
                    count={drafts.length}
                    tone="accent"
                    action={
                      resumes.length > 1 ? (
                        <div className="flex items-center gap-2">
                          <label htmlFor="sort-resumes" className={cx('text-sm', text.muted)}>Sort by:</label>
                          <select
                            id="sort-resumes"
                            value={sort}
                            onChange={(e) => setSort(e.target.value as ResumeSort)}
                            className={cx(
                              'cursor-pointer rounded-lg border border-transparent bg-transparent py-1 pl-1 pr-6 text-sm font-medium text-slate-700',
                              'hover:border-slate-200 hover:bg-white',
                              focusRing
                            )}
                          >
                            {RESUME_SORTS.map((option) => (
                              <option key={option.key} value={option.key}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                      ) : null
                    }
                  />
                  {drafts.length === 0 ? (
                    <EmptyGroup
                      icon={FileText}
                      title="No drafts"
                      body="Every resume starts here — new ones and imports alike."
                    />
                  ) : (
                    <ul className="grid gap-5 sm:grid-cols-2">{drafts.map(renderCard)}</ul>
                  )}
                </section>

                <section aria-labelledby="complete-heading">
                  <GroupHeading id="complete-heading" title="Complete" count={complete.length} tone="success" />
                  {complete.length === 0 ? (
                    <EmptyGroup
                      icon={CircleCheck}
                      tone="complete"
                      title="No completed resumes yet"
                      body="Mark a resume complete when it is ready to send, and it will wait here."
                    />
                  ) : (
                    <ul className="grid gap-5 sm:grid-cols-2">{complete.map(renderCard)}</ul>
                  )}
                </section>
              </div>
            )}
          </div>

          <NewResumeDialog
            open={choosing}
            busy={creating}
            onClose={() => setChoosing(false)}
            onStartFromScratch={() => {
              setChoosing(false)
              void command({ action: 'create' }, null)
            }}
            onImported={() => void load()}
          />

        </main>
      </div>
    </div>
  )
}

/**
 * What the page is for, in one strip.
 *
 * Above the resumes because it is read once and then ignored; small, on the
 * card surface rather than a coloured panel.
 *
 * EVERY CLAIM IS TIER-NEUTRAL. Free and Premium applicants read this page too,
 * so nothing here names exporting or finalising -- both are Ultimate's, and a
 * strip that promises them would be selling something this account may not
 * have.
 */
function IntroStrip() {
  return (
    <section
      aria-label="About Resume Studio"
      className="mt-6 flex flex-wrap items-center justify-between gap-x-10 gap-y-4 rounded-2xl border border-slate-200 bg-white px-5 py-4"
    >
      <div className="flex min-w-0 items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-600 ring-1 ring-inset ring-violet-100">
          <FileText className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-slate-900">Create a standout resume for your CRNA journey.</h2>
          <p className={cx('mt-1 text-sm leading-relaxed', text.secondary)}>
            Choose a template, add your real experience, and keep it ready to send.
          </p>
        </div>
      </div>
      <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {['Professional templates', 'CRNA-focused guidance', 'Live resume preview'].map((benefit) => (
          <li key={benefit} className={cx('flex items-center gap-2 text-sm', text.secondary)}>
            <CircleCheck className="h-4 w-4 shrink-0 text-violet-500" aria-hidden="true" />
            {benefit}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A group heading, its count, and anything that acts on the group. */
function GroupHeading({
  id,
  title,
  count,
  tone = 'neutral',
  action,
}: {
  id: string
  title: string
  count?: number
  tone?: 'neutral' | 'accent' | 'success'
  action?: React.ReactNode
}) {
  return (
    <div className="mb-4 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
      <h2 id={id} className="text-xl font-semibold tracking-tight text-slate-900">{title}</h2>
      {count !== undefined && <Badge tone={tone}>{count}</Badge>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  )
}

/**
 * A group with nothing in it yet.
 *
 * A panel rather than a sentence left on the background: an empty Complete
 * section is a normal state of a working dashboard, and it should look like
 * something the page planned for.
 */
function EmptyGroup({
  icon: Icon,
  title,
  body,
  tone = 'neutral',
  action,
}: {
  icon: typeof FileText
  title: string
  body: string
  /** 'complete' is the one place green appears outside a finished resume's mark. */
  tone?: 'neutral' | 'complete'
  action?: React.ReactNode
}) {
  return (
    <Card tone="muted" className="flex flex-col items-center px-6 py-10 text-center">
      <span
        className={cx(
          'mb-3.5 flex h-12 w-12 items-center justify-center rounded-full ring-1',
          tone === 'complete' ? 'bg-emerald-50 text-emerald-600 ring-emerald-100' : 'bg-white text-slate-400 ring-slate-200'
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <h3 className="text-[15px] font-semibold text-slate-900">{title}</h3>
      <p className={cx('mt-1 max-w-md text-sm leading-relaxed', text.secondary)}>{body}</p>
      {action}
    </Card>
  )
}
