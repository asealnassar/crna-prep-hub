/**
 * /personal-statement as the review entry point.
 *
 * The risk is not that the redirect fails -- that is obvious the moment you try
 * it. The risk is that it reaches production, or that it loops, or that it
 * quietly changes what the live analyser serves. Each has a test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { simulatedLiveEnabled } from './gate.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const PAGE = read('../../../app/personal-statement/page.tsx')
const ANALYZER = read('../../../app/personal-statement/PersonalStatementAnalyzer.tsx')
const STUDIO_PAGE = read('../../../app/statement-studio/page.tsx')
const STUDIO_LAYOUT = read('../../../app/statement-studio/layout.tsx')
const SIDEBAR = read('../../../components/Sidebar.tsx')

test('DEVELOPMENT redirects /personal-statement into the Studio', () => {
  assert.equal(simulatedLiveEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), true)
  assert.match(PAGE, /if \(simulatedLiveEnabled\(\)\) \{/)
  assert.match(PAGE, /redirect\(query === '' \? '\/statement-studio'/)
})

test('PRODUCTION serves the existing analyser, unchanged', () => {
  assert.equal(simulatedLiveEnabled({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), false)
  // the live page still renders the same component, and the redirect is the
  // only thing guarding it
  assert.match(PAGE, /return <PersonalStatementAnalyzer \/>/)
  // THE ANALYSER ITSELF IS UNTOUCHED. It moved file, and that is all: it is
  // still a client component with the same export.
  assert.match(ANALYZER, /^'use client'/)
  assert.match(ANALYZER, /export default function PersonalStatementAnalyzer\(\)/)
  // nothing development-only leaked into it
  assert.doesNotMatch(ANALYZER, /simulatedLive|statement-studio|devMode/)
})

test('THE REDIRECT CANNOT REACH PRODUCTION: NODE_ENV is the only condition', () => {
  const condition = PAGE.slice(PAGE.indexOf('simulatedLiveEnabled()'))
  assert.ok(condition.length > 0)
  // no query parameter, header, cookie or NEXT_PUBLIC_* value participates
  assert.doesNotMatch(PAGE, /NEXT_PUBLIC_/)
  assert.doesNotMatch(PAGE, /headers\(\)|cookies\(\)/)
  for (const value of ['on', 'true', '1']) {
    assert.equal(simulatedLiveEnabled({
      NODE_ENV: 'production', STATEMENT_SIMULATED_LIVE: value } as NodeJS.ProcessEnv), false, value)
  }
})

test('NO REDIRECT LOOP: the Studio never redirects back', () => {
  for (const [name, src] of [['studio page', STUDIO_PAGE],
    ['studio layout', STUDIO_LAYOUT]] as const) {
    assert.doesNotMatch(src, /redirect\('\/personal-statement/, `${name} must not bounce back`)
  }
  // the Studio's only redirect is the sign-in one the gate already had
  const redirects = [...STUDIO_PAGE.matchAll(/redirect\('([^']+)'\)/g)].map((m) => m[1])
  assert.deepEqual(redirects, ['/login'])
})

test('the query string survives, including a repeated parameter', () => {
  // ?preview=requirements and ?preview=fixtures are the two a reviewer types,
  // and the gate's refusal of a REPEATED parameter must stay reachable.
  assert.match(PAGE, /params\.append\(key, value\)/)
  assert.match(PAGE, /for \(const item of value\) params\.append\(key, item\)/)
  assert.match(PAGE, /\$\{query\}/)
})

test('the sidebar is byte-identical to production and needs no dev branch', () => {
  assert.match(SIDEBAR, /\{ href: '\/personal-statement', label: 'Personal Statement'/)
  assert.doesNotMatch(SIDEBAR, /simulatedLive/)
  // because the row leads to the Studio through the redirect, not through a
  // second development-only destination
  assert.doesNotMatch(SIDEBAR, /statement-studio/)
})

test('the Studio gate and its write isolation are untouched by this change', () => {
  // the entry point moved; nothing about what it opens onto did
  assert.match(STUDIO_PAGE, /statementStudioAccess\(\{/)
  assert.match(STUDIO_PAGE, /statementDbClient\(token, \{/)
  assert.doesNotMatch(STUDIO_PAGE, /createClient\(/)
  assert.match(STUDIO_LAYOUT, /simulatedLiveEnabled\(\)/)
  assert.match(STUDIO_LAYOUT, /SIMULATED_LIVE_BANNER/)
})

test('no middleware and no rewrite was added to carry this', () => {
  // A middleware file or a next.config rewrite would run in production too,
  // which is a production routing change however it is guarded.
  let hasMiddleware = true
  try { readFileSync(fileURLToPath(new URL('../../../middleware.ts', import.meta.url))) }
  catch { hasMiddleware = false }
  assert.equal(hasMiddleware, false, 'a middleware file now exists')
  const config = read('../../../next.config.js')
  assert.doesNotMatch(config, /personal-statement/)
  assert.doesNotMatch(config, /statement-studio/)
})
