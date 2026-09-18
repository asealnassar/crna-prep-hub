/**
 * DOCX export, from the same plan everything else renders.
 *
 * NOT A SECOND SOURCE OF CONTENT. Word has no CSS engine, so it cannot mount
 * ResumeDocument -- but it does not need its own idea of what a resume says.
 * `planDocument` decides that once, and `readingOrder` puts the blocks in the
 * order the PDF extracts in, so the two files carry identical content in an
 * identical sequence. What differs is styling, and only styling.
 *
 * ATS-READABLE BY CONSTRUCTION. Ordinary paragraphs and real bullet lists. No
 * tables, no text boxes, no columns, no headers or footers -- the four things
 * that turn a Word resume into scrambled text on the other side of a parser.
 */

import { planDocument } from '../document/plan.ts'
import type { DocumentEntry, DocumentPlan } from '../document/plan.ts'
import { readingOrder, templateFor } from '../document/templates.ts'
import type { TemplateDefinition } from '../document/templates.ts'
import type { ResumeV2 } from '../model/types.ts'

/** Half-points: Word's unit for font size. */
const hp = (points: number) => Math.round(points * 2)

export function docxFilename(resume: ResumeV2): string {
  const base = (resume.contact.fullName || resume.title || 'resume')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${base || 'resume'}-resume.docx`
}

/**
 * The document's content, in reading order, as plain data.
 *
 * Exported so a test can compare it against the PDF's own extraction without
 * going near Word -- the guarantee that matters is that both formats say the
 * same thing, and this is that claim in a form that can be asserted.
 */
export function docxContentLines(resume: ResumeV2, template?: string): string[] {
  const definition = templateFor(template ?? resume.template)
  const plan = planDocument(resume)
  const out: string[] = []
  if (plan.name) out.push(plan.name)
  if (plan.contact.length > 0) out.push(plan.contact.join(' · '))

  for (const block of readingOrder(plan, definition)) {
    out.push(block.heading)
    if (block.kind === 'prose') {
      out.push(...block.paragraphs)
    } else {
      for (const entry of block.entries) out.push(...entryLines(entry))
    }
  }
  return out.filter((line) => line.trim() !== '')
}

function entryLines(entry: DocumentEntry): string[] {
  const out: string[] = []
  const header = [entry.title, entry.subtitle].filter((p) => p !== '').join(' — ')
  if (header || entry.meta) out.push([header, entry.meta].filter((p) => p !== '').join('  ·  '))
  if (entry.location) out.push(entry.location)
  if (entry.notes.length > 0) out.push(entry.notes.join(' · '))
  out.push(...entry.detail)
  return out
}

/**
 * Builds the .docx.
 *
 * The `docx` package is imported at call time: it is a server-only dependency
 * of some size, and nothing in the preview path should pay for it.
 */
export async function docxFromResume(resume: ResumeV2, template?: string): Promise<Buffer> {
  const definition = templateFor(template ?? resume.template)
  const plan = planDocument(resume)
  const {
    AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun,
  } = await import('docx')

  const serif = definition.tokens.fontStack.toLowerCase().includes('serif')
  const font = serif ? 'Georgia' : 'Calibri'
  const body = definition.tokens.bodyPt
  const centred = definition.headerAlign === 'center'

  const children: InstanceType<typeof Paragraph>[] = []

  if (plan.name) {
    children.push(new Paragraph({
      alignment: centred ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { after: 60 },
      children: [new TextRun({ text: plan.name, bold: true, size: hp(definition.tokens.namePt), font })],
    }))
  }
  if (plan.contact.length > 0) {
    children.push(new Paragraph({
      alignment: centred ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { after: 200 },
      children: [new TextRun({ text: plan.contact.join('  ·  '), size: hp(body), font, color: '4B5563' })],
    }))
  }

  for (const block of readingOrder(plan, definition)) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 80 },
      // Ruled headings in Classic; the other templates separate by weight.
      ...(definition.headingStyle === 'ruled'
        ? { border: { bottom: { color: 'D1D5DB', size: 6, style: 'single', space: 2 } } }
        : {}),
      children: [new TextRun({
        text: definition.headingStyle === 'caps' ? block.heading.toUpperCase() : block.heading,
        bold: true, size: hp(definition.tokens.headingPt), font, color: '111827',
      })],
    }))

    if (block.kind === 'prose') {
      for (const paragraph of block.paragraphs) {
        children.push(new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: paragraph, size: hp(body), font })],
        }))
      }
      continue
    }

    for (const entry of block.entries) {
      const header = [entry.title, entry.subtitle].filter((p) => p !== '').join(' — ')
      if (header || entry.meta) {
        children.push(new Paragraph({
          spacing: { before: 100 },
          children: [
            ...(header ? [new TextRun({ text: header, bold: true, size: hp(body), font })] : []),
            ...(entry.meta
              ? [new TextRun({ text: `${header ? '  ·  ' : ''}${entry.meta}`, size: hp(body), font, color: '4B5563' })]
              : []),
          ],
        }))
      }
      if (entry.location) {
        children.push(new Paragraph({
          children: [new TextRun({ text: entry.location, size: hp(body), font, color: '4B5563' })],
        }))
      }
      if (entry.notes.length > 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: entry.notes.join('  ·  '), size: hp(body), font, color: '4B5563' })],
        }))
      }
      for (const detail of entry.detail) {
        // A real Word bullet list, not a hyphen typed at the start of a line:
        // a parser reading this sees list items. Applied to what the MODEL
        // calls a list -- a position's bullets -- and not to authored prose,
        // which is written as ordinary paragraphs exactly as it reads in the
        // PDF. See `detailStyle` in lib/resume/document/plan.ts.
        children.push(new Paragraph({
          ...(entry.detailStyle === 'bullets' ? { bullet: { level: 0 } } : {}),
          spacing: { after: 40 },
          children: [new TextRun({ text: detail, size: hp(body), font })],
        }))
      }
    }
  }

  const document = new Document({
    creator: 'CRNA Prep Hub',
    title: resume.title || 'Resume',
    sections: [{
      properties: {
        page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } },
      },
      children,
    }],
  })

  return Buffer.from(await Packer.toBuffer(document))
}

/** The plan, for a caller that wants to inspect what will be written. */
export function docxPlan(resume: ResumeV2): DocumentPlan {
  return planDocument(resume)
}

export type { TemplateDefinition }
