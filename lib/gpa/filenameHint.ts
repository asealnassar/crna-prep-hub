/**
 * D46 - a low-confidence institution hint taken from the uploaded filename.
 *
 * Some transcripts print the school name only in a letterhead image, so the
 * text layer never carries it. The filename is often the one place the name
 * survives. It is a HINT: it can suggest or help match a name, and it must
 * never override what the document itself says, never affect a GPA, and never
 * silently attach an unrelated institution.
 */

/** Words that describe the document rather than the school. */
const NOISE = new Set([
  'transcript', 'transcripts', 'official', 'unofficial', 'copy', 'final',
  'scan', 'scanned', 'document', 'doc', 'pdf', 'file', 'record', 'records',
  'academic', 'student', 'my', 'the', 'a', 'university', 'college', 'school',
  'updated', 'new', 'old', 'draft', 'v', 'version',
])

/** Shorter than this and it is an initial or an artefact, not a name. */
const MIN_TOKEN = 3

/**
 * Returns a candidate institution name, or null when the filename says nothing
 * useful. "Montclair Transcript.pdf" -> "Montclair";
 * "Rutgers_Official_Transcript.pdf" -> "Rutgers"; "scan_2.pdf" -> null.
 */
export function institutionHintFromFilename(filename: unknown): string | null {
  const base = String(filename ?? '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')      // drop the extension
    .replace(/[_\-.+]+/g, ' ')               // separators become spaces
    .replace(/\(\d+\)/g, ' ')                // "(1)" duplicate markers
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return null

  const kept = base
    .split(' ')
    .filter(t => {
      const w = t.toLowerCase().replace(/[^a-z]/g, '')
      if (w.length < MIN_TOKEN) return false
      if (NOISE.has(w)) return false
      // A token that is mostly digits is a date or a counter.
      return /[a-z]/i.test(t) && t.replace(/[^0-9]/g, '').length <= 1
    })

  if (kept.length === 0) return null
  const hint = kept.join(' ').trim()
  // Cap it: a filename is a hint, not a legal name.
  return hint.length >= MIN_TOKEN ? hint.slice(0, 60) : null
}
