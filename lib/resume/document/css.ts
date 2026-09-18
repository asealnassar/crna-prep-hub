/**
 * The document's stylesheet, and the tokens each template feeds it.
 *
 * WHY A STRING AND NOT A .css FILE. This renderer is mounted twice: by the
 * Studio preview and, from Phase 6, by whatever produces the PDF. A stylesheet
 * that only exists as a bundler import cannot travel with serialised markup, so
 * the export path would need a second copy — and a second copy is how a preview
 * and its PDF drift apart, which is the single most common complaint about V1.
 * As a string it can be inlined in a <style> tag by both consumers.
 *
 * WHY VARIANTS AND NOT ONE RULE-SET PER TEMPLATE. Structure is selected by data
 * attributes -- data-layout, data-heading-style, data-entry-layout -- and size
 * comes through CSS custom properties. A fourth template is a new object in
 * templates.ts; it needs new CSS only if it invents a new structural value.
 * That is the "tokens plus variants rather than forks" the blueprint asked for.
 */

import type { TemplateDefinition } from './templates.ts'
import {
  PAGE_CONTENT_HEIGHT_PX, PAGE_CONTENT_WIDTH_PX, PAGE_FLOW_GAP_PX, PRINT_BODY_MARGIN_PX,
} from './pages.ts'

/** CSS custom properties for one template. Consumed as an inline style. */
export function cssVariablesFor(template: TemplateDefinition): Record<string, string> {
  const t = template.tokens
  return {
    '--rd-body': `${t.bodyPt}pt`,
    '--rd-heading': `${t.headingPt}pt`,
    '--rd-name': `${t.namePt}pt`,
    '--rd-leading': String(t.leading),
    '--rd-section-gap': `${t.sectionGapPt}pt`,
    '--rd-entry-gap': `${t.entryGapPt}pt`,
    '--rd-font': t.fontStack,
  }
}

/**
 * Page geometry, structural variants and print rules.
 *
 * Colours are deliberately near-absent: a resume is black text on white paper,
 * and a template that differed by palette would fail the tests in
 * templates.test.ts. The only non-black value is the muted grey used for
 * secondary metadata, which prints legibly.
 */
export const DOCUMENT_CSS = `
.rd-root {
  --rd-ink: #111827;
  --rd-muted: #4b5563;
  --rd-rule: #d1d5db;
  font-family: var(--rd-font);
  font-size: var(--rd-body);
  line-height: var(--rd-leading);
  color: var(--rd-ink);
  background: #ffffff;
  /* LIGATURES OFF, AND THIS IS NOT COSMETIC. A font that renders "fi" as one
     glyph stores that ligature in the PDF's text layer, and extraction gives
     back "certication", "qualied", "eciency". A resume is read by software
     before it is read by a person, so every one of those is a keyword an
     applicant tracking system fails to match. The round-trip test caught this
     on a certification list; at resume sizes the visual difference is
     imperceptible. Belt and braces: the feature settings cover renderers that
     ignore the shorthand. */
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0, "clig" 0, "dlig" 0;
}

/* US Letter with half-inch margins. The preview shows the same box the PDF
   will use, so "it looked different when I downloaded it" cannot happen. */
.rd-page {
  position: relative;
  width: 8.5in;
  min-height: 11in;
  padding: 0.5in;
  margin: 0 auto;
  box-sizing: border-box;
  background: #ffffff;
}

.rd-header { margin-bottom: var(--rd-section-gap); }
.rd-root[data-header-align="center"] .rd-header { text-align: center; }
.rd-root[data-header-align="left"] .rd-header { text-align: left; }

.rd-name {
  font-size: var(--rd-name);
  font-weight: 700;
  letter-spacing: 0.01em;
  margin: 0 0 4pt;
}
.rd-contact {
  color: var(--rd-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 0 10pt;
  justify-content: inherit;
  margin: 0;
  padding: 0;
  list-style: none;
}
.rd-root[data-header-align="center"] .rd-contact { justify-content: center; }

/* --- columns ---------------------------------------------------------- */

.rd-columns { display: block; }
/* Roughly a quarter to the sidebar, the rest to the narrative. The sidebar
   holds lines -- a certification, a licence, a degree -- and a line needs
   little width; bullets and paragraphs need a lot, and at the old 1:2.1 the
   clinical experience that decides an application was the column being
   squeezed. Aligning to start keeps a short sidebar short rather than
   stretching it into a tall empty column beside the page. */
.rd-root[data-layout="sidebar"] .rd-columns {
  display: grid;
  grid-template-columns: 1fr 2.85fr;
  gap: var(--rd-section-gap);
  align-items: start;
}
/* Placed explicitly rather than by source order. The main column is FIRST in
   the DOM so extracted text reads as a resume -- name, summary, experience --
   and these coordinates put the sidebar back on the left visually. Without
   them, a two-column template would hand an ATS a list of licence numbers
   before it said who the applicant was. */
.rd-root[data-layout="sidebar"] .rd-aside { grid-column: 1; grid-row: 1; }
.rd-root[data-layout="sidebar"] .rd-main { grid-column: 2; grid-row: 1; }
.rd-aside { min-width: 0; }
.rd-main { min-width: 0; }

/* READ IN ORDER, WHATEVER THE COLUMN. Where a section is drawn is the
   applicant's choice; the order it is read in is not. Chromium writes a PDF's
   text layer in paint order, and positioned elements with a z-index paint in
   z-index order across both columns -- so each section's reading position is
   its z-index, and the text layer follows the reading order even when Critical
   Care has been moved into the sidebar. Relative positioning with no offset
   moves nothing and no section overlaps another, so the page looks exactly as
   it did. When watermarked, the columns are their own stacking context, which
   keeps every section beneath the mark. */
.rd-root[data-layout="sidebar"] .rd-section {
  position: relative;
  z-index: var(--rd-reading-order, auto);
}

/* --- sections --------------------------------------------------------- */

.rd-section { margin-bottom: var(--rd-section-gap); }
.rd-section:last-child { margin-bottom: 0; }

.rd-heading {
  font-size: var(--rd-heading);
  font-weight: 700;
  margin: 0 0 6pt;
}
.rd-root[data-heading-style="ruled"] .rd-heading {
  border-bottom: 0.75pt solid var(--rd-rule);
  padding-bottom: 3pt;
}
.rd-root[data-heading-style="caps"] .rd-heading {
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
/* Inline headings sit in a gutter beside their content, which is where the
   compact template finds most of the vertical space it saves. The gutter is
   1.55in -- wide enough for two words per line, where 1.15in stacked
   "VOLUNTEER / AND / COMMUNITY / SERVICE" one word at a time. */
.rd-root[data-heading-style="inline"] .rd-section {
  display: grid;
  grid-template-columns: 1.55in 1fr;
  gap: 0 10pt;
}
.rd-root[data-heading-style="inline"] .rd-heading {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0;
  /* Break inside a word only when a word alone cannot fit. */
  overflow-wrap: break-word;
  hyphens: none;
}
/* The fallback for a heading no gutter can hold: it spans the section instead
   of shredding the body width beside it. See isLongHeading in templates.ts. */
.rd-root[data-heading-style="inline"] .rd-section[data-long-heading="true"] {
  display: block;
}
.rd-root[data-heading-style="inline"] .rd-section[data-long-heading="true"] .rd-heading {
  margin-bottom: 3pt;
}

/* --- entries ---------------------------------------------------------- */

.rd-entry { margin-bottom: var(--rd-entry-gap); }
.rd-entry:last-child { margin-bottom: 0; }

/* A credential is one line. Six of them separated by an entry gap meant for a
   job with bullets reads as a list with holes punched in it, so the sections
   made of single-line entries close up. */
.rd-section[data-section-type="certifications"] .rd-entry {
  margin-bottom: calc(var(--rd-entry-gap) * 0.35);
}

.rd-entry-head { display: block; }
.rd-root[data-entry-layout="opposed"] .rd-entry-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12pt;
}
/* The title side yields; the date does not. A long employer name wraps onto a
   second line rather than pushing "Mar 2021 – Present" off the edge or
   breaking it in half. */
.rd-root[data-entry-layout="opposed"] .rd-entry-head > :first-child {
  min-width: 0;
  flex: 1 1 auto;
}
.rd-root[data-entry-layout="opposed"] .rd-meta { flex: 0 0 auto; }

/* Except in the sidebar, where an opposed head has nowhere to go: the title
   wraps to three cramped lines while the date hangs at a right edge two inches
   away, and neither is easy to read. A credential there stacks -- what it is,
   then when -- and keeps the full column width for the name. */
.rd-root[data-layout="sidebar"] .rd-aside .rd-entry-head { display: block; }

/* And the two halves stack rather than running together behind an em dash.
   "BSN, Nursing -- Rutgers University" does not fit in two inches, so it breaks
   wherever the line runs out -- often mid-name. A reader loses nothing; a
   parser searching for the institution loses the name. Given a line of its own,
   the name stays whole. */
.rd-root[data-layout="sidebar"] .rd-aside .rd-title,
.rd-root[data-layout="sidebar"] .rd-aside .rd-subtitle { display: block; }
.rd-root[data-layout="sidebar"] .rd-aside .rd-entry-head [aria-hidden="true"] { display: none; }

.rd-title { font-weight: 700; }
.rd-subtitle { color: var(--rd-ink); }
.rd-meta { color: var(--rd-muted); white-space: nowrap; }
.rd-location { color: var(--rd-muted); }
.rd-notes {
  color: var(--rd-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 0 8pt;
  margin: 1pt 0 0;
  padding: 0;
  list-style: none;
}

/* REAL BULLETS, STATED HERE RATHER THAN INHERITED. The marker was left to the
   browser default, and the preview mounts inside an application whose reset
   sets list-style to none on every ul -- so the glyphs vanished in the Studio
   while surviving in the PDF. A class selector states it outright and beats any
   host reset.

   An outside marker is what gives the hanging indent: it sits in the padding,
   so every wrapped line aligns with the text above it, not under the glyph. */
.rd-bullets {
  list-style: disc outside;
  margin: 3pt 0 0;
  padding-left: 13pt;
}
.rd-bullets li { margin-bottom: 2pt; padding-left: 1pt; }
.rd-bullets li:last-child { margin-bottom: 0; }
.rd-bullets li::marker { font-size: 0.85em; }

/* Authored prose inside an entry: a shadowing reflection, what a volunteer role
   involved, a citation. Paragraphs, because that is what the applicant wrote --
   a bullet glyph here would turn a sentence into a claim about its own shape. */
.rd-details { margin: 3pt 0 0; }
.rd-paragraph { margin: 0 0 4pt; }
.rd-paragraph:last-child { margin-bottom: 0; }

/* --- preview watermark ------------------------------------------------ */

/*
 * Shown to every tier that cannot export. The preview itself is complete and
 * untouched -- not blurred, not truncated, not paywalled behind a fold -- so
 * the applicant can see exactly what they are building. What they cannot do is
 * take a clean copy of it away.
 *
 * IT MUST SURVIVE PRINT. Browser print is the obvious way round an export
 * gate, so these rules live outside @media screen and are re-asserted inside
 * @media print with print-color-adjust, which is what stops a browser
 * helpfully dropping "background" colours from the printed page. A watermark
 * that vanishes on Ctrl+P would be worse than none: it would look like a gate
 * while being none.
 */
.rd-watermark {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  align-items: center;
  overflow: hidden;
  pointer-events: none;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.rd-watermark span {
  display: block;
  white-space: nowrap;
  transform: rotate(-28deg);
  font-family: var(--rd-font);
  font-size: 15pt;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: rgba(17, 24, 39, 0.13);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
/* The document keeps its own stacking context beneath the mark. */
.rd-root[data-watermarked="true"] .rd-columns,
.rd-root[data-watermarked="true"] .rd-header {
  position: relative;
  z-index: 1;
}

/* --- paginated preview ------------------------------------------------- */

/*
 * The preview shows the pages the PDF will have, and lets the browser decide
 * where they break. A multi-column flow whose column is exactly one printed
 * page's content box is broken into columns by the same fragmentation engine,
 * under the same rules in this stylesheet, that breaks the printed document
 * into pages. Each preview sheet then shows one column.
 *
 * Inside it, the page is laid out as it is in print: the page element loses
 * its screen padding and minimum height exactly as the print rules below take
 * them away, and the flow body carries the default body margin the exported
 * PDF keeps. Nothing here cuts content at a pixel height.
 */
.rd-flow {
  width: ${PAGE_CONTENT_WIDTH_PX}px;
  height: ${PAGE_CONTENT_HEIGHT_PX}px;
  column-width: ${PAGE_CONTENT_WIDTH_PX}px;
  column-gap: ${PAGE_FLOW_GAP_PX}px;
  column-fill: auto;
}
.rd-flow-body { margin: ${PRINT_BODY_MARGIN_PX}px; }
.rd-root[data-paginated="true"] .rd-page {
  width: auto;
  min-height: 0;
  padding: 0;
  margin: 0;
}

/* --- print ------------------------------------------------------------ */

@page { size: letter; margin: 0.5in; }

@media print {
  .rd-page {
    width: auto;
    min-height: 0;
    padding: 0;
    margin: 0;
  }
  .rd-root { font-size: var(--rd-body); }

  /* Re-asserted, and forced. Print → Save as PDF must not be a clean export. */
  .rd-watermark {
    display: flex !important;
    visibility: visible !important;
    opacity: 1 !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .rd-watermark span {
    color: rgba(17, 24, 39, 0.18) !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
}

/* Page-break control. An entry split across a page boundary and a heading
   stranded at the foot of a page are the two defects that make an exported
   resume look careless, and both are preventable here rather than in the
   exporter. Applied outside @media print too: the preview must break the same
   way the PDF will. */
.rd-entry { break-inside: avoid; page-break-inside: avoid; }
.rd-heading { break-after: avoid; page-break-after: avoid; }
.rd-section { break-inside: auto; }
.rd-bullets li { break-inside: avoid; page-break-inside: avoid; }
.rd-header { break-after: avoid; page-break-after: avoid; }
`.trim()
