/**
 * Module hooks that let `node --test` load the app's .tsx files.
 *
 * WHY THIS EXISTS. Node 25 strips TypeScript types from .ts on its own, but it
 * refuses .tsx outright -- JSX is syntax, not a type annotation. The Resume V2
 * PDF export renders the SHARED ResumeDocument component to HTML, and the
 * round-trip test has to exercise that same component or it is not testing the
 * export at all. So the test runner needs to be able to load JSX.
 *
 * NO NEW DEPENDENCY. The transform is TypeScript's own `transpileModule`, and
 * typescript is already a devDependency here. Nothing was installed for this.
 *
 * Two hooks, both narrow:
 *
 *   resolve  handles what a bundler normally would -- the `@/` path alias and
 *            extensionless relative imports -- and defers everything else.
 *   load     transpiles .tsx only. A .ts file still goes through Node's own
 *            type stripping, so every existing test loads exactly as before.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const ROOT = new URL('../', import.meta.url)
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '/index.ts', '/index.tsx']

function firstExisting(base) {
  for (const extension of EXTENSIONS) {
    const candidate = new URL(base + extension, ROOT)
    if (existsSync(fileURLToPath(candidate))) return candidate.href
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  // `@/x` is this repo's tsconfig path alias for `<root>/x`.
  if (specifier.startsWith('@/')) {
    const target = firstExisting(specifier.slice(2))
    // No `format`: Node infers it from the extension, which is what keeps its
    // own type-stripping in play for the .ts files resolved here.
    if (target) return { url: target, shortCircuit: true }
  }

  // A relative import with no extension, as .tsx files are written.
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const parent = context.parentURL ? new URL(specifier, context.parentURL) : null
    if (parent) {
      for (const extension of EXTENSIONS) {
        const candidate = new URL(parent.href + extension)
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true }
        }
      }
    }
  }

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return nextLoad(url, context)

  const fileName = fileURLToPath(url)
  const source = await readFile(fileName, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
  })
  return { format: 'module', source: outputText, shortCircuit: true }
}

/** Kept so the URL constant is reachable from a test that wants the root. */
export const REPO_ROOT = pathToFileURL(fileURLToPath(ROOT)).href
