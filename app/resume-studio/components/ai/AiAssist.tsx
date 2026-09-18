'use client'

import { useCallback, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RotateCcw, Sparkles } from 'lucide-react'
import {
  IDLE, canRestoreOriginal, canRestoreUserText, reduceProposal, selectedProposals,
} from '@/lib/resume/ai/proposalFlow'
import type { ProposalState } from '@/lib/resume/ai/proposalFlow'
import { usableCandidates } from '@/lib/resume/ai/candidates'
import { BULLET_CANDIDATES } from '@/lib/resume/ai/request'
import type { AuthoredText } from '@/lib/resume/model/authoredText'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import { Button, IconButton } from '../ui'
import ProposalCard from './ProposalCard'

/**
 * The AI affordance on one field.
 *
 * Asks the server for a proposal, shows it, and emits a patch only when the
 * applicant accepts. It never writes to the document itself and never holds the
 * resume -- the request names a field and the server builds the grounding from
 * the stored row.
 *
 * NO COUNTER, NO ALLOWANCE, NO "GENERATIONS REMAINING". There is no quota, so
 * nothing here may imply one. A 429 is shown as "try again shortly" and never
 * as a reason to upgrade, because it is not one.
 *
 * UNAVAILABLE IS NOT HIDDEN. When there is not enough of the applicant's own
 * work for a proposal to be an improvement, the control stays visible, disabled,
 * and says what would change that. A control that vanishes teaches nothing; the
 * server refuses the same request in the same words. See lib/resume/ai/gating.ts.
 *
 * LAYOUT IS THE CALLER'S. By default the trigger and restore controls sit in a
 * row with the suggestion beneath. A caller that wants them inside a field's own
 * toolbar passes `children` and places them; the suggestion still renders
 * directly beneath whatever the caller drew.
 */

const ENDPOINT = '/api/resume-v2/ai/propose'

export interface AiTarget {
  readonly resumeId: string
  readonly sectionId: string
  readonly targetId?: string | null
  readonly bulletIndex?: number | null
  /** The narrative field on an entry, for list-shaped sections. */
  readonly field?: string | null
}

export interface AiAssistParts {
  /** The control that asks for a suggestion. */
  readonly trigger: ReactNode
  /** Restore my text / Restore original, or null when neither applies. */
  readonly restore: ReactNode
  /**
   * Asks for a suggestion, for a caller whose own control starts the request.
   *
   * Bullet generation opens a fact picker first and asks only when the
   * applicant confirms, so it renders its own button and never `trigger`.
   */
  readonly run: () => void
  /** A request is in flight. A caller drawing its own control shows this. */
  readonly busy: boolean
}

export default function AiAssist({
  target,
  operation,
  label,
  text,
  acceptPatch,
  acceptManyPatch,
  restorePatch,
  emit,
  variant = 'button',
  unavailable,
  existingText,
  children,
}: {
  target: AiTarget
  operation: string
  label: string
  /** The field's current authored text, for the restore controls. */
  text?: AuthoredText | null
  /**
   * Builds the patch(es) that accept a proposal. More than one when accepting
   * creates the field it fills -- generating a new bullet adds it, then fills
   * it, and both land in the same save.
   */
  acceptPatch: (proposal: string, model: string, groundedIn: string[]) => StudioPatch | StudioPatch[]
  /**
   * Builds the patches that accept SEVERAL proposals at once.
   *
   * Supplying it is what makes an offer multiple-choice. Generation returns
   * candidates rather than an answer -- an applicant with five true bullets
   * should not have to ask five times, and one who finds two of five true should
   * be able to take exactly those two.
   */
  acceptManyPatch?: (proposals: string[], model: string, groundedIn: string[]) => StudioPatch[]
  /** Builds the patch that undoes an acceptance. */
  restorePatch?: (scope: 'original' | 'user') => StudioPatch
  emit: (patch: StudioPatch) => void
  /** `icon`: a compact sparkle button for tight rows, named by `label`. */
  variant?: 'button' | 'icon'
  /**
   * Why the action cannot be offered yet, in words for the applicant. Empty or
   * absent means it can.
   */
  unavailable?: string
  /**
   * Text already on the resume here. A candidate that repeats one of these is
   * dropped before it is offered: a suggestion to write what is already written
   * is not a suggestion.
   */
  existingText?: readonly string[]
  children?: (parts: AiAssistParts) => ReactNode
}) {
  const [state, setState] = useState<ProposalState>(IDLE)
  const inFlight = useRef(false)
  const modelRef = useRef('')
  const groundedRef = useRef<string[]>([])
  const reasonId = useId()

  const multi = Boolean(acceptManyPatch)
  const blocked = Boolean(unavailable)

  const request = useCallback(async () => {
    if (inFlight.current || blocked) return
    inFlight.current = true
    setState((s) => reduceProposal(s, { type: 'request' }))

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeId: target.resumeId,
          sectionId: target.sectionId,
          targetId: target.targetId ?? null,
          bulletIndex: target.bulletIndex ?? null,
          field: target.field ?? null,
          operation,
          // Several candidates where the applicant may take several; one field's
          // alternatives where they may take one.
          maxItems: multi ? BULLET_CANDIDATES : 3,
        }),
      })
      const body = await res.json().catch(() => ({} as Record<string, unknown>))

      if (res.status === 429) {
        // A rate ceiling, not a plan boundary. The wording matters.
        setState((s) => reduceProposal(s, {
          type: 'failed',
          message: typeof body.message === 'string' ? body.message : 'Too many requests just now. Please try again shortly.',
          retryable: true,
        }))
        return
      }
      if (!res.ok) {
        setState((s) => reduceProposal(s, {
          type: 'failed',
          // The server's own words when it has some: a refusal the applicant can
          // act on beats "that request could not be made".
          message: typeof body.message === 'string' && body.message !== ''
            ? body.message
            : res.status >= 500 ? 'The assistant is unavailable right now.' : 'That request could not be made.',
          retryable: res.status >= 500,
        }))
        return
      }

      modelRef.current = typeof body.model === 'string' ? body.model : 'gpt-4o'
      groundedRef.current = Array.isArray(body.groundedIn) ? (body.groundedIn as string[]) : []

      setState((s) => reduceProposal(s, {
        type: 'received',
        // Filtered here as well as on the server: what the applicant has typed
        // since the request was sent is newer than anything the server read.
        proposals: usableCandidates(
          Array.isArray(body.proposals) ? (body.proposals as string[]) : [],
          existingText ?? []
        ),
        opportunities: Array.isArray(body.opportunities) ? (body.opportunities as { question: string; why: string }[]) : [],
        rejected: Array.isArray(body.rejected) ? (body.rejected as { category: string; token: string; message: string }[]) : [],
      }))
    } catch {
      setState((s) => reduceProposal(s, { type: 'failed', message: 'Could not reach the server.', retryable: true }))
    } finally {
      inFlight.current = false
    }
  }, [target.resumeId, target.sectionId, target.targetId, target.bulletIndex, target.field, operation, multi, blocked, existingText])

  const showRestoreOriginal = Boolean(restorePatch) && canRestoreOriginal(text)
  const showRestoreUser = Boolean(restorePatch) && canRestoreUserText(text)
  const working = state.kind === 'working'

  const triggerProps = {
    disabled: working || blocked,
    'aria-busy': working,
    'aria-describedby': blocked ? reasonId : undefined,
    onClick: () => void request(),
  }

  const trigger = variant === 'icon' ? (
    <IconButton icon={Sparkles} tone="ai" label={working ? 'Working...' : label} {...triggerProps} />
  ) : (
    <Button size="sm" variant="ai" icon={Sparkles} {...triggerProps}>
      {working ? 'Working...' : label}
    </Button>
  )

  // Said once, beneath the control it explains, and tied to it for a screen
  // reader by aria-describedby rather than by proximity alone.
  const why = blocked ? (
    <p id={reasonId} className="mt-1.5 text-xs text-slate-500">{unavailable}</p>
  ) : null

  // Restore my text: the control that matters for anything written here.
  // Restore original is hidden unless the original is real -- for a field
  // created blank it would erase rather than restore.
  const restore = (showRestoreUser || showRestoreOriginal) && restorePatch ? (
    <span className="inline-flex flex-wrap items-center">
      {showRestoreUser && (
        <Button size="sm" variant="tertiary" icon={RotateCcw} onClick={() => emit(restorePatch('user'))}>
          Restore my text
        </Button>
      )}
      {showRestoreOriginal && (
        <Button size="sm" variant="tertiary" onClick={() => emit(restorePatch('original'))}>
          Restore original
        </Button>
      )}
    </span>
  ) : null

  const suggestion = (
    <ProposalCard
      state={state}
      multi={multi}
      onChoose={(index) => setState((s) => reduceProposal(s, { type: 'choose', index }))}
      onToggle={(index) => setState((s) => reduceProposal(s, { type: 'toggle', index }))}
      onRegenerate={() => void request()}
      onKeepOriginal={() => setState((s) => reduceProposal(s, { type: 'keep-original' }))}
      onAccept={(chosen) => {
        const patches = acceptPatch(chosen, modelRef.current, groundedRef.current)
        for (const patch of Array.isArray(patches) ? patches : [patches]) emit(patch)
        setState((s) => reduceProposal(s, { type: 'accepted' }))
      }}
      onAcceptMany={() => {
        const chosen = selectedProposals(state)
        if (!acceptManyPatch || chosen.length === 0) return
        for (const patch of acceptManyPatch(chosen, modelRef.current, groundedRef.current)) emit(patch)
        setState((s) => reduceProposal(s, { type: 'accepted' }))
      }}
    />
  )

  if (children) {
    return (
      <div className="min-w-0">
        {children({ trigger, restore, run: () => void request(), busy: working })}
        {why}
        {suggestion}
      </div>
    )
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1">
        {trigger}
        {restore}
      </div>
      {why}
      {suggestion}
    </div>
  )
}
