/**
 * The admin navigation: every surface reachable, and the current one marked.
 *
 * WHY THIS EXISTS. The admin header was hand-written on each page, so adding a
 * destination meant remembering every page that lists destinations -- and the
 * Statement catalog manager duly ended up reachable only from inside the
 * Statement area. That is invisible: each page looks complete on its own. So
 * the reachability is asserted across pages rather than within one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  GENERAL_ADMIN, STATEMENT_ADMIN, isCurrentAdminPath,
} from './nav.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const NAV = read('../../app/admin/AdminNav.tsx')
const RULES = read('./nav.ts')

/**
 * Comments out, code in.
 *
 * WITHOUT THIS THE SCANS BELOW ARE THEATRE. Both modules' doc comments
 * necessarily say the words the scans look for -- nav.ts explains that it
 * imports "no React, no next/link", and AdminNav.tsx explains that it is "NOT
 * THE APPLICANT SIDEBAR". Scanning raw text fails on prose that is correct.
 */
const code = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

/** Every admin page that renders a row of destinations. */
const PAGES = [
  '../../app/admin/page.tsx',
  '../../app/admin/schools/page.tsx',
  '../../app/admin/reports/page.tsx',
  '../../app/admin/statement-prompts/page.tsx',
  '../../app/admin/statement-requirements/page.tsx',
] as const

// ===========================================================================
// ACTIVE STATE
// ===========================================================================

test('the current section is marked, including from a child route', () => {
  assert.equal(isCurrentAdminPath('/admin/statement-requirements', '/admin/statement-requirements'), true)
  // A nested route still marks its parent -- the reason this is computed rather
  // than hard-coded per page.
  assert.equal(
    isCurrentAdminPath('/admin/statement-requirements/abc', '/admin/statement-requirements'), true)
  assert.equal(isCurrentAdminPath('/admin/statement-prompts', '/admin/statement-prompts'), true)
})

test('and a different section is NOT marked', () => {
  assert.equal(isCurrentAdminPath('/admin/statement-prompts', '/admin/statement-requirements'), false)
  assert.equal(isCurrentAdminPath('/admin/statement-requirements', '/admin/statement-prompts'), false)
  assert.equal(isCurrentAdminPath('/admin/schools', '/admin/statement-requirements'), false)
})

test('a prefix that is not a path segment does not match', () => {
  // Anchored with a trailing slash, so this cannot light up the wrong row.
  assert.equal(
    isCurrentAdminPath('/admin/statement-promptsomething', '/admin/statement-prompts'), false)
  assert.equal(
    isCurrentAdminPath('/admin/statement-requirements-archive', '/admin/statement-requirements'), false)
})

test('the admin home is matched EXACTLY, not as a prefix of everything', () => {
  // '/admin' is a prefix of every admin route; treating it as a section would
  // mark the home page current on all of them.
  assert.equal(isCurrentAdminPath('/admin', '/admin'), true)
  assert.equal(isCurrentAdminPath('/admin/schools', '/admin'), false)
  assert.equal(isCurrentAdminPath('/admin/statement-requirements', '/admin'), false)
})

// ===========================================================================
// REACHABILITY -- the regression this file is really about
// ===========================================================================

test('EVERY ADMIN PAGE WITH A NAV OFFERS BOTH STATEMENT DESTINATIONS', () => {
  for (const page of PAGES) {
    const source = read(page)
    // Either it renders the shared component, or it lists the hrefs itself.
    const viaComponent = source.includes('<AdminNav />')
    const hasBoth = source.includes('/admin/statement-requirements')
      && source.includes('/admin/statement-prompts')
    assert.ok(viaComponent || hasBoth,
      `${page} cannot reach the Statement admin area`)
  }
})

test('both Statement destinations are grouped, with the catalog first', () => {
  const hrefs = STATEMENT_ADMIN.map((d) => d.href)
  // The catalog is the master record; the queue feeds it.
  assert.deepEqual(hrefs, ['/admin/statement-requirements', '/admin/statement-prompts'])
  assert.deepEqual(STATEMENT_ADMIN.map((d) => d.label),
    ['Statement Requirements', 'Prompt Submissions'])
  // Grouped rather than scattered among the general links.
  for (const href of hrefs) {
    assert.equal(GENERAL_ADMIN.some((d) => d.href === href), false, href)
  }
})

test('it keeps every destination the admin area already had', () => {
  assert.deepEqual(GENERAL_ADMIN.map((d) => d.href),
    ['/admin', '/admin/schools', '/admin/school-unlocks', '/admin/reports'])
})

// ===========================================================================
// WHAT IT MUST NOT TOUCH
// ===========================================================================

test('the APPLICANT sidebar is not involved', () => {
  // components/Sidebar.tsx is the signed-in applicant's navigation. The admin
  // area does not render it and must not gain entries from it.
  assert.equal(code(NAV).includes('Sidebar'), false)
  assert.equal(code(RULES).includes('Sidebar'), false)
  const sidebar = read('../../components/Sidebar.tsx')
  assert.equal(sidebar.includes('/admin/statement-requirements'), false,
    'an admin destination leaked into the applicant sidebar')
  assert.equal(sidebar.includes('/admin/statement-prompts'), false)
})

test('the rules module imports nothing from React or Next', () => {
  // That is what lets node --test load it, and it is the same discipline
  // lib/resume/gate.ts and lib/statement/studioGate.ts follow.
  const rules = code(RULES)
  assert.ok(rules.includes('export function isCurrentAdminPath'), 'the stripper ate the module')
  for (const forbidden of ['react', 'next/link', 'next/navigation', 'next/headers']) {
    assert.equal(rules.includes(forbidden), false, `nav.ts imports ${forbidden}`)
  }
  // No import statement at all, which is the strongest form of the claim.
  assert.doesNotMatch(rules, /^\s*import /m)
})

test('the nav styling is the header the Statement pages already used', () => {
  // Copied, not designed: those two pages look exactly as they did.
  assert.match(NAV, /border-b border-slate-200 bg-white/)
  assert.match(NAV, /text-slate-600 hover:text-blue-600/)
  assert.match(NAV, /font-semibold text-blue-700/)
  // The current row is announced to assistive technology, not just coloured.
  assert.match(NAV, /aria-current="page"/)
})
