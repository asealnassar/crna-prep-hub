/**
 * What the school/prompt picker DECIDES, separated from what it renders. Pure.
 *
 * WHY THIS FILE EXISTS. A client component cannot be imported under
 * `node --test`: next/navigation is unresolvable there, so every component in
 * this feature is covered by source assertions rather than by execution. Source
 * assertions can prove a line exists; they cannot prove a stale response is
 * discarded, or that a malformed body is refused. So the decisions live here,
 * where they run, and PromptPicker.tsx is left with markup and state.
 *
 * NOTHING HERE FETCHES, STORES OR SAVES. No window, no fetch, no clock. The
 * component owns the request; this module owns the answer.
 *
 * BROWSING IS NOT SELECTING. Everything below concerns a prompt the applicant
 * is LOOKING AT. Which prompt the draft actually answers lives in the draft's
 * own four columns and reaches the editor as DraftPromptSnapshot -- this module
 * never produces one, and a later checkpoint is what will let a preview become
 * one.
 */

import type { SchoolOption } from './schoolPicker.ts'
import { draftPromptFrom } from './rows.ts'
import type { DraftPromptSnapshot } from './rows.ts'

/** The endpoint, named once. Checkpoint G built it; this only addresses it. */
export const PROMPTS_ENDPOINT = '/api/statement/prompts'

/**
 * One school's prompt list, by address.
 *
 * ENCODED, because a school id reaches this from a server-rendered prop and is
 * a uuid in practice -- but a value that is interpolated into a URL without
 * encoding is a value that only behaves while it stays well formed.
 */
export function promptsPath(schoolId: string): string {
  return `${PROMPTS_ENDPOINT}?schoolId=${encodeURIComponent(schoolId)}`
}

/**
 * One prompt as the endpoint returns it. Camel case: this is the API's shape,
 * not a database row's.
 */
export interface PromptChoice {
  readonly id: string
  readonly label: string
  readonly promptText: string
  readonly statedMaxWords: number | null
  readonly applicationCycle: string | null
}

// ---------------------------------------------------------------- the words
//
// EVERY STRING A READER CAN SEE IS CHOSEN HERE, so that nothing the server
// wrote can reach the screen: the endpoint's refusals are a fixed generic body
// and this module never renders one. A test asserts these are all distinct,
// because two identical notices are two states an applicant cannot tell apart.

export const PICKER_MESSAGES = {
  /** The directory could not be read. NOT the same as there being none. */
  unavailable:
    'The school list could not be loaded right now. Your essay is safe and still saves normally — reload the page to try again.',
  /** The directory was read and is genuinely empty. */
  emptyDirectory: 'No schools are listed yet.',
  /** A search that matched nothing. */
  noMatches: 'No schools match that search.',
  /** A prompt list on its way. */
  loading: 'Loading prompts…',
  /** The school was read and offers no active prompt. */
  noPrompts: 'No prompts are listed for this school yet. You can keep writing — a prompt is optional.',
  /** The request failed, or the reply could not be read. */
  failed: 'Those prompts could not be loaded. Try that school again.',
  /** The applicant is not signed in any more. */
  expired: 'Your session has expired. Sign in again to browse prompts.',
  /**
   * A conflict reload threw away a prompt choice that had not been saved.
   *
   * APPROVED WORDING, and it is shown ONLY when something was actually pending.
   * A reload adopts the server's draft entirely -- that is what resolves the
   * conflict -- so a selection that never reached the server is gone, and
   * saying nothing would be the silent erasure this notice exists to prevent.
   */
  selectionDiscarded:
    'Your unsaved prompt selection was not kept. Choose it again if you still want to use it.',
  /**
   * A 200 whose canonical prompt fields could not be read.
   *
   * THE ESSAY IS SAFE AND THE PROMPT IS NOT CONFIRMED, and the sentence says
   * both because both are true: the revision came back, so the document was
   * written, but the four prompt fields did not arrive in a form this
   * application can trust -- so claiming the selection was saved would be a
   * guess. The selection stays pending and the applicant is given a button.
   */
  confirmationFailed:
    'Your essay was saved, but we couldn’t confirm your prompt selection. Please try saving the prompt again.',
  /** The deliberate retry. Nothing automatic ever triggers it. */
  retryPromptSave: 'Try saving prompt again',
} as const

/** What a stated maximum reads as, including when a school states none. */
export function wordLimitLabel(statedMaxWords: number | null): string {
  if (statedMaxWords === null) return 'No stated word limit.'
  return `${statedMaxWords.toLocaleString('en-US')}-word maximum, as stated by the school.`
}

// --------------------------------------------------------------- the search

/**
 * The schools whose name matches, case-insensitively, in the order given.
 *
 * NAME ONLY. The state is shown beside a result to tell two similarly named
 * programmes apart, and searching it would be a different feature: typing "TX"
 * would silently return every Texas programme as if the applicant had asked
 * for them. lib/states.ts records that the column is inconsistent anyway --
 * mostly abbreviations, seven full names -- so matching it would answer
 * differently for two schools in the same state.
 *
 * AN EMPTY QUERY MATCHES EVERYTHING, so the list is browsable without typing.
 * Whitespace alone is an empty query.
 *
 * NULL-SAFE BY CONSTRUCTION: only `name` is read, and SchoolOption types it as
 * a required string. `locationState` is never touched here.
 */
export function matchingSchools(
  schools: readonly SchoolOption[],
  query: string,
): readonly SchoolOption[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return schools
  return schools.filter((school) => school.name.toLowerCase().includes(needle))
}

/**
 * How one school reads in a list: its name, and its state when it has one.
 *
 * THE NULL CASE IS THE REASON THIS IS A FUNCTION. `${name} — ${state}` would
 * render "Example University — null" for the rows that record no state, and
 * `state || ''` would leave a dangling dash. Both are refused here once rather
 * than in every place a school is printed.
 */
export function schoolLabel(school: SchoolOption): string {
  const state = school.locationState
  if (typeof state !== 'string' || state.trim().length === 0) return school.name
  return `${school.name} — ${state}`
}

/** What to say when there is no list to show. null means "show the list". */
export function directoryNotice(input: {
  readonly unavailable: boolean
  readonly total: number
  readonly matching: number
}): string | null {
  // THE FAILED READ IS CHECKED FIRST, and is a different sentence from an empty
  // one. Telling an applicant "no schools are listed" because a connection
  // dropped would have them conclude this product knows of no CRNA programmes.
  if (input.unavailable) return PICKER_MESSAGES.unavailable
  if (input.total === 0) return PICKER_MESSAGES.emptyDirectory
  if (input.matching === 0) return PICKER_MESSAGES.noMatches
  return null
}

// ------------------------------------------------------- the prompt request

export type PromptListOutcome =
  | { readonly ok: true; readonly prompts: readonly PromptChoice[] }
  | { readonly ok: false; readonly message: string }

const CHOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CYCLE = /^[0-9]{4}(-[0-9]{4})?$/
const MAX_PROMPT_TEXT_CHARS = 5000
const MAX_LABEL_CHARS = 200
const MAX_STATED_MAX_WORDS = 5000

/** Code points, as Postgres char_length counts them -- see promptRepo.ts. */
function tooManyCodePoints(value: string, ceiling: number): boolean {
  if (value.length <= ceiling) return false
  return [...value.slice(0, ceiling * 2 + 2)].length > ceiling
}

/**
 * One item of the response as a choice, or null when it cannot be trusted.
 *
 * THE SAME CONTRACT promptRepo.ts APPLIES TO THE ROW IT CAME FROM, repeated
 * here rather than imported: promptRepo is a server data-access module, and
 * importing it would put readActivePrompt into the browser bundle. picker.
 * test.ts asserts the two agree on every boundary, which is what stops the
 * copies drifting.
 *
 * AN ABSENT FIELD IS NOT A NULL ONE. A reply that omits statedMaxWords is a
 * reply this code did not expect, not a school with no limit.
 */
function choiceFrom(value: unknown): PromptChoice | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>

  if (typeof item.id !== 'string' || !CHOICE_UUID.test(item.id)) return null

  if (typeof item.label !== 'string') return null
  const trimmedLabel = item.label.trim()
  if (trimmedLabel.length === 0) return null
  if (tooManyCodePoints(trimmedLabel, MAX_LABEL_CHARS)) return null

  if (typeof item.promptText !== 'string' || item.promptText.trim().length === 0) return null
  if (tooManyCodePoints(item.promptText, MAX_PROMPT_TEXT_CHARS)) return null

  const words = item.statedMaxWords
  if (words !== null) {
    if (typeof words !== 'number') return null
    if (!Number.isSafeInteger(words)) return null
    if (words < 1 || words > MAX_STATED_MAX_WORDS) return null
  }

  const cycle = item.applicationCycle
  if (cycle !== null) {
    if (typeof cycle !== 'string' || !CYCLE.test(cycle)) return null
  }

  return {
    id: item.id,
    label: item.label,
    promptText: item.promptText,
    statedMaxWords: words,
    applicationCycle: cycle,
  }
}

/**
 * One prompts response, as an outcome.
 *
 * THE MAPPING, in the order it is decided:
 *
 *   2xx + a readable array  -> the choices, in the order sent
 *   2xx + anything else     -> failed. An unreadable reply is not an empty
 *                              school: "no prompts here" is a claim about a
 *                              programme, and it may not be made on the
 *                              evidence of a malformed body.
 *   401                     -> expired
 *   anything else           -> failed
 *
 * AN EMPTY ARRAY IS A SUCCESS, carrying no prompts. The catalog was empty at
 * its last production check, so that is the common answer today, and it is the
 * component that turns it into PICKER_MESSAGES.noPrompts.
 *
 * ONE MALFORMED ITEM FAILS THE WHOLE LIST, matching the repository: showing the
 * other four would hide a question a school published.
 *
 * NO SERVER PROSE IS EVER READ. The body is inspected for one key and the
 * shapes beneath it. `error` and `code` are not looked at, so nothing the
 * endpoint wrote can reach the screen.
 */
export function promptListFrom(input: {
  readonly status: number
  readonly body: unknown
}): PromptListOutcome {
  const { status, body } = input

  if (status >= 200 && status < 300) {
    if (typeof body !== 'object' || body === null) {
      return { ok: false, message: PICKER_MESSAGES.failed }
    }
    const listed = (body as { prompts?: unknown }).prompts
    if (!Array.isArray(listed)) return { ok: false, message: PICKER_MESSAGES.failed }

    const prompts: PromptChoice[] = []
    for (const item of listed) {
      const choice = choiceFrom(item)
      if (!choice) return { ok: false, message: PICKER_MESSAGES.failed }
      prompts.push(choice)
    }
    return { ok: true, prompts }
  }

  if (status === 401) return { ok: false, message: PICKER_MESSAGES.expired }
  return { ok: false, message: PICKER_MESSAGES.failed }
}

/**
 * Whether a reply that has just arrived is still about the school on screen.
 *
 * THE STALE-RESPONSE GUARD. An applicant who types one school, then another,
 * has two requests in the air; the first may land second. Applying it would
 * show one school's prompts under another's name -- and the applicant would
 * have no way to know. So a reply is applied only when the school it was asked
 * about is still the school being browsed.
 *
 * COMPARED AGAINST A SYNCHRONOUS REF, not React state, because state settles
 * after the event that changed it: by the time a reply is handled, `useState`
 * may not yet reflect the school the applicant has already clicked.
 *
 * AN EXACT STRING COMPARISON. Not a length, not a truthiness test: two uuids
 * either are the same request or they are not.
 */
export function mayApplyPrompts(input: {
  readonly requestedFor: string
  readonly browsingNow: string | null
}): boolean {
  return input.browsingNow !== null && input.browsingNow === input.requestedFor
}

// ------------------------------------------------- saved versus previewed

/**
 * Whether the prompt being previewed is the one the draft already answers.
 *
 * BY ID, AND ONLY WHEN THE DRAFT HAS ONE. A draft with no prompt is never
 * "already using" anything, however closely a preview resembles it. This is
 * what lets the interface say "this is the prompt your draft answers" for one
 * and "previewing — not attached to your draft yet" for every other, without
 * ever implying a browse has been saved.
 */
export function previewIsSaved(input: {
  readonly previewId: string | null
  readonly savedPromptId: string | null
}): boolean {
  if (input.previewId === null || input.savedPromptId === null) return false
  return input.previewId === input.savedPromptId
}

/**
 * Whether the draft's own saved snapshot should be shown as a standing panel.
 *
 * IT IS SHOWN FROM THE DRAFT, NEVER FROM THE CATALOG. The draft stores its own
 * copy of the wording precisely so that editing or withdrawing a catalog row
 * cannot change the question an essay was written to answer. So this reads the
 * snapshot and nothing else -- and in particular, a saved prompt that is NOT in
 * the fetched list stays fully visible. Its absence from a list is not evidence
 * of anything: the school may not be the one being browsed, the list may not
 * have loaded, or the row may simply no longer be offered.
 */
export function hasSavedPrompt(input: {
  readonly promptId: string | null
  readonly promptText: string | null
}): boolean {
  return typeof input.promptId === 'string' && typeof input.promptText === 'string'
}

// ===========================================================================
// THE PENDING SELECTION
//
// A prompt the applicant has CHOSEN but which has not reached the server yet.
// It is not the draft's snapshot and it is not a preview: it is an instruction
// in flight, and it has to survive every way a save can fail.
// ===========================================================================

/**
 * One pending instruction, with an identity of its own.
 *
 * THE TOKEN IS THE POINT. A → B → A gives three selections whose uuids are
 * two values, so comparing ids could not tell the first A from the third. A
 * response for the first A would then retire the third, and the applicant's
 * standing choice would vanish with no error anywhere. The token makes the
 * three distinguishable: 1, 2, 3.
 *
 * MONOTONIC, NOT RANDOM, so a test can state exactly what it expects and a
 * reader can see at a glance which of two selections came later.
 *
 * `promptId: null` IS AN INSTRUCTION, NOT AN ABSENCE. It means "clear the
 * prompt". "Nothing pending" is the absence of a PendingPrompt altogether --
 * null in place of the whole object -- which is why these are two layers rather
 * than one nullable id.
 */
export interface PendingPrompt {
  readonly token: number
  readonly promptId: string | null
}

/**
 * The next selection, given the LAST TOKEN EVER ISSUED.
 *
 * NOT DERIVED FROM WHAT IS PENDING NOW, and that correction matters. A pending
 * selection is retired on every success and discarded on every reload, so
 * counting from it would restart at 1 each time -- and a response for the first
 * token 1 could then retire a brand new token 1 issued after the next success.
 * The caller keeps a counter that NEVER RESETS for the lifetime of the editor,
 * so every selection an applicant ever makes has an identity of its own.
 *
 * STILL PURE. The counter lives in the component, so two editors on one page
 * cannot share a sequence and this function can be tested without one.
 */
export function nextPendingPrompt(lastToken: number, promptId: string | null): PendingPrompt {
  return { token: lastToken + 1, promptId }
}

/**
 * Whether two pending selections are THE SAME selection.
 *
 * BY TOKEN, never by promptId. This is the comparison that decides whether a
 * response may retire what is pending, and it is the whole defence against an
 * older response clearing a newer choice.
 */
export function samePendingPrompt(
  a: PendingPrompt | null,
  b: PendingPrompt | null,
): boolean {
  if (a === null || b === null) return false
  return a.token === b.token
}

/**
 * What to pass to statementSaveRequest's optional `prompt`.
 *
 * THREE STATES, AND THE FIRST ONE IS WHY THIS FUNCTION EXISTS: nothing pending
 * must become `undefined`, not null. `undefined` omits the key and leaves the
 * stored prompt alone; null CLEARS it. Collapsing them would make every
 * ordinary keystroke wipe the applicant's prompt.
 */
export function promptForRequest(pending: PendingPrompt | null): string | null | undefined {
  if (pending === null) return undefined
  return pending.promptId
}

/**
 * The canonical snapshot from a save or reload response, or null when the body
 * does not carry a usable one.
 *
 * THE SAME STRICT PARSER rows.ts applies to a database row -- called, not
 * repeated -- so the editor cannot disagree with the repository about what a
 * coherent snapshot is. A prompt_id with no wording, a non-uuid school, a
 * word limit out of range: all refused, and refused as a WHOLE, because a
 * half-snapshot is not a snapshot.
 *
 * NULL MEANS "DO NOT ACT". The caller must neither update the display nor
 * retire a pending selection on a null: claiming a selection was saved on the
 * strength of a body this code could not read is exactly the false success this
 * guards against.
 */
export function savedPromptFromResponse(body: unknown): DraftPromptSnapshot | null {
  if (typeof body !== 'object' || body === null) return null
  const draft = (body as { draft?: unknown }).draft
  if (typeof draft !== 'object' || draft === null) return null
  const fields = draft as Record<string, unknown>

  const snapshot = draftPromptFrom({
    schoolId: fields.schoolId,
    promptId: fields.promptId,
    promptText: fields.promptText,
    statedMaxWords: fields.statedMaxWords,
  })
  return snapshot ?? null
}

/**
 * Whether choosing this prompt is worth a write.
 *
 * NO, when the draft already answers it and nothing else is pending: a second
 * identical save would consume a revision and move the retention clock to
 * record a change that is not one.
 *
 * YES, when something IS pending, even for the same id -- because the pending
 * instruction may be a CLEAR, and "the draft already answers this" says nothing
 * about an instruction that has not landed.
 */
export function needsPromptWrite(input: {
  readonly chosenId: string | null
  readonly savedPromptId: string | null
  readonly pending: PendingPrompt | null
}): boolean {
  // SOMETHING IS ALREADY PENDING. Compare against THAT, not against what the
  // server holds: the pending instruction is what the applicant last asked for,
  // and it may not have landed yet.
  //
  //   pending B, chosen A  -> yes. This is the in-flight REVERSAL: the draft may
  //                          say A and a request attaching B may be in the air,
  //                          and choosing A again must be honoured or B would
  //                          silently become the final answer.
  //   pending <clear>, chosen A -> yes, for the same reason.
  //   pending A, chosen A  -> no. The instruction is already on its way; a
  //                          second identical one would be a second write.
  if (input.pending !== null) return input.pending.promptId !== input.chosenId

  // NOTHING PENDING. Then the server's snapshot is the applicant's intent, and
  // choosing what the draft already answers is not a change.
  return input.chosenId !== input.savedPromptId
}

/**
 * WHICH OF THE THREE THINGS a prompt on screen is.
 *
 *   'pending'  the applicant chose it and the server has not confirmed it.
 *   'saved'    the server's own snapshot says the draft answers it, AND no
 *              newer choice is waiting that could replace it.
 *   'preview'  anything else: a question being read, attached to nothing.
 *
 * 'pending' WINS OVER 'saved', always. That is the rule that stops a newer
 * choice looking settled: while anything is pending, the draft's prompt is
 * unsettled, so even a prompt whose uuid matches the stored one is reported as
 * pending rather than saved. An older response that happens to confirm the same
 * id cannot make a newer instruction appear finished.
 */
export type PromptBadge = 'saved' | 'pending' | 'preview'

export function promptBadgeFor(input: {
  readonly promptId: string
  readonly savedPromptId: string | null
  readonly pending: PendingPrompt | null
}): PromptBadge {
  if (input.pending !== null) {
    return input.pending.promptId === input.promptId ? 'pending' : 'preview'
  }
  return input.savedPromptId === input.promptId ? 'saved' : 'preview'
}

/**
 * Whether a confirmation failure still describes what is pending.
 *
 * A WARNING BELONGS TO ONE SELECTION. If the applicant has since chosen
 * something else, the failure recorded for the old one is no longer about
 * anything on screen -- showing it would blame a newer choice for an older
 * response. Compared by TOKEN, like every other decision about identity here.
 */
export function confirmationApplies(input: {
  readonly failedToken: number | null
  readonly pending: PendingPrompt | null
}): boolean {
  if (input.failedToken === null || input.pending === null) return false
  return input.pending.token === input.failedToken
}
