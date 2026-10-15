/**
 * The bridge between the stored essay and the editor's document.
 *
 * ---------------------------------------------------------------------------
 * PLAIN TEXT IS A HARD INVARIANT, AND THIS IS WHERE IT IS KEPT
 * ---------------------------------------------------------------------------
 * statement_drafts.essay is `text` and stays `text`. The editor is allowed to
 * use a document model internally -- that is what buys real page breaks that
 * the caret obeys -- but nothing of that model may reach the database, the
 * autosave body, or the analysis fingerprint.
 *
 * So the schema the editor is given can represent exactly one thing:
 *
 *     doc > paragraph > text
 *
 * No marks, no headings, no lists, no links, no HTML. Rich text is not
 * discarded on the way out; it is UNREPRESENTABLE on the way in. A paste of
 * bold Word text cannot produce a bold node because the schema has nowhere to
 * put one.
 *
 * ---------------------------------------------------------------------------
 * PURE
 * ---------------------------------------------------------------------------
 * Plain JSON in, plain JSON out. No ProseMirror import, no DOM, no React --
 * which is what lets the round-trip be property-tested under `node --test`
 * rather than in a browser. The editor component hands these shapes to Tiptap;
 * Tiptap's own schema then enforces them a second time.
 */

/** A text node. The only leaf the schema admits. */
interface TextNode {
  readonly type: 'text'
  readonly text: string
}

/** One paragraph. `content` is absent when the paragraph is empty. */
interface ParagraphNode {
  readonly type: 'paragraph'
  // MARKS RIDE THE TEXT NODE, which is where ProseMirror puts them. A
  // paragraph carries no formatting of its own in this schema.
  readonly content?: readonly StoredTextNode[]
}

export interface PlainDoc {
  readonly type: 'doc'
  readonly content: readonly ParagraphNode[]
}

/**
 * Line endings, normalised to \n.
 *
 * THE ONE NORMALISATION, and it matches what the textarea already did: a
 * browser textarea submits \n whatever the user pasted, so every essay in the
 * database is already \n-separated. Carrying \r\n into the document model would
 * make the SAME text round-trip differently depending on where it was pasted
 * from -- and a changed essay is a changed fingerprint, which would invalidate
 * an analysis the applicant paid for, for nothing.
 *
 * NOTHING ELSE IS TOUCHED. No trimming, no collapsing of blank lines, no
 * smartening of quotes: the applicant's text is theirs.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * The stored essay as a document.
 *
 * ONE PARAGRAPH PER LINE, including empty ones. A blank line between two
 * paragraphs is an empty paragraph, not a dropped one -- it is how the applicant
 * separated their thoughts and it occupies a line box on the page, so losing it
 * would change both the text and the page count.
 */
export function essayToDoc(essay: string): PlainDoc {
  const lines = normalizeLineEndings(essay).split('\n')
  return {
    type: 'doc',
    content: lines.map((line) => (
      line.length === 0
        ? { type: 'paragraph' as const }
        : { type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] }
    )),
  }
}

/**
 * The document as a stored essay.
 *
 * THE EXACT INVERSE of essayToDoc for any text the editor can hold, which a
 * property test asserts over generated inputs. That equality is the invariant:
 * loading a draft and saving it without typing must not alter a byte, or every
 * open-and-close would bump the revision and invalidate the analysis.
 *
 * TOLERANT OF SHAPES IT DID NOT MAKE, because this also parses what Tiptap
 * hands back: an unknown node contributes its text if it has any and nothing if
 * it does not, rather than throwing. The schema should make those impossible;
 * refusing to read one would turn a theoretical bug into a lost essay.
 */
export function docToEssay(doc: unknown): string {
  if (typeof doc !== 'object' || doc === null) return ''
  const content = (doc as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.map(paragraphText).join('\n')
}

function paragraphText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return ''
  const content = (node as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.map((child) => {
    if (typeof child !== 'object' || child === null) return ''
    const text = (child as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  }).join('')
}

/**
 * The one mark the Studio stores.
 *
 * ---------------------------------------------------------------------------
 * BOLD, AND DELIBERATELY NOTHING ELSE
 * ---------------------------------------------------------------------------
 * Every mark added here is a mark the pagination has to measure, the paste
 * sanitiser has to decide about, and the stored document has to keep valid
 * for ever. Bold earns that because applicants asked for it and because a real
 * Bold face ships with the family; italic, underline, colour and size do not
 * yet, so the schema cannot represent them and a pasted one is dropped rather
 * than stored as something nobody can render.
 */
/*
  THE NAME IS 'bold', WHICH IS WHAT TIPTAP PUTS IN THE JSON.

  The HTML tag is <strong> and the first version of this stored 'strong' to
  match it. That silently broke both directions: a stored document would not
  load, because the schema has no mark by that name, and a document coming
  OUT of the editor arrived as 'bold' and was dropped here as unrecognised --
  so bolding a word, saving, and reopening lost the bold with no error
  anywhere. The stored document is ProseMirror JSON, so it uses ProseMirror's
  name; <strong> remains what it renders as.
*/
export const STUDIO_MARKS = ['bold'] as const
export type StudioMark = (typeof STUDIO_MARKS)[number]

/**
 * The document as it is stored.
 *
 * THE PLAIN TEXT IS STILL THE CANONICAL TEXT. This carries formatting beside
 * `essay`, never instead of it: `documentText` below must equal the essay
 * byte for byte, and the server refuses a save where it does not.
 */
export interface StoredTextNode {
  readonly type: 'text'
  readonly text: string
  readonly marks?: readonly { readonly type: StudioMark }[]
}

/**
 * Reduce any document to the one shape the Studio can store and render.
 *
 * ---------------------------------------------------------------------------
 * A WHITELIST, NOT A BLACKLIST
 * ---------------------------------------------------------------------------
 * It keeps doc > paragraph > text, and on a text node the single mark above.
 * Everything else -- a heading, a list, a colour, a font, an image, an unknown
 * mark from a future version -- contributes its TEXT and loses its identity.
 * Dropping the node entirely would silently delete the applicant's words;
 * keeping it would store something no renderer here understands.
 *
 * TOTAL, so it can be pointed at a paste, at a stored row written by an older
 * build, or at anything a browser extension injected, and always produce a
 * document this application can hold.
 */
export function constrainDocument(input: unknown): PlainDoc {
  const paragraphs = blocksOf(input).map((block) => {
    const inline = inlineOf(block)
    return inline.length === 0
      ? { type: 'paragraph' as const }
      : { type: 'paragraph' as const, content: inline }
  })
  // A DOCUMENT ALWAYS HAS AT LEAST ONE PARAGRAPH, because an empty content
  // array is not a valid ProseMirror doc for this schema and would refuse to
  // load at all.
  return {
    type: 'doc',
    content: paragraphs.length === 0 ? [{ type: 'paragraph' as const }] : paragraphs,
  }
}

/** The top-level blocks, each of which becomes exactly one paragraph. */
function blocksOf(input: unknown): unknown[] {
  if (typeof input !== 'object' || input === null) return []
  const content = (input as { content?: unknown }).content
  return Array.isArray(content) ? content : []
}

/**
 * One block's inline content, flattened.
 *
 * NESTED BLOCKS ARE FLATTENED, NOT RECURSED INTO AS BLOCKS. A pasted list or
 * blockquote becomes the text of one paragraph rather than several, because
 * the schema has no node for it and inventing paragraph breaks would change
 * the line count and therefore the page count.
 */
function inlineOf(block: unknown): StoredTextNode[] {
  const out: StoredTextNode[] = []
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const text = (node as { text?: unknown }).text
    if (typeof text === 'string') {
      if (text.length === 0) return
      const marks = keptMarks(node)
      out.push(marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks })
      return
    }
    for (const child of blocksOf(node)) walk(child)
  }
  for (const child of blocksOf(block)) walk(child)
  return merged(out)
}

/** Only the marks the Studio stores, deduplicated and ordered. */
function keptMarks(node: unknown): { type: StudioMark }[] {
  const raw = (node as { marks?: unknown }).marks
  if (!Array.isArray(raw)) return []
  const found = new Set<StudioMark>()
  for (const mark of raw) {
    const type = typeof mark === 'object' && mark !== null
      ? (mark as { type?: unknown }).type
      : null
    if (typeof type === 'string' && (STUDIO_MARKS as readonly string[]).includes(type)) {
      found.add(type as StudioMark)
    }
  }
  return [...found].map((type) => ({ type }))
}

/**
 * Adjacent runs with the same marks, joined.
 *
 * A PASTE ARRIVES SPLIT for reasons that are not about formatting -- a span
 * per word, a break per line in the source markup. Two identically-marked runs
 * side by side are one run, and leaving them apart makes the stored document
 * differ from the one the editor would produce for the same text.
 */
function merged(nodes: StoredTextNode[]): StoredTextNode[] {
  const out: StoredTextNode[] = []
  for (const node of nodes) {
    const last = out[out.length - 1]
    const sameMarks = last !== undefined
      && (last.marks ?? []).map((m) => m.type).join() === (node.marks ?? []).map((m) => m.type).join()
    if (last !== undefined && sameMarks) {
      out[out.length - 1] = { ...last, text: last.text + node.text }
    } else {
      out.push(node)
    }
  }
  return out
}

/**
 * THE INVARIANT, as a function.
 *
 * ---------------------------------------------------------------------------
 * THE DOCUMENT MAY NEVER DISAGREE WITH THE ESSAY
 * ---------------------------------------------------------------------------
 * `essay` is what the analyser reads, what the counters count and what the
 * fingerprint is taken over. `editor_document` exists only to remember which
 * of those characters are bold. If the two ever disagreed, the applicant would
 * see one essay and be marked on another -- and the fingerprint would no
 * longer identify the text that was actually analysed.
 *
 * CHECKED ON THE SERVER, not only here. A browser is not the right place to
 * guarantee an invariant about what gets stored.
 */
export function documentText(doc: unknown): string {
  return docToEssay(doc)
}

export function documentMatchesEssay(doc: unknown, essay: string): boolean {
  return documentText(doc) === normalizeLineEndings(essay)
}

/**
 * Flatten anything pasted into text the schema can hold.
 *
 * APPLIED TO THE PLAIN-TEXT FLAVOUR OF A PASTE, not to its HTML. The editor
 * asks the clipboard for text/plain; this is the second line of defence for the
 * case where a source offers only HTML and the browser synthesises text from
 * it. Block boundaries become newlines so a pasted multi-paragraph essay stays
 * multi-paragraph.
 */
export function flattenPaste(text: string): string {
  return normalizeLineEndings(text)
    // A tab is not a paragraph break and is not representable as indentation in
    // this schema; a space keeps the words apart without inventing structure.
    .replace(/\t/g, ' ')
    // Characters that would change how a line box is measured without being
    // visible to the applicant.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/*
 * THERE IS NO characterCount HERE, DELIBERATELY.
 *
 * constraints.ts already owns that rule, and it takes the school's own
 * `spacesCount` flag -- some schools count spaces and some do not. A second
 * counter in this module would have ignored that and reported a different
 * number from the one beside it in the editor, for the same essay.
 */
