'use client'

import { Check, Sparkles } from 'lucide-react'
import { canRegenerate, isSelected, selectedProposal } from '@/lib/resume/ai/proposalFlow'
import type { ProposalState } from '@/lib/resume/ai/proposalFlow'
import { Button, Card, CheckboxField, SegmentedControl, cx, text } from '../ui'

/**
 * The proposal, and the things a person may do with it.
 *
 * Accept / Regenerate / Keep Original. Nothing here writes: Accept hands the
 * text upward and the Studio emits a patch, which the server re-verifies before
 * it can persist. A refused suggestion is NAMED and never shown -- there is no
 * arrangement of this component in which invented text sits beside an Accept
 * button, because the refused text never reaches the browser at all.
 *
 * MULTIPLE CHOICE WHERE THE ANSWER IS PLURAL. Rewriting one field has one
 * outcome, so its alternatives are a switch and a single Accept. Writing bullets
 * has as many outcomes as the applicant recognises as true, so its candidates
 * are checkboxes and nothing is ticked to begin with. Neither shape decides
 * anything: both are the same gate, with the same refusal available.
 */

export default function ProposalCard({
  state,
  onAccept,
  onAcceptMany,
  onRegenerate,
  onKeepOriginal,
  onChoose,
  onToggle,
  multi = false,
}: {
  state: ProposalState
  onAccept: (text: string) => void
  /** Adds every ticked candidate. Only meaningful when `multi`. */
  onAcceptMany?: () => void
  onRegenerate: () => void
  onKeepOriginal: () => void
  onChoose: (index: number) => void
  onToggle?: (index: number) => void
  /** The applicant may take more than one of what is offered. */
  multi?: boolean
}) {
  if (state.kind === 'idle') return null

  if (state.kind === 'working') {
    return (
      <p className={cx('mt-2 text-xs', text.muted)} role="status">
        Writing a suggestion from what you have entered...
      </p>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
        <p className="text-xs text-amber-800">{state.message}</p>
        {state.retryable && (
          <button type="button" onClick={onRegenerate} className="text-xs font-medium text-amber-800 underline hover:no-underline">
            Try again
          </button>
        )}
        <button type="button" onClick={onKeepOriginal} className="text-xs text-slate-600 underline hover:no-underline">
          Dismiss
        </button>
      </div>
    )
  }

  if (state.kind === 'refused') {
    return (
      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5" role="alert">
        <p className="text-xs font-semibold text-amber-900">
          The suggestion was not used, because it added things you have not told us.
        </p>
        <ul className="mt-2 space-y-1">
          {state.rejected.map((note, i) => (
            <li key={`${note.category}-${i}`} className="text-xs text-amber-800">
              It {note.message}
            </li>
          ))}
        </ul>
        <Opportunities items={state.opportunities} />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onRegenerate}>
            Try again
          </Button>
          <Button size="sm" variant="tertiary" onClick={onKeepOriginal}>
            Keep what I have
          </Button>
        </div>
      </div>
    )
  }

  const chosen = selectedProposal(state) ?? ''
  const tickedCount = state.selected.length

  return (
    <Card tone="accent" className="mt-3 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-800">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          {multi ? 'Suggestions · none added yet' : 'Suggestion · not yet used'}
        </p>
        {!multi && state.proposals.length > 1 && (
          <SegmentedControl
            label="Suggestions"
            size="sm"
            value={String(state.index)}
            onChange={(value) => onChoose(Number(value))}
            options={state.proposals.map((_, i) => ({ value: String(i), label: String(i + 1) }))}
          />
        )}
      </div>

      {multi ? (
        <>
          <p className={cx('mt-2 text-xs', text.muted)}>
            Tick the ones that are true of your work. Nothing is added until you say so.
          </p>
          <ul className="mt-2 space-y-2">
            {state.proposals.map((proposal, i) => (
              <li key={`${i}-${proposal.slice(0, 24)}`}>
                <CheckboxField
                  id={`cand-${i}`}
                  label={proposal}
                  checked={isSelected(state, i)}
                  onChange={() => onToggle?.(i)}
                />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{chosen}</p>
      )}

      {state.rejected.length > 0 && (
        <p className="mt-2 text-xs text-amber-800">
          {state.rejected.length} other suggestion
          {state.rejected.length === 1 ? ' was' : 's were'} discarded for adding things you have not
          told us.
        </p>
      )}

      <Opportunities items={state.opportunities} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {multi ? (
          <Button size="sm" variant="primary" icon={Check} disabled={tickedCount === 0} onClick={() => onAcceptMany?.()}>
            Add selected bullets
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={Check} onClick={() => onAccept(chosen)}>
            Use this
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onRegenerate} disabled={!canRegenerate(state)}>
          Try another
        </Button>
        <Button size="sm" variant="tertiary" onClick={onKeepOriginal}>
          Keep what I have
        </Button>
      </div>
    </Card>
  )
}

/**
 * What the assistant wanted to say but could not, turned into a question.
 *
 * This is where the impulse to invent a number is supposed to go. Showing them
 * is what makes "never fabricate" a workable instruction rather than a refusal.
 */
function Opportunities({ items }: { items: readonly { question: string; why: string }[] }) {
  if (items.length === 0) return null
  return (
    <div className="mt-3 border-t border-black/5 pt-2.5">
      <p className="text-xs font-medium text-slate-700">Would make this stronger</p>
      <ul className="mt-1 space-y-1">
        {items.map((item, i) => (
          <li key={i} className={cx('text-xs', text.secondary)}>
            {item.question}
            {item.why && <span className={text.muted}> — {item.why}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
