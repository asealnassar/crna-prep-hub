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
}

/* US Letter with half-inch margins. The preview shows the same box the PDF
   will use, so "it looked different when I downloaded it" cannot happen. */
.rd-page {
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
.rd-root[data-layout="sidebar"] .rd-columns {
  display: grid;
  grid-template-columns: 1fr 2.1fr;
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
/* Inline headings sit in a narrow gutter beside their content, which is where
   the compact template finds most of the vertical space it saves. */
.rd-root[data-heading-style="inline"] .rd-section {
  display: grid;
  grid-template-columns: 1.15in 1fr;
  gap: 0 10pt;
}
.rd-root[data-heading-style="inline"] .rd-heading {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 0;
}

/* --- entries ---------------------------------------------------------- */

.rd-entry { margin-bottom: var(--rd-entry-gap); }
.rd-entry:last-child { margin-bottom: 0; }

.rd-entry-head { display: block; }
.rd-root[data-entry-layout="opposed"] .rd-entry-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12pt;
}
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

.rd-bullets { margin: 3pt 0 0; padding-left: 14pt; }
.rd-bullets li { margin-bottom: 1pt; }
.rd-paragraph { margin: 0 0 4pt; }
.rd-paragraph:last-child { margin-bottom: 0; }

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
