'use client'

import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import type { JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Bold from '@tiptap/extension-bold'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import {
  allowanceRawOffsetPx, breakProbePx, lineTopPx, liveOffsetPx, needsBreakAfter,
  pagesUsedFromLayout, rawOffsetPx, rawPageStarts, rawTextHeightPx, sameLayout,
  type PaginationGeometry, type PaginationLayout, type RenderedGap,
} from '@/lib/statement/layout/pagination'
import {
  constrainDocument, docToEssay, essayToDoc, flattenPaste,
} from '@/lib/statement/layout/plainText'
import { contentBox, type PageGeometry } from '@/lib/statement/layout/geometry'
import { studioFontFaceCss } from '@/lib/statement/layout/fonts'
import { TOUCH_TARGET, TOUCH_TARGET_SQUARE } from './touchTarget'
import type { DocumentFontChoice, StudioFontId } from '@/lib/statement/layout/studioFonts'

/**
 * The writing surface, laid out as the page the school asked for.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A TEXTAREA
 * ---------------------------------------------------------------------------
 * A textarea is one continuous box. Drawing page sheets behind it gives two
 * layouts that nothing forces to agree, so every page gap, font fallback and
 * rounding difference is a fresh way for the caret to sit somewhere the page
 * boundary is not. ProseMirror lets the page gap be a widget decoration -- real
 * DOM in the flow that is NOT in the document -- so the browser lays the text
 * out around it and the caret, the selection and the break are all products of
 * one layout pass.
 *
 * ---------------------------------------------------------------------------
 * THE DOCUMENT CANNOT HOLD ANYTHING BUT TEXT
 * ---------------------------------------------------------------------------
 * The schema is Document + Paragraph + Text and nothing else. Rich text is not
 * stripped on the way out; it is UNREPRESENTABLE on the way in -- a pasted bold
 * run cannot become a bold node because the schema has nowhere to put one. What
 * leaves this component is the same `string` the textarea produced, so
 * autosave, the revision compare-and-swap and the analysis fingerprint are
 * untouched.
 *
 * ---------------------------------------------------------------------------
 * MEASUREMENT IS RENDERED, NEVER ESTIMATED
 * ---------------------------------------------------------------------------
 * The content box is sized in real units -- 6.5in wide, 12pt text, a line box
 * in points from the font's own metrics -- so its height in points is a fact
 * about the laid-out document rather than a guess from a word count.
 */

/**
 * The shortcut, named for the platform the reader is on.
 *
 * READ ONCE AT MODULE LOAD AND GUARDED FOR THE SERVER, because this component
 * renders on the client only but the module is imported during the build.
 */
const shortcutHint = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent ?? '')
  ? '\u2318B'
  : 'Ctrl+B'

/** CSS pixels are 1/96in and points are 1/72in. */
const PT_PER_PX = 72 / 96

/**
 * Paste, reduced to what the schema can hold.
 *
 * ---------------------------------------------------------------------------
 * BOLD SURVIVES. EVERYTHING ELSE BECOMES TEXT.
 * ---------------------------------------------------------------------------
 * A paste from a word processor carries headings, colours, fonts, sizes,
 * underlines and a stylesheet. None of those can be stored, measured or
 * rendered here, and a document that held them would be one no page count
 * could be trusted for.
 *
 * So the HTML flavour is read when there is one, walked, and reduced to
 * paragraphs of text carrying at most the strong mark -- `constrainDocument`
 * is the whitelist, and it keeps the WORDS of anything it does not recognise
 * rather than dropping them. Without an HTML flavour the plain text is used,
 * exactly as before.
 */
const PlainTextPaste = Extension.create({
  name: 'plainTextPaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const html = event.clipboardData?.getData('text/html')
            const text = event.clipboardData?.getData('text/plain')
            if ((typeof html !== 'string' || html.length === 0)
              && (typeof text !== 'string' || text.length === 0)) return false
            event.preventDefault()
            const { schema } = view.state

            const doc = typeof html === 'string' && html.length > 0
              // PARSED BY PROSEMIRROR'S OWN RULES FIRST, so <b>, <strong> and
              // font-weight all arrive as the strong mark rather than needing
              // a second HTML parser here; then constrained.
              ? constrainDocument(parseHtmlToDoc(html, view))
              : essayToDoc(flattenPaste(text ?? ''))

            const nodes = (doc.content ?? []).map((para) => schema.nodes.paragraph!.create(
              null,
              (para.content ?? []).map((run) => schema.text(
                run.text,
                (run.marks ?? []).map((mark) => schema.marks[mark.type]!.create()),
              )),
            ))
            view.dispatch(view.state.tr.replaceSelectionWith(
              schema.nodes.doc!.create(null, nodes), false,
            ).scrollIntoView())
            return true
          },
        },
      }),
    ]
  },
})

/** The gutter between two sheets, in CSS pixels. Visual only. */
const GUTTER_PX = 28

/** CSS defines an inch as exactly 96 pixels, so this conversion is not lossy. */
const CSS_PX_PER_IN = 96

/**
 * The page geometry, in the pixels the break arithmetic works in.
 *
 * THE GAP IS THE WHOLE DISTANCE BETWEEN TWO TEXT COLUMNS: the bottom margin of
 * the page above, the gutter between the sheets, and the top margin of the page
 * below. It is one number because the arithmetic only ever needs to know how
 * far the next page's first line has been pushed down.
 */
function paginationGeometry(geometry: PageGeometry): PaginationGeometry {
  return {
    pageHeightPx: contentBox(geometry).heightPt / PT_PER_PX,
    gapHeightPx: 2 * geometry.marginsIn.value * CSS_PX_PER_IN + GUTTER_PX,
    lineHeightPx: geometry.lineHeightPt / PT_PER_PX,
  }
}

/** The height of paper needed to hold the pages that have been started. */
function sheetHeightPx(geometry: PageGeometry, breaks: number): number {
  const { pageHeightPx, gapHeightPx } = paginationGeometry(geometry)
  return (breaks + 1) * pageHeightPx + breaks * gapHeightPx
    + 2 * geometry.marginsIn.value * CSS_PX_PER_IN
}

const paginationKey = new PluginKey<DecorationSet>('statementPagination')

/**
 * Page breaks and the allowance line, as widget decorations.
 *
 * ---------------------------------------------------------------------------
 * WHY A DECORATION AND NOT A BACKGROUND
 * ---------------------------------------------------------------------------
 * A widget is real DOM inserted into the flow but NOT into the document. The
 * browser lays the text out around it, so the caret, the selection rectangles
 * and the page gap are products of ONE layout pass. Drawing sheets behind a
 * continuous box would be two layouts nothing forces to agree -- which is where
 * a caret ends up sitting in the gutter.
 *
 * AND IT IS NOT IN THE DOCUMENT, so serialisation never sees it: the essay that
 * reaches autosave is the same string it always was.
 *
 * ---------------------------------------------------------------------------
 * MID-PARAGRAPH BREAKS
 * ---------------------------------------------------------------------------
 * A 1.5-page essay almost always breaks inside a paragraph, so the widget has
 * to be placeable at an inline position. It is rendered `display: block`, which
 * ends the line it sits in and continues the paragraph on the next page.
 *
 * THE POSITION IS ALWAYS A VISUAL LINE START. posAtCoords is asked about a
 * point at the left edge of the content box, so it answers with the first
 * character of that line. That is what makes the block widget safe: the line
 * was already ending there, so inserting it changes no line breaking anywhere,
 * which is the premise `pagination.ts` relies on to compute every break in a
 * single pass instead of settling.
 *
 * ---------------------------------------------------------------------------
 * ONE PASS, IN RAW SPACE
 * ---------------------------------------------------------------------------
 * Each page starts where the previous one broke, so the offsets are walked in
 * sequence -- but in the gapless coordinates `pagination.ts` calls raw space,
 * converted to live coordinates only to ask the DOM a question. The rendered
 * gaps are read from the DOM rather than assumed, so a pass that runs while the
 * previous set is still on screen converts correctly regardless.
 */
interface PaginationOptions {
  getGeometry: () => PaginationGeometry | null
  getMaxPages: () => number | null
  onLayout: (layout: PaginationLayout) => void
  /** Hands the caller a way to ask for another pass. */
  register: (remeasure: () => void) => void
}

function paginationPlugin(options: PaginationOptions) {
  const { getGeometry, getMaxPages, onLayout, register } = options
  return new Plugin<DecorationSet>({
    key: paginationKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old) {
        const next = tr.getMeta(paginationKey) as DecorationSet | undefined
        if (next !== undefined) return next
        // Positions move with the document between measurements, so the old set
        // is mapped rather than dropped: the gaps do not flicker while typing.
        return old.map(tr.mapping, tr.doc)
      },
    },
    props: {
      decorations(state) { return paginationKey.getState(state) },
    },
    view(view) {
      /**
       * The pending pass, and how to call it off.
       *
       * NOT ALWAYS AN ANIMATION FRAME. requestAnimationFrame is suspended while
       * a tab is hidden, so an editor that mounted in a background tab would
       * schedule a measurement that never ran -- no page breaks, no page count,
       * until the tab was brought to the front. Layout is still computed in a
       * hidden tab, so a timeout measures perfectly well there, and there is
       * nothing to paint in time with.
       */
      let cancel: (() => void) | null = null
      /**
       * The last layout handed upward.
       *
       * REPORTING IS WHAT FEEDS THE LOOP. React state becomes a render, a
       * render becomes a view update, and a view update is what schedules the
       * next pass -- so a pass that found nothing new must stay silent, or the
       * editor measures for ever. See sameLayout.
       */
      let reported: PaginationLayout | null = null
      const run = () => { cancel = null; measure() }
      const schedule = () => {
        if (cancel !== null) return
        if (typeof document !== 'undefined' && document.hidden) {
          const id = window.setTimeout(run, 0)
          cancel = () => window.clearTimeout(id)
        } else {
          const id = requestAnimationFrame(run)
          cancel = () => cancelAnimationFrame(id)
        }
      }
      const measure = () => {
        const geometry = getGeometry()
        if (geometry === null || geometry.pageHeightPx <= 0) return
        const dom = view.dom as HTMLElement
        const box = dom.getBoundingClientRect()

        // WHAT IS ON SCREEN RIGHT NOW, measured rather than assumed: this pass
        // may be running against the previous pass's gaps.
        const gaps: RenderedGap[] = Array.from(
          dom.querySelectorAll('.statement-page-break'),
        ).map((element) => {
          const rect = element.getBoundingClientRect()
          return { topPx: rect.top - box.top, heightPx: rect.height }
        })
        const rawHeight = rawTextHeightPx(dom.scrollHeight, gaps)

        // Left edge of the content, a hair inside it, so posAtCoords answers
        // with the first character of a line and not the end of the one above.
        const probeLeft = box.left + 1
        const rawAt = (livePx: number): number | null => {
          const found = view.posAtCoords({ left: probeLeft, top: box.top + livePx })
          return found === null ? null : found.pos
        }

        const breaks: { pos: number; rawTop: number }[] = []
        let rawStart = 0
        // Bounded by the pages that could exist: a runaway loop here would hang
        // the editor, and no essay reaches a thousand pages.
        for (let page = 0; page < 1000; page += 1) {
          if (!needsBreakAfter(rawStart, rawHeight, geometry)) break
          const probe = breakProbePx(rawStart, geometry)
          const pos = rawAt(liveOffsetPx(probe, gaps))
          if (pos === null) break
          const coords = view.coordsAtPos(pos, 1)
          // SNAPPED, NOT TRUSTED. The reported rectangle is around the glyphs,
          // inset by half the leading, and how far is the engine's business.
          const rawTop = lineTopPx(rawOffsetPx(coords.top - box.top, gaps), geometry)
          // NO PROGRESS MEANS STOP. A break that did not advance past the page
          // start would stack a second gap in one place and never converge --
          // which is what a single line taller than the page would do.
          if (rawTop <= rawStart) break
          breaks.push({ pos, rawTop })
          rawStart = rawTop
        }

        const starts = rawPageStarts(breaks.map((b) => b.rawTop))
        const decorations: Decoration[] = breaks.map((b, index) =>
          Decoration.widget(b.pos, () => pageBreakElement(index), {
            side: -1,
            key: `page-break-${index}`,
          }),
        )

        /*
          ---- the allowance line, and the text past it ----------------------

          THE LINE IS NOT A DECORATION. A decoration needs a document position,
          and the boundary is usually below the end of the essay -- halfway down
          an empty page two, for Boston -- where there is no text to anchor to.
          So the offset is reported and the line is drawn over the page.

          THAT IS NOT THE SPLIT ARCHITECTURE THE GAPS AVOID: the line holds no
          text and moves nothing. The offset comes out of the same pass that
          placed the breaks, so it cannot drift from them.

          THE TINT IS a decoration, because text is exactly what it marks.
        */
        const limitRaw = allowanceRawOffsetPx(getMaxPages(), starts, geometry)
        const limitLive = limitRaw === null ? null : liveOffsetPx(limitRaw, gaps)
        if (limitRaw !== null && limitRaw < rawHeight) {
          const pos = rawAt(limitLive!)
          const end = view.state.doc.content.size
          if (pos !== null && pos < end) {
            // BACKGROUND ONLY, and nothing that occupies space. A border, a
            // padding or a different size here would re-wrap the text and
            // invalidate the measurement that placed this decoration.
            decorations.push(Decoration.inline(pos, end, {
              class: 'statement-over-limit',
            }))
          }
        }

        const layout: PaginationLayout = {
          breaks: breaks.length,
          pagesUsed: pagesUsedFromLayout({ rawHeightPx: rawHeight, starts, geometry }),
          rawHeightPx: rawHeight,
          allowanceOffsetPx: limitLive,
        }
        if (!sameLayout(reported, layout)) {
          reported = layout
          onLayout(layout)
        }

        const set = DecorationSet.create(view.state.doc, decorations)
        const current = paginationKey.getState(view.state)
        // Only dispatch when something actually changed, or every measurement
        // would be a transaction and every transaction a measurement.
        if (current !== undefined && sameDecorations(current, set, view)) return
        view.dispatch(view.state.tr.setMeta(paginationKey, set).setMeta('addToHistory', false))
      }
      register(schedule)
      schedule()
      const observer = new ResizeObserver(schedule)
      observer.observe(view.dom as HTMLElement)
      // A TAB COMING TO THE FRONT IS A REASON TO RE-MEASURE: a pass that ran
      // while it was hidden is still correct, but this costs nothing and closes
      // the case where one was skipped.
      const onVisible = () => schedule()
      document.addEventListener('visibilitychange', onVisible)
      return {
        update: schedule,
        destroy() {
          cancel?.()
          observer.disconnect()
          document.removeEventListener('visibilitychange', onVisible)
        },
      }
    },
  })
}

/** Whether two decoration sets describe the same decorations in the same places. */
function sameDecorations(a: DecorationSet, b: DecorationSet, view: EditorView): boolean {
  const size = view.state.doc.content.size
  const key = (set: DecorationSet) =>
    set.find(0, size).map((d) => `${d.from}:${d.to}:${d.spec.key ?? 'inline'}`).join('|')
  return key(a) === key(b)
}

/** Tiptap's wrapper, so the plugin joins the editor with the rest of them. */
const Pagination = Extension.create<PaginationOptions>({
  name: 'statementPagination',
  addOptions() {
    return {
      getGeometry: () => null,
      getMaxPages: () => null,
      onLayout: () => {},
      register: () => {},
    }
  },
  addProseMirrorPlugins() {
    return [paginationPlugin(this.options)]
  },
})

/**
 * The gap itself: the foot of one sheet, the gutter, the head of the next.
 *
 * NOT EDITABLE AND NOT ANNOUNCED. contenteditable=false keeps the caret out of
 * it, and aria-hidden keeps it out of the text a screen reader reads -- it is
 * furniture, not content. The page number is for the eye.
 */
function pageBreakElement(index: number): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = 'statement-page-break'
  wrapper.contentEditable = 'false'
  wrapper.setAttribute('aria-hidden', 'true')
  const gutter = document.createElement('span')
  gutter.className = 'statement-page-break-gutter'
  const label = document.createElement('span')
  label.className = 'statement-page-break-label'
  label.textContent = `Page ${index + 2}`
  gutter.appendChild(label)
  wrapper.appendChild(gutter)
  return wrapper
}

/**
 * Pasted HTML, as a ProseMirror document, using the editor's own schema.
 *
 * THE SCHEMA IS THE FIRST FILTER. DOMParser plus ProseMirror's parse rules
 * already discard every node and mark the schema has no place for, which is
 * why only strong survives: it is the only mark registered. constrainDocument
 * is then the second, independent filter over the JSON.
 */
function parseHtmlToDoc(html: string, view: EditorView): unknown {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return ProseMirrorDOMParser.fromSchema(view.state.schema)
    .parse(parsed.body)
    .toJSON()
}

export default function PaginatedEditor({
  essay,
  geometry,
  maxPages = null,
  /** The stored constrained document, or null for a draft that has none. */
  initialDocument = null,
  fontChoice = null,
  onFontChange,
  readOnly = false,
  onEssayChange,
  onDocumentChange,
  onMeasure,
}: {
  essay: string
  geometry: PageGeometry
  /** The school's page maximum, which the allowance line is drawn at. */
  maxPages?: number | null
  initialDocument?: unknown
  /**
   * The font the applicant may choose, and from what.
   *
   * ---------------------------------------------------------------------------
   * THE CONTROL IS RENDERED FROM THE CHOICE, NOT FROM A LIST OF FONTS
   * ---------------------------------------------------------------------------
   * documentFontChoice() has already read the school's record and the
   * applicant's stored preference and settled what is legal. This component
   * renders what it was handed: a locked choice shows what is required and
   * offers nothing, and a free one offers exactly the faces this product
   * bundles. There is no path here that can offer a font the school forbade.
   *
   * OMITTED MEANS NO CONTROL, which is what the preview surfaces want.
   */
  fontChoice?: DocumentFontChoice | null
  onFontChange?: (id: StudioFontId) => void
  readOnly?: boolean
  onEssayChange: (essay: string) => void
  /**
   * The constrained document, whenever the essay changes AND whenever only
   * its formatting does.
   *
   * TWO CALLBACKS, BECAUSE THEY ARE TWO FACTS. Bolding a word changes the
   * document and not the essay; the engine still has to mark the draft dirty,
   * and the analysis fingerprint still has to stay exactly where it was.
   */
  onDocumentChange?: (document: unknown) => void
  /** What the layout pass found. null heights before the first pass. */
  onMeasure: (measurements: {
    contentHeightPt: number | null
    pagesUsed: number | null
  }) => void
}) {
  /**
   * How many breaks are rendered, for the sheet's height.
   *
   * THE SHEET MUST BE AS TALL AS THE PAGES IT HOLDS. The breaks are in the
   * text's flow, so the paper has to reach past the last one -- and a page the
   * applicant has started should look like a whole page rather than stopping at
   * the last line they typed, which is what a word processor shows.
   */
  const [breaks, setBreaks] = useState(0)
  /**
   * Where the allowance line goes, as the last pass measured it.
   *
   * null UNTIL THE PAGE IT FALLS ON EXISTS. Boston's 1.5 pages is halfway down
   * page two, so the line appears when page two does -- which is the point at
   * which it means something.
   */
  const [allowanceOffset, setAllowanceOffset] = useState<number | null>(null)

  /**
   * The plugin's re-measure hook, published upward.
   *
   * A FONT FINISHING LOADING IS NOT AN EDITOR UPDATE, so the plugin would not
   * hear about it on its own.
   */
  const remeasure = useRef<(() => void) | null>(null)
  /**
   * The last value this component emitted.
   *
   * WHY IT IS TRACKED. The parent owns `essay`, so a save, a reload or a
   * conflict re-read can push a new value down. Writing every incoming value
   * into the editor would reset the caret on each keystroke, because our own
   * change comes straight back. Comparing against what we emitted tells the two
   * apart: an echo is ignored, a genuine external change is applied.
   */
  const emitted = useRef(essay)
  const [ready, setReady] = useState(false)

  /**
   * The live inputs the plugin reads, behind refs.
   *
   * THE EXTENSION LIST IS BUILT ONCE. Rebuilding it would recreate the editor
   * and lose the caret, so the plugin reads the current geometry through a ref
   * rather than closing over the value it was created with.
   */
  const pagination = useRef<PaginationGeometry>(paginationGeometry(geometry))
  pagination.current = paginationGeometry(geometry)
  const maxPagesRef = useRef<number | null>(maxPages)
  maxPagesRef.current = maxPages
  const onMeasureRef = useRef(onMeasure)
  onMeasureRef.current = onMeasure
  const onDocumentChangeRef = useRef(onDocumentChange)
  onDocumentChangeRef.current = onDocumentChange

  const editor = useEditor({
    // SSR OFF. The editor measures real geometry, which does not exist on a
    // server, and a hydration mismatch here would flash the wrong layout.
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      Document, Paragraph, Text,
      /*
        THE ONE MARK, AND ITS KEYBOARD SHORTCUT.

        Tiptap's Bold ships Cmd+B / Ctrl+B and parses <strong>, <b> and
        font-weight into the same mark, so the toolbar button, the shortcut and
        a paste all produce one representation. Nothing else is registered:
        a mark the schema does not know cannot enter the document at all,
        which is what makes the paste filter a second line of defence rather
        than the only one.
      */
      Bold,
      PlainTextPaste,
      Pagination.configure({
        getGeometry: () => pagination.current,
        getMaxPages: () => maxPagesRef.current,
        onLayout: (layout: PaginationLayout) => {
          setBreaks(layout.breaks)
          setAllowanceOffset(layout.allowanceOffsetPx)
          onMeasureRef.current({
            contentHeightPt: layout.rawHeightPx * PT_PER_PX,
            pagesUsed: layout.pagesUsed,
          })
        },
        register: (fn: () => void) => { remeasure.current = fn },
      }),
    ],
    // CAST AT THE BOUNDARY, ONCE. The bridge returns readonly arrays because
    // nothing should mutate a document it did not build; Tiptap's JSONContent
    // is mutable. The shapes are identical, so this is a variance cast and not
    // a conversion.
    /*
      THE STORED DOCUMENT WINS, WHEN THERE IS ONE.

      A draft written before formatting existed has none, and reconstructs
      from the essay as text with no bold -- which is exactly what it was.
      A stored document is constrained on the way in as well as on the way
      out, so a row written by a future build with marks this one cannot
      render still loads, as text.
    */
    content: (initialDocument === null
      ? essayToDoc(essay)
      : constrainDocument(initialDocument)) as unknown as JSONContent,
    editorProps: {
      attributes: {
        'aria-label': 'Personal statement',
        // Kept from the textarea: the applicant had these and must not lose them.
        spellcheck: 'true',
        class: 'statement-page-content focus:outline-none',
      },
    },
    onUpdate: ({ editor: instance }) => {
      const json = instance.getJSON()
      const next = docToEssay(json)
      emitted.current = next
      // THE DOCUMENT FIRST. A bold-only edit leaves `next` identical, so the
      // parent's essay handler will do nothing; the document handler is what
      // tells it something changed at all.
      onDocumentChangeRef.current?.(constrainDocument(json))
      onEssayChange(next)
    },
  }, [])

  useEffect(() => { if (editor) setReady(true) }, [editor])

  // An external change -- a conflict re-read, a reload -- replaces the content.
  // Our own echo is ignored, so typing never resets the caret.
  useEffect(() => {
    if (!editor || essay === emitted.current) return
    emitted.current = essay
    editor.commands.setContent(
      essayToDoc(essay) as unknown as JSONContent, { emitUpdate: false })
  }, [editor, essay])

  useEffect(() => { editor?.setEditable(!readOnly) }, [editor, readOnly])

  /*
   * MEASUREMENT HAS ONE AUTHORITY, and it is the plugin.
   *
   * It has to be the plugin: where the breaks fall and how much of the page is
   * used are answers to the same measuring pass, and a second observer reading
   * scrollHeight would report a height that still had the gaps in it -- a 1.21
   * page essay reading as 1.47 the moment a break appeared. The plugin reports
   * the text's height with the gaps taken back out, which is the figure the
   * panel needs and the one the breaks were computed from.
   */
  useEffect(() => {
    if (!ready || typeof document === 'undefined') return
    // THE FONT MUST BE LOADED BEFORE A MEASUREMENT IS BELIEVED: a fallback face
    // wraps differently, so a height measured mid-swap is wrong -- and briefly
    // wrong is enough to show a page count that then jumps.
    void document.fonts?.ready.then(() => remeasure.current?.())
  }, [ready])

  const box = contentBox(geometry)

  /*
    WHETHER THE SELECTION IS BOLD, re-read on every editor transaction.

    useEditorState keeps this in step with the caret without re-rendering the
    whole surface on every keystroke: it subscribes to the editor and compares
    the one boolean it selects.
  */
  const bold = useEditorState({
    editor,
    selector: ({ editor: instance }) => instance?.isActive('bold') ?? false,
  }) ?? false

  return (
    <div className="statement-page-surface">
      {/*
        THE SHEET. Real units throughout -- inches for the paper and the
        margins, points for the type -- so the browser lays out the page the
        school asked for rather than an approximation of it scaled to the
        viewport.
      */}
      <style>{`
        ${studioFontFaceCss()}
        .statement-page-surface {
          --page-width: ${geometry.paperWidthIn.value}in;
          --page-margin: ${geometry.marginsIn.value}in;
          --page-content-width: ${box.widthPt / 72}in;
          --page-content-height: ${box.heightPt / 72}in;
          --page-font-size: ${geometry.fontSizePt.value}pt;
          --page-line-height: ${geometry.lineHeightPt}pt;
          --page-indent: ${geometry.firstLineIndentIn.value}in;
          --page-gutter: ${GUTTER_PX}px;
          /* The surface the sheets sit on, which shows through every gap. */
          --page-gutter-fill: #f1f5f9;
          --page-limit-ink: #b45309;
          /*
            THE PAPER NEVER REFLOWS, SO IT SCROLLS.

            A sheet that shrank to fit a narrow window would narrow the text
            column with it, and a narrower column wraps the same essay into more
            lines -- so the page count would depend on the size of the browser
            window. The measurement has to be a fact about the page, not about
            the viewport, so the column stays 6.5in and the surface scrolls.

            Auto margins on the sheet, not justify-content: center -- they
            centre it when there is room and collapse to zero when there is not,
            where centring a flex item wider than its container puts its left
            edge somewhere the reader cannot scroll to.
          */
          overflow-x: auto;
        }
        .statement-page-sheet {
          width: var(--page-width);
          padding: var(--page-margin);
          background: #fff;
          box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12), 0 8px 24px rgba(15, 23, 42, 0.06);
        }
        .statement-page-content {
          /* THE CHOSEN FACE, FROM THE GEOMETRY THE PAGE WAS MEASURED WITH.
             It used to be a constant, which was fine while one face existed
             and would now be a stylesheet that disagreed with the line box.
             The fallbacks exist only for the instant before it loads;
             measurement waits for document.fonts.ready, so a fallback's
             metrics never reach a reported page count. */
          font-family: ${geometry.fontStack};
          font-size: var(--page-font-size);
          line-height: var(--page-line-height);
          color: #0f172a;
          /* Deterministic measurement: no engine-chosen adjustments. */
          text-size-adjust: none;
          -webkit-text-size-adjust: none;
          font-kerning: normal;
          text-rendering: optimizeLegibility;
          /*
            ONE LINE MAY SIT ALONE EITHER SIDE OF A PAGE BREAK.
            
            THIS SAID ZERO, WHICH IS INVALID AND WAS SILENTLY WORSE THAN WRONG.
            CSS Fragmentation allows only a positive integer, so the declaration
            was dropped at parse time and each engine fell back to its own
            initial value -- measured as 2 in Chromium and auto in WebKit. A
            paragraph could then not split with fewer than two lines on a side,
            pushing lines across boundaries that this module's arithmetic does
            not model, and differently in each browser.
            
            1 is honoured identically by both, confirmed on screen and in print
            media: a paragraph may break anywhere, which is what lets a page
            boundary fall mid-paragraph exactly where the geometry says.
          */
          widows: 1;
          orphans: 1;
          /*
            EVERY PROPERTY THAT CAN MOVE A LINE BREAK, PINNED.
            Justification varies inter-word spacing per line and is not
            identical across engines; hyphenation depends on a pattern set that
            ships with the browser; tracking changes line length. Each would
            make the same essay wrap differently on a different machine.
          */
          text-align: left;
          letter-spacing: normal;
          word-spacing: normal;
          hyphens: none;
          -webkit-hyphens: none;
          font-variant-ligatures: none;
          white-space: pre-wrap;
          overflow-wrap: break-word;
        }
        /*
          ---------------------------------------------------------------------
          THE PAGE GAP
          ---------------------------------------------------------------------
          A block in the text's own flow, not a backdrop. It is the bottom
          margin of the page above, the gutter, and the top margin of the page
          below -- so the next line of text begins exactly one page down, and
          the caret, the selection and the boundary all come out of the single
          layout that produced them.

          FULL BLEED. The negative margins cancel the sheet's padding so the
          gutter reaches both edges of the paper; a gap inset by the margin
          would read as a rule drawn on one long page.
        */
        .statement-page-break {
          display: block;
          padding-top: var(--page-margin);
          padding-bottom: var(--page-margin);
          margin-left: calc(-1 * var(--page-margin));
          margin-right: calc(-1 * var(--page-margin));
          /* Furniture: not selectable, and a click in it is not a click in text. */
          user-select: none;
          -webkit-user-select: none;
          pointer-events: none;
        }
        .statement-page-break-gutter {
          display: block;
          position: relative;
          height: var(--page-gutter);
          background: var(--page-gutter-fill);
          /* The paper's own edges, so two sheets read as two sheets. */
          box-shadow:
            inset 0 10px 7px -7px rgba(15, 23, 42, 0.38),
            inset 0 -10px 7px -7px rgba(15, 23, 42, 0.26);
          border-top: 1px solid rgba(15, 23, 42, 0.10);
          border-bottom: 1px solid rgba(15, 23, 42, 0.07);
        }
        .statement-page-break-label {
          position: absolute;
          top: 50%;
          right: var(--page-margin);
          transform: translateY(-50%);
          /* ITS OWN TYPE. The page's 12pt Tinos and 37px line box are the
             essay's, and a label that inherited them would be a line of text. */
          font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
          font-size: 10px;
          line-height: 1;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #94a3b8;
        }
        /*
          ---------------------------------------------------------------------
          THE ALLOWANCE LINE
          ---------------------------------------------------------------------
          ZERO HEIGHT. The rule is drawn by a child taken out of the flow, so it
          costs no vertical space -- a line that occupied any would push the text
          down and move the boundary it was drawn at.
        */
        .statement-page-flow {
          /* The frame the allowance line is positioned against: its top is the
             top of the text, which is what the measured offset is relative to. */
          position: relative;
        }
        .statement-limit-rule {
          /* OUT OF THE FLOW. An element that occupied any height would push the
             text down and move the boundary it was drawn at. */
          position: absolute;
          left: calc(-1 * var(--page-margin));
          right: calc(-1 * var(--page-margin));
          border-top: 1px dashed var(--page-limit-ink);
          user-select: none;
          -webkit-user-select: none;
          pointer-events: none;
        }
        .statement-limit-rule-label {
          position: absolute;
          top: 3px;
          right: var(--page-margin);
          padding: 2px 5px;
          background: #fff;
          font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
          font-size: 10px;
          font-weight: 600;
          line-height: 1;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--page-limit-ink);
        }
        /*
          ---------------------------------------------------------------------
          TEXT PAST THE ALLOWANCE
          ---------------------------------------------------------------------
          MARKED, NOT PUNISHED. It stays editable, stays the same size and keeps
          its own colour, because this is text the applicant has to be able to
          work on -- cutting an essay to length means reading and rewriting the
          part that is over. A wash behind it says where the limit fell; dimming
          or shrinking it would say do not touch this.

          BACKGROUND ONLY. Anything that occupied space -- a border, padding, a
          different size -- would re-wrap the text and invalidate the
          measurement that decided where this decoration starts.
        */
        .statement-over-limit {
          background-color: rgba(245, 158, 11, 0.16);
          box-decoration-break: clone;
          -webkit-box-decoration-break: clone;
        }
        /*
          BOLD IS THE REAL FACE, NOT A SMEAR.

          font-synthesis: none REFUSES a synthesised bold outright. Without it
          a browser that failed to load the 700 face would silently thicken
          the 400 one, and the page count would quietly become a number that
          depends on which engine drew it. Better to render visibly un-bold
          than to paginate from a face nobody shipped.

          DECLARED ON THE WHOLE PAGE, NOT ONLY ON strong/b. It used to sit on
          those two selectors alone, which left the container itself at the
          initial value -- so anything bold that was not wearing one of those
          two tags, now or later, could still be smeared. The refusal belongs
          to the measured surface, and inheritance carries it to every element
          inside it.
        */
        .statement-page-content {
          font-synthesis: none;
          -webkit-font-synthesis: none;
        }
        .statement-page-content strong,
        .statement-page-content b {
          font-weight: 700;
        }
        .statement-page-content p {
          /*
            ZERO SPACING, STATED. A browser's default <p> margin is about one
            blank line, so a six-paragraph essay would gain six lines nobody
            typed -- a third of a double-spaced page.
            
            min-height GIVES AN EMPTY PARAGRAPH ITS LINE BOX, so pressing Enter
            twice costs exactly one line of the allowance: what the applicant
            sees as one blank line is one line.

            text-indent IS ZERO UNLESS A FORMAT PROFILE ASKS FOR ONE. APA
            requires half an inch on the first line of every paragraph, and
            text-indent is exactly that -- the FIRST line only, which is why
            it is not a padding. It changes where words wrap, so the page
            measurement sees it like any other layout rule.
          */
          margin: 0;
          padding: 0;
          text-indent: var(--page-indent);
          min-height: var(--page-line-height);
        }
      `}</style>
      {/*
        A CLICK ON THE BLANK PART OF A PAGE PUTS THE CARET AT THE END, which is
        what every word processor does. The sheet reaches past the last line so
        a started page looks like a page, and without this the paper below the
        text would be dead to the mouse.
      */}
      {/*
        THE ONE CONTROL, AND IT REFLECTS THE SELECTION.

        `isActive` is read from the live editor rather than tracked here, so
        the button cannot disagree with the caret: moving into bold text lights
        it up, and Cmd+B toggles the same mark the button does because both go
        through the same Tiptap command.

        aria-pressed, NOT A COLOUR ALONE. Whether the next character will be
        bold is state, and state that is only visible as a shade of grey is not
        available to everyone.
      */}
      {/*
        THE PAGE IS WIDER THAN A PHONE, AND SAYING SO IS THE FIX.

        ---------------------------------------------------------------------
        WHY THE SHEET IS NOT MADE TO FIT
        ---------------------------------------------------------------------
        The obvious mobile treatment -- shrink the paper to the viewport -- is
        the one thing this editor may not do. The text column IS the
        measurement: narrow it and the same essay wraps into more lines, so the
        page count would depend on the width of the reader's phone. A number
        that moves when you rotate the device is worse than no number.

        So the paper keeps its real size and the surface scrolls, and at phone
        width the reader is told that in words -- once, quietly, above the
        sheet. Pinch-to-zoom is the browser's own and is left alone: it scales
        the rendering without touching layout, which is exactly the property
        the measurement needs.

        `sm:hidden` BECAUSE IT IS ONLY TRUE BELOW 640px. On a desktop the sheet
        fits and there is nothing to explain.
      */}
      <p className="mx-auto mb-2 w-full max-w-[8.5in] text-[11px] leading-relaxed text-slate-500 sm:hidden">
        This is your page at its real printed size, so the page count stays
        exact. Scroll sideways or pinch to zoom — the text does not re-wrap to
        fit the screen.
      </p>

      {!readOnly && (
        <div className="mx-auto mb-3 flex w-full max-w-[8.5in] flex-wrap items-center gap-x-2 gap-y-2">
          <button
            type="button"
            aria-label="Bold"
            aria-keyshortcuts="Control+B Meta+B"
            aria-pressed={bold}
            disabled={editor === null}
            // THE CARET MUST NOT MOVE. A toolbar button steals focus by
            // default, which collapses the selection the applicant is trying
            // to format; preventing the mousedown keeps it where it was.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor?.chain().focus().toggleBold().run()}
            className={`${TOUCH_TARGET_SQUARE} inline-flex h-11 w-11 items-center justify-center
              rounded-md border text-sm font-bold transition sm:h-8 sm:w-8 ${
              bold
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            } disabled:opacity-40`}
          >
            B
          </button>
          <span className="text-[11px] text-slate-500">
            Bold &mdash; {shortcutHint}
          </span>

          {/*
            THE DOCUMENT'S FONT.

            ---------------------------------------------------------------
            A DOCUMENT-LEVEL CONTROL, SITTING BESIDE AN INLINE ONE
            ---------------------------------------------------------------
            Bold applies to the selection; this applies to the whole document,
            and the Studio deliberately offers no way to make it apply to less
            than that. A personal statement set in three typefaces is a
            personal statement an admissions reader stops reading.

            So it is a select rather than a toggle, it has no relationship to
            the caret, and changing it does not touch a single character --
            which is why the word count, the character count and the analysis
            fingerprint are all untouched by it.

            LOCKED IS SHOWN, NOT HIDDEN. A school that requires one family gets
            a disabled control naming it, because "you may not choose" is
            information; an empty space is not.
          */}
          {fontChoice !== null && (
            <div className="flex items-center gap-2 sm:ml-auto">
              <label
                htmlFor="statement-document-font"
                className="text-[11px] font-medium text-slate-600"
              >
                Font
              </label>
              <select
                id="statement-document-font"
                value={fontChoice.selected.font.id}
                disabled={fontChoice.locked || onFontChange === undefined}
                onChange={(event) => onFontChange?.(event.target.value as StudioFontId)}
                className={`${TOUCH_TARGET} rounded-md border border-slate-300 bg-white px-2 py-2 text-xs text-slate-800 focus:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 sm:py-1`}
              >
                {fontChoice.options.map((option) => (
                  <option key={option.font.id} value={option.font.id}>
                    {option.sizePt === null
                      ? `${option.font.label} (${option.font.standsFor})`
                      : `${option.font.label} (${option.font.standsFor}) — ${option.sizePt} pt`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/*
        WHAT THE FONT IS, AND WHAT IT IS NOT.

        The substitution sentence is the registry's, printed where the choice
        was made rather than only in a panel further down the page: an
        applicant picking Arimo has to read "this is not Arial" at the moment
        they pick it, not after they have laid out three pages.

        AND WHAT WAS PERMITTED BUT IS NOT OFFERED. A school or a standard that
        allows a font this product does not bundle is a fact the applicant
        should have -- the alternative is a list that looks arbitrary.
      */}
      {fontChoice !== null
        && (fontChoice.selected.note !== null || fontChoice.unavailable.length > 0) && (
        <div className="mx-auto mb-3 w-full max-w-[8.5in] grid gap-1">
          {fontChoice.selected.note !== null && (
            <p className="text-[11px] leading-relaxed text-amber-800">
              {fontChoice.selected.note}
            </p>
          )}
          {fontChoice.unavailable.map((entry) => (
            <p key={entry.family} className="text-[11px] leading-relaxed text-slate-500">
              {entry.family}: {entry.why}
            </p>
          ))}
        </div>
      )}
      <div
        className="statement-page-sheet mx-auto rounded-sm"
        style={{ minHeight: `${sheetHeightPx(geometry, breaks)}px` }}
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget || readOnly) return
          event.preventDefault()
          editor?.commands.focus('end')
        }}
      >
        <div className="statement-page-flow">
          <EditorContent editor={editor} />
          {/*
            THE ALLOWANCE LINE, drawn over the page rather than inside the text.

            It is out of the flow, so it moves nothing and costs no height, and
            its offset came out of the same pass that placed the page breaks --
            so it cannot drift from them. aria-hidden because the panel states
            the limit in words; this is the same fact, for the eye.
          */}
          {allowanceOffset !== null && (
            <div
              className="statement-limit-rule"
              style={{ top: `${allowanceOffset}px` }}
              aria-hidden="true"
            >
              <span className="statement-limit-rule-label">Page limit</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
