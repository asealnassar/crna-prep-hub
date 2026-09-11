import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DOCUMENT_CSS, cssVariablesFor } from './css.ts'
import { TEMPLATE_LIST } from './templates.ts'

const VARS = [
  '--rd-body', '--rd-heading', '--rd-name', '--rd-leading',
  '--rd-section-gap', '--rd-entry-gap', '--rd-font',
]

/**
 * Variant values the stylesheet does NOT need a selector for, because they are
 * the base rule. Listed here so adding a variant without styling it fails.
 */
const DEFAULTS: Record<string, string> = {
  layout: 'single-column',
  entryLayout: 'stacked',
}

test('every template supplies every custom property', () => {
  for (const template of TEMPLATE_LIST) {
    const vars = cssVariablesFor(template)
    assert.deepEqual(Object.keys(vars).sort(), [...VARS].sort(), template.id)
    for (const [name, value] of Object.entries(vars)) {
      assert.notEqual(String(value).trim(), '', `${template.id} ${name} is empty`)
      assert.doesNotMatch(String(value), /undefined|NaN|null/, `${template.id} ${name}`)
    }
  }
})

test('sizes carry print units, because this is a document and not a web page', () => {
  for (const template of TEMPLATE_LIST) {
    const vars = cssVariablesFor(template)
    for (const name of ['--rd-body', '--rd-heading', '--rd-name', '--rd-section-gap', '--rd-entry-gap']) {
      assert.match(vars[name], /pt$/, `${template.id} ${name} is not in points`)
    }
  }
})

test('two templates never produce identical tokens', () => {
  const seen = new Map<string, string>()
  for (const template of TEMPLATE_LIST) {
    const key = JSON.stringify(cssVariablesFor(template))
    const clash = seen.get(key)
    assert.equal(clash, undefined, `${template.id} has the same tokens as ${clash}`)
    seen.set(key, template.id)
  }
})

// ------------------------------------------------------------- the page

test('the page is US Letter with real margins', () => {
  assert.match(DOCUMENT_CSS, /width:\s*8\.5in/)
  assert.match(DOCUMENT_CSS, /min-height:\s*11in/)
  assert.match(DOCUMENT_CSS, /@page\s*\{[^}]*size:\s*letter/)
})

test('there are print rules', () => {
  assert.match(DOCUMENT_CSS, /@media print/)
  assert.match(DOCUMENT_CSS, /@page/)
})

test('page breaks are controlled where a resume looks careless without it', () => {
  // An entry split across pages, and a heading stranded at the foot of one.
  assert.match(DOCUMENT_CSS, /\.rd-entry\s*\{[^}]*break-inside:\s*avoid/)
  assert.match(DOCUMENT_CSS, /\.rd-heading\s*\{[^}]*break-after:\s*avoid/)
  // The legacy property too: Chromium's print path still honours it.
  assert.match(DOCUMENT_CSS, /page-break-inside:\s*avoid/)
  assert.match(DOCUMENT_CSS, /page-break-after:\s*avoid/)
})

/**
 * Removes every at-rule block (@media, @page) by brace depth.
 *
 * Comments go first: the stylesheet's own prose mentions @media, and a naive
 * scan treats that as the start of a block and swallows the rules after it --
 * which is exactly what this test caught the first time it was written.
 */
function withoutAtRuleBlocks(source: string): string {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  let out = ''
  let i = 0
  while (i < css.length) {
    if (css[i] !== '@') {
      out += css[i]
      i += 1
      continue
    }
    let depth = 0
    let opened = false
    while (i < css.length) {
      if (css[i] === '{') { depth += 1; opened = true }
      else if (css[i] === '}') {
        depth -= 1
        if (opened && depth === 0) { i += 1; break }
      }
      i += 1
    }
  }
  return out
}

test('break control is not confined to print, so the preview breaks the same way', () => {
  const unconditional = withoutAtRuleBlocks(DOCUMENT_CSS)
  assert.equal(unconditional.includes('@media'), false, 'the at-rule strip did not work')
  assert.equal(unconditional.includes('@page'), false, 'the at-rule strip did not work')
  assert.match(unconditional, /\.rd-entry\s*\{[^}]*break-inside:\s*avoid/)
  assert.match(unconditional, /\.rd-heading\s*\{[^}]*break-after:\s*avoid/)
})

// ---------------------------------------------------------- variants

test('every structural variant a template uses is actually styled', () => {
  const axes: [keyof (typeof TEMPLATE_LIST)[number], string][] = [
    ['layout', 'data-layout'],
    ['headerAlign', 'data-header-align'],
    ['headingStyle', 'data-heading-style'],
    ['entryLayout', 'data-entry-layout'],
  ]
  for (const template of TEMPLATE_LIST) {
    for (const [field, attribute] of axes) {
      const value = String(template[field])
      if (DEFAULTS[String(field)] === value) continue
      assert.ok(
        DOCUMENT_CSS.includes(`[${attribute}="${value}"]`),
        `${template.id}: ${attribute}="${value}" has no rule, so it would render unstyled`
      )
    }
  }
})

test('the stylesheet stays black on white — a template is not a palette', () => {
  const colours = DOCUMENT_CSS.match(/#[0-9a-fA-F]{3,8}/g) ?? []
  const unique = new Set(colours.map((c) => c.toLowerCase()))
  assert.ok(unique.size <= 5, `too many colours for a printed document: ${[...unique].join(', ')}`)
})

test('the stylesheet has no leading or trailing whitespace to inline badly', () => {
  assert.equal(DOCUMENT_CSS, DOCUMENT_CSS.trim())
  assert.notEqual(DOCUMENT_CSS.length, 0)
})

test('the stylesheet closes every brace it opens', () => {
  const open = (DOCUMENT_CSS.match(/\{/g) ?? []).length
  const close = (DOCUMENT_CSS.match(/\}/g) ?? []).length
  assert.equal(open, close)
})

test('the stylesheet cannot break out of the style tag it is inlined into', () => {
  // It is injected with dangerouslySetInnerHTML; a closing tag inside it would
  // end the element early and put the remainder into the document as markup.
  assert.equal(DOCUMENT_CSS.toLowerCase().includes('</style'), false)
  assert.equal(DOCUMENT_CSS.toLowerCase().includes('<script'), false)
})
