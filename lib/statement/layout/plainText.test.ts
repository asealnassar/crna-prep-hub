/**
 * Phase B: plain text in, plain text out, byte for byte.
 *
 * WHY THIS IS A PROPERTY TEST AND NOT A LIST OF EXAMPLES. The invariant is not
 * "these five strings survive" -- it is that NO string is altered. A draft that
 * changed by one character on open would bump the revision, change the analysis
 * fingerprint, and invalidate an analysis the applicant paid for, all without
 * anybody typing. So the round-trip is asserted over generated input as well as
 * over the cases that are easy to get wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  STUDIO_MARKS, docToEssay, essayToDoc, flattenPaste, normalizeLineEndings,
} from './plainText.ts'

const roundTrip = (essay: string) => docToEssay(essayToDoc(essay))

// ===========================================================================
// THE INVARIANT
// ===========================================================================

test('the round trip is the identity for ordinary prose', () => {
  const essay = [
    'I first understood anesthesia as a form of attention.',
    '',
    'In the cardiothoracic unit I cared for a woman whose pressure fell.',
    'The anesthetist narrated every adjustment until she was stable.',
  ].join('\n')
  assert.equal(roundTrip(essay), essay)
})

test('and for every shape of blank line', () => {
  for (const essay of [
    '',               // an untouched new draft
    '\n',             // one blank line
    '\n\n\n',         // several
    'a',              // no newline at all
    'a\n',            // trailing newline
    '\na',            // leading newline
    'a\n\nb',         // a paragraph break
    'a\n\n\n\nb',     // several
    '  leading spaces are the applicant\'s',
    'trailing spaces are too   ',
    '\t\ttabs survive storage',
  ]) {
    assert.equal(roundTrip(essay), essay, JSON.stringify(essay))
  }
})

test('PROPERTY: no generated essay is altered by a round trip', () => {
  // Deterministic generator: a reproducible failure is worth more than a random
  // one, and this runs on every commit.
  let seed = 20261006
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const alphabet = [...'abcdefghij ,.;:\'"()-—’éü中😀', '\n', '\n\n']
  for (let n = 0; n < 500; n += 1) {
    const length = Math.floor(rand() * 120)
    let essay = ''
    for (let i = 0; i < length; i += 1) {
      essay += alphabet[Math.floor(rand() * alphabet.length)]
    }
    assert.equal(roundTrip(essay), essay, `failed on ${JSON.stringify(essay)}`)
  }
})

test('non-Latin text and emoji survive intact', () => {
  // Code points, not UTF-16 units: an essay is not allowed to lose half a pair.
  const essay = 'Les soins intensifs — été 2026\n中文段落\n😀'
  assert.equal(roundTrip(essay), essay)
})

test('a very long single paragraph survives', () => {
  const essay = 'word '.repeat(5000).trim()
  assert.equal(roundTrip(essay), essay)
})

// ===========================================================================
// LINE ENDINGS -- THE ONE NORMALISATION
// ===========================================================================

test('CRLF and CR become LF, and nothing else changes', () => {
  assert.equal(normalizeLineEndings('a\r\nb'), 'a\nb')
  assert.equal(normalizeLineEndings('a\rb'), 'a\nb')
  assert.equal(normalizeLineEndings('a\nb'), 'a\nb')
  // The textarea already submitted \n, so this matches what is in the database
  // rather than changing it.
  assert.equal(roundTrip('a\r\nb'), 'a\nb')
})

test('normalisation does NOT trim, collapse or smarten anything', () => {
  const essay = '  spaced  \n\n\n   \n"straight quotes" and -- dashes  '
  assert.equal(normalizeLineEndings(essay), essay)
  assert.equal(roundTrip(essay), essay)
})

// ===========================================================================
// THE DOCUMENT SHAPE
// ===========================================================================

test('one paragraph per line, empty ones kept', () => {
  assert.deepEqual(essayToDoc('a\n\nb'), {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      // The blank line is a paragraph, not a dropped one: it occupies a line
      // box, so losing it would change the page count as well as the text.
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
    ],
  })
})

test('an empty essay is one empty paragraph', () => {
  assert.deepEqual(essayToDoc(''), { type: 'doc', content: [{ type: 'paragraph' }] })
  assert.equal(docToEssay(essayToDoc('')), '')
})

test('docToEssay tolerates a shape it did not build', () => {
  // The schema should make these impossible; refusing to read one would turn a
  // theoretical bug into a lost essay.
  assert.equal(docToEssay(null), '')
  assert.equal(docToEssay({}), '')
  assert.equal(docToEssay({ type: 'doc' }), '')
  assert.equal(docToEssay({ type: 'doc', content: 'nonsense' }), '')
  assert.equal(
    docToEssay({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image' }] }] }),
    '')
  // Marks a hostile input might carry are simply not read.
  assert.equal(
    docToEssay({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'bold?', marks: [{ type: 'bold' }] }],
      }],
    }),
    'bold?')
})

// ===========================================================================
// PASTE
// ===========================================================================

test('paste flattens to something the schema can hold', () => {
  assert.equal(flattenPaste('a\r\nb'), 'a\nb')
  assert.equal(flattenPaste('a\tb'), 'a b')
  // Control characters would change a line box without being visible.
  assert.equal(flattenPaste('a\u0000\u0007b'), 'ab')
  // Paragraph structure is preserved; it is the applicant's.
  assert.equal(flattenPaste('one\n\ntwo'), 'one\n\ntwo')
})

test('paste keeps the characters that belong to the essay', () => {
  const pasted = 'Café — "quoted" ’apostrophe’ 😀'
  assert.equal(flattenPaste(pasted), pasted)
})

// ===========================================================================
// COUNTING IS NOT THIS MODULE'S JOB
// ===========================================================================

test('the bridge does NOT define a second character counter', () => {
  // constraints.ts owns that rule and honours each school's spacesCount flag:
  // some schools count spaces and some do not. A counter here would have
  // reported a different number from the one beside it in the editor, for the
  // same essay.
  const source = readFileSync(new URL('./plainText.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.equal(code.includes('characterCount'), false)
})

// ===========================================================================
// WHAT THIS MODULE MUST NOT BECOME
// ===========================================================================

test('the bridge imports no editor, no DOM and no React', () => {
  const source = readFileSync(new URL('./plainText.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /^\s*import /m, 'the bridge gained an import')
  for (const forbidden of ['tiptap', 'prosemirror', 'react', 'document.', 'window.']) {
    assert.equal(code.toLowerCase().includes(forbidden), false, forbidden)
  }
})

test('and it cannot represent a heading, a list, or any mark except bold', () => {
  const source = readFileSync(new URL('./plainText.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  /*
   * BOLD IS NOW IN THE SCHEMA, AND IT IS THE ONLY THING THAT IS.
   *
   * This test forbade every mark, which was right while the document held
   * paragraphs and text alone. Issue #7 added bold deliberately -- one mark,
   * chosen because a bolded word still extracts to the same plain text and
   * still paginates against a real bold face. So the assertion is no longer
   * "no marks": it is the EXACT list, which is what keeps the next one out.
   */
  assert.deepEqual([...STUDIO_MARKS], ['bold'])
  for (const node of ['heading', 'bulletList', 'orderedList', 'italic', 'link',
    'underline', 'strike', 'code', 'textStyle', 'fontFamily', 'fontSize',
    'color', 'highlight', 'subscript', 'superscript', 'blockquote']) {
    assert.equal(code.includes(node), false, `the schema gained ${node}`)
  }
})
