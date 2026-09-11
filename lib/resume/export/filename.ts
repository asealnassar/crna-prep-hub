/**
 * Reading the filename the server chose.
 *
 * The route sanitises the name (see `pdfFilename`); the browser's job is to use
 * it, not to invent its own. A second construction on the client would mean two
 * sanitisers, and the weaker one would eventually be the one in use.
 *
 * Everything here is defensive because a header is still input: a missing
 * header, a quoted value, an RFC 5987 `filename*`, or a name containing a path
 * separator all resolve to something safe rather than to a download that lands
 * somewhere unexpected.
 */

export const FALLBACK_FILENAME = 'resume.pdf'

export function filenameFromDisposition(header: string | null | undefined): string {
  if (!header) return FALLBACK_FILENAME

  // RFC 5987 takes precedence when both are present, as browsers do.
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header)
  if (extended) {
    try {
      return sanitise(decodeURIComponent(extended[1].trim()))
    } catch {
      // A malformed percent-escape falls through to the plain form.
    }
  }

  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header)
  if (plain) return sanitise((plain[2] ?? plain[1]).trim())

  return FALLBACK_FILENAME
}

/**
 * A basename, never a path, and never control characters.
 *
 * `download` on an anchor already refuses a path, but relying on that puts the
 * guarantee in the browser rather than in code anyone can read.
 */
function sanitise(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  if (cleaned === '') return FALLBACK_FILENAME
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`
}
