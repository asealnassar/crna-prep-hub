'use client'

/**
 * What a transcript analysis looks like while it is running.
 *
 * The wait is real -- tens of seconds normally, sometimes past a minute -- so
 * this is a full surface rather than a spinner on a button. It shows what is
 * genuinely happening and how long it has genuinely taken, and it says nothing
 * it cannot know: no percentage, no estimate, no promise that the work
 * continues after the page closes.
 *
 * It is a panel rather than a modal: the request lives in this page's state and
 * survives moving between the workspace tabs, so there is no reason to lock the
 * user out of their own coursework while they wait. The one thing they must not
 * do -- start the same analysis again -- is prevented at the upload controls
 * instead.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, RefreshCw, Upload } from 'lucide-react'
import { BTN_PRIMARY, BTN_SECONDARY, CARD } from './workspace'
import {
  KEEP_PAGE_OPEN, destinationLine, elapsedMs, failureCopy, formatElapsed,
  reassuranceFor, stageList, statusAnnouncement, type ImportState,
} from '@/lib/gpa/importProgress'

/** Ticks once a second while running, so the timer measures real time. */
function useElapsed(state: ImportState): number {
  const [now, setNow] = useState(() => Date.now())
  const running = state.phase === 'running'
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running, state.startedAt])
  return elapsedMs(state, now)
}

function StageRow({
  label, detail, status,
}: { label: string; detail: string; status: 'done' | 'active' | 'pending' }) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
        status === 'done' ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
        : status === 'active' ? 'border-violet-200 bg-violet-50 text-violet-600'
        : 'border-slate-200 bg-white text-slate-300'}`}>
        {status === 'done'
          ? <Check className="h-3 w-3" />
          : status === 'active'
            ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
            : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <span className="min-w-0">
        {/* The state is in the text too, never in colour or motion alone. */}
        <span className={`block break-words text-sm font-semibold ${
          status === 'pending' ? 'text-slate-400' : 'text-slate-900'}`}>
          {label}
          <span className="sr-only">
            {status === 'done' ? ' — complete' : status === 'active' ? ' — in progress' : ' — not started'}
          </span>
        </span>
        {status !== 'pending' && (
          <span className="mt-0.5 block break-words text-xs text-slate-500">{detail}</span>
        )}
      </span>
    </li>
  )
}

export function ImportProgress({
  state, onRetry, onChooseAnother, onDismiss,
}: {
  state: ImportState
  onRetry: () => void
  onChooseAnother: () => void
  onDismiss: () => void
}) {
  const ms = useElapsed(state)
  const errorHeading = useRef<HTMLHeadingElement>(null)
  const retrying = useRef(false)

  const failed = state.phase === 'error'
  const copy = failed ? failureCopy(state.failure ?? 'unknown') : null

  // Failure is where the user has to act, so that is where focus goes.
  useEffect(() => { if (failed) errorHeading.current?.focus() }, [failed])

  const retry = () => {
    if (retrying.current) return
    retrying.current = true
    onRetry()
  }
  useEffect(() => { if (state.phase === 'running') retrying.current = false }, [state.phase])

  const stages = stageList(state)

  return (
    <section aria-labelledby="import-title"
      className={`${CARD} mb-5 border-violet-200 p-4 shadow-[0_6px_24px_rgba(76,29,149,0.08)] sm:p-6`}>
      <div className="mx-auto max-w-2xl">

        {/* Stage changes are announced; the timer below never is. */}
        <p className="sr-only" role="status" aria-live="polite">{statusAnnouncement(state)}</p>

        {failed ? (
          <>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-50">
                <AlertTriangle className="h-5 w-5 text-rose-600" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 id="import-title" ref={errorHeading} tabIndex={-1}
                  className="text-base font-bold tracking-tight text-slate-900 outline-none sm:text-lg">
                  {copy!.title}
                </h2>
                <p className="mt-1.5 break-words text-sm text-slate-600">{copy!.message}</p>
              </div>
            </div>

            <p className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
              Nothing was added to your analyses, and none of your existing coursework changed.
            </p>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
              {copy!.canRetry && (
                <button onClick={retry} className={`${BTN_PRIMARY} !py-3 sm:!py-2.5`}>
                  <RefreshCw className="h-4 w-4" aria-hidden />Retry Analysis
                </button>
              )}
              {copy!.secondary && (
                <button onClick={onChooseAnother} className={`${BTN_SECONDARY} !py-3 sm:!py-2.5`}>
                  <Upload className="h-4 w-4" aria-hidden />{copy!.secondary}
                </button>
              )}
              <button onClick={onDismiss}
                className={`${BTN_SECONDARY} !border-transparent !py-3 sm:mr-auto sm:!py-2.5`}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="import-title" className="flex items-center gap-2 text-base font-bold tracking-tight text-slate-900 sm:text-lg">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-600 motion-reduce:animate-none" aria-hidden />
                  Analyzing your transcript
                </h2>
                <p className="mt-1.5 break-words text-sm text-slate-600">{destinationLine(state)}</p>
              </div>
              {/* Measured, not estimated. Hidden from assistive tech so it is
                  not announced once a second. */}
              <span aria-hidden
                className="shrink-0 rounded-lg bg-slate-100 px-2 py-1 font-mono text-sm font-semibold tabular-nums text-slate-700">
                {formatElapsed(ms)}
              </span>
            </div>

            <ul className="mt-5 space-y-3">
              {stages.map(s => (
                <StageRow key={s.id} label={s.label} detail={s.detail} status={s.status} />
              ))}
            </ul>

            <p className="mt-5 break-words rounded-xl bg-violet-50 px-3 py-2.5 text-sm text-violet-900">
              {reassuranceFor(ms)}
            </p>
            <p className="mt-2 text-xs font-medium text-slate-500">{KEEP_PAGE_OPEN}</p>
          </>
        )}
      </div>
    </section>
  )
}

/** The brief confirmation that replaces the progress panel on success. */
export function ImportSuccessFlash({ courses }: { courses: number }) {
  return (
    <div className="mb-5 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900"
      role="status">
      <Check className="h-4 w-4 shrink-0" aria-hidden />
      Transcript analyzed — {courses} course{courses === 1 ? '' : 's'} imported.
    </div>
  )
}
