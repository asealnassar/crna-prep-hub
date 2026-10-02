import { MAX_TITLE_CHARS, checkTitle, isPromptId } from './validate.ts'
import { isDraftId } from './http.ts'

/**
 * The Statement Studio library's logic, with no React in it.
 *
 * The library page is a server component and its list and dialog are client
 * components; none of the three can be imported by `node --test`, because
 * next/navigation and next/headers do not resolve under bare Node. So the rules
 * worth testing live here instead -- what a title must be, exactly what is
 * POSTed, when Create may fire, and what a reader is told when it does not work
 * -- and the components are the thin wiring that calls them. Same arrangement
 * as save.ts, which is the autosave adapter for the same reason.
 *
 * NOTHING SERVER-ONLY IS REACHABLE FROM HERE. The two imports are validate.ts,
 * whose only dependency is limits.ts (bare numbers, no imports at all), and
 * http.ts, whose imports are type-only. So this module and everything it pulls
 * is safe in a browser bundle: no next/*, no node:*, no process, no Supabase.
 */

/** The endpoint. The same gated route a signed-in admin's browser may call. */
export const NEW_DRAFT_ENDPOINT = '/api/statement/drafts'

/** Where a created draft opens. The one place this path is spelled out. */
export function draftPath(id: string): string {
  return `/statement-studio/${id}`
}

/**
 * What a reader can be shown. EVERY message the library displays is one of
 * these.
 *
 * The server's own `error` string is never read, let alone rendered. A create
 * response can carry PostgREST text, a CHECK-constraint message quoting a value,
 * or -- if anything ever sits between the browser and the route -- prose written
 * by someone else entirely. None of it belongs in front of an applicant, so the
 * mapper below keys on `status` and on a closed set of our own `code` values,
 * and looks the message up here.
 */
export const CREATE_MESSAGES = {
  /** Empty after trimming, whitespace-only, or not text at all. */
  title: 'Give the draft a title.',
  /** Longer than the stored limit once trimmed. */
  tooLong: `That title is too long. Use ${MAX_TITLE_CHARS} characters or fewer.`,
  /** The session is gone. Nothing was created, so trying again is safe. */
  session: 'Your session has expired. Sign in again, then try once more.',
  /**
   * A 404. Says nothing about modes, administrators or flags -- only an
   * already-admitted reader can ever see this, and even they are told no more
   * than that it is unavailable.
   */
  unavailable: 'Statement Studio is not available right now.',
  /** A 5xx, or a refusal this client does not recognise. */
  server: 'That draft could not be created. Please try again.',
  /** The request never arrived. */
  network: 'Could not reach the server. Please try again.',
  /**
   * The chosen prompt was withdrawn or made inactive between the moment it was
   * listed and the moment Create was pressed. NOTHING WAS CREATED -- the server
   * refuses the whole request rather than quietly making a general draft -- so
   * the applicant has lost only the choice, not the title they typed.
   */
  promptGone: 'That prompt is no longer available. Choose another and try again.',
  /**
   * The prompt id this client sent was not a usable one. An applicant cannot
   * type a prompt id, so this is a bug on this side rather than a mistake on
   * theirs, and the wording asks for the one thing that can clear it.
   */
  promptUnusable: 'That prompt selection could not be used. Choose the prompt again.',
  /**
   * CREATED, BUT UNREADABLE. The POST succeeded, so a draft exists; the
   * response just could not be understood well enough to open it. This is the
   * one refusal that must NOT be retried -- a second POST would make a second
   * draft -- which is why the outcome carries `retryable: false`.
   */
  unopenable: 'That draft was created, but could not be opened. Reload the library to find it.',
} as const

/** A title the applicant may submit, or the reason they may not. */
export type NewDraftRequest =
  | { readonly ok: true; readonly body: { readonly title: string; readonly essay: string } }
  | { readonly ok: false; readonly message: string }

/**
 * The exact request body, and the only place it is built.
 *
 * TRIMMED BY checkTitle, not here: the same function the API validates with, so
 * the client cannot drift from the server about what a title is. A title that is
 * too long is REFUSED, never truncated -- silently shortening what somebody typed
 * would be a worse answer than telling them.
 *
 * `essay: ''` is deliberate: a new draft starts empty and the essay arrives with
 * the editor. The object is BUILT with exactly two keys rather than spread from
 * anything, so nothing can add a third. userId, id, revision and the timestamps
 * are not caller-owned -- the session supplies the first and the database the
 * rest -- and the route would ignore them anyway.
 */
export function newDraftRequest(raw: unknown): NewDraftRequest {
  const checked = checkTitle(raw)
  if (!checked.ok) {
    return {
      ok: false,
      message: checked.code === 'title-too-long' ? CREATE_MESSAGES.tooLong : CREATE_MESSAGES.title,
    }
  }
  return { ok: true, body: { title: checked.title, essay: '' } }
}

/**
 * Whether Create may fire.
 *
 * THIS IS NOT THE DUPLICATE GUARD, it is the declarative half of it: it decides
 * what the button looks like. React state settles asynchronously, so two clicks
 * in one tick could both read `submitting: false`; the component holds a ref
 * that is set synchronously before the fetch, and that is what actually makes one
 * click at most one POST.
 *
 * Every comparison is against an exact boolean, and anything else is treated as
 * "no". A missing or malformed flag must not open the button.
 */
export function canSubmitNewDraft(input: {
  title: string
  submitting: boolean
  retryable: boolean
}): boolean {
  if (input.submitting !== false) return false
  if (input.retryable !== true) return false
  return checkTitle(input.title).ok
}

/** What came of a create attempt. */
export type CreateOutcome =
  | { readonly type: 'created'; readonly id: string; readonly path: string }
  | { readonly type: 'refused'; readonly message: string; readonly retryable: boolean }

/**
 * The request never reached the route. Nothing was created; retrying is safe.
 *
 * TYPED AS THE `refused` MEMBER, NOT AS THE WHOLE UNION. Annotating it
 * `CreateOutcome` widened it and threw the discriminant away, so a caller could
 * not read `.message` or `.retryable` off it -- the value was always a refusal,
 * but the type had stopped saying so. NewDraftDialog's catch block reads both,
 * and TS2339 was the result.
 *
 * Extract<> rather than a hand-written second type, so there is still exactly
 * one definition of what a refusal looks like: adding a field to the union
 * member reaches this constant automatically. The same idiom
 * lib/statement/draft/save.ts and lib/resume/model/dates.ts already use.
 *
 * THE VALUE IS UNCHANGED -- same type, same message, same retryable flag.
 */
export const NETWORK_FAILURE: Extract<CreateOutcome, { type: 'refused' }> = {
  type: 'refused',
  message: CREATE_MESSAGES.network,
  retryable: true,
}

/** Our own refusal codes, and nothing else, may choose a message. */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  'invalid-title': CREATE_MESSAGES.title,
  'title-too-long': CREATE_MESSAGES.tooLong,
  // The prompt refusals, keyed the same way. Both are RETRYABLE: neither
  // created a row, so pressing Create again cannot make a second draft. They
  // are listed here rather than left to fall through to the generic server
  // message because "please try again" is wrong advice for both -- retrying
  // the same prompt will fail the same way, and what is needed is a new choice.
  'prompt-not-found': CREATE_MESSAGES.promptGone,
  'invalid-prompt': CREATE_MESSAGES.promptUnusable,
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

/** The created draft's id, only if the response really carries a usable one. */
function createdIdOf(body: unknown): string | null {
  const id = fieldOf(fieldOf(body, 'draft'), 'id')
  return isDraftId(id) ? id : null
}

/**
 * An HTTP response as an outcome.
 *
 * NO ID IS EVER INVENTED. A 2xx without a readable draft id is a refusal, not a
 * guess at where to navigate -- and specifically the one non-retryable refusal,
 * because the draft is probably there.
 *
 * `retryable` answers exactly one question: could pressing Create again make a
 * SECOND draft? Everything but the unreadable-2xx case created nothing, so
 * everything else may be retried deliberately. Nothing here retries by itself:
 * a create is not idempotent and this codebase has no idempotency key.
 */
export function createOutcomeFrom(input: { status: number; body: unknown }): CreateOutcome {
  const { status, body } = input

  if (status >= 200 && status < 300) {
    const id = createdIdOf(body)
    if (id !== null) return { type: 'created', id, path: draftPath(id) }
    return { type: 'refused', message: CREATE_MESSAGES.unopenable, retryable: false }
  }

  const code = fieldOf(body, 'code')
  if (typeof code === 'string' && code in CODE_MESSAGES) {
    return { type: 'refused', message: CODE_MESSAGES[code], retryable: true }
  }

  if (status === 401) return { type: 'refused', message: CREATE_MESSAGES.session, retryable: true }
  if (status === 404) {
    return { type: 'refused', message: CREATE_MESSAGES.unavailable, retryable: true }
  }
  // A 400 or 422 whose code this client does not know, and every 5xx.
  return { type: 'refused', message: CREATE_MESSAGES.server, retryable: true }
}

/**
 * The calendar day of a stored timestamp.
 *
 * DELIBERATELY NOT LOCALISED. The list is rendered on the server first and then
 * hydrated in the browser; `toLocaleDateString()` would run in two timezones and
 * produce two different strings for the same row, which React reports as a
 * hydration mismatch. The stored value's own date is the same in both places.
 *
 * The cost is honest and worth stating: this is the UTC day, so a draft saved
 * late in the evening in Pacific time shows the following date. Acceptable for an
 * internal library; a localised, hydration-safe format is a later job.
 *
 * Anything that is not a timestamp comes back untouched rather than sliced into
 * nonsense.
 */
export function draftDay(value: string): string {
  const day = typeof value === 'string' ? value.slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : value
}

/* ===========================================================================
 * Searching and ordering the library.
 *
 * WHY THIS IS HERE AND NOT IN THE COMPONENT. Same reason as everything above:
 * the list is a client component that `node --test` cannot import, so the rules
 * live in this module where they can be tested against real inputs, and the
 * component stays thin wiring. It also keeps the list itself free of sorting
 * code, which is the shape the library's tests already describe.
 *
 * THE SERVER'S ORDER IS STILL THE DEFAULT. `listDrafts` returns rows newest
 * edit first, ordered by the index that serves the query, and 'edited' hands
 * that array straight back -- same reference, not a re-sorted copy. The browser
 * only ever reorders because somebody asked it to.
 * ======================================================================== */

/** The minimum a draft needs to be searched and ordered. */
interface OrderableDraft {
  readonly id: string
  readonly title: string
  readonly createdAt: string
}

/** How the applicant may order their drafts. */
export type DraftOrder = 'edited' | 'started' | 'title'

/** The orders offered, and their wording. The one place both are spelled out. */
export const DRAFT_ORDERS: readonly { readonly value: DraftOrder; readonly label: string }[] = [
  { value: 'edited', label: 'Last edited' },
  { value: 'started', label: 'Recently started' },
  { value: 'title', label: 'Title A-Z' },
]

/** Whether a value is an order this module knows. Anything else is not. */
export function isDraftOrder(value: unknown): value is DraftOrder {
  return value === 'edited' || value === 'started' || value === 'title'
}

/** Ids break every tie, so equal keys never shuffle between renders. */
function compareIds(a: OrderableDraft, b: OrderableDraft): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Titles compared as lowercased code points, NOT with localeCompare.
 *
 * Same hazard draftDay documents: this list is rendered on the server and then
 * hydrated in the browser. localeCompare's answer depends on the ICU data of
 * whoever is asking, so Node and the browser can disagree about two titles and
 * React reports the difference as a hydration mismatch. A code point comparison
 * is the same answer everywhere.
 *
 * The cost, stated plainly: accented and non-Latin titles sort by code point
 * rather than by any language's alphabet. Acceptable for an internal library.
 */
function compareTitles(a: OrderableDraft, b: OrderableDraft): number {
  const left = a.title.trim().toLowerCase()
  const right = b.title.trim().toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  return compareIds(a, b)
}

/** Newest start first. Stored timestamps are ISO-8601, so they compare as text. */
function compareStarts(a: OrderableDraft, b: OrderableDraft): number {
  if (a.createdAt < b.createdAt) return 1
  if (a.createdAt > b.createdAt) return -1
  return compareIds(a, b)
}

/**
 * The drafts in the order asked for.
 *
 * 'edited' returns the ARRAY IT WAS GIVEN, untouched -- the server already
 * ordered it and a second opinion here would only be a chance to disagree. The
 * other two sort a copy, so the caller's array is never mutated out from under
 * React. An unrecognised order is treated as 'edited' rather than throwing.
 */
export function orderDrafts<T extends OrderableDraft>(
  drafts: readonly T[],
  order: DraftOrder,
): readonly T[] {
  if (order === 'title') return [...drafts].sort(compareTitles)
  if (order === 'started') return [...drafts].sort(compareStarts)
  return drafts
}

/**
 * The drafts whose title contains the search text.
 *
 * TITLES ONLY. A summary carries no statement text, so there is nothing else
 * here to search; searching the writing itself would mean fetching every
 * draft's body into the browser, which this page deliberately never does.
 *
 * A blank or whitespace-only search returns the array it was given, so typing
 * and then clearing the box lands exactly back where it started.
 */
export function matchDrafts<T extends { readonly title: string }>(
  drafts: readonly T[],
  query: string,
): readonly T[] {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle === '') return drafts
  return drafts.filter((draft) => draft.title.toLowerCase().includes(needle))
}

/**
 * The line under "Your drafts", counting what is actually on screen.
 *
 * It never says "0 drafts" when the workspace is empty -- an applicant who has
 * not started yet is told what the page is for instead.
 */
export function draftTally(shown: number, total: number): string {
  if (total === 0) return 'Create and manage your personal statement drafts here.'
  if (shown === total) return `${total} ${total === 1 ? 'draft' : 'drafts'} in your workspace.`
  return `${shown} of ${total} drafts match your search.`
}

/**
 * A title and a chosen prompt, or the reason they may not be sent.
 *
 * A SEPARATE BUILDER, not a wider NewDraftRequest. The general path is the one
 * every existing draft was made by, and its body is still built with exactly
 * two keys that nothing can add a third to; widening that object would have put
 * an optional prompt key into the request that creates an ordinary statement,
 * where it has no business being.
 */
export type NewSchoolDraftRequest =
  | {
      readonly ok: true
      readonly body: {
        readonly title: string
        readonly essay: string
        readonly promptId: string
      }
    }
  | { readonly ok: false; readonly message: string }

/**
 * The request that creates a draft already answering a school's question.
 *
 * THE ID AND NOTHING ELSE CROSSES THE BOUNDARY. There is no schoolId, no
 * promptText and no statedMaxWords in this object, and not because they are
 * omitted -- because the three keys are not written anywhere in this function,
 * so there is nothing to forget to remove. The server reads the catalog for
 * them. A browser that could state the wording could state different wording.
 *
 * THE ID IS CHECKED BEFORE IT IS SENT, with the same predicate the server
 * validates it with, so a selection this client has mangled is caught here
 * rather than spending a round trip to earn a 400.
 *
 * TITLE FIRST, matching newDraftRequest: an applicant who typed nothing is told
 * about the title, which is the field they can actually act on.
 */
export function newSchoolDraftRequest(
  rawTitle: unknown,
  promptId: unknown,
): NewSchoolDraftRequest {
  const checked = checkTitle(rawTitle)
  if (!checked.ok) {
    return {
      ok: false,
      message: checked.code === 'title-too-long' ? CREATE_MESSAGES.tooLong : CREATE_MESSAGES.title,
    }
  }
  if (!isPromptId(promptId)) {
    return { ok: false, message: CREATE_MESSAGES.promptUnusable }
  }
  return { ok: true, body: { title: checked.title, essay: '', promptId } }
}
