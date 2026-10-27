/**
 * The development-only catalog review: the gate, the payload, and the promise
 * that looking at it cannot change anything.
 *
 * THE RISK THIS FILE IS ABOUT. Production holds 63 inactive requirement sets.
 * A review screen that showed them is harmless; a review screen that LEAKED
 * them, or that quietly showed something else and let somebody sign off on the
 * wrong content, is not. So the tests below are in two groups: the gate cannot
 * open, and what it opens onto is the real payload.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pastePreviewAllowed, requirementsPreviewRequested, fixturesPreviewRequested,
  REQUIREMENTS_PREVIEW_VALUE, FIXTURES_PREVIEW_VALUE } from '../draft/pastePreview.ts'
import { loadLocalReviewCatalog } from './localReviewCatalog.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const REVIEW_SRC = read('../../../app/statement-studio/components/CatalogReview.tsx')
const LOADER_SRC = read('./localReviewCatalog.ts')
const PAGE_SRC = read('../../../app/statement-studio/page.tsx')
const LIBRARY_SRC = read('../../../app/statement-studio/components/LibraryClient.tsx')
const PAYLOAD_REL = '../../../local-review/statement_requirements_catalog.json'
const payloadPath = fileURLToPath(new URL(PAYLOAD_REL, import.meta.url))
const havePayload = existsSync(payloadPath)

const gate = (over: Partial<Parameters<typeof pastePreviewAllowed>[0]> = {}) =>
  pastePreviewAllowed({
    nodeEnv: 'development', isAdmin: true,
    requested: requirementsPreviewRequested(REQUIREMENTS_PREVIEW_VALUE), ...over,
  })

// ------------------------------------------------------------------ the gate

test('admin + development + the exact parameter opens the review', () => {
  assert.equal(gate(), true)
})

test('A MISSING OR WRONG PARAMETER DOES NOT OPEN IT', () => {
  for (const value of [undefined, null, '', 'requirement', 'Requirements', ' requirements',
    'requirements ', 'true', '1', ['requirements'], ['requirements', 'fixtures']]) {
    assert.equal(requirementsPreviewRequested(value), false, JSON.stringify(value))
    assert.equal(gate({ requested: requirementsPreviewRequested(value) }), false)
  }
})

test('A NON-ADMIN DOES NOT OPEN IT, however correct the address', () => {
  assert.equal(gate({ isAdmin: false }), false)
})

test('PRODUCTION DOES NOT OPEN IT, however correct the address and the account', () => {
  for (const nodeEnv of ['production', 'test', undefined, '', 'Development']) {
    assert.equal(gate({ nodeEnv }), false, String(nodeEnv))
  }
})

test('the shape fixtures keep their own value and do not answer to the other', () => {
  assert.equal(fixturesPreviewRequested(FIXTURES_PREVIEW_VALUE), true)
  assert.equal(fixturesPreviewRequested(REQUIREMENTS_PREVIEW_VALUE), false)
  assert.equal(requirementsPreviewRequested(FIXTURES_PREVIEW_VALUE), false)
})

test('the server reads the payload ONLY inside the preview branch', () => {
  // If this ever became an unconditional call, the catalog would be read on
  // every Studio page load -- including in production, where the file is absent
  // but the intent would still be wrong.
  assert.match(PAGE_SRC, /const reviewCatalog = requirementsPreview \? loadLocalReviewCatalog\(\) : null/)
  assert.equal((PAGE_SRC.match(/loadLocalReviewCatalog\(/g) ?? []).length, 1)
})

test('THE PAYLOAD IS NEVER IMPORTED INTO A CLIENT BUNDLE', () => {
  // The whole design. A static import in any client module would ship the
  // inactive catalog to every visitor, gate or no gate.
  for (const [name, src] of [['CatalogReview', REVIEW_SRC],
    ['LibraryClient', LIBRARY_SRC]] as const) {
    // IMPORTS, not mentions. LibraryClient names the payload path in the
    // "not generated yet" help text, which is prose and ships nothing; an
    // `import` of it would ship all 180 KB to every visitor.
    assert.doesNotMatch(src, /^\s*import[^\n]*\.json['"]/m, `${name} must not import JSON`)
    assert.doesNotMatch(src, /require\(/, `${name} must not require anything`)
    assert.doesNotMatch(src, /node:fs|readFileSync/, `${name} must not read files`)
    assert.doesNotMatch(src, /^\s*import[^\n]*local-review/m,
      `${name} must not import from the payload directory`)
  }
  // and the loader is not a client module
  assert.doesNotMatch(LOADER_SRC, /^'use client'/m)
  assert.match(LOADER_SRC, /typeof window !== 'undefined'/)
})

test('the payload lives outside public/, so it is not fetchable', () => {
  assert.match(LOADER_SRC, /'local-review'/)
  assert.doesNotMatch(LOADER_SRC, /'public'/)
})

// -------------------------------------------------------- no way to write

test('NO ACTION ON THE REVIEW SCREEN CAN WRITE ANYTHING', () => {
  for (const forbidden of [/fetch\(/, /XMLHttpRequest/, /sendBeacon/, /createClient/,
    /supabase/i, /method:\s*['"](POST|PATCH|PUT|DELETE)/, /\/api\//]) {
    assert.doesNotMatch(REVIEW_SRC, forbidden, String(forbidden))
  }
  // every control is dressed as a demo, so the checklist renders spans not links
  assert.match(REVIEW_SRC, /demo: true/)
  assert.match(REVIEW_SRC, /draftHref: \(\) => '#review-no-draft'/)
  // onStart is local state and nothing else
  assert.match(REVIEW_SRC, /onStart: \(requirementId\) =>\s*\n?\s*setStarted/)
})

test('the loader exports nothing that mutates', () => {
  const exported = [...LOADER_SRC.matchAll(/^export (?:async )?function (\w+)/gm)]
    .map((m) => m[1])
  assert.deepEqual(exported, ['loadLocalReviewCatalog'])
  for (const forbidden of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.upsert\(/,
    /writeFile/, /fetch\(/]) {
    assert.doesNotMatch(LOADER_SRC, forbidden, String(forbidden))
  }
})

// ------------------------------------------------------------- the payload

test('the payload assembles to exactly 63 sets and 80 documents', { skip: !havePayload }, () => {
  const catalog = loadLocalReviewCatalog()
  assert.ok(catalog, 'the payload did not load')
  assert.equal(catalog!.declaredSetCount, 63)
  assert.equal(catalog!.declaredDocumentCount, 80)
  // PARSED, not merely declared: these come out of requirementFromRow(), so a
  // row the production reader would refuse is missing here too and the counts
  // disagree. That is the signal worth having.
  assert.equal(catalog!.parsedSetCount, 63)
  assert.equal(catalog!.parsedDocumentCount, 80)
  assert.equal(catalog!.sets.length, 63)
  assert.equal(catalog!.sets.reduce((n, s) => n + s.requirements.length, 0), 80)
})

test('the payload matches the reviewed import fingerprints', { skip: !havePayload }, () => {
  const catalog = loadLocalReviewCatalog()!
  const manifest = read('../../../supabase/manual/statement_requirements_catalog_import_MANIFEST.md')
  assert.ok(manifest.includes(catalog.setFingerprint),
    'the set fingerprint is not the one in the import manifest')
  assert.ok(manifest.includes(catalog.documentFingerprint),
    'the document fingerprint is not the one in the import manifest')
  assert.match(catalog.correspondsTo, /statement_requirements_catalog_import\.sql/)
})

test('Boston College keeps 1.5 pages, unrounded, through the real parser',
  { skip: !havePayload }, () => {
    const catalog = loadLocalReviewCatalog()!
    const bc = catalog.sets.find((s) => s.schoolName.includes('Boston College'))
    assert.ok(bc, 'Boston College is not in the review catalog')
    const halves = bc!.requirements.filter((r) => r.constraints.pages?.max === 1.5)
    assert.equal(halves.length, 2, 'both goal essays must carry 1.5')
    for (const r of halves) {
      assert.equal(r.constraints.pages?.enforcement, 'enforced')
      assert.equal(r.constraints.pages?.spacing, 'double')
      // and no unit was derived from the page count
      assert.equal(r.constraints.words, null)
      assert.equal(r.constraints.characters, null)
    }
  })

test('Gonzaga and UW-La Crosse stay prose-only, with no bound invented',
  { skip: !havePayload }, () => {
    const catalog = loadLocalReviewCatalog()!
    for (const name of ['Gonzaga', 'Franciscan']) {
      const set = catalog.sets.find((s) => s.schoolName.includes(name))
      assert.ok(set, `${name} is not in the review catalog`)
      const prose = set!.requirements.filter((r) => r.constraints.unenforcedLength !== null)
      assert.equal(prose.length, 1, `${name} should have one prose-only document`)
      const c = prose[0]!.constraints
      assert.equal(c.unenforcedLength!.verbatim, false)
      assert.equal(c.words, null)
      assert.equal(c.characters, null)
      assert.equal(c.pages?.min ?? null, null)
      assert.equal(c.pages?.max ?? null, null)
    }
  })

test('University of South Dakota is carried as needs-review, not verified',
  { skip: !havePayload }, () => {
    const catalog = loadLocalReviewCatalog()!
    const usd = catalog.sets.find((s) => s.schoolName.toLowerCase().includes('south dakota'))
    assert.ok(usd, 'South Dakota is not in the review catalog')
    assert.equal(usd!.verification.status, 'needs-review')
    // exactly one set carries it, so the screen's badge is not noise
    assert.equal(catalog.sets.filter((s) => s.verification.status === 'needs-review').length, 1)
  })

test('every set carries real provenance and at least one document',
  { skip: !havePayload }, () => {
    const catalog = loadLocalReviewCatalog()!
    for (const set of catalog.sets) {
      assert.ok(set.requirements.length >= 1, set.schoolName)
      assert.match(set.verification.sourceUrl ?? '', /^https?:\/\//, set.schoolName)
      assert.match(set.verification.verifiedOn ?? '', /^\d{4}-\d{2}-\d{2}$/, set.schoolName)
      assert.ok(set.schoolName.trim().length > 0)
      for (const r of set.requirements) {
        assert.ok(r.promptText.trim().length > 0, `${set.schoolName}: ${r.label}`)
        assert.ok(r.label.trim().length > 0, set.schoolName)
      }
    }
  })

test('a school with several documents is present, so that case is reviewable',
  { skip: !havePayload }, () => {
    const catalog = loadLocalReviewCatalog()!
    const multi = catalog.sets.filter((s) => s.requirements.length > 1)
    assert.ok(multi.length >= 3, `only ${multi.length} schools have multiple documents`)
  })
