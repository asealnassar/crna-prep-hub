import {
  hasUnsavedWork, nextAction, type AutosaveAction, type AutosaveState,
} from '../../resume/draft/autosave.ts'
import { checkDraftUpdate, checkTitle, type DraftRefusal, type DraftUpdateInput } from './validate.ts'
import { isDraftId } from './http.ts'
import { parseStoredRevision } from './rows.ts'
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

/** A saveable document, or why it is not one. */
export type SaveRequest =
  | { readonly ok: true; readonly body: DraftUpdateInput }
  | { readonly ok: false; readonly code: DraftRefusal; readonly message: string }

/**
 * The exact PATCH body, and the only place it is built.
 *
 * checkDraftUpdate() is the SAME function the route validates with, so the
 * editor cannot disagree with the API about what is saveable. Its normalised
 * result is the payload: exactly title, essay and expectedRevision. Nothing
 * here adds an id, a userId, a timestamp, a school or a prompt -- the path
 * carries the id, the session carries the owner, and the database owns the rest.
 *
 * THE REVISION IS THE ENGINE'S, passed in from AutosaveState.revision, which is
 * only ever set from a server response. It is never incremented here.
 */
export function statementSaveRequest(input: {
  title: string
  essay: string
  revision: number
}): SaveRequest {
  const checked = checkDraftUpdate({
    title: input.title,
    essay: input.essay,
    expectedRevision: input.revision,
  })
  if (!checked.ok) {
    return { ok: false, code: checked.code, message: BLOCKED_MESSAGES[checked.code] }
  }
  return { ok: true, body: checked.input }
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

/** A persisted draft, as the reload accepted it. */
export interface ReloadedDraft {
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

    return { ok: true, draft: { id, title: checked.title, essay, revision } }
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
