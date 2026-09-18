/**
 * Accept / Regenerate / Keep Original, as a pure state machine.
 *
 * The human gate is the fifth and last truthfulness layer, and the only one the
 * applicant operates. It has one job: nothing an AI wrote reaches the resume
 * until a person says so. So this module holds no text of its own, writes
 * nothing, and cannot reach the document — the driver emits a patch when, and
 * only when, `accept` is chosen.
 *
 * WHAT IS NEVER HERE. Rejected text. The route returns the violations it found
 * and not the sentences that carried them, so there is no state in which
 * unsupported prose sits next to an Accept button. That is the locked decision
 * made structural rather than merely intended.
 */

import { isBlankAuthoredText } from '../model/authoredText.ts'
import type { AuthoredText } from '../model/authoredText.ts'

/** What the verifier refused, named. Never the sentence it appeared in. */
export interface RejectedNote {
  readonly category: string
  readonly token: string
  readonly message: string
}

export interface Opportunity {
  readonly question: string
  readonly why: string
}

export type ProposalState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | {
      readonly kind: 'offered'
      readonly proposals: readonly string[]
      readonly index: number
      /**
       * Which candidates are ticked, in list order.
       *
       * Generation offers several bullets and the applicant may take more than
       * one; a rewrite offers alternatives of a single field and they may take
       * one. Both are the same offer with the same refusal, so both are this
       * state -- `index` is what a single-choice caller reads, `selected` what a
       * multiple-choice one reads. Empty until a person ticks something: nothing
       * arrives pre-chosen, because the choice is the whole point of the gate.
       */
      readonly selected: readonly number[]
      readonly opportunities: readonly Opportunity[]
      /** Refused alongside the offered ones. Named, never shown as text. */
      readonly rejected: readonly RejectedNote[]
    }
  /** Everything the model returned was refused. */
  | {
      readonly kind: 'refused'
      readonly rejected: readonly RejectedNote[]
      readonly opportunities: readonly Opportunity[]
    }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean }

export type ProposalEvent =
  | { readonly type: 'request' }
  | {
      readonly type: 'received'
      readonly proposals: readonly string[]
      readonly opportunities: readonly Opportunity[]
      readonly rejected: readonly RejectedNote[]
    }
  | { readonly type: 'failed'; readonly message: string; readonly retryable: boolean }
  | { readonly type: 'choose'; readonly index: number }
  /** Ticks or unticks one candidate, for an offer the applicant may take several of. */
  | { readonly type: 'toggle'; readonly index: number }
  /** The applicant took it. The driver emits the patch; this only resets. */
  | { readonly type: 'accepted' }
  /** The applicant kept what they had. Nothing is written anywhere. */
  | { readonly type: 'keep-original' }
  | { readonly type: 'dismiss' }

export const IDLE: ProposalState = { kind: 'idle' }

export function reduceProposal(state: ProposalState, event: ProposalEvent): ProposalState {
  switch (event.type) {
    case 'request':
      // Regenerate is the same event from `offered`: the old proposal is
      // replaced and nothing else moves.
      return { kind: 'working' }

    case 'received': {
      if (event.proposals.length > 0) {
        return {
          kind: 'offered',
          proposals: event.proposals,
          index: 0,
          selected: [],
          opportunities: event.opportunities,
          rejected: event.rejected,
        }
      }
      if (event.rejected.length > 0) {
        return { kind: 'refused', rejected: event.rejected, opportunities: event.opportunities }
      }
      // Nothing offered and nothing refused: the model had nothing to add.
      return {
        kind: 'error',
        message: 'The assistant had nothing to suggest from what you have entered.',
        retryable: false,
      }
    }

    case 'failed':
      return { kind: 'error', message: event.message, retryable: event.retryable }

    case 'choose':
      if (state.kind !== 'offered') return state
      if (event.index < 0 || event.index >= state.proposals.length) return state
      return { ...state, index: event.index }

    case 'toggle': {
      if (state.kind !== 'offered') return state
      if (event.index < 0 || event.index >= state.proposals.length) return state
      const selected = state.selected.includes(event.index)
        ? state.selected.filter((i) => i !== event.index)
        // Kept in list order, so what is added reads in the order it was shown
        // rather than the order it happened to be ticked.
        : [...state.selected, event.index].sort((a, b) => a - b)
      return { ...state, selected }
    }

    case 'accepted':
    case 'keep-original':
    case 'dismiss':
      return IDLE
  }
}

/** The proposal currently in front of the applicant, if any. */
export function selectedProposal(state: ProposalState): string | null {
  return state.kind === 'offered' ? state.proposals[state.index] ?? null : null
}

/** Whether one candidate is ticked. */
export function isSelected(state: ProposalState, index: number): boolean {
  return state.kind === 'offered' && state.selected.includes(index)
}

/**
 * Every ticked candidate, in the order they were offered.
 *
 * Empty when nothing is ticked, which is what disables "Add selected": adding
 * nothing is not an outcome anyone meant to ask for.
 */
export function selectedProposals(state: ProposalState): string[] {
  if (state.kind !== 'offered') return []
  return state.selected
    .map((i) => state.proposals[i])
    .filter((text): text is string => typeof text === 'string')
}

/** Whether a Regenerate control makes sense right now. */
export function canRegenerate(state: ProposalState): boolean {
  return state.kind === 'offered' || state.kind === 'refused' ||
    (state.kind === 'error' && state.retryable)
}

/**
 * Whether "Restore original" should be offered.
 *
 * It restores `originalSource` — the first text ever supplied. For anything
 * written in the Studio that is the empty string the field was created with, so
 * the control would ERASE rather than restore. It earns its place only when the
 * original is real: imported prose, or text that existed before an AI touched
 * it. Hiding it otherwise is the whole of the fix.
 */
export function canRestoreOriginal(text: AuthoredText | null | undefined): boolean {
  if (!text) return false
  if (text.originalSource.trim() === '') return false
  if (text.originalSource === text.accepted) return false
  return true
}

/**
 * Whether "Restore my text" should be offered — the "undo the AI, keep my
 * edits" action, which is the one that matters for Studio-written prose.
 */
export function canRestoreUserText(text: AuthoredText | null | undefined): boolean {
  if (!text || isBlankAuthoredText(text)) return false
  if (text.userSource.trim() === '') return false
  return text.accepted !== text.userSource
}
