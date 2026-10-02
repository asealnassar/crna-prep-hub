import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * NOTHING A CLIENT COMPONENT IMPORTS MAY REACH A NODE BUILTIN.
 *
 * THE BUG THIS EXISTS FOR. reviewAccess.ts held the tier check, the action
 * labels AND the SHA-256 fingerprint, so its first line was
 * `import { createHash } from 'node:crypto'`. StatementStudioClient.tsx imports
 * that module for the labels; a client component pulls its whole import graph
 * into the browser bundle; Webpack has no loader for the `node:` scheme; the
 * Statement Studio editor stopped building.
 *
 * WHY NOTHING CAUGHT IT. tsc resolves node: builtins happily -- they are real
 * modules with real types. node --test resolves them too; it IS Node. Both
 * passed while the browser bundle was broken, because neither of them bundles
 * anything. Only a Webpack compilation sees this class of fault, and the one
 * thing cheaper than a build is walking the import graph, which is what this
 * does.
 *
 * IT FOLLOWS RELATIVE AND ALIASED IMPORTS, transitively, from every client
 * component in Statement Studio -- so a builtin added three modules deep fails
 * here rather than in the browser.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')

/** The client components whose graphs are bundled for the browser. */
const CLIENT_ENTRIES = [
  'app/statement-studio/components/StatementStudioClient.tsx',
  'app/statement-studio/components/LibraryClient.tsx',
  'app/statement-studio/components/NewDraftDialog.tsx',
  'app/statement-studio/components/PromptPicker.tsx',
]

/** Resolve a specifier the way the project's tsconfig and Node would. */
function resolveSpecifier(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = resolve(root, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return null // a package, not our source

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`,
                           resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        readFileSync(candidate, 'utf8')
        return candidate
      } catch { /* a directory */ }
    }
  }
  return null
}

// NEWLINES ARE ALLOWED IN THE MIDDLE. A multi-line `import {\n  a,\n  b,\n }
// from '...'` is the common form here, and a pattern that stopped at the line
// end matched almost nothing -- which made the builtin check pass vacuously.
// The non-vacuity test below is what caught that.
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g
const BARE_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

/** Every file reachable from an entry, and every bare specifier seen. */
function walk(entry: string): { files: Set<string>; specifiers: Set<string> } {
  const files = new Set<string>()
  const specifiers = new Set<string>()
  const queue = [resolve(root, entry)]

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    files.add(file)
    const source = readFileSync(file, 'utf8')
    for (const pattern of [IMPORT, BARE_IMPORT]) {
      pattern.lastIndex = 0
      let match = pattern.exec(source)
      while (match !== null) {
        const spec = match[1]
        specifiers.add(spec)
        const next = resolveSpecifier(file, spec)
        if (next !== null) queue.push(next)
        match = pattern.exec(source)
      }
    }
  }
  return { files, specifiers }
}

test('NO STATEMENT STUDIO CLIENT COMPONENT CAN REACH A NODE BUILTIN', () => {
  for (const entry of CLIENT_ENTRIES) {
    const { files, specifiers } = walk(entry)
    assert.ok(files.size > 1, `${entry} resolved nothing`)
    const builtins = [...specifiers].filter((s) => s.startsWith('node:'))
    assert.deepEqual(builtins, [], `${entry} reaches ${builtins.join(', ')}`)
  }
})

test('nor the unprefixed spellings of the same modules', () => {
  // `import 'crypto'` resolves in Node and breaks in a browser bundle just as
  // surely as `node:crypto` does.
  const BARE_BUILTINS = ['crypto', 'fs', 'path', 'os', 'child_process', 'net',
                         'http', 'https', 'stream', 'zlib', 'worker_threads']
  for (const entry of CLIENT_ENTRIES) {
    const { specifiers } = walk(entry)
    for (const builtin of BARE_BUILTINS) {
      assert.equal(specifiers.has(builtin), false, `${entry} imports ${builtin}`)
    }
  }
})

test('the editor does reach the modules it is supposed to', () => {
  // A walk that resolved nothing would pass the tests above vacuously.
  const { files } = walk(CLIENT_ENTRIES[0])
  const names = [...files].map((f) => f.replace(`${root}/`, ''))
  for (const expected of [
    'lib/statement/draft/reviewAccess.ts',
    'lib/statement/draft/reviewClient.ts',
    'lib/statement/draft/rubric.ts',
    'lib/statement/draft/editor.ts',
  ]) {
    assert.ok(names.includes(expected), `the walk should have reached ${expected}`)
  }
  assert.ok(files.size >= 10, `only ${files.size} files reached`)
  // And the graph is deep, not just the entry plus its direct imports: a
  // one-level walk would miss a builtin three modules down.
  assert.ok(names.includes('lib/statement/draft/picker.ts'), 'a transitive import')
})

test('THE FINGERPRINT IS NOT REACHABLE FROM THE BROWSER', () => {
  // It needs node:crypto, and it is computed from the saved draft, which only
  // the server has. A browser-computed cache key would be a browser deciding
  // whether work had already been paid for.
  for (const entry of CLIENT_ENTRIES) {
    const { files } = walk(entry)
    const names = [...files].map((f) => f.replace(`${root}/`, ''))
    assert.equal(names.includes('lib/statement/draft/analysisFingerprint.ts'), false, entry)
  }
  // And it still exists, server-side, with its identity intact.
  const source = readFileSync(resolve(root, 'lib/statement/draft/analysisFingerprint.ts'), 'utf8')
  assert.match(source, /createHash\('sha256'\)/)
  assert.match(source, /RUBRIC_VERSION/)
  assert.match(source, /REVIEW_SCHEMA_VERSION/)
})
