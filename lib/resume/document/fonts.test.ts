import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  FONT_FACES, SANS_FAMILY, SANS_STACK, SERIF_FAMILY, SERIF_STACK,
  fontFaceCss, webFontSrc, woff2DataUri,
} from './fonts.ts'
import { TEMPLATE_LIST } from './templates.ts'

const PUBLIC_FONTS = fileURLToPath(new URL('../../../public/fonts/', import.meta.url))

test('the font files this project claims to ship are actually here', () => {
  for (const face of FONT_FACES) {
    const path = PUBLIC_FONTS + face.file
    assert.ok(existsSync(path), `missing font file: ${face.file}`)
    assert.ok(statSync(path).size > 10_000, `${face.file} is too small to be a real font`)
  }
})

test('both families ship both subsets', () => {
  for (const family of [SANS_FAMILY, SERIF_FAMILY]) {
    const subsets = FONT_FACES.filter((f) => f.family === family).map((f) => f.subset).sort()
    assert.deepEqual(subsets, ['latin', 'latin-ext'], `${family} does not cover both subsets`)
  }
  assert.equal(FONT_FACES.length, 4)
})

test('the subsets do not overlap on the characters that distinguish them', () => {
  // A character covered by both faces, or by neither, is a character whose
  // rendering depends on declaration order rather than on the range.
  const latin = FONT_FACES.find((f) => f.subset === 'latin')!
  const latinExt = FONT_FACES.find((f) => f.subset === 'latin-ext')!
  assert.ok(latin.unicodeRange.includes('U+0000-00FF'), 'latin does not cover Latin-1')
  assert.ok(latinExt.unicodeRange.includes('U+0100-02BA'), 'latin-ext does not cover Latin Extended-A')
  assert.notEqual(latin.unicodeRange, latinExt.unicodeRange)
})

test('the Latin Extended characters a name needs fall inside the declared range', () => {
  // L-stroke, r-caron, s-comma: Polish, Czech and Romanian surnames.
  const latinExt = FONT_FACES.find((f) => f.subset === 'latin-ext')!
  for (const character of ['\u0141', '\u0159', '\u0219']) {
    const code = character.codePointAt(0)!
    assert.ok(code >= 0x0100 && code <= 0x02ba, `U+${code.toString(16)} is outside U+0100-02BA`)
    assert.ok(latinExt.unicodeRange.includes('U+0100-02BA'))
  }
})

test('their licences ship beside them', () => {
  for (const licence of ['Inter-LICENSE.txt', 'SourceSerif4-LICENSE.txt']) {
    assert.ok(existsSync(PUBLIC_FONTS + licence), `missing licence: ${licence}`)
  }
})

test('the web sources point at the files that exist', () => {
  for (const face of FONT_FACES) {
    const url = webFontSrc(face)
    assert.match(url, /^\/fonts\//, `${face.file} is not served from /fonts`)
    assert.ok(existsSync(PUBLIC_FONTS + url.replace('/fonts/', '')), `${url} does not exist`)
  }
})

test('every template sets its text in a face this project ships', () => {
  // The bug this prevents: naming Palatino or Iowan Old Style, which exist on a
  // designer's Mac and on no Vercel container, so the PDF silently fell back.
  const shipped = [SANS_FAMILY, SERIF_FAMILY]
  for (const template of TEMPLATE_LIST) {
    const first = template.tokens.fontStack.split(',')[0].trim()
    assert.ok(
      shipped.includes(first),
      `${template.id} leads with "${first}", which is not a shipped face`
    )
  }
})

test('a fallback stack still exists behind the shipped face', () => {
  for (const stack of [SANS_STACK, SERIF_STACK]) {
    const families = stack.split(',').map((f) => f.trim())
    assert.ok(families.length > 1, 'no fallback at all')
    assert.match(families[families.length - 1], /^(sans-)?serif$/, 'the stack does not end in a generic')
  }
})

test('every face declares the whole variable weight axis', () => {
  const css = fontFaceCss()
  // One file per subset serving 400 and 700 is why headings are really bold
  // rather than synthetically emboldened.
  assert.equal((css.match(/font-weight:\s*100 900/g) ?? []).length, FONT_FACES.length)
  assert.equal((css.match(/@font-face/g) ?? []).length, FONT_FACES.length)
  assert.ok(css.includes(SANS_FAMILY))
  assert.ok(css.includes(SERIF_FAMILY))
})

test('every face declares a unicode-range, so the browser can choose', () => {
  const css = fontFaceCss()
  assert.equal((css.match(/unicode-range:/g) ?? []).length, FONT_FACES.length)
  assert.ok(css.includes('U+0100-02BA'), 'latin-ext is not selectable')
  assert.ok(css.includes('U+0000-00FF'), 'latin is not selectable')
})

test('the preview links the fonts and the export inlines them — same files', () => {
  const web = fontFaceCss()
  for (const face of FONT_FACES) {
    assert.ok(web.includes(webFontSrc(face)), `the preview does not link ${face.file}`)
  }

  const embedded = fontFaceCss((face) => woff2DataUri(Buffer.from(`bytes-of-${face.file}`)))
  assert.ok(embedded.includes('data:font/woff2;base64,'))
  assert.equal(embedded.includes('/fonts/'), false, 'the embedded form still points at a URL')

  // Same rules, same families, same weights — only the src differs.
  // Whole line, not up to the first `;` -- a data URI contains one of those.
  const strip = (css: string) => css.replace(/^\s*src:.*$/gm, '  src:;')
  assert.equal(strip(web), strip(embedded))
})

test('a data URI is well formed', () => {
  const uri = woff2DataUri(Buffer.from([0x77, 0x4f, 0x46, 0x32]))
  assert.match(uri, /^data:font\/woff2;base64,[A-Za-z0-9+/=]+$/)
  assert.equal(Buffer.from(uri.split(',')[1], 'base64').toString('latin1'), 'wOF2')
})

test('no font is loaded over the network', () => {
  // An export that fetches nothing cannot be made to fetch something.
  for (const css of [fontFaceCss(), fontFaceCss(() => 'data:font/woff2;base64,AA')]) {
    assert.equal(/https?:\/\//.test(css), false, 'a font is fetched from a remote origin')
  }
})
