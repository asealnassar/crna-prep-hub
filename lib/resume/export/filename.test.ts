import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_FILENAME, filenameFromDisposition } from './filename.ts'

/**
 * The browser uses the name the server chose. These are the ways a header can
 * be absent, quoted, encoded or hostile.
 */

test('the ordinary case: the server’s sanitised name', () => {
  assert.equal(
    filenameFromDisposition('attachment; filename="jordan-ellery-resume.pdf"'),
    'jordan-ellery-resume.pdf'
  )
})

test('an unquoted name works too', () => {
  assert.equal(filenameFromDisposition('attachment; filename=resume.pdf'), 'resume.pdf')
})

test('a missing or unusable header falls back rather than downloading nothing', () => {
  for (const header of [null, undefined, '', 'attachment', 'inline']) {
    assert.equal(filenameFromDisposition(header), FALLBACK_FILENAME, String(header))
  }
})

test('the RFC 5987 form is preferred and decoded', () => {
  assert.equal(
    filenameFromDisposition("attachment; filename=\"fallback.pdf\"; filename*=UTF-8''jos%C3%A9-resume.pdf"),
    'josé-resume.pdf'
  )
})

test('a malformed percent-escape does not lose the download', () => {
  assert.equal(
    filenameFromDisposition("attachment; filename=\"safe.pdf\"; filename*=UTF-8''bad%ZZname.pdf"),
    'safe.pdf'
  )
})

test('a path in the header becomes a basename', () => {
  assert.equal(filenameFromDisposition('attachment; filename="../../etc/passwd.pdf"'), 'passwd.pdf')
  assert.equal(filenameFromDisposition('attachment; filename="/tmp/evil.pdf"'), 'evil.pdf')
  assert.equal(filenameFromDisposition('attachment; filename="a\\\\b\\\\c.pdf"'), 'c.pdf')
})

test('a name that is only dots or separators falls back', () => {
  for (const value of ['...', '/', '"."', '".."']) {
    const name = filenameFromDisposition(`attachment; filename=${value}`)
    assert.ok(name === FALLBACK_FILENAME || name.endsWith('.pdf'), value)
    assert.equal(name.includes('/'), false, value)
  }
})

test('control characters are stripped', () => {
  const header = 'attachment; filename="re\u0000su\u001fme.pdf"'
  const name = filenameFromDisposition(header)
  assert.equal(name, 'resume.pdf')
  assert.equal(/[\u0000-\u001f]/.test(name), false)
})

test('a name without an extension gains one', () => {
  assert.equal(filenameFromDisposition('attachment; filename="resume"'), 'resume.pdf')
  assert.equal(filenameFromDisposition('attachment; filename="RESUME.PDF"'), 'RESUME.PDF')
})

test('the result is never a path, whatever went in', () => {
  const hostile = [
    'attachment; filename="../../../../root/.ssh/authorized_keys"',
    "attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd",
    'attachment; filename="C:\\\\Windows\\\\System32\\\\x.pdf"',
  ]
  for (const header of hostile) {
    const name = filenameFromDisposition(header)
    assert.equal(name.includes('/'), false, header)
    assert.equal(name.includes('\\'), false, header)
    assert.equal(name.startsWith('.'), false, header)
  }
})
