'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  DEFAULT_AUTOSAVE,
  hasUnsavedWork,
  initialState,
  reduce,
  type AutosaveState,
} from '@/lib/resume/draft/autosave'
import { ceilingFromServer } from '@/lib/statement/extract/limits'
import { useSidebarCollapsed } from '@/lib/SidebarContext'
import { MAX_TITLE_CHARS, isPromptId } from '@/lib/statement/draft/validate'
import type { DraftPromptSnapshot, StatementDraft } from '@/lib/statement/draft/rows'
import type { SchoolOption } from '@/lib/statement/draft/schoolPicker'
import {
  PICKER_MESSAGES, confirmationApplies, needsPromptWrite, nextPendingPrompt,
  promptForRequest, samePendingPrompt, savedPromptFromResponse, schoolNameFor,
  wordLimitLabel, type PendingPrompt,
} from '@/lib/statement/draft/picker'
import {
  BAND_LABELS, NOT_ASSESSED, RUBRIC, bandFor, eligibilityFor, overLimit,
} from '@/lib/statement/draft/rubric'
import { reviewIsStale, type StatementReview } from '@/lib/statement/draft/reviewSchema'
import {
  resolveRequirementCapabilities,
} from '@/lib/statement/layout/capabilities'
import { documentFontChoice } from '@/lib/statement/layout/studioFonts'
import { formatProfileFor } from '@/lib/statement/layout/formatProfile'
import PaginatedEditor from './PaginatedEditor'
import RequirementsPanel from './RequirementsPanel'
import {
  SAMPLE_GENERAL_WORDS, SAMPLE_NOTICE, SAMPLE_SCHOOL_MAX_WORDS, SAMPLE_SCHOOL_WORDS,
} from '@/lib/statement/draft/reviewSample'
import {
  REVIEW_MESSAGES, REVIEW_NETWORK_FAILURE, analyzePath, canAnalyzeNow, provenanceLabel,
  reviewOutcomeFrom, type ReviewResult,
} from '@/lib/statement/draft/reviewClient'
import {
  ANALYSIS_ACTION_LABELS, ANALYSIS_NO_CACHE_NOTICE, ANALYSIS_PREVIEW_NOTICE,
  ANALYSIS_TIER_MESSAGE, analysisOffer,
  LOCAL_REAL_AI_NOTICE, LOCAL_REAL_AI_WARNING,
  ANALYSIS_UNAVAILABLE_MESSAGE, type AnalysisAction, type AnalysisAvailability,
} from '@/lib/statement/draft/reviewAccess'
import {
  characterCount, hasAdvisoryLength, liveCounts,
} from '@/lib/statement/requirements/constraints'
import {
  ADVISORY_LENGTH_NOTICE, labelledConstraints, liveCountLabel, liveCountStatus, liveCountVerdict,
  statedWordings,
  truncationNotice, unenforcedLengthNotice,
} from '@/lib/statement/requirements/constraintText'
import { DOCUMENT_TYPE_LABELS } from '@/lib/statement/requirements/requirement'
import type { RequirementSnapshot } from '@/lib/statement/requirements/snapshot'
import {
  FLOOR_UNREACHABLE, eligibilityForRequirement, shortfallLabel, tooShortLabel, wordFloorFits,
} from '@/lib/statement/requirements/eligibility'
import { SAVED_COPY_NOTICE } from '@/lib/statement/requirements/verification'
import PromptPicker from './PromptPicker'
import { ConstraintChips } from './constraintChips'
import { TOUCH_TARGET } from './touchTarget'
import { SAVE_MESSAGES, saveEventFrom } from '@/lib/statement/draft/save'
import { browserSessionAlive } from '@/lib/statement/draft/sessionCheck'
import type { PromptOrigin } from '@/lib/statement/draft/promptSubmission'
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
  documentWasEdited,
  draftStateMatches,
  saveFailedOnExpiredSession,
  type DraftState,
  statementStatus,
  titleAfterSave,
  wordCount,
  wordLimitProgress,
  type SaveSnapshot,
  documentForEssay,
  hydrationFor,
  FORMATTING_REBUILT,
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
  promptOrigin = null,
  savedCharacterCeiling,
  sampleReviews = null,
  analysisAllowed = false,
  analysisAvailable = 'unavailable',
  priorAnalysis = null,
  localRealAi = false,
  requirement = null,
  requirementAuthentic = false,
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
  /**
   * Where this draft's question came from: the catalog, or the applicant.
   *
   * A FACT, NOT A SENTENCE, so the heading, the badge and the limit line can
   * each say the right thing about it. null for a catalog prompt and for a
   * general draft -- neither needs a caveat.
   */
  promptOrigin?: PromptOrigin | null
  /**
   * The saved-character ceiling, RESOLVED ON THE SERVER.
   *
   * THE BROWSER MUST NOT WORK THIS OUT. maxSavedChars() reads the environment,
   * and the env object a client bundle is handed has neither NODE_ENV nor the
   * simulated-live opt-out in it -- so this component answered 20,000 while the
   * API accepted 30,000 and refused to send an essay that met the school's
   * published maximum. The server knows which schema is behind it; it says so.
   *
   * ABSENT OR MALFORMED FAILS CLOSED to the ceiling every schema has had.
   */
  savedCharacterCeiling?: number
  /**
   * DEVELOPMENT-ONLY: sample results, for reviewing the interface without
   * paying for an analysis.
   *
   * BUILT ON THE SERVER, behind the same gate the paste preview uses, and null
   * in every environment that is not a developer's own. It is a separate prop
   * from the real result so that nothing can confuse the two: a sample is
   * displayed under its own banner and is never written into `review`, so
   * staleness, Analyze-again and the real result all behave as though it were
   * not there.
   */
  sampleReviews?: { readonly general: StatementReview; readonly school: StatementReview } | null
  /**
   * Whether this member's plan includes analysis.
   *
   * PRESENTATION ONLY. The endpoint checks the tier again and is the control;
   * this decides whether to show the button or the reason it is not there, so a
   * Free member sees an explanation instead of a control that fails. Defaults
   * to false, so a page that does not pass it offers nothing.
   */
  analysisAllowed?: boolean
  /**
   * Whether analysis can be offered honestly: with storage, without it on a
   * developer's machine, or not at all. Defaults to 'unavailable', so a page
   * that does not pass it offers nothing rather than charging.
   */
  analysisAvailable?: AnalysisAvailability
  /**
   * An analysis already stored for this draft, and whether it is about exactly
   * what is on screen.
   *
   * null WHENEVER THE CACHE IS OFF, which is every environment today -- the
   * table does not exist until 20261002_004 is applied. The editor then offers
   * a fresh analysis, which is the behaviour it has now.
   */
  /**
   * Development only: the real analyser is running against localhost.
   *
   * DECIDED ON THE SERVER AND PASSED DOWN, never read from the environment
   * here: a NEXT_PUBLIC_* variable is inlined into this bundle and would be a
   * statement about what the browser was told rather than about the mode. It
   * defaults to false, so a production render cannot show either notice.
   */
  localRealAi?: boolean
  priorAnalysis?: {
    readonly result: Omit<ReviewResult, 'essay'>
    readonly action: AnalysisAction
  } | null
  /**
   * The draft's STORED structured requirement, when it has one.
   *
   * THE STORED ONE, NOT A PROJECTION, so a draft created before this feature
   * renders exactly as it did: null here means every block below is absent and
   * the panel is the single-prompt panel that shipped. snapshot.ts can project
   * an old draft's columns into this shape, and that projection is deliberately
   * NOT passed -- it would add a document header and a question count to drafts
   * whose authors never chose either.
   *
   * null ON EVERY UNMIGRATED DEPLOYMENT, because the column is not even read
   * unless STATEMENT_REQUIREMENTS is on.
   */
  requirement?: RequirementSnapshot | null
  /**
   * Whether the saved requirement still matches what the school publishes.
   *
   * COMPUTED ON THE SERVER AGAINST THE CATALOG, never read from the snapshot.
   * The snapshot has its own `verification` object and the owner can PATCH it
   * through PostgREST, so a warning keyed on that field could be switched off
   * by the person it is warning. This prop cannot be.
   *
   * DEFAULTS TO false, so a page that does not pass it labels the panel as a
   * saved copy rather than silently presenting it as official.
   */
  requirementAuthentic?: boolean
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
  /** The last completed analysis, with the essay it describes. Transient. */
  const [review, setReview] = useState<ReviewResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  /**
   * The rendered height of the essay, in points. null until the first layout.
   *
   * MEASURED BY THE EDITOR, NEVER ESTIMATED HERE. It is a fact about the text
   * laid out at the school's geometry, which is the whole reason the page count
   * can be shown at all.
   */
  const [contentHeightPt, setContentHeightPt] = useState<number | null>(null)
  /**
   * Pages occupied, as the editor's own layout pass counted them.
   *
   * MEASURED, NOT DERIVED, so the figure in the panel and the line drawn on the
   * page are the same answer. null until the first pass, and on the plain
   * textarea, which has no pages to count.
   */
  const [pagesUsed, setPagesUsed] = useState<number | null>(null)
  /**
   * The constrained editor document.
   *
   * ---------------------------------------------------------------------------
   * FORMATTING IS STATE THE ESSAY CANNOT HOLD
   * ---------------------------------------------------------------------------
   * Bolding a word changes this and leaves `essay` byte-identical. That is the
   * whole point: the analyser, the counters and the fingerprint all read the
   * essay, so formatting costs nothing and invalidates nothing -- while the
   * draft still has to save, and still has to say "Saved".
   *
   * STARTS FROM THE STORED DOCUMENT, or null for a draft written before
   * formatting existed, which the editor reconstructs from the essay.
   */
  // The stored pair, reconciled first: hydrationFor() owns the policy.
  const hydration = hydrationFor({ essay: draft.essay, document: draft.editorDocument })
  const [editorDocument, setEditorDocument] = useState<unknown>(hydration.document)
  const documentRef = useRef<unknown>(hydration.document)
  /**
   * The face this document is laid out in.
   *
   * A LAYOUT PREFERENCE, HELD BESIDE THE DOCUMENT AND NOT INSIDE IT. The
   * document model holds paragraphs, text and bold; a font is not an inline
   * fact and putting it there would put an attribute inside the string whose
   * plain text must equal `essay`.
   *
   * THE REF IS WHAT THE SAVE READS, written synchronously before the dispatch,
   * for the same reason the pending prompt is: startSave may run on the very
   * next tick and must send the choice that was just made.
   */
  const [documentFont, setDocumentFont] = useState<string | null>(draft.documentFont ?? null)
  const fontRef = useRef<string | null>(draft.documentFont ?? null)
  /**
   * Whether the font has been changed since this draft loaded.
   *
   * WITHOUT IT, EVERY AUTOSAVE WOULD CARRY A FONT. That is not harmful but it
   * is not honest either: a body that names a column is a body that writes it,
   * and a keystroke is not a decision about the font. The key is sent only
   * once a choice has actually been made.
   */
  const fontTouched = useRef(false)
  /** Which sample is on screen, when a developer is previewing the interface. */
  const [sampleKind, setSampleKind] = useState<'general' | 'school'>('school')
  /**
   * THE DUPLICATE GUARD, and a ref for the reason the New Draft dialog's is:
   * state settles asynchronously, so two clicks in one tick would both read
   * `analyzing === false` and both start a request -- and an analysis costs
   * the applicant part of their allowance.
   */
  const analyzeInFlight = useRef(false)

  /** Read-only, but stateful: a reload may bring a title changed elsewhere. */
  const [title, setTitle] = useState(draft.title)
  /*
    ONE RESOLVED NUMBER for every surface in this component: the status line,
    the blocked message and the save request all refuse at the same place, and
    that place is the one the SERVER named. Declared here because the save
    callbacks below close over it.
  */
  const savedCeiling = ceilingFromServer(savedCharacterCeiling)

  /*
    WHAT IS ACTUALLY STORED, so a no-op can be recognised as one.

    SEEDED FROM THE SERVER'S OWN DRAFT and advanced on every successful save.
    markEdited() below compares against it, which is what stops the editor
    MERELY ARRIVING from marking the draft dirty -- see draftStateMatches and
    QA-011. Nothing else may write it: a baseline that moved without a save
    would make a real edit look like a no-op, which is the one failure worse
    than the one it fixes.
  */
  const persistedRef = useRef<DraftState>({
    title: draft.title,
    essay: draft.essay,
    document: draft.editorDocument ?? null,
    font: draft.documentFont ?? null,
  })

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
  /** The live title, for the leave-flush, which cannot read React state. */
  const titleRef = useRef(title)
  useEffect(() => {
    essayRef.current = essay
    titleRef.current = title
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

  /**
   * A promise that resolves when the save settles -- OR when waiting stops
   * being honest.
   *
   * ---------------------------------------------------------------------------
   * WHY IT HAS A DEADLINE AT ALL
   * ---------------------------------------------------------------------------
   * settleVerdict() is null for dirty, saving AND retrying, so an unacknowledged
   * save that backs off and tries again three times can legitimately keep this
   * promise pending for a minute -- and before the liveness fix above it could
   * keep it pending for ever, which is what left "Saving before leaving…" on the
   * All Drafts button with nothing on the way.
   *
   * So the wait is bounded, and a bounded wait reports `false`: not "saved", not
   * "lost" -- UNSETTLED. The caller keeps the applicant on the page with every
   * character still on screen and says so. Nothing is discarded by giving up on
   * waiting, which is the whole reason this can safely give up.
   */
  const whenSettled = useCallback(
    (timeoutMs = DEFAULT_AUTOSAVE.saveTimeoutMs) => new Promise<boolean>((resolve) => {
      let done = false
      const once = (saved: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(saved)
      }
      const timer = setTimeout(() => {
        // Drop this waiter so the transition effect does not resolve it twice,
        // and so a long-lived component does not accumulate dead callbacks.
        settleWaiters.current = settleWaiters.current.filter((w) => w !== once)
        once(false)
      }, timeoutMs)
      settleWaiters.current.push(once)
    }),
    []
  )

  /**
   * Liveness, asserted on EVERY mount and withdrawn on every unmount.
   *
   * ---------------------------------------------------------------------------
   * THE MISSING LINE WAS THE SAVE HANG
   * ---------------------------------------------------------------------------
   * This used to be a cleanup with an empty body: `useEffect(() => () => {...})`.
   * React's StrictMode mounts, runs effects, runs cleanups, and mounts again --
   * so the cleanup ran once during that simulated unmount, set `alive` to false,
   * and nothing ever set it back, because a ref initialiser runs once and the
   * effect body did nothing.
   *
   * For the rest of that component's life every `if (!alive.current) return`
   * fired: the save response arrived, was parsed, and was DISCARDED before it
   * could be dispatched. The indicator stayed at "Saving…" for ever, the
   * single-flight rule then refused every later save, and leaving the page
   * waited on a promise that could not resolve -- so a paste after the first
   * save was never persisted and a refresh lost it.
   *
   * The body is the fix: a mounted component is alive, whatever happened to a
   * previous one. Nothing here depends on StrictMode being on or off.
   */
  useEffect(
    () => {
      alive.current = true
      return () => {
      alive.current = false
      snapshotRef.current = null
      uploadRef.current = null
      pendingPrompt.current = null
      const waiting = settleWaiters.current
      settleWaiters.current = []
      for (const resolve of waiting) resolve(false)
      }
    },
    []
  )

  // --- saving --------------------------------------------------------------

  const startSave = useCallback(
    async (revision: number, rawTitle: string, rawEssay: string, leaving = false) => {
      if (inFlight.current) return

      // CAPTURED ONCE, SYNCHRONOUSLY, before anything can await. `captured` is
      // this request's instruction and stays in its closure; the ref may move
      // on while the request is in the air, and that is the whole point.
      const captured = pendingPrompt.current

      // The snapshot is taken HERE, from the values this save is about, and is
      // never recomputed from React state afterwards.
      const attempt = saveAttemptFor({
        savedCharacterCeiling: savedCeiling,
        title: rawTitle,
        essay: rawEssay,
        revision,
        // THE DOCUMENT RIDES THE SAME PATCH, and the server refuses any whose
        // text disagrees with the essay above. Omitted entirely when this
        // draft has no formatting, so the plain surface's body is unchanged.
        ...(documentRef.current === null ? {} : { document: documentRef.current }),
        // THE FONT RIDES THE SAME PATCH, and only once it has been chosen. See
        // fontTouched: an ordinary keystroke must not write this column.
        ...(fontTouched.current ? { font: fontRef.current } : {}),
        // undefined when nothing is pending, so the body stays the three keys
        // it has always been. null means clear; a uuid means select.
        prompt: promptForRequest(captured),
      })
      if (!attempt.ok) return
      const snapshot = attempt.snapshot

      snapshotRef.current = snapshot
      inFlight.current = true
      setSave((state) => reduce(state, { type: 'save-started', at: Date.now() }))

      /*
        A DEADLINE ON THE SOCKET AS WELL AS ON THE STATUS.

        The watchdog in statementDriverAction() is what guarantees the
        indicator cannot sit at "Saving…" for ever -- it fires whatever
        happened to this request. This abort is the other half: without it a
        request the editor has stopped believing in keeps running, and could
        still write the draft minutes later, under a revision the applicant has
        moved past.

        SAME DEADLINE, deliberately. Two different numbers would mean a window
        in which the status has given up and the request has not.
      */
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), DEFAULT_AUTOSAVE.saveTimeoutMs)
      try {
        const response = await fetch(draftApiPath(draft.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt.body),
          signal: deadline.signal,
          // KEEPALIVE ONLY ON THE WAY OUT. A normal fetch is cancelled when the
          // document goes away, which is precisely when the leave-flush runs;
          // a keepalive request is allowed to outlive it. It is not the default
          // because keepalive requests are capped in size and number, and an
          // ordinary autosave has a live page to report back to.
          keepalive: leaving,
        })
        const body = await response.json().catch(() => null)
        // THE ONE MAPPING. saveEventFrom decides success, conflict, and whether
        // a failure is retryable; none of that is repeated here.
        let event = saveEventFrom({ status: response.status, body, at: Date.now() })

        /*
          A 404 MAY MEAN "YOUR SESSION WENT AWAY", AND SAYING "DELETED" IS WORSE
          THAN SAYING NOTHING.

          The Studio gate answers an unadmitted caller with a 404 whose body is
          deliberately empty of meaning -- it must not reveal that a gate, a
          draft or an endpoint exists. saveEventFrom therefore has only the
          status to go on and maps it to "This draft no longer exists."

          For an applicant whose session merely expired, that sentence is false
          and frightening: they are told their work was deleted while it is
          still on screen, and the message gives them nowhere to go. So the
          editor asks the one question the server cannot answer for it -- does
          this browser still hold a session? -- and re-words the failure when
          the answer is no.

          NOTHING ABOUT THE DRAFT IS INVOLVED, so the gate's neutrality is
          untouched: no request is made, and the answer would be the same for
          an id that never existed.

          ONLY ON THIS ONE REASON. A genuine deletion still reports a deletion,
          because the session is alive and the probe says so.
        */
        if (event.type === 'save-failed' && event.reason === SAVE_MESSAGES.missing) {
          const signedIn = await browserSessionAlive()
          if (!signedIn) {
            event = {
              type: 'save-failed',
              at: Date.now(),
              reason: SAVE_MESSAGES.expired,
              // RETRYABLE, so the engine's own backoff keeps the work moving
              // the moment the applicant signs back in -- and Try again is
              // there for them in the meantime.
              retryable: true,
            }
          }
        }
        if (!alive.current) return

        // RECONCILE ONLY ON SUCCESS, AND ONLY FOR THIS SNAPSHOT. A conflict or a
        // failure persisted nothing, so there is nothing to reconcile to; and a
        // snapshot that has been retired -- by a reload, or by a later save --
        // is no longer about the document on screen.
        if (event.type === 'save-succeeded' && snapshotRef.current === snapshot) {
          // THE BASELINE MOVES WITH THE DATABASE, and only here. What this save
          // sent is now what is stored, so the next no-op comparison is against
          // the right thing. See persistedRef.
          persistedRef.current = {
            title: snapshot.sent,
            essay: snapshot.essay,
            document: documentRef.current,
            font: fontRef.current,
          }
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
        clearTimeout(timer)
        // This request is over either way; its snapshot must not outlive it.
        if (snapshotRef.current === snapshot) snapshotRef.current = null
        inFlight.current = false
      }
    },
    [draft.id]
  )

  useEffect(() => {
    const action = statementDriverAction({
      state: save, now: Date.now(), title, essay, savedCharacterCeiling: savedCeiling })

    if (action.kind === 'blocked') {
      // No request and NO TIMER. The work stays on screen, visibly unsaved.
      setBlocked(action.message)
      return
    }
    setBlocked(null)

    /*
      THE SAVE THE EDITOR HAS STOPPED BELIEVING IN.

      Reported as a RETRYABLE failure, so the engine's own backoff tries again
      -- an unacknowledged save is usually a slow connection, not a broken
      document -- and so an exhausted one lands in 'failed' with a working Try
      again rather than in a status nothing can leave.

      THE REQUEST ITSELF IS ABORTED BY ITS OWN DEADLINE, above. This does not
      reach into it: the two share one number and neither waits on the other.
    */
    if (action.kind === 'timed-out') {
      setSave((state) =>
        reduce(state, {
          type: 'save-failed',
          at: Date.now(),
          reason: SAVE_MESSAGES.timeout,
          retryable: true,
        })
      )
      return
    }

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
    markEdited()
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
    markEdited()
  }, [])

  /**
   * A title edit is an edit. Same engine event, same dirty window, same
   * debounce, same navigation guard -- there is no title-specific save path and
   * no second endpoint.
   */
  const onTitleChange = useCallback((value: string) => {
    setTitle(value)
    setNotice(null)
    markEdited()
  }, [])

  /*
    THE ONE PLACE A DRAFT BECOMES DIRTY.

    Seven handlers used to dispatch the engine's `edited` event directly, and
    most of them fire while the editor is only arriving. They all come through
    here now, and here asks draftStateMatches whether anything a save would
    write is actually different. Nothing different, nothing dispatched: no
    dirty state, no timer, no PATCH.

    READS THE REFS, NOT STATE, because the handlers that call it have just
    written the refs synchronously and React has not re-rendered yet.
  */
  const markEdited = useCallback(() => {
    const proposed: DraftState = {
      title: titleRef.current,
      essay: essayRef.current,
      document: documentRef.current,
      font: fontRef.current,
    }
    if (draftStateMatches(persistedRef.current, proposed)) return
    setSave((state) => reduce(state, { type: 'edited', at: Date.now() }))
  }, [])

  /**
   * The document changed, and perhaps only the document.
   *
   * DISPATCHES THE SAME `edited` EVENT typing does. The engine has one idea of
   * dirty, and a formatting change is an edit to this draft -- it marks it
   * unsaved, it debounces, it saves, it bumps the revision. What it does NOT
   * do is touch `essay`, which is why nothing downstream re-analyses.
   *
   * COMPARED BEFORE DISPATCHING, because the editor emits on every
   * transaction including ones that changed nothing a document can hold --
   * a caret move, a selection. Dispatching on those would keep the draft
   * permanently dirty and autosaving for ever.
   *
   * AND COMPARED SEMANTICALLY, which is what documentWasEdited is for. A byte
   * comparison also fired on the editor merely ARRIVING: a draft with no
   * stored document -- every new one -- emitted the essay as a document and
   * looked like a change against null, so opening a draft saved it and bumped
   * its revision without the applicant touching anything. See QA-011.
   *
   * THE REF STILL TAKES THE NEW DOCUMENT EITHER WAY. It is what the editor
   * actually holds, and the next save must carry it; what the comparison
   * decides is only whether there is anything to save YET.
   */
  // Content from OUTSIDE the editor, both halves at once. Why it is one
  // function: see documentForEssay(). A plain draft gains no document.
  const applyExternalEssay = useCallback((text: string) => {
    setEssay(text)
    essayRef.current = text
    if (documentRef.current !== null) {
      const next = documentForEssay(text)
      documentRef.current = next
      setEditorDocument(next)
    }
  }, [])

  // Said out loud: text intact, bold reset, applicant told.
  useEffect(() => {
    if (hydration.kind === 'rebuilt') setNotice(FORMATTING_REBUILT)
    // Once, on mount, for the row as it was read. A later save cannot
    // reintroduce the state, so there is nothing to re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onDocumentChange = useCallback((next: unknown) => {
    // A CHEAP BAIL-OUT ONLY: the editor emits on every transaction, including
    // a caret move that changed nothing at all, and re-rendering for those is
    // waste. Whether this COUNTS as an edit is markEdited's question, asked
    // against what is stored rather than against the last emission.
    if (JSON.stringify(documentRef.current) === JSON.stringify(next)) return
    documentRef.current = next
    setEditorDocument(next)
    markEdited()
  }, [markEdited])

  /**
   * The applicant chose a font. THIS IS AN EDIT, and nothing more.
   *
   * IT ISSUES NO REQUEST AND TOUCHES NO TEXT. It records the choice and
   * dispatches the engine's own `edited` event; the existing driver saves the
   * document on its ordinary debounce with the font travelling inside the same
   * PATCH and the same compare-and-swap. There is no font-only save path.
   *
   * `essay` IS NOT READ OR WRITTEN HERE, which is the whole reason a font
   * change cannot move the word count, the character count or the analysis
   * fingerprint -- and therefore cannot cost the applicant a second paid
   * analysis. The page count DOES move, because the browser re-lays the text
   * out in the new face and the editor re-measures what it actually rendered.
   */
  const onFontChange = useCallback((id: string) => {
    if (fontRef.current === id) return
    fontRef.current = id
    fontTouched.current = true
    setDocumentFont(id)
    setNotice(null)
    markEdited()
  }, [])


  const onEssayChange = useCallback((value: string) => {
    setEssay(value)
    // Synchronously, so an extraction reply arriving in this same tick sees it.
    essayRef.current = value
    setNotice(null)
    setCopied('idle')
    setImportNotice(null)
    // Dispatched on EVERY REAL edit, including during a save. The engine
    // restarts the dirty window while a request is in flight, so a success
    // landing after this reports 'dirty' rather than 'saved'.
    markEdited()
  }, [markEdited])

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
   * The last resort: save on the way out, whatever the way out was.
   *
   * ---------------------------------------------------------------------------
   * WHAT THE OTHER GUARDS DO NOT COVER
   * ---------------------------------------------------------------------------
   * `beforeunload` warns, and only for a real unload. `visibilitychange`
   * flushes a hiding tab. `goToLibrary` flushes and waits for its own link.
   * Between them they miss the ordinary case: an applicant clicks any other
   * link -- the sidebar, the dashboard, Log out -- and this component unmounts
   * with up to 1.2 seconds of typing that has never been sent. Nothing warns,
   * because nothing is unloading; the edits are simply gone, and the draft
   * reopens without the last sentence.
   *
   * keepalive IS WHAT MAKES THIS POSSIBLE. A normal fetch is cancelled when the
   * document goes away, which is exactly when this runs; a keepalive request is
   * allowed to outlive it. The payload is small -- well inside the 64KB the
   * spec allows -- because it is one draft's text.
   *
   * IT IS STILL A COMPARE-AND-SWAP. The body carries the same revision any
   * other save would, so a request that loses a race is refused by the server
   * rather than overwriting a newer version. Nothing here bypasses the
   * concurrency rule to get the write in.
   *
   * NO STATE IS TOUCHED. The component is going away; dispatching into it would
   * be writing to something unmounted, and the result cannot be displayed
   * anyway. The next load reads whatever the server accepted.
   */
  useEffect(() => {
    const flushOnLeave = () => {
      if (!hasUnsavedWork(saveRef.current)) return
      // A save already in flight is the engine's business, and a second request
      // for the same revision would simply be refused.
      if (inFlight.current) return
      // THE SAME SAVE PATH, with one flag. There is still exactly one place
      // that builds a body and one that issues a PATCH; a second would be a
      // second set of rules about revisions and prompts to keep in step.
      void startSave(saveRef.current.revision, titleRef.current, essayRef.current, true)
    }
    // pagehide COVERS WHAT beforeunload DOES NOT, including a page entering the
    // back/forward cache, where unload never fires at all.
    window.addEventListener('pagehide', flushOnLeave)
    return () => {
      window.removeEventListener('pagehide', flushOnLeave)
      // AND THE UNMOUNT ITSELF, which is the in-app navigation case.
      flushOnLeave()
    }
  }, [draft.id, startSave])

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

        // The whole extracted string, both halves, one writer.
        applyExternalEssay(outcome.document.text)
        setImportNotice(importNoticeFor(outcome.document))
        // The SAME event typing dispatches. The driver decides the rest: a
        // document over the save ceiling simply blocks, with no request and no
        // timer, until the applicant trims it.
        markEdited()
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
      // Both halves: this component's document lost the race.
      applyExternalEssay(outcome.draft.essay)
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
  /**
   * Ask the server to analyse this draft.
   *
   * THE REQUEST CARRIES NOTHING BUT THE PATH. The essay, the prompt, the word
   * limit and the revision are all read on the server from the saved row, so
   * there is no field here that could misreport what was analysed -- and none
   * a caller could forge.
   *
   * THE ESSAY IS CAPTURED BEFORE THE REQUEST and stored with the result. That
   * captured string is what staleness is measured against: an applicant may
   * keep typing while this runs, and what comes back describes what they had
   * written, not what they have now.
   *
   * IT TOUCHES NO DRAFT STATE. No setTitle, no setEssay, no dispatch, no
   * revision: an analysis reads the draft and returns an opinion about it. The
   * autosave engine does not know this feature exists.
   */
  const analyze = useCallback(async () => {
    if (analyzeInFlight.current) return
    analyzeInFlight.current = true
    setAnalyzing(true)
    setReviewError(null)

    const analyzed = essay
    try {
      const response = await fetch(analyzePath(draft.id), { method: 'POST' })
      const body = await response.json().catch(() => null)
      const outcome = reviewOutcomeFrom({ status: response.status, body })
      if (outcome.type === 'ready') {
        setReview({ ...outcome.result, essay: analyzed })
        setOpenCategory(null)
      } else {
        setReviewError(outcome.message)
      }
    } catch {
      setReviewError(REVIEW_NETWORK_FAILURE.message)
    }
    analyzeInFlight.current = false
    setAnalyzing(false)
  }, [draft.id, essay])

  const retrySave = useCallback(() => {
    if (!canRetrySave({ state: save, title, essay, savedCharacterCeiling: savedCeiling })) return
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
        savedCharacterCeiling: savedCeiling,
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
  const canRetry = canRetrySave({ state: save, title, essay, savedCharacterCeiling: savedCeiling })
  /**
   * Whether the failure on screen is an expired session rather than anything
   * about the draft. Read from the reason the driver recorded, which is the
   * only place that distinction is known -- see the 404 handling in startSave.
   */
  const sessionExpired = saveFailedOnExpiredSession(save)
  /**
   * Whether the question on screen is the applicant's own, unreviewed wording.
   *
   * READ FROM THE SERVER'S ANSWER. originOf() resolves it from which column the
   * draft carries, and the page passes the result down; this component never
   * infers provenance from the presence of text.
   */
  const userProvidedPrompt = promptOrigin === 'user'

  /** Display only. Nothing is saved, limited or refused because of these. */
  const words = wordCount(essay)
  /**
   * The legacy single-maximum readout, or null.
   *
   * ---------------------------------------------------------------------------
   * WITHDRAWN WHENEVER A STRUCTURED WORD BOUND EXISTS
   * ---------------------------------------------------------------------------
   * This panel knows one number -- the draft's stored statedMaxWords -- and a
   * structured requirement can carry two. For a school asking 100-200 words it
   * therefore rendered "99 / 200 — 101 left", which reads as room to spare,
   * while the status bar a few pixels away correctly said "under the minimum".
   * Two readouts of one requirement, disagreeing.
   *
   * The status bar is the one that knows the whole bound and its register, so
   * it keeps the job. This panel remains for drafts whose only length
   * information IS the single number: a prompt from the older catalog, or a
   * limit the applicant typed into the paste form.
   *
   * KEYED ON THE DATA, NOT ON A SCHOOL. Any requirement carrying a word bound
   * suppresses it; any draft without one keeps it.
   */
  const limit = requirement?.constraints.words != null
    ? null
    : wordLimitProgress({ words, statedMaxWords: prompt.statedMaxWords })
  /** The banner's claim about analysis, from the plan and the capability. */
  const previewOffer = analysisOffer({
    allowed: analysisAllowed,
    availability: analysisAvailable,
  })
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
  /**
   * What the Studio can do with this school's requirement.
   *
   * ---------------------------------------------------------------------------
   * ONE RESOLVER DRIVES THE WHOLE SURFACE
   * ---------------------------------------------------------------------------
   * The writing surface, the page it is laid out on, the figures in the panel
   * and the lines that still need a human all come from here. There is no
   * second opinion anywhere in this component about what this school requires
   * or what we can do about it -- which is what stops a school-shaped condition
   * appearing in the UI the first time one record behaves unlike the others.
   *
   * RESOLVED FOR EVERY DRAFT, including those with no requirement at all: the
   * result is then the Studio defaults throughout, each marked as such.
   */
  /**
   * What the applicant may choose, from this draft's own record.
   *
   * THE RECORD DECIDES WHAT IS LEGAL; THE PREFERENCE DECIDES WHICH OF THOSE IS
   * IN FORCE. Both are read here, in one place, so no screen can offer a font
   * the school forbade and no stored value can render one.
   */
  const fontChoice = useMemo(() => {
    const typography = requirement?.constraints?.typography ?? null
    return documentFontChoice({
      statedFamily: typography?.fontFamily ?? null,
      permittedFamilies: typography?.fontFamilyOptions ?? null,
      profile: formatProfileFor(requirement?.constraints?.formatProfile ?? null),
      preferred: documentFont,
    })
  }, [requirement, documentFont])

  /**
   * THE FONT IS PART OF THE GEOMETRY, which is what makes a font change move
   * the page limit as well as the page: the line box, the content height and
   * the allowance the compliance rows are measured against all come from here.
   */
  const capabilities = useMemo(
    () => resolveRequirementCapabilities(requirement?.constraints ?? null, {
      metrics: fontChoice.selected.font.metrics,
      cssFamily: fontChoice.selected.font.cssFamily,
      sizePt: fontChoice.selected.sizePt,
    }),
    [requirement, fontChoice],
  )
  const pageGeometry = capabilities.geometry
  /**
   * Whether to write on a page rather than in a box.
   *
   * THE SCHOOL'S OWN RECORD DECIDES, through the resolver. A school that said
   * anything about the physical page gets one, because that is how the Studio
   * honours it. A school that states 500 words is measuring words, and a page
   * surface would invite the applicant to watch a number nobody asked for.
   */
  const paginated = capabilities.paginated
  /** Whether this draft is long enough to analyse, and what it would take. */
  const eligibility = eligibilityFor({ words, statedMaxWords: prompt.statedMaxWords })
  const canAnalyze = canAnalyzeNow({
    words,
    minimumWords: eligibility.kind === 'prompt-too-short'
      ? Number.MAX_SAFE_INTEGER
      : eligibility.minimumWords,
    running: analyzing,
    conflicted,
  })
  /**
   * A result that has stopped describing what is on screen.
   *
   * Compared against the essay CAPTURED when the request was made, so typing
   * during an analysis is caught even before autosave moves the revision.
   */
  const reviewStale = review !== null && reviewIsStale({
    analyzedRevision: review.revision,
    analyzedEssay: review.essay,
    currentRevision: save.revision,
    currentEssay: essay,
  })
  const essayOverLimit = overLimit({ words, statedMaxWords: prompt.statedMaxWords })

  // ---- the structured requirement, when this draft has one ----------------
  //
  // EVERY NUMBER BELOW IS DERIVED, NEVER STORED. The counters recompute from
  // the text in the textarea on each render, exactly as `words` does, so they
  // cannot drift from what is on screen.
  //
  // THE ELIGIBILITY SHOWN HERE IS A COURTESY, NOT THE CONTROL. The endpoint
  // decides and refuses; this exists so an applicant sees "320 of 500
  // characters needed" instead of pressing a button that fails.
  const requirementCounts = requirement === null ? [] : liveCounts(requirement.constraints)
  const requirementLimits = requirement === null ? [] : labelledConstraints(requirement.constraints)
  // THE SCHOOL'S OWN SENTENCES ABOUT LENGTH, and its policy of not reading past
  // the limit. Both exist because a register is a judgement somebody made and
  // the applicant is entitled to the wording it was made from.
  // ONLY WHAT IS ATTRIBUTABLE, AND NOT BY ASKING THE SNAPSHOT.
  //
  // AN EARLIER VERSION OF THIS LINE GATED ON requirement.verification.verbatim
  // AND THAT WAS WRONG. The snapshot is the applicant's own row: they hold
  // table-level UPDATE on it through PostgREST, so a `verification` object that
  // says "verbatim" is worth nothing, and this editor takes every claim of
  // STANDING from the server's verdict instead -- which is the rule a test in
  // access.test.ts pins and which that line broke.
  //
  // THE DISTINCTION STILL HOLDS, from a field the digest covers and provenance
  // authenticates: statedWordings() withholds a summarised length by itself, so
  // nothing reaches this heading that is not offered as a quotation.
  const requirementWordings = requirement === null ? [] : statedWordings(requirement.constraints)
  const requirementTruncation = requirement === null
    ? null
    : truncationNotice(requirement.constraints)
  // A LENGTH SHOWN AND NOT CHECKED. Its own notice, because the generic
  // advisory sentence does not explain why no counter is watching it -- and a
  // DIFFERENT notice when what is shown is a recorded summary rather than the
  // school's sentence, because then there are two open questions and not one.
  const requirementUnenforcedNotice = requirement === null
    ? null
    : unenforcedLengthNotice(requirement.constraints)
  const requirementAdvisory = requirement !== null && hasAdvisoryLength(requirement.constraints)
  const requirementEligibility = requirement === null ? null : eligibilityForRequirement({
    constraints: requirement.constraints, words,
  })
  // A CHARACTER MAXIMUM THE WORD FLOOR CANNOT FIT INSIDE. Explained rather than
  // legislated: the endpoint refuses these, and this is where the applicant
  // reads why instead of chasing a word target their school's limit excludes.
  const floorUnreachable = requirement !== null && !wordFloorFits(requirement.constraints)
  /**
   * What the panel says about where these instructions stand.
   *
   * THE SERVER'S VERDICT DECIDES, not the snapshot's own verification field.
   * An authenticated requirement is the school's current published one and
   * needs no caveat. Anything else is a saved copy -- which covers a school
   * that reworded its prompt, an entry withdrawn from the catalog, a set
   * nobody has verified, and a row somebody edited directly -- and is labelled
   * as one rather than presented as official.
   */
  const requirementWarning = requirement === null || requirementAuthentic
    ? null
    : SAVED_COPY_NOTICE

  /**
   * What the results block renders: the real analysis, or a sample.
   *
   * ONE BLOCK, TWO SOURCES, AND THE REAL ONE ALWAYS WINS. A sample is shown
   * only while there is no real result, so running a genuine analysis replaces
   * it and nothing can leave a sample on screen beside real feedback. Feeding
   * the same markup from both is the point of the preview: what the owner
   * approves is the interface, not a drawing of it.
   */
  const sample = sampleReviews === null ? null : {
    review: sampleKind === 'school' ? sampleReviews.school : sampleReviews.general,
    revision: save.revision,
    words: sampleKind === 'school' ? SAMPLE_SCHOOL_WORDS : SAMPLE_GENERAL_WORDS,
    overLimit: sampleKind === 'school',
    statedMaxWords: sampleKind === 'school' ? SAMPLE_SCHOOL_MAX_WORDS : null,
    provenance: (sampleKind === 'school' ? 'catalog' : null) as 'catalog' | null,
    essay,
  }
  /**
   * What the Analyze control should offer.
   *
   * 'view' means an analysis of exactly this essay and prompt is already
   * stored, so the button opens it rather than paying for it again.
   */
  const analysisAction: AnalysisAction = priorAnalysis?.action ?? 'analyze'

  const shown = review ?? sample
  const showingSample = review === null && sample !== null

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
              {/*
                THE SCHOOL'S OWN COUNTER, FIRST, when it stated one. A 2,500
                CHARACTER limit means an applicant watching a word count is
                watching the wrong number, so the unit the school used leads.
                The storage ceiling below is a different fact and stays.
              */}
              {requirement !== null && requirementCounts.map((kind) => {
                /*
                  COLOURED BY THE SAME BOUNDS THAT PRODUCED THE NUMBER.

                  This was grey at every count, because the only thing that
                  warned read a legacy single maximum carried on the draft --
                  null for every structured requirement. A school asking for
                  100-200 words therefore showed "154 / 200" and never warned
                  at 201, and never said anything at all at 99.
                */
                const status = liveCountStatus({
                  kind, constraints: requirement.constraints, words, text: essay,
                })
                const tone = status === 'over' || status === 'under'
                  ? 'text-amber-300'
                  : status === 'within' ? 'text-emerald-300' : 'text-slate-300'
                return (
                  <span key={kind} className="contents">
                    <span aria-hidden="true">·</span>
                    <span className={`font-semibold ${tone}`}>
                      {liveCountLabel({
                        kind, constraints: requirement.constraints, words, text: essay,
                      })}
                      {/* THE VERDICT IN WORDS, not colour alone: the count and
                          the bound are both numbers, and which side of the
                          bound you are on should not need a legend.

                          WORDED BY THE REGISTER, NOT BY THE STATUS. These two
                          lines used to read the status alone and say "over the
                          maximum" for a school that published a length rather
                          than a limit. liveCountVerdict() owns the sentence. */}
                      {liveCountVerdict({
                        kind, constraints: requirement.constraints, words, text: essay,
                      })}
                    </span>
                  </span>
                )
              })}
              {/*
                THE STORAGE CEILING, LABELLED AS ONE.

                IT USED TO READ "5 of 100,000 characters", WHICH IS A DIFFERENT
                NUMBER FROM THE ONE BESIDE IT. For a character-limited school
                this row shows two character counts under two different rules:
                UT Knoxville's limit excludes spaces, and this ceiling counts
                every character including them. Two numbers both labelled
                "characters", three centimetres apart, is the unexplained number
                this row is supposed to prevent -- so this one says whose limit
                it is and that spaces count toward it.
              */}
              <span aria-hidden="true">·</span>
              <span>
                {essay.length.toLocaleString('en-US')} of{' '}
                {savedCeiling.toLocaleString('en-US')} characters stored
                {requirement !== null && requirementCounts.includes('characters')
                  ? ' (this editor’s own limit, spaces included)'
                  : ''}
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
          {/* DERIVED, NOT WRITTEN DOWN. This sentence hardcoded "the AI analyzer
              is not built yet" and kept saying it above a working analysis
              (WK-QA-001). reviewAccess owns the wording for all three surfaces. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-2.5 text-xs text-slate-700">
            <span className="font-semibold text-slate-900">Internal preview</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span>{ANALYSIS_PREVIEW_NOTICE[previewOffer]}</span>
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
                  className={`${TOUCH_TARGET} rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-900 transition hover:bg-red-100`}
                >
                  Copy my version
                </button>
                <button
                  type="button"
                  onClick={() => void reloadLatest()}
                  disabled={reloading}
                  className={`${TOUCH_TARGET} rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60`}
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

          {/*
            A FAILED SAVE SAYS THE WORK IS SAFE FIRST, and offers the one action
            that moves it on. When the reason is an expired session it also
            offers the only thing that can actually fix it -- signing back in --
            because "Try again" alone would fail again for a reason the
            applicant has no way to guess.
          */}
          {canRetry && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3">
              <p className="text-sm text-red-900">
                {sessionExpired
                  ? 'Your session expired, so the last save did not go through. Your text is still here — sign in again, then try the save.'
                  : 'The last save did not go through. Your text is still here.'}
              </p>
              {sessionExpired && (
                /*
                  A NEW TAB, DELIBERATELY. Navigating this one away would take
                  the unsaved text with it; signing in beside the editor leaves
                  the work on screen and makes Try again work when they return.
                */
                <a
                  href="/login"
                  target="_blank"
                  rel="noopener"
                  className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
                >
                  Sign in again
                </a>
              )}
              <button
                type="button"
                onClick={retrySave}
                className={`${TOUCH_TARGET} ${sessionExpired
                  ? 'rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-semibold text-red-800 transition hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2'
                  : 'rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2'}`}
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
                {/*
                  ONE EDITOR, FOR EVERY DRAFT.
                  
                  ---------------------------------------------------------------
                  IT USED TO BE TWO, AND THAT WAS THE BOLD BUG
                  ---------------------------------------------------------------
                  This was `paginated ? <PaginatedEditor/> : <textarea/>`, where
                  `paginated` is true only when the school said something about
                  the physical page -- a page bound, a spacing, a font size, a
                  margin, or an APA profile. Everything else got a plain
                  textarea: a school stating 500 words, a user-provided prompt,
                  a General Statement.
                  
                  A textarea has no Bold. So Bold appeared for some schools and
                  not others, with no rule an applicant could learn, which is
                  exactly what the owner reported. The editing surface was being
                  chosen by a LAYOUT fact.
                  
                  Bold is an editing capability and belongs to every editable
                  draft. What the school stated still decides the LAYOUT -- the
                  geometry below, the allowance rule, the page readout -- and
                  that is the only thing it decides.
                  
                  THE STRING IS UNCHANGED EITHER WAY. The document model holds
                  paragraphs, text and bold, and its plain text is required to
                  equal `essay` -- so autosave, the revision compare-and-swap
                  and the analysis fingerprint see exactly what the textarea
                  gave them.
                */}
                <div className="rounded-b-2xl bg-slate-100 px-4 py-6">
                  <PaginatedEditor
                    essay={essay}
                    geometry={pageGeometry}
                    /* ONLY WHEN A SCHOOL STATED ONE. The allowance rule is a
                       school's limit drawn on the page; a draft with no page
                       maximum has nothing to draw and gets no line. */
                    maxPages={capabilities.pages?.max ?? null}
                    readOnly={conflicted}
                    onEssayChange={onEssayChange}
                    onDocumentChange={onDocumentChange}
                    initialDocument={editorDocument}
                    fontChoice={fontChoice}
                    onFontChange={onFontChange}
                    onMeasure={(measured) => {
                      setContentHeightPt(measured.contentHeightPt)
                      setPagesUsed(measured.pagesUsed)
                    }}
                  />
                </div>
              </div>

              {/*
                THE LIVE REQUIREMENTS PANEL, for a draft written on a page.
                
                It sits directly under the sheet because the figure it carries --
                "1.21 / 1.50 pages" -- is about what is on that sheet, and a
                reader checking their length should not have to look away from
                it. Only rendered when the school measures pages; the word and
                character counters below already serve the other bases.
              */}
              {paginated && requirement !== null && (
                <div className="mt-3">
                  <RequirementsPanel
                    schoolName={requirement.label}
                    capabilities={capabilities}
                    measurements={{
                      words,
                      // THE CANONICAL COUNTER, which honours this school's own
                      // spacesCount flag -- the same rule liveCountLabel uses,
                      // so the panel and the counter cannot disagree.
                      characters: characterCount(
                        essay, requirement.constraints.characters?.spacesCount ?? null),
                      contentHeightPt,
                      pagesUsed,
                    }}
                  />
                </div>
              )}

              {/*
                THE SINGLE STATED MAXIMUM, when that is all this draft has.
                Withdrawn for structured requirements -- see `limit` above.

                AND IT SAYS WHOSE NUMBER IT IS. For a prompt the applicant
                pasted, this figure came from an optional field they filled in,
                not from the school; calling it a "stated word limit" with no
                owner let their own guess read as a requirement.
              */}
              {limit !== null && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-white px-5 py-3">
                  <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-slate-700">
                      {userProvidedPrompt ? 'Word limit you entered' : 'Stated word limit'}
                    </span>
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
                    aria-label={userProvidedPrompt
                      ? 'Words against the limit you entered'
                      : "Words against the school's stated limit"}
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
              {/* ================================================= the analysis */}
              {/*
                BELOW THE WRITING AREA, NOT BESIDE IT. Feedback is long and
                wants the full column width; putting it in the reference panel
                would have squeezed both. Nothing above moves when it appears.
              */}
              {shown !== null && (
                <section aria-labelledby="analysis-heading" className="mt-6">
                  <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                    {/*
                      SAID PLAINLY, AT THE TOP, BEFORE ANY NUMBER. A reader who
                      scrolled past this and believed a sample score was theirs
                      would be the one failure this preview must not have.
                    */}
                    {showingSample && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-2xl border-b border-amber-300 bg-amber-100 px-6 py-3">
                        <p className="text-xs font-bold text-amber-900">{SAMPLE_NOTICE}</p>
                        <div className="flex items-center gap-1 rounded-lg bg-white/70 p-0.5">
                          <button
                            type="button"
                            onClick={() => setSampleKind('school')}
                            aria-pressed={sampleKind === 'school'}
                            className={`${TOUCH_TARGET} rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                              sampleKind === 'school' ? 'bg-amber-900 text-white' : 'text-amber-900'
                            }`}
                          >
                            School-specific (7)
                          </button>
                          <button
                            type="button"
                            onClick={() => setSampleKind('general')}
                            aria-pressed={sampleKind === 'general'}
                            className={`${TOUCH_TARGET} rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                              sampleKind === 'general' ? 'bg-amber-900 text-white' : 'text-amber-900'
                            }`}
                          >
                            General (6)
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
                      <div className="min-w-0">
                        <h2 id="analysis-heading" className="text-sm font-bold text-slate-900">
                          Analysis
                        </h2>
                        <p className="mt-0.5 text-xs text-slate-500">
                          Revision {shown.revision} &middot; {shown.words.toLocaleString('en-US')} words
                          {provenanceLabel(shown.provenance) === null
                            ? ''
                            : ` \u00b7 ${provenanceLabel(shown.provenance)}`}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-3xl font-bold tracking-tight text-slate-900">
                          {shown.review.overall}
                          <span className="text-base font-semibold text-slate-400">/100</span>
                        </p>
                        <p className="text-[11px] text-slate-500">weighted score</p>
                      </div>
                    </div>

                    {/*
                      STALE IS LABELLED, NEVER DISCARDED. The feedback was
                      accurate about the revision it names; it simply is not
                      about the one on screen, so it is marked and a fresh run
                      is offered rather than forced.
                    */}
                    {!showingSample && reviewStale && (
                      <p className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-xs text-amber-900">
                        {REVIEW_MESSAGES.stale}{' '}
                        <button
                          type="button"
                          onClick={() => void analyze()}
                          disabled={!canAnalyze}
                          className={`${TOUCH_TARGET} font-semibold underline underline-offset-2 disabled:no-underline disabled:opacity-60`}
                        >
                          Analyze the current draft
                        </button>
                      </p>
                    )}

                    {(shown.overLimit || (!showingSample && essayOverLimit)) && (
                      <p className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-xs font-medium text-amber-900">
                        {REVIEW_MESSAGES.overLimit}
                        {shown.statedMaxWords === null
                          ? ''
                          : ` The stated maximum is ${shown.statedMaxWords.toLocaleString('en-US')} words.`}
                      </p>
                    )}

                    <div className="px-6 py-5">
                      <p className="text-sm leading-relaxed text-slate-800">
                        {shown.review.overallAssessment}
                      </p>

                      <div className="mt-5 grid gap-4 sm:grid-cols-2">
                        <div>
                          <h3 className="text-xs font-bold uppercase tracking-wide text-emerald-700">
                            Strengths
                          </h3>
                          <ul className="mt-2 grid gap-1.5">
                            {shown.review.strengths.map((item) => (
                              <li key={item} className="text-sm leading-relaxed text-slate-700">{item}</li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <h3 className="text-xs font-bold uppercase tracking-wide text-amber-700">
                            Top priorities
                          </h3>
                          <ul className="mt-2 grid gap-1.5">
                            {shown.review.priorities.map((item) => (
                              <li key={item} className="text-sm leading-relaxed text-slate-700">{item}</li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      <h3 className="mt-6 text-xs font-bold uppercase tracking-wide text-slate-500">
                        Next steps
                      </h3>
                      <ul className="mt-2 grid gap-1.5">
                        {shown.review.nextSteps.map((item) => (
                          <li key={item} className="text-sm leading-relaxed text-slate-700">{item}</li>
                        ))}
                      </ul>

                      {/*
                        PROGRESSIVE DISCLOSURE. Seven categories of evidence,
                        explanation and recommendation is a great deal of prose;
                        the scores are all visible at a glance and the detail
                        opens one at a time.
                      */}
                      <h3 className="mt-6 text-xs font-bold uppercase tracking-wide text-slate-500">
                        Categories
                      </h3>
                      <ul className="mt-2 grid gap-2">
                        {RUBRIC.map((category) => {
                          const scored = shown.review.categories.find((c) => c.id === category.id)
                          if (scored === undefined) {
                            return (
                              <li key={category.id} className="rounded-xl border border-slate-200 px-4 py-3">
                                <p className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-sm font-semibold text-slate-500">{category.label}</span>
                                  <span className="text-xs text-slate-500">{NOT_ASSESSED}</span>
                                </p>
                              </li>
                            )
                          }
                          const open = openCategory === category.id
                          return (
                            <li key={category.id} className="rounded-xl border border-slate-200">
                              <button
                                type="button"
                                aria-expanded={open}
                                onClick={() => setOpenCategory(open ? null : category.id)}
                                className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                              >
                                <span className="text-sm font-semibold text-slate-900">{category.label}</span>
                                <span className="flex items-center gap-2">
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                                    scored.band === 'strong' ? 'bg-emerald-100 text-emerald-800'
                                      : scored.band === 'developing' ? 'bg-amber-100 text-amber-800'
                                      : 'bg-rose-100 text-rose-800'
                                  }`}>
                                    {BAND_LABELS[scored.band]}
                                  </span>
                                  <span className="text-sm font-bold tabular-nums text-slate-900">
                                    {scored.score}/10
                                  </span>
                                </span>
                              </button>
                              {open && (
                                <div className="border-t border-slate-200 px-4 py-3">
                                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                                    {scored.evidenceFound ? 'From your draft' : 'Not found in your draft'}
                                  </p>
                                  {/* The verbatim passage, verified against the
                                      stored essay before it was ever returned.
                                      Rendered as escaped text. */}
                                  {scored.excerpt !== null && (
                                    <blockquote className="mt-1 border-l-2 border-slate-300 pl-3 whitespace-pre-wrap break-words text-sm italic leading-relaxed text-slate-800">
                                      {scored.excerpt}
                                    </blockquote>
                                  )}
                                  {/* And what it shows, which is prose about
                                      the passage rather than the passage. */}
                                  <p className={`mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed ${
                                    scored.evidenceFound ? 'text-slate-700' : 'text-slate-600'
                                  }`}>
                                    {scored.evidence}
                                  </p>
                                  <p className="mt-3 text-sm leading-relaxed text-slate-700">
                                    {scored.explanation}
                                  </p>
                                  {/*
                                    THE PROMPT'S REQUIREMENTS, ONE BY ONE. This
                                    is what stops "the prompt is addressed"
                                    standing in for a judgement: an applicant
                                    can see which parts of the question their
                                    draft actually answers.
                                  */}
                                  {scored.components.length > 0 && (
                                    <ul className="mt-3 grid gap-2">
                                      {scored.components.map((part) => (
                                        <li key={part.component} className="rounded-lg border border-slate-200 px-3 py-2">
                                          <p className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-xs font-semibold text-slate-800">
                                              {part.component}
                                            </span>
                                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                                              part.status === 'addressed' ? 'bg-emerald-100 text-emerald-800'
                                                : part.status === 'weak' ? 'bg-amber-100 text-amber-800'
                                                : 'bg-rose-100 text-rose-800'
                                            }`}>
                                              {part.status}
                                            </span>
                                          </p>
                                          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">
                                            {part.evidence}
                                          </p>
                                        </li>
                                      ))}
                                    </ul>
                                  )}

                                  <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm leading-relaxed text-blue-900">
                                    {scored.recommendation}
                                  </p>
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>

                      <p className="mt-5 text-[11px] leading-relaxed text-slate-500">
                        These scores are writing-development indicators, not an admission
                        probability or a prediction of any committee&rsquo;s decision.
                      </p>
                    </div>
                  </div>
                </section>
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
                  {/*
                    THE HEADING ITSELF CARRIES THE PROVENANCE.

                    "Your school's prompt" is a claim, and for a prompt the
                    applicant pasted or reported it is the wrong one -- nobody
                    has checked that wording against the school. Calling it
                    theirs is both accurate and the only version of this panel
                    that cannot be misread by someone who never scrolls.
                  */}
                  <h2 id="prompt-heading" className="text-sm font-bold text-slate-900">
                    {userProvidedPrompt ? 'Your prompt' : <>Your school&rsquo;s prompt</>}
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {!hasPrompt
                      ? 'Attaching a school prompt is optional — a general statement needs none.'
                      : userProvidedPrompt
                        ? 'The question you gave us. CRNAPREPHUB has not verified it with the school.'
                        : 'The question this draft answers.'}
                  </p>
                  {/*
                    AND THE BADGE SITS WITH THE HEADING, not further down the
                    panel where it was before. The applicant has to meet it
                    before they read the wording, not after.
                  */}
                  {userProvidedPrompt && promptNotice !== null && (
                    <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-900">
                      {promptNotice}
                    </p>
                  )}
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

                      {/*
                        WHICH DOCUMENT THIS IS, when the school asks for more
                        than one. Without it an applicant with three drafts
                        open cannot tell which tab is the diversity essay.
                      */}
                      {requirement !== null && (
                        <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-bold text-slate-900">
                            {requirement.label}
                          </span>
                          <span className="text-[11px] font-medium text-slate-500">
                            {DOCUMENT_TYPE_LABELS[requirement.documentType]}
                          </span>
                        </p>
                      )}

                      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                        {prompt.promptText}
                      </p>

                      {/*
                        THE SCHOOL'S QUESTIONS, TOGETHER, INSIDE THE ONE PANEL.
                        One essay answers all of them, so they belong in this
                        document's panel rather than becoming documents of their
                        own. An optional one is marked, because omitting it is
                        not a gap.
                      */}
                      {requirement !== null && requirement.components.length > 0 && (
                        <>
                          <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                            This essay must address{' '}
                            {requirement.components.filter((part) => !part.optional).length}
                            {' '}
                            {requirement.components.filter((part) => !part.optional).length === 1
                              ? 'question'
                              : 'questions'}
                          </p>
                          <ol className="mt-2 grid gap-2">
                            {requirement.components.map((part, index) => (
                              <li
                                key={part.id}
                                className="flex gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-700"
                              >
                                <span className="font-semibold text-slate-400">{index + 1}.</span>
                                <span>
                                  {part.optional && (
                                    <span className="mr-1.5 rounded border border-slate-300 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                      Optional
                                    </span>
                                  )}
                                  {part.text}
                                </span>
                              </li>
                            ))}
                          </ol>
                        </>
                      )}

                      {/*
                        THE LIMITS, IN THREE VISIBLY DIFFERENT REGISTERS.
                        A solid chip is a number the counter is watching, a soft
                        one is something the editor applies by rendering the
                        page, and an outlined one sits under a label saying it
                        is the applicant's to apply. An applicant must never
                        read a page count as something we are tracking for
                        them, nor a type size we typeset as homework.

                        THE SAME COMPONENT THE CHECKLIST USES. See
                        constraintChips.tsx.
                      */}
                      {requirement !== null && (
                        <ConstraintChips limits={requirementLimits} />
                      )}

                      {/*
                        THE LEGACY LINE, for a draft with no structured
                        requirement. Unchanged, and still the only length line
                        such a draft has ever shown.
                      */}
                      {requirement === null && (
                        <p className="mt-2 text-xs text-slate-500">
                          {wordLimitLabel(prompt.statedMaxWords, promptOrigin)}
                        </p>
                      )}

                      {/*
                        AND NO SENTENCE RESTATING THEM.

                        A blanket line here once told every applicant that this
                        editor "counts words and characters only" and could not
                        check pages, spacing, font or margins -- true of a
                        textarea, false of a page the Studio lays out. What
                        replaced it named only the fields a human still had to
                        handle, and was then a word-for-word second copy of the
                        chips immediately above.

                        THE GROUP LABEL ON THE CHIPS SAYS IT INSTEAD, once,
                        naming nothing twice.
                      */}

                      {/*
                        A LENGTH THAT IS NOT A LIMIT, SAID ONCE.

                        WITHOUT THIS THE NUMBER CARRIES THE WHOLE MESSAGE. "250
                        words suggested" is accurate and is also, at a glance,
                        just a number next to a counter -- and an applicant who
                        reads it as a cap will cut an essay to it. So the
                        distinction is stated in a sentence, and the school's own
                        wording is shown underneath it.
                      */}
                      {/*
                        THE UNENFORCED LENGTH FIRST, when there is one. It is the
                        more specific statement and it answers the question the
                        applicant actually has -- "why is nothing counting this?"
                        -- so the generic advisory sentence stands down for it
                        rather than both appearing.
                      */}
                      {requirementUnenforcedNotice !== null && (
                        <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                          {requirementUnenforcedNotice}
                        </p>
                      )}

                      {requirementAdvisory && requirementUnenforcedNotice === null && (
                        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                          {ADVISORY_LENGTH_NOTICE}
                        </p>
                      )}

                      {requirementWordings.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {requirementWordings.map((wording) => (
                            <li
                              key={wording}
                              className="text-[11px] leading-relaxed text-slate-500"
                            >
                              <span className="font-medium text-slate-600">
                                The school&rsquo;s wording:
                              </span>
                              {' '}
                              &ldquo;{wording}&rdquo;
                            </li>
                          ))}
                        </ul>
                      )}

                      {/*
                        THE SCHOOL'S TRUNCATION POLICY, AS A POLICY.

                        NOT A VERDICT ON THIS DRAFT. The truncated bound is a
                        page count in every verified example, and this editor
                        has no pages -- so this says what the school said and
                        makes no claim about whether this draft passes it.
                      */}
                      {requirementTruncation !== null && (
                        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                          {requirementTruncation}
                        </p>
                      )}

                      {/* WHAT IS STILL NEEDED, in the school's own unit. */}
                      {floorUnreachable && (
                        <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                          {FLOOR_UNREACHABLE}
                        </p>
                      )}
                      {!floorUnreachable && requirementEligibility !== null
                        && shortfallLabel(requirementEligibility) !== null && (
                        <p className="mt-2 text-[11px] font-medium text-slate-500">
                          {shortfallLabel(requirementEligibility)}
                        </p>
                      )}
                      {requirementEligibility !== null
                        && tooShortLabel(requirementEligibility) !== null && (
                        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                          {tooShortLabel(requirementEligibility)}
                        </p>
                      )}

                      {/* PROVENANCE, SAID PLAINLY. */}
                      {requirementWarning !== null && (
                        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                          {requirementWarning}
                        </p>
                      )}

                      {/* UNRESOLVED CONFLICT IS SHOWN, NOT RESOLVED. */}
                      {requirement !== null && requirement.notes.length > 0 && (
                        <ul className="mt-2 grid gap-1.5">
                          {requirement.notes.map((note) => (
                            <li
                              key={note}
                              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900"
                            >
                              {note}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/*
                    WHERE THE WORDING CAME FROM. Worded on the server, where the
                    submission can actually be resolved, and null for a catalog
                    prompt and for a general draft -- which is every draft while
                    the submission feature is switched off. Rendered as escaped
                    text, never as markup.
                  */}
                  {/*
                    MOVED TO THE HEADING, above. One badge, where it is read.
                  */}

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
                      className={`${TOUCH_TARGET} mb-4 w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
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
                THE REAL ACTION. The placeholder that stood here said "coming
                soon" because nothing was behind it; this is behind it now.
              */}
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                <p className="text-sm font-bold text-slate-900">Analyze this draft</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  {prompt.promptText === null
                    ? 'Six categories of feedback on your writing. Attach a school prompt to add prompt alignment.'
                    : 'Seven categories of feedback, including how well this answers your school\u2019s question.'}
                </p>

                {/*
                  THE PLAN, FIRST. A member whose plan does not include this
                  sees why, not a button that fails when they press it. The
                  endpoint refuses them regardless; this is the courtesy.
                */}
                {!analysisAllowed ? (
                  <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
                    {ANALYSIS_TIER_MESSAGE}
                  </p>
                ) : analysisAvailable === 'unavailable' ? (
                  /* No storage: refusing is honest, charging again is not. */
                  <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
                    {ANALYSIS_UNAVAILABLE_MESSAGE}
                  </p>
                ) : eligibility.kind === 'prompt-too-short' ? (
                  <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                    {REVIEW_MESSAGES.promptTooShort}
                  </p>
                ) : (
                  <>
                    {/*
                      WHAT THE CLICK COSTS, BEFORE THE CLICK. On localhost the
                      analyser is the real one and the request is billed, so
                      this sits above the button rather than beside the result.
                      It is withdrawn when the button would open a stored result
                      instead, because that makes no request.
                    */}
                    {localRealAi && analysisAction !== 'view' && (
                      <p className="mt-3 rounded-xl border-2 border-amber-400 bg-amber-50 px-3 py-2.5 text-xs font-semibold leading-relaxed text-amber-900">
                        {LOCAL_REAL_AI_WARNING}
                      </p>
                    )}
                    {/*
                      VIEWING A STORED RESULT MAKES NO REQUEST. That analysis
                      already happened and was already paid for; opening it is
                      reading, not analysing, so this branch calls nothing.
                    */}
                    <button
                      type="button"
                      onClick={() => {
                        if (analysisAction === 'view' && priorAnalysis !== null) {
                          setReview({ ...priorAnalysis.result, essay })
                          setOpenCategory(null)
                          return
                        }
                        void analyze()
                      }}
                      disabled={analysisAction === 'view' ? false : !canAnalyze}
                      className="mt-3 w-full rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {analyzing
                        ? 'Analyzing\u2026'
                        : review !== null && analysisAction !== 'reanalyze'
                          ? 'Analyze again'
                          : ANALYSIS_ACTION_LABELS[analysisAction]}
                    </button>
                    {analysisAction === 'view' && review === null && (
                      <p className="mt-2 text-xs text-slate-500">
                        This draft has not changed since it was analyzed.
                      </p>
                    )}
                    {!canAnalyze && !analyzing && eligibility.kind === 'too-short' && (
                      <p className="mt-2 text-xs text-slate-500">
                        {words.toLocaleString('en-US')} of {eligibility.minimumWords.toLocaleString('en-US')} words needed.
                      </p>
                    )}
                    {conflicted && (
                      <p className="mt-2 text-xs text-slate-500">
                        Resolve the conflict above before analyzing.
                      </p>
                    )}
                  </>
                )}

                {/*
                  LABELLED, AND PROMISING NOTHING ABOUT REUSE.
                  Locally the real model is called and the result IS kept -- in
                  a gitignored file, not in production -- so the no-cache
                  sentence would be false there and this one is shown instead.
                */}
                {localRealAi ? (
                  <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                    {LOCAL_REAL_AI_NOTICE}
                  </p>
                ) : analysisAvailable === 'development-no-cache' && (
                  <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                    {ANALYSIS_NO_CACHE_NOTICE}
                  </p>
                )}

                {reviewError !== null && (
                  <p role="alert" className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                    {reviewError}
                  </p>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}
