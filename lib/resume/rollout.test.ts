import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MODE, LEGACY_SCHEMA_FILTER, RESUME_BUILDER_MODE_ENV,
  legacyBuilderDisposition, parseMode, resumeBuilderMode,
} from './rollout.ts'

/**
 * The rollout flag decides which resume builder every user of the site sees.
 * A defect here is not a broken feature, it is the wrong product shipping to
 * everyone, so the failure-safe direction is tested far harder than the happy
 * path.
 */

test('v1 is the default for every value that is not exactly "v2"', () => {
  const notV2 = [
    undefined, null, '', ' ', 'v1', 'V1', 'true', '2', 'two', 'v3',
    'v2x', 'xv2', 'v 2', 'v2v2', '0', 'false', 'undefined', 'null',
  ]
  for (const value of notV2) {
    assert.equal(parseMode(value as string | null | undefined), 'v1', `"${String(value)}" opened v2`)
  }
})

test('only the exact string opens v2, with surrounding space and case forgiven', () => {
  for (const value of ['v2', 'V2', ' v2', 'v2 ', '  V2  ', '\tv2\n']) {
    assert.equal(parseMode(value), 'v2', `"${value}" should be v2`)
  }
})

test('the documented default matches what parseMode actually does', () => {
  assert.equal(DEFAULT_MODE, 'v1')
  assert.equal(parseMode(undefined), DEFAULT_MODE)
})

test('resumeBuilderMode reads that one variable and nothing else', () => {
  const before = process.env[RESUME_BUILDER_MODE_ENV]
  try {
    delete process.env[RESUME_BUILDER_MODE_ENV]
    assert.equal(resumeBuilderMode(), 'v1', 'an unset flag must mean v1')

    process.env[RESUME_BUILDER_MODE_ENV] = 'v2'
    assert.equal(resumeBuilderMode(), 'v2')

    process.env[RESUME_BUILDER_MODE_ENV] = 'yes'
    assert.equal(resumeBuilderMode(), 'v1', 'an unrecognised value must mean v1')
  } finally {
    if (before === undefined) delete process.env[RESUME_BUILDER_MODE_ENV]
    else process.env[RESUME_BUILDER_MODE_ENV] = before
  }
})

test('V1 stays visible in v1 mode and redirects to the Studio in v2 mode', () => {
  assert.deepEqual(legacyBuilderDisposition('v1'), { visible: true })
  assert.deepEqual(legacyBuilderDisposition('v2'), {
    visible: false, redirectTo: '/resume-studio',
  })
})

test('the legacy filter matches V1 rows and excludes V2 rows', () => {
  // PostgREST `or` syntax. Asserting the literal because a typo here silently
  // stops filtering rather than erroring: V1 would list migrated resumes.
  assert.equal(LEGACY_SCHEMA_FILTER, 'schema_version.is.null,schema_version.eq.1')
  assert.ok(LEGACY_SCHEMA_FILTER.includes('schema_version.eq.1'), 'V1 rows must match')
  assert.equal(LEGACY_SCHEMA_FILTER.includes('eq.2'), false, 'V2 rows must never match')
})

// --- one flag, not two -----------------------------------------------------

function source(relative: string): string {
  const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  // Comments are stripped before every source assertion below: this suite has
  // repeatedly caught itself matching its own explanatory prose.
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('the flag has exactly one reader in the whole library', () => {
  const rollout = source('./rollout.ts')
  const reads = [...rollout.matchAll(/process\.env/g)]
  assert.equal(reads.length, 1, 'rollout.ts should consult process.env once')
})

test('no browser-visible copy of the flag exists', () => {
  const rollout = source('./rollout.ts')
  assert.equal(
    rollout.includes('NEXT_PUBLIC'), false,
    'a NEXT_PUBLIC mirror is a second flag that can disagree with the first'
  )
})

test('the gate takes the mode as data and never reads it itself', () => {
  const gate = source('./gate.ts')
  assert.equal(gate.includes('process.env'), false, 'the gate must not read the environment')
  assert.equal(
    gate.includes('resumeBuilderMode'), false,
    'the gate must receive the mode, not fetch it -- otherwise it is a second reader'
  )
  assert.ok(gate.includes('ResumeBuilderMode'), 'the gate should still be typed by the mode')
})
