'use client'

import { canRegenerate, selectedProposal } from '@/lib/resume/ai/proposalFlow'
import type { ProposalState } from '@/lib/resume/ai/proposalFlow'

/**
 * The proposal, and the three things a person may do with it.
 *
 * Accept / Regenerate / Keep Original. Nothing here writes: Accept hands the
 * text upward and the Studio emits a patch, which the server re-verifies before
 * it can persist. A refused suggestion is NAMED and never shown -- there is no
 * arrangement of this component in which invented text sits beside an Accept
 * button, because the refused text never reaches the browser at all.
 */

const BTN = 'px-3 py-1.5 text-sm font-semibold rounded-lg transition disabled:opacity-50'

export default function ProposalCard({
  state,
  onAccept,
  onRegenerate,
  onKeepOriginal,
  onChoose,
}: {
  state: ProposalState
  onAccept: (text: string) => void
  onRegenerate: () => void
  onKeepOriginal: () => void
  onChoose: (index: number) => void
}) {
  if (state.kind === 'idle') return null

  if (state.kind === 'working') {
    return (
      <p className="mt-2 text-xs text-indigo-300" role="status">
        Writing a suggestion from what you have entered...
      </p>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
        <p className="text-xs text-amber-200">{state.message}</p>
        {state.retryable && (
          <button type="button" onClick={onRegenerate} className="text-xs underline text-amber-200">
            Try again
          </button>
        )}
        <button type="button" onClick={onKeepOriginal} className="text-xs underline text-indigo-300">
          Dismiss
        </button>
      </div>
    )
  }

  if (state.kind === 'refused') {
    return (
      <div className="mt-2 rounded-xl border border-amber-300/40 bg-amber-400/10 p-3" role="alert">
        <p className="text-xs font-semibold text-amber-100">
          The suggestion was not used, because it added things you have not told us.
        </p>
        <ul className="mt-2 space-y-1">
          {state.rejected.map((note, i) => (
            <li key={`${note.category}-${i}`} className="text-xs text-amber-100/90">
              It {note.message}
            </li>
          ))}
        </ul>
        <Opportunities items={state.opportunities} />
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onRegenerate} className={`${BTN} border border-white/30 text-white hover:bg-white/10`}>
            Try again
          </button>
          <button type="button" onClick={onKeepOriginal} className={`${BTN} text-indigo-200 hover:bg-white/10`}>
            Keep what I have
          </button>
        </div>
      </div>
    )
  }

  const chosen = selectedProposal(state) ?? ''

  return (
    <div className="mt-2 rounded-xl border border-white/25 bg-white/10 p-3">
      <p className="text-xs font-semibold text-indigo-200 mb-2">Suggestion — not yet used</p>

      {state.proposals.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-2" role="tablist" aria-label="Suggestions">
          {state.proposals.map((_, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === state.index}
              onClick={() => onChoose(i)}
              className={`px-2 py-0.5 text-xs rounded ${
                i === state.index ? 'bg-white text-indigo-900 font-semibold' : 'text-indigo-200 hover:bg-white/10'
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      <p className="text-sm text-white whitespace-pre-wrap">{chosen}</p>

      {state.rejected.length > 0 && (
        <p className="mt-2 text-xs text-amber-200">
          {state.rejected.length} other suggestion
          {state.rejected.length === 1 ? ' was' : 's were'} discarded for adding things you have not
          told us.
        </p>
      )}

      <Opportunities items={state.opportunities} />

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onAccept(chosen)}
          className={`${BTN} bg-white text-indigo-900 hover:bg-indigo-50`}
        >
          Use this
        </button>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={!canRegenerate(state)}
          className={`${BTN} border border-white/30 text-white hover:bg-white/10`}
        >
          Try another
        </button>
        <button type="button" onClick={onKeepOriginal} className={`${BTN} text-indigo-200 hover:bg-white/10`}>
          Keep what I have
        </button>
      </div>
    </div>
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
    <div className="mt-3 border-t border-white/15 pt-2">
      <p className="text-xs font-semibold text-indigo-200">Would make this stronger</p>
      <ul className="mt-1 space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-xs text-indigo-100">
            {item.question}
            {item.why && <span className="text-indigo-300"> — {item.why}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
