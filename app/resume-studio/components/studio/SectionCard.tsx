'use client'

import {
  ArrowDown, ArrowUp, ChevronRight, Ellipsis, Eye, EyeOff, PanelLeft, PanelRight, Trash2,
} from 'lucide-react'
import { hasFixedHeading, headingFor } from '@/lib/resume/model/sections'
import type { ResumeSectionV2 } from '@/lib/resume/model/types'
import { descriptorFor } from '@/lib/resume/studio/fields'
import { otherColumn } from '@/lib/resume/studio/columns'
import type { TemplateDefinition } from '@/lib/resume/document/templates'
import type { StudioPatch } from '@/lib/resume/studio/patch'
import { Badge, Button, Card, IconButton, Menu, MenuItem, MenuSeparator, TextField, cx, focusRing, text } from '../ui'
import SectionEditor from '../sections/SectionEditor'

/**
 * One section in the editor: a compact header row that is always there, and
 * its heading and fields beneath when open.
 *
 * Reordering is Move up / Move down buttons rather than drag-and-drop. Drag is
 * the obvious gesture and the inaccessible one -- an applicant working by
 * keyboard, or on a phone where drag fights the scroll, can still reorder here.
 * "Full keyboard operation including reorder" is an acceptance criterion, and
 * buttons are how it is met rather than approximated. On a phone the move
 * buttons fold into the section's menu so the row keeps thumb-sized targets.
 */
export default function SectionCard({
  section,
  resumeId,
  template,
  moveUpTo,
  moveDownTo,
  open,
  newId,
  emit,
  unsaved,
  onFlush,
  onToggleOpen,
  compact = false,
}: {
  section: ResumeSectionV2
  resumeId: string
  /** Decides whether this section can be moved between columns at all. */
  template: TemplateDefinition
  /**
   * Where "move up" and "move down" should send it, or null when there is
   * nowhere to go. Computed by the pane, which can see the other sections and
   * which column each of them is drawn in.
   */
  moveUpTo: number | null
  moveDownTo: number | null
  open: boolean
  newId: () => string
  emit: (patch: StudioPatch) => void
  /** Edits are queued or in flight. An AI request must wait for them. */
  unsaved: boolean
  /** Saves the queue now rather than at the end of the debounce. */
  onFlush: () => void
  onToggleOpen: () => void
  /** Phone layout. Presentation only. */
  compact?: boolean
}) {
  const heading = headingFor(section)
  const panelId = `panel-${section.id}`
  const hidden = !section.visible
  const meta = summaryOf(section)
  const move = (toIndex: number | null) => {
    if (toIndex === null) return
    emit({ op: 'section-move', sectionId: section.id, toIndex })
  }
  // Null on a one-column template: there is no other column to move to, which
  // is why Classic and Compact never show the control rather than showing a
  // disabled one for a layout they do not have.
  const column = otherColumn(template, section)

  return (
    <Card as="section" tone={hidden ? 'muted' : 'default'} aria-label={heading}>
      <div className="flex items-center gap-0.5 p-1.5">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-controls={panelId}
          className={cx('flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left', focusRing)}
        >
          <ChevronRight className={cx('h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-90')} aria-hidden="true" />
          <span className={cx('truncate text-sm font-semibold', hidden ? 'text-slate-500' : 'text-slate-900')}>{heading}</span>
          {hidden ? (
            <Badge icon={EyeOff} className="shrink-0">Hidden</Badge>
          ) : (
            // On Modern the column control needs the room, so the one-glance
            // summary gives way first rather than the section's name.
            meta && !compact && <span className={cx(column ? 'min-w-0' : 'shrink-0', 'truncate text-xs', text.muted)}>{meta}</span>
          )}
        </button>

        {!compact && (
          <>
            <IconButton icon={ArrowUp} label={`Move ${heading} up`} size="sm" disabled={moveUpTo === null} onClick={() => move(moveUpTo)} />
            <IconButton icon={ArrowDown} label={`Move ${heading} down`} size="sm" disabled={moveDownTo === null} onClick={() => move(moveDownTo)} />
          </>
        )}
        {/* ON THE CARD, NOT IN A MENU. The only column control used to be a menu
            item behind the ellipsis, so on Modern nothing on a section said it
            could move sideways at all -- and up and down, which stay within a
            column, looked broken without it. The label names where it goes,
            which also says where it is now. */}
        {column && (compact ? (
          <IconButton
            icon={column === 'sidebar' ? PanelLeft : PanelRight}
            label={column === 'sidebar' ? `Move ${heading} to sidebar` : `Move ${heading} to main`}
            size="touch"
            onClick={() => emit({ op: 'section-column', sectionId: section.id, column })}
          />
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="shrink-0 whitespace-nowrap"
            aria-label={column === 'sidebar' ? `Move ${heading} to sidebar` : `Move ${heading} to main`}
            onClick={() => emit({ op: 'section-column', sectionId: section.id, column })}
          >
            {column === 'sidebar' ? '← Move to sidebar' : 'Move to main →'}
          </Button>
        ))}
        <IconButton
          icon={hidden ? EyeOff : Eye}
          label={hidden ? `Show ${heading} on the resume` : `Hide ${heading} from the resume`}
          size={compact ? 'touch' : 'sm'}
          onClick={() => emit({ op: 'section-visible', sectionId: section.id, visible: !section.visible })}
        />
        <Menu
          label={`${heading} actions`}
          trigger={(trigger) => (
            <IconButton {...trigger} icon={Ellipsis} label={`More actions for ${heading}`} size={compact ? 'touch' : 'sm'} />
          )}
        >
          {compact && (
            <>
              <MenuItem icon={ArrowUp} disabled={moveUpTo === null} onSelect={() => move(moveUpTo)}>Move up</MenuItem>
              <MenuItem icon={ArrowDown} disabled={moveDownTo === null} onSelect={() => move(moveDownTo)}>Move down</MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuItem icon={Trash2} tone="danger" onSelect={() => emit({ op: 'section-remove', sectionId: section.id })}>
            Remove section
          </MenuItem>
        </Menu>
      </div>

      {open && (
        <div id={panelId} className={cx('space-y-4 border-t border-slate-100', compact ? 'p-3' : 'px-4 pb-4 pt-3.5')}>
          {/* A fixed heading has no controls. Hidden rather than disabled: the card
              title above already shows the heading that prints. */}
          {!hasFixedHeading(section.type) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id={`label-${section.id}`}
                label="Heading on the resume"
                value={section.label ?? ''}
                placeholder={heading}
                onChange={(e) => emit({ op: 'section-label', sectionId: section.id, label: e.target.value || null })}
              />
              {section.type === 'custom' && (
                <TextField
                  id={`heading-${section.id}`}
                  label="Section name"
                  value={section.heading}
                  placeholder="Languages"
                  onChange={(e) => emit({ op: 'section-heading', sectionId: section.id, value: e.target.value })}
                />
              )}
            </div>
          )}

          <SectionEditor
            section={section}
            resumeId={resumeId}
            newId={newId}
            emit={emit}
            unsaved={unsaved}
            onFlush={onFlush}
          />
        </div>
      )}
    </Card>
  )
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** A one-glance summary for the header row, so a collapsed section still says what is in it. */
function summaryOf(section: ResumeSectionV2): string | null {
  if (section.type === 'summary') return null
  if (section.type === 'critical_care' || section.type === 'other_clinical') {
    const bullets = section.positions.reduce((total, p) => total + p.bullets.length, 0)
    return `${plural(section.positions.length, 'position')} · ${plural(bullets, 'bullet')}`
  }
  const entry = descriptorFor(section.type).entry
  if (!entry) return null
  const list = (section as unknown as Record<string, unknown[]>)[entry.listKey] ?? []
  return plural(list.length, entry.noun)
}
