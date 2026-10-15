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
export type NewDraftStep =
  'choice' | 'school' | 'requirement' | 'prompt' | 'paste' | 'report' | 'title'

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
   *
   * IT SAYS WHOSE GAP IT IS. "No prompts are listed" reads as a fact about the
   * school; the applicant's reasonable conclusion is that there is nothing to
   * write yet, which is false and costs them the feature. "We don't have it
   * yet" is the same fact, attributed correctly, and it makes the next sentence
   * an offer rather than an apology.
   */
  noPrompts: 'We don\u2019t have this school\u2019s current writing prompt yet.',
  /**
   * The offer that follows it.
   *
   * TWO CLAUSES, AND THE SECOND IS THE ONE THAT MATTERS. An applicant asked to
   * contribute to a directory is doing us a favour; an applicant told they can
   * start writing immediately is being offered something. Both are true, and
   * the order reflects which one answers "why would I?".
   */
  noPromptsInvite:
    'Have the prompt from your application? Add it here and you can start '
    + 'writing immediately.',
  /** The way forward, and it keeps whatever title has been typed. */
  startGeneral: 'Start a general statement instead',
  /**
   * The third way to start, offered alongside a school's listed questions.
   *
   * IT NAMES THE REASON SCHOOLS CHANGE. "Don't see your prompt?" invites a
   * reader who thinks they have missed something to look again. School prompts
   * are rewritten between application cycles, so the common case is not that
   * the applicant cannot find ours -- it is that theirs is newer. Saying so
   * makes submitting the obvious move rather than a last resort, and it is how
   * a changed prompt reaches the review queue at all.
   */
  pastePrompt: 'My school gave me a different or newer prompt',
  pasteHeading: 'Add your school prompt',
  /**
   * THE CONSENT SENTENCE, shown before the box is sent and not after.
   *
   * It says both halves plainly, because both are true and only one of them is
   * obvious: the wording may be published, and the writing never is.
   */
  pasteNotice:
    'Your submitted prompt will be reviewed by CRNAPREPHUB and may be added to our shared '
    + 'school-prompt directory. Your personal statement and essay will remain private.',
  pasteConfirm: 'I understand my prompt may be added to the shared directory.',
  /** What a draft on a pasted prompt is labelled, everywhere it appears. */
  unverifiedBadge: 'User-provided prompt \u2014 Not yet verified by CRNAPREPHUB',
  pasteIncomplete: 'Add the prompt wording and confirm before creating the draft.',
  /** The checklist screen's heading, and its one-line explanation. */
  chooseRequirement: 'Choose a writing requirement',
  requirementBody:
    'This school asks for the documents below. Start whichever you want to write first '
    + '— each one is saved and analysed separately, and you can come back for the rest.',
  /**
   * The escape back to the school list.
   *
   * IT USED TO READ "Looking for a different prompt? See this school's listed
   * prompts." -- which described what it did, and what it did was the wrong
   * thing: it stayed on the school already chosen and offered that school's
   * OTHER prompts. An applicant who has picked the wrong school reads "a
   * different prompt" as the way out and lands back in the same place.
   */
  otherPrompts: 'See Other School Prompts',
  /** A requirement-backed create with an empty title. */
  requirementTitleRequired: 'Name this draft before creating it.',
  /** Shown on the control itself when the backend for this is not switched on. */
  previewBlocked: 'Submission unavailable in preview',
  /**
   * WHAT PREVIEW IS, IN ONE SENTENCE AN APPLICANT WOULD UNDERSTAND. It says
   * what will happen once the feature is on -- writing starts immediately,
   * review happens afterwards -- without claiming any of it happens yet.
   */
  previewExplainer:
    'This is a visual preview, so nothing is saved and no prompt is submitted. Once this '
    + 'feature is switched on, your draft is created straight away and you can start writing '
    + 'while your prompt waits to be reviewed.',
  pasteSchoolMissing: 'Choose a school before pasting its prompt.',
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

/**
 * The state that returning to "Choose a school" must leave behind.
 *
 * ---------------------------------------------------------------------------
 * A LABEL CHANGE WOULD NOT HAVE FIXED THIS
 * ---------------------------------------------------------------------------
 * The control this belongs to used to call a handler that set `step` and
 * nothing else, so the chosen school survived the transition and the applicant
 * was shown the same school's other prompts. Renaming the button would have
 * made it lie more clearly.
 *
 * DECLARED AS DATA so the dialog and its test read one list. Every field that
 * identifies a school, a prompt or a requirement is here and is null; a new
 * one added to the dialog without being added here is a field that survives
 * the reset, which is the bug all over again.
 *
 * THE TITLE IS ABSENT ON PURPOSE, like every other transition in this dialog:
 * moving between screens is navigation, and navigation does not throw away
 * what the applicant typed.
 */
export const SCHOOL_CHOICE_RESET = {
  step: 'school',
  path: 'school',
  school: null,
  prompt: null,
  pasted: null,
  /*
   * A CHANGED-PROMPT REPORT IS ABOUT ONE CATALOG ROW, so it is as school-
   * specific as anything else here. Leaving it behind would carry a report
   * against Rush's prompt into a visit to Duke, and the submission would name
   * a requirement the applicant is no longer looking at.
   */
  report: null,
  requirementId: null,
  requirementSets: null,
  prompts: null,
  promptNotice: null,
  message: null,
} as const

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
    // The checklist is reached FROM the school list, and the prompt list is
    // reached either from the school list (no requirements published) or from
    // the checklist (a school that has both). Back from the prompt list
    // therefore cannot name one fixed predecessor, so it returns to the school
    // list -- which is reachable from either and loses nothing but one click.
    case 'requirement':
      return 'school'
    case 'prompt':
      return 'school'
    // The paste form is reached FROM the prompt list -- including from the
    // version of it that had no prompts to list -- so Back returns there.
    case 'paste':
      return 'prompt'
    // The report form is reached from the CHECKLIST, because that is where the
    // row being reported is shown. Back to the prompt list would be back to
    // the other catalog, which has no card the applicant just clicked.
    case 'report':
      return 'requirement'
    case 'title':
      // The general path never saw the middle screens, so its Back goes all
      // the way to the choice rather than to a school it never picked.
      //
      // A REQUIREMENT-BACKED TITLE GOES BACK TO THE CHECKLIST, not the prompt
      // list, and stepBeforeTitle() below is what decides that -- this
      // function has only the path to go on, and both kinds of school draft
      // share one path value.
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

/* ===========================================================================
 * A PASTED PROMPT.
 *
 * The third thing an applicant can start from, and the one that must never be
 * confused with the second. An approved prompt is named by an id the server
 * resolves against a catalog no browser may write; a pasted prompt is wording
 * the browser supplies. They travel different request shapes, through
 * different builders, to different branches of the route, and end in different
 * columns -- so there is no single place where swapping one for the other is a
 * typo away.
 * ======================================================================== */

/** What an applicant typed, before any of it has been checked. */
export interface PastedPrompt {
  readonly promptText: string
  readonly statedMaxWords: number | null
  readonly applicationCycle: string | null
  readonly sourceUrl: string | null
  /** Their explicit agreement that this wording may be published. */
  readonly confirmed: boolean
  // ---- what else their school may have told them, all optional -----------
  //
  // NINE MORE FIELDS AND NOT ONE MORE REQUIRED ONE. The form keeps them behind
  // a disclosure for exactly this reason: an applicant who has only the wording
  // must be able to submit in two fields, and an applicant holding a page of
  // instructions must not have to throw most of it away.
  //
  // NO ENFORCEMENT REGISTER AMONG THEM. Deciding whether "about 500 words" is a
  // cap or a target is a judgement the administrator makes from this evidence;
  // asking the applicant would manufacture reviewed-looking data nobody
  // reviewed. See 20261006_008.
  readonly documentLabel: string | null
  /** Their words for the kind of document. Never our nine-value taxonomy. */
  readonly documentTypeHint: string | null
  readonly statedMinWords: number | null
  readonly statedMaxCharacters: number | null
  /** A number, when they have a clean one. One decimal place, so 1.5 works. */
  readonly statedMaxPages: number | null
  /** Their own wording, for everything a number cannot hold. */
  readonly statedPagesText: string | null
  readonly formattingInstructions: string | null
  readonly otherInstructions: string | null
  readonly submitterNote: string | null
}

/**
 * What the applicant has chosen to write against, as a closed union.
 *
 * THE DISCRIMINANT IS THE POINT. 'approved' carries an id and no wording;
 * 'pasted' carries wording and no id. Neither member can hold the other's
 * field, so a function that handles one cannot silently accept the other, and
 * adding a third kind later forces every reader to say what it means.
 */
export type DraftSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'approved'; readonly promptId: string }
  | { readonly kind: 'pasted'; readonly pasted: PastedPrompt }

/** An empty paste, for a form that has just been opened. */
export const EMPTY_PASTE: PastedPrompt = {
  promptText: '',
  statedMaxWords: null,
  applicationCycle: null,
  sourceUrl: null,
  confirmed: false,
  documentLabel: null,
  documentTypeHint: null,
  statedMinWords: null,
  statedMaxCharacters: null,
  statedMaxPages: null,
  statedPagesText: null,
  formattingInstructions: null,
  otherInstructions: null,
  submitterNote: null,
}

/**
 * Whether a paste is complete enough to send.
 *
 * WORDING AND CONSENT, and nothing else is required: the three optional fields
 * are optional because a school often states none of them, and demanding a word
 * limit nobody published would make applicants invent one.
 *
 * CONSENT IS CHECKED HERE AS WELL AS IN THE VALIDATOR because this is what
 * decides whether the button is live. The validator is what decides whether the
 * request is honoured, and a caller that never rendered the checkbox is refused
 * there regardless of what this returns.
 */
export function pasteIsComplete(pasted: PastedPrompt | null | undefined): boolean {
  if (!pasted) return false
  if (typeof pasted.promptText !== 'string') return false
  if (pasted.promptText.trim().length === 0) return false
  return pasted.confirmed === true
}

/**
 * The request that creates a draft from a pasted prompt.
 *
 * A DIFFERENT SHAPE FROM BOTH OTHERS, deliberately. The general body is two
 * keys, the approved body is three with a promptId, and this one nests
 * everything the submission needs under `promptSubmission` -- so the route can
 * tell the three apart by shape alone, and the pasted branch is taken before
 * the promptId branch is ever reached.
 *
 * NO promptId, AND NO WAY TO ADD ONE. The object is built with exactly two
 * top-level keys plus the submission, from arguments that do not include a
 * catalog id, so this path cannot claim catalog provenance even by mistake.
 */
export type PastedDraftRequest =
  | {
      readonly ok: true
      readonly body: {
        readonly title: string
        readonly essay: string
        readonly promptSubmission: {
          readonly schoolId: string
          readonly promptText: string
          readonly statedMaxWords: number | null
          readonly applicationCycle: string | null
          readonly sourceUrl: string | null
          readonly confirmed: true
          // 20261006_008. Nullable, never absent: a key that is sometimes
          // missing is a shape the route would have to reason about twice.
          readonly documentLabel: string | null
          readonly documentTypeHint: string | null
          readonly statedMinWords: number | null
          readonly statedMaxCharacters: number | null
          readonly statedMaxPages: number | null
          readonly statedPagesText: string | null
          readonly formattingInstructions: string | null
          readonly otherInstructions: string | null
          readonly submitterNote: string | null
        }
      }
    }
  | { readonly ok: false; readonly message: string }

export function newPastedDraftRequest(
  rawTitle: unknown,
  schoolId: unknown,
  pasted: PastedPrompt | null,
): PastedDraftRequest {
  const checked = checkTitle(rawTitle)
  if (!checked.ok) {
    return {
      ok: false,
      message: checked.code === 'title-too-long' ? CREATE_MESSAGES.tooLong : CREATE_MESSAGES.title,
    }
  }
  if (!isPromptId(schoolId)) {
    return { ok: false, message: NEW_DRAFT_MESSAGES.pasteSchoolMissing }
  }
  if (!pasteIsComplete(pasted) || pasted === null) {
    return { ok: false, message: NEW_DRAFT_MESSAGES.pasteIncomplete }
  }
  return {
    ok: true,
    body: {
      title: checked.title,
      essay: '',
      promptSubmission: {
        schoolId,
        promptText: pasted.promptText,
        statedMaxWords: pasted.statedMaxWords,
        applicationCycle: pasted.applicationCycle,
        sourceUrl: pasted.sourceUrl,
        confirmed: true,
        // PASSED THROUGH UNREAD. Every one is validated by
        // checkPromptSubmission on the server; this builder's job is to carry
        // what was typed, not to decide whether it is usable.
        //
        // COALESCED TO null, NEVER undefined, AND THAT IS NOT COSMETIC.
        // JSON.stringify DROPS an undefined value, so a caller holding an older
        // PastedPrompt would send a body with the key missing rather than
        // present-and-empty -- and the declared type here says `string | null`,
        // which would then be a lie about what crossed the wire.
        documentLabel: pasted.documentLabel ?? null,
        documentTypeHint: pasted.documentTypeHint ?? null,
        statedMinWords: pasted.statedMinWords ?? null,
        statedMaxCharacters: pasted.statedMaxCharacters ?? null,
        statedMaxPages: pasted.statedMaxPages ?? null,
        statedPagesText: pasted.statedPagesText ?? null,
        formattingInstructions: pasted.formattingInstructions ?? null,
        otherInstructions: pasted.otherInstructions ?? null,
        submitterNote: pasted.submitterNote ?? null,
      },
    },
  }
}

/**
 * Whether Create may fire for a pasted prompt.
 *
 * A SIBLING OF canCreateNow RATHER THAN A BRANCH INSIDE IT, so the committed
 * rule -- "the school path may not create without a prompt id" -- keeps meaning
 * exactly what it meant, and a pasted prompt cannot satisfy it by accident.
 */
export function canCreatePasteNow(input: {
  readonly title: string
  readonly schoolId: string | null
  readonly pasted: PastedPrompt | null
  readonly submitting: boolean
  readonly retryable: boolean
}): boolean {
  if (input.submitting !== false) return false
  if (input.retryable !== true) return false
  if (!isPromptId(input.schoolId)) return false
  if (!pasteIsComplete(input.pasted)) return false
  return checkTitle(input.title).ok
}

/**
 * The screen BACK goes to from the title, when a requirement may be in play.
 *
 * A SEPARATE FUNCTION BECAUSE stepBefore() DOES NOT HAVE THE ANSWER. Both kinds
 * of school draft carry path === 'school', so the only thing that distinguishes
 * "I chose a document from the checklist" from "I chose a prompt from the list"
 * is whether a requirement id is held. Rather than widen stepBefore()'s
 * signature and every call to it, this wraps it for the one screen that needs
 * the distinction.
 *
 * SENDING A REQUIREMENT-BACKED DRAFT BACK TO THE PROMPT LIST would be the bug
 * this prevents: that list is the other catalog, and the applicant would see
 * questions they did not choose from with no way back to the one they did.
 */
export function stepBeforeTitle(input: {
  readonly path: CreatePath | null
  readonly requirementId: string | null
}): NewDraftStep | null {
  if (input.path === 'school' && input.requirementId !== null) return 'requirement'
  return stepBefore('title', input.path)
}
