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
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import { MAX_TITLE_CHARS, isPromptId } from '@/lib/statement/draft/validate'
import type { DraftPromptSnapshot, StatementDraft } from '@/lib/statement/draft/rows'
import type { SchoolOption } from '@/lib/statement/draft/schoolPicker'
import {
  PICKER_MESSAGES, confirmationApplies, needsPromptWrite, nextPendingPrompt,
  promptForRequest, samePendingPrompt, savedPromptFromResponse, schoolNameFor,
  wordLimitLabel, type PendingPrompt,
} from '@/lib/statement/draft/picker'
import PromptPicker from './PromptPicker'
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
  wordCount,
  wordLimitProgress,
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
 * `schools` and `schoolsUnavailable` GO STRAIGHT TO PromptPicker, which is the
 * only thing that reads them. They are not copied into state here: the server
 * read them once, behind the gate, and a second copy would be a second thing
 * to keep correct.
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
  promptNotice = null,
}: {
  draft: StatementDraft
  schools: readonly SchoolOption[]
  schoolsUnavailable: boolean
  /**
   * What to say about where this draft's question came from, ALREADY WORDED.
   *
   * A PREPARED STRING, not a status this component interprets. The server
   * resolves the submission and promptStatusLabel() chooses the sentence, so
   * nothing here has to know what a submission is, read one, or decide what
   * approval means -- and this component gains no new dependency, no new
   * fetch, and no new write.
   *
   * NULL FOR A CATALOG PROMPT AND FOR A GENERAL DRAFT, which is most drafts and
   * every draft today. The default means a page that does not pass it behaves
   * exactly as this component did before the prop existed.
   *
   * THE SNAPSHOT IS STILL WHAT IS RENDERED. This is a label beside the
   * question, never a replacement for it: `prompt` is untouched by this prop,
   * so an administrator editing or rejecting a submission cannot change a word
   * of what the applicant sees.
   */
  promptNotice?: string | null
}) {
  const router = useRouter()
  /** The nav is fixed and out of flow; this is how wide a space it reserves. */
  const { sidebarCollapsed } = useSidebarCollapsed()
  /**
   * Whether the school and prompt controls are showing.
   *
   * PRESENTATION ONLY, AND IT SAVES NOTHING. Opening this changes no state the
   * picker reads, issues no request and dispatches no autosave event -- it is a
   * class on a wrapper. Closing it is equally inert, which is what makes
   * "look at the options and change your mind" cost nothing.
   */
  const [pickerExpanded, setPickerExpanded] = useState(false)

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
  /**
   * A PROMPT THE APPLICANT HAS CHOSEN BUT THE SERVER HAS NOT CONFIRMED.
   *
   * A REF, NOT STATE, because startSave is a useCallback that would close over
   * a stale value: the instruction has to be the one that is true at the moment
   * the request is built, exactly as essayRef serves the upload path.
   *
   * THREE LAYERS, NOT TWO. `null` here means nothing is pending; a PendingPrompt
   * whose `promptId` is null means CLEAR the stored prompt. Collapsing those
   * would make every keystroke wipe the applicant's prompt.
   *
   * RETIRED ONLY BY A SUCCESS THAT STILL MATCHES IT, by token -- see startSave.
   * Every failure leaves it alone, so the engine's own next save re-sends it.
   *
   * NOTHING SETS IT IN THIS CHECKPOINT. The picker action is J2b; the mechanism
   * is built and tested first, with the button still disabled, so the lifecycle
   * is settled before any applicant can reach it.
   */
  const pendingPrompt = useRef<PendingPrompt | null>(null)

  /**
   * THE TOKEN SOURCE, AND IT NEVER RESETS for the life of this editor.
   *
   * Counting from whatever is pending would restart at 1 after every success
   * and every reload, so a response for the first token 1 could retire a brand
   * new token 1. Monotonic here means every selection an applicant ever makes
   * -- across saves, failures and reloads -- has an identity of its own.
   */
  const lastPromptToken = useRef(0)

  /**
   * The same pending selection, as STATE, purely so the picker can render it.
   *
   * The ref above is authoritative because it is synchronous; this mirror is
   * what React re-renders on. They are written together, in one handler, and
   * retired together -- a test asserts neither moves without the other.
   */
  const [pendingView, setPendingView] = useState<PendingPrompt | null>(null)

  /**
   * The token of a selection whose confirmation FAILED: a 200 arrived, the
   * revision was readable, and the four canonical prompt fields were not.
   *
   * A TOKEN, NOT A BOOLEAN, so the warning belongs to one selection. A failure
   * recorded for A must not appear as a failure of B -- confirmationApplies()
   * compares it with what is pending now, and a newer choice supersedes it.
   */
  const [promptConfirmFailed, setPromptConfirmFailed] = useState<number | null>(null)

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
      pendingPrompt.current = null
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

      // CAPTURED ONCE, SYNCHRONOUSLY, before anything can await. `captured` is
      // this request's instruction and stays in its closure; the ref may move
      // on while the request is in the air, and that is the whole point.
      const captured = pendingPrompt.current

      // The snapshot is taken HERE, from the values this save is about, and is
      // never recomputed from React state afterwards.
      const attempt = saveAttemptFor({
        title: rawTitle,
        essay: rawEssay,
        revision,
        // undefined when nothing is pending, so the body stays the three keys
        // it has always been. null means clear; a uuid means select.
        prompt: promptForRequest(captured),
      })
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

          // THE PROMPT COMES BACK FROM THE SERVER, NOT FROM WHAT WE SENT. The
          // response carries the canonical four fields, parsed by the same
          // strict rules a database row gets. A body that does not carry a
          // usable snapshot changes nothing and retires nothing: claiming a
          // selection was saved on the strength of an unreadable reply is the
          // false success this guards against.
          const saved = savedPromptFromResponse(body)
          if (saved !== null) {
            setPrompt(saved)
            // RETIRED ONLY IF IT IS STILL THE SAME SELECTION, by token. If a
            // newer one arrived during the request, the ref has moved and this
            // comparison fails -- so the newer instruction stays pending and
            // the engine's own dirty window schedules its save.
            if (samePendingPrompt(pendingPrompt.current, captured)) {
              pendingPrompt.current = null
              setPendingView(null)
              // This selection is confirmed, so any warning about it is spent.
              setPromptConfirmFailed((failed) =>
                captured !== null && failed === captured.token ? null : failed
              )
            }
          } else if (captured !== null) {
            // UNREADABLE CANONICAL METADATA ON A 200.
            //
            // The revision came back, so the document WAS written and the engine
            // is right to say so. But the four prompt fields did not arrive in a
            // form this application can trust, so whether the selection landed
            // is unknown -- and an unknown is not a success. The selection stays
            // pending, the display is not touched, and the applicant is told.
            //
            // NO `edited` IS DISPATCHED HERE, deliberately. Re-scheduling a save
            // from a response that keeps arriving malformed is an infinite loop.
            // The only thing that schedules another attempt is the applicant's
            // own click on the retry button below.
            setPromptConfirmFailed(captured.token)
          }
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
   * The applicant has chosen a prompt. THIS IS AN EDIT, and nothing more.
   *
   * WHAT IT DOES NOT DO. It issues no request, names no endpoint, and touches
   * neither the title nor the essay. It writes an instruction and dispatches the
   * engine's own `edited` event; the existing driver then saves the document on
   * its ordinary debounce, with the prompt id travelling inside the same PATCH
   * and the same compare-and-swap. There is no prompt-only save path.
   *
   * THE ID AND NOTHING ELSE. A uuid is the whole of what a browser may say about
   * a prompt -- the school, the wording and the word limit are resolved by the
   * server from the catalog -- so this takes a string and the picker has nothing
   * else to give it.
   *
   * THE REF IS WRITTEN SYNCHRONOUSLY, before the dispatch, because startSave may
   * run on the very next tick and must see this instruction rather than the one
   * before it.
   *
   * REDUNDANT CHOICES ARE DROPPED, but carefully: needsPromptWrite compares
   * against what is PENDING when anything is, and only against the server's
   * snapshot when nothing is. That is what lets an applicant reverse an
   * in-flight change back to the prompt their draft already shows.
   */
  const choosePrompt = useCallback((promptId: string) => {
    if (!isPromptId(promptId)) return
    if (!needsPromptWrite({
      chosenId: promptId,
      savedPromptId: prompt.promptId,
      pending: pendingPrompt.current,
    })) return

    lastPromptToken.current += 1
    const next = nextPendingPrompt(lastPromptToken.current - 1, promptId)
    pendingPrompt.current = next
    setPendingView(next)
    // A newer choice supersedes any warning about an older one.
    setPromptConfirmFailed(null)
    setNotice(null)
    setSave((state) => reduce(state, { type: 'edited', at: Date.now() }))
    // `prompt.promptId` is read above, so this handler is rebuilt when the
    // server's snapshot changes. A click handler has no stale-closure hazard
    // the way startSave does -- it runs from the render it was built in.
  }, [prompt.promptId])

  /**
   * A DELIBERATE retry of a prompt whose confirmation failed.
   *
   * THE ONLY THING THAT SCHEDULES ANOTHER ATTEMPT after an unreadable 200. It
   * dispatches the engine's `edited` event -- the same event typing dispatches,
   * no new event and no second path -- so the existing driver saves the current
   * document at the CURRENT confirmed revision, with the still-pending prompt
   * inside the same PATCH. `inFlight` still guards against overlap.
   *
   * NOT CALLED BY ANYTHING AUTOMATIC. That is the whole reason the response
   * branch above does not dispatch: a server returning malformed bodies would
   * otherwise be saved against for ever.
   */
  const retryPromptSave = useCallback(() => {
    if (pendingPrompt.current === null) return
    setNotice(null)
    setSave((state) => reduce(state, { type: 'edited', at: Date.now() }))
  }, [])

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

      // AND THE PENDING PROMPT GOES WITH IT. The reload adopts the server's
      // draft entirely -- that is what resolves the conflict -- so a selection
      // that never reached the server is gone, and the applicant is told rather
      // than left to discover it. Retiring the ref also means an in-flight
      // response cannot resurrect or retire anything afterwards: its `captured`
      // token no longer matches, and snapshotRef above is already null.
      const discarded = pendingPrompt.current !== null
      pendingPrompt.current = null
      setPendingView(null)
      // AND THE WARNING GOES WITH IT. A confirmation failure describes a
      // selection that no longer exists, so leaving it up would blame the
      // reloaded draft for an older response.
      setPromptConfirmFailed(null)
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
      // ONLY WHEN SOMETHING WAS ACTUALLY PENDING. A reload with no selection in
      // flight has nothing to report, and a notice that always appears is a
      // notice nobody reads.
      if (discarded) setNotice(PICKER_MESSAGES.selectionDiscarded)
      // `reloaded` returns the engine to a clean state at the SERVER's revision.
      // NO SAVE IS STARTED HERE: the discarded selection is not re-applied, so
      // the reloaded draft is exactly the server's.
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

  /** Display only. Nothing is saved, limited or refused because of these. */
  const words = wordCount(essay)
  const limit = wordLimitProgress({ words, statedMaxWords: prompt.statedMaxWords })
  /** The saved snapshot's school, named from the directory the server sent. */
  const promptSchool = schoolNameFor(schools, prompt.schoolId)
  const hasPrompt = prompt.promptText !== null
  /**
   * AN UNCONFIRMED PROMPT SAVE FORCES THE PANEL OPEN, and this is the reason
   * the collapse is not simply a boolean.
   *
   * The confirmation warning and its deliberate retry live INSIDE PromptPicker.
   * A draft whose prompt save came back unreadable must never leave the
   * applicant believing it was saved -- so while that warning applies, the
   * controls cannot be collapsed away from it and the toggle is withdrawn.
   * The same predicate the picker renders the warning with decides this, so the
   * two cannot disagree.
   */
  const confirmPending = confirmationApplies({
    failedToken: promptConfirmFailed,
    pending: pendingView,
  })
  /** A general draft opens on the picker: it is the whole point of the panel. */
  const pickerOpen = !hasPrompt || pickerExpanded || confirmPending

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/*
        THE NAV IS `fixed`, so it is out of flow and this page would otherwise
        start at the left edge of the VIEWPORT with the sidebar painted over it.
        The same reservation the Draft Library makes, read from the same shared
        context so the editor reflows when the nav is collapsed. `min-w-0` is
        what stops a long unbroken paste forcing a sideways scroll: a flex item
        defaults to min-width:auto and would refuse to shrink below its content.
      */}
      <div
        className={`min-w-0 flex-1 transition-all duration-300 ${
          sidebarCollapsed ? 'lg:ml-20' : 'lg:ml-64'
        } pt-16 lg:pt-0`}
      >
        {/* ======================================================== header */}
        {/*
          COMPACT ON PURPOSE. A writing application's header earns its height in
          navigation and status, not in decoration, so this is one row on
          desktop and wraps to two on a phone.
        */}
        <header className="border-b border-slate-800 bg-slate-950">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-3 sm:px-6 lg:px-8">
            <a
              href={LIBRARY}
              onClick={goToLibrary}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            >
              {leaving ? 'Saving before leaving…' : '← All drafts'}
            </a>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <label htmlFor="statement-title" className="sr-only">
                  Draft title
                </label>
                {/*
                  EDITABLE, and saved with the essay as one document. No
                  maxLength: stopping at the limit would silently shorten a
                  pasted title, which is the one thing the rules say not to do.
                  A long title is refused, visibly, with the count in front of
                  the applicant.

                  readOnly (not disabled) while frozen, so a conflicted title
                  stays selectable and copyable alongside the essay.
                */}
                <input
                  id="statement-title"
                  type="text"
                  value={title}
                  onChange={(event) => onTitleChange(event.target.value)}
                  readOnly={conflicted}
                  autoComplete="off"
                  spellCheck
                  placeholder="Give this draft a title"
                  className="-ml-2 w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-bold text-white placeholder:text-slate-500 hover:border-slate-700 focus:border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 read-only:hover:border-transparent sm:text-2xl"
                />
              </div>

              <p
                role="status"
                aria-live="polite"
                className={
                  status.frozen
                    ? 'shrink-0 rounded-lg border border-red-400/40 bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-200'
                    : 'shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300'
                }
              >
                {status.text}
              </p>
            </div>

            {/* The numbers that matter while writing, in one quiet row. */}
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span className="font-semibold text-slate-300">
                {words.toLocaleString('en-US')} {words === 1 ? 'word' : 'words'}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {essay.length.toLocaleString('en-US')} of{' '}
                {MAX_SAVED_CHARS.toLocaleString('en-US')} characters
              </span>
              <span aria-hidden="true">·</span>
              <span>Revision {save.revision}</span>
              <span aria-hidden="true">·</span>
              <span className={titleCharacters > MAX_TITLE_CHARS ? 'text-red-300' : undefined}>
                title {titleCharacters.toLocaleString('en-US')}/
                {MAX_TITLE_CHARS.toLocaleString('en-US')}
                {titleCharacters > MAX_TITLE_CHARS ? ' — too long to save' : ''}
              </span>
            </p>
          </div>
        </header>

        <div className="mx-auto w-full max-w-[1600px] px-4 pb-16 pt-5 sm:px-6 lg:px-8">
          {/* ACCURATE ABOUT WHAT IS BUILT. Drafting and document import both
              work; the analyser does not exist yet. The previous wording said
              upload was unwired, which stopped being true when upload shipped. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-2.5 text-xs text-slate-700">
            <span className="font-semibold text-slate-900">Internal preview</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span>
              Drafting and document import are available. The AI analyzer is not built yet.
            </span>
          </p>

          {/* ------------------------------------- messages, above both columns */}
          {importNotice !== null && (
            <p
              role="status"
              className={
                importNotice.overLimit
                  ? 'mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900'
                  : 'mt-4 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900'
              }
            >
              {importNotice.text}
            </p>
          )}

          {importError !== null && (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800"
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
              className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
            >
              {notice}
            </p>
          )}

          {/* ====================================================== two columns */}
          {/*
            8/12 and 4/12 on desktop, which is the approved two-thirds split.
            `items-start` is what lets the aside be sticky: a grid item stretches
            to the row height by default, and a stretched item has nothing to
            stick within.
          */}
          <div className="mt-5 grid items-start gap-6 lg:grid-cols-12">
            {/* ------------------------------------------- your statement */}
            <section aria-labelledby="statement-heading" className="min-w-0 lg:col-span-8">
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
                  <h2 id="statement-heading" className="text-sm font-bold text-slate-900">
                    Your statement
                  </h2>
                  {/*
                    A real file input, no drag-and-drop. `accept` offers the
                    three formats the route can read; the byte-signature check
                    on the server is the authority, and a renamed file is
                    refused there rather than here.
                  */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      className={
                        importing || conflicted
                          ? 'cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-400'
                          : 'cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus-within:ring-2 focus-within:ring-blue-500'
                      }
                    >
                      {importing ? 'Reading document…' : 'Import PDF, DOCX or TXT'}
                      <input
                        ref={fileInput}
                        type="file"
                        accept={ACCEPT_ATTRIBUTE}
                        disabled={importing || conflicted}
                        onChange={(event) => void onFileChosen(event.target.files)}
                        className="sr-only"
                      />
                    </label>
                    <span className="text-[11px] text-slate-500">Replaces the essay.</span>
                  </div>
                </div>

                {/*
                  readOnly, NOT disabled, when frozen. A disabled textarea is not
                  selectable in most browsers, and the whole point of a frozen
                  conflict is that the applicant can still read and copy what
                  they wrote.

                  No maxLength: truncating a pasted statement would be a worse
                  answer than refusing to save it and saying so.

                  A TEXTAREA, STILL. The stored document is plain text and the
                  autosave engine sends a string; a rich-text editor would be a
                  content-format change wearing a layout change's clothes.
                */}
                <textarea
                  value={essay}
                  onChange={(event) => onEssayChange(event.target.value)}
                  readOnly={conflicted}
                  spellCheck
                  aria-label="Personal statement"
                  placeholder="Write your personal statement here."
                  className="block min-h-[32rem] w-full resize-y whitespace-pre-wrap rounded-b-2xl border-0 bg-white px-6 py-6 text-[15px] leading-[1.9] text-slate-800 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 read-only:bg-slate-50 lg:min-h-[38rem] lg:px-8"
                />
              </div>

              {/* The school's stated maximum, when it stated one. */}
              {limit !== null && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-white px-5 py-3">
                  <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-700">Stated word limit</span>
                    <span className={limit.over ? 'font-semibold text-amber-700' : 'text-slate-600'}>
                      {limit.words.toLocaleString('en-US')} /{' '}
                      {limit.limit.toLocaleString('en-US')}
                      {limit.over
                        ? ` — ${Math.abs(limit.remaining).toLocaleString('en-US')} over`
                        : ` — ${limit.remaining.toLocaleString('en-US')} left`}
                    </span>
                  </p>
                  {/*
                    GUIDANCE, NOT A LIMIT. Going past a school's stated count
                    does not stop a save: the stored ceiling is a character
                    count, and this is the school's own advice.
                  */}
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={limit.limit}
                    aria-valuenow={limit.words}
                    aria-label="Words against the school's stated limit"
                    className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
                  >
                    <div
                      style={{ width: `${Math.round(limit.ratio * 100)}%` }}
                      className={`h-full rounded-full transition-all ${
                        limit.over ? 'bg-amber-500' : 'bg-blue-600'
                      }`}
                    />
                  </div>
                </div>
              )}
            </section>

            {/* ------------------------------------------ your school's prompt */}
            {/*
              STICKY ONLY FROM lg, AND ONLY AS TALL AS THE VIEWPORT. `self-start`
              keeps it at its content height so sticky has somewhere to travel;
              the max-height and its own overflow mean a very long question
              scrolls inside the panel instead of running past the footer. Below
              lg it is an ordinary block above the writing area.
            */}
            <aside
              aria-labelledby="prompt-heading"
              className="min-w-0 lg:col-span-4 lg:sticky lg:top-5 lg:self-start lg:max-h-[calc(100vh-2.5rem)] lg:overflow-y-auto lg:overscroll-contain"
            >
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 px-5 py-3">
                  <h2 id="prompt-heading" className="text-sm font-bold text-slate-900">
                    Your school&rsquo;s prompt
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {hasPrompt
                      ? 'The question this draft answers.'
                      : 'Attaching a school prompt is optional — a general statement needs none.'}
                  </p>
                </div>

                <div className="px-5 py-4">
                  {/* THE SAVED SNAPSHOT, not the catalog's current wording. */}
                  {hasPrompt && (
                    <div className="mb-4">
                      {promptSchool !== null && (
                        <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                          {promptSchool}
                        </p>
                      )}
                      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                        {prompt.promptText}
                      </p>
                      <p className="mt-2 text-xs text-slate-500">
                        {wordLimitLabel(prompt.statedMaxWords)}
                      </p>
                    </div>
                  )}

                  {/*
                    WHERE THE WORDING CAME FROM. Worded on the server, where the
                    submission can actually be resolved, and null for a catalog
                    prompt and for a general draft -- which is every draft while
                    the submission feature is switched off. Rendered as escaped
                    text, never as markup.
                  */}
                  {promptNotice !== null && (
                    <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs font-medium text-amber-900">
                      {promptNotice}
                    </p>
                  )}

                  {/*
                    THE CONTROLS, COLLAPSED BY DEFAULT ONCE A PROMPT IS
                    ATTACHED. An applicant who has chosen their question does
                    not need a search box open beneath it, and the right column
                    is shorter for it.

                    HIDDEN, NOT UNMOUNTED. `hidden` takes the subtree out of the
                    layout, the tab order and the accessibility tree, while the
                    component keeps its state -- so closing the panel does not
                    throw away a search in progress, and a reply still in flight
                    lands on a component that is still mounted and still guarded
                    by its own stale-response check.
                  */}
                  {hasPrompt && !confirmPending && (
                    <button
                      type="button"
                      aria-expanded={pickerOpen}
                      aria-controls="statement-prompt-controls"
                      onClick={() => setPickerExpanded((open) => !open)}
                      className="mb-4 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      {pickerOpen ? 'Hide school and prompt options' : 'Change school or prompt'}
                    </button>
                  )}

                  <div
                    id="statement-prompt-controls"
                    hidden={!pickerOpen}
                  >
                  {/*
                    WHAT THE PICKER CAN AND CANNOT DO.

                    `saved` is the draft's own snapshot, so the panel shows the
                    question this essay answers from the DRAFT rather than from
                    the catalog. `pending` and `confirmFailedToken` let it tell
                    saved from chosen from merely previewed.

                    AND THE TWO CALLBACKS CARRY NO POWER OF THEIR OWN.
                    `onUsePrompt` takes a uuid and `onRetryPromptSave` takes
                    nothing; both land in handlers above that write an
                    instruction and dispatch the engine's `edited` event. The
                    picker still has no setter for the draft's prompt, no
                    endpoint, and no way to reach startSave except through the
                    ordinary autosave it shares with typing.
                  */}
                  <PromptPicker
                    schools={schools}
                    schoolsUnavailable={schoolsUnavailable}
                    saved={prompt}
                    pending={pendingView}
                    confirmFailedToken={promptConfirmFailed}
                    onUsePrompt={choosePrompt}
                    onRetryPromptSave={retryPromptSave}
                    savedShownByParent
                  />
                  </div>
                </div>
              </div>

              {/*
                NOT A BUTTON, BECAUSE THERE IS NOTHING BEHIND IT. An analyser
                that looked clickable and did nothing would be worse than
                saying plainly that it is not built.
              */}
              <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-4">
                <p className="flex items-center gap-2 text-sm font-bold text-slate-500">
                  Analyze this draft
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Coming soon
                  </span>
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  Detailed AI feedback on your statement will appear here once the analyzer
                  is built.
                </p>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}
