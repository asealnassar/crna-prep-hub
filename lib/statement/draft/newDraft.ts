import { checkTitle, isPromptId } from './validate.ts'
import {
  CREATE_MESSAGES,
  newDraftRequest,
  newSchoolDraftRequest,
  type NewDraftRequest,
  type NewSchoolDraftRequest,
} from './library.ts'
import type { PromptChoice } from './picker.ts'

/**
 * The guided New Draft flow, with no React in it.
 *
 * SAME ARRANGEMENT AS library.ts, and for the same reason: NewDraftDialog is a
 * client component that `node --test` cannot import, so the rules worth testing
 * live here -- which screen follows which, when Create may fire, what is sent,
 * and what survives going backward -- and the dialog is the wiring that calls
 * them. The two decisions that are easy to get wrong and impossible to see in a
 * screenshot are both here: a stale prompt list, and a prompt outliving the
 * school it belonged to.
 *
 * NOTHING SERVER-ONLY IS REACHABLE FROM HERE. The imports are validate.ts,
 * library.ts and one type from picker.ts, all of which are already in the
 * browser bundle.
 */

/**
 * Which kind of statement is being started.
 *
 * NEITHER IS A DEFAULT. There is no initial value for this anywhere in the
 * flow -- `null` until the applicant picks one -- because a preselected path is
 * a path somebody can submit without having read it. An applicant who wanted
 * their Rutgers question and was handed a blank general draft would not find
 * out until the editor opened.
 */
export type CreatePath = 'school' | 'general'

/** The screens, in the order they are reached. */
export type NewDraftStep = 'choice' | 'school' | 'prompt' | 'title'

/**
 * Every word the dialog can show that is not already PICKER_MESSAGES'.
 *
 * The picker's own wording is reused where it fits -- an unreadable directory,
 * an empty one, a search that matched nothing, a failed prompt list -- because
 * those sentences are already written, already tested and already familiar from
 * the editor. What is here is the wording that only exists while a draft is
 * being STARTED, which is the two paths and what to do when a school turns out
 * to have no questions listed.
 */
export const NEW_DRAFT_MESSAGES = {
  schoolPath: 'Write for a specific school',
  schoolPathBody:
    'Choose a CRNA school and its personal statement prompt before creating the draft.',
  generalPath: 'Start a general statement',
  generalPathBody: 'Create a draft without choosing a school or prompt.',
  /**
   * A school whose catalog is empty. DELIBERATELY NOT the picker's noPrompts,
   * which ends "you can keep writing -- a prompt is optional": true in the
   * editor, where a draft already exists, and meaningless here, where nothing
   * has been created yet. What this reader needs is the way forward.
   */
  noPrompts: 'No prompts are listed for this school yet.',
  /** The way forward, and it keeps whatever title has been typed. */
  startGeneral: 'Start a general statement instead',
  chooseSchool: 'Choose a school',
  choosePrompt: 'Choose a prompt',
  nameDraft: 'Name your draft',
  back: 'Back',
} as const

/**
 * The screen a path opens on.
 *
 * The general path skips straight to the title: there is nothing to choose, and
 * a screen with one button that says "continue" is a screen that wastes a click.
 */
export function stepForPath(path: CreatePath): NewDraftStep {
  return path === 'school' ? 'school' : 'title'
}

/**
 * The screen BACK goes to, or null when there is nowhere left to go.
 *
 * NULL MEANS THE FIRST SCREEN, not "close the dialog". Cancel closes the
 * dialog; Back never does, so a misplaced click cannot throw away a title.
 *
 * THE TITLE IS NOT MENTIONED HERE, which is the point: moving between screens
 * is navigation, and the title is state that navigation does not touch. A test
 * on the dialog's source asserts the only two writes to it are the applicant's
 * keystrokes and the reset when the dialog opens.
 */
export function stepBefore(step: NewDraftStep, path: CreatePath | null): NewDraftStep | null {
  switch (step) {
    case 'choice':
      return null
    case 'school':
      return 'choice'
    case 'prompt':
      return 'school'
    case 'title':
      // The general path never saw the two middle screens, so its Back goes
      // all the way to the choice rather than to a school it never picked.
      return path === 'school' ? 'prompt' : 'choice'
  }
}

/**
 * Whether Create may fire.
 *
 * THIS IS NOT THE DUPLICATE GUARD, exactly as canSubmitNewDraft is not: it
 * decides what the button looks like, and the dialog holds a ref that is set
 * synchronously before the request. Two clicks in one tick would both read the
 * same `submitting`.
 *
 * A SCHOOL PATH WITHOUT A PROMPT MAY NOT CREATE, and that is the browser-side
 * half of a protection the server also enforces: POST refuses a promptId it
 * cannot resolve rather than creating a general draft. Both halves exist
 * because this one can be bypassed and that one cannot.
 *
 * Every comparison is against an exact boolean, matching canSubmitNewDraft:
 * a missing or malformed flag must not open the button.
 */
export function canCreateNow(input: {
  readonly path: CreatePath | null
  readonly title: string
  readonly promptId: string | null
  readonly submitting: boolean
  readonly retryable: boolean
}): boolean {
  if (input.path === null) return false
  if (input.submitting !== false) return false
  if (input.retryable !== true) return false
  if (!checkTitle(input.title).ok) return false
  if (input.path === 'school' && !isPromptId(input.promptId)) return false
  return true
}

/**
 * The prompt selection that survives choosing a school.
 *
 * A PROMPT CANNOT OUTLIVE ITS SCHOOL. It is one school's question, and keeping
 * it after the applicant moved to another would leave a draft answering
 * Rutgers' prompt under Duke's name -- with nothing on screen to say so. So any
 * real change of school drops it.
 *
 * RE-CLICKING THE SCHOOL ALREADY OPEN IS NOT A CHANGE, and must not drop it:
 * going Back to the school screen and clicking the same row again is how an
 * applicant checks they picked the right one.
 *
 * COMPARED BY ID, not by object identity: the school rows are re-derived by the
 * search filter on every keystroke, so the same school is a different object
 * moments later.
 */
export function selectionAfterSchoolChange(input: {
  readonly chosenId: string
  readonly browsingId: string | null
  readonly prompt: PromptChoice | null
}): PromptChoice | null {
  if (input.browsingId !== null && input.browsingId === input.chosenId) return input.prompt
  return null
}

/**
 * The request a path produces, built by the committed builders and by nothing
 * else.
 *
 * THE GENERAL PATH CANNOT SEND A PROMPT and the school path cannot omit one,
 * because the two bodies are built by two functions and neither takes an
 * argument that would let it behave like the other. A school path missing its
 * prompt is REFUSED here -- it does not fall back to a general draft, which is
 * the single most important thing this function does not do.
 */
export function createRequestFor(input: {
  readonly path: CreatePath
  readonly title: string
  readonly promptId: string | null
}): NewDraftRequest | NewSchoolDraftRequest {
  if (input.path === 'general') return newDraftRequest(input.title)
  return newSchoolDraftRequest(input.title, input.promptId)
}

/**
 * Whether a refusal was about the PROMPT rather than about the draft.
 *
 * WHY THIS IS A MESSAGE COMPARISON AND NOT PROSE MATCHING: both operands are
 * the same exported constant, so this is identity between two references to one
 * string, and rewording either message cannot change the answer. createOutcome
 * deliberately hands back only a message and a retry flag -- the code is mapped
 * away so no server prose can reach a reader -- so the message constant is what
 * there is to key on.
 *
 * WHAT IT IS FOR. A prompt withdrawn between choosing and creating must send
 * the applicant back to the prompt list with their title intact, rather than
 * leaving them on a screen whose Create button will fail the same way again.
 */
export function promptWasRefused(message: string): boolean {
  return message === CREATE_MESSAGES.promptGone || message === CREATE_MESSAGES.promptUnusable
}
