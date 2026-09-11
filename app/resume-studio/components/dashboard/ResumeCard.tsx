'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import {
  lastEditedLabel, statusLabel, statusToggleLabel, templateLabel,
} from '@/lib/resume/draft/summary'
import type { ResumeSummary } from '@/lib/resume/draft/summary'

/**
 * One resume on the dashboard.
 *
 * Presentational: every label comes from lib/resume/draft/summary.ts, which is
 * unit-tested, and every action is handed upward. The card holds no state of
 * its own beyond focusing the title field when editing begins.
 */
export default function ResumeCard({
  resume,
  isEditing,
  draftTitle,
  busy,
  canFinalize,
  indicator,
  onStartRename,
  onTitleChange,
  onFinishRename,
  onToggleStatus,
  onDuplicate,
  onDelete,
}: {
  resume: ResumeSummary
  isEditing: boolean
  draftTitle: string
  busy: boolean
  /** Presentation only; the draft route refuses a non-Ultimate finalise. */
  canFinalize: boolean
  indicator: React.ReactNode
  onStartRename: () => void
  onTitleChange: (value: string) => void
  onFinishRename: () => void
  onToggleStatus: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (isEditing) input.current?.focus()
  }, [isEditing])

  const complete = resume.status === 'complete'

  return (
    <div className="bg-white/10 backdrop-blur-sm border-2 border-white/20 rounded-2xl p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <>
              <label htmlFor={`title-${resume.id}`} className="sr-only">
                Resume title
              </label>
              <input
                id={`title-${resume.id}`}
                ref={input}
                value={draftTitle}
                onChange={(e) => onTitleChange(e.target.value)}
                onBlur={onFinishRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onFinishRename()
                  if (e.key === 'Escape') onFinishRename()
                }}
                className="w-full bg-white/10 border border-white/30 rounded-lg px-3 py-1.5 text-white text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </>
          ) : (
            <button
              type="button"
              onClick={onStartRename}
              className="text-left text-lg font-semibold text-white hover:underline truncate w-full"
              title="Rename"
            >
              {resume.title}
            </button>
          )}
          <p className="text-xs text-indigo-200 mt-1">
            {templateLabel(String(resume.template))} · {lastEditedLabel(resume.updatedAt, Date.now())}
          </p>
        </div>

        <span
          className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full border ${
            complete
              ? 'bg-emerald-400/15 text-emerald-100 border-emerald-300/40'
              : 'bg-white/10 text-indigo-100 border-white/25'
          }`}
        >
          {statusLabel(resume.status)}
        </span>
      </div>

      {indicator}

      <div className="flex flex-wrap gap-2 pt-1">
        {/* Marking complete is Ultimate's half of the gate. Reverting to draft
            is not gated, so a lapsed plan never strands a finished resume. */}
        {canFinalize || complete ? (
          <button
            type="button"
            onClick={onToggleStatus}
            disabled={busy}
            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-white/30 text-white hover:bg-white/10 transition disabled:opacity-50"
          >
            {statusToggleLabel(resume.status)}
          </button>
        ) : (
          <Link
            href="/pricing"
            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-amber-300/50 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25 transition"
          >
            Upgrade to finalize
          </Link>
        )}
        <button
          type="button"
          onClick={onDuplicate}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-medium rounded-lg border border-white/30 text-white hover:bg-white/10 transition disabled:opacity-50"
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-medium rounded-lg text-red-200 hover:bg-red-500/15 transition disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </div>
  )
}
