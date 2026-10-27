import {
  DEFAULT_AUTOSAVE, hasUnsavedWork, nextAction, saveTimedOut,
  type AutosaveAction, type AutosaveState,
} from '../../resume/draft/autosave.ts'
import { constrainDocument, documentMatchesEssay, essayToDoc } from '../layout/plainText.ts'
import { studioFontFor } from '../layout/studioFonts.ts'
import {
  checkDraftUpdate, checkPromptSelection, checkTitle,
  type DraftRefusal, type DraftUpdateInput,
  type PromptSelection, type PromptSelectionRefusal,
} from './validate.ts'
import { isDraftId } from './http.ts'
import { draftPromptFrom, parseStoredRevision } from './rows.ts'
import type { DraftPromptSnapshot } from './rows.ts'
import { SAVE_MESSAGES } from './save.ts'
import { maxSavedChars } from '../extract/limits.ts'

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
/**
 * Which constrained schema a stored document was written against.
 *
 * STORED WITH THE DOCUMENT so a later widening -- italic, say -- can be told
 * from a document that predates it, without having to infer the schema from
 * the marks that happen to appear in one essay.
 */
export const EDITOR_DOCUMENT_VERSION = 1

/**
 * The too-long sentence, for whatever ceiling is actually in force.
 *
 * A FUNCTION BECAUSE THE NUMBER IS NOT A CONSTANT. It was interpolated into a
 * module-level record, so it froze whatever maxSavedChars() answered when the
 * bundle was first evaluated -- in the browser, the fail-closed 20,000, while
 * the server was accepting 30,000. See QA-004.
 */
export function essayTooLongMessage(ceiling: number): string {
  return `That is longer than ${ceiling.toLocaleString('en-US')} characters, which is as `
    + 'much as a draft can hold. Shorten it and saving resumes.'
}

export const BLOCKED_MESSAGES: Readonly<Record<DraftRefusal, string>> = {
  'invalid-title': 'This draft needs a title before it can be saved.',
  'title-too-long': 'That title is too long to save. Shorten it and saving resumes.',
  'invalid-essay': 'This editor can only save text.',
  // THE DEFAULT CEILING, for a caller that never says which one applies. Every
  // surface that knows passes it: see blockedMessageFor.
  'essay-too-long': essayTooLongMessage(maxSavedChars()),
  'invalid-revision': 'This draft cannot be saved against the version it was opened at. Reload it.',
}

/** BLOCKED_MESSAGES, with the one message that depends on a ceiling resolved. */
export function blockedMessageFor(code: DraftRefusal, ceiling?: number): string {
  if (code === 'essay-too-long' && ceiling !== undefined) return essayTooLongMessage(ceiling)
  return BLOCKED_MESSAGES[code]
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

/**
 * A font this build does not ship.
 *
 * A SEPARATE CONSTANT FOR THE SAME REASON PROMPT_BLOCKED_MESSAGE IS ONE:
 * BLOCKED_MESSAGES is Record<DraftRefusal, string>, and widening DraftRefusal
 * would change the type of the route's VALIDATION_MESSAGES and
 * statusForValidation for a code only this builder can produce.
 *
 * AND IT SHOULD NEVER BE SEEN EITHER. The id reaching this builder came from
 * the control the Studio rendered, which is built from the same registry this
 * checks against -- so a refusal here is this application's bug.
 */
export const FONT_BLOCKED_MESSAGE =
  'That font could not be applied. Reload the page and choose it again.'

/** The one code only the font check produces. */
export type FontRefusal = 'invalid-font'

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
      readonly code: DraftRefusal | PromptSelectionRefusal | FontRefusal
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
/**
 * The document that represents a piece of plain text, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: ONE WRITER FOR CONTENT
 * ---------------------------------------------------------------------------
 * A formatted draft stores its text TWICE -- `essay` as plain characters and
 * `editorDocument` as the same characters plus which of them are bold -- and
 * for a while nothing owned keeping them in step. Three paths moved the essay
 * on its own: a file import, a conflict re-read, and any hand-made PATCH. The
 * editor's own sync effect then replaced the visible text with
 * `setContent(..., { emitUpdate: false })`, which deliberately does NOT emit,
 * so the document the parent holds never caught up.
 *
 * Two different failures came out of that, and the second is the worse one:
 *
 *   THE SAVE IS REFUSED AND NOTHING SAYS SO. statementSaveRequest compares the
 *   two and returns `invalid-essay`, so the autosave driver was handed a
 *   request it would not send. Imported text stayed on screen, unsaved, until
 *   the applicant reloaded and lost it.
 *
 *   OR THE PAIR REACHES THE DATABASE AND THE OLDER HALF WINS. On reopen the
 *   editor seeded from the stored document, and its first save wrote that
 *   older text back over the newer essay. Sentences disappeared with no
 *   notice, no conflict and no version entry.
 *
 * So any path that sets the essay from outside the editor derives the document
 * from it HERE, in one place, rather than each remembering to. See AI-QA-001.
 *
 * IT IS NOT A CONVERSION WITH OPINIONS. essayToDoc is the same function the
 * editor seeds a plain draft with, and constrainDocument is the same one the
 * API validates against, so the result is exactly what the editor would have
 * produced for this text -- which is what makes documentMatchesEssay() true of
 * the pair by construction.
 *
 * FORMATTING IS LOST, AND THAT IS THE POINT. Text that arrives from outside
 * the editor has no marks to preserve; inventing some would be worse. A
 * bold-only edit never comes through here -- it comes from the editor, which
 * emits both halves itself.
 */
export function documentForEssay(essay: string): unknown {
  return constrainDocument(essayToDoc(essay))
}

/**
 * Which stored representation to open a draft with, when they disagree.
 *
 * ---------------------------------------------------------------------------
 * THE POLICY: THE PLAIN ESSAY WINS, AND THE FORMATTING IS REBUILT FROM IT
 * ---------------------------------------------------------------------------
 * A draft should never hold an `essay` and an `editorDocument` that spell
 * different text -- the write path now refuses to create that state. But a row
 * written before it did can still be out there, so opening one has to have an
 * answer, and the answer must not be "seed from the document", which is how
 * the newer text was being destroyed: the editor seeded from the stale
 * document and its first save wrote that text back over the essay.
 *
 * SO THE ESSAY IS AUTHORITATIVE HERE, for reasons that are about this product
 * and not about taste:
 *
 *   IT IS WHAT EVERYTHING ELSE ALREADY READS. The analyser reads `essay`, the
 *   counters count it, the save ceiling applies to it and the analysis
 *   fingerprint is taken over it. The document is a rendering detail beside
 *   it, and the repository says so in as many words.
 *
 *   LOSING BOLD IS RECOVERABLE; LOSING SENTENCES IS NOT. The worst case of
 *   preferring the essay is that an applicant re-bolds a few words. The worst
 *   case of preferring the document is that a paragraph they wrote is gone,
 *   silently, with the save that destroyed it looking like an ordinary one.
 *
 *   AND THE ESSAY IS THE HALF THAT GETS WRITTEN ALONE. Every path that could
 *   diverge the pair advanced the essay and left the document behind, so on a
 *   diverged row the essay is also the NEWER half in practice.
 *
 * NOTHING IS DISCARDED SILENTLY. 'rebuilt' is reported so the editor can say
 * that formatting was reset; the alternative -- fixing it quietly -- is the
 * behaviour that made this hard to find in the first place.
 */
export type HydrationChoice =
  /** The pair agrees, or there is no document. Open it as stored. */
  | { readonly kind: 'stored'; readonly document: unknown }
  /** They disagreed. Open the essay, with formatting derived from it. */
  | { readonly kind: 'rebuilt'; readonly document: unknown }

export function hydrationFor(input: {
  readonly essay: string
  readonly document: unknown
}): HydrationChoice {
  if (input.document === null || input.document === undefined) {
    return { kind: 'stored', document: null }
  }
  if (documentMatchesEssay(input.document, input.essay)) {
    return { kind: 'stored', document: input.document }
  }
  return { kind: 'rebuilt', document: documentForEssay(input.essay) }
}

/** What an applicant is told when the formatting had to be rebuilt. */
export const FORMATTING_REBUILT =
  'This draft\u2019s formatting was out of step with its text, so the text was kept and the '
  + 'bold formatting was reset. Nothing you wrote was lost.'

export function statementSaveRequest(input: {
  title: string
  essay: string
  revision: number
  /**
   * The saved-character ceiling the SERVER resolved, when the caller has it.
   *
   * ABSENT MEANS "ASK THE ENVIRONMENT", which is right on the server and wrong
   * in a browser -- so every client surface passes it. See QA-004.
   */
  savedCharacterCeiling?: number
  /** undefined / absent = no change, null = clear, a uuid = select. */
  prompt?: unknown
  /** The constrained editor document. Absent on a surface with no formatting. */
  document?: unknown
  /**
   * The chosen face. Absent on a save that is not about the font.
   *
   * ABSENT IS THE COMMON CASE and is what every keystroke sends, so an
   * ordinary autosave cannot clear a preference by saying nothing about it.
   */
  font?: unknown
}): SaveRequest {
  const checked = checkDraftUpdate({
    title: input.title,
    essay: input.essay,
    expectedRevision: input.revision,
    savedCharacterCeiling: input.savedCharacterCeiling,
  })
  if (!checked.ok) {
    return {
      ok: false,
      code: checked.code,
      message: blockedMessageFor(checked.code, input.savedCharacterCeiling),
    }
  }

  const selection = checkPromptSelection(input.prompt)
  if (!selection.ok) {
    return { ok: false, code: selection.code, message: SAVE_BLOCKED_MESSAGES[selection.code] }
  }

  /*
    THE DOCUMENT RIDES THE SAME BODY, AND MUST AGREE WITH THE ESSAY.

    Checked here as well as on the server, for the same reason the title
    length is: an obviously invalid body should cost no round trip. The server
    checks it again because a browser is not where an invariant about stored
    data is guaranteed.

    A SURFACE WITH NO DOCUMENT OMITS THE KEY, so the plain textarea's body is
    byte-for-byte the three keys it has always been.
  */
  if (input.document !== undefined) {
    if (!documentMatchesEssay(input.document, input.essay)) {
      return { ok: false, code: 'invalid-essay', message: BLOCKED_MESSAGES['invalid-essay'] }
    }
  }
  const documentKey = input.document === undefined
    ? {}
    : { editorDocument: input.document, editorDocumentVersion: EDITOR_DOCUMENT_VERSION }

  /*
    THE FONT IS CHECKED AGAINST THE FACES THIS BUILD SHIPS, not against a list
    of names. A family the Studio does not bundle would render from whatever
    the reader's machine happens to have, and the page count -- which is the
    product -- would stop being reproducible. studioFontFor() is the same
    function the renderer resolves with, so the editor cannot send a face the
    renderer would then refuse to draw.

    null IS VALID AND MEANS THE STUDIO DEFAULT. Only a value that is neither
    null nor a bundled id is a refusal.
  */
  if (input.font !== undefined && input.font !== null && studioFontFor(input.font) === null) {
    return { ok: false, code: 'invalid-font', message: FONT_BLOCKED_MESSAGE }
  }
  const fontKey = input.font === undefined
    ? {}
    : { documentFont: (input.font ?? null) as string | null }

  // THE KEY IS OMITTED on 'unchanged', present and null on 'clear', present and
  // a uuid on 'select'. Spreading {} adds nothing, which is what keeps an
  // ordinary keystroke's body byte-for-byte the three keys it has always been.
  return {
    ok: true,
    body: { ...checked.input, ...promptKey(selection.selection), ...documentKey, ...fontKey },
  }
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
      readonly code: DraftRefusal | PromptSelectionRefusal | FontRefusal
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
  /** The constrained editor document, when the surface has one. */
  document?: unknown
  /** The chosen face. Absent on a save that is not about the font. */
  font?: unknown
  /** The server-resolved ceiling, forwarded to statementSaveRequest. */
  savedCharacterCeiling?: number
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
   * The in-flight save has not been acknowledged inside its deadline.
   *
   * A SEPARATE KIND FROM 'blocked', because the two mean opposite things. A
   * blocked document is one the applicant can fix by editing; this is a save
   * the editor has stopped believing in, and the only honest response is to
   * report it as failed and offer Try again.
   */
  | { readonly kind: 'timed-out' }

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
  /** The server-resolved ceiling, forwarded to statementSaveRequest. */
  savedCharacterCeiling?: number
}): DriverAction {
  /*
    'saving' IS NOT A RESTING STATE, AND THAT IS WHY IT IS HANDLED FIRST.

    nextAction() reports 'idle' while a request is in flight -- correctly, as
    far as scheduling goes: nothing new may start. But 'idle' also means "no
    timer", and a status that can only be left by a continuation needs a timer
    more than any other: if that continuation never runs, nothing else will
    ever look at this state again.

    So while a save is in flight this returns a WAIT until its deadline, and
    'timed-out' once the deadline passes. The driver dispatching a retryable
    save-failed is what turns a permanent "Saving…" into "Not saved" with a
    working Try again.
  */
  if (input.state.status === 'saving') {
    if (saveTimedOut(input.state, input.now)) return { kind: 'timed-out' }
    if (input.state.savingSince === null) return { kind: 'idle' }
    const due = input.state.savingSince + DEFAULT_AUTOSAVE.saveTimeoutMs
    return { kind: 'wait', afterMs: Math.max(1, due - input.now) }
  }

  const action = nextAction(input.state, input.now)
  if (action.kind === 'idle') return action

  const request = statementSaveRequest({
    title: input.title,
    essay: input.essay,
    revision: input.state.revision,
    savedCharacterCeiling: input.savedCharacterCeiling,
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
/**
 * Whether the failure on screen is an expired session.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FUNCTION HERE AND NOT A COMPARISON IN THE COMPONENT
 * ---------------------------------------------------------------------------
 * The editor is forbidden from reading `state.error`, and the ban is worth
 * keeping: the shared engine writes its OWN sentences into that field -- the
 * Resume conflict wording among them -- and a component that read it could
 * render one. statementStatus() is the only thing allowed to turn that field
 * into text, and it whitelists what it will show.
 *
 * The expired-session affordance still needs to know which failure it is
 * looking at. So the question is asked here, in the module that owns
 * Statement's wording, and the component gets a boolean it cannot render.
 *
 * A CONFLICT IS NEVER THIS, whatever its error says: `conflict` is a different
 * status with a different recovery, and statementStatus() already refuses to
 * read `error` for it.
 */
export function saveFailedOnExpiredSession(state: AutosaveState): boolean {
  if (state.status === 'conflict') return false
  return state.error === SAVE_MESSAGES.expired
}

/**
 * Whether an editor emission is an EDIT, or only the editor arriving.
 *
 * ---------------------------------------------------------------------------
 * A SAVE THE APPLICANT DID NOT ASK FOR IS NOT A FREE ACTION
 * ---------------------------------------------------------------------------
 * It bumps the revision, moves `updated_at`, and makes a draft the applicant
 * merely LOOKED at sort to the top of their library as recently edited. Two
 * situations produced one on every open:
 *
 *   A DRAFT WITH NO STORED DOCUMENT. Every newly created draft, and every
 *   draft written before formatting existed, stores `editor_document` as null.
 *   The editor builds a document out of the essay, emits it, and a raw
 *   comparison against null reports a change. Nothing changed: that document
 *   IS the stored essay, expressed in the editor's own shape.
 *
 *   A STORED DOCUMENT THAT DIFFERS ONLY IN SHAPE. ProseMirror writes an empty
 *   paragraph as `content: []` where the constrainer omits the key, and splits
 *   or merges adjacent runs with identical marks. Byte comparison called those
 *   edits too.
 *
 * SO THE COMPARISON IS SEMANTIC, over the one canonical form both sides can
 * be reduced to. `constrainDocument` is already the schema's normaliser -- it
 * whitelists the nodes, drops unknown marks and merges equal-marked runs -- so
 * two documents with the same paragraphs, the same text and the same bold
 * compare equal however they were spelled.
 *
 * THE BASELINE FOR A NULL DOCUMENT IS THE ESSAY'S OWN. Not "anything is an
 * edit" and not "nothing is": the applicant's first bold on such a draft has
 * to save, and it does, because bold makes the canonical form differ from the
 * one the plain essay implies.
 */
export function documentWasEdited(input: {
  /** The document as the draft holds it now. Null when none is stored. */
  readonly before: unknown
  /** What the editor just emitted, or null when it has emitted nothing. */
  readonly after: unknown
  /** The draft's text, which is the baseline when `before` is null. */
  readonly essay: string
}): boolean {
  /*
    NOTHING EMITTED IS NOT AN EDIT.

    constrainDocument(null) is a valid empty document, so comparing a null
    `after` against the essay's own document reported an edit for every draft
    that has no document on either side -- which is most of them, and which
    made draftStateMatches answer "changed" for a draft nobody had touched.
  */
  if (input.after === null || input.after === undefined) return false
  const canonical = (doc: unknown) => JSON.stringify(constrainDocument(doc))
  const baseline = input.before === null || input.before === undefined
    ? canonical(essayToDoc(input.essay))
    : canonical(input.before)
  return canonical(input.after) !== baseline
}

/**
 * Everything a save would persist, as one comparable value.
 *
 * TITLE, ESSAY, DOCUMENT AND FONT, because those are the four columns a save
 * writes. Anything outside them cannot make a draft dirty.
 */
export interface DraftState {
  readonly title: string
  readonly essay: string
  /** The constrained document, or null for a draft that has never had one. */
  readonly document: unknown
  readonly font: string | null
}

/**
 * Whether a proposed editor state is the draft that is already stored.
 *
 * ---------------------------------------------------------------------------
 * ONE COMPARISON, BECAUSE THE ALTERNATIVE WAS SEVEN GUARDS
 * ---------------------------------------------------------------------------
 * The editor dispatches the engine's `edited` event from seven places, and
 * most of them fire while the editor is merely ARRIVING: Tiptap emits its
 * first transaction, the essay handler forwards an unchanged string, the font
 * control reports the face it resolved. Each dispatch marks the draft dirty,
 * the autosave then writes it, and a draft the applicant only opened comes
 * back with a new revision and a new `updated_at` -- so it sorts to the top of
 * their library as recently edited. Reloading did it again.
 *
 * Guarding each dispatcher separately would be seven chances to miss one. This
 * asks the only question that matters -- is what we would send different from
 * what is stored -- and every dispatcher asks it.
 *
 * THE DOCUMENT IS COMPARED CANONICALLY, through the schema's own normaliser,
 * so ProseMirror's `content: []` for an empty paragraph and its split runs do
 * not read as edits. A draft with no stored document is compared against the
 * document its ESSAY implies, which is exactly what the editor reconstructs --
 * so a first bold on such a draft still counts, because bold makes the
 * canonical form differ.
 *
 * NOT A SUBSTITUTE FOR THE REVISION CHECK. This asks "has anything changed
 * here"; compare-and-swap still asks "has anything changed THERE".
 */
export function draftStateMatches(persisted: DraftState, proposed: DraftState): boolean {
  if (persisted.title !== proposed.title) return false
  if (persisted.essay !== proposed.essay) return false
  if ((persisted.font ?? null) !== (proposed.font ?? null)) return false
  return !documentWasEdited({
    before: persisted.document,
    after: proposed.document,
    essay: proposed.essay,
  })
}

export function canRetrySave(input: {
  state: AutosaveState
  title: string
  essay: string
  /** The server-resolved ceiling, forwarded to statementSaveRequest. */
  savedCharacterCeiling?: number
}): boolean {
  if (input.state.status !== 'failed') return false
  return statementSaveRequest({
    title: input.title,
    essay: input.essay,
    revision: input.state.revision,
    savedCharacterCeiling: input.savedCharacterCeiling,
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
