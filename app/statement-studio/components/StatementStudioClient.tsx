'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { initialState, reduce, type AutosaveState } from '@/lib/resume/draft/autosave'
import { MAX_SAVED_CHARS } from '@/lib/statement/extract/limits'
import type { StatementDraft } from '@/lib/statement/draft/rows'
import { SAVE_MESSAGES, saveEventFrom } from '@/lib/statement/draft/save'
import {
  draftSavePath,
  statementDriverAction,
  statementSaveRequest,
  statementStatus,
} from '@/lib/statement/draft/editor'

/**
 * The statement editor, and the driver for the shared autosave engine.
 *
 * THE ENGINE IS lib/resume/draft/autosave.ts, USED IN PLACE. It is imported, not
 * copied and not forked: it decides when to save, it enforces single flight, and
 * it is the only thing that advances the revision. This component owns the
 * clock, the payload and the request -- the three things it deliberately does
 * not know about -- and nothing else.
 *
 * WHAT IS NOT HERE, on purpose: upload, analysis, version history, schools,
 * prompts, delete, conflict recovery, navigation guards, beforeunload and
 * visibilitychange. Each is its own step. The consequence to know about today is
 * in the note on the library link below.
 *
 * THE TITLE IS READ-ONLY IN THIS CHECKPOINT. checkTitle() trims, so an editable
 * title would let the field read "My essay " while the row holds "My essay", and
 * the indicator would say Saved over a visible difference. Reconciling that
 * needs the save snapshot written back into the field, which is its own small
 * piece of work. The title that IS sent came out of the database, so it has
 * already been through the same trim and round-trips unchanged.
 */
export default function StatementStudioClient({ draft }: { draft: StatementDraft }) {
  const [essay, setEssay] = useState(draft.essay)
  /** THE INITIAL REVISION IS THE SERVER'S. Never a literal 1. */
  const [save, setSave] = useState<AutosaveState>(() => initialState(draft.revision))
  const [blocked, setBlocked] = useState<string | null>(null)
  /** Bumped by the wait timer, so the effect re-asks the engine at the due time. */
  const [tick, setTick] = useState(0)

  /**
   * SINGLE FLIGHT, taken synchronously. nextAction() already returns 'idle'
   * while a save is in flight, but the reducer that sets 'saving' is a state
   * update and therefore asynchronous; this closes the window between the effect
   * deciding to save and the state reflecting it.
   */
  const inFlight = useRef(false)

  const startSave = useCallback(
    async (revision: number, snapshot: string) => {
      if (inFlight.current) return

      // The document as it is at THIS instant. Edits arriving after this line
      // belong to the next save, which is exactly what the engine's
      // inFlightSince / dirtySince split is for.
      const request = statementSaveRequest({ title: draft.title, essay: snapshot, revision })
      if (!request.ok) return

      inFlight.current = true
      setSave((state) => reduce(state, { type: 'save-started', at: Date.now() }))

      try {
        const response = await fetch(draftSavePath(draft.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request.body),
        })
        const body = await response.json().catch(() => null)
        // THE ONE MAPPING. saveEventFrom decides success, conflict and whether a
        // failure is retryable; none of that is repeated here.
        setSave((state) =>
          reduce(state, saveEventFrom({ status: response.status, body, at: Date.now() }))
        )
      } catch {
        // The request never arrived, so the write did not happen and trying
        // again is safe. SAVE_MESSAGES.server is reused rather than a new
        // sentence invented, because statementStatus() renders only strings this
        // codebase already chose.
        setSave((state) =>
          reduce(state, {
            type: 'save-failed',
            at: Date.now(),
            reason: SAVE_MESSAGES.server,
            retryable: true,
          })
        )
      } finally {
        inFlight.current = false
      }
    },
    [draft.id, draft.title]
  )

  useEffect(() => {
    const action = statementDriverAction({
      state: save,
      now: Date.now(),
      title: draft.title,
      essay,
    })

    if (action.kind === 'blocked') {
      // No request and NO TIMER. The work stays on screen, visibly unsaved, and
      // nothing runs again until the applicant types.
      setBlocked(action.message)
      return
    }
    setBlocked(null)

    if (action.kind === 'idle') return
    if (action.kind === 'wait') {
      const timer = setTimeout(() => setTick((n) => n + 1), action.afterMs)
      return () => clearTimeout(timer)
    }

    void startSave(save.revision, essay)
  }, [save, essay, tick, draft.title, startSave])

  const onEssayChange = useCallback((value: string) => {
    setEssay(value)
    // Dispatched on EVERY edit, including during a save. The engine restarts the
    // dirty window while a request is in flight, so a success that lands after
    // this edit reports 'dirty' rather than 'saved'.
    setSave((state) => reduce(state, { type: 'edited', at: Date.now() }))
  }, [])

  const status = statementStatus(save, blocked)
  const characters = essay.length

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <p className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        Internal preview. Upload and “Analyze this Draft” are not wired up yet.
      </p>

      {/*
        NO SAVE-BEFORE-NAVIGATION GUARD YET. A soft navigation away from here
        does not fire beforeunload and unmounting cancels a pending save, so
        edits made in the last debounce window can be lost by clicking this.
        That guard is the next step and is deliberately absent today.
      */}
      <Link
        href="/statement-studio"
        className="text-sm font-medium text-blue-700 hover:underline"
      >
        ← All drafts
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <h1 className="min-w-0 text-2xl font-bold text-slate-900">{draft.title}</h1>
        <p
          role="status"
          aria-live="polite"
          className={
            status.frozen
              ? 'shrink-0 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-800'
              : 'shrink-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600'
          }
        >
          {status.text}
        </p>
      </div>

      <p className="mt-1 text-xs text-slate-500">
        Revision {save.revision} · {characters.toLocaleString('en-US')} of{' '}
        {MAX_SAVED_CHARS.toLocaleString('en-US')} characters
      </p>

      {/*
        NO maxLength. Truncating what somebody pasted would be a worse answer
        than refusing to save it and saying so.
      */}
      <textarea
        value={essay}
        onChange={(event) => onEssayChange(event.target.value)}
        disabled={status.frozen}
        spellCheck
        aria-label="Personal statement"
        placeholder="Write your personal statement here."
        className="mt-4 min-h-[28rem] w-full resize-y whitespace-pre-wrap rounded-xl border border-gray-300 bg-white px-4 py-4 text-sm leading-relaxed text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
      />

      {status.frozen && (
        <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Saving is paused. Your text is still here, but nothing is being written
          until this is resolved.
        </p>
      )}
    </main>
  )
}
