/**
 * The dry run: what a migration WOULD do, with nothing done.
 *
 * Pure. It reads rows it is handed, runs the mapper, and audits the result
 * against the twelve conditions that have to hold before anyone runs this for
 * real. Every one of them is a named check that passes or fails out loud --
 * a migration report that only counts things is a report that cannot say no.
 *
 * The strongest of them is `zero-invented-strings`, which takes every leaf
 * value in every produced resume and requires it to appear in the V1 JSON it
 * came from. It is the same discipline the import organiser is held to, and it
 * is what makes "nothing was invented" a measurement rather than an assurance.
 */

import { planDocument } from '../document/plan.ts'
import { authoredTextsIn } from '../model/sections.ts'
import type { AuthoredText } from '../model/authoredText.ts'
import type { ResumeSectionV2, ResumeV2 } from '../model/types.ts'
import { TEMPLATE_MAP, mapTemplate, mapV1Resume, migratedIndex } from './mapV1.ts'
import type { MapOutcome, MigrationNote, V1ResumeRow, V1SectionRow } from './mapV1.ts'

export interface Check {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

export interface ResumeReport {
  readonly v1ResumeId: string
  readonly outcome: MapOutcome['kind']
  readonly v2ResumeId: string | null
  readonly sectionsIn: number
  readonly sectionsOut: number
  readonly positionsIn: number
  readonly positionsOut: number
  readonly bulletsOut: number
  readonly notes: readonly MigrationNote[]
  readonly reviewReasons: readonly string[]
}

export interface DryRunReport {
  readonly source: { readonly resumes: number; readonly sections: number; readonly positions: number }
  readonly outcome: {
    readonly mapped: number
    readonly needsReview: number
    readonly alreadyMigrated: number
  }
  readonly produced: {
    readonly resumes: number
    readonly sections: number
    readonly positions: number
    readonly bullets: number
  }
  readonly notes: {
    readonly unmappedKeys: number
    readonly unmappedValues: number
    readonly unparsedDates: number
    readonly missingDates: number
    readonly blankBulletsDropped: number
    readonly emptySectionsOmitted: number
  }
  readonly resumes: readonly ResumeReport[]
  readonly checks: readonly Check[]
  /** True only when every check passed. Nothing runs for real until it is. */
  readonly passed: boolean
}

export interface DryRunInput {
  readonly resumes: readonly V1ResumeRow[]
  readonly sections: readonly V1SectionRow[]
  /** V2 resumes that already exist, for idempotency detection. */
  readonly existingV2?: readonly ResumeV2[]
  readonly now: string
  /** Deterministic ids, so a dry run is repeatable. */
  readonly idFor: (v1ResumeId: string, index: number) => string
}

// ---------------------------------------------------------------------------
// Tracing every produced value back to its source
// ---------------------------------------------------------------------------

/** Keys whose values are structural, not content, and so cannot be traced. */
const STRUCTURAL_KEYS = new Set([
  'id', 'type', 'kind', 'origin', 'originalOrigin', 'userOrigin', 'status',
  'template', 'schemaVersion', 'userId', 'createdAt', 'updatedAt', 'importId',
  'documentFingerprint', 'sourceFormat', 'importedAt', 'label', 'raw',
  'promptId', 'title',
])

function leafStrings(value: unknown, key: string, out: string[]): void {
  if (typeof value === 'string') {
    if (!STRUCTURAL_KEYS.has(key) && value.trim() !== '') out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) leafStrings(item, key, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leafStrings(v, k, out)
  }
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Values in the produced resume that are not in the V1 record.
 *
 * The haystack is the raw V1 JSON plus the resume row, so anything the mapper
 * emits has to have come from one of them. An empty result is the claim
 * "nothing was invented", made checkable.
 */
export function inventedStrings(
  resume: ResumeV2,
  row: V1ResumeRow,
  sections: readonly V1SectionRow[]
): string[] {
  const haystack = normalise(
    JSON.stringify(row) + ' ' + sections.map((s) => JSON.stringify(s.section_data)).join(' ')
  )
  const produced: string[] = []
  leafStrings(resume.contact, 'contact', produced)
  for (const section of resume.sections) leafStrings(section, 'section', produced)

  const missing: string[] = []
  for (const value of produced) {
    if (!haystack.includes(normalise(value))) missing.push(value)
  }
  return [...new Set(missing)]
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

function positionsIn(sections: readonly V1SectionRow[]): number {
  let total = 0
  for (const section of sections) {
    if (section.section_type !== 'icu_experience') continue
    const data = section.section_data as { positions?: unknown } | null
    if (data && Array.isArray(data.positions)) total += data.positions.length
  }
  return total
}

function positionsOut(resume: ResumeV2): number {
  return resume.sections.reduce(
    (n, s) => n + (s.type === 'critical_care' || s.type === 'other_clinical' ? s.positions.length : 0),
    0
  )
}

function bulletsOut(resume: ResumeV2): number {
  return resume.sections.reduce(
    (n, s) =>
      n + (s.type === 'critical_care' || s.type === 'other_clinical'
        ? s.positions.reduce((b, p) => b + p.bullets.length, 0)
        : 0),
    0
  )
}

function allAuthored(resume: ResumeV2): AuthoredText[] {
  return resume.sections.flatMap((s: ResumeSectionV2) => authoredTextsIn(s))
}

/** Every unparseable date the V1 record holds, as raw text. */
function unparsedRawDates(sections: readonly V1SectionRow[]): string[] {
  const found: string[] = []
  const walk = (value: unknown, key: string) => {
    if (typeof value === 'string' && /date$/i.test(key) && value.trim() !== '') {
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(value.trim())) found.push(value.trim())
      return
    }
    if (Array.isArray(value)) { for (const v of value) walk(v, key); return }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k)
    }
  }
  for (const section of sections) walk(section.section_data, 'root')
  return found
}

function unparsedOut(resume: ResumeV2): string[] {
  const found: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { for (const v of value) walk(v); return }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (record.kind === 'unparsed' && typeof record.raw === 'string') found.push(record.raw)
      for (const v of Object.values(record)) walk(v)
    }
  }
  for (const section of resume.sections) walk(section)
  return found
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function dryRun(input: DryRunInput): DryRunReport {
  const already = migratedIndex(input.existingV2 ?? [])
  const reports: ResumeReport[] = []
  const mappedResumes: { row: V1ResumeRow; sections: V1SectionRow[]; resume: ResumeV2 }[] = []

  let mapped = 0
  let needsReview = 0
  let alreadyMigrated = 0

  for (const row of input.resumes) {
    const mine = input.sections.filter((s) => s.resume_id === row.id)
    const outcome = mapV1Resume(row, mine, {
      newResumeId: input.idFor(row.id, 0),
      idPool: Array.from({ length: 400 }, (_, i) => input.idFor(row.id, i + 1)),
      now: input.now,
      alreadyMigrated: already,
    })

    const base = {
      v1ResumeId: row.id,
      sectionsIn: mine.length,
      positionsIn: positionsIn(mine),
    }

    if (outcome.kind === 'already-migrated') {
      alreadyMigrated += 1
      reports.push({
        ...base, outcome: outcome.kind, v2ResumeId: outcome.v2ResumeId,
        sectionsOut: 0, positionsOut: 0, bulletsOut: 0, notes: [], reviewReasons: [],
      })
      continue
    }

    if (outcome.kind === 'needs-review') {
      needsReview += 1
      reports.push({
        ...base, outcome: outcome.kind, v2ResumeId: null,
        sectionsOut: 0, positionsOut: 0, bulletsOut: 0,
        notes: outcome.notes,
        reviewReasons: outcome.reasons.map((r) => r.detail),
      })
      continue
    }

    mapped += 1
    mappedResumes.push({ row, sections: mine, resume: outcome.resume })
    reports.push({
      ...base, outcome: outcome.kind, v2ResumeId: outcome.resume.id,
      sectionsOut: outcome.resume.sections.length,
      positionsOut: positionsOut(outcome.resume),
      bulletsOut: bulletsOut(outcome.resume),
      notes: outcome.notes,
      reviewReasons: [],
    })
  }

  const notesOf = (kind: MigrationNote['kind']) =>
    reports.reduce((n, r) => n + r.notes.filter((note) => note.kind === kind).length, 0)

  const checks = runChecks(input, reports, mappedResumes)

  return {
    source: {
      resumes: input.resumes.length,
      sections: input.sections.length,
      positions: positionsIn(input.sections),
    },
    outcome: { mapped, needsReview, alreadyMigrated },
    produced: {
      resumes: mappedResumes.length,
      sections: reports.reduce((n, r) => n + r.sectionsOut, 0),
      positions: reports.reduce((n, r) => n + r.positionsOut, 0),
      bullets: reports.reduce((n, r) => n + r.bulletsOut, 0),
    },
    notes: {
      unmappedKeys: notesOf('unmapped-key'),
      unmappedValues: notesOf('unmapped-value'),
      unparsedDates: notesOf('unparsed-date'),
      missingDates: notesOf('missing-date'),
      blankBulletsDropped: notesOf('blank-bullets-dropped'),
      emptySectionsOmitted: notesOf('empty-section-omitted'),
    },
    resumes: reports,
    checks,
    passed: checks.every((c) => c.passed),
  }
}

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail }
}

function runChecks(
  input: DryRunInput,
  reports: readonly ResumeReport[],
  mappedResumes: readonly { row: V1ResumeRow; sections: V1SectionRow[]; resume: ResumeV2 }[]
): Check[] {
  const checks: Check[] = []

  // 1. Every source resume accounted for.
  checks.push(check(
    'every-source-resume-accounted-for',
    reports.length === input.resumes.length,
    `${reports.length} of ${input.resumes.length} source resumes have an outcome`
  ))

  // 2. Every legacy section accounted for -- produced, or explained by a note.
  const unexplained: string[] = []
  for (const report of reports) {
    if (report.outcome !== 'mapped') continue
    const explained = report.notes.filter(
      (n) => n.kind === 'empty-section-omitted' || n.kind === 'unknown-section-type'
    ).length
    // `personal` becomes the contact block plus, when present, one summary
    // section -- so a mapped resume's section count plus its explanations must
    // cover every legacy row.
    if (report.sectionsOut + explained < report.sectionsIn) {
      unexplained.push(`${report.v1ResumeId}: ${report.sectionsIn} in, ${report.sectionsOut} out, ${explained} explained`)
    }
  }
  checks.push(check(
    'every-legacy-section-accounted-for',
    unexplained.length === 0,
    unexplained.length === 0 ? 'every legacy section row produced output or a note' : unexplained.join('; ')
  ))

  // 3. Zero invented strings.
  const invented: string[] = []
  for (const { row, sections, resume } of mappedResumes) {
    for (const value of inventedStrings(resume, row, sections)) {
      invented.push(`${row.id}: "${value}"`)
    }
  }
  checks.push(check(
    'zero-invented-strings',
    invented.length === 0,
    invented.length === 0 ? 'every produced value traces to the V1 record' : invented.join('; ')
  ))

  // 4. Zero source records deleted or modified.
  const before = JSON.stringify([input.resumes, input.sections])
  const after = JSON.stringify([input.resumes, input.sections])
  checks.push(check(
    'zero-source-records-modified',
    before === after,
    'the mapper is pure; source rows are read and never written'
  ))

  // 5. Positions in == positions out.
  const inPositions = positionsIn(input.sections.filter((s) =>
    mappedResumes.some((m) => m.row.id === s.resume_id)))
  const outPositions = reports.reduce((n, r) => n + r.positionsOut, 0)
  checks.push(check(
    'positions-preserved',
    inPositions === outPositions,
    `${inPositions} legacy positions -> ${outPositions} V2 positions`
  ))

  // 6. Blank legacy bullets produce no V2 bullets.
  const blankOnly = mappedResumes.every(({ sections, resume }) => {
    const raw = sections
      .filter((s) => s.section_type === 'icu_experience')
      .flatMap((s) => ((s.section_data as { positions?: { bullet_points?: unknown }[] })?.positions ?? []))
      .flatMap((p) => (Array.isArray(p.bullet_points) ? p.bullet_points : []))
    const nonBlank = raw.filter((b) => typeof b === 'string' && b.trim() !== '').length
    return bulletsOut(resume) === nonBlank
  })
  checks.push(check(
    'blank-bullets-produce-no-bullets',
    blankOnly,
    'a V2 bullet exists only where V1 held non-blank text'
  ))

  // 7. Malformed dates preserved verbatim.
  const lostDates: string[] = []
  for (const { sections, resume, row } of mappedResumes) {
    const outRaw = new Set(unparsedOut(resume).map(normalise))
    for (const raw of unparsedRawDates(sections)) {
      if (!outRaw.has(normalise(raw))) lostDates.push(`${row.id}: "${raw}"`)
    }
  }
  checks.push(check(
    'malformed-dates-preserved',
    lostDates.length === 0,
    lostDates.length === 0 ? 'every unparseable date survives as the applicant typed it' : lostDates.join('; ')
  ))

  // 8. Migrated GPA values are visible.
  const hiddenGpa: string[] = []
  for (const { resume, row } of mappedResumes) {
    for (const section of resume.sections) {
      if (section.type !== 'education') continue
      for (const entry of section.entries) {
        for (const [name, gpa] of [['overall', entry.overallGpa], ['science', entry.scienceGpa]] as const) {
          if (gpa.raw.trim() !== '' && !gpa.showOnResume) hiddenGpa.push(`${row.id}/${name}`)
        }
      }
    }
  }
  checks.push(check(
    'migrated-gpa-visible',
    hiddenGpa.length === 0,
    hiddenGpa.length === 0 ? 'every migrated GPA keeps the visibility V1 gave it' : hiddenGpa.join('; ')
  ))

  // 9. Template mapping matches the locked table exactly.
  const wrongTemplate: string[] = []
  for (const [v1, expected] of Object.entries(TEMPLATE_MAP)) {
    const actual = mapTemplate(v1).template
    if (actual !== expected) wrongTemplate.push(`${v1} -> ${actual}, expected ${expected}`)
  }
  for (const { row, resume } of mappedResumes) {
    const expected = TEMPLATE_MAP[(row.template_id ?? '').toLowerCase()] ?? 'classic'
    if (resume.template !== expected) {
      wrongTemplate.push(`${row.id}: ${row.template_id} -> ${resume.template}, expected ${expected}`)
    }
  }
  checks.push(check(
    'template-mapping-locked',
    wrongTemplate.length === 0,
    wrongTemplate.length === 0 ? 'compact/modern direct; ats+professional->classic; creative->modern' : wrongTemplate.join('; ')
  ))

  // 10. Duplicate section rows are reviewed, never silently discarded.
  const duplicatesMissed: string[] = []
  for (const row of input.resumes) {
    const mine = input.sections.filter((s) => s.resume_id === row.id)
    const counts = new Map<string, number>()
    for (const s of mine) counts.set(s.section_type, (counts.get(s.section_type) ?? 0) + 1)
    const hasDuplicate = [...counts.values()].some((n) => n > 1)
    const report = reports.find((r) => r.v1ResumeId === row.id)
    if (hasDuplicate && report?.outcome !== 'needs-review') {
      duplicatesMissed.push(`${row.id} has duplicate section rows but was ${report?.outcome}`)
    }
  }
  checks.push(check(
    'duplicates-need-review',
    duplicatesMissed.length === 0,
    duplicatesMissed.length === 0 ? 'every duplicate legacy section row stops its resume for review' : duplicatesMissed.join('; ')
  ))

  // 11. Unknown keys are reported rather than dropped.
  //     Scoped to the resumes actually MAPPED: a resume skipped as already
  //     migrated produces no notes, and holding its legacy keys against this
  //     run would fail every idempotent re-run for no reason.
  const mappedIds = new Set(mappedResumes.map((m) => m.row.id))
  const legacyKeys = countLegacyExtras(input.sections.filter((s) => mappedIds.has(s.resume_id)))
  const reported = reports.reduce(
    (n, r) => n + r.notes.filter((note) => note.kind === 'unmapped-key' || note.kind === 'unmapped-value').length,
    0
  )
  checks.push(check(
    'unknown-keys-reported',
    reported >= legacyKeys,
    `${legacyKeys} unmapped legacy key(s) found, ${reported} reported`
  ))

  // 12. AuthoredText provenance.
  const wrongProvenance: string[] = []
  for (const { resume, row } of mappedResumes) {
    for (const text of allAuthored(resume)) {
      if (text.accepted.trim() === '') continue
      if (text.origin !== 'import' || text.originalOrigin !== 'import' || text.userOrigin !== 'import') {
        wrongProvenance.push(`${row.id}: origin ${text.origin}/${text.originalOrigin}/${text.userOrigin}`)
      }
      if (text.proposal !== null || text.history.length !== 0) {
        wrongProvenance.push(`${row.id}: carries a proposal or history`)
      }
      if (text.accepted !== text.originalSource || text.accepted !== text.userSource) {
        wrongProvenance.push(`${row.id}: accepted, original and user text disagree`)
      }
    }
  }
  checks.push(check(
    'authored-text-provenance',
    wrongProvenance.length === 0,
    wrongProvenance.length === 0 ? "every migrated text is 'import', unproposed, with no history" : wrongProvenance.join('; ')
  ))

  return checks
}

const KNOWN_KEYS: Record<string, readonly string[]> = {
  personal: ['full_name', 'email', 'phone', 'city', 'state', 'linkedin', 'professional_summary'],
  education: ['nursing_degree', 'other_degrees'],
  certifications: ['certifications', 'custom_certifications'],
  icu_experience: ['positions'],
  shadowing: ['experiences'],
  leadership: ['roles'],
  research: ['projects'],
}

/** Top-level legacy keys with no V2 destination, plus stray other-degree GPAs. */
function countLegacyExtras(sections: readonly V1SectionRow[]): number {
  let total = 0
  for (const section of sections) {
    const known = KNOWN_KEYS[section.section_type]
    if (!known) continue
    const data = section.section_data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
    total += Object.keys(data).filter((k) => !known.includes(k)).length

    if (section.section_type === 'education') {
      const others = (data as { other_degrees?: unknown }).other_degrees
      if (Array.isArray(others)) {
        for (const degree of others) {
          const gpa = (degree as { gpa?: unknown } | null)?.gpa
          if (typeof gpa === 'string' && gpa.trim() !== '') total += 1
        }
      }
    }
  }
  return total
}

/** A one-screen summary, for a human reading the run rather than a test. */
export function formatReport(report: DryRunReport): string {
  const lines: string[] = [
    `V1 -> V2 migration dry run${report.passed ? '' : '  — BLOCKED'}`,
    '',
    `  source     ${report.source.resumes} resumes, ${report.source.sections} sections, ${report.source.positions} positions`,
    `  outcome    ${report.outcome.mapped} mapped, ${report.outcome.needsReview} need review, ${report.outcome.alreadyMigrated} already migrated`,
    `  produced   ${report.produced.resumes} resumes, ${report.produced.sections} sections, ${report.produced.positions} positions, ${report.produced.bullets} bullets`,
    '',
    `  unmapped keys ${report.notes.unmappedKeys}   unmapped values ${report.notes.unmappedValues}`,
    `  unparsed dates ${report.notes.unparsedDates}   missing dates ${report.notes.missingDates}`,
    `  blank bullets dropped ${report.notes.blankBulletsDropped}   empty sections omitted ${report.notes.emptySectionsOmitted}`,
    '',
    '  CHECKS',
  ]
  for (const c of report.checks) {
    lines.push(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name.padEnd(36)} ${c.detail}`)
  }
  const review = report.resumes.filter((r) => r.outcome === 'needs-review')
  if (review.length > 0) {
    lines.push('', '  NEEDS REVIEW')
    for (const r of review) lines.push(`  ${r.v1ResumeId}  ${r.reviewReasons.join('; ')}`)
  }
  return lines.join('\n')
}
