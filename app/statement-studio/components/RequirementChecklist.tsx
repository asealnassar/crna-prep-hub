'use client'

import { useState } from 'react'
import { UNMEASURED_NOTICE } from '@/lib/statement/requirements/constraints'
import {
  progressLabel, type ChecklistRow, type ChecklistView, type RequirementCard,
} from '@/lib/statement/requirements/checklistView'

/**
 * A school's writing requirements as a checklist of cards.
 *
 * EVERY DECISION ON THIS SCREEN WAS ALREADY MADE. checklistView() decided which
 * rows exist, which card offers Start and which offers Continue, what each
 * limit says and whether a choice has been settled; this component renders a
 * ChecklistView and holds exactly one piece of state of its own -- which card's
 * detail is expanded. That is deliberate: the interesting rules are tested at
 * runtime in lib/, because a component importing next/navigation cannot be.
 *
 * NO NEW DESIGN LANGUAGE. The card, the border, the radius, the badge and the
 * blue primary button are the ones the draft library and the editor already
 * use. The sidebar is not touched, referenced or re-laid-out by anything here.
 *
 * A MEASURED LIMIT AND AN UNMEASURED ONE DO NOT LOOK ALIKE, which is the one
 * visual rule this component adds: the two numbers the editor really watches
 * are shown as solid chips, and a page count or a font is shown as an outlined
 * chip under a notice saying plainly that this editor cannot check it. An
 * applicant should never be able to mistake "we are counting this for you" for
 * "you must check this yourself".
 */

/** A requirement the applicant has not started. The parent decides what Start does. */
export interface ChecklistActions {
  /** Called with the requirement id. The parent creates the draft. */
  readonly onStart: (requirementId: string) => void
  /** Where an existing draft lives. */
  readonly draftHref: (draftId: string) => string
  /** True while a creation request is in flight, so buttons can be disabled. */
  readonly busy?: boolean
  /**
   * True when these controls create nothing -- the development preview.
   *
   * IT CHANGES HOW THEY LOOK, NOT JUST WHAT THEY DO. A blue primary button
   * reading "Start" is this product's promise that pressing it creates a
   * draft. In the preview it creates local state and nothing else, from
   * unverified research fixtures, so rendering the same button would be the
   * interface claiming something untrue about data it also calls unverified.
   * The demo still works -- that is the point of a preview -- but it is dressed
   * as a demo.
   */
  readonly demo?: boolean
}

function LimitChips({ card }: { card: RequirementCard }) {
  if (card.constraints.length === 0) {
    return (
      <p className="mt-3 text-xs font-medium text-slate-500">{card.constraintSummary}</p>
    )
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {card.constraints.map((limit) => (
        <span
          key={`${limit.kind}-${limit.text}`}
          className={limit.measured
            // Solid: the editor is watching this number.
            ? 'rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white'
            // Outlined: stated by the school, not checked here.
            : 'rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-600'}
        >
          {limit.text}
        </span>
      ))}
    </div>
  )
}

function Card({
  card, actions, expanded, onToggle, badge,
}: {
  card: RequirementCard
  actions: ChecklistActions
  expanded: boolean
  onToggle: () => void
  /** An extra label, e.g. "Option 1" inside a choice. */
  badge?: string
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-blue-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            {badge !== undefined && (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">
                {badge}
              </span>
            )}
            <span className="text-base font-bold text-slate-900">{card.label}</span>
            {card.optional && (
              <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Optional
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs font-medium text-slate-500">{card.documentTypeLabel}</p>
        </div>

        {/*
          START CREATES NOTHING UNTIL IT IS PRESSED. A school asking for five
          documents does not get five drafts when the page loads.
        */}
        {card.started === null ? (
          <button
            type="button"
            onClick={() => actions.onStart(card.requirementId)}
            disabled={actions.busy === true}
            className={actions.demo === true
              // DEMO: dashed, grey and labelled. Nothing about it reads as the
              // primary action that creates a draft.
              ? 'rounded-xl border border-dashed border-slate-400 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60'
              : 'rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60'}
          >
            {actions.demo === true ? 'Start (preview only)' : 'Start'}
          </button>
        ) : actions.demo === true ? (
          /*
            NOT A LINK, because there is nothing to open. An anchor to a dead
            href is a broken promise a keyboard user meets first.
          */
          <span className="rounded-xl border border-dashed border-slate-400 px-4 py-2 text-sm font-semibold text-slate-500">
            Continue (preview only)
          </span>
        ) : (
          <a
            href={actions.draftHref(card.started.id)}
            className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            Continue
          </a>
        )}
      </div>

      <LimitChips card={card} />

      {/* THE NOTICE SITS WITH THE CHIPS IT EXPLAINS, not at the foot of the page. */}
      {card.showUnmeasuredNotice && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{UNMEASURED_NOTICE}</p>
      )}

      {card.started !== null && (
        <p className="mt-3 text-xs text-slate-500">
          {actions.demo === true
            ? 'Preview: this is how a started document appears. No draft exists.'
            : `${card.started.words.toLocaleString('en-US')} words saved`}
        </p>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="mt-3 text-xs font-semibold text-blue-700 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {expanded ? 'Hide the prompt' : 'Read the prompt'}
      </button>

      {expanded && (
        <div className="mt-3 border-t border-slate-200 pt-3">
          {/* The recorded wording, as escaped text with its whitespace kept. */}
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
            {card.promptText}
          </p>

          {/*
            THE QUESTIONS, TOGETHER, IN ONE CARD. They are answered in one
            essay, so they are listed inside the one document rather than
            becoming documents of their own.
          */}
          {card.questions.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                This one document must address {card.questions.filter((q) => !q.optional).length}
                {' '}
                {card.questions.filter((q) => !q.optional).length === 1 ? 'question' : 'questions'}
              </p>
              <ol className="mt-2 grid gap-2">
                {card.questions.map((question, index) => (
                  <li key={question.id} className="flex gap-2 text-sm leading-relaxed text-slate-700">
                    <span className="font-semibold text-slate-400">{index + 1}.</span>
                    <span>
                      {question.optional && (
                        <span className="mr-1.5 rounded border border-slate-300 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          Optional
                        </span>
                      )}
                      {question.text}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {/* UNRESOLVED UNCERTAINTY IS SHOWN, NOT RESOLVED. */}
          {card.notes.length > 0 && (
            <ul className="mt-3 grid gap-1.5">
              {card.notes.map((note) => (
                <li key={note} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                  {note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Row({
  row, actions, expanded, onToggle,
}: {
  row: ChecklistRow
  actions: ChecklistActions
  expanded: string | null
  onToggle: (id: string) => void
}) {
  if (row.kind === 'document') {
    return (
      <li>
        <Card
          card={row.card}
          actions={actions}
          expanded={expanded === row.card.requirementId}
          onToggle={() => onToggle(row.card.requirementId)}
        />
      </li>
    )
  }

  // A CHOICE IS ONE ITEM ON THE LIST, with its alternatives nested inside it.
  // Rendering them as two top-level cards would tell the applicant to write
  // both, which is the opposite of what the school asked.
  return (
    <li className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-4">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-slate-900">
          {row.chosen === null ? 'Choose one of these' : 'Your choice'}
        </span>
        {row.optional && (
          <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Optional
          </span>
        )}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        {row.chosen === null
          ? 'The school asks for one of the following. Pick the one you want to answer — your draft is created against that prompt, and the analysis assesses it against that prompt only.'
          : 'You started one of the alternatives. The other is shown so you can see what it asked; delete your draft if you want to switch.'}
      </p>
      <ul className="mt-3 grid gap-3">
        {row.options.map((option, index) => (
          <li key={option.requirementId}>
            <Card
              card={option}
              actions={actions}
              badge={`Option ${index + 1}`}
              expanded={expanded === option.requirementId}
              onToggle={() => onToggle(option.requirementId)}
            />
          </li>
        ))}
      </ul>
    </li>
  )
}

export default function RequirementChecklist({
  view, actions,
}: {
  view: ChecklistView
  actions: ChecklistActions
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const toggle = (id: string) => setExpanded((current) => (current === id ? null : id))

  return (
    <section aria-labelledby="requirements-heading" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="requirements-heading" className="text-xl font-bold tracking-tight text-slate-900">
            {view.schoolName}
          </h2>
          <p className="mt-0.5 text-sm text-slate-600">
            {progressLabel(view)}
            {view.applicationCycle === null ? '' : ` · ${view.applicationCycle} cycle`}
          </p>
        </div>
      </div>

      {/*
        SAID BEFORE ANY REQUIREMENT IS READ. A reader who scrolled past this and
        wrote to an unverified limit would be the one failure this screen must
        not have, so it is above the cards rather than beneath them.
      */}
      {view.verificationNotice !== null && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-medium leading-relaxed text-amber-900">
          {view.verificationNotice}
        </p>
      )}
      <p className="text-[11px] leading-relaxed text-slate-500">{view.textAttribution}</p>

      {view.notes.length > 0 && (
        <ul className="grid gap-1.5">
          {view.notes.map((note) => (
            <li key={note} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
              {note}
            </li>
          ))}
        </ul>
      )}

      <ul className="grid gap-3">
        {view.rows.map((row) => (
          <Row
            key={row.kind === 'document' ? row.card.requirementId : row.key}
            row={row}
            actions={actions}
            expanded={expanded}
            onToggle={toggle}
          />
        ))}
      </ul>

      {/*
        THE RESEARCH TEXT, LAST AND COLLAPSED. It is the evidence the structured
        limits above were derived from; when the two disagree this is the one
        that is right, so it has to be reachable without being in the way.
      */}
      {view.originalText.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">
            What was recorded for this school
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">
            {view.originalText}
          </p>
        </details>
      )}
    </section>
  )
}
