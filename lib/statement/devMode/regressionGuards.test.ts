/**
 * The fixes that are expensive to lose.
 *
 * WHY THEY ARE ASSERTED TOGETHER, AWAY FROM THEIR OWN SUITES. Each of these was
 * found by a person using the product and costing a session to diagnose, and
 * every one of them is INVISIBLE when it breaks: a flag that reads off, a row
 * that parses as null, a column that is not selected, a guard that stops
 * throwing. None produces an error anybody would notice in review -- the screen
 * simply stops offering something.
 *
 * So this file is a list of "these specifically", with the symptom recorded
 * beside each. A failure here names the regression rather than a test number.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'development'
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fixture.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'fixture-anon-key'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('1. prompt submissions read as ON in simulated-live', async () => {
  // SYMPTOM: the applicant picks a school with no prompt, presses "Add your
  // school prompt", and the route answers 404. Reads as a missing feature.
  const { promptSubmissionsEnabled } = await import('../draft/rollout.ts')
  assert.equal(
    promptSubmissionsEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), true)
  assert.equal(
    promptSubmissionsEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), false)
})

test('2. every rollout helper respects the env it is given', async () => {
  // SYMPTOM: a test asserting the production answer passes or fails depending
  // on which process runs it, because half the decision read process.env.
  const rollout = await import('../draft/rollout.ts')
  const production = { NODE_ENV: 'production' } as NodeJS.ProcessEnv
  for (const [name, fn] of [
    ['promptSubmissionsEnabled', rollout.promptSubmissionsEnabled],
    ['requirementsEnabled', rollout.requirementsEnabled],
    ['submissionFieldsEnabled', rollout.submissionFieldsEnabled],
  ] as const) {
    assert.equal(fn(production), false, `${name} ignored the supplied env`)
    assert.equal(fn({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), true, name)
  }
  // The cache flag has no development branch, deliberately: it is the one the
  // owner forbids turning on.
  assert.equal(
    rollout.analysisCacheEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), false)
})

test('3. a pasted-prompt draft row PARSES', async () => {
  // SYMPTOM: create returns 500 after writing both rows, and the editor can
  // never open the draft. The parser's three-state rule refused a row whose
  // only id was a submission id.
  const { draftFromRow } = await import('../draft/rows.ts')
  const parsed = draftFromRow({
    id: '11111111-1111-4111-8111-111111111111',
    user_id: '22222222-2222-4222-8222-222222222222',
    title: 'T', essay: '', revision: 1,
    created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z',
    school_id: '33333333-3333-4333-8333-333333333333',
    prompt_id: null,
    prompt_text: 'The question the applicant pasted.',
    stated_max_words: 750,
    requirement_id: null,
    requirement_snapshot: null,
    prompt_submission_id: '44444444-4444-4444-8444-444444444444',
  } as never)
  assert.ok(parsed, 'a pasted draft is unreadable again')
  assert.equal(parsed!.promptText, 'The question the applicant pasted.')
  assert.equal(parsed!.promptId, null, 'a pasted draft must claim no catalog prompt')
})

test('3b. and the row with NO id at all is still refused', async () => {
  // The guarantee the fix had to keep: nothing can say where that question came
  // from, so the row is refused rather than displayed as though vouched for.
  const { draftPromptFrom } = await import('../draft/rows.ts')
  assert.equal(draftPromptFrom({
    schoolId: '33333333-3333-4333-8333-333333333333',
    promptId: null, promptText: 'Orphan wording.', statedMaxWords: null,
    requirementId: null, promptSubmissionId: null,
  }), undefined)
  // And a row claiming TWO sources is refused as two claims about one question.
  assert.equal(draftPromptFrom({
    schoolId: '33333333-3333-4333-8333-333333333333',
    promptId: null, promptText: 'Two claims.', statedMaxWords: null,
    requirementId: '55555555-5555-4555-8555-555555555555',
    promptSubmissionId: '44444444-4444-4444-8444-444444444444',
  }), undefined)
})

test('4. the draft projection selects prompt_submission_id', () => {
  // SYMPTOM: the parser accepts a pasted row, but the column is never fetched,
  // so it sees "not pasted", finds no id and refuses it anyway.
  const repo = read('../draft/draftRepo.ts')
  assert.match(repo, /prompt_submission_id/)
  // THE RULE, NOT THE EXACT EXPRESSION. The projection gained a third flagged
  // segment when 013 added the editor document, so the variable the ternary
  // reads is no longer literally `base`.
  assert.match(repo, /promptSubmissionsEnabled\(\)\s*\n?\s*\? `\$\{base\}, prompt_submission_id`/)
})

test('5. the admin service-role path is guarded locally', () => {
  // SYMPTOM: reviewing LOCAL submissions reads production, and Approve writes
  // it. The admin route built its service-role client inline.
  const route = read('../../../app/api/admin/statement-prompts/route.ts')
  // THE HELPER, NOT ITS ARGUMENT TEXT. The key is now optional in development
  // -- it is what the local branch never reads -- so the call passes
  // `serviceKey ?? ''` and pinning the exact text would pin that detail rather
  // than the property.
  assert.match(route, /statementAdminClient\(serviceKey/)
  // AND THE KEY IS ONLY DEMANDED WHERE IT IS USED.
  assert.match(route, /if \(!serviceKey && !simulatedLiveEnabled\(\)\) \{/)
  assert.doesNotMatch(route, /createClient\(/, 'the admin route builds its own client again')
  const guarded = read('./guardedClient.ts')
  assert.match(guarded, /export function statementAdminClient\(/)
})

test('6. an applicant cannot read another applicant\'s submission', async () => {
  // SYMPTOM: listOwnSubmissions sends no submitted_by filter -- correctly,
  // because RLS supplies it -- so a local store without the predicate hands
  // one applicant everybody else's rows.
  const source = read('./localSubmissions.ts')
  assert.match(source, /readAll\(\)\.filter\(\(row\) => row\.submitted_by === this\.caller\.userId\)/)
  // And the two columns an applicant holds no grant on are removed, not nulled.
  assert.match(source, /review_note: _note, reviewed_by: _reviewer/)
})

test('7. a user-provided prompt stays provenance `user`', async () => {
  const { provenanceOf } = await import('../draft/promptSubmission.ts')
  // A pasted prompt has no catalog text to agree with, so it can never be
  // 'catalog' however the draft row is labelled.
  assert.equal(provenanceOf({ promptText: 'Pasted.', catalogText: null }), 'user')
  assert.equal(provenanceOf({ promptText: 'Pasted.', catalogText: 'Something else.' }), 'user')
})

test('8. a requirement-backed draft request still sends essay: \'\'', async () => {
  // SYMPTOM: "That draft could not be created." The dialog omitted the key and
  // the route refused the body with invalid-essay.
  const { requirementDraftRequest } = await import('../requirements/newDraftFlow.ts')
  const built = requirementDraftRequest('A title', '55555555-5555-4555-8555-555555555555')
  assert.deepEqual(Object.keys(built).sort(), ['essay', 'requirementId', 'title'])
  assert.equal(built.essay, '')
})

test('9. the simulated-live write guard still refuses every production write',
  async () => {
    const { statementDbClient } = await import('./guardedClient.ts')
    const { SimulatedLiveWriteBlocked } = await import('./gate.ts')
    const db = statementDbClient('token', { userId: 'u', isAdmin: false })
    for (const table of ['statement_analyses', 'resume_ai_usage', 'statement_prompts',
      'statement_requirement_sets', 'statement_requirements',
      'statement_prompt_submissions']) {
      for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
        assert.throws(
          () => (db.from(table) as unknown as Record<string, () => unknown>)[operation]!(),
          SimulatedLiveWriteBlocked, `${table}.${operation}`)
      }
    }
    // Only the four reviewed submission functions are callable; everything else
    // still stops here.
    for (const fn of ['record_ai_usage', 'settle_ai_usage',
      'claim_statement_analysis', 'settle_statement_analysis', 'anything_new']) {
      assert.throws(() => db.rpc(fn), SimulatedLiveWriteBlocked, fn)
    }
  })

test('10. the analysis path still spends nothing it should not', () => {
  // The invariants from the analyzer work, restated where they are cheap to
  // check: the ledger is not written locally, and the local store is consulted
  // before the model.
  const route = read('../../../app/api/statement/drafts/[id]/analyze/route.ts')
  assert.match(route, /const usageId = simulated\s*\n\s*\? null/)
  assert.ok(route.indexOf('localAnalysisFor(id, fingerprint)')
    < route.indexOf('openai.chat.completions.create'))
  assert.equal(route.includes('mockReview'), false, 'the deterministic stub is back')
})

test('11. nothing creates an ACTIVE catalog row', () => {
  // The property the whole promotion design rests on. Both canonical tables
  // default is_active to TRUE, so every writer has to say false explicitly.
  // 20261006_009 WAS WITHDRAWN BEFORE IT WAS EVER APPLIED and is replaced by
  // 20261015_017, which adds the two evidence columns 011 introduced. The
  // property asserted here is unchanged: the promotion RPC writes is_active
  // false explicitly, in both of its inserts, so no payload can publish a row
  // to applicants merely by creating it.
  const sql = read('../../../supabase/migrations/20261015_017_statement_submission_promotion.sql')
  const local = read('./localCanonical.ts')
  // Two inserts, each with an explicit false in its value list.
  assert.equal((sql.match(/is_active,/g) ?? []).length, 2)
  assert.match(local, /is_active: false,[\s\S]{0,400}display_order: int\(input\.set\.display_order\)/)
  /*
   * THE PROMOTION PATH WRITES false LITERALLY; ONLY THE TOGGLE IS PARAMETERISED.
   *
   * promoteLocally() builds both rows with `is_active: false` spelled out, so no
   * payload can carry a true through it. The only code that can write true is
   * setActive(), which takes the value as an argument and is reachable from
   * exactly two exported functions -- the deliberate local-preview toggle.
   *
   * Split at the toggle rather than counted, because activation legitimately
   * flips the set AND each of its documents.
   */
  const boundary = local.indexOf('export function simulateActivation')
  assert.ok(boundary > 0, 'simulateActivation was renamed; fix this boundary')
  /*
   * COUNTED ON CODE, NOT ON PROSE. The module's comments necessarily say
   * "`is_active: false` is spelled out in both inserts", and counting raw text
   * made the guard fail the moment that sentence was written -- a failure about
   * a comment, not about a write.
   */
  const code = local
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const promotion = code.slice(0, code.indexOf('export function simulateActivation'))
  assert.ok(promotion.length > 0, 'the stripper removed the module')
  assert.equal(promotion.includes('is_active: true'), false,
    'the creation path writes an active row')
  assert.equal((promotion.match(/is_active: false/g) ?? []).length, 2,
    'the two created rows are no longer both written inactive')

  const toggle = local.slice(boundary)
  // The toggle is the only parameterised write, and it is gated on `active`.
  assert.match(toggle, /is_active: active/)
  assert.match(toggle, /function setActive\(setId: string, active: boolean\)/)
  // Activating still enforces production's own condition; deactivating does not
  // need to, because is_active = false satisfies the constraint either way.
  assert.match(toggle, /if \(active\) \{[\s\S]{0,200}activationShortfall\(set\)/)
  assert.equal(code.includes('is_active: true'), false,
    'something writes a literal active row')
})
