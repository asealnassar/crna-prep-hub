import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ANALYZE_BODY_BYTES, MAX_REWRITE_BODY_BYTES, MAX_STATEMENT_CHARS,
  MIN_STATEMENT_CHARS, checkStatement, declaredTooLarge, withinBodyLimit,
} from './limits.ts'

const essay = (n: number) => 'a'.repeat(n)

// ----------------------------------------------------------- the floor

test('the existing minimum is unchanged', () => {
  // Phase 0 hardens; it does not move a threshold users already know.
  assert.equal(MIN_STATEMENT_CHARS, 100)
  assert.equal(checkStatement(essay(99)).ok, false)
  assert.equal(checkStatement(essay(100)).ok, true)
})

test('the refusal message for a short statement is the one the page already showed', () => {
  const result = checkStatement(essay(10))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /at least 100 characters/)
})

// ---------------------------------------------------------- the ceiling

test('there is now a ceiling, and it refuses before the model is reached', () => {
  assert.equal(checkStatement(essay(MAX_STATEMENT_CHARS)).ok, true)
  const over = checkStatement(essay(MAX_STATEMENT_CHARS + 1))
  assert.equal(over.ok, false)
  if (over.ok) return
  assert.equal(over.code, 'too-long')
})

test('a ceiling large enough for any real personal statement', () => {
  // CRNA programmes ask for 500-1,500 words. At ~6 characters a word that is
  // 3,000-9,000 characters, so the cap clears the longest prompt twice over.
  assert.ok(MAX_STATEMENT_CHARS >= 18_000, 'too tight for a legitimate essay')
  assert.ok(MAX_STATEMENT_CHARS <= 40_000, 'too loose to bound a single call')
})

// ------------------------------------------------------ what is measured

test('the length checked is the length returned', () => {
  // Checking one string and forwarding another is how a cap is bypassed with
  // leading whitespace.
  const padded = `${' '.repeat(5_000)}${essay(200)}${' '.repeat(5_000)}`
  const result = checkStatement(padded)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.statement.length, 200)
})

test('whitespace alone cannot pass the floor', () => {
  const result = checkStatement(' '.repeat(500))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'missing')
})

test('a trimmed statement that falls under the floor is refused', () => {
  // 120 characters of padding around 40 of essay is a 40-character essay.
  const result = checkStatement(`${' '.repeat(120)}${essay(40)}`)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'too-short')
})

// ------------------------------------------------- adversarial body shapes

test('a non-string statement is a malformed request, never an exception', () => {
  const hostile: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['boolean', true],
    ['array', []],
    ['object', {}],
    // A body whose toString is not callable. The check must refuse it rather
    // than try to coerce it and throw.
    ['broken toString', { toString: 'x' }],
    ['length-alike', { length: 500 }],
    ['array of strings', ['a'.repeat(500)]],
    ['symbol', Symbol('s')],
    ['function', () => 'a'.repeat(500)],
  ]
  for (const [label, value] of hostile) {
    let result: ReturnType<typeof checkStatement> | undefined
    assert.doesNotThrow(() => { result = checkStatement(value) }, label)
    assert.equal(result?.ok, false, label)
    if (!result || result.ok) continue
    assert.equal(result.code, 'missing', label)
  }
})

// ----------------------------------------------------------- body bytes

test('the body is measured in bytes, not characters', () => {
  // One emoji is four UTF-8 bytes. A limit counted in characters would let a
  // body four times over the intended size through.
  const wide = '🎯'.repeat(MAX_ANALYZE_BODY_BYTES / 4)
  assert.equal(wide.length < MAX_ANALYZE_BODY_BYTES, true, 'fixture is not wide')
  assert.equal(withinBodyLimit(wide, MAX_ANALYZE_BODY_BYTES), true)
  assert.equal(withinBodyLimit(wide + '🎯', MAX_ANALYZE_BODY_BYTES), false)
})

test('an empty body is within every limit', () => {
  assert.equal(withinBodyLimit('', MAX_ANALYZE_BODY_BYTES), true)
})

test('the analyze limit holds a maximum statement with room for JSON', () => {
  const body = JSON.stringify({ statement: essay(MAX_STATEMENT_CHARS) })
  assert.equal(withinBodyLimit(body, MAX_ANALYZE_BODY_BYTES), true)
})

test('the rewrite limit is larger, because it carries the analysis back', () => {
  assert.ok(MAX_REWRITE_BODY_BYTES > MAX_ANALYZE_BODY_BYTES)
})

test('a multi-megabyte paste is refused by the body gate', () => {
  const huge = 'a'.repeat(5 * 1024 * 1024)
  assert.equal(withinBodyLimit(huge, MAX_ANALYZE_BODY_BYTES), false)
  assert.equal(withinBodyLimit(huge, MAX_REWRITE_BODY_BYTES), false)
})

// ------------------------------------- refusal before the body is buffered

test('an honestly-declared oversized request is refused without reading it', () => {
  // request.text() buffers the whole body, so a check that runs after it has
  // already paid the memory cost it exists to prevent.
  assert.equal(declaredTooLarge(String(MAX_ANALYZE_BODY_BYTES + 1), MAX_ANALYZE_BODY_BYTES), true)
  assert.equal(declaredTooLarge(String(50 * 1024 * 1024), MAX_ANALYZE_BODY_BYTES), true)
  assert.equal(declaredTooLarge(String(MAX_ANALYZE_BODY_BYTES), MAX_ANALYZE_BODY_BYTES), false)
})

test('a liar is not trusted, and is caught by the real measurement instead', () => {
  // Understating, omitting or corrupting the header must never be a way past
  // the limit — it only means the cheap gate cannot help.
  for (const header of [null, undefined, '', '   ', 'abc', '-1', '1e9', '12.5', '0x10', '9'.repeat(40)]) {
    assert.equal(declaredTooLarge(header, MAX_ANALYZE_BODY_BYTES), false, JSON.stringify(header))
  }
  // And the bytes that actually arrive are still measured.
  assert.equal(withinBodyLimit('a'.repeat(MAX_ANALYZE_BODY_BYTES + 1), MAX_ANALYZE_BODY_BYTES), false)
})

test('a truthful small request is not refused by the cheap gate', () => {
  const body = JSON.stringify({ statement: 'a'.repeat(200) })
  assert.equal(declaredTooLarge(String(Buffer.byteLength(body)), MAX_ANALYZE_BODY_BYTES), false)
})

// ------------------------------- the header gate on realistic HTTP traffic

test('a real oversized request body trips the gate on its own Content-Length', () => {
  // The live E2E could not test this by faking a header: undici validates
  // Content-Length against the body it is given and refuses to put a
  // mismatched request on the wire at all (UND_ERR_REQ_CONTENT_LENGTH_MISMATCH).
  // So this asserts the thing that actually happens in production — an HONEST
  // client serialising an oversized body and stating its true size.
  const body = JSON.stringify({ statement: 'a'.repeat(200_000) })
  const contentLength = String(Buffer.byteLength(body, 'utf8'))

  assert.equal(declaredTooLarge(contentLength, MAX_ANALYZE_BODY_BYTES), true,
    'the header gate must refuse this before request.text() buffers it')
  // And it is genuinely over, not a rounding artefact of the ceiling.
  assert.ok(Number(contentLength) > MAX_ANALYZE_BODY_BYTES * 2)
})

test('the largest legitimate request is NOT refused by the header gate', () => {
  // The gate must not fire on a maximum-length statement, or the ceiling in
  // checkStatement would be unreachable and the error message wrong.
  const body = JSON.stringify({ statement: 'a'.repeat(MAX_STATEMENT_CHARS) })
  assert.equal(
    declaredTooLarge(String(Buffer.byteLength(body, 'utf8')), MAX_ANALYZE_BODY_BYTES),
    false
  )
})

test('a rewrite body carrying a full analysis is not refused by its own gate', () => {
  // The rewrite ceiling is larger because the analysis travels back with the
  // statement. A realistic payload must clear it.
  const analysis = {
    overallScore: 70,
    categories: Array.from({ length: 6 }, (_, i) => ({
      name: `Category ${i}`, score: 7,
      feedback: 'f'.repeat(600), suggestion: 's'.repeat(600),
    })),
    admissionsImpression: 'i'.repeat(600),
    biggestWeaknesses: Array.from({ length: 3 }, () => 'w'.repeat(600)),
    topChanges: Array.from({ length: 3 }, () => 'c'.repeat(600)),
    sentenceAnalysis: Array.from({ length: 7 }, () => ({
      original: 'o'.repeat(400), label: 'Weak', improved: 'p'.repeat(400),
    })),
  }
  const body = JSON.stringify({
    statement: 'a'.repeat(MAX_STATEMENT_CHARS), analysis, token: 'v1.1.' + 'a'.repeat(64),
  })
  assert.equal(declaredTooLarge(String(Buffer.byteLength(body, 'utf8')), MAX_REWRITE_BODY_BYTES), false,
    'a legitimate rewrite would be refused at the door')
})

test('an understated Content-Length is not trusted', () => {
  // The header says 100 bytes; the body is a megabyte. The gate declines to
  // refuse (it is not KNOWN to be oversized) and the real measurement catches
  // it. The two together are the control; neither alone is.
  assert.equal(declaredTooLarge('100', MAX_ANALYZE_BODY_BYTES), false)
  assert.equal(withinBodyLimit('a'.repeat(1024 * 1024), MAX_ANALYZE_BODY_BYTES), false)
})
