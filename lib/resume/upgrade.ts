/**
 * What Ultimate actually adds to Resume Builder, and where to go to get it.
 *
 * EVERY LINE HERE IS A RULE IN CODE. Each benefit names the gate that makes it
 * true -- `canExportPdf`, `canExportDocx`, `resumeLimitFor`, `canFinalize` in
 * lib/resume/entitlement.ts -- and a test walks this list and checks each one
 * really is Ultimate-only. That is what stops an upgrade modal from growing
 * marketing copy the product does not honour.
 *
 * Deliberately NOT listed: templates, import, AI and Resume Strength. Free and
 * Premium have all of them, and selling something the applicant already has is
 * how an upgrade prompt stops being believed.
 *
 * The upgrade itself is the pricing page -- the one checkout flow, with its own
 * promo handling and sign-in check. There is no second payment path here.
 */

export type UltimateGate = 'export-pdf' | 'export-docx' | 'resume-limit' | 'finalize'

export interface UltimateBenefit {
  readonly label: string
  /** The rule that makes this true. See the test that enforces it. */
  readonly gate: UltimateGate
}

export const ULTIMATE_RESUME_BENEFITS: readonly UltimateBenefit[] = [
  { label: 'Download your finished resume as a PDF', gate: 'export-pdf' },
  { label: 'Download it as a Word document', gate: 'export-docx' },
  { label: 'Unlimited resumes', gate: 'resume-limit' },
  { label: 'Mark a resume complete', gate: 'finalize' },
]

/** The existing upgrade flow. */
export const UPGRADE_HREF = '/pricing'
