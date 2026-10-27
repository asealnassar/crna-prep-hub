/**
 * The audit trail between what production holds and what we want it to hold.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TEST AND NOT A COMMENT
 * ---------------------------------------------------------------------------
 * The catalog was imported into production, then the research previews were
 * corrected and the generator re-run, OVERWRITING the package production had
 * actually run. The original was never committed, so for a while the repository
 * held one import package and quietly implied it was both things at once -- and
 * its postcheck asserted a state production did not have.
 *
 * The frozen baseline closes that. These assertions keep it closed: a
 * regeneration that dropped the banner, or a baseline edited to match the
 * current state, fails here rather than at a Supabase SQL prompt.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const BASELINE = 'supabase/manual/catalog_import_baseline'
const GENERATED = 'supabase/manual'
const sha = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

/** The package production actually ran. These values may never change. */
const BASELINE_SHA: Readonly<Record<string, string>> = {
  'statement_requirements_catalog_import.sql':
    '45e53ea2e7bd06ff336a25b37c6ac8eac11306ad8188241699c040d5a9d34dae',
  'statement_requirements_catalog_import_preflight.sql':
    'ceeced9356e7b9bcfa632f24035ffecfa1e96797fac7a8961560d7c4ca57c516',
  'statement_requirements_catalog_import_postcheck.sql':
    '612097ee2550459904e878b33df3b190fd3400cf09022f60d616c0c870cbf680',
  'statement_requirements_catalog_import_MANIFEST.md':
    '4f40a86d9f5de0b153babcacacf6e9bd053f0d97530a2278e9e512d41b0459c6',
}

test('THE BASELINE IS FROZEN', () => {
  // It is a record of what was executed. If it changes, the record is lost and
  // there is nothing left to compare production against.
  for (const [name, expected] of Object.entries(BASELINE_SHA)) {
    assert.equal(sha(`${BASELINE}/${name}`), expected, `${name} was modified`)
  }
})

test('the baseline input is kept, so the package can be re-derived', () => {
  // The generator is deterministic. Keeping its input means the baseline can be
  // rebuilt and checked, which is the only reason the reproduction is credible.
  assert.equal(
    sha(`${BASELINE}/12_statement_requirements_preview.baseline.csv`),
    '10ba99d9c8c9c067dcba88677c4d83f88741c7fda7f08504aa6654cb7c8ac9e4')
})

test('THE BASELINE AND THE GENERATED PACKAGE ARE NOT THE SAME FILE', () => {
  // The whole hazard in one assertion: if these ever match, either the
  // correction was reverted or the baseline was overwritten by a regeneration.
  for (const name of Object.keys(BASELINE_SHA)) {
    assert.notEqual(sha(`${GENERATED}/${name}`), sha(`${BASELINE}/${name}`), name)
  }
})

test('every generated artifact says it is NOT what production ran', () => {
  // Emitted by the generator, so a rebuild cannot drop it.
  for (const name of ['statement_requirements_catalog_import.sql',
    'statement_requirements_catalog_import_preflight.sql',
    'statement_requirements_catalog_import_postcheck.sql']) {
    const text = readFileSync(`${GENERATED}/${name}`, 'utf8')
    assert.match(text, /NOT THE PACKAGE PRODUCTION RAN/, name)
    assert.match(text, /DO NOT RUN THIS AGAINST PRODUCTION/, name)
    assert.match(text, /MIGRATION_STATUS\.md/, name)
  }
})

test('THE IMPORT REALLY CANNOT OVERWRITE, AND THE BANNER SAYS SO ACCURATELY', () => {
  /*
   * The documentation claimed a rerun would "rewrite every row and discard
   * activation state". It would not. The import stages into TEMP tables and
   * refuses a non-empty catalog before either statement that writes to public,
   * and carries no ON CONFLICT, DELETE, TRUNCATE or UPDATE at all -- so a
   * rerun inserts nothing and rolls back.
   *
   * ASSERTED ON THE SQL, because the rule "never rerun the import" survives
   * only if its stated reason is the true one. A wrong reason points an
   * operator at the wrong fix -- here, at emptying the tables so it "works".
   */
  for (const path of [`${GENERATED}/statement_requirements_catalog_import.sql`,
    `${BASELINE}/statement_requirements_catalog_import.sql`]) {
    const sql = readFileSync(path, 'utf8')
    const code = sql.split('\n').filter((line) => !line.trim().startsWith('--'))
    const body = code.join('\n')

    // No merge, no overwrite, no removal -- in the executable text only.
    assert.doesNotMatch(body, /on conflict/i, `${path}: an upsert appeared`)
    assert.doesNotMatch(body, /^\s*delete\s+from/im, `${path}: a delete appeared`)
    assert.doesNotMatch(body, /truncate\s+(table|only|public\.)/i, path)
    assert.doesNotMatch(body, /^\s*update\s+public\./im, path)

    // The empty-catalog guard, and that it fires BEFORE anything is written.
    assert.match(body, /the catalog must be EMPTY|already holds %s row\(s\)/)
    const refuse = body.indexOf('IMPORT REFUSED')
    const write = body.indexOf('insert into public.')
    assert.notEqual(refuse, -1, `${path}: no refusal`)
    assert.notEqual(write, -1, `${path}: no write`)
    assert.ok(refuse < write, `${path}: the guard must precede the first write`)
  }

  // And the banner states that reason rather than the wrong one.
  const banner = readFileSync(
    `${GENERATED}/statement_requirements_catalog_import.sql`, 'utf8')
  assert.match(banner, /THIS IMPORT CANNOT OVERWRITE ANYTHING/)
  assert.match(banner, /requires an EMPTY catalog|EMPTY catalog/)
  assert.doesNotMatch(banner, /would rewrite every row/)
})

test('and the baseline does NOT, because it is what production ran', () => {
  const text = readFileSync(`${BASELINE}/statement_requirements_catalog_import.sql`, 'utf8')
  assert.doesNotMatch(text, /NOT THE PACKAGE PRODUCTION RAN/)
})

test('THE STATUS FILE RECORDS 007 AS APPLIED', () => {
  /*
   * The bookkeeping error this guards. 007 is applied to production; it sat
   * untracked on this branch for a long while, alongside 008 and 010-017,
   * which is a fact about the branch and not about the database. Reporting it
   * as pending invites someone to apply it twice.
   */
  const status = readFileSync('supabase/manual/MIGRATION_STATUS.md', 'utf8')
  const row = (name: string) =>
    status.split('\n').find((line) => line.includes(name)) ?? ''
  for (const applied of ['004_statement_analyses', '005_statement_requirements',
    '006_statement_requirement_length_register',
    '007_statement_requirement_document_types_and_pages']) {
    assert.match(row(applied), /\*\*APPLIED\*\*/, `${applied} must read as applied`)
  }
  for (const pending of ['008_statement_prompt_submission_requirement_fields',
    '010_statement_requirement_typography_options',
    '016_statement_draft_length_ceiling',
    '017_statement_submission_promotion']) {
    assert.match(row(pending), /NOT APPLIED/, `${pending} must read as pending`)
    assert.doesNotMatch(row(pending), /\*\*APPLIED\*\*/, pending)
  }
  /*
   * 009 IS NEITHER APPLIED NOR PENDING: it was withdrawn before any database
   * ran it, because its INSERT predated 011's evidence columns and would have
   * recorded an applicant's approved submission as an official source. It is
   * replaced by 017. The status file has to say WITHDRAWN rather than quietly
   * dropping the row, or a reader who remembers 009 cannot tell whether it was
   * applied, lost, or renamed.
   */
  const nine = row('009_statement_submission_promotion')
  assert.match(nine, /WITHDRAWN/)
  // AND THE INSTRUCTION, not merely the label. "WITHDRAWN" alone reads as
  // "superseded", which an operator working through a list may still apply.
  assert.match(nine, /MUST NEVER BE APPLIED/)
  assert.doesNotMatch(nine, /\*\*APPLIED\*\*/)
  assert.equal(
    existsSync('supabase/migrations/20261006_009_statement_submission_promotion.sql'),
    false, 'the withdrawn migration must not be on disk to be applied by accident')
  // AND 017 IS NAMED AS THE REPLACEMENT, so a reader who remembers 009 is told
  // where its work went rather than left to assume it was dropped.
  assert.match(row('017_statement_submission_promotion'),
    /replacement promotion migration/)
})

test('NOTHING IN THE REPOSITORY TELLS AN OPERATOR TO APPLY 009', () => {
  /*
   * The withdrawal is only as good as the last file that still names 009 as a
   * dependency. Three did -- 010, 011 and 012 each listed it in their header
   * sequence, and 011 went further and claimed 009 created the submission
   * table it references, which is false (20261002_000 does, and it is
   * applied). An operator reading those headers would have applied 009 first.
   *
   * So every surviving mention has to be ABOUT the withdrawal. This is a
   * structural assertion over the pending migrations, comments included,
   * because a comment is exactly where this went wrong.
   */
  const dir = 'supabase/migrations'
  const pending = readdirSync(dir).filter((name) =>
    /^2026(1006_008|1008_01[012]|1011_01[34]|1013_01[56]|1015_017)_statement/.test(name))
  assert.equal(pending.length, 9, `found ${pending.length} pending migrations, expected 9`)

  // Phrases that only make sense if 009 is being retired, not applied.
  const retiring =
    /withdraw|deleted|never|replaced|refuses|does not|used to|had yet|reason once|FUNCTION, not|nothing here relates/i
  for (const name of pending) {
    const text = readFileSync(`${dir}/${name}`, 'utf8')
    /*
     * 017 IS EXEMPT, AND SAYS WHY INSTEAD. It is the replacement, and its
     * header is several paragraphs of argument about what 009 did and why it
     * could not be edited in place -- so individual lines read as statements
     * about 009 while the passage is the withdrawal itself. Asserting
     * line-by-line there would force the prose to repeat "withdrawn" in every
     * sentence, which is how a real explanation gets replaced by a keyword.
     */
    if (/_017_/.test(name)) {
      assert.match(text, /THIS FILE REPLACES THE WITHDRAWN 20261006_009/)
      assert.match(text, /WHICH WAS NEVER APPLIED/)
      continue
    }
    for (const line of text.split('\n')) {
      // The resume series has its own, unrelated, applied 20260917_009.
      if (!/\b009\b/.test(line) || /20260917/.test(line)) continue
      assert.match(line, retiring,
        `${name} mentions 009 without retiring it: ${line.trim()}`)
    }
  }
})

test('THE ROLLOUT ORDER IS STAGED, AND THE STAGES ARE IN THIS ORDER', () => {
  /*
   * ---------------------------------------------------------------------------
   * THE ORDERING THIS ENFORCES, AND WHY EACH ONE IS LOAD-BEARING
   * ---------------------------------------------------------------------------
   * DEPLOY BEFORE THE RENAME. The name correction runs in the SQL editor and
   * the redirect ships in a build, so the two cannot be swapped together. Run
   * the SQL first and /schools/ceder-crest -- an indexed URL -- 404s for every
   * search result and saved link until the next deploy.
   *
   * 017 AFTER 008 AND 011. CREATE OR REPLACE FUNCTION checks a PL/pgSQL body
   * for syntax only, so a promotion function created before 011's evidence
   * columns applies cleanly and fails at the first promotion. 017 refuses in
   * SQL; this keeps the document agreeing with it.
   *
   * THE POSTCHECK BEFORE ANY FLAG. A capability flag must never be the thing
   * that discovers a bad migration -- switching one on is what makes a wrong
   * column reach an applicant. The document used to put the flags first.
   *
   * THE FLAGS BEFORE ACTIVATION. Activation is the only step an applicant can
   * observe, and it must not be bundled with enabling a read path.
   */
  const whole = readFileSync('supabase/manual/MIGRATION_STATUS.md', 'utf8')
  /*
   * SCOPED TO THE ROLLOUT SECTION. The correction files are also listed in the
   * catalog inventory further up, and an unscoped search finds that first --
   * which made this assertion compare an inventory row against a rollout
   * stage and fail for the wrong reason.
   */
  const sectionStart = whole.indexOf('## 7. The exact rollout order')
  const sectionEnd = whole.indexOf('## 8. The school-name correction')
  assert.ok(sectionStart > 0 && sectionEnd > sectionStart, 'the rollout section moved')
  const status = whole.slice(sectionStart, sectionEnd)
  const at = (needle: string) => {
    const index = status.indexOf(needle)
    assert.ok(index > 0, `the rollout order no longer contains: ${needle}`)
    return index
  }

  /*
   * THE CHRONOLOGY, NOT THE NUMBERING. An earlier draft called the two
   * preflights A1 and A2 while placing A2 after C0, so the document described
   * a stage that was both first and fifth. Stage A is the FOUNDATION preflight
   * and nothing else; the V2 preflight is the gate that closes C0 and lives in
   * C0-V. These positions are asserted so that contradiction cannot return.
   *
   * STAGE C0 EXISTS BECAUSE 008 CANNOT BE FIRST. The production Stage A
   * reconciliation on 2026-10-22 found 20261002_000..003 had never been
   * applied, and 008 and 012 add columns to the table 000 creates while 017
   * reads it. The foundation therefore precedes the V2 schema.
   */
  const preflight = at('Stage A — foundation preflight')
  const deploy = at('Stage B — deploy the compatible code')
  const foundation = at('Stage C0 — the prompt-submission foundation')
  const verify = at('Stage C0-V — foundation verification, and the V2 gate')
  const schema = at('Stage C1 — Statement Studio V2 schema, in this order')
  const corrections = at('Stage D — data corrections')
  const postcheck = at('Stage E — DATABASE POSTCHECK, before any capability is enabled')
  const flags = at('Stage F — capability enablement')
  const activation = at('Stage G — catalog activation')

  // A -> B -> C0 -> C0-V -> C1 -> D -> E -> F -> G, each edge named.
  assert.ok(preflight < deploy, 'the deploy precedes the foundation preflight')
  assert.ok(deploy < foundation, 'the foundation migrations precede the deploy')
  assert.ok(foundation < verify, 'the foundation is verified before it is applied')
  assert.ok(verify < schema, 'THE V2 SCHEMA BEGINS BEFORE THE FOUNDATION IS VERIFIED')
  assert.ok(schema < corrections, 'corrections before the schema')
  assert.ok(corrections < postcheck, 'the postcheck before the corrections')
  assert.ok(postcheck < flags, 'A CAPABILITY FLAG IS ENABLED BEFORE THE POSTCHECK')
  assert.ok(flags < activation, 'activation before the capabilities')

  /*
   * EACH PREFLIGHT IS NAMED IN EXACTLY ONE STAGE. The foundation preflight
   * belongs to A and the V2 preflight to C0-V; naming either in the other
   * stage is how the A1/A2 contradiction got written in the first place.
   */
  const stageA = status.slice(preflight, deploy)
  const stageC0V = status.slice(verify, schema)
  assert.match(stageA, /statement_foundation_preflight\.sql/)
  assert.doesNotMatch(stageA, /statement_v2_rollout_preflight\.sql/,
    'the V2 preflight is listed in Stage A, which cannot run it')
  assert.match(stageC0V, /statement_v2_rollout_preflight\.sql/)
  // C0-V is the gate, so it must demand a clean result in both registers.
  assert.match(stageC0V, /0 FAIL and 0 WARN/)

  // The deploy precedes the rename, and the document says so in words too.
  assert.ok(deploy < at('statement_school_name_corrections.sql'),
    'the school-name SQL is listed before the deploy that makes it safe')
  assert.match(whole, /STAGE B MUST BE DEPLOYED BEFORE D3/)

  // 017 names its two predecessors.
  const seventeen = status.slice(at('| C9 | `20261015_017`'), at('| C9 | `20261015_017`') + 200)
  assert.match(seventeen, /C1 \(008\)/)
  assert.match(seventeen, /C3 \(011\)/)

  // The foundation's four are spelled out too, and 003 is last -- it installs
  // with only 000 present and then fails at run time without 001 and 002.
  for (const migration of ['20261002_000', '20261002_001', '20261002_002', '20261002_003']) {
    assert.ok(status.includes(migration), `Stage C0 does not name ${migration}`)
  }
  assert.ok(status.indexOf('20261002_003') > status.indexOf('20261002_000'),
    '003 is listed before 000, which would install a broken RPC')

  // Every migration is spelled out as its own step -- no "any order".
  for (const migration of ['20261006_008', '20261008_010', '20261008_011',
    '20261008_012', '20261011_013', '20261011_014', '20261013_015',
    '20261013_016', '20261015_017']) {
    assert.ok(status.includes(`| \`${migration}\``),
      `${migration} is not spelled out as its own step`)
  }
  assert.doesNotMatch(whole, /may be applied in any order/,
    'the order must document ONE path')

  // And the postcheck requirement is stated as a stop, not a preference.
  assert.match(whole, /STOP WITH ALL TEN CAPABILITIES STILL OFF/)
})

test('ALL TEN CAPABILITIES ARE DOCUMENTED, AND THE SET IS READ FROM THE CODE', () => {
  /*
   * SOURCE-DERIVED, because the gap this closes was a document naming two of
   * ten. Followed literally it would have left five migrations applied but
   * inert and Analyze permanently 503.
   */
  const rollout = readFileSync('lib/statement/draft/rollout.ts', 'utf8')
  const flags = [...rollout.matchAll(/^export const [A-Z_]+_ENV = '([A-Z_]+)'$/gm)]
    .map((match) => match[1]!)
  assert.equal(flags.length, 10, `rollout.ts defines ${flags.length} flags, expected 10`)

  const status = readFileSync('supabase/manual/MIGRATION_STATUS.md', 'utf8')
  const missing = flags.filter((flag) => !status.includes(flag))
  assert.deepEqual(missing, [],
    `the rollout document does not account for: ${missing.join(', ')}`)

  // Each one is a row in the capability table, with all five columns filled.
  for (const flag of flags) {
    const row = status.split('\n').find((line) =>
      line.startsWith(`| \`${flag}\``))
    assert.ok(row !== undefined, `${flag} has no row in the capability table`)
    assert.ok(row.split('|').length >= 7, `${flag}'s row is incomplete: ${row}`)
  }

  // THE AI FLAG IS TIED TO ITS FINDING, so it cannot be enabled casually.
  assert.match(status, /`STATEMENT_ANALYSIS_CACHE`[^|]*\|[^|]*\|[^|]*Analyze answers 503/)
  const aiSection = status.slice(status.indexOf('**F5**'), status.indexOf('**F5**') + 600)
  assert.match(aiSection, /AI-QA-005/)
  assert.match(aiSection, /separate, and last/)
})

test('009 NEVER APPEARS AS AN EXECUTABLE STEP', () => {
  const status = readFileSync('supabase/manual/MIGRATION_STATUS.md', 'utf8')
  // Not a row in the schema stage...
  for (const line of status.split('\n')) {
    if (!/^\| C\d /.test(line)) continue
    assert.ok(!line.includes('009'), `009 appears as a schema step: ${line}`)
  }
  // ...and the stage says so outright.
  assert.match(status, /IS WITHDRAWN AND IS NEVER APPLIED, at this stage or any/)
  // And it is still absent from disk.
  assert.equal(
    existsSync('supabase/migrations/20261006_009_statement_submission_promotion.sql'),
    false)
})

test('the runbook does not pass itself off as a record of state', () => {
  // It says 004-006 are unapplied, which was true when it was written and is
  // not true now. It may stay, because it is a procedure -- but it has to point
  // at the file that does record state.
  const runbook = readFileSync(
    'supabase/manual/STATEMENT_V2_ACTIVATION_RUNBOOK.md', 'utf8')
  assert.match(runbook, /MIGRATION_STATUS\.md/)
  assert.match(runbook, /now APPLIED to\s*\n?>?\s*production/)
})
