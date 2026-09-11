import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The renderer's architecture, asserted against the files themselves.
 *
 * `components/resume-document/` sits outside the route because two callers
 * mount it: the Studio preview and, from Phase 6, the export path. That is only
 * true for as long as it stays free of Supabase, the router and anything to do
 * with editing -- so this reads the source rather than trusting the intent.
 */

const DIR = fileURLToPath(new URL('../../../components/resume-document', import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = joinPath(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/**
 * Source with comments removed.
 *
 * The checks below are about what the code DOES, not what it says. These files
 * document what they deliberately avoid -- "knows nothing about editing,
 * routing or Supabase" -- and a grep over raw text fails on its own
 * documentation, which is what happened when this was first written.
 */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const FILES = walk(DIR)
const SOURCES = FILES.map((path) => {
  const text = readFileSync(path, 'utf8')
  return { path: path.slice(DIR.length + 1), text, code: codeOf(text) }
})

test('the directory holds the renderer, the header and the two primitives', () => {
  const names = SOURCES.map((f) => f.path).sort()
  assert.deepEqual(names, [
    'DocumentHeader.tsx',
    'ResumeDocument.tsx',
    'sections/EntriesBlock.tsx',
    'sections/ProseBlock.tsx',
  ])
})

test('nothing in the directory imports Supabase', () => {
  for (const { path, code } of SOURCES) {
    assert.equal(/supabase/i.test(code), false, `${path} references Supabase`)
  }
})

test('nothing in the directory imports the router', () => {
  for (const { path, code: text } of SOURCES) {
    for (const forbidden of ['next/navigation', 'next/router', 'next/link', 'useRouter', 'usePathname']) {
      assert.equal(text.includes(forbidden), false, `${path} imports ${forbidden}`)
    }
  }
})

test('nothing in the directory reaches into an editing concern', () => {
  for (const { path, code: text } of SOURCES) {
    for (const forbidden of [
      '@/lib/resume/repo', '@/lib/resume/draft', '@/lib/apiAuth',
      'app/resume-studio', '/api/', 'fetch(',
    ]) {
      assert.equal(text.includes(forbidden), false, `${path} reaches into ${forbidden}`)
    }
  }
})

test('the renderer holds no state and no effects', () => {
  for (const { path, code: text } of SOURCES) {
    for (const hook of ['useState', 'useEffect', 'useReducer', 'useContext', 'useRef']) {
      assert.equal(text.includes(hook), false, `${path} uses ${hook}`)
    }
  }
})

test('no file is a client component, so the export path can render it on a server', () => {
  for (const { path, text } of SOURCES) {
    assert.equal(text.includes("'use client'"), false, `${path} is a client component`)
  }
})

test('every import is React, a sibling, or the pure document layer', () => {
  const allowed = /^(react|\.\/|\.\.\/|@\/lib\/resume\/(document|model)\/)/
  for (const { path, text } of SOURCES) {
    const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    for (const specifier of specifiers) {
      assert.match(specifier, allowed, `${path} imports ${specifier}`)
    }
  }
})

test('the dispatch covers both primitives and nothing else', () => {
  const renderer = SOURCES.find((f) => f.path === 'ResumeDocument.tsx')!.text
  assert.ok(renderer.includes('ProseBlock'), 'prose is not rendered')
  assert.ok(renderer.includes('EntriesBlock'), 'entries are not rendered')
  // A per-section-type import list would mean the dispatch has to grow with the
  // model, which is what the two-primitive plan exists to prevent.
  const componentImports = [...renderer.matchAll(/from\s+'\.\/(?:sections\/)?([A-Z]\w+)'/g)].map((m) => m[1])
  assert.deepEqual(componentImports.sort(), ['DocumentHeader', 'EntriesBlock', 'ProseBlock'])
})

test('the stylesheet is inlined once, and only by the root', () => {
  for (const { path, text } of SOURCES) {
    const inlines = text.includes('DOCUMENT_CSS')
    if (path === 'ResumeDocument.tsx') assert.ok(inlines, 'the root does not inline the stylesheet')
    else assert.equal(inlines, false, `${path} inlines the stylesheet too`)
  }
})

test('the only raw HTML injected is the stylesheet', () => {
  for (const { path, text } of SOURCES) {
    const uses = [...text.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
    for (const value of uses) {
      assert.equal(value, 'DOCUMENT_CSS', `${path} injects ${value} as raw HTML`)
    }
  }
})
