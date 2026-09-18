'use client'

import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Ellipsis, Info, Plus, Sparkles, Trash2 } from 'lucide-react'
import { descriptorFor } from '@/lib/resume/studio/fields'
import { formatDateRange } from '@/lib/resume/document/format'
import { fieldAssist, summaryAssist } from '@/lib/resume/ai/gating'
import {
  COMMON_CERTIFICATIONS, alreadyHasCertification, certificationsToAdd,
} from '@/lib/resume/studio/certifications'
import { groupSelections, mergeFacts } from '@/lib/resume/studio/icuCatalogue'
import type { IcuSelection } from '@/lib/resume/studio/icuCatalogue'
import type { ClinicalPosition, ResumeSectionV2 } from '@/lib/resume/model/types'
import type { AuthoredText } from '@/lib/resume/model/authoredText'
import type { StudioPatch, FieldValue } from '@/lib/resume/studio/patch'
import {
  Button, Card, CheckboxField, IconButton, Menu, MenuItem, TextAreaField, TextField,
  cardClass, cx, field as fieldStyle, text,
} from '../ui'
import FieldInput from './FieldInput'
import IcuExperiencePicker from './IcuExperiencePicker'
import AiAssist from '../ai/AiAssist'

/**
 * The editor for one section, chosen by the descriptor's shape.
 *
 * Eleven of the fifteen section types are a list of entries with typed fields,
 * so they share this one form and differ only in the descriptor that drives it.
 * The two shapes that are genuinely different say so: a professional summary is
 * one block of prose, and a clinical position carries grounding facts that must
 * never render alongside bullets that must.
 *
 * AI actions sit inside the field they act on -- in its toolbar, or beside a
 * bullet -- and a suggestion appears directly beneath that field. WHETHER one is
 * offered is never decided here: `gating` answers that, in the same words the
 * server refuses with.
 */

const words = (value: string) => value.trim().split(/\s+/).filter(Boolean).length

export default function SectionEditor({
  section,
  resumeId,
  newId,
  emit,
  unsaved,
  onFlush,
}: {
  section: ResumeSectionV2
  resumeId: string
  newId: () => string
  emit: (patch: StudioPatch) => void
  /** Edits are queued or in flight. An AI request must wait for them. */
  unsaved: boolean
  /** Saves the queue now rather than at the end of the debounce. */
  onFlush: () => void
}) {
  const descriptor = descriptorFor(section.type)

  if (descriptor.shape === 'prose' && section.type === 'summary') {
    const count = words(section.text.accepted)
    // Tightening rewrites the paragraph they wrote, so there has to be one.
    const assist = summaryAssist(section.text)
    return (
      <AiAssist
        target={{ resumeId, sectionId: section.id }}
        operation="tighten-summary"
        label="Tighten with AI"
        text={section.text}
        emit={emit}
        unavailable={assist.reason}
        acceptPatch={(proposal, model, groundedIn) => ({
          op: 'ai-accept-summary', sectionId: section.id, text: proposal, model, groundedIn,
        })}
        restorePatch={(scope) => ({ op: 'ai-restore-summary', sectionId: section.id, scope })}
      >
        {({ trigger, restore }) => (
          <TextAreaField
            id={`sum-${section.id}`}
            label="Professional summary"
            rows={4}
            value={section.text.accepted}
            placeholder="Three or four sentences on who you are as a critical-care nurse."
            onChange={(e) => emit({ op: 'summary', sectionId: section.id, value: e.target.value })}
            footer={
              <>
                <span className="inline-flex min-w-0 flex-wrap items-center">{restore}</span>
                <span className="inline-flex items-center gap-1">
                  <span className={cx('px-1 text-xs tabular-nums', text.muted)}>
                    {count} {count === 1 ? 'word' : 'words'}
                  </span>
                  {trigger}
                </span>
              </>
            }
          />
        )}
      </AiAssist>
    )
  }

  if (section.type === 'critical_care' || section.type === 'other_clinical') {
    return (
      <PositionsEditor
        section={section}
        resumeId={resumeId}
        newId={newId}
        emit={emit}
        unsaved={unsaved}
        onFlush={onFlush}
      />
    )
  }

  const entry = descriptor.entry
  if (!entry) return null
  const list = (section as unknown as Record<string, Record<string, unknown>[]>)[entry.listKey] ?? []
  const offerCertificationPicker = section.type === 'certifications'

  return (
    <div className="space-y-3">
      {offerCertificationPicker && (
        <CertificationPicker
          existing={list.map((item) => ({ name: String(item.name ?? '') }))}
          onAdd={(names) => {
            for (const name of names) {
              const entryId = newId()
              emit({ op: 'entry-add', sectionId: section.id, entryId })
              emit({ op: 'field', sectionId: section.id, entryId, field: 'name', value: name })
            }
          }}
        />
      )}

      {list.map((item, index) => {
        const entryId = String(item.id)
        const name = `${entry.noun} ${index + 1}`
        return (
          <fieldset key={entryId} className={cx(cardClass('muted'), 'p-3')}>
            <legend className="sr-only">{name}</legend>
            <div className="mb-2.5 flex items-center gap-0.5">
              <p aria-hidden="true" className={cx('flex-1 first-letter:uppercase', text.overline)}>{name}</p>
              <IconButton
                icon={ArrowUp} label={`Move ${name} up`} size="sm" disabled={index === 0}
                onClick={() => emit({ op: 'entry-move', sectionId: section.id, entryId, toIndex: index - 1 })}
              />
              <IconButton
                icon={ArrowDown} label={`Move ${name} down`} size="sm" disabled={index === list.length - 1}
                onClick={() => emit({ op: 'entry-move', sectionId: section.id, entryId, toIndex: index + 1 })}
              />
              <IconButton
                icon={Trash2} tone="danger" label={`Remove ${name}`} size="sm"
                onClick={() => emit({ op: 'entry-remove', sectionId: section.id, entryId })}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {entry.fields.map((field) => (
                <div key={field.name} className={field.kind === 'authored' || field.kind === 'daterange' ? 'sm:col-span-2' : ''}>
                  {field.kind !== 'authored' && (
                    <FieldInput
                      descriptor={field}
                      id={`f-${section.id}-${entryId}-${field.name}`}
                      value={item[field.name]}
                      onChange={(value: FieldValue) =>
                        emit({ op: 'field', sectionId: section.id, entryId, field: field.name, value })
                      }
                    />
                  )}

                  {/* The descriptor decides eligibility. A field it calls
                      'authored' is narrative and may be written with help; a
                      name, a date, an institution or a licence number is factual
                      and never gets the affordance. That is one rule, applied
                      everywhere, rather than a list of sections to remember.

                      WHETHER it is offered yet is `fieldAssist`: an entry whose
                      narrative the applicant has not written has nothing for an
                      assistant to improve, and everything for it to imagine. */}
                  {field.kind === 'authored' && (
                    <AiAssist
                      target={{
                        resumeId,
                        sectionId: section.id,
                        targetId: entryId,
                        field: field.name,
                      }}
                      operation="improve-text"
                      label={`Improve ${(field.shortLabel ?? field.label).toLowerCase()} with AI`}
                      text={item[field.name] as AuthoredText | null}
                      emit={emit}
                      unavailable={fieldAssist(section, entryId, field.name).reason}
                      acceptPatch={(proposal, model, groundedIn) => ({
                        op: 'ai-accept-field',
                        sectionId: section.id,
                        entryId,
                        field: field.name,
                        text: proposal,
                        model,
                        groundedIn,
                      })}
                      restorePatch={(scope) => ({
                        op: 'ai-restore-field',
                        sectionId: section.id,
                        entryId,
                        field: field.name,
                        scope,
                      })}
                    >
                      {({ trigger, restore }) => (
                        <FieldInput
                          descriptor={field}
                          id={`f-${section.id}-${entryId}-${field.name}`}
                          value={item[field.name]}
                          onChange={(value: FieldValue) =>
                            emit({ op: 'field', sectionId: section.id, entryId, field: field.name, value })
                          }
                          footer={
                            <>
                              <span className="inline-flex min-w-0 flex-wrap items-center">{restore}</span>
                              {trigger}
                            </>
                          }
                        />
                      )}
                    </AiAssist>
                  )}
                </div>
              ))}
            </div>
          </fieldset>
        )
      })}

      <Button
        size="sm"
        variant="tertiary"
        icon={Plus}
        onClick={() => emit({ op: 'entry-add', sectionId: section.id, entryId: newId() })}
      >
        Add {entry.noun}
      </Button>
    </div>
  )
}

/**
 * Adding the certifications an ICU nurse usually holds, several at a time.
 *
 * A PICKER, NOT A CLAIM. Ticking CCRN asserts nothing until the applicant ticks
 * it: what appears is an entry with the name filled in and issuer, number and
 * dates empty, because those are facts only they have. Nothing here is grounding
 * for an AI proposal and nothing here scores a point -- a certification is worth
 * no marks for existing, and an applicant with none is not marked down.
 */
function CertificationPicker({
  existing,
  onAdd,
}: {
  existing: readonly { readonly name: string }[]
  onAdd: (names: string[]) => void
}) {
  const [picked, setPicked] = useState<readonly string[]>([])
  const [custom, setCustom] = useState('')

  const chosen = certificationsToAdd(existing, [...picked, custom])
  const toggle = (name: string) =>
    setPicked((current) =>
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
    )

  return (
    <fieldset className={cx(cardClass('muted'), 'p-3')}>
      <legend className={cx('px-0', text.overline)}>Add common certifications</legend>
      <p className={cx('mb-2.5 text-xs', text.muted)}>
        Tick the ones you hold. We fill in the name; the issuer, number and dates are yours to add.
      </p>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {COMMON_CERTIFICATIONS.map((certification) => {
          const added = alreadyHasCertification(existing, certification.name)
          return (
            <CheckboxField
              key={certification.id}
              id={`cert-${certification.id}`}
              label={added ? `${certification.name} — already added` : `${certification.name} — ${certification.note}`}
              checked={!added && picked.includes(certification.name)}
              disabled={added}
              onChange={() => toggle(certification.name)}
            />
          )
        })}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <TextField
          id="cert-custom"
          label="Something else"
          value={custom}
          placeholder="CNRN"
          onChange={(e) => setCustom(e.target.value)}
        />
      </div>

      <Button
        size="sm"
        variant="tertiary"
        icon={Plus}
        className="mt-3"
        disabled={chosen.length === 0}
        onClick={() => {
          onAdd(chosen)
          setPicked([])
          setCustom('')
        }}
      >
        Add selected certifications
      </Button>
    </fieldset>
  )
}

/**
 * Bullets for one position: what the applicant has done, then what to write.
 *
 * THE FACTS COME FIRST. Asked to write bullets from an employer, a role and a
 * date range, a model has nothing true and specific to say -- so it is not
 * asked. The applicant picks their own experience from a catalogue, those ticks
 * are saved onto the position as facts they supplied, and only then is anything
 * generated. That is also why the request waits for the save: the route grounds
 * a proposal in the STORED position, and a selection still sitting in the
 * autosave queue would be a selection the model never sees.
 */
function BulletGenerator({
  section,
  position,
  emit,
  unsaved,
  onFlush,
  run,
  busy,
}: {
  section: ResumeSectionV2
  position: ClinicalPosition
  emit: (patch: StudioPatch) => void
  unsaved: boolean
  onFlush: () => void
  run: () => void
  busy: boolean
}) {
  const [picking, setPicking] = useState(false)
  const [awaitingSave, setAwaitingSave] = useState(false)
  const panelId = `icu-${position.id}`
  const working = busy || awaitingSave

  useEffect(() => {
    if (!awaitingSave || unsaved) return
    setAwaitingSave(false)
    run()
  }, [awaitingSave, unsaved, run])

  const confirm = (selections: readonly IcuSelection[]) => {
    for (const [factField, values] of Object.entries(groupSelections(selections))) {
      if (!values || values.length === 0) continue
      const existing =
        ((position.facts as unknown as Record<string, unknown>)[factField] as string[] | undefined) ?? []
      emit({
        op: 'position-fact',
        sectionId: section.id,
        positionId: position.id,
        field: factField,
        value: mergeFacts(existing, values),
      })
    }
    setPicking(false)
    setAwaitingSave(true)
    onFlush()
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className={text.heading}>Bullets</p>
          <p className={cx('text-xs', text.muted)}>Printed under this position on your resume.</p>
        </div>
        <Button
          size="sm"
          variant="ai"
          icon={Sparkles}
          disabled={working}
          aria-busy={working}
          aria-expanded={picking}
          aria-controls={panelId}
          onClick={() => setPicking((open) => !open)}
        >
          {working ? 'Working...' : 'Write bullets from these facts'}
        </Button>
      </div>

      {picking && (
        <IcuExperiencePicker
          id={panelId}
          facts={position.facts}
          busy={working}
          onConfirm={confirm}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  )
}

/**
 * Clinical positions: the facts that ground an AI proposal, and the bullets
 * that actually render.
 *
 * The two are visibly separated and labelled, because V1 printed the fact
 * checkboxes onto the resume whenever bullets were missing and applicants had
 * no way to know that would happen.
 */
function PositionsEditor({
  section,
  resumeId,
  newId,
  emit,
  unsaved,
  onFlush,
}: {
  section: Extract<ResumeSectionV2, { type: 'critical_care' | 'other_clinical' }>
  resumeId: string
  newId: () => string
  emit: (patch: StudioPatch) => void
  unsaved: boolean
  onFlush: () => void
}) {
  const TEXT_FACTS: [string, string][] = [
    ['employer', 'Employer'], ['location', 'Location'], ['role', 'Role'],
    ['unit', 'Unit'], ['unitType', 'Unit type'], ['acuity', 'Acuity'],
  ]

  return (
    <div className="space-y-3">
      {section.positions.map((position, index) => {
        const title = position.facts.employer || `Position ${index + 1}`
        return (
          <Card key={position.id}>
            <div className="flex items-center gap-2 border-b border-slate-100 py-2 pl-3.5 pr-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
                <p className={cx('truncate text-xs', text.muted)}>
                  {[position.facts.role, formatDateRange(position.facts.dates)].filter(Boolean).join(' · ')}
                </p>
              </div>
              <Menu
                label={`${title} actions`}
                trigger={(trigger) => <IconButton {...trigger} icon={Ellipsis} label={`More actions for ${title}`} size="sm" />}
              >
                <MenuItem
                  icon={Trash2}
                  tone="danger"
                  onSelect={() => emit({ op: 'position-remove', sectionId: section.id, positionId: position.id })}
                >
                  Remove position
                </MenuItem>
              </Menu>
            </div>

            <div className="space-y-4 p-3.5">
              <fieldset className={cx(cardClass('muted'), 'p-3')}>
                <legend className="sr-only">Position {index + 1} details</legend>
                <p aria-hidden="true" className={cx('mb-2.5 flex items-center gap-1.5', text.overline)}>
                  <Info className="h-3.5 w-3.5" />
                  Position details
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {TEXT_FACTS.map(([name, label]) => (
                    <TextField
                      key={name}
                      id={`p-${position.id}-${name}`}
                      label={label}
                      value={String((position.facts as unknown as Record<string, unknown>)[name] ?? '')}
                      onChange={(e) =>
                        emit({ op: 'position-fact', sectionId: section.id, positionId: position.id, field: name, value: e.target.value })
                      }
                    />
                  ))}
                  <div className="sm:col-span-2">
                    <FieldInput
                      descriptor={{ name: 'dates', label: 'Dates', kind: 'daterange' }}
                      id={`p-${position.id}-dates`}
                      value={position.facts.dates}
                      onChange={(value) =>
                        emit({ op: 'position-fact', sectionId: section.id, positionId: position.id, field: 'dates', value })
                      }
                    />
                  </div>
                </div>
              </fieldset>

              {/* Candidates, not an answer: several grounded bullets, none of
                  them ticked, and each one the applicant takes is added and
                  filled in the same save. Bullets they already have are not
                  offered back to them. */}
              <AiAssist
                target={{ resumeId, sectionId: section.id, targetId: position.id }}
                operation="generate-bullets"
                label="Write bullets from these facts"
                emit={emit}
                existingText={position.bullets.map((bullet) => bullet.accepted)}
                acceptPatch={(proposal, model, groundedIn) => [
                  { op: 'bullet-add', sectionId: section.id, positionId: position.id },
                  {
                    op: 'ai-accept-bullet', sectionId: section.id, positionId: position.id,
                    index: position.bullets.length, text: proposal, model, groundedIn,
                  },
                ]}
                acceptManyPatch={(proposals, model, groundedIn) =>
                  proposals.flatMap((proposal, offset) => [
                    { op: 'bullet-add', sectionId: section.id, positionId: position.id },
                    {
                      op: 'ai-accept-bullet', sectionId: section.id, positionId: position.id,
                      index: position.bullets.length + offset, text: proposal, model, groundedIn,
                    },
                  ])
                }
              >
                {({ run, busy }) => (
                  <BulletGenerator
                    section={section}
                    position={position}
                    emit={emit}
                    unsaved={unsaved}
                    onFlush={onFlush}
                    run={run}
                    busy={busy}
                  />
                )}
              </AiAssist>

              <ul className="space-y-2">
                {position.bullets.map((bullet, i) => (
                  <li key={`${position.id}-b${i}`}>
                    <AiAssist
                      target={{ resumeId, sectionId: section.id, targetId: position.id, bulletIndex: i }}
                      operation="improve-bullet"
                      label={`Improve bullet ${i + 1} with AI`}
                      variant="icon"
                      text={bullet}
                      emit={emit}
                      acceptPatch={(proposal, model, groundedIn) => ({
                        op: 'ai-accept-bullet', sectionId: section.id, positionId: position.id,
                        index: i, text: proposal, model, groundedIn,
                      })}
                      restorePatch={(scope) => ({
                        op: 'ai-restore-bullet', sectionId: section.id, positionId: position.id,
                        index: i, scope,
                      })}
                    >
                      {({ trigger, restore }) => (
                        <div className="flex items-start gap-1.5">
                          <span aria-hidden="true" className="mt-[1.05rem] h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                          <div className="min-w-0 flex-1">
                            <label className="sr-only" htmlFor={`b-${position.id}-${i}`}>Bullet {i + 1}</label>
                            <textarea
                              id={`b-${position.id}-${i}`}
                              rows={3}
                              className={cx(fieldStyle.control, 'resize-y leading-relaxed')}
                              value={bullet.accepted}
                              onChange={(e) =>
                                emit({ op: 'bullet-text', sectionId: section.id, positionId: position.id, index: i, value: e.target.value })
                              }
                            />
                            {restore}
                          </div>
                          <div className="flex shrink-0 flex-col">
                            {trigger}
                            <IconButton
                              icon={Trash2}
                              tone="danger"
                              label={`Remove bullet ${i + 1}`}
                              onClick={() => emit({ op: 'bullet-remove', sectionId: section.id, positionId: position.id, index: i })}
                            />
                          </div>
                        </div>
                      )}
                    </AiAssist>
                  </li>
                ))}
              </ul>

              <Button
                size="sm"
                variant="tertiary"
                icon={Plus}
                onClick={() => emit({ op: 'bullet-add', sectionId: section.id, positionId: position.id })}
              >
                Add bullet
              </Button>
            </div>
          </Card>
        )
      })}

      <Button
        size="sm"
        variant="tertiary"
        icon={Plus}
        onClick={() => emit({ op: 'position-add', sectionId: section.id, positionId: newId() })}
      >
        Add position
      </Button>
    </div>
  )
}
