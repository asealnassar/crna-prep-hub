import {
  hasUnsavedWork, nextAction, type AutosaveAction, type AutosaveState,
} from '../../resume/draft/autosave.ts'
import {
  checkDraftUpdate, checkPromptSelection, checkTitle,
  type DraftRefusal, type DraftUpdateInput,
  type PromptSelection, type PromptSelectionRefusal,
} from './validate.ts'
import { isDraftId } from './http.ts'
import { draftPromptFrom, parseStoredRevision } from './rows.ts'
import type { DraftPromptSnapshot } from './rows.ts'
import { SAVE_MESSAGES } from './save.ts'
import { MAX_SAVED_CHARS } from '../extract/limits.ts'

/**
 * The Statement editor's driver logic, with no React and no clock in it.
 *
 * lib/resume/draft/autosave.ts decides WHEN to save. This decides whether the
 * document may be saved at all, exactly what goes on the wire, and what the
 * applicant is told -- three things the shared engine deliberately knows nothing
 * about, because it holds no domain model.
 *
 * WHY A STATEMENT-OWNED STATUS LAYER EXISTS. The shared engine stores a
 * Resume-specific sentence in `state.error` when a conflict happens. Its own
 * describe() never reads that field in the conflict branch, so Resume Studio
 * never shows it -- but "the current implementation happens not to read it" is
 * not a guarantee. statementStatus() below is the guarantee: it never reads
 * `error` on a conflict, and on a failure it renders `error` only when the
 * string is one this codebase chose. Anything else becomes a generic refusal.
 *
 * BROWSER-SAFE. autosave.ts imports nothing at all; validate.ts imports only
 * limits.ts (bare numbers); save.ts imports a type and one parser. No next/*,
 * no node:*, no Supabase.
 */

/** What the applicant is told while a document cannot be saved as it stands. */
export const BLOCKED_MESSAGES: Readonly<Record<DraftRefusal, string>> = {
  'invalid-title': 'This draft needs a title before it can be saved.',
  'title-too-long': 'That title is too long to save. Shorten it and saving resumes.',
  'invalid-essay': 'This editor can only save text.',
  'essay-too-long': `That is longer than ${MAX_SAVED_CHARS.toLocaleString('en-US')} characters, which is as much as a draft can hold. Shorten it and saving resumes.`,
  'invalid-revision': 'This draft cannot be saved against the version it was opened at. Reload it.',
}

/**
 * The one extra thing a save can be blocked on once a prompt may travel with it.
 *
 * A SEPARATE CONSTANT, AND BLOCKED_MESSAGES IS UNCHANGED. That map is
 * Record<DraftRefusal, string>, and 'invalid-prompt' is deliberately not a
 * member of DraftRefusal -- http.ts keys VALIDATION_MESSAGES and
 * statusForValidation on the same union, so widening it would change the type
 * of both for a code only this builder and the PATCH route can produce.
 * Checkpoint D drew that line; this keeps it.
 *
 * AND IT SHOULD NEVER BE SEEN. A prompt id reaching this builder came from the
 * editor's own state, not from a request, so a refusal here is this
 * application's bug rather than the applicant's mistake. The words say what to
 * do about it rather than blaming them for it.
 */
export const PROMPT_BLOCKED_MESSAGE =
  'That prompt selection could not be saved. Reload the page and choose it again.'

/** Every code a save request can be refused with, and what it reads as. */
export const SAVE_BLOCKED_MESSAGES: Readonly<
  Record<DraftRefusal | PromptSelectionRefusal, string>
> = {
  ...BLOCKED_MESSAGES,
  'invalid-prompt': PROMPT_BLOCKED_MESSAGE,
}

/** Statement's own words. The shared engine's describe() is not used. */
export const STATEMENT_STATUS = {
  clean: 'Saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  retrying: 'Save failed — retrying',
  failed: 'Not saved',
  /**
   * STATEMENT'S CONFLICT WORDING, and the reason this module exists. The shared
   * engine's `state.error` says "This resume was changed somewhere else." That
   * sentence must never reach a statement editor, so the conflict branch of
   * statementStatus() does not read `error` at all.
   */
  conflict: 'This draft changed somewhere else. Reload it before continuing.',
} as const

/**
 * The only server-supplied strings this editor will render.
 *
 * `state.error` is set from two places: a save-failed event's `reason`, which
 * this driver takes from saveEventFrom() and is therefore one of these; and the
 * engine's own conflict assignment, which is not. Whitelisting rather than
 * blacklisting means a sentence added to the shared engine later is also
 * refused, without this file having to learn about it.
 */
const RENDERABLE_ERRORS: ReadonlySet<string> = new Set(Object.values(SAVE_MESSAGES))

export interface StatementStatus {
  readonly text: string
  /** Autosave will not resume without the applicant doing something. */
  readonly frozen: boolean
  /** Work exists that the server has not confirmed. */
  readonly unsaved: boolean
}

/**
 * What the indicator shows.
 *
 * `blocked` is this driver's own refusal -- the document is not currently
 * saveable -- and is not frozen: it clears itself the moment the applicant edits
 * back into range. A conflict IS frozen, and so is an exhausted failure.
 */
export function statementStatus(state: AutosaveState, blocked: string | null): StatementStatus {
  if (state.status === 'conflict') {
    // NO `state.error` HERE. Ever.
    return { text: STATEMENT_STATUS.conflict, frozen: true, unsaved: true }
  }
  if (typeof blocked === 'string' && blocked.length > 0) {
    return { text: blocked, frozen: false, unsaved: true }
  }
  switch (state.status) {
    case 'clean':
      return { text: STATEMENT_STATUS.clean, frozen: false, unsaved: false }
    case 'dirty':
      return { text: STATEMENT_STATUS.dirty, frozen: false, unsaved: true }
    case 'saving':
      return { text: STATEMENT_STATUS.saving, frozen: false, unsaved: true }
    case 'saved':
      return { text: STATEMENT_STATUS.saved, frozen: false, unsaved: false }
    case 'retrying':
      return { text: STATEMENT_STATUS.retrying, frozen: false, unsaved: true }
    case 'failed': {
      const reason = state.error
      const safe = typeof reason === 'string' && RENDERABLE_ERRORS.has(reason)
      return {
        text: safe ? `${STATEMENT_STATUS.failed}: ${reason}` : STATEMENT_STATUS.failed,
        frozen: true,
        unsaved: true,
      }
    }
  }
}

/**
 * THE PATCH BODY. The document, and -- only when a prompt change is being made
 * -- one id.
 *
 * `promptId` IS OPTIONAL, AND ITS THREE STATES ARE THE SERVER'S THREE STATES:
 *
 *   absent            no prompt change. The stored snapshot keeps whatever it
 *                     holds, and this is what every keystroke sends.
 *   null              an explicit clear.
 *   a uuid            select that prompt.
 *
 * ABSENT IS NOT undefined. The key is omitted entirely rather than set to
 * undefined: JSON.stringify would drop such a key anyway, but Object.keys would
 * report it, so a body that merely looked three-keyed would be four-keyed to
 * anything inspecting it. promptSelectionOf() on the route reads absence and
 * null as different instructions, and this is the half of that contract the
 * editor owns.
 *
 * AND ONLY THE ID. The school, the wording and the word limit are canonical --
 * the server resolves them from the catalog -- so there is no field for them
 * here and nothing to leave one in.
 */
export interface SaveBody extends DraftUpdateInput {
  readonly promptId?: string | null
}

/** A saveable document, or why it is not one. */
export type SaveRequest =
  | { readonly ok: true; readonly body: SaveBody }
  | {
      readonly ok: false
      readonly code: DraftRefusal | PromptSelectionRefusal
      readonly message: string
    }

/**
 * The exact PATCH body, and the only place it is built.
 *
 * checkDraftUpdate() is the SAME function the route validates with, so the
 * editor cannot disagree with the API about what is saveable. Its normalised
 * result is the payload: exactly title, essay and expectedRevision. Nothing
 * here adds an id, a userId, a timestamp, a school or a word limit -- the path
 * carries the id, the session carries the owner, and the database owns the rest.
 *
 * THE DOCUMENT IS VALIDATED FIRST, so the refusal order the existing tests pin
 * -- title, then essay, then revision -- is unchanged, and a body wrong in both
 * ways still reports the document's code.
 *
 * THE PROMPT IS BUILT ON TOP, NOT MERGED IN BY THE VALIDATOR.
 * checkDraftUpdate() returns exactly three fields and would discard a fourth,
 * so the body is ASSEMBLED here from its normalised result plus the id. That is
 * the whole reason this function does not simply forward `checked.input`.
 *
 * AN INVALID PROMPT IS A REFUSAL, NEVER A DROPPED FIELD. Silently omitting a
 * malformed id would turn "save this prompt" into "change nothing" -- a save
 * that reports success while the selection is quietly gone. checkPromptSelection
 * is the same validator the route reads bodies with.
 *
 * THE REVISION IS THE ENGINE'S, passed in from AutosaveState.revision, which is
 * only ever set from a server response. It is never incremented here, and a
 * prompt change does not add one: it travels inside the same compare-and-swap.
 */
export function statementSaveRequest(input: {
  title: string
  essay: string
  revision: number
  /** undefined / absent = no change, null = clear, a uuid = select. */
  prompt?: unknown
}): SaveRequest {
  const checked = checkDraftUpdate({
    title: input.title,
    essay: input.essay,
    expectedRevision: input.revision,
  })
  if (!checked.ok) {
    return { ok: false, code: checked.code, message: BLOCKED_MESSAGES[checked.code] }
  }

  const selection = checkPromptSelection(input.prompt)
  if (!selection.ok) {
    return { ok: false, code: selection.code, message: SAVE_BLOCKED_MESSAGES[selection.code] }
  }

  // THE KEY IS OMITTED on 'unchanged', present and null on 'clear', present and
  // a uuid on 'select'. Spreading {} adds nothing, which is what keeps an
  // ordinary keystroke's body byte-for-byte the three keys it has always been.
  return { ok: true, body: { ...checked.input, ...promptKey(selection.selection) } }
}

/**
 * The prompt half of a body: no key, a null, or an id.
 *
 * TYPED ON PromptSelection, so the three branches are the validator's three
 * states and the compiler -- not a cast -- is what guarantees `promptId` exists
 * on the one branch that reads it.
 */
function promptKey(selection: PromptSelection): { promptId?: string | null } {
  if (selection.kind === 'unchanged') return {}
  if (selection.kind === 'clear') return { promptId: null }
  return { promptId: selection.promptId }
}

// ------------------------------------------------- the save snapshot

/**
 * The document as it was when ONE request began.
 *
 * WHY BOTH TITLES. checkTitle trims, so the string that goes to the database is
 * not always the string on screen. `raw` is what the applicant could see at the
 * moment the request left; `sent` is what was actually persisted. Reconciliation
 * needs both: `raw` to recognise that nobody has typed since, and `sent` to know
 * what the field should now read.
 *
 * ONE SNAPSHOT BELONGS TO ONE REQUEST. It is taken before the fetch and is never
 * recomputed from React state afterwards -- state may have moved on, and the
 * whole point is to compare against what was true when the request started.
 * There is no queue: Statement sends the entire document every time.
 */
export interface SaveSnapshot {
  /** The visible title when this save began, untrimmed. */
  readonly raw: string
  /** The normalised title this save actually put in the database. */
  readonly sent: string
  /** The essay this save sent, verbatim. */
  readonly essay: string
  /** The revision this save was compared and swapped against. */
  readonly expectedRevision: number
}

export type SaveAttempt =
  | { readonly ok: true; readonly body: SaveBody; readonly snapshot: SaveSnapshot }
  | {
      readonly ok: false
      readonly code: DraftRefusal | PromptSelectionRefusal
      readonly message: string
    }

/**
 * The request body and the snapshot that belongs to it, built together so they
 * cannot disagree.
 *
 * NORMALISATION HAPPENS HERE AND NOWHERE ELSE -- inside checkDraftUpdate, the
 * same function the route validates with. The component never trims a title.
 */
export function saveAttemptFor(input: {
  title: string
  essay: string
  revision: number
  /** Forwarded verbatim to statementSaveRequest. See its three states. */
  prompt?: unknown
}): SaveAttempt {
  const request = statementSaveRequest(input)
  if (!request.ok) return request
  return {
    ok: true,
    body: request.body,
    // THE SNAPSHOT IS UNCHANGED, and deliberately carries NO prompt. It exists
    // for one job -- deciding what the title field should read once a save has
    // landed -- and titleAfterSave() compares `raw` against the live title and
    // nothing else. A prompt in here would be a value nothing reads, and would
    // invite a future reader to think reconciliation covers it. Which prompt
    // the draft answers comes back in the save RESPONSE, as it already does.
    snapshot: {
      raw: input.title,
      sent: request.body.title,
      essay: request.body.essay,
      expectedRevision: request.body.expectedRevision,
    },
  }
}

/**
 * What the title field should read once a save has succeeded, or null to leave
 * it exactly as it is.
 *
 * THE COMPARISON IS AGAINST `raw`, NOT `sent`. If it compared against the
 * normalised title, then an applicant who typed "My Statement " and then
 * corrected it to "My Statement" during the request would look identical to one
 * who typed nothing -- and the reconciliation would be a no-op in a case where
 * it happens not to matter, but the same reasoning applied to any other edit
 * would silently discard it. Comparing raw-to-raw asks the only question worth
 * asking: is what I can see still the document this response is about?
 *
 *   unchanged since the request  -> adopt `sent`, so Saved is honest
 *   changed since the request    -> null; the newer text is the applicant's and
 *                                  the next autosave will carry it
 *
 * Returning null when the field already equals `sent` keeps a settled editor
 * from re-rendering for nothing.
 */
export function titleAfterSave(input: {
  snapshot: SaveSnapshot | null
  currentTitle: string
}): string | null {
  const { snapshot, currentTitle } = input
  if (snapshot === null) return null
  if (currentTitle !== snapshot.raw) return null
  if (currentTitle === snapshot.sent) return null
  return snapshot.sent
}

/** What the driver should do, including "nothing, and schedule no timer". */
export type DriverAction =
  | AutosaveAction
  | { readonly kind: 'blocked'; readonly message: string }

/**
 * The shared engine's decision, gated by whether the document may be saved.
 *
 * ORDER MATTERS. nextAction() is asked first, so a clean document costs no
 * validation and an in-flight save is still reported idle -- single flight stays
 * the engine's rule, not a second one invented here.
 *
 * NO TIMER WHILE BLOCKED. When the document is unsaveable this returns 'blocked'
 * in place of BOTH 'save' and 'wait', so the driver schedules nothing. An
 * applicant who pastes 25,000 characters and walks away produces no requests and
 * no timers at all -- the work stays on screen, visibly unsaved. The next
 * keystroke re-runs this, and the moment the document is back in range the
 * engine's ordinary wait resumes. That is what stops a temporarily invalid
 * document becoming a retry loop.
 */
export function statementDriverAction(input: {
  state: AutosaveState
  now: number
  title: string
  essay: string
}): DriverAction {
  const action = nextAction(input.state, input.now)
  if (action.kind === 'idle') return action

  const request = statementSaveRequest({
    title: input.title,
    essay: input.essay,
    revision: input.state.revision,
  })
  if (!request.ok) return { kind: 'blocked', message: request.message }
  return action
}

/**
 * This draft's API path. PATCH saves to it and the conflict reload GETs from
 * it, which is why the name is not "save": one draft, one address. The path
 * carries the id, so no payload ever has to.
 */
export function draftApiPath(id: string): string {
  return `/api/statement/drafts/${id}`
}

// ---------------------------------------------------------------- recovery

/**
 * Whether work has reached the server, definitely has not, or is still going.
 *
 * `null` is the important value: 'retrying' is neither a yes nor a no, and a
 * navigation waiter that treated it as either would leave the page mid-retry or
 * refuse to leave a page that was about to succeed.
 *
 * THIS IS A FUNCTION OF STATE ONLY. The waiter that uses it is resolved by
 * observing future transitions, never by reading the state that existed before
 * the dispatch that prompted the wait -- the bug called out in
 * app/resume-studio/components/studio/StudioClient.tsx's whenSettled().
 */
export function settleVerdict(state: AutosaveState): boolean | null {
  if (!hasUnsavedWork(state)) return true
  if (state.status === 'failed' || state.status === 'conflict') return false
  return null
}

/**
 * What the applicant is told while recovering. Fixed strings, chosen here.
 *
 * EVERY ONE SAYS THE LOCAL VERSION IS STILL THERE, because that is the fact
 * that matters when a reload has just failed and the screen still holds work
 * the server has never seen. A message that only said "could not load" would
 * leave somebody wondering whether their own text had gone with it.
 */
export const RELOAD_MESSAGES = {
  unreadable: 'The latest saved version could not be read. Your version is still here.',
  expired: 'Your session expired. Sign in again, then reload the latest saved version.',
  missing: 'This draft no longer exists on the server. Copy your version before you leave.',
  /** 5xx: the server's problem, so trying again may well work. */
  server: 'The server could not send the latest saved version. Your version is still here.',
  /** Anything else: the request was refused, and repeating it may not help. */
  refused: 'The latest saved version could not be loaded. Your version is still here.',
} as const

/** Copy outcomes. The clipboard is not guaranteed, so failure has words too. */
export const COPY_MESSAGES = {
  copied: 'Copied',
  failed: 'Could not copy automatically. Select the text in the editor and copy it.',
} as const

/** Why a guarded navigation did not happen. */
export const NAV_MESSAGES = {
  stayed: 'Your work is not saved yet, so you are still here. Resolve the notice above first.',
  blocked: 'Your work cannot be saved as it stands, so you are still here. Fix the notice above first.',
  modified:
    'Opening a copy in another tab would leave unsaved work behind here. Save or resolve this first.',
} as const

/**
 * A persisted draft, as the reload accepted it.
 *
 * THE PROMPT SNAPSHOT IS PART OF IT, and that is the whole point of widening
 * this type: a reload replaces what the editor is holding, so if it did not
 * carry the four prompt fields the editor would keep the LOSING revision's
 * prompt beside the winning revision's essay. The four come from
 * DraftPromptSnapshot, which is the same type rows.ts produces from a database
 * row -- one shape, one set of rules, both directions.
 */
export interface ReloadedDraft extends DraftPromptSnapshot {
  readonly id: string
  readonly title: string
  readonly essay: string
  readonly revision: number
}

export type ReloadOutcome =
  | { readonly ok: true; readonly draft: ReloadedDraft }
  | { readonly ok: false; readonly message: string }

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

/**
 * The reload response, accepted only if it is genuinely a usable draft.
 *
 * A 200 IS NOT ENOUGH. This replaces text the applicant can see and cannot get
 * back, so every field is checked before anything is handed over: the id must
 * be a uuid AND the one that was asked for, the title must satisfy the same
 * checkTitle the API validates with, the essay must be a string, and the
 * revision must survive parseStoredRevision -- the strict parser, so a null or a
 * '0' becomes a refusal rather than a fabricated 1.
 *
 * THE ID COMPARISON IS THE POINT OF `expectedId`. A proxy, a cache or a
 * mis-built URL that returned somebody else's draft would otherwise overwrite
 * this one's essay with it.
 *
 * Nothing the server said is read for display; the outcome carries one of the
 * fixed messages above.
 */
export function reloadOutcomeFrom(input: {
  status: number
  body: unknown
  expectedId: string
}): ReloadOutcome {
  const { status, body, expectedId } = input

  if (status >= 200 && status < 300) {
    const draft = field(body, 'draft')
    const id = field(draft, 'id')
    const title = field(draft, 'title')
    const essay = field(draft, 'essay')
    const revision = parseStoredRevision(field(draft, 'revision'))

    if (!isDraftId(id) || id !== expectedId) return { ok: false, message: RELOAD_MESSAGES.unreadable }
    if (typeof essay !== 'string') return { ok: false, message: RELOAD_MESSAGES.unreadable }
    if (revision === null) return { ok: false, message: RELOAD_MESSAGES.unreadable }
    const checked = checkTitle(title)
    if (!checked.ok) return { ok: false, message: RELOAD_MESSAGES.unreadable }

    // THE PROMPT SNAPSHOT, by the same rules rows.ts applies to a stored row --
    // the rules are not repeated here, they are called.
    //
    // AN ABSENT FIELD IS NOT A NULL ONE. draftPromptFrom() refuses undefined, so
    // a response that omits the four -- a stale deployment, a cached body, a
    // proxy that rewrote it -- is unreadable rather than silently generic.
    // Treating absence as "no prompt" would make a reload quietly discard the
    // applicant's prompt selection, which is exactly the loss this parser
    // exists to prevent.
    const prompt = draftPromptFrom({
      schoolId: field(draft, 'schoolId'),
      promptId: field(draft, 'promptId'),
      promptText: field(draft, 'promptText'),
      statedMaxWords: field(draft, 'statedMaxWords'),
    })
    if (prompt === undefined) return { ok: false, message: RELOAD_MESSAGES.unreadable }

    return {
      ok: true,
      draft: {
        id,
        title: checked.title,
        essay,
        revision,
        schoolId: prompt.schoolId,
        promptId: prompt.promptId,
        promptText: prompt.promptText,
        statedMaxWords: prompt.statedMaxWords,
      },
    }
  }

  if (status === 401) return { ok: false, message: RELOAD_MESSAGES.expired }
  if (status === 404) return { ok: false, message: RELOAD_MESSAGES.missing }
  if (status >= 500) return { ok: false, message: RELOAD_MESSAGES.server }
  return { ok: false, message: RELOAD_MESSAGES.refused }
}

/**
 * Whether a deliberate Try again may fire.
 *
 * Only from 'failed' -- the shared engine's `retry` event is a no-op from any
 * other status, so offering the action elsewhere would be a button that does
 * nothing. And only while the document is saveable, so a retry cannot walk
 * straight into the blocked path.
 */
export function canRetrySave(input: {
  state: AutosaveState
  title: string
  essay: string
}): boolean {
  if (input.state.status !== 'failed') return false
  return statementSaveRequest({
    title: input.title,
    essay: input.essay,
    revision: input.state.revision,
  }).ok
}

/**
 * How many words are on screen.
 *
 * A DISPLAY VALUE, AND NOTHING ELSE. Nothing is saved, limited, refused or
 * sent because of this number: the stored ceiling is MAX_SAVED_CHARS and it is
 * counted in characters, which is what the database constraint measures. A word
 * count that could block a save would be a second limit nobody agreed to.
 *
 * WHITESPACE RUNS ARE ONE SEPARATOR, so a line break between paragraphs does
 * not invent a word, and leading or trailing space does not either. An empty or
 * whitespace-only essay is zero rather than one, which is what `filter` is for:
 * ''.split(/\s+/) yields [''], and counting that as a word would show "1 word"
 * over an empty page.
 *
 * COUNTED THE WAY A SCHOOL WOULD COUNT. Hyphenated and apostrophised forms stay
 * one word, because they are one word; this deliberately does not try to be
 * cleverer than the person reading the statement.
 */
export function wordCount(text: string): number {
  if (typeof text !== 'string') return 0
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}

/** Where a draft stands against a stated limit, for a progress indicator. */
export interface WordLimitProgress {
  readonly words: number
  readonly limit: number
  /** 0..1, clamped, so a bar cannot overflow its track. */
  readonly ratio: number
  readonly over: boolean
  readonly remaining: number
}

/**
 * Progress towards the school's stated maximum, or null when it stated none.
 *
 * NULL IS THE COMMON ANSWER and must stay distinguishable from zero: a school
 * that published no limit is not a school that published a limit of nothing.
 * The caller shows no bar at all in that case rather than an empty one, which
 * would read as "you have used none of your allowance".
 *
 * OVER THE LIMIT IS REPORTED, NOT PREVENTED. Going past a school's word count
 * is the applicant's business and their draft still saves normally -- the
 * stored limit is a character ceiling, and this is a school's guidance. The
 * ratio is clamped so the indicator stays inside its track while `over` and a
 * negative `remaining` say what is actually true.
 */
export function wordLimitProgress(input: {
  readonly words: number
  readonly statedMaxWords: number | null
}): WordLimitProgress | null {
  const { words, statedMaxWords } = input
  if (statedMaxWords === null || !Number.isFinite(statedMaxWords) || statedMaxWords <= 0) {
    return null
  }
  const ratio = Math.min(1, Math.max(0, words / statedMaxWords))
  return {
    words,
    limit: statedMaxWords,
    ratio,
    over: words > statedMaxWords,
    remaining: statedMaxWords - words,
  }
}
