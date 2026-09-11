'use client'

import { useCallback, useRef, useState } from 'react'
import {
  IDLE, canRestoreOriginal, canRestoreUserText, reduceProposal,
} from '@/lib/resume/ai/proposalFlow'
import type { ProposalState } from '@/lib/resume/ai/proposalFlow'
import type { AuthoredText } from '@/lib/resume/model/authoredText'
import type { StudioPatch } from '@/lib/resume/studio/patch'
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

export default function AiAssist({
  target,
  operation,
  label,
  text,
  acceptPatch,
  restorePatch,
  emit,
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
  /** Builds the patch that undoes an acceptance. */
  restorePatch?: (scope: 'original' | 'user') => StudioPatch
  emit: (patch: StudioPatch) => void
}) {
  const [state, setState] = useState<ProposalState>(IDLE)
  const inFlight = useRef(false)
  const modelRef = useRef('')
  const groundedRef = useRef<string[]>([])

  const request = useCallback(async () => {
    if (inFlight.current) return
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
          maxItems: 3,
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
          message: res.status >= 500 ? 'The assistant is unavailable right now.' : 'That request could not be made.',
          retryable: res.status >= 500,
        }))
        return
      }

      modelRef.current = typeof body.model === 'string' ? body.model : 'gpt-4o'
      groundedRef.current = Array.isArray(body.groundedIn) ? (body.groundedIn as string[]) : []

      setState((s) => reduceProposal(s, {
        type: 'received',
        proposals: Array.isArray(body.proposals) ? (body.proposals as string[]) : [],
        opportunities: Array.isArray(body.opportunities) ? (body.opportunities as { question: string; why: string }[]) : [],
        rejected: Array.isArray(body.rejected) ? (body.rejected as { category: string; token: string; message: string }[]) : [],
      }))
    } catch {
      setState((s) => reduceProposal(s, { type: 'failed', message: 'Could not reach the server.', retryable: true }))
    } finally {
      inFlight.current = false
    }
  }, [target.resumeId, target.sectionId, target.targetId, target.bulletIndex, target.field, operation])

  const showRestoreOriginal = Boolean(restorePatch) && canRestoreOriginal(text)
  const showRestoreUser = Boolean(restorePatch) && canRestoreUserText(text)

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void request()}
          disabled={state.kind === 'working'}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-indigo-300/40 bg-indigo-400/10 text-indigo-100 hover:bg-indigo-400/20 transition disabled:opacity-50"
        >
          {state.kind === 'working' ? 'Working...' : label}
        </button>

        {/* Restore my text: the control that matters for anything written here.
            Restore original is hidden unless the original is real -- for a field
            created blank it would erase rather than restore. */}
        {showRestoreUser && restorePatch && (
          <button
            type="button"
            onClick={() => emit(restorePatch('user'))}
            className="text-xs underline text-indigo-300 hover:text-indigo-100"
          >
            Restore my text
          </button>
        )}
        {showRestoreOriginal && restorePatch && (
          <button
            type="button"
            onClick={() => emit(restorePatch('original'))}
            className="text-xs underline text-indigo-300 hover:text-indigo-100"
          >
            Restore original
          </button>
        )}
      </div>

      <ProposalCard
        state={state}
        onChoose={(index) => setState((s) => reduceProposal(s, { type: 'choose', index }))}
        onRegenerate={() => void request()}
        onKeepOriginal={() => setState((s) => reduceProposal(s, { type: 'keep-original' }))}
        onAccept={(proposal) => {
          const patches = acceptPatch(proposal, modelRef.current, groundedRef.current)
          for (const patch of Array.isArray(patches) ? patches : [patches]) emit(patch)
          setState((s) => reduceProposal(s, { type: 'accepted' }))
        }}
      />
    </div>
  )
}
