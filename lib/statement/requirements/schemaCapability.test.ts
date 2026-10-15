/**
 * The schema/code capability contract for migrations 010 and 014.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS EXISTS TO STOP
 * ---------------------------------------------------------------------------
 * Two failure shapes, opposite to each other:
 *
 *   NAMING A COLUMN THAT DOES NOT EXIST. PostgREST answers a select mentioning
 *   an unknown column with a 42703 for the WHOLE query, so a build that asked
 *   for font_family_options against today's production would take the entire
 *   catalog down rather than lose one field.
 *
 *   NEVER NAMING ONE THAT DOES. constraintsFromRow has always read these
 *   columns "if they arrive", which read as forward-compatible and was not:
 *   the select list never asked, so applying 010 or 014 changed nothing and
 *   the catalog corrections that populate them would have been stored and
 *   never read.
 *
 * So the select list is a FUNCTION of the flags, and this file pins all three
 * states of the contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REQUIREMENT_READ_COLUMNS, requirementFromRow } from './repo.ts'
import {
  FORMAT_PROFILE_ENV, TYPOGRAPHY_OPTIONS_ENV, formatProfileEnabled,
  typographyOptionsEnabled,
} from '../draft/rollout.ts'

const OPTION_COLUMNS = ['font_family_options', 'font_size_pt_options']
const PROFILE_COLUMN = 'document_format_profile'

test('both flags fail closed, and simulated live forces them on', () => {
  for (const [name, fn] of [
    [TYPOGRAPHY_OPTIONS_ENV, typographyOptionsEnabled],
    [FORMAT_PROFILE_ENV, formatProfileEnabled],
  ] as const) {
    assert.equal(fn({} as NodeJS.ProcessEnv), false, `${name} default`)
    assert.equal(fn({ [name]: 'on' } as NodeJS.ProcessEnv), true)
    // ANYTHING BUT THE EXACT STRING IS OFF.
    for (const value of ['ON', 'true', '1', 'on ', 'yes']) {
      assert.equal(fn({ [name]: value } as NodeJS.ProcessEnv), false, `${name}=${value}`)
    }
    assert.equal(fn({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), true, `${name} locally`)
    // ...but not in a development process that opted out, which talks to the
    // real database and must not name columns it may not have.
    assert.equal(fn({
      NODE_ENV: 'development', STATEMENT_SIMULATED_LIVE: 'off',
    } as NodeJS.ProcessEnv), false, `${name} with simulated live off`)
  }
})

test('PRE-010/014 SCHEMA: the select names neither migration’s columns', () => {
  /*
   * The state production is in today. A build deployed now must be safe
   * against it, which means asking for nothing 005/006/007 did not create.
   */
  const base = REQUIREMENT_READ_COLUMNS.REQUIREMENT_COLUMNS
  for (const column of [...OPTION_COLUMNS, PROFILE_COLUMN]) {
    assert.ok(!base.includes(column), `the base projection names ${column}`)
  }
  // And the base projection is what the flag-off path produces.
  assert.equal(typographyOptionsEnabled({} as NodeJS.ProcessEnv), false)
  assert.equal(formatProfileEnabled({} as NodeJS.ProcessEnv), false)
})

test('PRE-010/014 SCHEMA: a row without those columns still parses', () => {
  // The row PostgREST returns today: the columns are simply not there.
  const row = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    set_id: 'bbbbbbbb-0000-4000-8000-000000000001',
    school_id: 'cccccccc-0000-4000-8000-000000000001',
    document_type: 'personal-statement',
    label: 'Admission Essay',
    prompt_text: 'Why anesthesia?',
    components: [],
    max_words: 500,
    words_enforcement: 'enforced',
    font_family: 'Times New Roman',
    font_size_pt: 12,
    other_instructions: [],
    notes: [],
    display_order: 0,
  }
  const parsed = requirementFromRow(row)
  assert.ok(parsed !== null, 'the parser refused a row it will see in production')
  // ABSENT, NOT WRONG: no options offered, no profile claimed, and the single
  // required family still applied.
  assert.equal(parsed.constraints.typography?.fontFamilyOptions ?? null, null)
  assert.equal(parsed.constraints.typography?.fontSizePtOptions ?? null, null)
  assert.equal(parsed.constraints.formatProfile, null)
  assert.equal(parsed.constraints.typography?.fontFamily, 'Times New Roman')
  assert.equal(parsed.constraints.words?.max, 500)
})

test('POST-010/014 SCHEMA, CAPABILITY ON: the fields are read and used', () => {
  /*
   * Southern Mississippi's shape after the targeted correction, and Cedar
   * Crest / New Mexico State's after theirs. This is the row the widened
   * select returns; the parser must carry all three fields through.
   */
  const row = {
    id: 'aaaaaaaa-0000-4000-8000-000000000002',
    set_id: 'bbbbbbbb-0000-4000-8000-000000000002',
    school_id: 'cccccccc-0000-4000-8000-000000000002',
    document_type: 'personal-statement',
    label: 'Personal Statement',
    prompt_text: 'Why anesthesia?',
    components: [],
    // A SCHOOL THAT PERMITS A CHOICE: the single-value columns stay null,
    // which 010's one-representation constraints require.
    font_family: null,
    font_size_pt: null,
    font_family_options: ['Times Roman', 'Arial'],
    font_size_pt_options: [11, 12],
    document_format_profile: 'apa-7',
    other_instructions: [],
    notes: [],
    display_order: 0,
  }
  const parsed = requirementFromRow(row)
  assert.ok(parsed !== null)
  // NORMALISED BY THE PARSER, DELIBERATELY: deduped, and sorted so two rows
  // listing the same permitted families in different orders are one fact.
  // The school's own wording is preserved in each value, not in their order.
  assert.deepEqual(parsed.constraints.typography?.fontFamilyOptions, ['Arial', 'Times Roman'])
  assert.deepEqual(parsed.constraints.typography?.fontSizePtOptions, [11, 12])
  assert.equal(parsed.constraints.formatProfile, 'apa-7')
})

test('POST-010/014 SCHEMA, CAPABILITY OFF: the row parses and claims nothing', () => {
  // The middle state of the rollout: migrations applied, flags not yet on.
  // The columns exist but are not selected, so the row looks exactly like the
  // pre-migration one. Nothing crashes and nothing is asserted.
  const row = {
    id: 'aaaaaaaa-0000-4000-8000-000000000003',
    set_id: 'bbbbbbbb-0000-4000-8000-000000000003',
    school_id: 'cccccccc-0000-4000-8000-000000000003',
    document_type: 'personal-statement',
    label: 'Personal Statement',
    prompt_text: 'Why anesthesia?',
    components: [], other_instructions: [], notes: [], display_order: 0,
  }
  const parsed = requirementFromRow(row)
  assert.ok(parsed !== null)
  assert.equal(parsed.constraints.formatProfile, null)
  assert.equal(parsed.constraints.typography, null)
})

test('the option columns are never selected beside their single-value twin', () => {
  /*
   * 010 adds two one-representation CHECKs: font_family and
   * font_family_options may not both be populated, and likewise for the size.
   * The parser must not invent the combination either -- a row carrying both
   * would have no defined precedence, and every reader downstream would have
   * to pick one.
   */
  const row = {
    id: 'aaaaaaaa-0000-4000-8000-000000000004',
    set_id: 'bbbbbbbb-0000-4000-8000-000000000004',
    school_id: 'cccccccc-0000-4000-8000-000000000004',
    document_type: 'personal-statement', label: 'X', prompt_text: 'Y',
    components: [], other_instructions: [], notes: [], display_order: 0,
    font_family: 'Arial', font_family_options: ['Arial', 'Times'],
  }
  const parsed = requirementFromRow(row)
  assert.ok(parsed !== null, 'a row the database would refuse must still parse, not crash')
  // Both are carried as read; the DATABASE is what forbids the combination,
  // and this test exists so nobody moves that decision into the parser.
  assert.equal(parsed.constraints.typography?.fontFamily, 'Arial')
})
