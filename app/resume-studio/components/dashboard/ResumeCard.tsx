'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { CircleCheck, Copy, Ellipsis, Lock, Pencil, RotateCcw, SquareArrowOutUpRight, Trash2 } from 'lucide-react'
import { dashboardMeta, statusToggleLabel, strengthLabel } from '@/lib/resume/draft/summary'
import type { ResumeSummary } from '@/lib/resume/draft/summary'
import { Badge, Card, IconButton, Menu, MenuSeparator, cx, field, focusRing, menu, text } from '../ui'
import ResumePreview from './ResumePreview'

/** Open is the card's action, so it carries the accent. Nothing else here does. */
const openAction = cx(
  'inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-violet-50 px-3.5 text-sm font-semibold text-violet-700',
  'ring-1 ring-inset ring-violet-100 transition-colors hover:bg-violet-100 hover:text-violet-800',
  focusRing
)

/**
 * One resume on the dashboard, as a document card.
 *
 * THE PAGE, THEN THE FACTS. A preview big enough to recognise the shape of the
 * document sits beside one line that says what the resume is -- template, pages
 * when the list knows them, and when it was last edited -- with the actions on
 * the same line as the bottom of the page. Nothing is padded out to fill a box:
 * the preview sets the height, and the row of cards stays level because the
 * actions are pinned to the bottom of each.
 *
 * NO DRAFT OR COMPLETE PILL. The group heading above the card already says
 * which it is, and the same word twice reads as two separate facts.
 *
 * THE WHOLE CARD OPENS IT. The title's link is stretched over the card by an
 * overlay, so a press anywhere opens the resume while Open and the actions menu
 * keep working above it. An <a> wrapped around the whole card would be neither
 * valid markup nor operable, and it would swallow the buttons inside it.
 *
 * Presentational: every label comes from lib/resume/draft/summary.ts, which is
 * unit-tested, and every action is handed upward. The card holds no state of
 * its own beyond focusing the title field when editing begins.
 *
 * The title opens the resume, which is what a title is expected to do; renaming
 * is a named action in the card's menu alongside the others. It was the other
 * way round until the Studio route existed, and that left saved resumes
 * unreachable.
 */
export default function ResumeCard({
  resume,
  tier,
  isEditing,
  draftTitle,
  busy,
  canFinalize,
  indicator,
  onOpen,
  onStartRename,
  onTitleChange,
  onFinishRename,
  onToggleStatus,
  onDuplicate,
  onDelete,
}: {
  resume: ResumeSummary
  /** Presentation only: decides whether a locked thumbnail may be read. */
  tier?: string | null
  isEditing: boolean
  draftTitle: string
  busy: boolean
  /** Presentation only; the draft route refuses a non-Ultimate finalise. */
  canFinalize: boolean
  indicator: React.ReactNode
  /** May defer the navigation so an unsaved rename is not discarded. */
  onOpen: (event: React.MouseEvent<HTMLAnchorElement>) => void
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
  const strength = strengthLabel(resume.strength)

  return (
    <Card
      as="li"
      className={cx(
        'group relative flex gap-4 p-4 transition duration-150 sm:gap-5',
        'focus-within:border-violet-300 focus-within:ring-2 focus-within:ring-violet-600/10',
        !isEditing && 'hover:-translate-y-px hover:border-slate-300 hover:shadow-[0_12px_28px_-16px_rgba(15,23,42,0.40)]'
      )}
    >
      {/* The resume itself, at about a third of the card: the real document,
          read when the card is seen. Decorative -- the card's own link already
          names it, and the miniature takes no clicks of its own. */}
      <div className="relative w-[37%] shrink-0 self-start">
        <ResumePreview resume={resume} tier={tier} />
        {complete && (
          <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-white">
            <CircleCheck className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
            <span className="sr-only">Complete</span>
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
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
              className={cx(field.control, 'relative z-10 text-[15px] font-semibold')}
            />
          </>
        ) : (
          /* prefetch={false}: prefetching every card would run the gate and a
             full RLS-scoped read per resume on dashboard load, to open one.
             The ::after overlay is what makes the rest of the card clickable. */
          <Link
            href={`/resume-studio/${resume.id}`}
            prefetch={false}
            onClick={onOpen}
            title={resume.title}
            className={cx(
              'line-clamp-2 rounded text-[17px] font-semibold leading-snug tracking-tight text-slate-900',
              'transition-colors group-hover:text-violet-700',
              'after:absolute after:inset-0 after:rounded-xl after:content-[""]',
              focusRing
            )}
          >
            {resume.title}
          </Link>
        )}

        {/* Two facts, and nothing written to fill the space: the list carries no
            resume text, and a description of someone's own resume is not ours
            to write. The block sits centred against the page beside it. */}
        <p className={cx('mt-2 truncate text-sm', text.muted)}>{dashboardMeta(resume, Date.now()).join(' · ')}</p>

        {indicator && <div className="relative z-10 mt-2">{indicator}</div>}

        <div className="relative z-10 mt-5 flex items-center gap-2">
          <Link
            href={`/resume-studio/${resume.id}`}
            prefetch={false}
            onClick={onOpen}
            aria-label={`Open ${resume.title}`}
            className={openAction}
          >
            <SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" />
            Open
          </Link>

          {/* Only when the list actually carries a score. Never computed here. */}
          {strength && <Badge tone="accent">{strength}</Badge>}

          {/* Every card renders the same words, so each action's accessible name
              carries the title; otherwise a screen reader hears "Rename,
              Duplicate, Delete" repeated with no way to tell which resume is
              which. The menu opens upward, over its own card, so it never lands
              on the next group. */}
          <Menu
            label={`Actions for ${resume.title}`}
            placement="top"
            trigger={(trigger) => (
              <IconButton
                {...trigger}
                icon={Ellipsis}
                label={`More actions for ${resume.title}`}
                disabled={busy}
                className="h-9 w-9 border border-slate-200 bg-white"
              />
            )}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={onStartRename}
              disabled={busy || isEditing}
              aria-label={`Rename ${resume.title}`}
              className={menu.item}
            >
              <Pencil className={menu.icon} aria-hidden="true" />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={onDuplicate}
              disabled={busy}
              aria-label={`Duplicate ${resume.title}`}
              className={menu.item}
            >
              <Copy className={menu.icon} aria-hidden="true" />
              Duplicate
            </button>
            {/* Marking complete is Ultimate's half of the gate. Reverting to draft
                is not gated, so a lapsed plan never strands a finished resume. */}
            {canFinalize || complete ? (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={onToggleStatus}
                disabled={busy}
                className={menu.item}
              >
                {complete ? (
                  <RotateCcw className={menu.icon} aria-hidden="true" />
                ) : (
                  <CircleCheck className={menu.icon} aria-hidden="true" />
                )}
                {statusToggleLabel(resume.status)}
              </button>
            ) : (
              <Link href="/pricing" role="menuitem" tabIndex={-1} className={menu.item}>
                <Lock className={menu.icon} aria-hidden="true" />
                Upgrade to finalize
              </Link>
            )}
            <MenuSeparator />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={onDelete}
              disabled={busy}
              aria-label={`Delete ${resume.title}`}
              className={menu.itemDanger}
            >
              <Trash2 className={menu.icon} aria-hidden="true" />
              Delete
            </button>
          </Menu>
        </div>
      </div>
    </Card>
  )
}
