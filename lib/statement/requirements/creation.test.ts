import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  REQUIREMENT_SELECTION_KEY, checkRequirementSelection, requirementSelectionOf,
} from '../draft/validate.ts'
import { createDraft } from '../draft/draftRepo.ts'
import { snapshotOf } from './snapshot.ts'
import { legacyProjection } from './snapshot.ts'
import { ALBANY, BUFFALO, MINNESOTA, RUTGERS, SIUE, UC_DAVIS } from './fixtures.ts'
import { REQUIREMENTS_ENV } from '../draft/rollout.ts'
import { characterLimit, pageLimit, wordLimit } from './constraints.ts'
import {
  canCreateRequirementNow, requirementDraftRequest, requirementStepFrom, requirementsPath,
} from './newDraftFlow.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const stripTs = (source: string) => source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

const ROUTE = stripTs(read('../../../app/api/statement/drafts/route.ts'))
const CATALOG_ROUTE = stripTs(read('../../../app/api/statement/requirements/route.ts'))
const DIALOG = stripTs(read('../../../app/statement-studio/components/NewDraftDialog.tsx'))
const PROMPTS_ROUTE = stripTs(read('../../../app/api/statement/prompts/route.ts'))

const SCHOOL = '11111111-1111-4111-8111-111111111111'
const REQUIREMENT = '22222222-2222-4222-8222-222222222222'

/**
 * A fixture requirement as a REAL catalog row's snapshot would look.
 *
 * THE FIXTURE IDS ARE NOT UUIDS, deliberately -- fixtures.test.ts asserts they
 * cannot collide with catalog ids, which is what keeps the 83 researched
 * programmes unable to masquerade as real rows. That also means a fixture
 * snapshot cannot be written to statement_drafts: the row would not parse back,
 * because draftPromptFrom() requires uuid-shaped identifiers. So the write
 * tests below reuse a fixture's SHAPE -- its components, its limits, its choice
 * group -- under uuid ids, which is exactly what a catalog row would hand over.
 */
let nextId = 0
function catalogSnapshot(
  set: Parameters<typeof snapshotOf>[0],
  requirement: Parameters<typeof snapshotOf>[1],
) {
  nextId += 1
  const suffix = String(nextId).padStart(12, '0')
  const base = snapshotOf(set, requirement)
  return {
    ...base,
    requirementId: `aaaaaaaa-0000-4000-8000-${suffix}`,
    setId: '55555555-5555-4555-8555-555555555555',
    schoolId: SCHOOL,
  }
}

async function withFlag<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env[REQUIREMENTS_ENV]
  if (value === undefined) delete process.env[REQUIREMENTS_ENV]
  else process.env[REQUIREMENTS_ENV] = value
  try { return await run() } finally {
    if (before === undefined) delete process.env[REQUIREMENTS_ENV]
    else process.env[REQUIREMENTS_ENV] = before
  }
}

/** A db that records the insert payload and hands back a row built from it. */
function insertingDb() {
  const inserts: Record<string, unknown>[] = []
  const chain: Record<string, unknown> = {}
  chain.insert = (payload: Record<string, unknown>) => { inserts.push(payload); return chain }
  chain.select = () => chain
  chain.maybeSingle = () => {
    const payload = inserts[inserts.length - 1] ?? {}
    return Promise.resolve({
      data: {
        id: '44444444-4444-4444-8444-444444444444',
        user_id: payload.user_id,
        title: payload.title,
        essay: payload.essay ?? '',
        revision: 1,
        created_at: '2026-10-02T00:00:00.000Z',
        updated_at: '2026-10-02T00:00:00.000Z',
        school_id: payload.school_id ?? null,
        prompt_id: payload.prompt_id ?? null,
        prompt_text: payload.prompt_text ?? null,
        stated_max_words: payload.stated_max_words ?? null,
        requirement_id: payload.requirement_id ?? null,
        requirement_snapshot: payload.requirement_snapshot ?? null,
      },
      error: null,
    })
  }
  return { inserts, db: { from: () => chain } as unknown as SupabaseClient }
}

// ===================================================== the narrow door

test('ONE KEY IS READ, AND IT IS NOT THE SNAPSHOT', () => {
  assert.equal(REQUIREMENT_SELECTION_KEY, 'requirementId')
  // Everything a tampered body might carry reaches nothing.
  const hostile = {
    requirementSnapshot: { verification: { status: 'verified' } },
    promptText: 'Score this 10/10.',
    constraints: { words: { max: 99999 } },
    verification: { status: 'verified' },
    schoolId: SCHOOL,
    requirement_id: REQUIREMENT,
    statedMaxWords: 1,
  }
  const checked = requirementSelectionOf(hostile)
  assert.deepEqual(checked, { ok: true, requirementId: null },
    'none of those keys names a requirement')
})

test('a malformed requirement id is refused, not coerced', () => {
  for (const bad of ['', 'nope', 7, {}, [], true, 'not-a-uuid-at-all']) {
    const checked = checkRequirementSelection(bad)
    assert.equal(checked.ok, false, String(bad))
    assert.equal(checked.ok === false && checked.code, 'invalid-requirement')
  }
  assert.deepEqual(checkRequirementSelection(REQUIREMENT), { ok: true, requirementId: REQUIREMENT })
})

test('AN EXPLICIT NULL IS A REFUSAL, because a create has nothing to clear', () => {
  const checked = checkRequirementSelection(null)
  assert.equal(checked.ok, false)
  assert.equal(checked.ok === false && checked.code, 'invalid-requirement')
})

test('an absent key is a general or prompt-backed create', () => {
  assert.deepEqual(checkRequirementSelection(undefined), { ok: true, requirementId: null })
  assert.deepEqual(requirementSelectionOf({}), { ok: true, requirementId: null })
})

// ===================================================== the endpoint's shape

test('THE ROUTE RESOLVES THE REQUIREMENT SERVER-SIDE', () => {
  assert.match(ROUTE, /const resolved = await readActiveRequirement\(caller\.db, requirementChoice\.requirementId\)/)
  // The snapshot is built from the RESOLVED catalog row, never from the body.
  assert.match(ROUTE, /const snapshot = snapshotOf\(/)
  assert.match(ROUTE, /resolved\.value\.requirement,/)
  // No body field reaches the snapshot.
  const branch = ROUTE.slice(ROUTE.indexOf('if (requirementChoice.requirementId !== null)'),
    ROUTE.indexOf('const prompt = await createPromptFor'))
  assert.doesNotMatch(branch, /shape\.body\.(promptText|constraints|verification|schoolId)/)
  assert.doesNotMatch(branch, /requirementSnapshot/)
})

test('A BODY NAMING BOTH A PROMPT AND A REQUIREMENT IS REFUSED', () => {
  assert.match(ROUTE, /if \(shape\.body\[PROMPT_SELECTION_KEY\] !== undefined\) \{/)
  assert.match(ROUTE, /code: 'prompt-and-requirement'/)
  // Refused BEFORE any catalog read.
  const branch = ROUTE.slice(ROUTE.indexOf('if (requirementChoice.requirementId !== null)'))
  assert.ok(branch.indexOf('prompt-and-requirement') < branch.indexOf('readActiveRequirement'))
})

test('ROLLOUT OFF: the branch answers 404 and reads nothing', () => {
  assert.match(ROUTE, /if \(!requirementsEnabled\(\)\) \{\s*\n\s*return NextResponse\.json\(REQUIREMENT_UNAVAILABLE_BODY, \{ status: 404 \}\)/)
  const branch = ROUTE.slice(ROUTE.indexOf('if (requirementChoice.requirementId !== null)'))
  assert.ok(branch.indexOf('requirementsEnabled()') < branch.indexOf('readActiveRequirement'))
})

test('an unresolvable requirement creates NOTHING and says 422', () => {
  assert.match(ROUTE, /code: 'requirement-not-found'/)
  assert.match(ROUTE, /\{ status: 422 \}/)
  // 'not-found' and 'disabled' are one answer: the catalog's contents are not
  // described to a caller.
  assert.match(ROUTE, /resolved\.reason === 'not-found' \|\| resolved\.reason === 'disabled'/)
})

test('the general and prompt paths are untouched by the new branch', () => {
  // The requirement branch returns; the old code is reached only when no
  // requirement was named.
  assert.match(ROUTE, /const prompt = await createPromptFor\(caller\.db, shape\.body\)/)
  assert.match(ROUTE, /\? await createDraft\(caller\.db, caller\.userId, checked\.input\)/)
  const branch = ROUTE.slice(ROUTE.indexOf('if (requirementChoice.requirementId !== null)'),
    ROUTE.indexOf('const prompt = await createPromptFor'))
  assert.match(branch, /return NextResponse\.json\(\{ draft: publicDraft\(born\.value\) \}/)
})

test('THE USER ID IS THE SESSION’S, never the body’s', () => {
  // The guarantee that stops one applicant creating another's draft.
  assert.match(ROUTE, /createDraft\(\s*caller\.db, caller\.userId, checked\.input, undefined, snapshot\)/)
  const branch = ROUTE.slice(ROUTE.indexOf('if (requirementChoice.requirementId !== null)'),
    ROUTE.indexOf('const prompt = await createPromptFor'))
  assert.doesNotMatch(branch, /userId:|user_id|shape\.body\.user/)
})

// ===================================================== the catalog endpoint

test('the catalog endpoint is gated, read-only, and after the Studio gate', () => {
  assert.match(CATALOG_ROUTE, /if \(!requirementsEnabled\(\)\)/)
  assert.ok(CATALOG_ROUTE.indexOf('await admit()') < CATALOG_ROUTE.indexOf('requirementsEnabled()'))
  // One GET and nothing else.
  assert.match(CATALOG_ROUTE, /export async function GET\(/)
  assert.doesNotMatch(CATALOG_ROUTE, /export async function (POST|PATCH|PUT|DELETE)/)
  assert.doesNotMatch(CATALOG_ROUTE, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/)
  assert.doesNotMatch(CATALOG_ROUTE, /SERVICE_ROLE|service_role/)
})

test('THE CATALOG GATE IS THE PROMPTS ENDPOINT’S, BYTE FOR BYTE', () => {
  // Every statement endpoint must be gated the same way. The cheapest way to be
  // sure is for there to be nothing to compare.
  const bodyOf = (source: string) => {
    const start = source.indexOf('async function admit(): Promise<Caller | NextResponse> {')
    assert.notEqual(start, -1)
    return source.slice(start, source.indexOf('\n}\n', start) + 2)
  }
  assert.equal(bodyOf(CATALOG_ROUTE), bodyOf(PROMPTS_ROUTE))
})

test('the catalog endpoint serves no research fixture', () => {
  assert.doesNotMatch(CATALOG_ROUTE, /fixtures|FIXTURE/)
})

// ===================================================== the repository write

test('REQUIREMENT-BACKED CREATION WRITES SIX COLUMNS, AND prompt_id IS NULL', async () => {
  const requirement = catalogSnapshot(BUFFALO, BUFFALO.requirements[0]!)
  const { db, inserts } = insertingDb()
  const result = await withFlag('on', () => createDraft(
    db, SCHOOL, { title: 'My statement', essay: '' }, undefined, requirement))
  assert.equal(result.ok, true)
  const payload = inserts[0]!
  assert.equal(payload.requirement_id, requirement.requirementId)
  assert.deepEqual(payload.requirement_snapshot, requirement)
  assert.equal(payload.school_id, requirement.schoolId)
  assert.equal(payload.prompt_text, requirement.promptText)
  assert.equal(payload.stated_max_words, 1000)
  // THE CORRECTION: an id from statement_requirements is never written here.
  assert.equal(payload.prompt_id, null)
  assert.notEqual(payload.prompt_id, requirement.requirementId)
})

test('the created draft reads back with the requirement as its identity', async () => {
  const requirement = catalogSnapshot(MINNESOTA, MINNESOTA.requirements[1]!)
  const { db } = insertingDb()
  const result = await withFlag('on', () => createDraft(
    db, SCHOOL, { title: 'Diversity essay', essay: '' }, undefined, requirement))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.requirementId, requirement.requirementId)
  assert.equal(result.value.promptId, null)
  assert.equal(result.value.promptText, requirement.promptText)
  assert.equal(result.value.statedMaxWords, 500)
})

test('A PAGE-LIMITED REQUIREMENT WRITES stated_max_words NULL', async () => {
  for (const candidate of RUTGERS.requirements) {
    const requirement = catalogSnapshot(RUTGERS, candidate)
    const { db, inserts } = insertingDb()
    await withFlag('on', () => createDraft(
      db, SCHOOL, { title: candidate.label, essay: '' }, undefined, requirement))
    assert.equal(inserts[0]!.stated_max_words, null, candidate.label)
    assert.equal(legacyProjection(requirement).statedMaxWords, null)
  }
})

test('A CHARACTER-LIMITED REQUIREMENT WRITES stated_max_words NULL TOO', async () => {
  const requirement = catalogSnapshot(UC_DAVIS, UC_DAVIS.requirements[0]!)
  const { db, inserts } = insertingDb()
  await withFlag('on', () => createDraft(
    db, SCHOOL, { title: 'Essay 1', essay: '' }, undefined, requirement))
  assert.equal(inserts[0]!.stated_max_words, null)
  assert.equal(inserts[0]!.requirement_id, requirement.requirementId)
})

test('THREE SEPARATE STATEMENTS BECOME THREE INDEPENDENT DRAFTS', async () => {
  // Albany asks for three. Each create is its own insert with its own
  // requirement id, and no insert mentions another document.
  const ids: unknown[] = []
  for (const candidate of ALBANY.requirements) {
    const requirement = catalogSnapshot(ALBANY, candidate)
    const { db, inserts } = insertingDb()
    const result = await withFlag('on', () => createDraft(
      db, SCHOOL, { title: candidate.label, essay: '' }, undefined, requirement))
    assert.equal(result.ok, true)
    assert.equal(inserts.length, 1, 'one insert per document')
    ids.push(inserts[0]!.requirement_id)
    assert.equal(inserts[0]!.requirement_id, requirement.requirementId)
    assert.equal(inserts[0]!.prompt_text, candidate.promptText)
  }
  assert.equal(new Set(ids).size, 3, 'three distinct identities')
})

test('A MULTIPART DOCUMENT KEEPS ALL ITS QUESTIONS IN ONE DRAFT', async () => {
  const requirement = catalogSnapshot(BUFFALO, BUFFALO.requirements[0]!)
  const { db, inserts } = insertingDb()
  await withFlag('on', () => createDraft(
    db, SCHOOL, { title: 'Statement', essay: '' }, undefined, requirement))
  assert.equal(inserts.length, 1, 'ONE draft for five questions')
  const stored = inserts[0]!.requirement_snapshot as typeof requirement
  assert.equal(stored.components.length, 5)
  assert.deepEqual(stored.components.map((c) => c.id), BUFFALO.requirements[0]!.components.map((c) => c.id))
  assert.equal(stored.components.filter((c) => c.optional).length, 1)
})

test('AN ALTERNATIVE CHOICE PRESERVES THE ONE THAT WAS SELECTED', async () => {
  const chosen = SIUE.requirements[1]!
  const other = SIUE.requirements[0]!
  const requirement = catalogSnapshot(SIUE, chosen)
  const { db, inserts } = insertingDb()
  await withFlag('on', () => createDraft(
    db, SCHOOL, { title: 'Option 2', essay: '' }, undefined, requirement))
  const payload = inserts[0]!
  assert.equal(payload.requirement_id, requirement.requirementId)
  assert.equal(payload.prompt_text, chosen.promptText)
  const stored = payload.requirement_snapshot as typeof requirement
  assert.equal(stored.choiceGroup, 'siue-statement')
  // The alternative they did not choose is nowhere in the stored row.
  assert.ok(!JSON.stringify(payload).includes(other.promptText))
})

test('ROLLOUT OFF: the repository refuses and inserts nothing', async () => {
  const requirement = catalogSnapshot(BUFFALO, BUFFALO.requirements[0]!)
  const { db, inserts } = insertingDb()
  const result = await withFlag(undefined, () => createDraft(
    db, SCHOOL, { title: 'T', essay: '' }, undefined, requirement))
  assert.equal(result.ok, false)
  assert.deepEqual(inserts, [], 'no row, not a downgraded one')
})

test('LEGACY COMPATIBILITY: a general create is byte-for-byte what it was', async () => {
  const { db, inserts } = insertingDb()
  await withFlag('on', () => createDraft(db, SCHOOL, { title: 'General', essay: 'Hi.' }))
  assert.deepEqual(inserts[0], { user_id: SCHOOL, title: 'General', essay: 'Hi.' })
})

test('LEGACY COMPATIBILITY: a prompt-backed create still writes prompt_id', async () => {
  const prompt = {
    promptId: REQUIREMENT, schoolId: SCHOOL, promptText: 'A question.', statedMaxWords: 500,
  }
  const { db, inserts } = insertingDb()
  const result = await withFlag('on', () => createDraft(
    db, SCHOOL, { title: 'School draft', essay: '' }, prompt))
  assert.equal(result.ok, true)
  assert.equal(inserts[0]!.prompt_id, REQUIREMENT)
  assert.equal(inserts[0]!.requirement_id, undefined, 'no requirement keys on this path')
  assert.equal(inserts[0]!.requirement_snapshot, undefined)
})

// ===================================================== the dialog

test('THE DIALOG ASKS THE CATALOG FIRST AND FALLS BACK SOFTLY', () => {
  assert.match(DIALOG, /const catalog = await fetch\(requirementsPath\(option\.id\)\)/)
  assert.match(DIALOG, /if \(outcome\.kind === 'ready'\) \{/)
  assert.match(DIALOG, /setStep\('requirement'\)/)
  // The prompt list runs when the catalog says fallback -- the catch does not
  // return, it falls through.
  const handler = DIALOG.slice(DIALOG.indexOf('const catalog = await fetch('),
    DIALOG.indexOf('const response = await fetch(promptsPath('))
  assert.match(handler, /\} catch \{/)
  assert.doesNotMatch(handler.slice(handler.indexOf('} catch {')), /setPromptNotice\(PICKER_MESSAGES\.failed\)/)
})

test('STARTING A DOCUMENT SENDS ONE ID AND NO SNAPSHOT', () => {
  assert.match(DIALOG, /const startRequirement = useCallback\(\(id: string\) => \{/)
  assert.match(DIALOG, /setRequirementId\(id\)/)
  assert.match(DIALOG, /body: JSON\.stringify\(requirementDraftRequest\(title, requirementId\)\)/)
  const request = requirementDraftRequest('  My draft  ', REQUIREMENT)
  assert.deepEqual(request, { title: 'My draft', requirementId: REQUIREMENT })
  assert.deepEqual(Object.keys(request).sort(), ['requirementId', 'title'])
})

test('a requirement and a prompt cannot both be held', () => {
  const start = DIALOG.slice(DIALOG.indexOf('const startRequirement'),
    DIALOG.indexOf('const showListedPrompts'))
  assert.match(start, /setPrompt\(null\)/)
  assert.match(start, /setPasted\(null\)/)
  // And choosing a school clears any requirement from the previous one.
  assert.match(DIALOG, /setRequirementSets\(null\)\s*\n\s*setRequirementId\(null\)/)
})

test('the general path clears a chosen requirement', () => {
  const general = DIALOG.slice(DIALOG.indexOf('const startGeneral'), DIALOG.indexOf('const startPaste'))
  assert.match(general, /setRequirementId\(null\)/)
})

test('THE OLDER PROMPT CATALOG STAYS REACHABLE from the checklist', () => {
  assert.match(DIALOG, /const showListedPrompts = useCallback\(/)
  assert.match(DIALOG, /onClick=\{\(\) => void showListedPrompts\(\)\}/)
  assert.match(DIALOG, /NEW_DRAFT_MESSAGES\.otherPrompts/)
})

test('BACK FROM THE TITLE RETURNS TO THE CHECKLIST, not the prompt list', () => {
  assert.match(DIALOG, /stepBeforeTitle\(\{ path, requirementId \}\)/)
  // And it unchooses the document, so the cards read Start again.
  assert.match(DIALOG, /if \(before === 'requirement'\) setRequirementId\(null\)/)
})

test('the checklist renders through the SAME component as the preview', () => {
  assert.match(DIALOG, /import RequirementChecklist from '\.\/RequirementChecklist'/)
  assert.match(DIALOG, /view=\{checklistView\(\{ set, drafts: \[\] \}\)\}/)
  // No draft exists yet, so every card is Start.
  assert.match(DIALOG, /drafts: \[\]/)
})

test('ONE DOCUMENT IS STARTED, NEVER A SCHOOL’S WHOLE SET', () => {
  // onStart takes one id. There is no loop over requirements that creates.
  assert.match(DIALOG, /onStart: startRequirement/)
  const start = DIALOG.slice(DIALOG.indexOf('const startRequirement'),
    DIALOG.indexOf('const showListedPrompts'))
  assert.doesNotMatch(start, /\.map\(|forEach|for \(/)
  assert.doesNotMatch(start, /fetch\(/)
})

// ===================================================== the flow parser

test('ROLLOUT OFF AND EVERY FAILURE FALL BACK TO THE PROMPT LIST', () => {
  const base = { schoolId: SCHOOL, schoolName: 'A School' }
  for (const status of [404, 500, 401, 403, 204]) {
    assert.deepEqual(requirementStepFrom({ ...base, status, body: { sets: [] } }),
      { kind: 'fallback' }, String(status))
  }
  for (const body of [null, undefined, 'string', 7, [], {}, { sets: null }, { sets: 'nope' }]) {
    assert.deepEqual(requirementStepFrom({ ...base, status: 200, body }), { kind: 'fallback' },
      JSON.stringify(body) ?? 'undefined')
  }
  // An empty catalog is a fallback too: the school has none researched.
  assert.deepEqual(requirementStepFrom({ ...base, status: 200, body: { sets: [] } }),
    { kind: 'fallback' })
})

test('a set for ANOTHER SCHOOL is dropped', () => {
  const body = {
    sets: [{
      id: 'set-1',
      schoolId: '99999999-9999-4999-8999-999999999999',
      requirements: [{ id: 'r1', label: 'L', promptText: 'q' }],
    }],
  }
  assert.deepEqual(
    requirementStepFrom({ status: 200, body, schoolId: SCHOOL, schoolName: 'A School' }),
    { kind: 'fallback' })
})

test('a set with no readable document is dropped', () => {
  const body = { sets: [{ id: 'set-1', schoolId: SCHOOL, requirements: [{ id: 'r1' }] }] }
  assert.deepEqual(
    requirementStepFrom({ status: 200, body, schoolId: SCHOOL, schoolName: 'A School' }),
    { kind: 'fallback' })
})

test('A GOOD RESPONSE SURVIVES THE WIRE, constraints and all', () => {
  const body = {
    sets: [{
      id: 'set-1',
      schoolId: SCHOOL,
      applicationCycle: '2026-2027',
      verification: {
        status: 'verified', sourceUrl: 'https://example.edu', verifiedOn: '2026-10-02',
        verbatim: true,
      },
      originalText: 'the research text',
      notes: ['a note'],
      requirements: [{
        id: 'r1',
        label: 'Personal Statement',
        promptText: 'Address the following.',
        documentType: 'personal-statement',
        components: [{ id: 'q1', text: 'one', optional: false },
          { id: 'q2', text: 'two', optional: true }],
        constraints: {
          words: wordLimit({ min: null, max: 1000, enforcement: 'enforced' }),
          characters: characterLimit({ min: null, max: 2500, spacesCount: true, enforcement: 'enforced' }),
          pages: pageLimit({ min: null, max: 2, spacing: 'double', enforcement: 'enforced' }),
          typography: { fontSizePt: 12, fontFamily: 'Times New Roman', marginsInches: 1 },
          citation: { family: 'apa', statedAs: 'APA 7th edition', minReferences: 3 },
          otherInstructions: ['no cover page'],
        },
        choiceGroup: null,
        optional: false,
        displayOrder: 0,
        notes: [],
      }],
    }],
  }
  const outcome = requirementStepFrom({
    status: 200, body, schoolId: SCHOOL, schoolName: 'A School',
  })
  assert.equal(outcome.kind, 'ready')
  if (outcome.kind !== 'ready') return
  const set = outcome.sets[0]!
  // THE SCHOOL NAME IS STAMPED BY THE CLIENT, not read from the response.
  assert.equal(set.schoolName, 'A School')
  assert.equal(set.schoolId, SCHOOL)
  assert.equal(set.applicationCycle, '2026-2027')
  assert.equal(set.verification.status, 'verified')
  const requirement = set.requirements[0]!
  assert.equal(requirement.components.length, 2)
  assert.deepEqual(requirement.constraints.words,
    { min: null, max: 1000, enforcement: 'enforced', statedAs: null })
  assert.deepEqual(requirement.constraints.characters,
    { min: null, max: 2500, spacesCount: true, enforcement: 'enforced', statedAs: null })
  assert.deepEqual(requirement.constraints.pages,
    { min: null, max: 2, spacing: 'double', enforcement: 'enforced', statedAs: null })
  assert.equal(requirement.constraints.typography?.fontFamily, 'Times New Roman')
  assert.equal(requirement.constraints.citation?.statedAs, 'APA 7th edition')
  assert.deepEqual([...requirement.constraints.otherInstructions], ['no cover page'])
})

test('AN UNRECOGNISED VERIFICATION STATUS OVER THE WIRE DEGRADES TO UNVERIFIED', () => {
  const body = {
    sets: [{
      id: 'set-1', schoolId: SCHOOL,
      verification: { status: 'super-verified', sourceUrl: 'https://x', verifiedOn: '2026-10-02' },
      requirements: [{ id: 'r1', label: 'L', promptText: 'q' }],
    }],
  }
  const outcome = requirementStepFrom({
    status: 200, body, schoolId: SCHOOL, schoolName: 'A School',
  })
  assert.equal(outcome.kind, 'ready')
  if (outcome.kind !== 'ready') return
  assert.equal(outcome.sets[0]!.verification.status, 'unverified')
})

test('the path encodes its query value', () => {
  assert.equal(requirementsPath(SCHOOL), `/api/statement/requirements?schoolId=${SCHOOL}`)
  assert.match(requirementsPath('a b&c=d'), /schoolId=a%20b%26c%3Dd/)
})

test('Create is closed without a title or a chosen document', () => {
  assert.equal(canCreateRequirementNow({ title: 'T', requirementId: REQUIREMENT, submitting: false }), true)
  assert.equal(canCreateRequirementNow({ title: '  ', requirementId: REQUIREMENT, submitting: false }), false)
  assert.equal(canCreateRequirementNow({ title: 'T', requirementId: null, submitting: false }), false)
  assert.equal(canCreateRequirementNow({ title: 'T', requirementId: REQUIREMENT, submitting: true }), false)
})
