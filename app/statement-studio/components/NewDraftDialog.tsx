'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MAX_TITLE_CHARS } from '@/lib/statement/draft/validate'
import {
  NETWORK_FAILURE,
  NEW_DRAFT_ENDPOINT,
  createOutcomeFrom,
} from '@/lib/statement/draft/library'
import {
  EMPTY_PASTE,
  NEW_DRAFT_MESSAGES,
  canCreateNow,
  canCreatePasteNow,
  createRequestFor,
  newPastedDraftRequest,
  type PastedPrompt,
  promptWasRefused,
  selectionAfterSchoolChange,
  stepBefore,
  stepBeforeTitle,
  stepForPath,
  type CreatePath,
  type NewDraftStep,
} from '@/lib/statement/draft/newDraft'
import { pasteOptionVisible, pasteSubmissionAllowed } from '@/lib/statement/draft/pastePreview'
import {
  PICKER_MESSAGES,
  directoryNotice,
  matchingSchools,
  mayApplyPrompts,
  promptListFrom,
  promptsPath,
  schoolLabel,
  wordLimitLabel,
  type PromptChoice,
} from '@/lib/statement/draft/picker'
import type { SchoolOption } from '@/lib/statement/draft/schoolPicker'
import {
  canCreateRequirementNow, requirementDraftRequest, requirementStepFrom, requirementsPath,
} from '@/lib/statement/requirements/newDraftFlow'
import { checklistView } from '@/lib/statement/requirements/checklistView'
import type { RequirementSet } from '@/lib/statement/requirements/requirement'
import RequirementChecklist from './RequirementChecklist'

/**
 * New draft: a path, then what that path needs, then the draft.
 *
 * THE ROW IS STILL CREATED BEFORE ANYTHING IS TYPED INTO IT. The alternative --
 * open an editor and create the row on the first keystroke -- means an applicant
 * can write a paragraph into something that does not exist yet, and every
 * failure after that point is a lost paragraph. One POST, before there is
 * anything to lose, and the editor opens on a draft that is already saved.
 *
 * ONE POST, NOT A CREATE-THEN-PATCH. A school-specific draft is born answering
 * its prompt: the id goes with the create, the server resolves the canonical
 * school, wording and limit, and the row exists correct from its first revision.
 * There is no moment at which the draft exists without the question it was
 * started for, and no second write to fail halfway.
 *
 * WIRING ONLY, as before. Which screen follows which, when Create may fire,
 * what is sent and what survives going backward all live in
 * lib/statement/draft/newDraft.ts, which is pure and unit-tested; the school
 * search, the prompt-list parsing and the stale-response guard live in
 * picker.ts, which the editor's own picker already uses. This component holds
 * the fields, the focus and the guard.
 *
 * NO maxLength ON THE INPUT, deliberately. It would stop typing at the limit and
 * silently shorten a pasted title, which is exactly what the rules say not to do.
 * A long title is REFUSED, visibly, with the count in front of the applicant.
 *
 * THE TITLE IS WRITTEN IN EXACTLY TWO PLACES -- the applicant's keystrokes, and
 * the reset when the dialog opens. Every other screen, every Back, every
 * refusal and the switch to a general statement all leave it alone, which is
 * what makes "go back and change your mind" cost no retyping. A test asserts
 * the set of writes, so a third one cannot appear unnoticed.
 */
export default function NewDraftDialog({
  open,
  onClose,
  schools,
  schoolsUnavailable,
  submissionsEnabled = false,
  pastePreview = false,
}: {
  open: boolean
  onClose: () => void
  schools: readonly SchoolOption[]
  schoolsUnavailable: boolean
  /**
   * Whether an applicant may paste a prompt the catalog does not have.
   *
   * DEFAULTS TO FALSE, and the default is what matters: until the submission
   * migrations are applied there is no table to write and no function to call,
   * so with this off the dialog offers exactly the two paths it offers today.
   */
  submissionsEnabled?: boolean
  /**
   * DEVELOPMENT-ONLY: draw the paste screens without wiring them up.
   *
   * SEPARATE FROM submissionsEnabled, AND THAT SEPARATION IS THE SAFETY. This
   * prop decides what is DRAWN; `submissionsEnabled` decides what may be SENT.
   * Nothing below reads this one when deciding whether to submit -- the guard
   * in submit() consults pasteSubmissionAllowed(), which has no parameter
   * through which a preview could reach it.
   *
   * The server grants it only under NODE_ENV === 'development', for an
   * administrator who has passed the Studio gate, with an explicit query
   * parameter. Defaults to false, so a page that does not pass it is unchanged.
   */
  pastePreview?: boolean
}) {
  const router = useRouter()
  const [step, setStep] = useState<NewDraftStep>('choice')
  const [path, setPath] = useState<CreatePath | null>(null)
  const [title, setTitle] = useState('')
  const [school, setSchool] = useState<SchoolOption | null>(null)
  const [prompt, setPrompt] = useState<PromptChoice | null>(null)
  /** What the applicant has typed on the paste screen. null means not pasting. */
  const [pasted, setPasted] = useState<PastedPrompt | null>(null)
  const [query, setQuery] = useState('')
  const [prompts, setPrompts] = useState<readonly PromptChoice[] | null>(null)
  /**
   * The school's published writing requirements, when the catalog has any.
   *
   * null MEANS "NOT APPLICABLE", which covers every reason: the rollout flag is
   * off, the migration is unapplied, the school has none researched, or the
   * read failed. All of them send the applicant to the prompt list, which is
   * the flow that ships today.
   */
  const [requirementSets, setRequirementSets] = useState<readonly RequirementSet[] | null>(null)
  /** The document chosen from the checklist. One id, never a snapshot. */
  const [requirementId, setRequirementId] = useState<string | null>(null)
  const [promptNotice, setPromptNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /** False only after a create that may have left a draft behind. */
  const [retryable, setRetryable] = useState(true)

  /**
   * THE DUPLICATE GUARD, and the reason it is a ref rather than the `submitting`
   * state. A state update is asynchronous, so two clicks in one tick would both
   * read `submitting === false` and both POST. This is set synchronously, before
   * the first await, so the second click returns immediately.
   */
  const inFlight = useRef(false)
  /**
   * WHICH SCHOOL IS BEING BROWSED, synchronously. State settles after the event
   * that changed it, so by the time a prompt list arrives `school` may not yet
   * be the school already clicked. This is what the stale guard compares.
   */
  const browsing = useRef<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const messageId = useId()

  // Focus moves in on open and back to whatever opened it on close, so a
  // keyboard never lands behind the dialog or loses its place after it. Opening
  // also clears the last attempt: a fresh dialog, not a stale refusal.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    setTitle('')
    setMessage(null)
    setRetryable(true)
    setSubmitting(false)
    setStep('choice')
    setPath(null)
    setSchool(null)
    setPrompt(null)
    setPasted(null)
    setQuery('')
    setPrompts(null)
    setPromptNotice(null)
    setLoading(false)
    setRequirementSets(null)
    setRequirementId(null)
    browsing.current = null
    inFlight.current = false
    const timer = setTimeout(() => panel.current?.focus(), 0)
    return () => {
      clearTimeout(timer)
      opener?.focus?.()
    }
  }, [open])

  // The title field takes focus when its screen arrives, from whichever
  // direction -- forward from a prompt, or back from a refusal.
  useEffect(() => {
    if (step === 'title') field.current?.focus()
  }, [step])

  /** The dialog does not close itself, and it cannot be closed mid-flight. */
  const dismiss = useCallback(() => {
    if (submitting) return
    onClose()
  }, [submitting, onClose])

  /** Tab stays inside the dialog: that is what makes it modal rather than a layer. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [dismiss]
  )

  /**
   * A school's active prompts.
   *
   * THE STALE GUARD IS WHY THIS READS A REF. Clicking through three schools
   * quickly puts three requests in the air and they may land in any order;
   * applying a late one would show one school's questions under another's name,
   * with nothing on screen to say so. A reply is applied only while the school
   * it was asked about is still the school being browsed, and a reply that is
   * not applied touches NOTHING -- not the list, not the notice, not the
   * spinner, all of which belong to the request that is still outstanding.
   */
  const chooseSchool = useCallback(async (option: SchoolOption) => {
    // A prompt belongs to the school it was chosen from, and cannot survive a
    // move to another. Re-clicking the school already open is not a move.
    setPrompt(selectionAfterSchoolChange({
      chosenId: option.id,
      browsingId: browsing.current,
      prompt,
    }))
    // A paste belongs to the school it was typed for, exactly as a chosen
    // prompt does. Switching schools drops it rather than submitting one
    // school's question under another's name.
    if (browsing.current !== option.id) setPasted(null)
    browsing.current = option.id
    setSchool(option)
    setRequirementSets(null)
    setRequirementId(null)
    setStep('prompt')
    setPrompts(null)
    setPromptNotice(PICKER_MESSAGES.loading)
    setLoading(true)

    // ---- does this school publish structured writing requirements? --------
    //
    // ASKED FIRST, AND FAILING SOFT. A 404 (the flag is off), a 500, a body
    // this build does not understand and a school with none researched all
    // return 'fallback', and the prompt list below runs exactly as it does
    // today. Nothing here can prevent the shipped flow from working.
    //
    // THE SAME STALENESS GUARD THE PROMPT LIST USES. An applicant who clicks
    // two schools quickly must not be shown the first one's requirements under
    // the second one's name, so the reply is dropped unless they are still
    // browsing the school it was requested for.
    try {
      const catalog = await fetch(requirementsPath(option.id))
      const catalogBody = await catalog.json().catch(() => null)
      if (!mayApplyPrompts({ requestedFor: option.id, browsingNow: browsing.current })) return

      const outcome = requirementStepFrom({
        status: catalog.status,
        body: catalogBody,
        schoolId: option.id,
        schoolName: option.name,
      })
      if (outcome.kind === 'ready') {
        setRequirementSets(outcome.sets)
        setPromptNotice(null)
        setLoading(false)
        setStep('requirement')
        return
      }
    } catch {
      // A thrown fetch is a fallback like any other. The prompt list follows.
      if (!mayApplyPrompts({ requestedFor: option.id, browsingNow: browsing.current })) return
    }

    try {
      const response = await fetch(promptsPath(option.id))
      const body = await response.json().catch(() => null)
      if (!mayApplyPrompts({ requestedFor: option.id, browsingNow: browsing.current })) return

      const outcome = promptListFrom({ status: response.status, body })
      setLoading(false)
      if (!outcome.ok) {
        setPrompts(null)
        setPromptNotice(outcome.message)
        return
      }
      setPrompts(outcome.prompts)
      setPromptNotice(outcome.prompts.length === 0 ? NEW_DRAFT_MESSAGES.noPrompts : null)
    } catch {
      if (!mayApplyPrompts({ requestedFor: option.id, browsingNow: browsing.current })) return
      setLoading(false)
      setPrompts(null)
      setPromptNotice(PICKER_MESSAGES.failed)
    }
  }, [prompt])

  /**
   * Start ONE of the school's writing documents.
   *
   * ONE ID, AND NOTHING ELSE IS REMEMBERED. The wording, the limits and the
   * provenance are not carried in state and are not sent: the server reads them
   * from the catalog when the draft is created. So this cannot create a draft
   * against a requirement the catalog does not currently publish, and a
   * tampered client holding a stale snapshot has nothing to submit.
   *
   * THE TITLE IS KEPT, like every other transition here. And no other document
   * is touched: starting the diversity essay creates one draft, not the
   * school's whole set.
   *
   * A PROMPT SELECTION IS DROPPED, because a draft is one or the other. The
   * server refuses a body carrying both; this is the browser-side half.
   */
  const startRequirement = useCallback((id: string) => {
    setRequirementId(id)
    setPrompt(null)
    setPasted(null)
    setPath('school')
    setMessage(null)
    setStep('title')
  }, [])

  /**
   * Leave the checklist for this school's older catalog prompts.
   *
   * KEPT REACHABLE DELIBERATELY. A school may have rows in statement_prompts
   * AND a published requirement set, and the prompt path is the shipped flow --
   * it must not become unreachable because a newer catalog answered first.
   */
  const showListedPrompts = useCallback(async () => {
    if (school === null) return
    setRequirementId(null)
    setStep('prompt')
    setPrompts(null)
    setPromptNotice(PICKER_MESSAGES.loading)
    setLoading(true)
    try {
      const response = await fetch(promptsPath(school.id))
      const body = await response.json().catch(() => null)
      if (!mayApplyPrompts({ requestedFor: school.id, browsingNow: browsing.current })) return
      const outcome = promptListFrom({ status: response.status, body })
      setLoading(false)
      if (!outcome.ok) {
        setPrompts(null)
        setPromptNotice(outcome.message)
        return
      }
      setPrompts(outcome.prompts)
      setPromptNotice(outcome.prompts.length === 0 ? NEW_DRAFT_MESSAGES.noPrompts : null)
    } catch {
      if (!mayApplyPrompts({ requestedFor: school.id, browsingNow: browsing.current })) return
      setLoading(false)
      setPrompts(null)
      setPromptNotice(PICKER_MESSAGES.failed)
    }
  }, [school])

  /**
   * Abandon the school and write a general statement. THE TITLE IS KEPT: an
   * applicant who already named their draft should not retype it because the
   * school they picked turned out to list no questions.
   */
  const startGeneral = useCallback(() => {
    setPath('general')
    setPrompt(null)
    setPasted(null)
    // A GENERAL STATEMENT ANSWERS NOTHING, so a requirement chosen a moment ago
    // must not survive into the create. Without this, an applicant who started
    // a document and then changed their mind would get a requirement-backed
    // draft labelled as a general one.
    setRequirementId(null)
    setStep('title')
  }, [])

  /** Open the paste form for the school being browsed. The title is untouched. */
  const startPaste = useCallback(() => {
    setPrompt(null)
    setPasted(EMPTY_PASTE)
    setStep('paste')
  }, [])

  const goBack = useCallback(() => {
    // THE TITLE SCREEN IS THE ONE THAT NEEDS MORE THAN THE PATH. Both kinds of
    // school draft carry path === 'school', so stepBefore() alone would send a
    // requirement-backed draft back to the prompt list -- the other catalog,
    // which the applicant never chose from.
    const before = step === 'title'
      ? stepBeforeTitle({ path, requirementId })
      : stepBefore(step, path)
    if (before === null) return
    if (before === 'choice') setPath(null)
    // LEAVING THE TITLE FOR THE CHECKLIST UNCHOOSES THE DOCUMENT, so the cards
    // all read Start again and the applicant can pick a different one. The
    // title survives, as it does on every other transition here.
    if (before === 'requirement') setRequirementId(null)
    setStep(before)
  }, [step, path, requirementId])

  const submit = useCallback(async () => {
    if (inFlight.current) return
    if (path === null) return

    // Built by the committed builders, never assembled here. The general path
    // sends two keys and the school path three; neither can behave like the
    // other, and a school path with no prompt is REFUSED rather than quietly
    // creating a blank general draft.
    // PREVIEW STOPS HERE, BEFORE ANYTHING IS BUILT OR SENT.
    //
    // The applicant's wording never reaches a request object, let alone a
    // fetch: this returns before the builder runs, before the duplicate guard
    // is taken, and before any network call. And it returns -- it does NOT fall
    // through to the general builder, because silently creating a blank draft
    // for somebody who pasted their school's question is the exact accident
    // this whole feature is shaped to avoid.
    //
    // KEYED ON THE ROLLOUT FLAG, NOT ON THE PREVIEW FLAG. pasteSubmissionAllowed
    // takes only `submissionsEnabled`, so even a preview forced on in a
    // deployed build could not open this path.
    if (pasted !== null && !pasteSubmissionAllowed({ submissionsEnabled })) {
      setMessage(NEW_DRAFT_MESSAGES.previewBlocked)
      return
    }

    // FOUR SHAPES, FOUR BUILDERS, IN A FIXED ORDER OF PRECEDENCE.
    //
    // A REQUIREMENT IS CHECKED FIRST, and it is the only branch that sends a
    // requirementId. It cannot be combined with a promptId -- the server
    // refuses a body carrying both -- so this returns its own request rather
    // than merging into the school builder.
    //
    // THE PASTE IS CHECKED BEFORE THE PROMPT, unchanged: a pasted prompt must
    // never travel the promptId branch, which means "the catalog vouches for
    // this", and nobody has reviewed that wording yet.
    if (requirementId !== null) {
      if (!canCreateRequirementNow({ title, requirementId, submitting })) {
        setMessage(NEW_DRAFT_MESSAGES.requirementTitleRequired)
        field.current?.focus()
        return
      }
      if (!retryable) return
      inFlight.current = true
      setSubmitting(true)
      setMessage(null)
      try {
        const response = await fetch(NEW_DRAFT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requirementDraftRequest(title, requirementId)),
        })
        const body = await response.json().catch(() => null)
        const outcome = createOutcomeFrom({ status: response.status, body })
        if (outcome.type === 'created') {
          // NEITHER THE GUARD NOR THE BUSY STATE IS RELEASED, exactly as the
          // other paths do it: router.push is a soft navigation and this
          // component stays mounted until the new route lands.
          router.push(outcome.path)
          return
        }
        setMessage(outcome.message)
        setRetryable(outcome.retryable)
      } catch {
        setMessage(NETWORK_FAILURE.message)
        setRetryable(NETWORK_FAILURE.retryable)
      }
      inFlight.current = false
      setSubmitting(false)
      return
    }

    const request = pasted !== null
      ? newPastedDraftRequest(title, school === null ? null : school.id, pasted)
      : createRequestFor({ path, title, promptId: prompt === null ? null : prompt.id })
    if (!request.ok) {
      setMessage(request.message)
      field.current?.focus()
      return
    }
    if (!retryable) return

    inFlight.current = true
    setSubmitting(true)
    setMessage(null)

    try {
      const response = await fetch(NEW_DRAFT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      })
      // A body that is not JSON is not a reason to throw; the mapper treats an
      // unreadable 2xx as the one refusal that must not be retried.
      const body = await response.json().catch(() => null)
      const outcome = createOutcomeFrom({ status: response.status, body })

      if (outcome.type === 'created') {
        // NEITHER THE GUARD NOR THE BUSY STATE IS RELEASED, and the dialog does
        // not close. router.push is a soft navigation: this component stays
        // mounted until the new route lands, and a dialog that became
        // interactive again in the meantime could create a second draft.
        router.push(outcome.path)
        return
      }

      // The title is left exactly as typed, so a deliberate retry costs no
      // retyping. Nothing retries on its own -- a create is not idempotent.
      setMessage(outcome.message)
      setRetryable(outcome.retryable)
      // A PROMPT WITHDRAWN BETWEEN CHOOSING AND CREATING. No draft was made --
      // the server refuses the whole request rather than making a general one --
      // so the selection is dropped and the list reopens. Nothing is created as
      // a consolation, and the title is untouched.
      if (promptWasRefused(outcome.message)) {
        setPrompt(null)
        setStep('prompt')
      }
    } catch {
      setMessage(NETWORK_FAILURE.message)
      setRetryable(NETWORK_FAILURE.retryable)
    }

    inFlight.current = false
    setSubmitting(false)
  }, [path, title, prompt, pasted, school, retryable, router, submissionsEnabled,
      requirementId, submitting])

  if (!open) return null

  const trimmed = title.trim().length
  /*
    THREE GATES, CHECKED IN THE SAME ORDER submit() USES ITS BUILDERS.
    A requirement-backed draft cannot be judged by canCreateNow: that function
    requires a promptId on the school path, and a requirement-backed draft has
    none by design -- its identity is requirement_id. Routing it through the
    same gate would leave Create permanently disabled.
  */
  const canSubmit = requirementId !== null
    ? canCreateRequirementNow({ title, requirementId, submitting })
    : pasted !== null
    ? canCreatePasteNow({
        title,
        schoolId: school === null ? null : school.id,
        pasted,
        submitting,
        retryable,
      })
    : canCreateNow({
        path,
        title,
        promptId: prompt === null ? null : prompt.id,
        submitting,
        retryable,
      })
  /** Whether the school being browsed listed any approved prompt. */
  const hasPrompts = prompts !== null && prompts.length > 0
  /** A pasted prompt is on screen but the backend that would store it is off. */
  const previewBlocked = pasted !== null && !pasteSubmissionAllowed({ submissionsEnabled })
  const pasteReady = canCreatePasteNow({
    title: 'placeholder',
    schoolId: school === null ? null : school.id,
    pasted,
    submitting,
    retryable,
  })
  const visible = matchingSchools(schools, query)
  const notice = directoryNotice({
    unavailable: schoolsUnavailable,
    total: schools.length,
    matching: visible.length,
  })
  const heading = step === 'choice' ? 'New draft'
    : step === 'school' ? NEW_DRAFT_MESSAGES.chooseSchool
    : step === 'requirement' ? NEW_DRAFT_MESSAGES.chooseRequirement
    : step === 'prompt' ? NEW_DRAFT_MESSAGES.choosePrompt
    : step === 'paste' ? NEW_DRAFT_MESSAGES.pasteHeading
    : NEW_DRAFT_MESSAGES.nameDraft

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto p-4 sm:p-6">
      <div aria-hidden="true" onClick={dismiss} className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm" />
      <div className="flex min-h-full items-start justify-center sm:items-center">
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="relative w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl focus:outline-none sm:p-7"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id={headingId} className="text-lg font-bold tracking-tight text-slate-900">
                {heading}
              </h2>
              {step === 'choice' && (
                <p className="mt-1 text-sm text-slate-500">
                  How would you like to start?
                </p>
              )}
              {step === 'prompt' && school !== null && (
                <p className="mt-1 truncate text-sm text-slate-500">{schoolLabel(school)}</p>
              )}
            </div>
            {(step === 'title'
              ? stepBeforeTitle({ path, requirementId })
              : stepBefore(step, path)) !== null && (
              <button
                type="button"
                onClick={goBack}
                disabled={submitting}
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
              >
                {NEW_DRAFT_MESSAGES.back}
              </button>
            )}
          </div>

          {/* ------------------------------------------------- choose a path */}
          {step === 'choice' && (
            <div className="mt-5 grid gap-3">
              <button
                type="button"
                onClick={() => { setPath('school'); setStep(stepForPath('school')) }}
                className="rounded-xl border border-slate-200 p-4 text-left transition hover:border-blue-400 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <span className="block text-sm font-bold text-slate-900">
                  {NEW_DRAFT_MESSAGES.schoolPath}
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-slate-600">
                  {NEW_DRAFT_MESSAGES.schoolPathBody}
                </span>
              </button>
              <button
                type="button"
                onClick={() => { setPath('general'); setStep(stepForPath('general')) }}
                className="rounded-xl border border-slate-200 p-4 text-left transition hover:border-blue-400 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <span className="block text-sm font-bold text-slate-900">
                  {NEW_DRAFT_MESSAGES.generalPath}
                </span>
                <span className="mt-1 block text-sm leading-relaxed text-slate-600">
                  {NEW_DRAFT_MESSAGES.generalPathBody}
                </span>
              </button>
            </div>
          )}

          {/* ----------------------------------------------- choose a school */}
          {step === 'school' && (
            <div className="mt-5">
              <label htmlFor={`${headingId}-school`} className="sr-only">
                Search schools by name
              </label>
              <input
                id={`${headingId}-school`}
                type="search"
                value={query}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search schools..."
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
              {notice !== null ? (
                <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
                  {notice}
                </p>
              ) : (
                <ul className="mt-3 max-h-72 overflow-y-auto">
                  {visible.map((option) => (
                    <li key={option.id}>
                      <button
                        type="button"
                        onClick={() => void chooseSchool(option)}
                        className="w-full rounded-lg px-3 py-2.5 text-left text-sm text-slate-800 transition hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        {schoolLabel(option)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {/* Available even while the directory is unreadable: a general
                  statement needs no school, so a failed list is not a dead end. */}
              <button
                type="button"
                onClick={startGeneral}
                className="mt-4 text-sm font-semibold text-blue-700 underline-offset-4 transition hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {NEW_DRAFT_MESSAGES.startGeneral}
              </button>
            </div>
          )}

          {/* ----------------------------------------------- choose a prompt */}
          {/* ----------------------------------- the school's writing documents */}
          {/*
            THE CHECKLIST, RENDERED BY THE SAME COMPONENT THE EDITOR'S LIBRARY
            PREVIEW USES. One implementation, so what the owner approved in the
            preview is literally what an applicant sees here.

            NO DRAFT EXISTS YET, so every card reads Start and `drafts` is
            empty: the dialog creates one document when Start is pressed and
            nothing before that. Continue appears on this school's cards only
            after a draft exists, which is a later visit.
          */}
          {step === 'requirement' && requirementSets !== null && (
            <div className="mt-5 grid gap-4">
              <p className="text-sm leading-relaxed text-slate-600">
                {NEW_DRAFT_MESSAGES.requirementBody}
              </p>
              {requirementSets.map((set) => (
                <RequirementChecklist
                  key={set.id}
                  view={checklistView({ set, drafts: [] })}
                  actions={{
                    onStart: startRequirement,
                    // UNREACHABLE FROM HERE: no card can be in the Continue
                    // state, because this screen is only shown while creating.
                    draftHref: () => '#',
                    busy: submitting,
                  }}
                />
              ))}

              {/*
                THE OLDER CATALOG STAYS REACHABLE. A school may have rows in
                both, and the prompt path is the shipped flow -- it must not
                become unreachable because a newer catalog answered first.
              */}
              <button
                type="button"
                onClick={() => void showListedPrompts()}
                className="justify-self-start text-sm font-semibold text-blue-700 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {NEW_DRAFT_MESSAGES.otherPrompts}
              </button>
              <button
                type="button"
                onClick={startGeneral}
                className="justify-self-start text-sm font-semibold text-slate-600 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                {NEW_DRAFT_MESSAGES.startGeneral}
              </button>
            </div>
          )}

          {step === 'prompt' && (
            <div className="mt-5">
              {promptNotice !== null && (
                <p
                  aria-live="polite"
                  className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600"
                >
                  {promptNotice}
                </p>
              )}
              {prompts !== null && prompts.length > 0 && (
                <ul className="grid max-h-80 gap-2.5 overflow-y-auto">
                  {prompts.map((choice) => (
                    <li key={choice.id}>
                      <button
                        type="button"
                        onClick={() => { setPasted(null); setPrompt(choice); setStep('title') }}
                        className="w-full rounded-xl border border-slate-200 p-4 text-left transition hover:border-blue-400 hover:bg-blue-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <span className="block text-sm font-bold text-slate-900">{choice.label}</span>
                        {/* The school's exact words, rendered as escaped text. */}
                        <span className="mt-1.5 block text-sm leading-relaxed text-slate-700">
                          {choice.promptText}
                        </span>
                        <span className="mt-2 block text-xs text-slate-500">
                          {wordLimitLabel(choice.statedMaxWords)}
                          {choice.applicationCycle === null
                            ? ''
                            : ` Cycle ${choice.applicationCycle}.`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {/* OFFERED WHETHER OR NOT THE SCHOOL HAS PROMPTS. A catalog that
                  lists two questions may still be missing this year's, so the
                  paste option is not an empty-state fallback -- it sits under
                  the list as a peer of it. */}
              {/* THE WEIGHT FOLLOWS THE SITUATION. With prompts listed, the list
                  is the next step and this is an understated alternative under
                  it. With nothing listed, pasting IS the next step, so it
                  looks like one -- and "start a general statement" stays below
                  it as the secondary way out. */}
              {!loading && pasteOptionVisible({ submissionsEnabled, pastePreview }) && (
                hasPrompts ? (
                  <button
                    type="button"
                    onClick={startPaste}
                    className="mt-4 block text-sm font-semibold text-blue-700 underline-offset-4 transition hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    {NEW_DRAFT_MESSAGES.pastePrompt}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={startPaste}
                    className="mt-4 w-full rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                  >
                    {NEW_DRAFT_MESSAGES.pasteHeading}
                  </button>
                )
              )}
              {/* And the general path stays reachable from here, so a school
                  with nothing listed is never a dead end. */}
              {!loading && (prompts === null || prompts.length === 0) && (
                <button
                  type="button"
                  onClick={startGeneral}
                  className="mt-3 block w-full text-center text-sm font-semibold text-slate-600 underline-offset-4 transition hover:text-slate-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {NEW_DRAFT_MESSAGES.startGeneral}
                </button>
              )}
            </div>
          )}

          {/* --------------------------------------------- paste your own */}
          {step === 'paste' && pasted !== null && (
            <div className="mt-5">
              {school !== null && (
                <p className="mb-3 truncate text-sm font-medium text-slate-600">
                  {schoolLabel(school)}
                </p>
              )}

              <label htmlFor={`${headingId}-paste`} className="mb-2 block text-sm font-medium text-slate-700">
                School prompt <span className="text-rose-600">*</span>
              </label>
              {/* A plain textarea rendering escaped React text. Nothing typed
                  here is ever interpreted as markup, here or in review. */}
              <textarea
                id={`${headingId}-paste`}
                rows={5}
                value={pasted.promptText}
                disabled={submitting}
                onChange={(event) => setPasted({ ...pasted, promptText: event.target.value })}
                placeholder="Paste the question exactly as your school wrote it"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"
              />

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${headingId}-words`} className="mb-1.5 block text-xs font-medium text-slate-600">
                    Word limit <span className="text-slate-400">(optional)</span>
                  </label>
                  {/* A BLANK FIELD STAYS NULL. Number('') is 0, and recording
                      that would claim a school allows zero words. */}
                  <input
                    id={`${headingId}-words`}
                    type="number"
                    min={1}
                    max={5000}
                    value={pasted.statedMaxWords === null ? '' : pasted.statedMaxWords}
                    disabled={submitting}
                    onChange={(event) => setPasted({
                      ...pasted,
                      statedMaxWords: event.target.value.trim() === ''
                        ? null
                        : Number(event.target.value),
                    })}
                    placeholder="Not stated"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  />
                </div>
                <div>
                  <label htmlFor={`${headingId}-cycle`} className="mb-1.5 block text-xs font-medium text-slate-600">
                    Application cycle <span className="text-slate-400">(optional)</span>
                  </label>
                  <input
                    id={`${headingId}-cycle`}
                    type="text"
                    value={pasted.applicationCycle ?? ''}
                    disabled={submitting}
                    onChange={(event) => setPasted({
                      ...pasted,
                      applicationCycle: event.target.value.trim() === '' ? null : event.target.value,
                    })}
                    placeholder="2026 or 2026-2027"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  />
                </div>
              </div>

              <label htmlFor={`${headingId}-source`} className="mb-1.5 mt-3 block text-xs font-medium text-slate-600">
                Source URL <span className="text-slate-400">(optional)</span>
              </label>
              <input
                id={`${headingId}-source`}
                type="url"
                value={pasted.sourceUrl ?? ''}
                disabled={submitting}
                onChange={(event) => setPasted({
                  ...pasted,
                  sourceUrl: event.target.value.trim() === '' ? null : event.target.value,
                })}
                placeholder="https://"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />

              {/* THE NOTICE COMES BEFORE THE AGREEMENT, and says both halves:
                  the wording may be published, the writing never is. */}
              <p className="mt-5 rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-3 text-xs leading-relaxed text-slate-700">
                {NEW_DRAFT_MESSAGES.pasteNotice}
              </p>
              <label className="mt-3 flex items-start gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={pasted.confirmed}
                  disabled={submitting}
                  onChange={(event) => setPasted({ ...pasted, confirmed: event.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span>{NEW_DRAFT_MESSAGES.pasteConfirm}</span>
              </label>

              <button
                type="button"
                disabled={!pasteReady}
                onClick={() => setStep('title')}
                className="mt-5 w-full rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Continue
              </button>
            </div>
          )}

          {/* ------------------------------------------------- name and create */}
          {step === 'title' && (
            <form
              className="mt-5"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              {/*
                WHICH DOCUMENT IS BEING NAMED. An applicant who pressed Start on
                the diversity essay must see that on the title screen, or three
                visits to this dialog look identical and they cannot tell which
                one they are about to create.

                THE LABEL COMES FROM THE SET IN STATE, not from a snapshot held
                for submission: nothing on this screen is sent, and the server
                re-reads the requirement from the catalog when it creates.
              */}
              {requirementId !== null && school !== null && (
                <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                    {schoolLabel(school)}
                  </p>
                  {(() => {
                    const chosen = (requirementSets ?? [])
                      .flatMap((set) => set.requirements)
                      .find((candidate) => candidate.id === requirementId)
                    if (chosen === undefined) return null
                    return (
                      <>
                        <p className="mt-1 text-sm font-bold text-slate-900">{chosen.label}</p>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                          {chosen.promptText}
                        </p>
                        {/*
                          THE QUESTIONS STAY TOGETHER, in the one document, so
                          an applicant naming a multipart essay can see it is
                          one essay and not four.
                        */}
                        {chosen.components.length > 0 && (
                          <ol className="mt-2 grid gap-1">
                            {chosen.components.map((part, index) => (
                              <li key={part.id} className="flex gap-2 text-xs leading-relaxed text-slate-600">
                                <span className="font-semibold text-slate-400">{index + 1}.</span>
                                <span>
                                  {part.optional && (
                                    <span className="mr-1 font-semibold uppercase tracking-wide">
                                      Optional —{' '}
                                    </span>
                                  )}
                                  {part.text}
                                </span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </>
                    )
                  })()}
                </div>
              )}

              {/* A PASTED PROMPT IS LABELLED WHEREVER IT IS SHOWN, and the
                  label says what is true: nobody has checked this yet. */}
              {pasted !== null && school !== null && (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-800">
                    {schoolLabel(school)}
                  </p>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                    {pasted.promptText}
                  </p>
                  <p className="mt-2 text-xs font-medium text-amber-800">
                    {NEW_DRAFT_MESSAGES.unverifiedBadge}
                  </p>
                </div>
              )}
              {prompt !== null && school !== null && (
                <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                    {schoolLabel(school)}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-800">
                    {prompt.promptText}
                  </p>
                  <p className="mt-2 text-xs text-slate-600">
                    {wordLimitLabel(prompt.statedMaxWords)}
                    {prompt.applicationCycle === null ? '' : ` Cycle ${prompt.applicationCycle}.`}
                  </p>
                </div>
              )}

              <label htmlFor={`${headingId}-title`} className="mb-2 block text-sm font-medium text-slate-700">
                Title
              </label>
              <input
                ref={field}
                id={`${headingId}-title`}
                type="text"
                value={title}
                autoComplete="off"
                disabled={submitting}
                aria-invalid={message !== null}
                aria-describedby={message === null ? undefined : messageId}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Why I want to become a CRNA"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"
              />

              <p className="mt-1.5 text-xs text-slate-500">
                {trimmed > MAX_TITLE_CHARS
                  ? `${trimmed} characters. Use ${MAX_TITLE_CHARS} or fewer.`
                  : `${trimmed}/${MAX_TITLE_CHARS}`}
              </p>

              {message !== null && (
                <p
                  id={messageId}
                  role="alert"
                  className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3.5 py-2.5 text-sm text-red-800"
                >
                  {message}
                </p>
              )}

              {previewBlocked && (
                <p className="mt-4 rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-700">
                  {NEW_DRAFT_MESSAGES.previewExplainer}
                </p>
              )}

              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={dismiss}
                  disabled={submitting}
                  className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit || previewBlocked}
                  title={previewBlocked ? NEW_DRAFT_MESSAGES.previewBlocked : undefined}
                  className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {previewBlocked
                    ? 'Submission unavailable in preview'
                    : submitting ? 'Creating…' : 'Create draft'}
                </button>
              </div>
            </form>
          )}

          {step !== 'title' && (
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={dismiss}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
