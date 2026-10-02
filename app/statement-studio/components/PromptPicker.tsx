'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SchoolOption } from '@/lib/statement/draft/schoolPicker'
import type { DraftPromptSnapshot } from '@/lib/statement/draft/rows'
import {
  PICKER_MESSAGES, confirmationApplies, directoryNotice, hasSavedPrompt, matchingSchools,
  mayApplyPrompts, needsPromptWrite, promptBadgeFor, promptListFrom, promptsPath,
  schoolLabel, wordLimitLabel,
} from '@/lib/statement/draft/picker'
import type { PendingPrompt, PromptChoice } from '@/lib/statement/draft/picker'

/**
 * Find your school, read its prompts, and attach one to your draft.
 *
 * THE ONE THING TO UNDERSTAND ABOUT THIS COMPONENT. There are two prompts on
 * screen and they are not the same kind of thing:
 *
 *   THE SAVED PROMPT is the draft's own four-column snapshot. It arrives as
 *   `saved`, it is rendered from the DRAFT and never from the catalog, and this
 *   component cannot change it -- there is no setter for it here and no
 *   callback that would reach one.
 *
 *   THE PREVIEW is a question the applicant is looking at. It lives in this
 *   component's own state, it never leaves, and it is labelled as not attached
 *   to the draft every single time it is shown.
 *
 * SO BROWSING STILL WRITES NOTHING. Reading a question dispatches no autosave
 * event, sends no request, consumes no revision and does not touch the essay,
 * the title or the saved snapshot.
 *
 * ATTACHING IS A SEPARATE, DELIBERATE ACT. `onUsePrompt` is the only way out of
 * this component, it carries one uuid, and it issues no request of its own --
 * the editor turns it into an ordinary edit and the existing autosave sends it
 * inside the existing PATCH. There is no persistence path here.
 *
 * AND THERE ARE THREE STATES, NOT TWO. A prompt on screen is SAVED (the
 * server's snapshot says so, and nothing newer is waiting), PENDING (chosen,
 * not yet confirmed) or PREVIEW (being read, attached to nothing).
 * promptBadgeFor() decides, and `pending` always wins over `saved` so a newer
 * choice can never look settled.
 *
 * WHY THE SAVED SNAPSHOT IS NOT LOOKED UP IN THE CATALOG. The draft stores its
 * own copy of the wording so that editing or withdrawing a catalog row can
 * never change the question an essay was written to answer. A saved prompt
 * therefore stays fully visible even when it is not in the fetched list -- and
 * its absence is not treated as evidence of anything, because the list may be
 * another school's, or may not have loaded.
 *
 * THE DIRECTORY IS NOT FETCHED HERE. `schools` is server-rendered behind the
 * Studio gate; this component makes exactly one kind of request, to the gated
 * prompts endpoint, and holds no Supabase client.
 */
export default function PromptPicker({
  schools,
  schoolsUnavailable,
  saved,
  pending,
  confirmFailedToken,
  onUsePrompt,
  onRetryPromptSave,
  savedShownByParent = false,
}: {
  schools: readonly SchoolOption[]
  schoolsUnavailable: boolean
  /** The draft's persisted snapshot. Read-only here, by construction. */
  saved: DraftPromptSnapshot
  /** What the applicant has chosen but the server has not confirmed. */
  pending: PendingPrompt | null
  /** The token of a selection whose confirmation failed, if any. */
  confirmFailedToken: number | null
  /**
   * Attach the previewed prompt to the draft. THE ID AND NOTHING ELSE: the
   * school, the wording and the word limit are the server's to resolve, so
   * there is nothing else this component could hand over even by accident.
   */
  onUsePrompt: (promptId: string) => void
  /** A deliberate re-attempt after a confirmation failure. */
  onRetryPromptSave: () => void
  /**
   * PRESENTATION ONLY: the parent is already showing the draft's saved prompt.
   *
   * The editor's reference panel renders the snapshot itself -- school name,
   * wording, word limit and provenance -- so this component's own copy of it
   * would be the same question twice on one screen. When this is set, the
   * heading, the lead sentence and the stored-prompt panel are omitted and what
   * remains is the part only this component has: the search, the list, the
   * preview and Use this prompt.
   *
   * IT CHANGES NOTHING ELSE. No state, no fetch, no selection rule and no
   * guard is conditional on it -- the confirmation warning in particular is
   * still rendered, because an unconfirmed save must stay visible wherever this
   * component appears.
   */
  savedShownByParent?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  /** Which school's prompts are being browsed. Not the draft's school. */
  const [browsing, setBrowsing] = useState<SchoolOption | null>(null)
  const [prompts, setPrompts] = useState<readonly PromptChoice[]>([])
  /** Which school the held list belongs to, so a stale list is never shown. */
  const [promptsFor, setPromptsFor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [promptsError, setPromptsError] = useState<string | null>(null)

  /** The previewed question. Local to this component, and never persisted. */
  const [preview, setPreview] = useState<PromptChoice | null>(null)

  /**
   * SYNCHRONOUS, because React state settles after the click that changed it:
   * by the time a reply is handled, `browsing` may not yet be the school the
   * applicant has already chosen. The guard has to read what is true NOW.
   */
  const browsingRef = useRef<string | null>(null)
  /** The in-flight request, so switching schools can abort the old one. */
  const inFlight = useRef<AbortController | null>(null)
  const alive = useRef(true)

  useEffect(
    () => () => {
      alive.current = false
      inFlight.current?.abort()
    },
    []
  )

  const browseSchool = useCallback(async (school: SchoolOption) => {
    // 1. Abort the previous request and retire its identity, synchronously, so
    //    a reply already on the wire cannot be applied below.
    inFlight.current?.abort()
    browsingRef.current = school.id

    // 2. The old list goes immediately. A previous school's prompts must never
    //    sit under a different school's name while this one loads.
    setBrowsing(school)
    setQuery('')
    setOpen(false)
    setPrompts([])
    setPromptsFor(null)
    setPreview(null)
    setPromptsError(null)
    setLoading(true)

    const controller = new AbortController()
    inFlight.current = controller

    try {
      const response = await fetch(promptsPath(school.id), {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      })
      const body = await response.json().catch(() => null)
      const outcome = promptListFrom({ status: response.status, body })

      // 3. THE STALE GUARD. Compared against the ref, not the state.
      if (!alive.current) return
      if (!mayApplyPrompts({ requestedFor: school.id, browsingNow: browsingRef.current })) return

      if (!outcome.ok) {
        setPromptsError(outcome.message)
        return
      }
      setPrompts(outcome.prompts)
      setPromptsFor(school.id)
    } catch {
      // An abort lands here too, and is not an error anybody should read: the
      // guard below is what distinguishes "superseded" from "failed".
      if (!alive.current) return
      if (!mayApplyPrompts({ requestedFor: school.id, browsingNow: browsingRef.current })) return
      setPromptsError(PICKER_MESSAGES.failed)
    } finally {
      if (alive.current && browsingRef.current === school.id) setLoading(false)
    }
  }, [])

  const matches = matchingSchools(schools, query)
  const notice = directoryNotice({
    unavailable: schoolsUnavailable,
    total: schools.length,
    matching: matches.length,
  })
  const showingList = promptsFor !== null && promptsFor === browsing?.id
  const savedVisible = hasSavedPrompt({ promptId: saved.promptId, promptText: saved.promptText })
  const previewBadge = preview === null
    ? 'preview'
    : promptBadgeFor({ promptId: preview.id, savedPromptId: saved.promptId, pending })
  const canUsePreview = preview !== null && needsPromptWrite({
    chosenId: preview.id,
    savedPromptId: saved.promptId,
    pending,
  })

  return (
    <section
      className={
        savedShownByParent
          ? 'mt-0'
          : 'mt-6 rounded-xl border border-gray-300 bg-white px-4 py-4'
      }
    >
      {!savedShownByParent && (
        <>
          <h2 className="text-sm font-semibold text-slate-900">Your school&rsquo;s prompt</h2>
          <p className="mt-1 text-xs text-slate-500">
            Find your programme to read its personal statement question. Browsing here does not
            change your draft.
          </p>
        </>
      )}

      {/* ---------------------------------------------- the draft's own prompt */}
      {/*
        THE CONFIRMATION WARNING. Shown only while the failure still describes
        what is pending -- a newer choice supersedes it, and so does a success
        or a reload. It is deliberately ABOVE the stored panel: the applicant
        needs to know their choice is unconfirmed before they read what the
        draft currently answers.
      */}
      {confirmationApplies({ failedToken: confirmFailedToken, pending }) ? (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-400 bg-amber-50 px-3 py-3"
        >
          <p className="text-sm text-amber-900">{PICKER_MESSAGES.confirmationFailed}</p>
          <button
            type="button"
            onClick={onRetryPromptSave}
            className="rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100"
          >
            {PICKER_MESSAGES.retryPromptSave}
          </button>
        </div>
      ) : null}

      {/* OMITTED WHEN THE PARENT SHOWS IT. The markup is unchanged and still
          rendered whenever this component is used on its own. */}
      {savedShownByParent ? null : savedVisible ? (
        <div className="mt-4 rounded-lg border border-blue-300 bg-blue-50 px-3 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-900">
            The prompt your draft answers
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
            {saved.promptText}
          </p>
          <p className="mt-2 text-xs text-blue-900">{wordLimitLabel(saved.statedMaxWords)}</p>
        </div>
      ) : (
        <p className="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-slate-600">
          This draft is not attached to a prompt. That is fine — a prompt is optional.
        </p>
      )}

      {/* ------------------------------------------------------- school search */}
      <div className="mt-4">
        <label htmlFor="statement-school-search" className="block text-xs font-medium text-slate-700">
          Search schools by name
        </label>
        <input
          id="statement-school-search"
          type="search"
          autoComplete="off"
          value={query}
          placeholder="Start typing a programme name"
          disabled={schoolsUnavailable}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-slate-400"
        />

        {notice === null ? null : (
          <p
            className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            role="status"
          >
            {notice}
          </p>
        )}

        {notice === null && open && query.trim().length > 0 ? (
          <ul className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-gray-200">
            {matches.map((school) => (
              <li key={school.id}>
                <button
                  type="button"
                  onClick={() => { void browseSchool(school) }}
                  className="block w-full px-3 py-2 text-left text-sm text-slate-800 transition hover:bg-blue-50 focus:bg-blue-50 focus:outline-none"
                >
                  {schoolLabel(school)}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* ------------------------------------------------------- prompt list */}
      {browsing === null ? null : (
        <div className="mt-4">
          <p className="text-xs font-medium text-slate-700">
            Prompts at <span className="font-semibold">{schoolLabel(browsing)}</span>
          </p>

          {loading ? (
            <p className="mt-2 text-xs text-slate-500" role="status">
              {PICKER_MESSAGES.loading}
            </p>
          ) : null}

          {!loading && promptsError !== null ? (
            <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2">
              <p className="text-xs text-red-900">{promptsError}</p>
              <button
                type="button"
                onClick={() => { void browseSchool(browsing) }}
                className="rounded-lg border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-900 transition hover:bg-red-100"
              >
                Try again
              </button>
            </div>
          ) : null}

          {!loading && promptsError === null && showingList && prompts.length === 0 ? (
            <p className="mt-2 text-xs text-slate-600" role="status">
              {PICKER_MESSAGES.noPrompts}
            </p>
          ) : null}

          {!loading && promptsError === null && showingList && prompts.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {prompts.map((choice) => {
                const badge = promptBadgeFor({
                  promptId: choice.id,
                  savedPromptId: saved.promptId,
                  pending,
                })
                return (
                  <li key={choice.id}>
                    <button
                      type="button"
                      aria-pressed={preview?.id === choice.id}
                      onClick={() => setPreview(choice)}
                      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left transition hover:border-blue-300 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <span className="text-sm font-medium text-slate-900">{choice.label}</span>
                      {choice.applicationCycle === null ? null : (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-slate-600">
                          {choice.applicationCycle}
                        </span>
                      )}
                      {badge === 'saved' ? (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-900">
                          Your draft&rsquo;s prompt
                        </span>
                      ) : null}
                      {badge === 'pending' ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                          Saving&hellip;
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      )}

      {/* ---------------------------------------------------------- preview */}
      {preview === null ? null : (
        <div className="mt-4 rounded-lg border border-gray-300 bg-gray-50 px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-900">{preview.label}</p>
            {preview.applicationCycle === null ? null : (
              <span className="rounded bg-white px-1.5 py-0.5 text-xs text-slate-600">
                {preview.applicationCycle}
              </span>
            )}
            {/*
              NEVER AMBIGUOUS, AND NOW THREE-WAY. `pending` beats `saved` in
              promptBadgeFor, so a choice that has not been confirmed can never
              read as attached -- however closely its id matches the stored one.
            */}
            {previewBadge === 'saved' ? (
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-900">
                Already your draft&rsquo;s prompt
              </span>
            ) : null}
            {previewBadge === 'pending' ? (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                Chosen — not yet saved
              </span>
            ) : null}
            {previewBadge === 'preview' ? (
              <span className="rounded bg-gray-200 px-1.5 py-0.5 text-xs font-medium text-slate-700">
                Preview — not attached to your draft
              </span>
            ) : null}
          </div>

          {/* Escaped React text, whitespace preserved. Never raw HTML. */}
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
            {preview.promptText}
          </p>
          <p className="mt-2 text-xs text-slate-600">{wordLimitLabel(preview.statedMaxWords)}</p>

          {/*
            ENABLED ONLY WHEN IT WOULD CHANGE SOMETHING. needsPromptWrite says no
            when the draft already answers this prompt and nothing is pending --
            a second identical save would consume a revision to record a change
            that is not one. It says YES whenever something IS pending for a
            different prompt, which is what lets an applicant reverse a choice
            that is still in the air.
          */}
          <button
            type="button"
            disabled={!canUsePreview}
            onClick={() => onUsePrompt(preview.id)}
            title={
              canUsePreview
                ? 'Attach this prompt to your draft.'
                : 'Your draft already answers this prompt.'
            }
            className="mt-3 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-slate-400"
          >
            Use this prompt
          </button>
        </div>
      )}
    </section>
  )
}
