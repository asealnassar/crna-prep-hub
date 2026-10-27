import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ANALYSIS_LIBRARY_NOTICE, ANALYSIS_PREVIEW_NOTICE, ANALYSIS_STEP_BODY,
  type AnalysisAvailability, type AnalysisOffer,
  analysisOffer, analysisStepIsLive, canAnalyzeStatement,
} from './reviewAccess.ts'

/**
 * WK-QA-001 — what the Statement Studio may claim about analysis.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT. Three applicant-facing surfaces each
 * hardcoded a sentence saying the analyser did not exist: the editor banner
 * ("AI analyzer is not built yet"), the library notice ("AI analyzer is not
 * available yet") and the third feature card ("Coming soon." with
 * available: false). The analyser shipped; the sentences did not change,
 * because nothing derived them. An authenticated WebKit pass found the editor
 * telling an applicant the feature was not built immediately above a rendered
 * seven-category analysis.
 *
 * Worse than the wording: the previous tests REQUIRED those literals, so the
 * suite actively defended the false claim. The tests here assert the
 * derivation instead, and the last test fails if any of the three phrases
 * comes back into the rendered source.
 */

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const read = (rel: string) => readFileSync(path(rel), 'utf8')

/**
 * Comments are removed before searching for stale phrases. The history of this
 * defect is written down in several of these files on purpose, and a guard that
 * could not tell an explanation from a claim would forbid explaining it.
 */
const stripComments = (source: string) => source
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const EDITOR = stripComments(read('../../../app/statement-studio/components/StatementStudioClient.tsx'))
const LIBRARY = stripComments(read('../../../app/statement-studio/components/LibraryClient.tsx'))
const LIBRARY_PAGE = stripComments(read('../../../app/statement-studio/page.tsx'))
const EDITOR_PAGE = stripComments(read('../../../app/statement-studio/[id]/page.tsx'))

const OFFERS: readonly AnalysisOffer[] = ['offered', 'needs-plan', 'unavailable']
const AVAILABILITIES: readonly AnalysisAvailability[] = ['ready', 'development-no-cache', 'unavailable']

// ===========================================================================
// THE THREE STATES THAT MATTER
// ===========================================================================

test('capability OFF is unavailable for everybody, whatever the plan', () => {
  // The capability is the outer gate. Naming the plan that includes analysis
  // while nobody can run one would be advertising something switched off.
  for (const tier of ['ultimate', 'premium', 'free', null, undefined, 'nonsense']) {
    assert.equal(
      analysisOffer({ allowed: canAnalyzeStatement(tier), availability: 'unavailable' }),
      'unavailable',
      `tier ${String(tier)}`,
    )
  }
})

test('capability ON plus Ultimate is offered', () => {
  for (const availability of ['ready', 'development-no-cache'] as const) {
    assert.equal(
      analysisOffer({ allowed: canAnalyzeStatement('ultimate'), availability }),
      'offered',
      availability,
    )
  }
})

test('capability ON without Ultimate names the plan and nothing worse', () => {
  // The feature exists and works; this viewer has not bought it. That must not
  // be reported as the feature being unbuilt.
  for (const availability of ['ready', 'development-no-cache'] as const) {
    for (const tier of ['free', 'premium', null, undefined, 'nonsense']) {
      assert.equal(
        analysisOffer({ allowed: canAnalyzeStatement(tier), availability }),
        'needs-plan',
        `${availability} / ${String(tier)}`,
      )
    }
  }
})

test('Free and Premium never gain Ultimate analysis access', () => {
  assert.equal(canAnalyzeStatement('ultimate'), true)
  for (const tier of ['free', 'premium', 'pro', '', null, undefined, 'ULTIMATE_']) {
    assert.equal(canAnalyzeStatement(tier), false, String(tier))
  }
})

test('only the switched-off state mutes the feature card', () => {
  // A plan boundary is not an absence, so the tile stays live for needs-plan.
  assert.equal(analysisStepIsLive('offered'), true)
  assert.equal(analysisStepIsLive('needs-plan'), true)
  assert.equal(analysisStepIsLive('unavailable'), false)
})

test('every availability maps to an offer, so no state falls through', () => {
  for (const availability of AVAILABILITIES) {
    for (const allowed of [true, false]) {
      const offer = analysisOffer({ allowed, availability })
      assert.ok(OFFERS.includes(offer), `${availability}/${allowed} -> ${offer}`)
    }
  }
})

// ===========================================================================
// THE COPY ITSELF
// ===========================================================================

test('every offer has wording on all three surfaces', () => {
  for (const offer of OFFERS) {
    for (const [name, table] of [
      ['preview notice', ANALYSIS_PREVIEW_NOTICE],
      ['library notice', ANALYSIS_LIBRARY_NOTICE],
      ['step body', ANALYSIS_STEP_BODY],
    ] as const) {
      const copy = table[offer]
      assert.equal(typeof copy, 'string', `${name} / ${offer}`)
      assert.ok(copy.trim().length > 0, `${name} / ${offer} is empty`)
    }
  }
})

test('no wording claims the analyser does not exist', () => {
  // "currently unavailable" is a reversible statement about now. "not built
  // yet" and "coming soon" are claims about the product that stopped being
  // true and that no flag could retract.
  for (const table of [ANALYSIS_PREVIEW_NOTICE, ANALYSIS_LIBRARY_NOTICE, ANALYSIS_STEP_BODY]) {
    for (const offer of OFFERS) {
      const copy = table[offer]
      assert.doesNotMatch(copy, /not built/i, copy)
      assert.doesNotMatch(copy, /coming soon/i, copy)
      assert.doesNotMatch(copy, /not yet/i, copy)
      assert.doesNotMatch(copy, /does not exist/i, copy)
    }
  }
})

test('the switched-off wording says it is unavailable now, not absent', () => {
  for (const table of [ANALYSIS_PREVIEW_NOTICE, ANALYSIS_LIBRARY_NOTICE, ANALYSIS_STEP_BODY]) {
    assert.match(table.unavailable, /currently unavailable/i, table.unavailable)
  }
})

test('the offered wording carries no leftover caveat about analysis', () => {
  for (const table of [ANALYSIS_PREVIEW_NOTICE, ANALYSIS_LIBRARY_NOTICE]) {
    assert.match(table.offered, /AI analysis/i)
    assert.doesNotMatch(table.offered, /unavailable|Ultimate/i, table.offered)
  }
})

test('the plan wording names Ultimate and makes no claim about availability', () => {
  for (const table of [ANALYSIS_PREVIEW_NOTICE, ANALYSIS_LIBRARY_NOTICE, ANALYSIS_STEP_BODY]) {
    assert.match(table['needs-plan'], /Ultimate/)
    assert.doesNotMatch(table['needs-plan'], /unavailable/i, table['needs-plan'])
  }
})

// ===========================================================================
// THE SURFACES READ THE VERDICT INSTEAD OF DECIDING IT
// ===========================================================================

test('the editor banner renders the looked-up sentence', () => {
  assert.match(EDITOR, /ANALYSIS_PREVIEW_NOTICE\[previewOffer\]/)
  assert.match(EDITOR, /const previewOffer = analysisOffer\(\{/)
  assert.match(EDITOR, /allowed: analysisAllowed/)
  assert.match(EDITOR, /availability: analysisAvailable/)
})

test('the library notice and card render the looked-up sentences', () => {
  assert.match(LIBRARY, /ANALYSIS_LIBRARY_NOTICE\[analysisOffer\]/)
  assert.match(LIBRARY, /body: ANALYSIS_STEP_BODY\[offer\]/)
  assert.match(LIBRARY, /available: analysisStepIsLive\(offer\)/)
})

test('the verdict is computed on the server, from the plan and the capability', () => {
  // THE ONE THING THAT MUST NOT HAPPEN IS A SECOND OPINION. If a client read
  // the environment for itself it could disagree with the route about whether
  // analysis is possible, which is the shape of the original defect.
  assert.match(LIBRARY_PAGE, /analysisOffer=\{analysisOffer\(\{/)
  assert.match(LIBRARY_PAGE, /allowed: canAnalyzeStatement\(auth\.tier\)/)
  assert.match(LIBRARY_PAGE, /cacheEnabled: analysisCacheEnabled\(\)/)
  for (const [name, client] of [['editor', EDITOR], ['library', LIBRARY]] as const) {
    assert.doesNotMatch(client, /analysisCacheEnabled/, `${name} must not read the flag itself`)
    assert.doesNotMatch(client, /process\.env\.NODE_ENV/, `${name} must not read NODE_ENV itself`)
  }
})

test('both pages derive availability from the same helper the route gates on', () => {
  for (const [name, page] of [['library', LIBRARY_PAGE], ['editor', EDITOR_PAGE]] as const) {
    assert.match(page, /analysisAvailability\(\{/, name)
    assert.match(page, /canAnalyzeStatement\(/, name)
  }
})

// ===========================================================================
// THE GUARD
// ===========================================================================

test('THE STALE PHRASES CANNOT COME BACK INTO THE APPLICANT PATH', () => {
  // The exact literals that shipped the defect, plus an unconditional "Coming
  // soon" anywhere in the rendered source of either surface.
  const forbidden = [
    /AI analyzer is not built yet/i,
    /AI analyzer is not available yet/i,
    /analyzer is not (built|available)/i,
    /Coming soon/i,
    /not wired up/i,
  ]
  for (const [name, source] of [
    ['StatementStudioClient.tsx', EDITOR],
    ['LibraryClient.tsx', LIBRARY],
    ['statement-studio/page.tsx', LIBRARY_PAGE],
    ['statement-studio/[id]/page.tsx', EDITOR_PAGE],
  ] as const) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${name} must not say ${pattern}`)
    }
  }
})

test('the stripper used by the guard does not eat the code it searches', () => {
  // The guard would pass vacuously over an empty string, so the inputs are
  // checked for the identifiers the other tests depend on.
  for (const [name, stripped, raw] of [
    ['editor', EDITOR, read('../../../app/statement-studio/components/StatementStudioClient.tsx')],
    ['library', LIBRARY, read('../../../app/statement-studio/components/LibraryClient.tsx')],
  ] as const) {
    assert.ok(stripped.length > raw.length * 0.4, `${name}: stripping removed too much`)
  }
  assert.match(EDITOR, /ANALYSIS_PREVIEW_NOTICE/)
  assert.match(LIBRARY, /ANALYSIS_LIBRARY_NOTICE/)
})
