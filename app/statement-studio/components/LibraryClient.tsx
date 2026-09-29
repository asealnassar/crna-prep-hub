'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { StatementDraftSummary } from '@/lib/statement/draft/rows'
import { draftDay, draftPath } from '@/lib/statement/draft/library'
import NewDraftDialog from './NewDraftDialog'

/**
 * The statement draft library.
 *
 * SUMMARIES, NOT DRAFTS. The prop type is StatementDraftSummary -- a distinct
 * type from StatementDraft with no essay field at all, so no statement body can
 * reach this component even by accident. The full text is loaded by
 * /statement-studio/[id] when a draft is opened, and only then.
 *
 * NO RE-SORTING. The rows arrive newest edit first, ordered by the index that
 * serves the query. Sorting them again in the browser would be a second opinion
 * about the same question, and sorting controls are a later job.
 *
 * NAVIGATION IS A LINK, not a click handler. Opening a draft is a plain
 * document navigation, so it should be a real anchor: middle-click, Cmd-click
 * and "open in new tab" all work, and it needs no JavaScript to function.
 */
export default function LibraryClient({ drafts }: { drafts: readonly StatementDraftSummary[] }) {
  const [creating, setCreating] = useState(false)

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <p className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        Internal preview. Upload and “Analyze this Draft” are not wired up yet.
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">Statement Studio</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {drafts.length === 0
              ? 'Your personal statement drafts will appear here.'
              : `${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'}, most recently edited first.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
        >
          New draft
        </button>
      </div>

      {drafts.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-300 px-6 py-12 text-center">
          <p className="text-sm font-medium text-slate-700">No drafts yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Start one and it is saved from the moment you name it.
          </p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            New draft
          </button>
        </div>
      ) : (
        <ul className="mt-6 grid gap-2.5">
          {drafts.map((draft) => (
            <li key={draft.id}>
              <Link
                href={draftPath(draft.id)}
                className="block rounded-xl border border-gray-300 bg-white px-4 py-3 transition hover:border-blue-300 hover:bg-blue-50/40 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <span className="block truncate text-sm font-semibold text-slate-900">
                  {draft.title}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Edited {draftDay(draft.updatedAt)} · started {draftDay(draft.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <NewDraftDialog open={creating} onClose={() => setCreating(false)} />
    </main>
  )
}
