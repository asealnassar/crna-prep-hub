/**
 * Catalog rows created locally by the admin promotion flow.
 *
 * WHY A SEPARATE FILE FROM THE PAYLOAD. local-review/statement_requirements_
 * catalog.json is a COPY OF PRODUCTION -- the 63 sets and 80 documents that
 * were imported and verified. Writing promoted rows into it would corrupt the
 * record of what production actually holds, and the owner asked for the
 * opposite: test the whole workflow without touching that. So promotions land
 * here, in their own gitignored file, and the catalog reader unions the two.
 *
 * IT IMITATES THE FUNCTION, NOT THE TABLES. The real write path is
 * promote_statement_submission_to_requirement() -- a SECURITY DEFINER function
 * whose EXECUTE is granted to service_role alone, because no role holds INSERT
 * on either canonical table. A JSON file has no grants to reproduce, so the
 * properties that matter are reproduced as behaviour:
 *
 *   * the caller must be an administrator, which the route establishes;
 *   * the set is CHOSEN, never guessed: an invalid or absent mode is refused;
 *   * every canonical value comes from the administrator's payload, and not one
 *     is read from the submission;
 *   * both rows are written is_active = false, always, whatever the payload
 *     says -- which is the one property a local test could most easily lose;
 *   * a refusal writes nothing at all, so there is no partial set and no
 *     orphan requirement.
 *
 * ACTIVATION IS STILL A SEPARATE ACT. simulateActivation() exists so the owner
 * can see what an applicant would see afterwards, and it is deliberately not
 * part of saving: nothing this module writes becomes visible until somebody
 * asks for it in a second, explicit step.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readJsonStore, writeJsonStore } from './jsonStore.ts'

type Row = Record<string, unknown>

const STORE = path.join(
  process.cwd(),
  'local-review',
  path.basename(process.env.STATEMENT_LOCAL_CANONICAL_FILE ?? 'dev-canonical.json'),
)

export interface LocalCanonical {
  readonly sets: Row[]
  readonly documents: Row[]
}

/**
 * One catalog row replaced by another, and what caused the replacement.
 *
 * ---------------------------------------------------------------------------
 * WHY A RECORD AND NOT A FLAG ON THE ROW
 * ---------------------------------------------------------------------------
 * The row being replaced usually lives in local-review/statement_requirements_
 * catalog.json -- the copy of what production actually holds. Writing
 * `is_active = false` into that file would corrupt the record of production,
 * which is the one thing the module header says this file exists to avoid.
 *
 * So the replacement is recorded HERE, in the local store, as an overlay the
 * catalog reader applies. The production copy stays byte-identical, and the
 * three questions 20261008_012 keeps answerable stay answerable locally too:
 * what the catalog used to say, what replaced it, and which submission caused
 * the change.
 *
 * APPEND-ONLY, AND NOTHING IS DELETED. The superseded row is still readable;
 * it is simply no longer OFFERED, which is what "replace" means to an
 * applicant and what `is_active = false` would mean in production.
 */
export interface LocalSupersession {
  /** The row that is no longer current. */
  readonly requirementId: string
  /** The row that replaced it. */
  readonly supersededBy: string
  /** The report that caused it. */
  readonly submissionId: string
  readonly reviewerId: string | null
  readonly at: string
}

/**
 * The promoted canonical rows.
 *
 * AN UNREADABLE STORE THROWS. It used to log and return an empty catalog,
 * which is indistinguishable from "nothing has been promoted" -- and the next
 * promotion wrote that empty catalog back over the real one.
 */
function readAll(): LocalCanonical {
  const parsed = readJsonStore<Partial<LocalCanonical>>(STORE, { sets: [], documents: [] })
  return {
    sets: Array.isArray(parsed.sets) ? parsed.sets : [],
    documents: Array.isArray(parsed.documents) ? parsed.documents : [],
  }
}

/**
 * The supersession overlay, read from the SAME file and kept out of
 * LocalCanonical.
 *
 * SEPARATE FROM readAll() ON PURPOSE. Every caller of readAll() either filters
 * rows or writes them back, and a third key travelling through writeAll()
 * would be dropped by the ones that rebuild the object from its two halves.
 * Reading and writing it on its own means a promotion cannot erase a
 * replacement and a replacement cannot erase a promotion.
 */
function readSupersessions(): LocalSupersession[] {
  const parsed = readJsonStore<{ supersessions?: unknown }>(STORE, {})
  const raw = parsed.supersessions
  if (!Array.isArray(raw)) return []
  const out: LocalSupersession[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (typeof row.requirementId !== 'string' || typeof row.supersededBy !== 'string') continue
    out.push({
      requirementId: row.requirementId,
      supersededBy: row.supersededBy,
      submissionId: typeof row.submissionId === 'string' ? row.submissionId : '',
      reviewerId: typeof row.reviewerId === 'string' ? row.reviewerId : null,
      at: typeof row.at === 'string' ? row.at : '',
    })
  }
  return out
}

function writeAll(next: LocalCanonical): void {
  // THE OVERLAY IS CARRIED THROUGH EVERY WRITE. writeAll() is called with a
  // freshly built {sets, documents} from several places; without this line the
  // first promotion after a replacement would silently un-replace it.
  writeJsonStore(STORE, { ...next, supersessions: readSupersessions() })
}

/** The nine reviewed document types, as 20261005_007 constrains them. */
const DOCUMENT_TYPES = [
  'personal-statement', 'goal-statement', 'diversity-statement',
  'writing-sample', 'additional-response', 'other',
  'statement-of-purpose', 'autobiographical-essay', 'supplemental-essay',
] as const

type Outcome =
  | {
    readonly ok: true
    readonly setId: string
    readonly requirementId: string
    readonly created: 'set' | 'requirement'
    readonly isActive: false
  }
  | { readonly ok: false; readonly reason: string; readonly detail?: string }

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : value
}
const int = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null
/** numeric(4,1): one decimal place survives, so a page and a half does. */
const dec = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
const bool = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * The local stand-in for promote_statement_submission_to_requirement().
 *
 * THE SUBMISSION IS READ FOR TWO THINGS ONLY, exactly as the function does: its
 * school, and whether it has already been promoted. Its wording, its label and
 * its reported limits are never copied -- an administrator decided those, and
 * a path that quietly fell back to the applicant's values would be publishing
 * unreviewed text as reviewed data.
 */
export function promoteLocally(input: {
  readonly submission: Row | null
  readonly reviewerId: string | null
  readonly mode: unknown
  readonly setId: unknown
  readonly set: Row
  readonly requirement: Row
}): Outcome {
  if (input.reviewerId === null) return { ok: false, reason: 'invalid-reviewer' }
  const submission = input.submission
  if (submission === null) return { ok: false, reason: 'not-found' }
  if (submission.approved_requirement_id) {
    return { ok: false, reason: 'already-promoted' }
  }
  if (submission.status === 'rejected' || submission.status === 'withdrawn') {
    return { ok: false, reason: 'not-promotable' }
  }

  // THE WRITE ITSELF IS SHARED WITH THE CATALOG MANAGER, which creates entries
  // that came from no submission at all. Promotion is "this submission's
  // school, plus a created entry, plus the link back"; the middle part is the
  // same act either way, and duplicating it would be duplicating the one rule
  // that matters most -- is_active = false on both rows.
  return createLocalCanonicalEntry({
    schoolId: String(submission.school_id),
    mode: input.mode,
    setId: input.setId,
    set: input.set,
    requirement: input.requirement,
    origin: 'promoted',
  })
}

/**
 * Approve a submission and publish it, in one act.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS ONE ACTION
 * ---------------------------------------------------------------------------
 * Publishing a student's prompt used to take four separate steps -- approve,
 * promote, edit the entry to supply a status and a date, activate -- and only
 * the last one changed anything an applicant could see. An administrator who
 * clicked Approve and stopped had, reasonably, no idea that nothing had
 * happened; the word means "yes, publish this" in every other product they
 * use.
 *
 * So the primary action does all four, and the partial one is still available
 * under a name that says what it does NOT do.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT BYPASS THE EVIDENCE RULE
 * ---------------------------------------------------------------------------
 * The published set carries `evidence_kind = 'admin-approved-submission'` and
 * the id of the submission it was published from, which is what migration 011
 * accepts in place of a source URL. The rule is unchanged in substance: no
 * active set without a verified status, a date, and something a person can
 * point at. What changed is that an administrator's recorded decision on a
 * specific submission counts as something to point at.
 *
 * AND THE DIFFERENCE STAYS VISIBLE. `evidence_kind` is stored, and
 * EVIDENCE_LABELS is what the applicant reads; a prompt published this way is
 * never described as checked against the school's own page.
 */
export function approveAndPublishLocally(input: {
  readonly submission: Row | null
  readonly reviewerId: string | null
  readonly mode: unknown
  readonly setId: unknown
  readonly set: Row
  readonly requirement: Row
  /** The day the administrator took the decision. */
  readonly decidedOn: string
}): Outcome {
  const promoted = promoteLocally({
    submission: input.submission,
    reviewerId: input.reviewerId,
    mode: input.mode,
    setId: input.setId,
    // THE EVIDENCE RIDES THE CREATE. A set written without it and patched a
    // moment later is a set that briefly claims to be verified with nothing
    // behind it, which is the state the constraint exists to forbid.
    set: {
      ...input.set,
      verification_status: 'verified',
      verified_on: input.decidedOn,
      evidence_kind: 'admin-approved-submission',
      evidence_submission_id: input.submission === null ? null : input.submission.id,
    },
    requirement: input.requirement,
  })
  if (!promoted.ok) return promoted

  // PUBLISHED ONLY IF THE SAME CHECK PRODUCTION WOULD RUN PASSES. simulate-
  // Activation re-reads the written row and applies activationShortfall, so a
  // set this function somehow left short is refused here rather than published.
  const activated = simulateActivation(String(promoted.setId))
  if (!activated.ok) {
    // THE SHORTFALL IS CARRIED OUT, not summarised away: an administrator told
    // only "it could not be published" has to go and read a migration to find
    // out which part was missing.
    return {
      ok: false,
      reason: activated.reason,
      detail: (activated.missing ?? []).join('; ') || undefined,
    }
  }
  return promoted
}

/**
 * Create a local canonical set and/or document, from anywhere.
 *
 * TWO CALLERS, ONE WRITE. promoteLocally() reaches it with a submission's
 * school; the admin catalog manager reaches it with a school the administrator
 * chose. Neither can produce an active row: `is_active: false` is spelled out
 * in both inserts below and is read from no argument.
 *
 * `origin` IS RECORDED, NOT INFERRED. A row that came from a student submission
 * and a row an administrator typed are different provenance, and the catalog
 * manager says which on screen. It is bookkeeping, never a permission.
 */
export function createLocalCanonicalEntry(input: {
  readonly schoolId: string
  readonly mode: unknown
  readonly setId: unknown
  readonly set: Row
  readonly requirement: Row
  readonly origin: 'promoted' | 'admin'
}): Outcome {
  if (input.mode !== 'new-set' && input.mode !== 'existing-set') {
    return { ok: false, reason: 'invalid-mode' }
  }
  if (typeof input.schoolId !== 'string' || input.schoolId.length === 0) {
    return { ok: false, reason: 'invalid-school' }
  }
  const submission = { school_id: input.schoolId } as Row

  const label = text(input.requirement.label)
  const promptText = text(input.requirement.prompt_text)
  const documentType = text(input.requirement.document_type)
  if (label === null) return { ok: false, reason: 'invalid-label' }
  if (promptText === null) return { ok: false, reason: 'invalid-prompt-text' }
  if (documentType === null
    || !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    return { ok: false, reason: 'invalid-document-type' }
  }

  /*
   * statement_requirement_sets_evidence_shape, APPLIED BEFORE ANYTHING IS
   * WRITTEN. 011 pairs the kind with its target: an official source carries no
   * submission id, and an approved submission must carry one. A local file has
   * no CHECK constraints, so a mismatched pair is refused here rather than
   * stored and discovered at activation.
   */
  const evidenceKind = text(input.set.evidence_kind) ?? 'official-source'
  if (evidenceKind !== 'official-source' && evidenceKind !== 'admin-approved-submission') {
    return { ok: false, reason: 'invalid-evidence-kind' }
  }
  const evidenceSubmissionId = text(input.set.evidence_submission_id)
  if (evidenceKind === 'official-source' && evidenceSubmissionId !== null) {
    return { ok: false, reason: 'invalid-evidence' }
  }
  if (evidenceKind === 'admin-approved-submission' && evidenceSubmissionId === null) {
    return { ok: false, reason: 'invalid-evidence' }
  }

  const stored = readAll()
  const schoolId = String(submission.school_id)
  const now = new Date().toISOString()

  // ---- the set: chosen or created, never guessed -------------------------
  let setId: string
  let created: 'set' | 'requirement'
  const sets = [...stored.sets]
  if (input.mode === 'existing-set') {
    const chosen = text(input.setId)
    if (chosen === null) return { ok: false, reason: 'set-required' }
    /*
     * IT MUST BE A LOCAL SET, AND THIS SCHOOL'S.
     *
     * THE SCHOOL CHECK is the same one the production function makes: a set id
     * from another school would file the document under a school nobody chose,
     * and the document carries its own school_id, so the two would disagree for
     * ever.
     *
     * THE LOCAL CHECK WAS MISSING, and it mattered. This used to fall back to
     * the imported payload when the id was not a local one, on the reasoning
     * that an administrator adding a document usually adds it to one of
     * production's 63. That produced dead data: the document landed in
     * dev-canonical.json with a production set_id, so it could never be
     * activated for preview -- activeLocalCanonical() only admits documents
     * whose SET is a local active one -- and it rendered nested under a
     * read-only row the manager had just said could not be edited. No
     * production write occurred; the result was simply unreachable.
     *
     * Attaching a local document to a production set is a production write, and
     * that is a design nobody has approved yet.
     */
    const localSet = sets.find((row) => row.id === chosen && row.school_id === schoolId)
    if (!localSet) return { ok: false, reason: 'set-not-found' }
    setId = chosen
    created = 'requirement'
  } else {
    setId = randomUUID()
    created = 'set'
    sets.push({
      id: setId,
      school_id: schoolId,
      application_cycle: text(input.set.application_cycle),
      verification_status: text(input.set.verification_status) ?? 'unverified',
      source_url: text(input.set.source_url),
      verified_on: text(input.set.verified_on),
      is_verbatim: bool(input.set.is_verbatim) ?? false,
      original_text: typeof input.set.original_text === 'string' ? input.set.original_text : '',
      /*
       * 20261008_011's TWO EVIDENCE COLUMNS.
       *
       * THESE WERE BEING DROPPED HERE, and it made "Approve and publish"
       * impossible locally: the handler supplied evidence_kind =
       * 'admin-approved-submission' on the set, this insert ignored it,
       * activationShortfall() then read the column's default
       * 'official-source', and refused the set for having no source URL --
       * which a student submission never has. The button reported "no source
       * URL (or an approved submission to publish on)" while an approved
       * submission was exactly what it had been given.
       *
       * DEFAULTED AS THE COLUMN IS, so a row that says nothing about its
       * evidence still has to carry a source URL. The pair is checked above,
       * because 011 refuses a mismatched one.
       */
      evidence_kind: evidenceKind,
      evidence_submission_id: evidenceSubmissionId,
      notes: list(input.set.notes),
      // ALWAYS FALSE, AND THE PAYLOAD CANNOT OVERRIDE IT. See the module header
      // and 20261015_017 (which replaced the withdrawn 009): creating catalog
      // data is not releasing it.
      is_active: false,
      display_order: int(input.set.display_order) ?? 0,
      created_at: now,
      updated_at: now,
      // Local bookkeeping, so the catalog manager can say where a row came from.
      local_origin: input.origin,
    })
  }

  // ---- the requirement ---------------------------------------------------
  const requirementId = randomUUID()
  const documents = [...stored.documents, {
    id: requirementId,
    set_id: setId,
    school_id: schoolId,
    document_type: documentType,
    label,
    prompt_text: promptText,
    components: list(input.requirement.components),
    min_words: int(input.requirement.min_words),
    max_words: int(input.requirement.max_words),
    min_characters: int(input.requirement.min_characters),
    max_characters: int(input.requirement.max_characters),
    characters_include_spaces: bool(input.requirement.characters_include_spaces),
    min_pages: dec(input.requirement.min_pages),
    max_pages: dec(input.requirement.max_pages),
    words_enforcement: text(input.requirement.words_enforcement),
    words_stated_as: text(input.requirement.words_stated_as),
    characters_enforcement: text(input.requirement.characters_enforcement),
    characters_stated_as: text(input.requirement.characters_stated_as),
    pages_enforcement: text(input.requirement.pages_enforcement),
    pages_stated_as: text(input.requirement.pages_stated_as),
    unenforced_length: text(input.requirement.unenforced_length),
    unenforced_length_verbatim: bool(input.requirement.unenforced_length_verbatim),
    page_spacing: text(input.requirement.page_spacing),
    font_size_pt: int(input.requirement.font_size_pt),
    font_family: text(input.requirement.font_family),
    margins_inches: dec(input.requirement.margins_inches),
    citation_style: text(input.requirement.citation_style),
    citation_family: text(input.requirement.citation_family),
    min_references: int(input.requirement.min_references),
    other_instructions: list(input.requirement.other_instructions),
    choice_group: text(input.requirement.choice_group),
    is_optional: bool(input.requirement.is_optional) ?? false,
    notes: list(input.requirement.notes),
    // ALWAYS FALSE. A requirement added to an already-active set would
    // otherwise be visible to every applicant the moment it was saved -- the
    // hazard 20261015_017's header describes.
    is_active: false,
    display_order: int(input.requirement.display_order) ?? 0,
    created_at: now,
    updated_at: now,
    local_origin: input.origin,
  }]

  // ONE WRITE, SO THERE IS NO PARTIAL STATE. The real function is one
  // transaction; here both collections are replaced in a single writeAll, and
  // every refusal above returned before this line.
  writeAll({ sets, documents })
  return { ok: true, setId, requirementId, created, isActive: false }
}


/**
 * What the catalog reader should add to the production payload.
 *
 * ONLY ACTIVE ROWS, which is the whole point: a promoted set is inactive, so
 * this returns nothing for it until somebody simulates activation. That is how
 * "nothing becomes applicant-visible by saving" is visible in the product
 * rather than only in a comment.
 */
export function activeLocalCanonical(): LocalCanonical {
  const stored = readAll()
  const sets = stored.sets.filter((set) => set.is_active === true)
  const ids = new Set(sets.map((set) => set.id))
  const documents = stored.documents.filter(
    (doc) => ids.has(doc.set_id) && doc.is_active === true)
  return { sets, documents }
}

/** Everything promoted locally, active or not, for the review screen. */
export function localCanonical(): LocalCanonical {
  return readAll()
}

/**
 * Record that one catalog row has been replaced by another.
 *
 * THE REPLACEMENT MUST ALREADY EXIST, and that is checked rather than assumed:
 * a supersession pointing at a row nobody created would remove the old prompt
 * and offer nothing in its place, which is worse than either outcome the
 * administrator was choosing between.
 *
 * NOT SELF, as statement_requirements_supersedes_not_self requires.
 *
 * IDEMPOTENT. Re-recording the same pair changes nothing, so a retried request
 * cannot produce two histories for one decision.
 */
export function recordLocalSupersession(input: {
  readonly requirementId: string
  readonly supersededBy: string
  readonly submissionId: string
  readonly reviewerId: string | null
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.requirementId.length === 0) return { ok: false, reason: 'invalid-superseded' }
  if (input.requirementId === input.supersededBy) return { ok: false, reason: 'supersedes-self' }
  const stored = readAll()
  if (!stored.documents.some((doc) => doc.id === input.supersededBy)) {
    return { ok: false, reason: 'replacement-not-found' }
  }
  const existing = readSupersessions()
  if (existing.some((row) => row.requirementId === input.requirementId
    && row.supersededBy === input.supersededBy)) {
    return { ok: true }
  }
  writeJsonStore(STORE, {
    ...stored,
    supersessions: [...existing, {
      requirementId: input.requirementId,
      supersededBy: input.supersededBy,
      submissionId: input.submissionId,
      reviewerId: input.reviewerId,
      at: new Date().toISOString(),
    }],
  })
  return { ok: true }
}

/** Every replacement recorded locally, for the admin screen's history. */
export function localSupersessions(): readonly LocalSupersession[] {
  return readSupersessions()
}

/**
 * The requirement ids the catalog reader must stop offering.
 *
 * ONLY WHERE THE REPLACEMENT IS ACTUALLY VISIBLE. A replacement that has been
 * created but not activated for preview would otherwise take the old prompt
 * away and show nothing -- the school would appear to have lost a document.
 * So a supersession takes effect exactly when its replacement is live, which is
 * also what applying 012 in production would produce: the old row is
 * deactivated in the same act that publishes the new one.
 */
export function supersededRequirementIds(): ReadonlySet<string> {
  const active = activeLocalCanonical()
  const live = new Set(active.documents.map((doc) => String(doc.id)))
  const out = new Set<string>()
  for (const row of readSupersessions()) {
    if (live.has(row.supersededBy)) out.add(row.requirementId)
  }
  return out
}

export function localCanonicalSetsForSchool(schoolId: string): Row[] {
  return readAll().sets.filter((set) => set.school_id === schoolId)
}

/**
 * Flip a locally promoted set on, so the applicant view can be inspected.
 *
 * A SECOND, EXPLICIT ACT, and local only. In production this is an owner action
 * against a reviewed row, and 20261002_005's active_needs_evidence constraint
 * refuses it unless the set is verified with a source and a date -- so the same
 * condition is enforced here rather than waved through, or the local preview
 * would show something production would refuse to publish.
 */
/**
 * The set and document behind a promoted requirement, as stored.
 *
 * THE RAW ROWS, so the editor can be reopened on exactly what is there rather
 * than on a summary of it. null for anything this file does not hold, which is
 * the production guard: the 63 imported sets are in the payload copy that
 * localCatalog.ts reads, and nothing here can see or reach them.
 */
export function localCanonicalEntryFor(requirementId: string): {
  readonly set: Row
  readonly requirement: Row
} | null {
  const stored = readAll()
  const requirement = stored.documents.find((doc) => doc.id === requirementId)
  if (requirement === undefined) return null
  const set = stored.sets.find((row) => row.id === requirement.set_id)
  if (set === undefined) return null
  return { set, requirement }
}

type EditOutcome =
  | { readonly ok: true; readonly setId: string; readonly requirementId: string }
  | { readonly ok: false; readonly reason: string; readonly detail?: string }

/**
 * Edit a canonical entry that has already been promoted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Promotion creates an inactive entry, and an administrator reviewing a
 * submission often does not yet have what activation requires: the programme
 * page URL, the date they checked it, the judgement that it is verified. Those
 * arrive afterwards. Without an edit path the only way to supply them is to
 * promote a different submission, which means the review of THIS school's
 * document is stuck behind finding another applicant.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT DO
 * ---------------------------------------------------------------------------
 * IT NEVER RAISES is_active. The current value is carried through untouched and
 * the payload cannot contain it: `is_active` is not read from either argument.
 * Saving an inactive entry leaves it inactive, which is the whole separation
 * between "reviewed" and "released".
 *
 * AND IT REFUSES AN EDIT THAT WOULD LEAVE AN ACTIVE SET WITHOUT ITS EVIDENCE,
 * because that is what production does. 20261002_005's constraint is
 * `is_active = false OR (verification_status = 'verified' AND source_url IS NOT
 * NULL AND verified_on IS NOT NULL)`, and it is checked on UPDATE as well as
 * INSERT -- so unverifying an active set is a constraint violation there. The
 * same refusal here means an administrator meets the real rule while editing
 * rather than discovering it at release.
 *
 * THE SUBMISSION IS NOT TOUCHED. Nothing in this function reads or writes
 * dev-submissions.json. The submission stays the historical record of what the
 * applicant sent; this is the reviewed version, and the two diverge on purpose.
 */
export function updateLocalCanonicalEntry(input: {
  readonly requirementId: string
  readonly set: Row
  readonly requirement: Row
}): EditOutcome {
  const stored = readAll()
  const docIndex = stored.documents.findIndex((doc) => doc.id === input.requirementId)
  if (docIndex < 0) return { ok: false, reason: 'not-found' }
  const existingDoc = stored.documents[docIndex]!
  const setIndex = stored.sets.findIndex((row) => row.id === existingDoc.set_id)
  if (setIndex < 0) return { ok: false, reason: 'not-found' }
  const existingSet = stored.sets[setIndex]!

  // THE THREE CANONICAL FIELDS THAT CANNOT BECOME ABSENT. Same checks the
  // promotion function applies, and for the same reason: an administrator gets
  // a word rather than a constraint violation.
  const label = text(input.requirement.label)
  const promptText = text(input.requirement.prompt_text)
  const documentType = text(input.requirement.document_type)
  if (label === null) return { ok: false, reason: 'invalid-label' }
  if (promptText === null) return { ok: false, reason: 'invalid-prompt-text' }
  if (documentType === null
    || !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    return { ok: false, reason: 'invalid-document-type' }
  }

  const now = new Date().toISOString()
  const nextSet: Row = {
    ...existingSet,
    application_cycle: text(input.set.application_cycle),
    verification_status: text(input.set.verification_status) ?? 'unverified',
    source_url: text(input.set.source_url),
    verified_on: text(input.set.verified_on),
    is_verbatim: bool(input.set.is_verbatim) ?? existingSet.is_verbatim ?? false,
    original_text: typeof input.set.original_text === 'string'
      ? input.set.original_text
      : existingSet.original_text ?? '',
    notes: list(input.set.notes),
    display_order: int(input.set.display_order) ?? int(existingSet.display_order) ?? 0,
    // CARRIED THROUGH, NEVER READ FROM THE PAYLOAD. See the header.
    is_active: existingSet.is_active === true,
    updated_at: now,
  }

  // THE PRODUCTION CONSTRAINT, ON UPDATE. An active set that would lose its
  // evidence is refused rather than silently switched off: deactivating is the
  // administrator's call, and doing it for them would hide a published
  // requirement without anybody deciding to.
  if (nextSet.is_active === true) {
    const missing = activationShortfall(nextSet)
    if (missing.length > 0) {
      return { ok: false, reason: 'active-needs-evidence', detail: missing.join('; ') }
    }
  }

  const sets = [...stored.sets]
  sets[setIndex] = nextSet

  const documents = [...stored.documents]
  documents[docIndex] = {
    ...existingDoc,
    document_type: documentType,
    label,
    prompt_text: promptText,
    components: list(input.requirement.components),
    min_words: int(input.requirement.min_words),
    max_words: int(input.requirement.max_words),
    min_characters: int(input.requirement.min_characters),
    max_characters: int(input.requirement.max_characters),
    characters_include_spaces: bool(input.requirement.characters_include_spaces),
    min_pages: dec(input.requirement.min_pages),
    max_pages: dec(input.requirement.max_pages),
    words_enforcement: text(input.requirement.words_enforcement),
    words_stated_as: text(input.requirement.words_stated_as),
    characters_enforcement: text(input.requirement.characters_enforcement),
    characters_stated_as: text(input.requirement.characters_stated_as),
    pages_enforcement: text(input.requirement.pages_enforcement),
    pages_stated_as: text(input.requirement.pages_stated_as),
    unenforced_length: text(input.requirement.unenforced_length),
    unenforced_length_verbatim: bool(input.requirement.unenforced_length_verbatim),
    page_spacing: text(input.requirement.page_spacing),
    font_size_pt: int(input.requirement.font_size_pt),
    font_family: text(input.requirement.font_family),
    margins_inches: dec(input.requirement.margins_inches),
    citation_style: text(input.requirement.citation_style),
    citation_family: text(input.requirement.citation_family),
    min_references: int(input.requirement.min_references),
    other_instructions: list(input.requirement.other_instructions),
    choice_group: text(input.requirement.choice_group),
    is_optional: bool(input.requirement.is_optional) ?? false,
    notes: list(input.requirement.notes),
    // THE DOCUMENT FOLLOWS ITS SET, and neither is raised here.
    is_active: existingDoc.is_active === true,
    display_order: int(input.requirement.display_order) ?? 0,
    updated_at: now,
  }

  writeAll({ sets, documents })
  return { ok: true, setId: String(nextSet.id), requirementId: input.requirementId }
}

/**
 * What a set still needs before it could be activated.
 *
 * THE SAME THREE THINGS 20261002_005 REQUIRES, named individually. Its
 * constraint is `is_active = false OR (verification_status = 'verified' AND
 * source_url IS NOT NULL AND verified_on IS NOT NULL)`, and a reviewer told
 * only "it does not qualify" has to go and read the migration to find out
 * which part. So each is reported separately, in the words the editor used.
 *
 * AN EMPTY LIST MEANS PRODUCTION WOULD ACCEPT IT. That is the whole value of
 * checking the real condition locally rather than waving it through: a local
 * preview of something production would refuse to publish is a preview of
 * nothing.
 */
export function activationShortfall(set: Row): string[] {
  const missing: string[] = []
  if (set.verification_status !== 'verified') {
    missing.push(`verification status is "${String(set.verification_status)}", not "verified"`)
  }
  if (typeof set.verified_on !== 'string' || set.verified_on.length === 0) {
    missing.push('no verified date')
  }
  /*
    EVIDENCE, OF EITHER KIND -- migration 011.

    005 recognised one kind: a URL on the school's own site. A student
    submission never has one, so an approved submission could be promoted and
    then never published, and "Approve" appeared to do nothing.

    011 adds a second kind and names it. The rule is not weakened: an active
    set still needs a verified status, a date, and something a person can point
    at. The something may now be an administrator's decision on one specific
    submission, recorded by id.

    THE DEFAULT IS THE OLD RULE, so a row that says nothing about its evidence
    is still required to carry a source URL.
  */
  const kind = typeof set.evidence_kind === 'string' ? set.evidence_kind : 'official-source'
  if (kind === 'admin-approved-submission') {
    const id = set.evidence_submission_id
    if (typeof id !== 'string' || id.length === 0) {
      missing.push('no approved submission to publish on')
    }
  } else if (typeof set.source_url !== 'string' || set.source_url.length === 0) {
    missing.push('no source URL (or an approved submission to publish on)')
  }
  return missing
}

/** How an active set came to be publishable. Shown, never inferred. */
export type EvidenceKind = 'official-source' | 'admin-approved-submission'

/**
 * What a reader is told about where a published prompt came from.
 *
 * THE TWO ARE NOT THE SAME CLAIM, and this is the only place that chooses
 * between them. A prompt checked against the school's own page and a prompt
 * taken on an applicant's word, both labelled "verified", would launder the
 * second into the first -- which is the whole thing 005's evidence rule exists
 * to prevent. Widening what counts as evidence is only safe if the difference
 * stays visible.
 */
export const EVIDENCE_LABELS: Readonly<Record<EvidenceKind, string>> = {
  'official-source': 'Verified against the school’s published materials.',
  'admin-approved-submission':
    'Published from an applicant’s submission, reviewed and approved by '
    + 'CRNAPREPHUB. Not checked against the school’s own published page.',
}

export function evidenceKindOf(set: Row): EvidenceKind {
  return set.evidence_kind === 'admin-approved-submission'
    ? 'admin-approved-submission'
    : 'official-source'
}

export interface LocalPreviewState {
  readonly setId: string
  readonly requirementId: string
  readonly isActive: boolean
  readonly qualifies: boolean
  readonly missing: readonly string[]
  readonly label: string
  readonly applicationCycle: string | null
}

/**
 * The local preview state of the set a promoted requirement belongs to.
 *
 * null FOR ANYTHING NOT IN THIS FILE, which is the production guard: the 63
 * imported sets live in the payload copy that localCatalog.ts reads, and
 * nothing here can see them. A requirement id from production resolves to
 * nothing and therefore cannot be activated, deactivated, or reported on.
 */
export function localPreviewFor(requirementId: string): LocalPreviewState | null {
  const stored = readAll()
  const document = stored.documents.find((doc) => doc.id === requirementId)
  if (document === undefined) return null
  const set = stored.sets.find((row) => row.id === document.set_id)
  if (set === undefined) return null
  const missing = activationShortfall(set)
  return {
    setId: String(set.id),
    requirementId,
    isActive: set.is_active === true,
    qualifies: missing.length === 0,
    missing,
    label: String(document.label ?? ''),
    applicationCycle: typeof set.application_cycle === 'string' ? set.application_cycle : null,
  }
}

type ActivationOutcome =
  | { readonly ok: true; readonly isActive: boolean }
  | { readonly ok: false; readonly reason: string; readonly missing?: readonly string[] }

/**
 * Turn a locally promoted set on, so the applicant view can be inspected.
 *
 * A SECOND, EXPLICIT ACT, and local only. In production this is an owner action
 * against a reviewed row; here it rewrites one field in one gitignored file.
 *
 * IT CANNOT REACH A PRODUCTION SET. The lookup is in this file's own sets, and
 * production's 63 are not in it -- so a production set id is 'not-found' rather
 * than activated. There is no code path from here to the database at all: this
 * module imports node:fs and nothing else.
 *
 * AND IT ENFORCES PRODUCTION'S OWN CONDITION. 20261002_005 refuses an active
 * set that is not verified with a source and a date; refusing it here too means
 * the local preview can only ever show something production would also publish.
 */
export function simulateActivation(setId: string): ActivationOutcome {
  return setActive(setId, true)
}

/**
 * Turn it back off.
 *
 * NO CONDITION ON DEACTIVATING. Withdrawing something from view is always safe,
 * and 20261002_005's constraint is satisfied by `is_active = false` whatever
 * else the row says -- which is why a half-filled set can be switched off but
 * not on.
 */
export function simulateDeactivation(setId: string): ActivationOutcome {
  return setActive(setId, false)
}

function setActive(setId: string, active: boolean): ActivationOutcome {
  const stored = readAll()
  const index = stored.sets.findIndex((set) => set.id === setId)
  if (index < 0) return { ok: false, reason: 'not-found' }
  const set = stored.sets[index]!

  if (active) {
    const missing = activationShortfall(set)
    if (missing.length > 0) return { ok: false, reason: 'needs-evidence', missing }
  }

  const sets = [...stored.sets]
  sets[index] = { ...set, is_active: active, updated_at: new Date().toISOString() }
  // THE DOCUMENTS FOLLOW THEIR SET. The select policy on
  // statement_requirements admits a row whose set is active AND which is itself
  // active, so leaving the documents off would activate a set with nothing in
  // it -- a school that appears in the picker and then offers no requirement.
  const documents = stored.documents.map(
    (doc) => (doc.set_id === setId ? { ...doc, is_active: active } : doc))
  writeAll({ sets, documents })
  return { ok: true, isActive: active }
}

export function resetLocalCanonical(): void {
  // writeAll() preserves the overlay by design, so a reset writes the file
  // directly: "start again" has to mean the replacements too, or a cleared
  // store would keep hiding rows whose replacements no longer exist.
  writeJsonStore(STORE, { sets: [], documents: [], supersessions: [] })
}
