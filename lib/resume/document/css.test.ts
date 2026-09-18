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

// ------------------------------------------------------------- bullets

test('bullets carry a marker of their own rather than inheriting one', () => {
  // The preview mounts inside an application whose reset sets list-style: none
  // on every ul, so the glyphs vanished in the Studio while surviving in the
  // PDF. A class selector states the marker and beats any host reset.
  assert.match(DOCUMENT_CSS, /\.rd-bullets\s*\{[^}]*list-style:\s*disc\s+outside/)
})

test('bullets hang, so a wrapped line aligns with the text and not the glyph', () => {
  const rule = /\.rd-bullets\s*\{[^}]*\}/.exec(DOCUMENT_CSS)?.[0] ?? ''
  assert.match(rule, /list-style:\s*disc\s+outside/, 'an inside marker would indent the wrap under the glyph')
  assert.match(rule, /padding-left:\s*\d/, 'without padding there is no room for the marker')
})

test('there is readable space between one bullet and the next', () => {
  assert.match(DOCUMENT_CSS, /\.rd-bullets li\s*\{[^}]*margin-bottom:\s*[1-9]/)
})

test('authored prose inside an entry is never given a bullet glyph', () => {
  // A shadowing reflection is a sentence, not a resume line.
  const rule = /\.rd-details\s*\{[^}]*\}/.exec(DOCUMENT_CSS)?.[0] ?? ''
  assert.notEqual(rule, '', 'narrative detail has no rule of its own')
  assert.equal(/list-style:\s*(disc|circle|square)/.test(rule), false, 'prose was given a marker')
})

// ------------------------------------------------------------ geometry

test('the sidebar takes about a quarter of the width, not a third', () => {
  const columns = /\[data-layout="sidebar"\][^{]*\.rd-columns\s*\{[^}]*grid-template-columns:\s*([\d.]+)fr\s+([\d.]+)fr/
    .exec(DOCUMENT_CSS)
  assert.ok(columns, 'the sidebar columns are not declared in fr units')
  const [aside, main] = [Number(columns![1]), Number(columns![2])]
  const share = aside / (aside + main)
  assert.ok(share >= 0.25 && share <= 0.28, `the sidebar takes ${Math.round(share * 100)}% of the width`)
})

test('the compact heading gutter fits two words, not one', () => {
  const gutter = /\[data-heading-style="inline"\][^{]*\.rd-section\s*\{[^}]*grid-template-columns:\s*([\d.]+)in/
    .exec(DOCUMENT_CSS)
  assert.ok(gutter, 'the inline heading gutter is not declared in inches')
  const px = Number(gutter![1]) * 96
  assert.ok(px >= 145 && px <= 160, `the gutter is ${px}px, which stacks a long heading one word per line`)
})

test('a heading no gutter can hold spans the section instead', () => {
  assert.match(DOCUMENT_CSS, /\[data-long-heading="true"\]\s*\{\s*display:\s*block/)
})

test('a long employer name wraps rather than pushing the date off the line', () => {
  assert.match(DOCUMENT_CSS, /\[data-entry-layout="opposed"\][^{]*:first-child\s*\{[^}]*min-width:\s*0/)
  assert.match(DOCUMENT_CSS, /\.rd-meta\s*\{[^}]*white-space:\s*nowrap/)
})

test('single-line credential entries close up instead of standing apart', () => {
  assert.match(DOCUMENT_CSS, /\[data-section-type="certifications"\]\s+\.rd-entry\s*\{[^}]*margin-bottom/)
})

test('the paginated preview is paged by the browser, one printed page per column', () => {
  const flow = /\.rd-flow\s*\{[^}]*\}/.exec(DOCUMENT_CSS)?.[0] ?? ''
  assert.match(flow, /width:\s*720px/)
  assert.match(flow, /height:\s*960px/)
  assert.match(flow, /column-width:\s*720px/)
  // Balanced columns would share content out evenly; auto fills each page first.
  assert.match(flow, /column-fill:\s*auto/)
  // The export's body margin, reproduced inside each page.
  assert.match(DOCUMENT_CSS, /\.rd-flow-body\s*\{\s*margin:\s*8px/)
  // The page loses its screen padding and height exactly as print takes them away.
  const page = /\[data-paginated="true"\] \.rd-page\s*\{[^}]*\}/.exec(DOCUMENT_CSS)?.[0] ?? ''
  for (const rule of [/width:\s*auto/, /min-height:\s*0/, /padding:\s*0/, /margin:\s*0/]) {
    assert.match(page, rule, `the paginated page does not match print: ${rule}`)
  }
})

test('a two-column page paints its sections in reading order, not column order', () => {
  // Chromium writes the PDF's text layer in paint order. The reading position
  // as a z-index is what keeps that order when a section is moved between
  // columns; relative positioning without an offset changes nothing visible.
  assert.match(
    DOCUMENT_CSS,
    /\[data-layout="sidebar"\] \.rd-section\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*var\(--rd-reading-order/
  )
})
