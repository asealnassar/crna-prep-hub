'use client'

import { useMemo, useState } from 'react'

/**
 * The canonical requirement editor, prefilled from a submission.
 *
 * ---------------------------------------------------------------------------
 * PREFILLED IS NOT THE SAME AS DECIDED
 * ---------------------------------------------------------------------------
 * Every field below starts from what the applicant reported, and nothing is
 * sent until Save is pressed. Opening this form creates nothing, changes
 * nothing and publishes nothing -- it is a draft of a catalog row held in this
 * component's state. That is the whole reason it exists as a form rather than
 * as an "Approve and publish" button.
 *
 * WHAT IS DELIBERATELY NOT PREFILLED, AND WHY:
 *
 *   * DOCUMENT TYPE. The applicant's words arrive as a hint and are shown
 *     beside the control, but the nine reviewed values are a taxonomy they were
 *     never asked to learn. A prefilled guess would be an inference presented
 *     as a reviewer's choice, and the reviewer would have no way to tell which
 *     of the nine it had guessed from "Letter of Intent".
 *
 *   * EVERY ENFORCEMENT REGISTER. Deciding that "about 500 words" is a target
 *     rather than a cap is a judgement about a school's wording. The wording is
 *     shown; the judgement is empty until somebody makes it. 20261002_006 is
 *     explicit that a register is a classification and a quotation is not.
 *
 *   * VERIFICATION. A submission is one applicant's report. It cannot verify
 *     itself, so the status starts at 'unverified' and the reviewer raises it
 *     only after checking the source -- which is also the condition
 *     20261002_005 puts on ever activating the set.
 *
 * THE LENGTHS ARE PREFILLED, because a number the applicant copied off an
 * instruction page is evidence of that number, and retyping it introduces
 * errors rather than preventing them. They are editable, and the applicant's
 * own report stays visible beside them.
 */

/** The nine values 20261005_007 constrains document_type to. */
const DOCUMENT_TYPES = [
  'personal-statement', 'goal-statement', 'diversity-statement',
  'writing-sample', 'additional-response', 'other',
  'statement-of-purpose', 'autobiographical-essay', 'supplemental-essay',
] as const

/** 20261002_006's register, plus the empty choice that means "not decided". */
const ENFORCEMENT = ['', 'truncated', 'enforced', 'target', 'suggested', 'unknown'] as const

const VERIFICATION = ['unverified', 'needs-review', 'verified', 'conflicting'] as const

export interface PromotionSubmission {
  readonly id: string
  readonly schoolId: string
  readonly promptText: string
  readonly applicationCycle: string | null
  readonly sourceUrl: string | null
  readonly documentLabel: string | null
  readonly documentTypeHint: string | null
  readonly statedMinWords: number | null
  readonly statedMaxWords: number | null
  readonly statedMaxCharacters: number | null
  readonly statedMaxPages: number | null
  readonly statedPagesText: string | null
  readonly formattingInstructions: string | null
  readonly otherInstructions: string | null
  readonly submitterNote: string | null
}

export interface ExistingSet {
  readonly id: string
  readonly applicationCycle: string | null
  readonly requirements: readonly { readonly label: string }[]
}

type Mode = 'new-set' | 'existing-set'

/**
 * The two jobs this editor does.
 *
 * ONE COMPONENT, BECAUSE IT IS ONE FORM. "Promote" creates the canonical entry
 * from a submission; "edit" reopens the entry that promotion created. The
 * fields, the vocabularies and the refusals are identical -- only where the
 * initial values come from and which endpoint receives them differ. A second
 * component would be a second place for the nine document types and the five
 * enforcement values to drift.
 */
export type EditorMode = 'promote' | 'edit' | 'create'

/** A canonical entry as the local store holds it, for reopening on. */
export interface ExistingEntry {
  readonly set: Record<string, unknown>
  readonly requirement: Record<string, unknown>
}

const num = (value: string): number | null =>
  (value.trim() === '' ? null : Number(value))
const blank = (value: string): string | null => (value.trim() === '' ? null : value)

/** A stored value as form text. null and undefined both become ''. */
const asText = (value: unknown): string =>
  (value === null || value === undefined ? '' : String(value))
/** A stored jsonb array of strings as one-per-line text. */
const asLines = (value: unknown): string =>
  (Array.isArray(value) ? value.map((item) => String(item)).join('\n') : '')
/** The stored components array as one question per line. */
const asComponentLines = (value: unknown): string => (Array.isArray(value)
  ? value.map((item) => String((item as { text?: unknown })?.text ?? '')).join('\n')
  : '')

/** A school an administrator may create a brand-new local set for. */
export interface SchoolChoice {
  readonly id: string
  readonly name: string
}

/**
 * Nothing to prefill from.
 *
 * USED BY 'create', where there is no submission: an administrator adding a
 * document the catalog manager asked for is not reviewing anybody's report, so
 * every field starts empty and no "Applicant said" line is rendered.
 */
const NO_SUBMISSION: PromotionSubmission = {
  id: '', schoolId: '', promptText: '', applicationCycle: null, sourceUrl: null,
  documentLabel: null, documentTypeHint: null, statedMinWords: null,
  statedMaxWords: null, statedMaxCharacters: null, statedMaxPages: null,
  statedPagesText: null, formattingInstructions: null, otherInstructions: null,
  submitterNote: null,
}

export default function PromotionEditor({
  submission: suppliedSubmission = null,
  schoolName,
  existingSets,
  mode: editorMode = 'promote',
  changeAction = null,
  existing = null,
  schoolChoices = [],
  endpoint = '/api/admin/statement-prompts',
  onCancel,
  onSaved,
}: {
  /** Required for 'promote'. Null for 'create', which reviews nothing. */
  submission?: PromotionSubmission | null
  schoolName: string
  existingSets: readonly ExistingSet[]
  /** 'edit' reopens an entry; 'create' starts an empty one. */
  mode?: EditorMode
  /**
   * For a "this prompt has changed" report: what the administrator pressed.
   *
   * NOT A CONTROL ON THIS FORM, AND THAT IS DELIBERATE. The choice is made
   * before the editor opens, by pressing one of two differently named buttons,
   * so it cannot be left at a default while a long form is filled in. This
   * form's job is to carry it, say which outcome it is about to produce, and
   * send it with the save.
   */
  changeAction?: 'replace' | 'add-additional' | null
  /** The stored rows, when editing. Ignored otherwise. */
  existing?: ExistingEntry | null
  /** Schools an administrator may create a set for. 'create' only. */
  schoolChoices?: readonly SchoolChoice[]
  /** Which admin API receives the save. */
  endpoint?: string
  onCancel: () => void
  onSaved: (result: { setId: string; requirementId: string; created: string }) => void
}) {
  const editing = editorMode === 'edit' && existing !== null
  const creating = editorMode === 'create'
  const submission = suppliedSubmission ?? NO_SUBMISSION
  const storedSet = existing?.set ?? {}
  const storedRequirement = existing?.requirement ?? {}
  /** 'create' chooses its own school; the other two inherit one. */
  const [schoolId, setSchoolId] = useState('')
  /*
   * THE MODE HAS NO SAFE DEFAULT WHEN A SET EXISTS.
   *
   * A school with no set can only be given one, so 'new-set' is not a guess
   * there. A school that already has one is the case the owner asked not to be
   * decided silently: adding a document to this year's set and opening a set
   * for a new cycle are different facts about the school. So the control starts
   * UNSET and Save stays disabled until it is answered.
   */
  // WHEN EDITING THERE IS NO DESTINATION TO CHOOSE: the entry already has a
  // set, and this form changes that set rather than picking one.
  const [mode, setMode] = useState<Mode | ''>(
    editing ? 'existing-set' : existingSets.length === 0 ? 'new-set' : '')
  const [setId, setSetId] = useState<string>(editing ? asText(storedSet.id) : '')

  // ---- the set ----------------------------------------------------------
  const [cycle, setCycle] = useState(
    editing ? asText(storedSet.application_cycle) : submission.applicationCycle ?? '')
  const [sourceUrl, setSourceUrl] = useState(
    editing ? asText(storedSet.source_url) : submission.sourceUrl ?? '')
  const [verification, setVerification] = useState<string>(
    editing ? asText(storedSet.verification_status) || 'unverified' : 'unverified')
  const [verifiedOn, setVerifiedOn] = useState(
    editing ? asText(storedSet.verified_on) : '')
  const [setNotes, setSetNotes] = useState(editing ? asLines(storedSet.notes) : '')
  const [originalText, setOriginalText] = useState(
    editing ? asText(storedSet.original_text) : submission.promptText)

  // ---- the requirement --------------------------------------------------
  const [label, setLabel] = useState(
    editing ? asText(storedRequirement.label) : submission.documentLabel ?? '')
  // WHEN EDITING, THE TYPE IS ALREADY A REVIEWED CHOICE and is prefilled. When
  // promoting it starts empty, because mapping the applicant's words onto one
  // of nine is the judgement the reviewer has not made yet.
  const [documentType, setDocumentType] = useState(
    editing ? asText(storedRequirement.document_type) : '')
  const [promptText, setPromptText] = useState(
    editing ? asText(storedRequirement.prompt_text) : submission.promptText)
  const [components, setComponents] = useState(
    editing ? asComponentLines(storedRequirement.components) : '')
  const [minWords, setMinWords] = useState(editing
    ? asText(storedRequirement.min_words) : submission.statedMinWords?.toString() ?? '')
  const [maxWords, setMaxWords] = useState(editing
    ? asText(storedRequirement.max_words) : submission.statedMaxWords?.toString() ?? '')
  const [minCharacters, setMinCharacters] = useState(
    editing ? asText(storedRequirement.min_characters) : '')
  const [maxCharacters, setMaxCharacters] = useState(editing
    ? asText(storedRequirement.max_characters)
    : submission.statedMaxCharacters?.toString() ?? '')
  const [minPages, setMinPages] = useState(
    editing ? asText(storedRequirement.min_pages) : '')
  const [maxPages, setMaxPages] = useState(editing
    ? asText(storedRequirement.max_pages) : submission.statedMaxPages?.toString() ?? '')
  const [wordsEnforcement, setWordsEnforcement] = useState(
    editing ? asText(storedRequirement.words_enforcement) : '')
  const [wordsStatedAs, setWordsStatedAs] = useState(
    editing ? asText(storedRequirement.words_stated_as) : '')
  const [charactersEnforcement, setCharactersEnforcement] = useState(
    editing ? asText(storedRequirement.characters_enforcement) : '')
  const [charactersStatedAs, setCharactersStatedAs] = useState(
    editing ? asText(storedRequirement.characters_stated_as) : '')
  const [pagesEnforcement, setPagesEnforcement] = useState(
    editing ? asText(storedRequirement.pages_enforcement) : '')
  // THE APPLICANT'S OWN WORDING FOR A PAGE LIMIT IS THE QUOTATION, so it
  // prefills the quotation field rather than a numeric bound it may not fit.
  const [pagesStatedAs, setPagesStatedAs] = useState(editing
    ? asText(storedRequirement.pages_stated_as) : submission.statedPagesText ?? '')
  const [unenforcedLength, setUnenforcedLength] = useState(
    editing ? asText(storedRequirement.unenforced_length) : '')
  const [pageSpacing, setPageSpacing] = useState(
    editing ? asText(storedRequirement.page_spacing) : '')
  const [fontSize, setFontSize] = useState(
    editing ? asText(storedRequirement.font_size_pt) : '')
  const [fontFamily, setFontFamily] = useState(
    editing ? asText(storedRequirement.font_family) : '')
  const [margins, setMargins] = useState(
    editing ? asText(storedRequirement.margins_inches) : '')
  const [citationStyle, setCitationStyle] = useState(
    editing ? asText(storedRequirement.citation_style) : '')
  const [otherInstructions, setOtherInstructions] = useState(editing
    ? asLines(storedRequirement.other_instructions) : submission.otherInstructions ?? '')
  const [isOptional, setIsOptional] = useState(
    editing ? storedRequirement.is_optional === true : false)
  const [displayOrder, setDisplayOrder] = useState(
    editing ? asText(storedRequirement.display_order) || '0' : '0')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = useMemo(() => (
    // EDITING HAS NO DESTINATION TO ANSWER. The entry already belongs to a set.
    (editing || (mode !== '' && (mode === 'new-set' || setId !== '')))
    // CREATING HAS NO SCHOOL EITHER, until one is chosen.
    && (!creating || schoolId !== '')
    && label.trim().length > 0
    && documentType !== ''
    && promptText.trim().length > 0
  ), [editing, creating, schoolId, mode, setId, label, documentType, promptText])

  async function save(publish = false) {
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    try {
      /*
       * TWO ENDPOINTS, ONE PAYLOAD.
       *
       * Promoting POSTs -- it creates catalog data, and in production that is
       * the SECURITY DEFINER function. Editing PUTs to the development-only
       * handler, which changes a row that already exists in the local store.
       * The body below is the same either way, which is why one form can do
       * both: the set and requirement fields are the catalog's own fields.
       */
      const response = await fetch(endpoint, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // PUBLISHING IS A PROPERTY OF THE REQUEST, not a second endpoint.
          // The server supplies the evidence -- a verified status, today's
          // date and this submission's id -- so a browser cannot claim an
          // entry was verified by sending fields that say so.
          ...(publish ? { publish: true } : {}),
          ...(editing
            ? { action: 'edit', requirementId: asText(storedRequirement.id) }
            : creating
              // THE CATALOG MANAGER NAMES ITS OWN SCHOOL. No submission is
              // involved, so there is no id to carry and no school to inherit.
              ? { mode, schoolId, setId: mode === 'existing-set' ? setId : null }
              : {
                id: submission.id,
                mode,
                setId: mode === 'existing-set' ? setId : null,
                // SENT ONLY WHEN THERE IS ONE. The server refuses the word on
                // a submission that is not a report, so an absent choice must
                // be an absent key rather than a null the handler has to read
                // as "no opinion".
                ...(changeAction === null ? {} : { changeAction }),
              }),
          set: {
            application_cycle: blank(cycle),
            source_url: blank(sourceUrl),
            verification_status: verification,
            verified_on: blank(verifiedOn),
            original_text: originalText,
            is_verbatim: originalText === submission.promptText,
            // ONE NOTE PER LINE, as the jsonb array of strings the catalog
            // stores. Blank lines are dropped rather than stored as '' notes.
            notes: setNotes.split('\n').map((line) => line.trim()).filter(Boolean),
            display_order: 0,
          },
          requirement: {
            label: label.trim(),
            document_type: documentType,
            prompt_text: promptText,
            // Each line is one of the prompt's numbered questions.
            components: components.split('\n').map((line) => line.trim()).filter(Boolean)
              .map((textLine, index) => ({
                id: `c${index + 1}`, text: textLine, optional: false,
              })),
            min_words: num(minWords),
            max_words: num(maxWords),
            min_characters: num(minCharacters),
            max_characters: num(maxCharacters),
            min_pages: num(minPages),
            max_pages: num(maxPages),
            words_enforcement: blank(wordsEnforcement),
            words_stated_as: blank(wordsStatedAs),
            characters_enforcement: blank(charactersEnforcement),
            characters_stated_as: blank(charactersStatedAs),
            pages_enforcement: blank(pagesEnforcement),
            pages_stated_as: blank(pagesStatedAs),
            unenforced_length: blank(unenforcedLength),
            page_spacing: blank(pageSpacing),
            font_size_pt: num(fontSize),
            font_family: blank(fontFamily),
            margins_inches: num(margins),
            citation_style: blank(citationStyle),
            other_instructions: otherInstructions.split('\n')
              .map((line) => line.trim()).filter(Boolean),
            is_optional: isOptional,
            notes: [],
            display_order: num(displayOrder) ?? 0,
          },
        }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setError(typeof body?.error === 'string'
          ? body.error
          : editing ? 'Those edits could not be saved.'
            : 'That requirement could not be created.')
        return
      }
      onSaved({
        setId: String(body?.setId), requirementId: String(body?.requirementId),
        created: String(body?.created ?? 'edit'),
      })
    } catch {
      setError(editing
        ? 'Those edits could not be saved.'
        : 'That requirement could not be created.')
    } finally {
      setSaving(false)
    }
  }

  const field = 'w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900'
  const lab = 'mb-1 block text-xs font-medium text-slate-600'

  return (
    <div className="mt-4 rounded-xl border-2 border-blue-300 bg-blue-50/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-900">
          {editing ? 'Edit Catalog Entry'
            : creating ? 'Add Requirement'
            : changeAction === 'replace' ? 'Replace Existing Prompt'
            : changeAction === 'add-additional' ? 'Add as Additional Prompt'
            : 'Add to School Requirements'}
          {schoolName === '' ? null : <> &mdash; {schoolName}</>}
        </h3>
        {/* SAID BEFORE ANYTHING IS TYPED, not after it is saved. */}
        <p className="text-xs font-semibold text-blue-800">
          {editing
            ? 'Saving keeps this entry inactive. Activation stays a separate button.'
            : 'Nothing is created until you press Save. New rows are always inactive.'}
        </p>
      </div>

      {/*
        WHICH OUTCOME THIS SAVE PRODUCES, IN THE WORDS OF THE CONSEQUENCE.

        "Replace" and "add" are the administrator's words; what they mean to an
        applicant is whether a prompt they may be mid-draft on stops being
        offered. That is the sentence worth reading before a long form, so it
        is the sentence shown -- and it is shown for BOTH choices, because
        "nothing is removed" is just as much a fact to confirm as its opposite.
      */}
      {changeAction !== null && (
        <p className={`mt-3 rounded-lg border px-3 py-2 text-xs font-semibold ${
          changeAction === 'replace'
            ? 'border-amber-300 bg-amber-50 text-amber-900'
            : 'border-blue-300 bg-blue-50 text-blue-900'}`}
        >
          {changeAction === 'replace'
            ? 'Saving publishes this as the school\u2019s prompt and stops offering the '
              + 'reported one. The replaced prompt is kept and records what replaced it.'
            : 'Saving publishes this alongside the reported prompt. The reported prompt is '
              + 'left exactly as it is and keeps being offered.'}
        </p>
      )}

      {/* ---- the school, when nothing supplies one ---- */}
      {creating && (
        <fieldset className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
          <legend className="px-1 text-xs font-bold uppercase tracking-wide text-slate-500">
            Which school?
          </legend>
          <select
            value={schoolId}
            onChange={(event) => {
              setSchoolId(event.target.value)
              // A SET BELONGS TO A SCHOOL. Changing the school abandons a
              // destination chosen under the previous one.
              setSetId('')
              setMode(existingSets.length === 0 ? 'new-set' : '')
            }}
            className={field}
          >
            <option value="">Choose a school&hellip;</option>
            {schoolChoices.map((school) => (
              <option key={school.id} value={school.id}>{school.name}</option>
            ))}
          </select>
          {schoolChoices.length === 0 && (
            <p className="mt-1.5 text-xs text-amber-800">
              The school directory could not be read, so there is nothing to choose from.
            </p>
          )}
        </fieldset>
      )}

      {/* ---- Case A / Case B, chosen and never guessed ---- */}
      {!editing && (
      <fieldset className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
        <legend className="px-1 text-xs font-bold uppercase tracking-wide text-slate-500">
          Where does this document go?
        </legend>
        {existingSets.length === 0 ? (
          <p className="text-sm text-slate-700">
            This school has no requirement set that applicants can see, so this will
            create one.
          </p>
        ) : (
          <div className="grid gap-2">
            <label className="flex items-start gap-2 text-sm text-slate-800">
              <input
                type="radio"
                name="mode"
                checked={mode === 'existing-set'}
                onChange={() => setMode('existing-set')}
                className="mt-1"
              />
              <span>
                Add it to a set this school already has
                {mode === 'existing-set' && (
                  <select
                    value={setId}
                    onChange={(event) => setSetId(event.target.value)}
                    className={`${field} mt-1.5`}
                  >
                    <option value="">Choose a set&hellip;</option>
                    {existingSets.map((set) => (
                      <option key={set.id} value={set.id}>
                        {set.applicationCycle ?? 'no cycle'} &middot;{' '}
                        {set.requirements.length} document
                        {set.requirements.length === 1 ? '' : 's'}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-800">
              <input
                type="radio"
                name="mode"
                checked={mode === 'new-set'}
                onChange={() => setMode('new-set')}
                className="mt-1"
              />
              <span>Create a new set, for a different application cycle</span>
            </label>
            {mode === '' && (
              <p className="text-xs font-medium text-amber-800">
                This school already has requirements. Choose one of the two above &mdash;
                we will not guess.
              </p>
            )}
          </div>
        )}
      </fieldset>
      )}

      {/* ---- the set ----
          SHOWN WHEN EDITING TOO, and that is the whole point of this mode: the
          verification status, source URL and verified date an activation needs
          are SET-level fields, and they are exactly what arrives after a
          promotion rather than before it. */}
      {(editing || mode === 'new-set') && (
        <fieldset className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
          <legend className="px-1 text-xs font-bold uppercase tracking-wide text-slate-500">
            Requirement set
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={lab} htmlFor="p-cycle">Application cycle</label>
              <input id="p-cycle" className={field} value={cycle}
                onChange={(e) => setCycle(e.target.value)} placeholder="2026-2027" />
            </div>
            <div>
              <label className={lab} htmlFor="p-source">Source URL</label>
              <input id="p-source" className={field} value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" />
            </div>
            <div>
              <label className={lab} htmlFor="p-verif">Verification status</label>
              {/* STARTS UNVERIFIED. A submission cannot verify itself, and an
                  active set needs verified + source + date (20261002_005). */}
              <select id="p-verif" className={field} value={verification}
                onChange={(e) => setVerification(e.target.value)}>
                {VERIFICATION.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className={lab} htmlFor="p-verified-on">Verified on</label>
              <input id="p-verified-on" type="date" className={field} value={verifiedOn}
                onChange={(e) => setVerifiedOn(e.target.value)} />
            </div>
          </div>
          <label className={`${lab} mt-3`} htmlFor="p-original">
            Original text, as recorded
          </label>
          <textarea id="p-original" rows={2} className={field} value={originalText}
            onChange={(e) => setOriginalText(e.target.value)} />
          <label className={`${lab} mt-3`} htmlFor="p-setnotes">
            Set notes, one per line
          </label>
          <textarea id="p-setnotes" rows={2} className={field} value={setNotes}
            onChange={(e) => setSetNotes(e.target.value)}
            placeholder="Anything uncertain about scope or conflicting sources" />
        </fieldset>
      )}

      {/* ---- the requirement ---- */}
      <fieldset className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
        <legend className="px-1 text-xs font-bold uppercase tracking-wide text-slate-500">
          Writing requirement
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={lab} htmlFor="p-label">
              Document label <span className="text-rose-600">*</span>
            </label>
            <input id="p-label" className={field} value={label}
              onChange={(e) => setLabel(e.target.value)} placeholder="Personal Statement" />
            {submission.documentLabel !== null && (
              <p className="mt-1 text-[11px] text-slate-500">
                Applicant said: {submission.documentLabel}
              </p>
            )}
          </div>
          <div>
            <label className={lab} htmlFor="p-type">
              Document type <span className="text-rose-600">*</span>
            </label>
            {/* NOT PREFILLED. Mapping their words to one of nine is the
                reviewer's judgement, so it starts empty and their words are
                shown underneath. */}
            <select id="p-type" className={field} value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}>
              <option value="">Choose&hellip;</option>
              {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {submission.documentTypeHint !== null && (
              <p className="mt-1 text-[11px] text-slate-500">
                Applicant said: {submission.documentTypeHint}
              </p>
            )}
          </div>
        </div>

        <label className={`${lab} mt-3`} htmlFor="p-prompt">
          Prompt text <span className="text-rose-600">*</span>
        </label>
        <textarea id="p-prompt" rows={4} className={field} value={promptText}
          onChange={(e) => setPromptText(e.target.value)} />

        <label className={`${lab} mt-3`} htmlFor="p-components">
          Components / questions, one per line
        </label>
        <textarea id="p-components" rows={3} className={field} value={components}
          onChange={(e) => setComponents(e.target.value)}
          placeholder="Why nurse anesthesia&#10;Your clinical background" />

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label className={lab} htmlFor="p-minw">Min words</label>
            <input id="p-minw" type="number" className={field} value={minWords}
              onChange={(e) => setMinWords(e.target.value)} />
          </div>
          <div>
            <label className={lab} htmlFor="p-maxw">Max words</label>
            <input id="p-maxw" type="number" className={field} value={maxWords}
              onChange={(e) => setMaxWords(e.target.value)} />
          </div>
          <div>
            <label className={lab} htmlFor="p-wenf">Words enforcement</label>
            <select id="p-wenf" className={field} value={wordsEnforcement}
              onChange={(e) => setWordsEnforcement(e.target.value)}>
              {ENFORCEMENT.map((v) => (
                <option key={v || 'none'} value={v}>{v === '' ? 'not decided' : v}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-3">
            <label className={lab} htmlFor="p-wsa">Words stated as (quote the school)</label>
            <input id="p-wsa" className={field} value={wordsStatedAs}
              onChange={(e) => setWordsStatedAs(e.target.value)}
              placeholder="Maximum of 750 words" />
          </div>

          <div>
            <label className={lab} htmlFor="p-minc">Min characters</label>
            <input id="p-minc" type="number" className={field} value={minCharacters}
              onChange={(e) => setMinCharacters(e.target.value)} />
          </div>
          <div>
            <label className={lab} htmlFor="p-maxc">Max characters</label>
            <input id="p-maxc" type="number" className={field} value={maxCharacters}
              onChange={(e) => setMaxCharacters(e.target.value)} />
          </div>
          <div>
            <label className={lab} htmlFor="p-cenf">Characters enforcement</label>
            <select id="p-cenf" className={field} value={charactersEnforcement}
              onChange={(e) => setCharactersEnforcement(e.target.value)}>
              {ENFORCEMENT.map((v) => (
                <option key={v || 'none'} value={v}>{v === '' ? 'not decided' : v}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-3">
            <label className={lab} htmlFor="p-csa">Characters stated as</label>
            <input id="p-csa" className={field} value={charactersStatedAs}
              onChange={(e) => setCharactersStatedAs(e.target.value)} />
          </div>

          <div>
            <label className={lab} htmlFor="p-minp">Min pages</label>
            {/* step 0.1: a page and a half is a real limit (20261005_007). */}
            <input id="p-minp" type="number" step={0.1} className={field} value={minPages}
              onChange={(e) => setMinPages(e.target.value)} />
          </div>
          <div>
            <label className={lab} htmlFor="p-maxp">Max pages</label>
            <input id="p-maxp" type="number" step={0.1} className={field} value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)} />
          </div>
          <div>
            <label className={lab} htmlFor="p-penf">Pages enforcement</label>
            <select id="p-penf" className={field} value={pagesEnforcement}
              onChange={(e) => setPagesEnforcement(e.target.value)}>
              {ENFORCEMENT.map((v) => (
                <option key={v || 'none'} value={v}>{v === '' ? 'not decided' : v}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-3">
            <label className={lab} htmlFor="p-psa">Pages stated as</label>
            <input id="p-psa" className={field} value={pagesStatedAs}
              onChange={(e) => setPagesStatedAs(e.target.value)} />
            {submission.statedPagesText !== null && (
              <p className="mt-1 text-[11px] text-slate-500">
                Applicant said: {submission.statedPagesText}
              </p>
            )}
          </div>
        </div>

        <label className={`${lab} mt-3`} htmlFor="p-unenforced">
          Prose-only / unenforced length
        </label>
        <input id="p-unenforced" className={field} value={unenforcedLength}
          onChange={(e) => setUnenforcedLength(e.target.value)}
          placeholder="Concise, no stated limit" />

        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div>
            <label className={lab} htmlFor="p-spacing">Spacing</label>
            <input id="p-spacing" className={field} value={pageSpacing}
              onChange={(e) => setPageSpacing(e.target.value)} placeholder="double" />
          </div>
          <div>
            <label className={lab} htmlFor="p-font">Font</label>
            <input id="p-font" className={field} value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)} placeholder="Times New Roman" />
          </div>
          <div>
            <label className={lab} htmlFor="p-size">Font size (pt)</label>
            <input id="p-size" type="number" className={field} value={fontSize}
              onChange={(e) => setFontSize(e.target.value)} />
          </div>
          <div>
            <label className={lab} htmlFor="p-margin">Margins (in)</label>
            <input id="p-margin" type="number" step={0.25} className={field} value={margins}
              onChange={(e) => setMargins(e.target.value)} />
          </div>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label className={lab} htmlFor="p-cite">Citation style</label>
            <input id="p-cite" className={field} value={citationStyle}
              onChange={(e) => setCitationStyle(e.target.value)} placeholder="APA 7" />
          </div>
          <div>
            <label className={lab} htmlFor="p-order">Display order</label>
            <input id="p-order" type="number" className={field} value={displayOrder}
              onChange={(e) => setDisplayOrder(e.target.value)} />
          </div>
          <label className="flex items-end gap-2 pb-1.5 text-sm text-slate-800">
            <input type="checkbox" checked={isOptional}
              onChange={(e) => setIsOptional(e.target.checked)} />
            Optional document
          </label>
        </div>

        <label className={`${lab} mt-3`} htmlFor="p-other">
          Other instructions, one per line
        </label>
        <textarea id="p-other" rows={2} className={field} value={otherInstructions}
          onChange={(e) => setOtherInstructions(e.target.value)} />
        {submission.formattingInstructions !== null && (
          <p className="mt-1 text-[11px] text-slate-500">
            Applicant reported formatting: {submission.formattingInstructions}
          </p>
        )}
      </fieldset>

      {error !== null && (
        <p role="alert" className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/*
          THE PRIMARY ACTION SAYS WHAT IT DOES TO APPLICANTS.

          It used to read "Save requirement (inactive)", preceded by a button
          called "Approve", and neither put a prompt in front of anybody:
          publishing took two further steps that nothing announced. An
          administrator who approved a submission and stopped had every reason
          to think they were done.

          OFFERED ONLY WHERE IT MEANS SOMETHING. Editing an existing entry and
          creating one by hand are not decisions about a submission, so they
          keep the explicit inactive wording.
        */}
        {!editing && !creating && (
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={!ready || saving}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Working…' : 'Approve & Publish to School Prompts'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!ready || saving}
          className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
            !editing && !creating
              ? 'border border-slate-300 text-slate-700'
              : 'bg-blue-600 text-white'
          }`}
        >
          {saving
            ? 'Saving…'
            : editing ? 'Save changes (stays inactive)'
              : creating ? 'Create requirement (inactive)'
              // NAMED FOR WHAT IT DOES NOT DO, so it cannot be mistaken for
              // the button beside it.
              : 'Approve only — do not publish yet'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
        >
          Cancel
        </button>
        {!ready && (
          <span className="text-xs text-slate-500">
            {editing
              ? 'A label, a document type and the wording are required.'
              : creating
                ? 'A school, a destination, a label, a document type and the wording '
                  + 'are required.'
                : 'A label, a document type, the wording and a destination are required.'}
          </span>
        )}
      </div>
    </div>
  )
}
