import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Import's privacy and enforcement guarantees, asserted against the source.
 *
 * Two of them cannot be reached any other way: that the limit is decided before
 * anything expensive runs, and that nothing of the uploaded document is kept.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ROUTE = strip(read('../../../app/api/resume-v2/import/route.ts'))
const BODY = ROUTE.replace(/^import[\s\S]*?from\s+'[^']+'\s*$/gm, '')
const DOCX_ROUTE = strip(read('../../../app/api/resume-v2/export/docx/route.ts'))
const MIGRATION = read('../../../supabase/migrations/20260910_005_resume_imports.sql')

// ----------------------------------------- the limit, before the cost

test('the resume limit is decided before extraction or the model', () => {
  // Scoped to the analyse handler: the check itself now lives in a shared
  // helper both steps call, so an index into the whole file would find its
  // definition rather than its use.
  const analyse = BODY.slice(BODY.indexOf('async function analyseImport'), BODY.indexOf('async function confirmImport'))
  const limit = analyse.indexOf('roomForAnother')
  assert.ok(limit >= 0, 'the import does not enforce the resume limit')
  for (const later of ['extractSource', 'openai.chat.completions.create', 'buildImportPlan']) {
    assert.ok(analyse.indexOf(later) > limit, `${later} runs before the limit is checked`)
  }
  assert.ok(BODY.includes('decideCreateResume'), 'the limit is not taken from the entitlement rules')
})

test('a slot is consumed only on explicit confirmation', () => {
  // Analysis creates nothing at all; confirmation is the one path that does.
  const analyse = BODY.slice(BODY.indexOf('async function analyseImport'), BODY.indexOf('async function confirmImport'))
  assert.equal(analyse.includes('createResumeRows('), false, 'analysis consumes a slot')
  assert.equal((BODY.match(/createResumeRows\(/g) ?? []).length, 1, 'more than one creation path')

  const confirm = BODY.slice(BODY.indexOf('async function confirmImport'), BODY.indexOf('async function roomForAnother'))
  assert.ok(confirm.indexOf('buildImportPlan') < confirm.indexOf('createResumeRows('),
    'a resume is created before it is verified')
})

test('deduplication saves an AI call without bypassing the limit', () => {
  const analyse = BODY.slice(BODY.indexOf('async function analyseImport'), BODY.indexOf('async function confirmImport'))
  const limit = analyse.indexOf('roomForAnother')
  const dedupe = analyse.indexOf('priorImport')
  const call = analyse.indexOf('openai.chat.completions.create')
  assert.ok(limit >= 0 && limit < dedupe, 'a duplicate import skips the limit check')
  assert.ok(dedupe < call, 'the model runs before the duplicate check')
})

test('a fingerprint lookup is scoped to the caller', () => {
  const fn = BODY.slice(BODY.indexOf('async function priorImport'))
  assert.match(fn, /\.eq\('user_id', userId\)/, 'the lookup is not scoped to the caller')
  assert.match(fn, /document_fingerprint/)
})

// ------------------------------------------------------ nothing kept

test('the route writes no file anywhere', () => {
  for (const forbidden of ['storage', 'Bucket', 'writeFile', 'createWriteStream', 'fs.']) {
    assert.equal(ROUTE.includes(forbidden), false, `the import route uses ${forbidden}`)
  }
})

test('the ledger stores metadata, never content', () => {
  // SQL comments stripped first: the migration's own prose explains that it
  // cannot reconstruct content, and searching raw text finds the sentence
  // rather than a column.
  const columns = MIGRATION.slice(
    MIGRATION.indexOf('create table if not exists public.resume_imports'),
    MIGRATION.indexOf(');')
  ).replace(/--.*$/gm, '')
  for (const forbidden of ['bytes', 'file_data', 'content', 'extracted_text', 'raw_text', 'prompt', 'storage_key', 'bytea']) {
    assert.equal(columns.includes(forbidden), false, `the ledger stores "${forbidden}"`)
  }
  assert.ok(columns.includes('document_fingerprint'), 'no fingerprint to deduplicate on')
})

test('only the fingerprint is sent to the ledger, never the text', () => {
  const record = BODY.slice(BODY.indexOf('async function record('))
  assert.match(record, /p_fingerprint:\s*fingerprint/)
  for (const forbidden of ['source.text', 'source.lines', 'organisedRaw']) {
    assert.equal(record.includes(forbidden), false, `the ledger receives ${forbidden}`)
  }
})

test('the ledger is readable only by its owner', () => {
  assert.match(MIGRATION, /for select using \(auth\.uid\(\) = user_id\)/)
  // No insert, update or delete policy: a client that could delete a row could
  // erase the record of what it uploaded.
  assert.equal(/for (insert|update|delete)/i.test(MIGRATION.replace(/grant[^;]*;/gi, '')), false)
  assert.match(MIGRATION, /security definer/)
})

test('there is no unique constraint across users', () => {
  // A resume template two people upload must not tell either about the other.
  assert.equal(/unique[^\n]*document_fingerprint/i.test(MIGRATION), false)
})

// ------------------------------------------- re-import after cancelling

test('an abandoned review leaves the document re-importable', () => {
  // Analysis settles the row as 'attempted'. `priorImport` matches only
  // 'created', so walking away from a review blocks nothing.
  const analyse = BODY.slice(BODY.indexOf('async function analyseImport'), BODY.indexOf('async function confirmImport'))
  assert.match(analyse, /outcome:\s*'attempted'/, 'analysis settles as something other than attempted')
  assert.equal(analyse.includes("outcome: 'created'"), false, 'analysis marks the import created')

  const prior = BODY.slice(BODY.indexOf('async function priorImport'))
  assert.match(prior, /\.eq\('outcome', 'created'\)/)
})

test('a failed creation leaves the row attempted, not created', () => {
  const confirm = BODY.slice(BODY.indexOf('async function confirmImport'), BODY.indexOf('async function roomForAnother'))
  const failure = confirm.slice(confirm.indexOf('if (!created.ok)'), confirm.indexOf('await settle'))
  assert.equal(failure.includes("'created'"), false, 'a failed creation was recorded as created')
})

test('deleting the imported resume re-opens the document for import', () => {
  // The FK sets resume_id to null, and the lookup requires it to be present.
  assert.match(MIGRATION, /resume_id[^\n]*on delete set null/)
  const prior = BODY.slice(BODY.indexOf('async function priorImport'))
  assert.match(prior, /\.not\('resume_id', 'is', null\)/)
})

test('a refused or failed import can be retried', () => {
  // Neither outcome matches the dedupe filter.
  const prior = BODY.slice(BODY.indexOf('async function priorImport'))
  for (const outcome of ['refused', 'failed', 'attempted']) {
    assert.equal(prior.includes(`'${outcome}'`), false, `the dedupe blocks on ${outcome}`)
  }
})

test('the duplicate message points at Duplicate rather than a dead end', () => {
  const message = ROUTE.slice(ROUTE.indexOf('duplicate: true'), ROUTE.indexOf('const importId'))
  assert.match(message, /Duplicate/, 'the applicant is told to import again or nothing')
})

// --------------------------------------------------------- hardening

test('the format is decided by signature, and the size capped', () => {
  assert.ok(BODY.includes('checkUpload'), 'no signature check')
  assert.ok(BODY.includes('MAX_UPLOAD_BYTES'), 'no size cap')
  assert.ok(BODY.includes('withTimeout'), 'no parse timeout')
  // MIME and filename are never trusted.
  assert.equal(/file\.type|file\.name/.test(BODY), false, 'the route trusts the browser’s label')
})

test('a scan is refused, never OCR’d', () => {
  assert.ok(BODY.includes('IMAGE_ONLY_CODE'))
  for (const forbidden of ['tesseract', 'ocr', 'OCR']) {
    assert.equal(ROUTE.includes(forbidden), false, `the import route reaches for ${forbidden}`)
  }
})

test('no import or export path uses the service role', () => {
  for (const [name, text] of [['import', ROUTE], ['docx', DOCX_ROUTE]] as const) {
    assert.equal(/SERVICE_ROLE|service_role/.test(text), false, `${name} uses the service role`)
  }
})

test('the rate ceiling applies, and never reads as a quota', () => {
  assert.ok(BODY.includes('checkAiRate'))
  assert.ok(BODY.indexOf('rateDecision') < BODY.indexOf('openai.chat.completions.create'))
  for (const word of ['upgrade', 'quota', 'allowance', 'remaining']) {
    assert.equal(ROUTE.toLowerCase().includes(word), false, `the import route says "${word}"`)
  }
})

// ------------------------------------------------------- DOCX export

test('DOCX export is gated by the same entitlement as PDF', () => {
  assert.ok(DOCX_ROUTE.includes('decideExport'), 'DOCX export is ungated')
  assert.match(DOCX_ROUTE, /decideExport\(auth\.tier\)/, 'the tier does not come from the session')
  assert.equal(/body\.(tier|plan|isUltimate)/.test(DOCX_ROUTE), false)
  assert.ok(DOCX_ROUTE.includes("'not-found'"))
})
