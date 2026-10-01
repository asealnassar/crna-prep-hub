'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  hasUnsavedWork,
  initialState,
  reduce,
  type AutosaveState,
} from '@/lib/resume/draft/autosave'
import { MAX_SAVED_CHARS } from '@/lib/statement/extract/limits'
import { MAX_TITLE_CHARS } from '@/lib/statement/draft/validate'
import type { DraftPromptSnapshot, StatementDraft } from '@/lib/statement/draft/rows'
import type { SchoolOption } from '@/lib/statement/draft/schoolPicker'
import { SAVE_MESSAGES, saveEventFrom } from '@/lib/statement/draft/save'
import {
  ACCEPT_ATTRIBUTE,
  EXTRACT_ENDPOINT,
  EXTRACT_FIELD,
  IMPORT_MESSAGES,
  checkUploadFile,
  importNoticeFor,
  importOutcomeFrom,
  mayApplyImport,
  type ImportNotice,
} from '@/lib/statement/draft/upload'
import {
  COPY_MESSAGES,
  NAV_MESSAGES,
  RELOAD_MESSAGES,
  canRetrySave,
  draftApiPath,
  reloadOutcomeFrom,
  saveAttemptFor,
  settleVerdict,
  statementDriverAction,
  statementSaveRequest,
  statementStatus,
  titleAfterSave,
  type SaveSnapshot,
} from '@/lib/statement/draft/editor'

const LIBRARY = '/statement-studio'

/**
 * The statement editor: autosave, conflict recovery, and leaving safely.
 *
 * THE ENGINE IS lib/resume/draft/autosave.ts, USED IN PLACE. Imported, never
 * copied or forked. Every recovery action here is one of its PUBLIC events --
 * `retry` for a deliberate Try again, `reloaded` for an explicit reload, `flush`
 * for a hiding tab and for leaving the page -- so none of this required the
 * engine to change. It decides when to save and when a retry is allowed; this
 * owns the clock, the payload and the requests.
 *
 * NOTHING IS RESOLVED AUTOMATICALLY. A conflict means somebody else's work is
 * newer, and the only correct answer is to ask. The applicant's text stays on
 * screen and selectable until they choose Reload, and no merge is attempted.
 *
 * THE TITLE IS EDITABLE, AND RECONCILED AGAINST WHAT WAS ACTUALLY PERSISTED.
 * checkTitle trims, so "My Statement " is stored as "My Statement" -- and an
 * indicator reading Saved over a field that still shows the trailing space would
 * be a lie. Each save carries a snapshot of the title as it looked when the
 * request left; on success, the field is corrected to the persisted string ONLY
 * if nobody has typed since. If they have, their newer text stands and the next
 * autosave carries it. See titleAfterSave() for the reasoning.
 *
 * IMPORTING A DOCUMENT IS JUST AN EDIT. The upload control sends one file to
 * the committed extraction endpoint, which parses nothing in the browser, and on
 * a valid reply it sets the essay and dispatches the same `edited` event typing
 * does. There is NO second persistence path: the driver decides whether the
 * result is saveable and when to save it, which is why a 27,000-character import
 * simply sits there, complete and visibly unsaved, issuing no requests at all.
 * An import never touches the title.
 *
 * THE PROMPT SNAPSHOT IS CARRIED, NOT CHOSEN. The four fields the server read
 * arrive on the draft, are held in one piece of state, and are replaced wholesale
 * by a successful reload -- which is what stops a conflict recovery keeping the
 * losing revision's prompt beside the winning revision's essay. Nothing here
 * chooses a prompt: there is no picker, no catalog request, and no save sends
 * one. An ordinary autosave still sends exactly title, essay and
 * expectedRevision.
 *
 * Still deferred: analysis, the school/prompt PICKER and its catalog request,
 * version history, delete, drag-and-drop, upload history.
 */
/**
 * WHAT THE SERVER HANDS THIS EDITOR.
 *
 * `schools` and `schoolsUnavailable` ARRIVE BUT ARE NOT YET READ. The picker
 * that will render them is the next checkpoint; they are accepted now so the
 * server read, its sanitisation and its failure state are settled and tested
 * before any control exists. Nothing is invented to consume them -- no hidden
 * element, no attribute, no log line.
 *
 * THE TWO ARE SEPARATE ON PURPOSE. `schools: []` with `schoolsUnavailable:
 * false` means the directory is genuinely empty; the same array with the flag
 * TRUE means it could not be read. A picker must say different things about
 * those, and merging them would let a dropped connection read as "your
 * programme is not supported".
 *
 * NOTHING IS FETCHED HERE. This component makes no Supabase call of any kind --
 * the draft and the school list both arrive as props, read on the server behind
 * the Studio gate -- and it does not call the prompt catalog endpoint yet.
 */
export default function StatementStudioClient({
  draft,
  schools,
  schoolsUnavailable,
}: {
  draft: StatementDraft
  schools: readonly SchoolOption[]
  schoolsUnavailable: boolean
}) {
  const router = useRouter()

  /** Read-only, but stateful: a reload may bring a title changed elsewhere. */
  const [title, setTitle] = useState(draft.title)
  const [essay, setEssay] = useState(draft.essay)
  /**
   * WHICH PROMPT THIS DRAFT ANSWERS, as the server read it. Stateful for one
   * reason only at this checkpoint: a conflict reload must be able to replace it.
   *
   * NOTHING IN THE UI SETS IT AND NOTHING YET READS IT. There is no picker, no
   * catalog fetch, and no save sends it -- the four values arrive on the
   * server-rendered draft, are held here, and are replaced wholesale by a
   * successful reload. They are NOT derived from anything: not from the essay,
   * not from a school list, not from a previous selection. The picker
   * checkpoint is what will finally read them; until then this state exists so
   * that a conflict reload has somewhere correct to put the server's prompt.
   *
   * ONE PIECE OF STATE, NOT FOUR, because the four are one fact. A generic draft
   * is all-null together and a chosen prompt is all-present together, so storing
   * them separately would make a half-replaced snapshot representable.
   */
  const [prompt, setPrompt] = useState<DraftPromptSnapshot>(() => ({
    schoolId: draft.schoolId,
    promptId: draft.promptId,
    promptText: draft.promptText,
    statedMaxWords: draft.statedMaxWords,
  }))
  /** THE INITIAL REVISION IS THE SERVER'S. Never a literal 1. */
  const [save, setSave] = useState<AutosaveState>(() => initialState(draft.revision))
  const [blocked, setBlocked] = useState<string | null>(null)
  /** Bumped by the wait timer, so the effect re-asks the engine at the due time. */
  const [tick, setTick] = useState(0)
  /** A recovery or navigation notice. Never anything the server wrote. */
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  const [reloading, setReloading] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  /**
   * SINGLE FLIGHT, taken synchronously. nextAction() already returns 'idle'
   * while a save is in flight, but the reducer that sets 'saving' is an async
   * state update; this closes the window between deciding and reflecting it.
   */
  const inFlight = useRef(false)
  const reloadInFlight = useRef(false)
  /**
   * The snapshot belonging to the request currently in flight, and the thing a
   * late continuation checks itself against. Identity is the test: a reload sets
   * this to null, so an older response cannot reconcile a title over a freshly
   * loaded draft even if it arrives afterwards.
   */
  const snapshotRef = useRef<SaveSnapshot | null>(null)
  /** Set to false on unmount, so no late response writes to a dead component. */
  const alive = useRef(true)
  /**
   * The live autosave state, for listeners that are registered ONCE. Without
   * this, beforeunload and visibilitychange would have to be torn down and
   * re-registered on every keystroke.
   */
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  /**
   * The live essay, for the extraction continuation to compare against.
   *
   * WHY A REF AND NOT A STATE UPDATER. Deciding "has the essay changed since the
   * upload began?" inside setEssay's functional form would read the answer after
   * the updater ran, which is after the decision has to be made -- and React may
   * run an updater more than once. This is written synchronously on every
   * keystroke, so the comparison is always against what is on screen now.
   */
  const essayRef = useRef(essay)
  useEffect(() => {
    essayRef.current = essay
  }, [essay])

  /** Identity of the extraction in flight. One at a time, and no other may apply. */
  const uploadRef = useRef<object | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // --- waiting for a save to settle ---------------------------------------

  const settleWaiters = useRef<Array<(saved: boolean) => void>>([])

  /**
   * Resolves waiters by OBSERVING TRANSITIONS, which is the whole point.
   * Reading the state synchronously after dispatching a flush would report the
   * status from before it and wave the applicant off the page with unsaved work
   * -- the bug the Resume studio's whenSettled() documents.
   */
  useEffect(() => {
    if (settleWaiters.current.length === 0) return
    const verdict = settleVerdict(save)
    if (verdict === null) return
    const waiting = settleWaiters.current
    settleWaiters.current = []
    for (const resolve of waiting) resolve(verdict)
  }, [save])

  const whenSettled = useCallback(
    () => new Promise<boolean>((resolve) => { settleWaiters.current.push(resolve) }),
    []
  )

  /** Unmount: nothing may resolve into a component that is gone. */
  useEffect(
    () => () => {
      alive.current = false
      snapshotRef.current = null
      uploadRef.current = null
      const waiting = settleWaiters.current
      settleWaiters.current = []
      for (const resolve of waiting) resolve(false)
    },
    []
  )

  // --- saving --------------------------------------------------------------

  const startSave = useCallback(
    async (revision: number, rawTitle: string, rawEssay: string) => {
      if (inFlight.current) return

      // The snapshot is taken HERE, from the values this save is about, and is
      // never recomputed from React state afterwards.
      const attempt = saveAttemptFor({ title: rawTitle, essay: rawEssay, revision })
      if (!attempt.ok) return
      const snapshot = attempt.snapshot

      snapshotRef.current = snapshot
      inFlight.current = true
      setSave((state) => reduce(state, { type: 'save-started', at: Date.now() }))

      try {
        const response = await fetch(draftApiPath(draft.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt.body),
        })
        const body = await response.json().catch(() => null)
        // THE ONE MAPPING. saveEventFrom decides success, conflict, and whether
        // a failure is retryable; none of that is repeated here.
        const event = saveEventFrom({ status: response.status, body, at: Date.now() })
        if (!alive.current) return

        // RECONCILE ONLY ON SUCCESS, AND ONLY FOR THIS SNAPSHOT. A conflict or a
        // failure persisted nothing, so there is nothing to reconcile to; and a
        // snapshot that has been retired -- by a reload, or by a later save --
        // is no longer about the document on screen.
        if (event.type === 'save-succeeded' && snapshotRef.current === snapshot) {
          // The functional form reads the LIVE title at commit time, which is
          // what makes "has anyone typed since?" answerable at all.
          setTitle((current) => titleAfterSave({ snapshot, currentTitle: current }) ?? current)
        }
        setSave((state) => reduce(state, event))
      } catch {
        // The request never arrived, so the write did not happen and trying
        // again is safe. An existing message is reused rather than a new one
        // invented, because statementStatus renders only strings already chosen.
        setSave((state) =>
          reduce(state, {
            type: 'save-failed',
            at: Date.now(),
            reason: SAVE_MESSAGES.server,
            retryable: true,
          })
        )
      } finally {
        // This request is over either way; its snapshot must not outlive it.
        if (snapshotRef.current === snapshot) snapshotRef.current = null
        inFlight.current = false
      }
    },
    [draft.id]
  )

  useEffect(() => {
    const action = statementDriverAction({ state: save, now: Date.now(), title, essay })

    if (action.kind === 'blocked') {
      // No request and NO TIMER. The work stays on screen, visibly unsaved.
      setBlocked(action.message)
      return
    }
    setBlocked(null)

    if (action.kind === 'idle') return
    if (action.kind === 'wait') {
      const timer = setTimeout(() => setTick((n) => n + 1), action.afterMs)
      return () => clearTimeout(timer)
    }

    void startSave(save.revision, title, essay)
  }, [save, title, essay, tick, startSave])

  /**
   * A title edit is an edit. Same engine event, same dirty window, same
   * debounce, same navigation guard -- there is no title-specific save path and
   * no second endpoint.
   */
  const onTitleChange = useCallback((value: string) => {
    setTitle(value)
    setNotice(null)
    setSave((state) => reduce(state, { type: 'edited', at: Date.now() }))
  }, [])

  const onEssayChange = useCallback((value: string) => {
    setEssay(value)
    // Synchronously, so an extraction reply arriving in this same tick sees it.
    essayRef.current = value
    setNotice(null)
    setCopied('idle')
    setImportNotice(null)
    // Dispatched on EVERY edit, including during a save. The engine restarts the
    // dirty window while a request is in flight, so a success landing after this
    // reports 'dirty' rather than 'saved'.
    setSave((state) => reduce(state, { type: 'edited', at: Date.now() }))
  }, [])

  // --- leaving the tab -----------------------------------------------------

  /**
   * Registered ONCE and reading the ref, so typing does not churn listeners.
   * `hasUnsavedWork` is the shared engine's own definition -- there is no second
   * idea of "dirty" anywhere in this file.
   */
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork(saveRef.current)) return
      event.preventDefault()
      // Still required by some browsers to raise the dialog.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  /**
   * A hiding tab may never come back, so stop waiting out the debounce. This
   * dispatches and nothing more: the engine decides whether a flush means
   * anything (it refuses one during a conflict or an in-flight save), and the
   * driver effect is what actually issues the request.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return
      if (!hasUnsavedWork(saveRef.current)) return
      setSave((state) => reduce(state, { type: 'flush', at: Date.now() }))
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // --- importing a document ------------------------------------------------

  /**
   * One file to the committed extraction endpoint, and nothing else.
   *
   * NOTHING IS TOUCHED UNTIL A VALID REPLY IS IN HAND. Choosing a file, starting
   * the request and every failure path leave the essay exactly as it is -- there
   * is no clearing, no placeholder, no partial application.
   *
   * THE INPUT IS ALWAYS RESET, so the same file can be chosen again deliberately
   * after either outcome. Nothing retries by itself, and the bytes are never
   * kept in state.
   */
  const onFileChosen = useCallback(
    async (chosen: FileList | null) => {
      const clearInput = () => {
        if (fileInput.current) fileInput.current.value = ''
      }

      // A conflict is unresolved work. Replacing the preserved essay with an
      // import would destroy the very thing Copy my version exists to rescue.
      if (saveRef.current.status === 'conflict') {
        setImportError(IMPORT_MESSAGES.conflicted)
        clearInput()
        return
      }
      // One extraction at a time.
      if (uploadRef.current !== null) {
        clearInput()
        return
      }
      if (chosen === null || chosen.length === 0) {
        clearInput()
        return
      }
      if (chosen.length > 1) {
        setImportError(IMPORT_MESSAGES.oneFile)
        clearInput()
        return
      }

      const file = chosen[0]
      // Name and size only: the document is never read in the browser.
      const precheck = checkUploadFile({ name: file.name, size: file.size })
      if (!precheck.ok) {
        setImportError(precheck.message)
        clearInput()
        return
      }

      const token = {}
      uploadRef.current = token
      // The essay as it stands now. The reply applies only if it still is this.
      const essayAtStart = essayRef.current
      setImporting(true)
      setImportError(null)
      setImportNotice(null)
      setNotice(null)

      try {
        const form = new FormData()
        form.append(EXTRACT_FIELD, file)
        const response = await fetch(EXTRACT_ENDPOINT, { method: 'POST', body: form })
        const body = await response.json().catch(() => null)
        const outcome = importOutcomeFrom({ status: response.status, body })
        if (!alive.current || uploadRef.current !== token) return

        if (!outcome.ok) {
          setImportError(outcome.message)
          return
        }
        // Newer typing wins. The extracted text is discarded, not queued.
        if (!mayApplyImport({ essayAtStart, currentEssay: essayRef.current })) {
          setImportError(IMPORT_MESSAGES.stale)
          return
        }

        // THE WHOLE extracted string. Nothing is cut, whatever its length.
        setEssay(outcome.document.text)
        essayRef.current = outcome.document.text
        setImportNotice(importNoticeFor(outcome.document))
        // The SAME event typing dispatches. The driver decides the rest: a
        // document over the save ceiling simply blocks, with no request and no
        // timer, until the applicant trims it.
        setSave((state) => reduce(state, { type: 'edited', at: Date.now() }))
      } catch {
        if (alive.current && uploadRef.current === token) {
          setImportError(IMPORT_MESSAGES.network)
        }
      } finally {
        if (uploadRef.current === token) uploadRef.current = null
        if (alive.current) setImporting(false)
        clearInput()
      }
    },
    []
  )

  // --- recovery ------------------------------------------------------------

  /**
   * The applicant's own text, to the clipboard. The essay ALONE -- no title, no
   * revision, no status. Nothing is dispatched, nothing is sent anywhere, the
   * draft is not touched and the conflict is not cleared.
   */
  const copyMine = useCallback(async () => {
    try {
      const clipboard = navigator.clipboard
      if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('unavailable')
      await clipboard.writeText(essay)
      if (alive.current) setCopied('done')
    } catch {
      // The editor stays readOnly rather than disabled, so the text is still
      // selectable and a manual copy still works.
      if (alive.current) setCopied('failed')
    }
  }, [essay])

  /**
   * THE ONLY conflict resolution in this checkpoint, and only when asked for.
   *
   * It fetches the document rather than trusting `storedRevision`: that number
   * says which revision won, not what it says, and adopting it without the text
   * would leave the editor claiming a revision whose content it has never seen.
   *
   * A failure changes nothing at all -- the conflict stands, saving stays
   * frozen, and the local essay is untouched -- so the applicant can copy their
   * version and try the reload again.
   */
  const reloadLatest = useCallback(async () => {
    if (reloadInFlight.current) return
    reloadInFlight.current = true
    setNotice(null)
    setReloading(true)
    try {
      const response = await fetch(draftApiPath(draft.id), { method: 'GET', cache: 'no-store' })
      const body = await response.json().catch(() => null)
      const outcome = reloadOutcomeFrom({
        status: response.status,
        body,
        expectedId: draft.id,
      })
      if (!alive.current) return
      if (!outcome.ok) {
        setNotice(outcome.message)
        return
      }
      // Only now is the local version replaced. The snapshot is retired first,
      // so a save response still in the air cannot reconcile its title over the
      // draft that was just loaded.
      snapshotRef.current = null
      uploadRef.current = null
      setTitle(outcome.draft.title)
      setEssay(outcome.draft.essay)
      essayRef.current = outcome.draft.essay
      // REPLACED WHOLESALE, in the same step as the essay and the revision.
      // Not merged, not kept when the server's is null: whatever the losing
      // revision held locally is gone, because the draft on screen is now the
      // server's draft and its prompt is the server's prompt.
      setPrompt({
        schoolId: outcome.draft.schoolId,
        promptId: outcome.draft.promptId,
        promptText: outcome.draft.promptText,
        statedMaxWords: outcome.draft.statedMaxWords,
      })
      setCopied('idle')
      setImportNotice(null)
      setImportError(null)
      // `reloaded` returns the engine to a clean state at the SERVER's revision.
      setSave((state) =>
        reduce(state, { type: 'reloaded', at: Date.now(), revision: outcome.draft.revision })
      )
    } catch {
      if (alive.current) setNotice(RELOAD_MESSAGES.server)
    } finally {
      reloadInFlight.current = false
      if (alive.current) setReloading(false)
    }
  }, [draft.id])

  /**
   * A deliberate retry of a terminal failure, through the engine's own `retry`
   * event. It sets `forced`, so the driver saves the CURRENT document at the
   * CURRENT confirmed revision: no revision is reset or invented and no text is
   * discarded. Nothing retries by itself beyond the engine's own budget.
   */
  const retrySave = useCallback(() => {
    if (!canRetrySave({ state: save, title, essay })) return
    setNotice(null)
    setSave((state) => reduce(state, { type: 'retry', at: Date.now() }))
  }, [save, title, essay])

  // --- leaving the page ----------------------------------------------------

  const leave = useCallback(() => router.push(LIBRARY), [router])

  /**
   * Back to the library, without losing the debounce window.
   *
   * The verdict is taken BEFORE anything is dispatched only to decide whether a
   * wait is needed at all. The wait itself is a waiter resolved by a future
   * transition, never by re-reading state after the flush.
   *
   * A document that cannot be saved is not flushed: the flush would set `forced`
   * and the driver would refuse it, and the waiter would never resolve. The
   * applicant stays, with the blocked notice already on screen.
   */
  const goToLibrary = useCallback(
    async (event: React.MouseEvent<HTMLAnchorElement>) => {
      // A modified click is the browser opening its own tab, and this component
      // cannot save on its way out of that. Rather than pretend, it is refused
      // while there is unsaved work and allowed when there is none.
      const modified =
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0
      if (modified) {
        if (hasUnsavedWork(saveRef.current)) {
          event.preventDefault()
          setNotice(NAV_MESSAGES.modified)
        }
        return
      }

      event.preventDefault()
      if (leaving) return

      const verdict = settleVerdict(saveRef.current)
      if (verdict === true) {
        leave()
        return
      }
      if (verdict === false) {
        // failed or conflict: the applicant has to resolve it first.
        setNotice(NAV_MESSAGES.stayed)
        return
      }

      const request = statementSaveRequest({
        title,
        essay,
        revision: saveRef.current.revision,
      })
      if (!request.ok) {
        setNotice(NAV_MESSAGES.blocked)
        return
      }

      setLeaving(true)
      // The waiter is registered BEFORE the dispatch, so a save that settles
      // immediately cannot resolve before anything is listening.
      const settled = whenSettled()
      setSave((state) => reduce(state, { type: 'flush', at: Date.now() }))
      const saved = await settled
      if (!alive.current) return
      setLeaving(false)
      if (saved) leave()
      else setNotice(NAV_MESSAGES.stayed)
    },
    [leaving, title, essay, whenSettled, leave]
  )

  // --- render --------------------------------------------------------------

  const status = statementStatus(save, blocked)
  const conflicted = save.status === 'conflict'
  /** Trimmed, because that is the length the limit actually applies to. */
  const titleCharacters = title.trim().length
  const canRetry = canRetrySave({ state: save, title, essay })

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <p className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        Internal preview. Upload and “Analyze this Draft” are not wired up yet.
      </p>

      <a
        href={LIBRARY}
        onClick={goToLibrary}
        className="text-sm font-medium text-blue-700 hover:underline"
      >
        {leaving ? 'Saving before leaving…' : '← All drafts'}
      </a>

      <div className="mt-4 flex items-start justify-between gap-4">
        {/*
          EDITABLE, and saved with the essay as one document. No maxLength:
          stopping at the limit would silently shorten a pasted title, which is
          the one thing the rules say not to do. A long title is refused,
          visibly, with the count in front of the applicant.

          readOnly (not disabled) while frozen, so a conflicted title stays
          selectable and copyable alongside the essay.
        */}
        <div className="min-w-0 flex-1">
          <label htmlFor="statement-title" className="sr-only">
            Draft title
          </label>
          <input
            id="statement-title"
            type="text"
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            readOnly={conflicted}
            autoComplete="off"
            spellCheck
            placeholder="Give this draft a title"
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 -ml-2 text-2xl font-bold text-slate-900 hover:border-gray-300 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 read-only:hover:border-transparent"
          />
        </div>
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
        Revision {save.revision} · title {titleCharacters.toLocaleString('en-US')}/
        {MAX_TITLE_CHARS.toLocaleString('en-US')}
        {titleCharacters > MAX_TITLE_CHARS ? ' — too long to save' : ''} · essay{' '}
        {essay.length.toLocaleString('en-US')} of{' '}
        {MAX_SAVED_CHARS.toLocaleString('en-US')} characters
      </p>

      {/*
        A real file input, no drag-and-drop. `accept` offers the three formats
        the route can read; the byte-signature check on the server is the
        authority, and a renamed file is refused there rather than here.
      */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label
          className={
            importing || conflicted
              ? 'cursor-not-allowed rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm font-medium text-slate-400'
              : 'cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-gray-50'
          }
        >
          {importing ? 'Reading document…' : 'Import PDF, DOCX or TXT'}
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            disabled={importing || conflicted}
            onChange={(event) => void onFileChosen(event.target.files)}
            className="hidden"
          />
        </label>
        <span className="text-xs text-slate-500">
          Replaces the essay. The title is left alone.
        </span>
      </div>

      {importNotice !== null && (
        <p
          role="status"
          className={
            importNotice.overLimit
              ? 'mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900'
              : 'mt-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900'
          }
        >
          {importNotice.text}
        </p>
      )}

      {importError !== null && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {importError}
        </p>
      )}

      {conflicted && (
        <div className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3">
          <p className="text-sm font-semibold text-red-900">
            This draft changed somewhere else. Saving is paused.
          </p>
          <p className="mt-1 text-sm text-red-800">
            Your version is still here and nothing has been overwritten. Copy it
            first if you want to keep it, then load the latest saved version —
            loading will replace what is on screen.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void copyMine()}
              className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-900 transition hover:bg-red-100"
            >
              Copy my version
            </button>
            <button
              type="button"
              onClick={() => void reloadLatest()}
              disabled={reloading}
              className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {reloading ? 'Loading…' : 'Reload latest version'}
            </button>
            {copied === 'done' && (
              <span className="text-xs font-medium text-red-900">{COPY_MESSAGES.copied}</span>
            )}
            {copied === 'failed' && (
              <span className="text-xs text-red-900">{COPY_MESSAGES.failed}</span>
            )}
          </div>
        </div>
      )}

      {canRetry && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3">
          <p className="text-sm text-red-900">
            The last save did not go through. Your text is still here.
          </p>
          <button
            type="button"
            onClick={retrySave}
            className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-800"
          >
            Try again
          </button>
        </div>
      )}

      {notice !== null && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {notice}
        </p>
      )}

      {/*
        readOnly, NOT disabled, when frozen. A disabled textarea is not
        selectable in most browsers, and the whole point of a frozen conflict is
        that the applicant can still read and copy what they wrote.

        No maxLength: truncating a pasted statement would be a worse answer than
        refusing to save it and saying so.
      */}
      <textarea
        value={essay}
        onChange={(event) => onEssayChange(event.target.value)}
        readOnly={conflicted}
        spellCheck
        aria-label="Personal statement"
        placeholder="Write your personal statement here."
        className="mt-4 min-h-[28rem] w-full resize-y whitespace-pre-wrap rounded-xl border border-gray-300 bg-white px-4 py-4 text-sm leading-relaxed text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 read-only:bg-gray-50"
      />
    </main>
  )
}
