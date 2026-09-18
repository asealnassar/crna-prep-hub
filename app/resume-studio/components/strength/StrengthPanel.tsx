'use client'

import { useCallback, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, CircleCheck, Clock, Gauge, RotateCcw, X } from 'lucide-react'
import { STRENGTH_DISCLAIMER, STRENGTH_NAME } from '@/lib/resume/score/language'
import type { StrengthResult, SubScoreResult } from '@/lib/resume/score/types'
import type { ResumeStrengthRef } from '@/lib/resume/model/types'
import { Badge, Button, Card, IconButton, buttonClass, cx, floating, text, useDismiss } from '../ui'
import CategoryRow from './CategoryRow'
import ImprovementList from './ImprovementList'

/**
 * CRNA Resume Strength.
 *
 * ON DEMAND. Nothing computes on a keystroke; the applicant asks. That is what
 * keeps the cost bounded without a quota, and it is also kinder — a number that
 * twitches while you type is a number you start writing for.
 *
 * STALE, NOT HIDDEN. Once the resume moves on, the score stays on screen with a
 * clear label. Hiding it would lose the guidance someone is working through;
 * silently keeping it would be a number that no longer refers to anything.
 *
 * A COMPACT ENTRY POINT. The toolbar shows the number and whether it is current;
 * the analysis opens beneath it on desktop and as a sheet on a phone. Opening it
 * only opens it -- checking stays the explicit button inside.
 *
 * NO TIER GATE ANYWHERE IN THIS FILE. Every tier sees this.
 */

const ENDPOINT = '/api/resume-v2/score'

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'error'; readonly message: string }

export default function StrengthPanel({
  resumeId,
  currentRevision,
  result,
  scoredAtRevision,
  storedScore,
  hasUnsavedWork,
  onResult,
  presentation = 'popover',
}: {
  resumeId: string
  /** The document's revision right now. */
  currentRevision: number
  result: StrengthResult | null
  /** The revision the visible result describes. */
  scoredAtRevision: number | null
  /**
   * A score computed in an earlier session. The database keeps the headline
   * number and the revision it was taken at, not the reasoning -- so this shows
   * as a number with its staleness, and a check brings the detail back.
   */
  storedScore?: ResumeStrengthRef | null
  hasUnsavedWork: boolean
  onResult: (result: StrengthResult, revision: number) => void
  /** Presentation only: a panel under the chip on desktop, a bottom sheet on a phone. */
  presentation?: 'popover' | 'sheet'
}) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const inFlight = useRef(false)
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const headingId = useId()
  const chipRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const run = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    // Captured before the request: the server scores the STORED resume, so a
    // score describes the document as it was when we asked.
    const askedAt = currentRevision
    setState({ kind: 'working' })

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: resumeId }),
      })
      const body = await res.json().catch(() => ({} as Record<string, unknown>))

      if (res.status === 429) {
        // A rate ceiling, never a plan boundary.
        setState({
          kind: 'error',
          message: typeof body.message === 'string' ? body.message : 'Too many requests just now. Please try again shortly.',
        })
        return
      }
      if (!res.ok) {
        setState({ kind: 'error', message: 'Could not check your resume just now.' })
        return
      }

      onResult(body.strength as StrengthResult, askedAt)
      setState({ kind: 'idle' })
    } catch {
      setState({ kind: 'error', message: 'Could not reach the server.' })
    } finally {
      inFlight.current = false
    }
  }, [resumeId, currentRevision, onResult])

  const close = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) chipRef.current?.focus()
  }

  useDismiss(open && presentation === 'popover', [chipRef, panelRef], (reason) => close(reason === 'escape'))

  const working = state.kind === 'working'
  const stale = result !== null && scoredAtRevision !== null && scoredAtRevision !== currentRevision
  const score = result ? result.score : storedScore ? storedScore.score : null
  const outOfDate = result ? stale : storedScore ? storedScore.computedAtRevision !== currentRevision : false

  const chipName = score === null
    ? `${STRENGTH_NAME}: not checked yet`
    : `${STRENGTH_NAME}: ${score} out of 100, ${working ? 'checking' : outOfDate ? 'out of date' : 'up to date'}`

  const details = (
    <div>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 pb-3.5 pt-4">
        <div>
          <h2 id={headingId} className={text.heading}>{STRENGTH_NAME}</h2>
          <p className={cx('mt-1 text-xs leading-relaxed', text.muted)}>{STRENGTH_DISCLAIMER}</p>
        </div>
        <IconButton icon={X} label="Close" size="sm" onClick={() => close(true)} className="-mr-1.5 -mt-1" />
      </div>

      <div className="px-5 pb-4 pt-4">
        {score !== null && (
          <div className="flex items-end justify-between gap-4">
            <p className="flex items-baseline gap-1.5">
              <span className={cx('text-4xl font-semibold tabular-nums tracking-tight', outOfDate ? 'text-slate-400' : 'text-slate-900')}>
                {score}
              </span>
              <span className={cx('text-sm', text.muted)}>/ 100</span>
            </p>
            {working ? (
              <Badge>Checking…</Badge>
            ) : outOfDate ? (
              <Badge tone="warning" icon={Clock}>Out of date</Badge>
            ) : (
              <Badge tone="success" icon={CircleCheck}>Up to date</Badge>
            )}
          </div>
        )}

        {result && stale && (
          <p role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            You have edited the resume since this was checked, so these numbers describe an earlier
            version. Refresh the score to bring them up to date.
          </p>
        )}

        {!result && storedScore && (
          <p className={cx('mt-2 text-xs leading-relaxed', text.secondary)}>
            {storedScore.computedAtRevision === currentRevision
              ? 'From an earlier check. Refresh the score to see the reasoning behind it.'
              : 'From an earlier check, before your latest edits. Refresh the score for an up-to-date number and the reasoning behind it.'}
          </p>
        )}

        {result && (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <SubScore sub={result.dataQuality} dim={stale} />
            <SubScore sub={result.writingQuality} dim={stale} />
          </div>
        )}

        <Button
          variant={score === null || outOfDate ? 'primary' : 'secondary'}
          icon={RotateCcw}
          className="mt-4 w-full"
          onClick={() => void run()}
          disabled={working || hasUnsavedWork}
          aria-busy={working}
        >
          {working ? 'Checking…' : score !== null ? 'Refresh score' : 'Check my resume'}
        </Button>

        {hasUnsavedWork && !working && (
          <p className={cx('mt-2 text-xs', text.muted)} role="status">
            Waiting for your latest edits to save — the check reads your saved resume.
          </p>
        )}

        {state.kind === 'error' && (
          <p className="mt-2 text-xs text-amber-800" role="alert">{state.message}</p>
        )}
      </div>

      {result && (
        <>
          <div className="border-t border-slate-100 px-5 py-4">
            <h3 className={text.heading}>What to do next</h3>
            <div className="mt-2.5">
              <ImprovementList result={result} />
            </div>
          </div>

          <div className="border-t border-slate-100 px-5 pb-5 pt-4">
            <h3 className={text.heading}>Every category</h3>
            {[result.dataQuality, result.writingQuality].map((sub) => (
              <div key={sub.id} className="mt-3">
                <p className={text.overline}>{sub.label}</p>
                <div className="mt-1 divide-y divide-slate-100">
                  {sub.categories.map((c) => (
                    <CategoryRow key={c.id} result={c} dim={stale} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )

  if (presentation === 'sheet') {
    return (
      <>
        <button
          ref={chipRef}
          type="button"
          aria-haspopup="dialog"
          aria-label={chipName}
          onClick={() => setOpen(true)}
          className={cx(buttonClass('secondary'), 'gap-1.5 pl-1.5 pr-2.5')}
        >
          {score === null ? (
            <>
              <Gauge className="h-4 w-4 text-slate-500" aria-hidden="true" />
              <span>Strength</span>
            </>
          ) : (
            <>
              <ScoreRing score={score} muted={outOfDate} />
              <span className={cx('tabular-nums', outOfDate ? 'text-slate-500' : 'text-slate-900')}>{score}</span>
              {/* Up to date is the quiet default; out of date is spelled out, not left to an icon. */}
              {outOfDate && <span className="text-xs font-medium text-amber-700">Out of date</span>}
            </>
          )}
        </button>
        {open && typeof document !== 'undefined' && createPortal(
          <div
            className={cx('fixed inset-0 z-50 flex flex-col justify-end', floating.scrim)}
            onClick={() => close(true)}
            onKeyDown={(event) => { if (event.key === 'Escape') close(true) }}
          >
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-modal="true"
              aria-labelledby={headingId}
              className={cx(floating.sheet, 'max-h-[85vh] overflow-y-auto')}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex justify-center pt-2" aria-hidden="true">
                <span className="h-1 w-10 rounded-full bg-slate-300" />
              </div>
              {details}
            </div>
          </div>,
          document.body
        )}
      </>
    )
  }

  return (
    <div className="relative">
      <button
        ref={chipRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={chipName}
        onClick={() => setOpen((current) => !current)}
        className={cx(buttonClass('secondary'), 'gap-2 pl-2 pr-2.5')}
      >
        {score === null ? (
          <>
            <Gauge className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <span>{working ? 'Checking…' : 'Check strength'}</span>
          </>
        ) : (
          <>
            <ScoreRing score={score} muted={outOfDate} />
            <span className={cx('tabular-nums', outOfDate ? 'text-slate-500' : 'text-slate-900')}>{score}</span>
            <span className="h-4 w-px bg-slate-200" aria-hidden="true" />
            {working ? (
              <span className={cx('text-xs font-medium', text.muted)}>Checking…</span>
            ) : outOfDate ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />Out of date
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />Up to date
              </span>
            )}
          </>
        )}
        <ChevronDown className={cx('h-3.5 w-3.5 text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          className={cx(floating.popover, 'absolute right-0 top-full mt-2 max-h-[calc(100vh-5rem)] w-[26rem] overflow-y-auto')}
        >
          {details}
        </div>
      )}
    </div>
  )
}

function ScoreRing({ score, muted, size = 20 }: { score: number; muted: boolean; size?: number }) {
  const radius = (size - 4) / 2
  const circumference = 2 * Math.PI * radius
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth="3" className="stroke-slate-200" />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(0, Math.min(100, score)) / 100)}
        className={muted ? 'stroke-slate-400' : 'stroke-violet-600'}
      />
    </svg>
  )
}

function SubScore({ sub, dim }: { sub: SubScoreResult; dim: boolean }) {
  return (
    <Card tone="muted" className="px-3 py-2.5">
      <p className={cx('text-xs', text.secondary)}>{sub.label}</p>
      <p className="mt-0.5 flex items-baseline gap-0.5">
        <span className={cx('text-lg font-semibold tabular-nums', dim ? 'text-slate-400' : 'text-slate-900')}>{sub.points}</span>
        <span className={cx('text-xs', text.muted)}>/{sub.max}</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
        <div
          className={cx('h-full rounded-full', dim ? 'bg-slate-400' : 'bg-violet-600')}
          style={{ width: `${sub.max > 0 ? Math.min(100, (sub.points / sub.max) * 100) : 0}%` }}
        />
      </div>
      {sub.notAssessed && <p className={cx('mt-1.5 text-xs', text.muted)}>{sub.notAssessed}</p>}
    </Card>
  )
}
