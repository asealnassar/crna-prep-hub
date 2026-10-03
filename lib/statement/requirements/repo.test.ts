import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { REQUIREMENT_READ_COLUMNS, listRequirementSets, readActiveRequirement, requirementFromRow } from './repo.ts'
import { createDraft } from '../draft/draftRepo.ts'
import { legacyProjection, snapshotOf } from './snapshot.ts'
import { BUFFALO, RUTGERS, UC_DAVIS } from './fixtures.ts'
import { REQUIREMENTS_ENV } from '../draft/rollout.ts'

/**
 * A recording stub. Every call is logged so a test can assert that NO QUERY WAS
 * ISSUED, which is the central claim about the disabled path -- naming an absent
 * table fails the whole request, so "returns a refusal" is not enough.
 */
function stubDb(responses: Record<string, { data?: unknown; error?: unknown }>) {
  const calls: string[] = []
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const method of ['select', 'eq', 'in', 'order']) {
      chain[method] = (...args: unknown[]) => {
        calls.push(`${table}.${method}(${args.map((a) => typeof a === 'string' ? a : '…').join(',')})`)
        return self()
      }
    }
    chain.maybeSingle = () =>
      Promise.resolve(responses[table] ?? { data: null, error: null })
    // A non-single read resolves when awaited directly.
    chain.then = (resolve: (value: unknown) => unknown) =>
      resolve(responses[table] ?? { data: [], error: null })
    return chain
  }
  return {
    calls,
    db: { from: (table: string) => { calls.push(`from(${table})`); return builder(table) } } as unknown as SupabaseClient,
  }
}

function withFlag<T>(value: string | undefined, run: () => T): T {
  const before = process.env[REQUIREMENTS_ENV]
  if (value === undefined) delete process.env[REQUIREMENTS_ENV]
  else process.env[REQUIREMENTS_ENV] = value
  try { return run() } finally {
    if (before === undefined) delete process.env[REQUIREMENTS_ENV]
    else process.env[REQUIREMENTS_ENV] = before
  }
}

// ===================================================== the gate

test('WITH THE FLAG OFF, NO QUERY IS ISSUED AT ALL', async () => {
  const { db, calls } = stubDb({})
  await withFlag(undefined, async () => {
    const listed = await listRequirementSets(db, 'school-1', 'A School')
    assert.equal(listed.ok, false)
    assert.equal(listed.ok === false && listed.reason, 'disabled')
    const one = await readActiveRequirement(db, 'req-1')
    assert.equal(one.ok === false && one.reason, 'disabled')
  })
  // THE LOAD-BEARING ASSERTION: the tables do not exist, so a query would fail
  // the request rather than return nothing.
  assert.deepEqual(calls, [])
})

test('the flag must be exactly "on"', async () => {
  for (const value of ['', 'off', 'true', 'ON', ' on']) {
    const { db, calls } = stubDb({})
    await withFlag(value, async () => {
      const result = await listRequirementSets(db, 's', 'S')
      assert.equal(result.ok === false && result.reason, 'disabled', value)
    })
    assert.deepEqual(calls, [], value)
  }
})

test('with the flag ON the expected tables and columns are read', async () => {
  const { db, calls } = stubDb({ statement_requirement_sets: { data: [], error: null } })
  await withFlag('on', async () => {
    const result = await listRequirementSets(db, 'school-1', 'A School')
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok === true ? [...result.value] : null, [], 'no sets is not an error')
  })
  assert.ok(calls.some((c) => c === 'from(statement_requirement_sets)'))
  // The second query is SKIPPED when the first finds nothing.
  assert.ok(!calls.some((c) => c.includes('statement_requirements')))
})

test('the column lists name only columns the migration creates', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const sql = readFileSync(
    fileURLToPath(new URL('../../../supabase/migrations/20261002_005_statement_requirements.sql',
      import.meta.url)), 'utf8').replace(/^\s*--.*$/gm, '')
  for (const columns of Object.values(REQUIREMENT_READ_COLUMNS)) {
    for (const column of columns.split(',').map((c) => c.trim())) {
      assert.ok(sql.includes(column), `${column} is not in the migration`)
    }
  }
})

// ===================================================== row parsing

test('a requirement row parses into the model', () => {
  const parsed = requirementFromRow({
    id: 'r1', set_id: 's1', school_id: 'c1', document_type: 'diversity-statement',
    label: 'Diversity Essay', prompt_text: 'Why does equity matter?',
    components: [{ id: 'a', text: 'one', optional: false }, { id: 'b', text: 'two', optional: true }],
    min_words: null, max_words: 500,
    min_characters: null, max_characters: null, characters_include_spaces: null,
    min_pages: null, max_pages: null, page_spacing: null,
    font_size_pt: null, font_family: null, margins_inches: null,
    citation_style: null, citation_family: null, min_references: null,
    other_instructions: ['no cover page'], choice_group: null, is_optional: false,
    notes: ['a note'], display_order: 2,
  })
  assert.ok(parsed)
  assert.equal(parsed.documentType, 'diversity-statement')
  assert.deepEqual(parsed.constraints.words, { min: null, max: 500 })
  assert.equal(parsed.constraints.characters, null, 'all-null columns yield NO section')
  assert.equal(parsed.constraints.pages, null)
  assert.equal(parsed.constraints.typography, null)
  assert.equal(parsed.constraints.citation, null)
  assert.deepEqual([...parsed.constraints.otherInstructions], ['no cover page'])
  assert.equal(parsed.components.length, 2)
  assert.equal(parsed.displayOrder, 2)
})

test('ALL-NULL LIMIT COLUMNS YIELD NO SECTION, NOT AN EMPTY LIMIT', () => {
  // The difference matters: {min: null, max: null} reads downstream as "there
  // IS a word limit" and liveCounts() would show a word counter for a school
  // that gave none.
  const bare = requirementFromRow({
    id: 'r', label: 'L', prompt_text: 'q', set_id: 's', school_id: 'c',
  })
  assert.ok(bare)
  assert.equal(bare.constraints.words, null)
  assert.equal(bare.constraints.characters, null)
  assert.equal(bare.constraints.pages, null)
  assert.equal(bare.constraints.typography, null)
  assert.equal(bare.constraints.citation, null)
})

test('a row missing its identity or wording does not parse', () => {
  for (const missing of ['id', 'label', 'prompt_text']) {
    const row: Record<string, unknown> = { id: 'r', label: 'L', prompt_text: 'q' }
    delete row[missing]
    assert.equal(requirementFromRow(row), null, missing)
  }
  // Blank wording is not wording.
  assert.equal(requirementFromRow({ id: 'r', label: '  ', prompt_text: 'q' }), null)
  assert.equal(requirementFromRow({ id: 'r', label: 'L', prompt_text: '   ' }), null)
  for (const junk of [null, undefined, 'string', 7, []]) {
    assert.equal(requirementFromRow(junk), null, String(junk))
  }
})

test('an unrecognised document type becomes "other"', () => {
  const parsed = requirementFromRow({
    id: 'r', label: 'L', prompt_text: 'q', document_type: 'thesis',
  })
  assert.equal(parsed?.documentType, 'other')
})

test('a page-only row carries pages and NO words', () => {
  const parsed = requirementFromRow({
    id: 'r', label: 'L', prompt_text: 'q', max_pages: 1, page_spacing: 'double',
  })
  assert.deepEqual(parsed?.constraints.pages, { min: null, max: 1, spacing: 'double' })
  assert.equal(parsed?.constraints.words, null, 'one page is not a word count')
})

test('a margin arriving as a numeric STRING is still read', () => {
  const parsed = requirementFromRow({
    id: 'r', label: 'L', prompt_text: 'q', margins_inches: '1.00',
  })
  assert.equal(parsed?.constraints.typography?.marginsInches, 1)
})

test('a citation family with no stated wording is dropped', () => {
  const parsed = requirementFromRow({
    id: 'r', label: 'L', prompt_text: 'q', citation_family: 'apa', min_references: 3,
  })
  assert.equal(parsed?.constraints.citation, null,
    'a style with nothing to show the applicant is not a style')
})

// ===================================================== creating a draft

test('A REQUIREMENT-BACKED CREATE IS REFUSED WHILE THE FLAG IS OFF', async () => {
  const requirement = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const { db, calls } = stubDb({})
  await withFlag(undefined, async () => {
    const result = await createDraft(
      db, 'user-1', { title: 'T', essay: '' }, undefined, requirement)
    assert.equal(result.ok, false)
  })
  // NO ROW IS INSERTED. Refusing before the statement is the whole point:
  // silently downgrading to a prompt-only insert would store a draft that kept
  // the wording and lost the components and the character limit.
  assert.deepEqual(calls, [])
})

test('a create cannot pass BOTH a prompt and a requirement', async () => {
  const requirement = snapshotOf(BUFFALO, BUFFALO.requirements[0]!)
  const prompt = {
    promptId: 'p', schoolId: 's', promptText: 'q', statedMaxWords: 500,
  }
  const { db, calls } = stubDb({})
  await withFlag('on', async () => {
    const result = await createDraft(db, 'u', { title: 'T', essay: '' }, prompt, requirement)
    assert.equal(result.ok, false, 'two sources for prompt_text is a bug, not a merge')
  })
  assert.deepEqual(calls, [])
})

test('A PAGE-LIMITED REQUIREMENT WRITES stated_max_words AS NULL', () => {
  // Checked on the projection directly: the insert payload is built from it.
  for (const requirement of RUTGERS.requirements) {
    const snapshot = snapshotOf(RUTGERS, requirement)
    assert.equal(legacyProjection(snapshot).statedMaxWords, null)
  }
  for (const requirement of UC_DAVIS.requirements) {
    assert.equal(legacyProjection(snapshotOf(UC_DAVIS, requirement)).statedMaxWords, null)
  }
})
