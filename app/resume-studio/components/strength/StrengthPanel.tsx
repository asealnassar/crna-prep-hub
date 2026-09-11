'use client'

import { useCallback, useRef, useState } from 'react'
import { STRENGTH_DISCLAIMER, STRENGTH_NAME } from '@/lib/resume/score/language'
import type { StrengthResult, SubScoreResult } from '@/lib/resume/score/types'
import type { ResumeStrengthRef } from '@/lib/resume/model/types'
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
}) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const inFlight = useRef(false)

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

  const working = state.kind === 'working'
  const stale = result !== null && scoredAtRevision !== null && scoredAtRevision !== currentRevision

  return (
    <section className="border border-white/20 bg-white/5 rounded-2xl p-4" aria-labelledby="strength-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="strength-heading" className="text-white font-semibold">{STRENGTH_NAME}</h2>
          <p className="text-xs text-indigo-300 mt-0.5 max-w-md">{STRENGTH_DISCLAIMER}</p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={working || hasUnsavedWork}
          aria-busy={working}
          className="px-4 py-2 text-sm font-semibold rounded-xl border border-white/30 text-white hover:bg-white/10 transition disabled:opacity-50"
        >
          {working ? 'Checking…' : result ? 'Refresh' : 'Check my resume'}
        </button>
      </div>

      {hasUnsavedWork && !working && (
        <p className="mt-2 text-xs text-indigo-300" role="status">
          Waiting for your latest edits to save — the check reads your saved resume.
        </p>
      )}

      {state.kind === 'error' && (
        <p className="mt-3 text-xs text-amber-200" role="alert">{state.message}</p>
      )}

      {!result && storedScore && (
        <div className="mt-4">
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold text-indigo-200/70">{storedScore.score}</span>
            <span className="text-sm text-indigo-300">out of 100, from an earlier check</span>
          </div>
          <p className="mt-1 text-xs text-indigo-300">
            {storedScore.computedAtRevision === currentRevision
              ? 'Check again to see the reasoning behind it.'
              : 'You have edited the resume since. Check again for an up-to-date score and the reasoning behind it.'}
          </p>
        </div>
      )}

      {result && (
        <div className="mt-4">
          {stale && (
            <p
              role="status"
              className="mb-3 rounded-xl border border-amber-300/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100"
            >
              You have edited the resume since this was checked, so these numbers describe an earlier
              version. Refresh to bring them up to date.
            </p>
          )}

          <div className="flex items-baseline gap-3">
            <span className={`text-4xl font-bold ${stale ? 'text-indigo-200/60' : 'text-white'}`}>
              {result.score}
            </span>
            <span className="text-sm text-indigo-300">out of 100</span>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <SubScore sub={result.dataQuality} dim={stale} />
            <SubScore sub={result.writingQuality} dim={stale} />
          </div>

          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-300 mb-2">
              What to do next
            </h3>
            <ImprovementList result={result} />
          </div>

          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-300 mb-1">
              Every category
            </h3>
            <div>
              {[...result.dataQuality.categories, ...result.writingQuality.categories].map((c) => (
                <CategoryRow key={c.id} result={c} />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function SubScore({ sub, dim }: { sub: SubScoreResult; dim: boolean }) {
  return (
    <div className="rounded-xl border border-white/15 bg-white/5 px-3 py-2">
      <p className="text-xs text-indigo-300">{sub.label}</p>
      <p className={`text-lg font-semibold ${dim ? 'text-indigo-200/60' : 'text-white'}`}>
        {sub.points}
        <span className="text-indigo-300 text-sm font-normal">/{sub.max}</span>
      </p>
      {sub.notAssessed && <p className="text-xs text-indigo-300 mt-1">{sub.notAssessed}</p>}
    </div>
  )
}
