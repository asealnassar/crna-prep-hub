/**
 * QA-005: the dialog and the editor must mean the same thing by a requirement.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG, AND WHY A UNIT TEST WOULD NOT HAVE CAUGHT IT
 * ---------------------------------------------------------------------------
 * /api/statement/requirements sends the canonical model. The New Draft dialog
 * revalidated it by flattening it back into column names and calling the row
 * parser -- and that flattening was a SECOND, hand-written list of columns.
 * It was eleven short: every enforcement register, every `*_stated_as`, both
 * `unenforced_length` columns, the format profile and the two font option
 * sets.
 *
 * So the dialog read every register as 'enforced'. Albany Medical College's
 * advisory "500 words" became "500 words maximum" on the screen an applicant
 * reads BEFORE choosing what to write, while the editor -- fed by the server
 * -- called the same figure a stated length. Both parsers were individually
 * correct; the drift between them was the defect, and nothing that tested
 * either one alone could see it.
 *
 * THIS FILE TESTS THE SEAM, over every document actually served.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CONSTRAINT_COLUMNS, columnsFromConstraints, requirementFromRow } from './repo.ts'
import { requirementStepFrom } from './newDraftFlow.ts'
import { loadLocalReviewCatalog } from './localReviewCatalog.ts'
import { activatableForApplicants } from './verification.ts'
import {
  constraintSummary, labelledConstraints, statedWordings, truncationNotice,
  unenforcedLengthIsVerbatim, unenforcedLengthNotice,
} from './constraintText.ts'
import { liveCounts } from './constraints.ts'

const CATALOG = loadLocalReviewCatalog()
const LIVE = (CATALOG?.sets ?? []).filter((s) => activatableForApplicants(s.verification))

test('the catalog loaded, so nothing below passes vacuously', () => {
  assert.ok(CATALOG !== null)
  assert.equal(LIVE.length, 62, `${LIVE.length} served sets, expected 62`)
  const docs = LIVE.reduce((n, s) => n + s.requirements.length, 0)
  assert.equal(docs, 79, `${docs} served documents, expected 79`)
})

test('QA-005 the adapter covers every column the reader reads', () => {
  /*
   * SOURCE-DERIVED, so a column the reader learns tomorrow fails here rather
   * than silently reaching an applicant as a default. constraintsFromRow and
   * its inverse live in the same file precisely so this stays true.
   */
  const repo = readFileSync(fileURLToPath(new URL('./repo.ts', import.meta.url)), 'utf8')
  const start = repo.indexOf('function constraintsFromRow')
  const end = repo.indexOf('export function columnsFromConstraints')
  assert.ok(start > 0 && end > start)
  const read = new Set(
    [...repo.slice(start, end).matchAll(/row\.([a-z_]+)/g)].map((m) => m[1]!))
  const covered = new Set(CONSTRAINT_COLUMNS)
  for (const column of read) {
    assert.ok(covered.has(column),
      `constraintsFromRow reads ${column}, columnsFromConstraints does not carry it`)
  }
  assert.ok(read.size >= 24, `only ${read.size} columns found; the scan is wrong`)
})

/** Everything an applicant can SEE about one requirement's constraints. */
const visible = (c: Parameters<typeof labelledConstraints>[0]) => ({
  chips: labelledConstraints(c).map((x) => ({ kind: x.kind, text: x.text, register: x.register })),
  summary: constraintSummary(c),
  wordings: [...statedWordings(c)],
  truncation: truncationNotice(c),
  unenforced: unenforcedLengthNotice(c),
  unenforcedVerbatim: unenforcedLengthIsVerbatim(c),
  counts: [...liveCounts(c)],
})

test('QA-005 every served document survives the wire round trip unchanged', () => {
  /*
   * THE EXHAUSTIVE PARITY TEST. For each document: take the model the server
   * would send, push it through the dialog's own parse, and compare what the
   * two would SHOW -- not just the fields, but every applicant-visible
   * derivation of them.
   */
  let checked = 0
  const mismatches: string[] = []
  for (const set of LIVE) {
    const body = {
      sets: [{
        id: set.id,
        applicationCycle: set.applicationCycle,
        verification: set.verification,
        originalText: set.originalText,
        notes: set.notes,
        requirements: set.requirements,
      }],
    }
    const step = requirementStepFrom({
      status: 200, body, schoolId: set.schoolId, schoolName: set.schoolName,
    })
    assert.equal(step.kind, 'ready', `${set.schoolName}: the dialog dropped the whole set`)
    const viaDialog = step.kind === 'ready' ? step.sets[0]!.requirements : []
    assert.equal(viaDialog.length, set.requirements.length, `${set.schoolName}: lost a document`)

    for (const [i, server] of set.requirements.entries()) {
      const dialog = viaDialog[i]!
      checked += 1
      const a = JSON.stringify(visible(server.constraints))
      const b = JSON.stringify(visible(dialog.constraints))
      if (a !== b) mismatches.push(`${set.schoolName} / ${server.label}\n  server: ${a}\n  dialog: ${b}`)
      // AND THE RAW MODEL TOO, so a field nothing renders yet cannot be lost
      // quietly and surface as a defect the next time something reads it.
      assert.deepEqual(dialog.constraints, server.constraints,
        `${set.schoolName} / ${server.label}: constraints differ`)
    }
  }
  assert.equal(mismatches.length, 0, `\n${mismatches.join('\n')}`)
  assert.equal(checked, 79, `${checked} documents compared, expected 79`)
})

test('QA-005 the register specifically survives, for every shape', () => {
  // The field whose loss produced the defect, asserted on its own so a
  // regression names itself.
  const registers = new Map<string, number>()
  for (const set of LIVE) {
    for (const r of set.requirements) {
      const row = columnsFromConstraints(r.constraints)
      const back = requirementFromRow({
        id: r.id, label: r.label, prompt_text: r.promptText,
        document_type: r.documentType, components: r.components,
        choice_group: r.choiceGroup, is_optional: r.optional,
        notes: r.notes, display_order: r.displayOrder, ...row,
      })
      assert.ok(back !== null, `${set.schoolName} / ${r.label} failed to reparse`)
      for (const key of ['words', 'characters', 'pages'] as const) {
        const before = r.constraints[key]
        const after = back.constraints[key]
        assert.equal(after?.enforcement ?? null, before?.enforcement ?? null,
          `${set.schoolName} / ${r.label}: ${key} register changed`)
        assert.equal(after?.statedAs ?? null, before?.statedAs ?? null,
          `${set.schoolName} / ${r.label}: ${key} statedAs changed`)
        if (before?.enforcement) {
          registers.set(before.enforcement, (registers.get(before.enforcement) ?? 0) + 1)
        }
      }
      assert.equal(back.constraints.formatProfile, r.constraints.formatProfile,
        `${set.schoolName} / ${r.label}: format profile changed`)
      assert.deepEqual(back.constraints.unenforcedLength, r.constraints.unenforcedLength,
        `${set.schoolName} / ${r.label}: unenforced length changed`)
    }
  }
  // MORE THAN ONE REGISTER IS PRESENT, or this test proves nothing: if every
  // document were 'enforced', losing the column would look identical to
  // keeping it.
  assert.ok(registers.size >= 2, `only registers ${[...registers.keys()]} appear`)
  assert.ok((registers.get('target') ?? 0) > 0, 'no target register in the catalog')
})

test('QA-005 a target length is NEVER called a maximum, on either path', () => {
  for (const set of LIVE) {
    const step = requirementStepFrom({
      status: 200,
      body: { sets: [{ id: set.id, applicationCycle: set.applicationCycle,
        verification: set.verification, originalText: set.originalText,
        notes: set.notes, requirements: set.requirements }] },
      schoolId: set.schoolId, schoolName: set.schoolName,
    })
    const viaDialog = step.kind === 'ready' ? step.sets[0]!.requirements : []
    for (const [i, r] of viaDialog.entries()) {
      for (const key of ['words', 'characters', 'pages'] as const) {
        /*
          GATED ON THE SERVER'S REGISTER, CHECKED ON THE DIALOG'S CHIP.

          Gating on the dialog's own register made this test blind to the only
          failure it exists for: lose the column and the dialog reads
          'enforced', so the loop skipped the document and the assertion never
          ran. A mutation that dropped words_enforcement passed it. The
          authority for "is this a target" is the server's model.
        */
        const bound = set.requirements[i]!.constraints[key]
        if (bound?.enforcement !== 'target' && bound?.enforcement !== 'suggested') continue
        for (const chip of labelledConstraints(r.constraints)) {
          if (chip.kind !== key) continue
          /*
            THE RULE, NOT A WORD BAN. The correct wording for a target is
            "500 words (the stated length, not a maximum)", which CONTAINS
            "maximum" -- a ban on the word fails the very sentence it is meant
            to protect. What must never appear is the ASSERTIVE form: a figure
            followed by "maximum" or "limit" with nothing qualifying it.
          */
          assert.doesNotMatch(chip.text, /^[^(]*\b(maximum|limit)\s*$/,
            `${set.schoolName} / ${r.label}: "${chip.text}" asserts a ${key} limit `
            + `for a ${bound.enforcement} bound`)
          // AND THE REGISTER IS SAID OUT LOUD, so an applicant can see which
          // kind of figure they are looking at.
          assert.match(chip.text, /the stated length|suggested|without saying whether/,
            `${set.schoolName} / ${r.label}: "${chip.text}" names no register`)
        }
      }
    }
  }
})
