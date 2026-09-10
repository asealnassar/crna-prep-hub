/**
 * Authored text and AI provenance.
 *
 * This is the type that carries the V2 truthfulness contract. Every sentence
 * that reaches a rendered resume is an AuthoredText, and the shape enforces
 * what the product locked in:
 *
 *   1. the applicant's FIRST words are preserved permanently
 *   2. the applicant's LATEST words are preserved separately
 *   3. an AI suggestion is inert until explicitly accepted
 *   4. no AI operation can write either of the applicant's texts
 *
 * Four texts, and the distinction between the first two is the correction that
 * makes the model honest over a long editing session:
 *
 *   originalSource  what was FIRST supplied — typed or imported. Written once,
 *                   at construction, and never again by anything.
 *   userSource      the LATEST text a human authored. Moves only when a person
 *                   edits. Equals originalSource until the first edit.
 *   accepted        what actually renders. May be AI text, once accepted.
 *   proposal        a pending suggestion. Rendered by nothing.
 *
 * Without the split, "restore my original" degrades as soon as someone edits
 * twice: the thing they first wrote is gone. With it, both "give me back what
 * I first wrote" and "give me back what I last wrote" stay answerable for the
 * life of the resume.
 *
 * (4) is structural rather than conventional. `originalSource` is assigned in
 * exactly one place — `createAuthoredText` — and `userSource` in exactly one
 * more — `editSource`, which represents a person typing. No AI-facing
 * transition writes either, and a test enumerates every AI-reachable path to
 * prove it.
 *
 * V1 had none of this. It assigned generated bullets straight over the field
 * the applicant had typed into, with no diff, no confirmation and no way back.
 */

/** Where a piece of text came from. AI is only reachable via acceptance. */
export type TextOrigin = 'user' | 'import' | 'ai-accepted'

/** Origins a human or their document can produce. Deliberately excludes AI. */
export type SourceOrigin = Extract<TextOrigin, 'user' | 'import'>

/**
 * An untaken suggestion. Not rendered, not scored, not exported — it exists
 * only until someone decides about it.
 *
 * `groundedIn` records the fact ids the proposal was permitted to use. It is
 * the audit trail for "what was the model allowed to know?", and later phases
 * verify generated text against exactly that list.
 */
export interface AIProposal {
  readonly text: string
  readonly model: string
  readonly groundedIn: readonly string[]
  readonly createdAt: string
}

export interface AuthoredTextHistoryEntry {
  readonly text: string
  readonly origin: TextOrigin
  readonly replacedAt: string
}

export interface AuthoredText {
  /** The first text ever supplied. Immutable after construction. */
  readonly originalSource: string
  /** Whether that first text was typed or extracted from an upload. */
  readonly originalOrigin: SourceOrigin
  /** The latest human-authored text. Only `editSource` moves this. */
  readonly userSource: string
  /** 'import' until a person edits, then 'user'. */
  readonly userOrigin: SourceOrigin
  /** What currently renders. */
  readonly accepted: string
  readonly origin: TextOrigin
  /** A pending suggestion, awaiting Accept / Regenerate / Keep Original. */
  readonly proposal: AIProposal | null
  /** Most recent first. Bounded — see MAX_HISTORY. */
  readonly history: readonly AuthoredTextHistoryEntry[]
}

/**
 * Undo depth. Bounded in the type, not in the UI, because every retained entry
 * is another stored copy of someone's personal text.
 */
export const MAX_HISTORY = 5

export function createAuthoredText(text: string, origin: SourceOrigin = 'user'): AuthoredText {
  const value = text ?? ''
  return {
    originalSource: value,
    originalOrigin: origin,
    userSource: value,
    userOrigin: origin,
    accepted: value,
    origin,
    proposal: null,
    history: [],
  }
}

export const EMPTY_AUTHORED_TEXT: AuthoredText = createAuthoredText('', 'user')

function pushHistory(at: AuthoredText, replacedAt: string): readonly AuthoredTextHistoryEntry[] {
  const entry: AuthoredTextHistoryEntry = {
    text: at.accepted,
    origin: at.origin,
    replacedAt,
  }
  return [entry, ...at.history].slice(0, MAX_HISTORY)
}

/**
 * A person typing. The ONLY function that writes `userSource`, and it still
 * cannot touch `originalSource`.
 *
 * Editing takes ownership of whatever was on screen: `userSource` and
 * `accepted` both become the new text, and the previous accepted value goes to
 * history. `userOrigin` becomes 'user' even when the text arrived by import,
 * because a person has now written it — while `originalOrigin` keeps saying
 * where it started.
 */
export function editSource(at: AuthoredText, text: string, now: string): AuthoredText {
  const value = text ?? ''
  if (value === at.accepted && value === at.userSource && at.proposal === null) return at
  return {
    ...at,
    userSource: value,
    userOrigin: 'user',
    accepted: value,
    origin: 'user',
    proposal: null,
    history: pushHistory(at, now),
  }
}

/** Attaches a suggestion. Changes nothing that renders. */
export function propose(at: AuthoredText, proposal: AIProposal): AuthoredText {
  return { ...at, proposal }
}

/** Discards a suggestion and leaves everything else alone. */
export function keepOriginal(at: AuthoredText): AuthoredText {
  return at.proposal === null ? at : { ...at, proposal: null }
}

/** Alias — the UI calls this rejecting, the model calls it keeping. */
export const rejectProposal = keepOriginal

/**
 * The single point at which AI text becomes visible.
 *
 * Note what it does NOT touch: both `originalSource` and `userSource` pass
 * through unchanged, so the applicant's first words and their latest words
 * both survive the acceptance.
 */
export function acceptProposal(at: AuthoredText, now: string): AuthoredText {
  if (at.proposal === null) return at
  return {
    ...at,
    accepted: at.proposal.text,
    origin: 'ai-accepted',
    proposal: null,
    history: pushHistory(at, now),
  }
}

/**
 * Restores the TRUE original — what was first typed or imported, however many
 * edits and acceptances have happened since.
 */
export function restoreOriginal(at: AuthoredText, now: string): AuthoredText {
  if (at.accepted === at.originalSource && at.origin === at.originalOrigin) {
    return keepOriginal(at)
  }
  return {
    ...at,
    accepted: at.originalSource,
    origin: at.originalOrigin,
    proposal: null,
    history: pushHistory(at, now),
  }
}

/**
 * Restores the applicant's LATEST words — the "undo the AI, keep my edits"
 * action, which is a different request from restoring the first draft.
 *
 * Storing `userSource` would be pointless without a way back to it; this is
 * that way, and it is the whole of the addition.
 */
export function restoreUserText(at: AuthoredText, now: string): AuthoredText {
  if (at.accepted === at.userSource && at.origin === at.userOrigin) {
    return keepOriginal(at)
  }
  return {
    ...at,
    accepted: at.userSource,
    origin: at.userOrigin,
    proposal: null,
    history: pushHistory(at, now),
  }
}

/**
 * One step of undo. Walks BACK through accepted states, consuming the entry it
 * restores, so pressing it N times moves N states back.
 *
 * The obvious alternative -- pushing the current value onto the front of the
 * stack -- makes the second press undo the first, which is a redo toggle
 * wearing an undo label. There is deliberately no redo here: this is the
 * lightweight history the product asked for, and the two explicit jumps
 * (Restore Original, Restore My Text) plus regeneration cover getting forward
 * again.
 *
 * `now` is accepted for signature symmetry with the other transitions and so
 * a future change can record when an undo happened without a breaking change.
 */
export function restorePrevious(at: AuthoredText, now: string): AuthoredText {
  void now
  const [previous, ...rest] = at.history
  if (!previous) return at
  return {
    ...at,
    accepted: previous.text,
    origin: previous.origin,
    proposal: null,
    history: rest,
  }
}

/** True when nothing would render. Whitespace does not count as content. */
export function isBlankAuthoredText(at: AuthoredText): boolean {
  return at.accepted.trim() === ''
}

/** Whether what renders came from a model. */
export function isAiAuthored(at: AuthoredText): boolean {
  return at.origin === 'ai-accepted'
}

export function hasPendingProposal(at: AuthoredText): boolean {
  return at.proposal !== null
}

/** Whether a person has rewritten this since it was first supplied. */
export function hasBeenEdited(at: AuthoredText): boolean {
  return at.userSource !== at.originalSource
}

/** Whether the first supplied text came from an uploaded document. */
export function isImported(at: AuthoredText): boolean {
  return at.originalOrigin === 'import'
}
