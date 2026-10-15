/**
 * Migrations 010 and 014 reach an applicant only through their capability
 * flags. This file pins all three rollout states against the REAL catalog.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REAL CATALOG AND NOT A FIXTURE
 * ---------------------------------------------------------------------------
 * schemaCapability.test.ts already pins the contract on synthetic rows: the
 * select list is a function of the flags, the parser degrades to absence
 * rather than to a claim, and anything but the exact string 'on' is off.
 *
 * What that cannot show is whether the DATA those migrations exist for
 * actually arrives. Three documents in the catalog are the whole reason 010
 * and 014 were written, and each is a different outcome:
 *
 *   Southern Mississippi  the one school that PERMITS A CHOICE of typeface.
 *                         Its arrays are not in the payload at all -- they
 *                         are written by a separate targeted correction -- so
 *                         this file reads them out of that SQL file, and a
 *                         change to the correction fails here.
 *   Cedar Crest,          a named standard that governs the WHOLE document.
 *   New Mexico State      014's column, set by the 28-document package.
 *   Keiser                a citation instruction that is NOT a whole-document
 *                         profile. It must stay absent in every state, or 014
 *                         would be asserting a layout the school never asked
 *                         for.
 *
 * ---------------------------------------------------------------------------
 * THE PROJECTION IS PART OF THE TEST
 * ---------------------------------------------------------------------------
 * A row is not parsed as stored; it is parsed as SELECTED. `project()` below
 * drops every column the live select list would not have asked for, so state
 * B -- migration applied, capability off -- is tested as it will really be:
 * the columns exist in the table and the query never mentions them.
 *
 * Leaving the projection out is what made the original bug invisible. The
 * parser read these columns "if they arrive" and nothing ever asked for them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REQUIREMENT_READ_COLUMNS, requirementFromRow } from './repo.ts'
import {
  FORMAT_PROFILE_ENV, TYPOGRAPHY_OPTIONS_ENV,
} from '../draft/rollout.ts'

const OPTION_COLUMNS = ['font_family_options', 'font_size_pt_options'] as const
const PROFILE_COLUMN = 'document_format_profile'

type Row = Record<string, unknown>

const PAYLOAD = path.join(
  process.cwd(), 'local-review', 'statement_requirements_catalog.json')
const SM_SQL = path.join(
  process.cwd(), 'supabase', 'manual',
  'statement_southern_mississippi_typography_options.sql')

interface Payload {
  readonly sets: readonly Row[]
  readonly documents: readonly Row[]
}

function payload(): Payload | null {
  try {
    return JSON.parse(readFileSync(PAYLOAD, 'utf8')) as Payload
  } catch {
    return null
  }
}

const CATALOG = payload()

/**
 * The select list the live read would send, for this env.
 *
 * THIS, NOT THE PROJECTED ROW, IS THE CONTRACT WITH POSTGREST. A projection
 * test can pass for the wrong reason -- the payload simply has no
 * font_family_options key, so a widened select list still delivers nothing --
 * and that blind spot survived a mutation that made the flag accept any
 * truthy value. So the column name is asserted against the SELECT LIST, and
 * the row projection is used only for what the parser then does with it.
 */
function selectedColumns(env: NodeJS.ProcessEnv): readonly string[] {
  const before = {
    [TYPOGRAPHY_OPTIONS_ENV]: process.env[TYPOGRAPHY_OPTIONS_ENV],
    [FORMAT_PROFILE_ENV]: process.env[FORMAT_PROFILE_ENV],
    NODE_ENV: process.env.NODE_ENV,
    STATEMENT_SIMULATED_LIVE: process.env.STATEMENT_SIMULATED_LIVE,
  }
  // The flags read process.env, as they must: threading an env parameter
  // through to the browser is what QA-004 was. So the test sets it.
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply({
    [TYPOGRAPHY_OPTIONS_ENV]: env[TYPOGRAPHY_OPTIONS_ENV],
    [FORMAT_PROFILE_ENV]: env[FORMAT_PROFILE_ENV],
    // A test process is NODE_ENV=test, so simulated live is off unless asked.
    NODE_ENV: env.NODE_ENV,
    STATEMENT_SIMULATED_LIVE: env.STATEMENT_SIMULATED_LIVE,
  })
  try {
    return REQUIREMENT_READ_COLUMNS.requirementColumns()
      .split(',').map((column) => column.trim())
  } finally {
    apply(before)
  }
}

/** The row as the live select list would deliver it, for this env. */
function project(row: Row, env: NodeJS.ProcessEnv): Row {
  const out: Row = {}
  for (const column of selectedColumns(env)) {
    if (column in row) out[column] = row[column]
  }
  return out
}

/** One document, by the school on its set and its label. */
function document(school: string, label: string): Row {
  assert.ok(CATALOG !== null, 'the local-review payload is missing; run the generator')
  const sets = new Map(CATALOG.sets.map((s) => [s.id as string, s]))
  const found = CATALOG.documents.filter((d) => {
    const set = sets.get(d.set_id as string)
    return typeof set?.school_name === 'string'
      && set.school_name.toLowerCase().includes(school.toLowerCase())
      && d.label === label
  })
  assert.equal(found.length, 1,
    `${found.length} documents matched ${school} / ${label}, expected exactly 1`)
  return found[0]!
}

/**
 * The option arrays the Southern Mississippi correction will store, read out
 * of the correction itself.
 *
 * SOURCE-DERIVED ON PURPOSE. These values are not in the payload: 010's
 * columns are not part of the import, and the one row that needs them is
 * converted by a separate reviewed UPDATE. Copying them here would make this
 * file agree with a past version of that UPDATE for ever.
 */
function southernMississippiOptions(): {
  families: readonly string[], sizes: readonly number[], prose: string,
} {
  const sql = readFileSync(SM_SQL, 'utf8')
  const families = /array\[([^\]]*)\]::text\[\]/.exec(sql)
  const sizes = /array\[([^\]]*)\]::integer\[\]/.exec(sql)
  assert.ok(families !== null && sizes !== null,
    'the Southern Mississippi correction no longer declares its arrays the same way')
  const strings = [...families[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
  const numbers = sizes[1]!.split(',').map((n) => Number(n.trim()))
  // The sentence the correction removes from other_instructions, which is the
  // school's own wording and the reason the arrays exist.
  const prose = /^\s*'(Times Roman[^']*)'\s*$/m.exec(sql)
  assert.ok(prose !== null, 'the correction no longer carries the school\'s wording')
  return { families: strings, sizes: numbers, prose: prose[1]! }
}

const PRE = {} as NodeJS.ProcessEnv
const OFF = {} as NodeJS.ProcessEnv
const ON = {
  [TYPOGRAPHY_OPTIONS_ENV]: 'on', [FORMAT_PROFILE_ENV]: 'on',
} as NodeJS.ProcessEnv

test('the payload loaded, so nothing below passes vacuously', () => {
  assert.ok(CATALOG !== null)
  assert.equal(CATALOG.sets.length, 63)
  assert.equal(CATALOG.documents.length, 80)
})

// ---------------------------------------------------------------------------
// STATE A -- BEFORE THE MIGRATION. Production, today.
// ---------------------------------------------------------------------------
test('010/014 ABSENT: the select names neither migration’s columns', () => {
  // With no flag set, which is what a production process has today.
  const selected = selectedColumns(PRE)
  for (const column of [...OPTION_COLUMNS, PROFILE_COLUMN]) {
    assert.ok(!selected.includes(column),
      `the pre-migration select list names ${column}, which production would 42703`)
  }
  // And the base columns are still there, so this is not passing by emptiness.
  for (const column of ['id', 'label', 'min_words', 'words_enforcement']) {
    assert.ok(selected.includes(column), `the select list lost ${column}`)
  }
})

test('010/014 ABSENT: every served document still parses, claiming neither', () => {
  assert.ok(CATALOG !== null)
  let parsed = 0
  for (const row of CATALOG.documents) {
    const requirement = requirementFromRow(project(row, PRE))
    assert.ok(requirement !== null, `row ${String(row.id)} refused pre-migration`)
    assert.equal(requirement.constraints.formatProfile, null)
    assert.equal(requirement.constraints.typography?.fontFamilyOptions ?? null, null)
    assert.equal(requirement.constraints.typography?.fontSizePtOptions ?? null, null)
    parsed += 1
  }
  assert.equal(parsed, 80)
})

// ---------------------------------------------------------------------------
// STATE B -- MIGRATION APPLIED, CAPABILITY OFF. The middle of the rollout.
// ---------------------------------------------------------------------------
test('014 APPLIED, CAPABILITY OFF: a stored profile is not selected, so not claimed', () => {
  for (const school of ['Cedar Crest', 'New Mexico State']) {
    const stored = document(school, school === 'Cedar Crest'
      ? 'Admission Essay' : 'Admissions Essay')
    // The column IS populated in the desired state...
    assert.equal(stored[PROFILE_COLUMN], 'apa-7', `${school} desired profile`)
    // ...and with the capability off the query never asks for it.
    assert.ok(!selectedColumns(OFF).includes(PROFILE_COLUMN),
      'the capability-off select list names the profile column')
    const row = project(stored, OFF)
    assert.ok(!(PROFILE_COLUMN in row), `${school} leaked the profile column`)
    const requirement = requirementFromRow(row)
    assert.ok(requirement !== null)
    assert.equal(requirement.constraints.formatProfile, null,
      `${school} claimed a profile with the capability off`)
  }
})

test('010 APPLIED, CAPABILITY OFF: the option arrays are not selected', () => {
  const { families, sizes } = southernMississippiOptions()
  const stored = {
    ...document('Southern Mississippi', 'Personal Statement'),
    font_family_options: families, font_size_pt_options: sizes,
  }
  const selected = selectedColumns(OFF)
  const row = project(stored, OFF)
  for (const column of OPTION_COLUMNS) {
    assert.ok(!selected.includes(column),
      `the capability-off select list names ${column}`)
    assert.ok(!(column in row), `the capability-off projection delivered ${column}`)
  }
  const requirement = requirementFromRow(row)
  assert.ok(requirement !== null)
  assert.equal(requirement.constraints.typography?.fontFamilyOptions ?? null, null)
  assert.equal(requirement.constraints.typography?.fontSizePtOptions ?? null, null)
})

// ---------------------------------------------------------------------------
// STATE C -- MIGRATION APPLIED, CORRECTION APPLIED, CAPABILITY ON.
// ---------------------------------------------------------------------------
test('010 + correction + capability: Southern Mississippi gets both choices', () => {
  const { families, sizes, prose } = southernMississippiOptions()
  // THE CORRECTION'S OWN VALUES, canonically sorted, as 010's validator
  // demands. Asserted here so a re-ordered correction is caught by a test and
  // not by the database refusing it at 3am.
  assert.deepEqual([...families], ['Arial', 'Times Roman'])
  assert.deepEqual([...sizes], [11, 12])
  assert.match(prose, /Times Roman or Arial, 11 or 12 point/)

  const stored = {
    ...document('Southern Mississippi', 'Personal Statement'),
    font_family_options: families, font_size_pt_options: sizes,
  }
  // 010's one-representation CHECKs: a choice means the single columns stay null.
  assert.equal(stored.font_family ?? null, null)
  assert.equal(stored.font_size_pt ?? null, null)

  const selected = selectedColumns(ON)
  const row = project(stored, ON)
  for (const column of OPTION_COLUMNS) {
    assert.ok(selected.includes(column), `the capability-on select list omits ${column}`)
    assert.ok(column in row, `the capability-on projection dropped ${column}`)
  }
  const requirement = requirementFromRow(row)
  assert.ok(requirement !== null)
  assert.deepEqual(requirement.constraints.typography?.fontFamilyOptions,
    ['Arial', 'Times Roman'])
  assert.deepEqual(requirement.constraints.typography?.fontSizePtOptions, [11, 12])
  // AND NO SINGLE VALUE IS INVENTED. Reporting one of the two permitted faces
  // as required would state a requirement the school did not make.
  assert.equal(requirement.constraints.typography?.fontFamily ?? null, null)
  assert.equal(requirement.constraints.typography?.fontSizePt ?? null, null)
})

test('014 + correction + capability: Cedar Crest and New Mexico State get apa-7', () => {
  for (const [school, label] of [
    ['Cedar Crest', 'Admission Essay'],
    ['New Mexico State', 'Admissions Essay'],
  ] as const) {
    assert.ok(selectedColumns(ON).includes(PROFILE_COLUMN),
      'the capability-on select list omits the profile column')
    const row = project(document(school, label), ON)
    assert.ok(PROFILE_COLUMN in row, `${school} projection dropped the profile`)
    const requirement = requirementFromRow(row)
    assert.ok(requirement !== null)
    assert.equal(requirement.constraints.formatProfile, 'apa-7',
      `${school} did not receive its whole-document profile`)
  }
})

test('014 + capability: Keiser does NOT get a whole-document profile', () => {
  /*
   * Keiser's citation instruction is about the references, not about the
   * layout of the whole document. 014's column means "format this essay as a
   * named standard", and claiming it here would impose a title page, a
   * running head and a reference page the school never asked for.
   *
   * ASSERTED IN THE CAPABILITY-ON STATE, which is the only state where it
   * could go wrong -- with the flag off nothing claims a profile at all, so
   * the off-state assertion would pass for the wrong reason.
   */
  const stored = document('Keiser', 'Personal Statement Letter')
  assert.equal(stored[PROFILE_COLUMN] ?? null, null,
    'Keiser gained a document_format_profile in the payload')
  const requirement = requirementFromRow(project(stored, ON))
  assert.ok(requirement !== null)
  assert.equal(requirement.constraints.formatProfile, null)
})

test('no other served document gains a profile the payload did not store', () => {
  /*
   * The complement of the three cases above, over everything else: 014 may
   * only ever surface what the catalog stores, so the set of documents
   * claiming a profile with the capability ON is exactly the set the payload
   * populates. Two today.
   */
  assert.ok(CATALOG !== null)
  const claimed = CATALOG.documents.filter((row) => {
    const requirement = requirementFromRow(project(row, ON))
    return requirement !== null && requirement.constraints.formatProfile !== null
  })
  const stored = CATALOG.documents.filter((row) => row[PROFILE_COLUMN] != null)
  assert.equal(claimed.length, stored.length)
  assert.equal(claimed.length, 2)
  assert.deepEqual(
    claimed.map((row) => row.id).sort(), stored.map((row) => row.id).sort())
})

// ---------------------------------------------------------------------------
// FAIL CLOSED
// ---------------------------------------------------------------------------
test('a malformed flag value widens nothing', () => {
  /*
   * The predicate is already tested; this tests the PROJECTION, which is what
   * actually reaches PostgREST. A typo in a Vercel environment variable must
   * not produce a select naming a column production may not have -- that is a
   * 42703 for the whole query, which is the entire catalog, not one field.
   */
  for (const value of ['ON', 'On', 'true', '1', 'yes', 'on ', ' on', '', '0', 'off']) {
    // EACH FLAG ALONE as well as both together, so a mutation to one of them
    // cannot hide behind the other still being strict.
    for (const env of [
      { [TYPOGRAPHY_OPTIONS_ENV]: value },
      { [FORMAT_PROFILE_ENV]: value },
      { [TYPOGRAPHY_OPTIONS_ENV]: value, [FORMAT_PROFILE_ENV]: value },
    ] as NodeJS.ProcessEnv[]) {
      const selected = selectedColumns(env)
      for (const column of [...OPTION_COLUMNS, PROFILE_COLUMN]) {
        assert.ok(!selected.includes(column),
          `${column} was selected for the flag value ${JSON.stringify(value)}`)
      }
    }
  }
})

test('local simulated-live forces both capabilities on', () => {
  // The owner's development process talks to local JSON stores that always
  // have every column, so it does not need the flags -- and must not need
  // them, or local review would silently exercise a different read.
  const row = {
    ...document('Cedar Crest', 'Admission Essay'),
    font_family_options: ['Arial'], font_size_pt_options: [12],
  }
  const selected = selectedColumns({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)
  const columns = project(row, { NODE_ENV: 'development' } as NodeJS.ProcessEnv)
  for (const column of [...OPTION_COLUMNS, PROFILE_COLUMN]) {
    assert.ok(selected.includes(column), `simulated live did not name ${column}`)
    assert.ok(column in columns, `simulated live did not select ${column}`)
  }
  // ...and a development process that opted OUT talks to the real database,
  // so it must ask for nothing extra.
  const optedOut = project(row, {
    NODE_ENV: 'development', STATEMENT_SIMULATED_LIVE: 'off',
  } as NodeJS.ProcessEnv)
  for (const column of [...OPTION_COLUMNS, PROFILE_COLUMN]) {
    assert.ok(!(column in optedOut), `simulated-live-off still selected ${column}`)
  }
})
