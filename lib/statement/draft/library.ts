import { MAX_TITLE_CHARS, checkTitle } from './validate.ts'
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
